// Category-aware, photo-grounded item-specifics fill.
//
// The initial analysis model writes generic specifics without knowing which
// aspects the final eBay leaf category actually wants. At publish time we know
// the exact leaf category and its full aspect schema — AND we have the original
// photos in hand. This pass re-examines the photos against eBay's real aspect
// names and allowed values.
//
// Strictly best-effort: any failure leaves the aspects untouched.

import OpenAI from "openai";
import { toImageBlock, urlImageBlock, type WireImage } from "@/lib/images";
import type { ListingResult } from "@/lib/types";
import type { AspectMeta } from "./taxonomy";
import {
  cleanAspectValue,
  matchAllowed,
  splitAspectValues,
  MAX_MULTI_VALUES,
} from "./aspects";

const FILL_MODEL = "gpt-4.1-mini";

const MAX_ASPECTS_TO_FILL = 40;
const MAX_ALLOWED_VALUES_SHOWN = 40;
const MAX_FILL_IMAGES = 8;

const USAGE_RANK = {
  REQUIRED: 0,
  RECOMMENDED: 1,
  OPTIONAL: 2,
} as const;

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  return new OpenAI({ apiKey });
}

function parseModelJson<T>(raw: string): T {
  let text = (raw || "").trim();

  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]) as T;
    }

    throw new Error("OpenAI model did not return valid JSON.");
  }
}

export function prioritizeAspects(
  unfilled: AspectMeta[]
): AspectMeta[] {
  return [...unfilled].sort(
    (a, b) =>
      (USAGE_RANK[a.usage] ?? 2) -
      (USAGE_RANK[b.usage] ?? 2)
  );
}

function aspectPromptLine(a: AspectMeta): string {
  const tag =
    a.usage === "REQUIRED"
      ? " [required]"
      : a.usage === "RECOMMENDED"
        ? " [recommended]"
        : "";

  const multi =
    a.cardinality === "MULTI"
      ? " (multiple values allowed — return an array)"
      : "";

  if (a.mode === "SELECTION_ONLY" && a.values.length) {
    const values = a.values
      .slice(0, MAX_ALLOWED_VALUES_SHOWN)
      .join(" | ");

    return `- "${a.name}"${tag}${multi} (must be EXACTLY one of: ${values})`;
  }

  const hint = a.values.length
    ? ` (common values: ${a.values.slice(0, 12).join(" | ")})`
    : "";

  return `- "${a.name}"${tag} (free text)${multi}${hint}`;
}

export async function fillRecommendedAspects(
  listing: ListingResult,
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  sku: string,
  images: WireImage[] = [],
  imageUrls: string[] = []
): Promise<void> {
  const have = new Set(
    Object.keys(aspects).map((k) => k.toLowerCase())
  );

  const candidates = prioritizeAspects(
    meta.filter(
      (a) =>
        a.name &&
        !have.has(a.name.toLowerCase())
    )
  );

  const unfilled = candidates.slice(
    0,
    MAX_ASPECTS_TO_FILL
  );

  if (candidates.length > unfilled.length) {
    console.log(
      `[ebay/publish] aspect-fill sku=${sku}: ${
        candidates.length - unfilled.length
      } low-priority aspects skipped`
    );
  }

  if (unfilled.length === 0) return;

  const clip = (v: unknown, n: number) =>
    String(v ?? "").slice(0, n);

  const itemData = {
    title: clip(listing.title, 120),
    brand: clip(listing.brand, 80),
    item_type: clip(listing.item_type, 80),

    color: (
      Array.isArray(listing.color)
        ? listing.color
        : [listing.color]
    )
      .filter(Boolean)
      .slice(0, 4)
      .map((c) => clip(c, 40)),

    size: clip(listing.size, 40),
    material: clip(listing.material, 80),
    measurements: clip(
      listing.measurements,
      200
    ),

    key_features: (
      listing.key_features ?? []
    )
      .slice(0, 5)
      .map((f) => clip(f, 100)),

    item_specifics: Object.fromEntries(
      Object.entries(
        listing.item_specifics ?? {}
      )
        .slice(0, 40)
        .map(([k, v]) => [
          clip(k, 60),
          clip(v, 120),
        ])
    ),

    description: clip(
      listing.description,
      900
    ),
  };

  const imageBlocks = (
    images.length
      ? images
          .slice(0, MAX_FILL_IMAGES)
          .map(toImageBlock)
      : imageUrls
          .slice(0, MAX_FILL_IMAGES)
          .map(urlImageBlock)
  ).filter(
    (b): b is NonNullable<
      ReturnType<typeof toImageBlock>
    > => Boolean(b)
  );

  const prompt = `You are completing eBay item specifics for a listing that is about to publish.

${
  imageBlocks.length
    ? "The photos above show the actual item. Inspect every photo again — tags, labels, stamps, close-ups — for evidence."
    : ""
}

ITEM DATA (from earlier photo analysis):

${JSON.stringify(itemData, null, 1)}

EBAY WANTS VALUES FOR THESE ASPECTS (exact aspect names for this category):

${unfilled.map(aspectPromptLine).join("\n")}

Rules:
- Fill ONLY aspects supported by visible evidence in the photos or by the item data. Omit everything else — never guess.
- Use ONLY the supplied eBay aspect names as keys, spelled exactly as given.
- For "must be EXACTLY one of" aspects, copy the value verbatim from the list.
- For "multiple values allowed" aspects you may return a JSON array of values.
- Never answer with placeholder text like "See photos", "Unknown", or "N/A" — omit the aspect instead.
- Values must be short (under 65 characters each).

Return ONLY valid JSON mapping aspect name to value (string, or array for multi-value aspects), e.g. {"Sleeve Length": "Long Sleeve", "Material": ["Cotton", "Polyester"]}. Return {} if nothing can be determined. No markdown, no explanation.`;

  try {
    const client = getOpenAIClient();

    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      [];

    for (const block of imageBlocks) {
      if (
        "image_url" in block &&
        block.image_url
      ) {
        content.push({
          type: "image_url",
          image_url: {
            url: block.image_url.url,
          },
        });
      }
    }

    content.push({
      type: "text",
      text: prompt,
    });

    const resp =
      await client.chat.completions.create({
        model: FILL_MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content,
          },
        ],
      });

    const text =
      resp.choices?.[0]?.message?.content ?? "";

    const filled =
      parseModelJson<Record<string, unknown>>(
        text
      );

    const byLower = new Map(
      unfilled.map((a) => [
        a.name.toLowerCase(),
        a,
      ])
    );

    let added = 0;

    for (const [key, raw] of Object.entries(
      filled || {}
    )) {
      const a = byLower.get(
        String(key).toLowerCase()
      );

      if (!a || aspects[a.name]) continue;

      const parts = Array.isArray(raw)
        ? raw
            .map((v) =>
              cleanAspectValue(
                String(v ?? ""),
                a.maxLength
              )
            )
            .filter(Boolean)
        : splitAspectValues(
            raw,
            a.maxLength
          );

      if (!parts.length) continue;

      let vals: string[];

      if (a.mode === "SELECTION_ONLY") {
        vals = [];

        for (const p of parts) {
          const canonical = matchAllowed(
            p,
            a.values
          );

          if (
            canonical &&
            !vals.includes(canonical)
          ) {
            vals.push(canonical);
          }
        }

        if (!vals.length && parts.length > 1) {
          for (const sep of [
            " & ",
            " / ",
            ", ",
            " and ",
          ]) {
            const joined = matchAllowed(
              parts.join(sep),
              a.values
            );

            if (joined) {
              vals = [joined];
              break;
            }
          }
        }

        if (!vals.length) continue;
      } else {
        vals = parts;
      }

      aspects[a.name] =
        a.cardinality === "MULTI"
          ? vals.slice(0, MAX_MULTI_VALUES)
          : vals.slice(0, 1);

      added++;
    }

    if (added) {
      console.log(
        `[ebay/publish] aspect-fill added ${added} specifics sku=${sku}` +
          (imageBlocks.length
            ? ` (OpenAI vision, ${imageBlocks.length} photos)`
            : " (OpenAI text-only)")
      );
    }
  } catch (e) {
    console.warn(
      `[ebay/publish] aspect-fill skipped sku=${sku}: ${
        (e as Error).message
      }`
    );
  }
}
