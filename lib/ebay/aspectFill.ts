// Model-assisted item-specifics fill.
//
// The analysis model writes generic specifics without knowing which aspects the
// final eBay leaf category actually wants — so live listings still show a pile
// of "suggested item specifics", which hurts search placement. At publish time
// we know the exact leaf category and its full aspect list, so one cheap
// text-only call fills whatever recommended aspects the listing data supports.
//
// Strictly best-effort: any failure leaves the aspects untouched.

import { getClient, parseModelJson } from "@/lib/anthropic";
import type { ListingResult } from "@/lib/types";
import type { AspectMeta } from "./taxonomy";
import { clipAspectValue, matchAllowed } from "./aspects";

const FILL_MODEL = "claude-sonnet-4-5-20250929";
const MAX_ASPECTS_TO_FILL = 25;
const MAX_ALLOWED_VALUES_SHOWN = 40;

function aspectPromptLine(a: AspectMeta): string {
  if (a.mode === "SELECTION_ONLY" && a.values.length) {
    const values = a.values.slice(0, MAX_ALLOWED_VALUES_SHOWN).join(" | ");
    return `- "${a.name}" (must be EXACTLY one of: ${values})`;
  }
  const hint = a.values.length
    ? ` (common values: ${a.values.slice(0, 12).join(" | ")})`
    : "";
  return `- "${a.name}" (free text)${hint}`;
}

export async function fillRecommendedAspects(
  listing: ListingResult,
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  sku: string
): Promise<void> {
  const have = new Set(Object.keys(aspects).map((k) => k.toLowerCase()));
  const unfilled = meta
    .filter((a) => a.name && !have.has(a.name.toLowerCase()))
    .slice(0, MAX_ASPECTS_TO_FILL);
  if (unfilled.length === 0) return;

  const itemData = {
    title: listing.title,
    brand: listing.brand,
    item_type: listing.item_type,
    color: listing.color,
    size: listing.size,
    material: listing.material,
    measurements: listing.measurements,
    key_features: listing.key_features,
    item_specifics: listing.item_specifics,
    description: String(listing.description || "").slice(0, 900),
  };

  const prompt = `You are completing eBay item specifics for a listing that is about to publish.

ITEM DATA (from photo analysis):
${JSON.stringify(itemData, null, 1)}

EBAY WANTS VALUES FOR THESE ASPECTS:
${unfilled.map(aspectPromptLine).join("\n")}

Rules:
- Fill ONLY aspects you can determine confidently from the item data. Omit everything else — never guess.
- For "must be EXACTLY one of" aspects, copy the value verbatim from the list.
- Values must be short (under 65 characters).

Return ONLY valid JSON mapping aspect name to value, e.g. {"Sleeve Length": "Long Sleeve"}. Return {} if nothing can be determined. No markdown, no explanation.`;

  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: FILL_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });
    const block = resp.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    const filled = parseModelJson<Record<string, unknown>>(text);

    const byLower = new Map(unfilled.map((a) => [a.name.toLowerCase(), a]));
    let added = 0;
    for (const [key, raw] of Object.entries(filled || {})) {
      const a = byLower.get(String(key).toLowerCase());
      if (!a || aspects[a.name]) continue;
      let val = clipAspectValue(String(raw ?? ""));
      if (!val) continue;
      if (a.mode === "SELECTION_ONLY") {
        const canonical = matchAllowed(val, a.values);
        if (!canonical) continue; // invalid selection — safer to leave empty
        val = canonical;
      }
      aspects[a.name] = [val];
      added++;
    }
    if (added) console.log(`[ebay/publish] aspect-fill added ${added} specifics sku=${sku}`);
  } catch (e) {
    console.warn(`[ebay/publish] aspect-fill skipped sku=${sku}: ${(e as Error).message}`);
  }
}
