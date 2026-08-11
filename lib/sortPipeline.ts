import OpenAI from "openai";
import { anthropicAuthError, parseModelJson } from "@/lib/anthropic";

import {
  buildSortPrompt,
  buildVerifyGroupPrompt,
  buildVerifyMergePrompt,
  slugifyFolderName,
} from "@/lib/prompts";

import type { WireImage } from "@/lib/images";

const GROUP_MODEL = "gpt-5.4-mini";
const CHECK_MODEL = "gpt-5.4-mini";

const BATCH_SIZE = 10;
const GROUP_CONCURRENCY = 2;
const VERIFY_CONCURRENCY = 3;
const MERGE_CONCURRENCY = 4;

export const SORT_TIME_BUDGET_MS = 250_000;

const PER_CALL_TIMEOUT_MS = 60_000;
const MIN_CALL_MS = 5_000;

const RETRYABLE_STATUS = new Set([
  408,
  409,
  429,
  500,
  502,
  503,
  504,
]);

type OpenAIContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail?: "low" | "high" | "auto";
    };

export interface SortGroup {
  name: string;
  photoIndices: number[];
}

export interface SortResult {
  groups: SortGroup[];
  orphanIndices: number[];
}

export class SortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortUnavailableError";
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function rawBase64(data: string): string {
  return data.includes(",") ? data.split(",")[1] : data;
}

function imageContent(img: WireImage | undefined): OpenAIContent | null {
  if (!img?.data) return null;

  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);

  if (!allowed.has(img.mediaType)) return null;

  return {
    type: "input_image",
    image_url: `data:${img.mediaType};base64,${rawBase64(img.data)}`,
    detail: "auto",
  };
}

function labeledContent(
  images: WireImage[],
  labelStart = 1
): OpenAIContent[] {
  const content: OpenAIContent[] = [];

  images.forEach((img, i) => {
    const image = imageContent(img);
    if (!image) return;

    content.push({
      type: "input_text",
      text: `Photo ${labelStart + i}:`,
    });

    content.push(image);
  });

  return content;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index], index);
      }
    }
  );

  await Promise.all(workers);

  return results;
}

async function openAIJson<T>(
  client: OpenAI,
  model: string,
  content: OpenAIContent[],
  maxTokens: number,
  label: string,
  deadline: number
): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = deadline - Date.now();

    if (remaining < MIN_CALL_MS) {
      console.warn(`[sort] ${label}: time budget exhausted`);
      return null;
    }

    try {
      const response = await client.responses.create(
        {
          model,
          input: [
            {
              role: "user",
              content,
            },
          ],
          max_output_tokens: maxTokens,
          text: {
            format: {
              type: "json_object",
            },
          },
        },
        {
          timeout: Math.min(PER_CALL_TIMEOUT_MS, remaining),
          maxRetries: 0,
        }
      );

      return parseModelJson<T>(response.output_text);
    } catch (error) {
      const status =
        error &&
        typeof error === "object" &&
        "status" in error
          ? Number((error as { status?: number }).status)
          : undefined;

      const fatal = anthropicAuthError(error);

      if (fatal) {
        throw fatal;
      }

      const retryable =
        status === undefined || RETRYABLE_STATUS.has(status);

      if (attempt < 3 && retryable) {
        const wait =
          Math.min(10_000, 800 * 2 ** attempt) +
          Math.floor(Math.random() * 400);

        if (Date.now() + wait + MIN_CALL_MS >= deadline) {
          console.warn(`[sort] ${label}: no budget left for retry`);
          return null;
        }

        console.warn(
          `[sort] ${label}: ${status ?? "connection"} error — retry ${
            attempt + 1
          }`
        );

        await sleep(wait);
        continue;
      }

      console.warn(
        `[sort] ${label}: giving up — ${
          status ?? (error as Error)?.message ?? "unknown error"
        }`
      );

      return null;
    }
  }

  return null;
}

async function groupPhotos(
  client: OpenAI,
  images: WireImage[],
  model: string,
  deadline: number
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

  const results = await mapLimit(
    batches,
    GROUP_CONCURRENCY,
    async (batchInfo) => {
      const content = labeledContent(
        batchInfo.batch,
        batchInfo.labelStart
      );

      const note =
        batchInfo.offset > 0
          ? ` These are photos ${batchInfo.labelStart}–${batchInfo.labelEnd} of ${total} total. Group only the photos shown above.`
          : "";

      content.push({
        type: "input_text",
        text: buildSortPrompt(
          batchInfo.batch.length,
          batchInfo.labelStart,
          batchInfo.labelEnd,
          note
        ),
      });

      const data = await openAIJson<{
        groups?: {
          folder_name?: string;
          photo_indices?: number[];
        }[];
      }>(
        client,
        model,
        content,
        2000,
        `group ${batchInfo.labelStart}-${batchInfo.labelEnd}`,
        deadline
      );

      const groups: {
        name: string;
        indices: number[];
      }[] = [];

      for (const group of data?.groups ?? []) {
        const indices: number[] = [];

        for (const index of group.photo_indices ?? []) {
          const realIndex = Number(index) - 1;

          if (
            Number.isInteger(realIndex) &&
            realIndex >= 0 &&
            realIndex < total
          ) {
            indices.push(realIndex);
          }
        }

        if (indices.length) {
          groups.push({
            name: slugifyFolderName(
              group.folder_name ?? "item"
            ),
            indices,
          });
        }
      }

      return {
        groups,
        failed: data === null,
      };
    }
  );

  if (results.length > 0 && results.every((r) => r.failed)) {
    throw new SortUnavailableError(
      "The photo-sorting service was unavailable or rate-limited. Wait a minute and try again."
    );
  }

  return results.flatMap((r) => r.groups);
}

async function verifyGroups(
  client: OpenAI,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number
): Promise<{
  groups: { name: string; indices: number[] }[];
  orphans: number[];
}> {
  const orphans: number[] = [];

  const checked = await mapLimit(
    groups,
    VERIFY_CONCURRENCY,
    async (group) => {
      if (group.indices.length === 1) {
        return group;
      }

      const groupImages = group.indices.map((i) => images[i]);

      const content = labeledContent(groupImages, 1);

      content.push({
        type: "input_text",
        text: buildVerifyGroupPrompt(group.indices.length),
      });

      const result = await openAIJson<{
        valid?: boolean;
        keep_indices?: number[];
      }>(
        client,
        model,
        content,
        300,
        `verify ${group.name}`,
        deadline
      );

      if (!result || result.valid !== false) {
        return group;
      }

      const keepSet = new Set(
        (result.keep_indices ?? []).map(
          (x) => Number(x) - 1
        )
      );

      const kept: number[] = [];

      group.indices.forEach((globalIndex, localIndex) => {
        if (keepSet.has(localIndex)) {
          kept.push(globalIndex);
        } else {
          orphans.push(globalIndex);
        }
      });

      return kept.length
        ? { name: group.name, indices: kept }
        : group;
    }
  );

  return {
    groups: checked,
    orphans,
  };
}

async function mergeSplitGroups(
  client: OpenAI,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number
): Promise<{ name: string; indices: number[] }[]> {
  if (groups.length < 2) {
    return groups;
  }

  const pairs = groups.slice(0, -1);

  const votes = await mapLimit(
    pairs,
    MERGE_CONCURRENCY,
    async (group, index) => {
      const next = groups[index + 1];

      const first = imageContent(images[group.indices[0]]);
      const second = imageContent(images[next.indices[0]]);

      if (!first || !second) {
        return false;
      }

      const content: OpenAIContent[] = [
        {
          type: "input_text",
          text: "Photo 1:",
        },
        first,
        {
          type: "input_text",
          text: "--- Group B ---",
        },
        {
          type: "input_text",
          text: "Photo 2:",
        },
        second,
        {
          type: "input_text",
          text: buildVerifyMergePrompt(
            group.indices.length,
            next.indices.length
          ),
        },
      ];

      const result = await openAIJson<{
        merge?: boolean;
      }>(
        client,
        model,
        content,
        100,
        `merge ${index}`,
        deadline
      );

      return result?.merge === true;
    }
  );

  const merged: {
    name: string;
    indices: number[];
  }[] = [];

  let index = 0;

  while (index < groups.length) {
    if (index < groups.length - 1 && votes[index]) {
      merged.push({
        name: groups[index].name,
        indices: [
          ...groups[index].indices,
          ...groups[index + 1].indices,
        ],
      });

      index += 2;
    } else {
      merged.push(groups[index]);
      index++;
    }
  }

  return merged;
}

function uniqueNames(
  groups: { name: string; indices: number[] }[]
): SortGroup[] {
  const counts = new Map<string, number>();

  return groups.map((group) => {
    const count = (counts.get(group.name) ?? 0) + 1;
    counts.set(group.name, count);

    return {
      name:
        count === 1
          ? group.name
          : `${group.name}-${count}`,
      photoIndices: group.indices,
    };
  });
}

export async function checkMergePair(
  client: OpenAI,
  imageA: WireImage,
  imageB: WireImage,
  countA: number,
  countB: number,
  model?: string
): Promise<boolean> {
  const first = imageContent(imageA);
  const second = imageContent(imageB);

  if (!first || !second) {
    return false;
  }

  const content: OpenAIContent[] = [
    {
      type: "input_text",
      text: "Photo 1:",
    },
    first,
    {
      type: "input_text",
      text: "--- Group B ---",
    },
    {
      type: "input_text",
      text: "Photo 2:",
    },
    second,
    {
      type: "input_text",
      text: buildVerifyMergePrompt(countA, countB),
    },
  ];

  const result = await openAIJson<{
    merge?: boolean;
  }>(
    client,
    model ?? CHECK_MODEL,
    content,
    100,
    "merge chunk-boundary",
    Date.now() + 25_000
  );

  return result?.merge === true;
}

export async function sortPhotos(
  client: OpenAI,
  images: WireImage[],
  model?: string,
  budgetMs: number = SORT_TIME_BUDGET_MS
): Promise<SortResult> {
  const selectedModel = model ?? GROUP_MODEL;
  const deadline = Date.now() + budgetMs;

  const grouped = await groupPhotos(
    client,
    images,
    selectedModel,
    deadline
  );

  if (grouped.length === 0) {
    return {
      groups: [],
      orphanIndices: [],
    };
  }

  const verified = await verifyGroups(
    client,
    images,
    grouped,
    selectedModel,
    deadline
  );

  const merged = await mergeSplitGroups(
    client,
    images,
    verified.groups,
    selectedModel,
    deadline
  );

  return {
    groups: uniqueNames(merged),
    orphanIndices: verified.orphans,
  };
}
