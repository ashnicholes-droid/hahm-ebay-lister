// What this listing will actually look like on eBay.
//
// The point of a preview is that it can't be wishful. Everything below is
// produced by the SAME functions the publish pipeline uses — buildAspects,
// canonicalizeAspectKeys, reconcileAspects, enforceCardinality,
// sanitizeNumericAspects, conditionCandidates, validListingPrice — driven by the
// SAME live eBay taxonomy call. So the specifics you see here are the specifics
// eBay will store, the condition label is the tier eBay will display, and a
// title clipped at 80 characters is clipped here too.
//
// Two things a preview genuinely cannot know, and which are reported rather than
// guessed: whether the SKU is already live (a publish-time lookup), and whether
// eBay's validators will reject a particular aspect VALUE (only discovered on
// submission, which is what publish.ts's recovery loops exist for).

import {
  acceptedConditionsFor,
  buildAspects,
  conditionCandidates,
  reconcileAspects,
  staticCategory,
  validListingPrice,
} from "./publish";
import { canonicalizeAspectKeys, enforceCardinality, sanitizeNumericAspects } from "./aspects";
import {
  acceptedConditionIds,
  categoryAspects,
  suggestLeafCategories,
  type AspectMeta,
} from "./taxonomy";
import { EBAY_CURRENCY } from "./config";
import {
  discountedUnitPrice,
  listingQuantity,
  quantityWarnings,
  volumeDiscount,
  type VolumeDiscount,
} from "@/lib/quantity";
import type { ListingResult } from "@/lib/types";

/** Buyer-facing condition wording, keyed by the Inventory API enum we send. */
const CONDITION_LABELS: Record<string, string> = {
  NEW: "New with tags",
  NEW_OTHER: "New without tags",
  NEW_WITH_DEFECTS: "New with defects",
  LIKE_NEW: "Open box",
  PRE_OWNED_EXCELLENT: "Pre-owned · Excellent",
  USED_EXCELLENT: "Pre-owned · Good",
  PRE_OWNED_FAIR: "Pre-owned · Fair",
  USED_VERY_GOOD: "Pre-owned · Very Good",
  USED_GOOD: "Pre-owned · Good",
  USED_ACCEPTABLE: "Pre-owned · Acceptable",
  FOR_PARTS_OR_NOT_WORKING: "For parts or not working",
};

export interface PreviewSpecific {
  name: string;
  values: string[];
  /** eBay marks required specifics; a missing one holds up the listing. */
  required: boolean;
}

export interface ListingPreview {
  sku: string;
  title: string;
  /** True when the model's title was longer than eBay's 80-character cap. */
  titleClipped: boolean;
  price: number | null;
  currency: string;
  /** The enum sent to eBay. */
  conditionEnum: string;
  /** How eBay renders that enum to a buyer — often not the grade the model wrote. */
  conditionLabel: string;
  conditionNotes: string;
  categoryId: string;
  /** eBay's own name for the leaf category, when it told us one. */
  categoryName: string;
  description: string;
  imageUrls: string[];
  /** Photos that will actually be posted (capped at eBay's 12). */
  photoCount: number;
  specifics: PreviewSpecific[];
  /** Required specifics eBay wants for this category that the listing lacks. */
  missingRequired: string[];
  /**
   * Every condition this eBay category accepts, with eBay's own wording.
   *
   * The direct answer to "why can't I list this as refurbished": categories
   * publish their own condition policy, and one that has no refurbished tier
   * will reject it however it's spelled. Empty when eBay's metadata wasn't
   * reachable, which is different from "the category allows nothing".
   */
  allowedConditions: { id: number; enumValue: string; label: string; approvalOnly: boolean }[];
  /** Units eBay will show as available. 1 for an ordinary single item. */
  quantity: number;
  /** The multi-buy tier a buyer will see, when one applies. */
  volumeDiscount: (VolumeDiscount & { unitPrice: number | null }) | null;
  /** Anything that makes this preview less than exact. */
  warnings: string[];
  /** True when eBay's live taxonomy answered; false means an offline best guess. */
  fromLiveTaxonomy: boolean;
}

export interface PreviewInput {
  sku: string;
  listing: ListingResult;
  /** eBay-hosted URLs, when the photos have already been uploaded. */
  imageUrls?: string[];
  /**
   * How many photos this item has locally. Before posting, the browser holds
   * the photos and the server has never seen them — it only needs the count to
   * report the photo limit honestly, and the client renders its own thumbnails
   * into the preview's gallery. Sending the bytes here would be pure waste.
   */
  photoCount?: number;
  /** Seller token when connected — improves condition metadata accuracy. */
  accessToken?: string;
}

/** Build the preview, consulting eBay's live taxonomy when it's reachable. */
export async function buildListingPreview(input: PreviewInput): Promise<ListingPreview> {
  const { listing, sku } = input;
  const warnings: string[] = [];
  const catKey = String(listing.category || "other");

  const rawTitle = String(listing.title || "Untitled");
  const title = rawTitle.slice(0, 80);

  // suggestLeafCategories swallows its own transport errors and returns [], so
  // an empty result is the single "eBay didn't answer" signal to key off.
  const suggestions = await suggestLeafCategories(
    `${listing.category_hint || ""} ${listing.title || ""}`,
    3
  );
  let categoryId = suggestions[0]?.id || "";
  const categoryName = suggestions[0]?.name || "";
  let suggestionsFailed = false;
  if (!categoryId) {
    suggestionsFailed = true;
    categoryId = staticCategory(listing);
    warnings.push(
      "eBay's category suggestions weren't available, so this shows the offline category map. The live category may differ."
    );
  }

  // Same aspect pipeline as publish, in the same order.
  const aspects = buildAspects(listing, catKey);
  let aspectMeta: AspectMeta[] = [];
  let acceptedConds = new Set<number>();
  try {
    const [meta, conds] = await Promise.all([
      categoryAspects(categoryId),
      acceptedConditionIds(categoryId, input.accessToken),
    ]);
    aspectMeta = meta;
    acceptedConds = conds;
  } catch {
    /* handled by the aspectMeta.length check below */
  }

  if (aspectMeta.length) {
    canonicalizeAspectKeys(aspects, aspectMeta);
    reconcileAspects(aspects, aspectMeta, listing, catKey);
  } else {
    warnings.push(
      "eBay's item-specifics schema for this category couldn't be read, so specifics are shown unreconciled — the live listing may have more or fewer."
    );
    for (const k of Object.keys(aspects)) {
      if (k !== "Features" && aspects[k].length > 1) aspects[k] = aspects[k].slice(0, 1);
    }
  }
  enforceCardinality(aspects, aspectMeta);
  const droppedNumeric = sanitizeNumericAspects(aspects, aspectMeta);
  if (droppedNumeric.length) {
    warnings.push(
      `Dropped from the live listing because eBay requires a number: ${droppedNumeric.join(", ")}.`
    );
  }

  // `required` is eBay's own flag (taxonomy.ts derives `usage` from it), so key
  // off the flag rather than the derivation.
  const requiredNames = new Set(aspectMeta.filter((a) => a.required).map((a) => a.name));
  const specifics: PreviewSpecific[] = Object.entries(aspects)
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => ({ name, values, required: requiredNames.has(name) }))
    // Required specifics first — those are the ones that hold up a listing.
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));

  const missingRequired = [...requiredNames].filter((name) => !aspects[name]?.length).sort();

  const conditionEnum = conditionCandidates(listing.condition, acceptedConds, catKey)[0] || "USED_EXCELLENT";
  const conditionLabel = CONDITION_LABELS[conditionEnum] ?? conditionEnum.replace(/_/g, " ");
  // The grade the seller picked and the tier eBay will actually show are often
  // different — eBay has no "Very Good" in fashion, for one. Say so here rather
  // than letting the seller discover it on the live listing.
  const requestedGrade = String(listing.condition || "").replace(/_/g, " ").trim();
  if (requestedGrade && !conditionLabel.toLowerCase().includes(requestedGrade.toLowerCase())) {
    warnings.push(
      `You graded this "${requestedGrade.toLowerCase()}", but this eBay category will display it as "${conditionLabel}".`
    );
  }

  const price = validListingPrice(listing.suggested_price);
  if (price === null) {
    warnings.push("No price set — eBay will refuse this listing until you set one.");
  }

  const imageUrls = (input.imageUrls ?? []).slice(0, 12);
  const photoCount = Math.max(imageUrls.length, input.photoCount ?? 0);
  if (photoCount === 0) {
    warnings.push("No photos attached — eBay requires at least one.");
  } else if ((input.photoCount ?? 0) > 12) {
    warnings.push(
      `This item has ${input.photoCount} photos; eBay accepts 12, so the last ${
        (input.photoCount ?? 0) - 12
      } won't be posted.`
    );
  }

  // Quantity comes from the same normaliser publish uses, so "3 available"
  // here means three will be published — including the clamping.
  const quantity = listingQuantity(listing);
  const discount = volumeDiscount(listing);
  warnings.push(...quantityWarnings(listing));

  const allowedConditions = acceptedConditionsFor(acceptedConds);
  // Say it once, clearly, at the point the seller is looking at the condition —
  // rather than letting eBay reject the publish with a message that never
  // mentions the category's policy.
  if (allowedConditions.length && !allowedConditions.some((c) => c.enumValue === conditionEnum)) {
    warnings.push(
      `This category doesn't accept the condition you chose. It allows: ${allowedConditions
        .map((c) => c.label)
        .join(", ")}.`
    );
  }

  return {
    sku,
    title,
    titleClipped: rawTitle.length > 80,
    allowedConditions,
    quantity,
    volumeDiscount: discount
      ? { ...discount, unitPrice: price === null ? null : discountedUnitPrice(price, discount) }
      : null,
    price,
    currency: EBAY_CURRENCY,
    conditionEnum,
    conditionLabel,
    conditionNotes: String(listing.condition_notes || ""),
    categoryId,
    categoryName,
    description: String(listing.description || ""),
    imageUrls,
    photoCount: Math.min(photoCount, 12),
    specifics,
    missingRequired,
    warnings,
    fromLiveTaxonomy: !suggestionsFailed && aspectMeta.length > 0,
  };
}
