import { measuredMessage } from "@/lib/ai-usage";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicAuthError, parseModelJson } from "@/lib/anthropic";
import {
  buildSortPrompt,
  buildVerifyGroupPrompt,
  buildVerifyMergePrompt,
  slugifyFolderName,
} from "@/lib/prompts";
import { labeledContent, toImageBlock, type WireImage } from "@/lib/images";

const GROUP_MODEL = "claude-sonnet-4-6";
const CHECK_MODEL = "claude-sonnet-4-6";
const BATCH_SIZE = 10;

// Concurrency caps — keep parallel bursts gentle so we don't trip Anthropic's
// per-minute rate limits on big batches (which silently zeroed out sorting).
const GROUP_CONCURRENCY = 2;
const VERIFY_CONCURRENCY = 3;
const MERGE_CONCURRENCY = 4;

// The sort route runs under a 300s Vercel maxDuration. Stop starting new work
// with headroom to spare so a slow run returns a usable (if less polished)
// result instead of being killed by the platform (FUNCTION_INVOCATION_TIMEOUT,
// which loses everything).
export const SORT_TIME_BUDGET_MS = 250_000;
// Cap each Anthropic call — the SDK default timeout is 10 MINUTES, so one
// stalled call could otherwise eat the whole function budget before our own
// retry logic ever saw it.
const PER_CALL_TIMEOUT_MS = 60_000;
// Don't bother starting a call with less budget than this left.
const MIN_CALL_MS = 5_000;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface SortGroup {
  name: string;
  photoIndices: number[];
}
export interface SortResult {
  groups: SortGroup[];
  orphanIndices: number[];
}

// Thrown when EVERY grouping batch failed (API errors / rate limits) — distinct
// from a successful run where the model simply found no groups. Lets the route
// tell the user to wait and retry instead of the misleading "try fewer photos."
export class SortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortUnavailableError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

// Run an async fn over items with a fixed concurrency cap, preserving order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Call Claude and parse JSON, retrying transient/rate-limit errors with backoff.
// `deadline` (epoch ms) bounds the whole attempt loop: calls are skipped once
// the budget is (nearly) spent, and each call's HTTP timeout never extends past
// it. SDK-internal retries are disabled — this loop is the only retry layer, so
// time spent is predictable.
async function claudeJson<T>(
  client: Anthropic,
  model: string,
  content: Anthropic.ContentBlockParam[],
  maxTokens: number,
  label: string,
  deadline: number,
): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) {
      console.warn(`[sort] ${label}: time budget exhausted — skipping call`);
      return null;
    }
    try {
      const resp = await measuredMessage(
        "sort",
        client,
        {
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
        },
        { timeout: Math.min(PER_CALL_TIMEOUT_MS, remaining), maxRetries: 0 },
      );
      return parseModelJson<T>(firstText(resp));
    } catch (e) {
      const status =
        e && typeof e === "object" && "status" in e
          ? Number((e as { status?: number }).status)
          : undefined;
      // Account-level failures won't fix themselves on retry — surface them.
      const fatal = anthropicAuthError(e);
      if (fatal) throw fatal;
      const retryable = status === undefined || RETRYABLE_STATUS.has(status);
      if (attempt < 3 && retryable) {
        const wait =
          Math.min(10000, 800 * 2 ** attempt) + Math.floor(Math.random() * 400);
        if (Date.now() + wait + MIN_CALL_MS >= deadline) {
          console.warn(`[sort] ${label}: no budget left for retry — giving up`);
          return null;
        }
        console.warn(
          `[sort] ${label}: ${status ?? "parse/conn"} error — retry ${attempt + 1} in ${wait}ms`,
        );
        await sleep(wait);
        continue;
      }
      console.warn(
        `[sort] ${label}: giving up (${status ?? (e as Error).message})`,
      );
      return null;
    }
  }
  return null;
}

// Step 1 — group photos in independent batches of 10 (run a few at a time).
// The merge step (step 3) reunites any item split across a batch boundary, so
// batches don't need sequential context — letting us parallelize safely.
async function groupPhotos(
  client: Anthropic,
  images: WireImage[],
  model: string,
  deadline: number,
): Promise<{ name: string; indices: number[] }[]> {
  const total = images.length;
  const batches: {
    offset: number;
    batch: WireImage[];
    labelStart: number;
    labelEnd: number;
  }[] = [];
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = images.slice(offset, offset + BATCH_SIZE);
    batches.push({
      offset,
      batch,
      labelStart: offset + 1,
      labelEnd: offset + batch.length,
    });
  }

  const perBatch = await mapLimit(batches, GROUP_CONCURRENCY, async (b) => {
    const content: Anthropic.ContentBlockParam[] = [
      ...labeledContent(b.batch, b.labelStart),
    ];
    const note =
      b.offset > 0
        ? ` (These are photos ${b.labelStart}–${b.labelEnd} of ${total} total. Group only the photos shown above.)`
        : "";
    content.push({
      type: "text",
      text: buildSortPrompt(b.batch.length, b.labelStart, b.labelEnd, note),
    });
    const data = await claudeJson<{
      groups?: { folder_name?: string; photo_indices?: number[] }[];
    }>(
      client,
      model,
      content,
      2000,
      `group ${b.labelStart}-${b.labelEnd}`,
      deadline,
    );

    const out: { name: string; indices: number[] }[] = [];
    for (const g of data?.groups ?? []) {
      const indices: number[] = [];
      for (const idx of g.photo_indices ?? []) {
        const real = Number(idx) - 1;
        if (
          Number.isInteger(real) &&
          real >= b.offset &&
          real < b.offset + b.batch.length
        )
          indices.push(real);
      }
      if (indices.length)
        out.push({ name: slugifyFolderName(g.folder_name ?? "item"), indices });
    }
    // data === null means the call failed after exhausting retries (vs. a
    // successful call that simply returned no groups) — track it so we can tell a
    // total outage apart from "the model found nothing to group."
    return { out, failed: data === null };
  });

  if (perBatch.length > 0 && perBatch.every((b) => b.failed)) {
    throw new SortUnavailableError(
      "The photo-sorting service was unavailable or rate-limited — every request failed. Wait a minute and try again; reducing the number of photos won't help.",
    );
  }

  return perBatch.flatMap((b) => b.out);
}

// Step 2 — verify each multi-photo group for accidentally mixed items.
// A verify that can't run (budget spent) keeps the group as sorted — a rougher
// result beats a platform timeout that loses the whole sort.
async function verifyGroups(
  client: Anthropic,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number,
): Promise<{
  groups: { name: string; indices: number[] }[];
  orphans: number[];
}> {
  const orphans: number[] = [];

  const checks = await mapLimit(groups, VERIFY_CONCURRENCY, async (group) => {
    if (group.indices.length === 1) return group;
    const content = labeledContent(
      group.indices.map((i) => images[i]),
      1,
    );
    content.push({
      type: "text",
      text: buildVerifyGroupPrompt(group.indices.length),
    });
    const result = await claudeJson<{
      valid?: boolean;
      keep_indices?: number[];
    }>(client, model, content, 300, `verify ${group.name}`, deadline);

    if (!result || result.valid !== false) return group;
    const keepRaw = result.keep_indices ?? [];
    if (keepRaw.length === 0) return group;
    const keepSet = new Set(keepRaw.map((x) => Number(x) - 1));
    const kept: number[] = [];
    group.indices.forEach((globalIdx, localIdx) => {
      if (keepSet.has(localIdx)) kept.push(globalIdx);
      else orphans.push(globalIdx);
    });
    return kept.length > 0 ? { name: group.name, indices: kept } : group;
  });

  return { groups: checks, orphans };
}

// Step 3 — merge adjacent groups that are really one item split in two.
// A pair that can't be checked (budget spent) simply stays unmerged.
async function mergeSplitGroups(
  client: Anthropic,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number,
): Promise<{ name: string; indices: number[] }[]> {
  if (groups.length < 2) return groups;

  const pairs = groups.slice(0, -1);
  const pairVotes = await mapLimit(
    pairs,
    MERGE_CONCURRENCY,
    async (group, i) => {
      const next = groups[i + 1];
      if (group.indices.length + next.indices.length > 24) return false;
      const aBlock = toImageBlock(images[group.indices[0]]);
      const bBlock = toImageBlock(images[next.indices[0]]);
      if (!aBlock || !bBlock) return false;
      const content: Anthropic.ContentBlockParam[] = [
        ...labeledContent(group.indices.map((i) => images[i])),
        { type: "text", text: "--- Group B ---" },
        ...labeledContent(next.indices.map((i) => images[i])),
        {
          type: "text",
          text: buildVerifyMergePrompt(
            group.indices.length,
            next.indices.length,
          ),
        },
      ];
      const result = await claudeJson<{ merge?: boolean }>(
        client,
        model,
        content,
        100,
        `merge ${i}`,
        deadline,
      );
      return result?.merge === true;
    },
  );

  const merged: { name: string; indices: number[] }[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = { name: groups[i].name, indices: [...groups[i].indices] };
    while (i < groups.length - 1 && pairVotes[i]) {
      i++;
      group.indices.push(...groups[i].indices);
    }
    merged.push(group);
  }
  return merged;
}

function uniqueNames(
  groups: { name: string; indices: number[] }[],
): SortGroup[] {
  const counts = new Map<string, number>();
  return groups.map((g) => {
    const n = (counts.get(g.name) ?? 0) + 1;
    counts.set(g.name, n);
    return {
      name: n === 1 ? g.name : `${g.name}-${n}`,
      photoIndices: g.indices,
    };
  });
}

// One-off merge check between two groups that landed in DIFFERENT sort chunks
// (the client sorts big batches 100 photos at a time; an item photographed
// across the chunk boundary gets split). Same prompt as the in-request merge
// step, exposed for the /api/merge-check route.
export async function checkMergePair(
  client: Anthropic,
  imageA: WireImage,
  imageB: WireImage,
  countA: number,
  countB: number,
  model?: string,
): Promise<boolean> {
  const aBlock = toImageBlock(imageA);
  const bBlock = toImageBlock(imageB);
  if (!aBlock || !bBlock) return false;
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: "Photo 1:" },
    aBlock,
    { type: "text", text: "--- Group B ---" },
    { type: "text", text: "Photo 2:" },
    bBlock,
    {
      type: "text",
      text: 'These are only two representative photos, not all group photos. Return {"merge":false} unless identifying marks prove this is the same physical item. Never infer sameness merely from similar appearance.',
    },
  ];
  const result = await claudeJson<{ merge?: boolean }>(
    client,
    model ?? CHECK_MODEL,
    content,
    100,
    "merge chunk-boundary",
    // The merge-check route runs under a 30s maxDuration — budget within it.
    Date.now() + 25_000,
  );
  return result?.merge === true;
}

export async function sortPhotos(
  client: Anthropic,
  images: WireImage[],
  model?: string,
  budgetMs: number = SORT_TIME_BUDGET_MS,
): Promise<SortResult> {
  const m = model ?? GROUP_MODEL;
  const deadline = Date.now() + budgetMs;
  const grouped = await groupPhotos(client, images, m, deadline);
  if (grouped.length === 0) return { groups: [], orphanIndices: [] };
  const seen = new Set<number>();
  for (const g of grouped)
    g.indices = g.indices.filter((i) => {
      if (seen.has(i)) return false;
      seen.add(i);
      return true;
    });
  const verified = await verifyGroups(
    client,
    images,
    grouped.filter((g) => g.indices.length),
    m,
    deadline,
  );
  const merged = await mergeSplitGroups(
    client,
    images,
    verified.groups,
    m,
    deadline,
  );
  const checked =
    merged.length < verified.groups.length
      ? await verifyGroups(client, images, merged, m, deadline)
      : { groups: merged, orphans: [] };
  const assigned = new Set(checked.groups.flatMap((g) => g.indices));
  return {
    groups: uniqueNames(checked.groups),
    orphanIndices: images.map((_, i) => i).filter((i) => !assigned.has(i)),
  };
}
