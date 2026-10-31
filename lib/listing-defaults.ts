import type { ItemGroup, ListingResult } from "./types";
import type { AspectMeta } from "./ebay/taxonomy";

// eBay condition values to try for a grade, best match first. Anything without
// its own entry is the seller's Pre-owned Excellent default: 2990 in clothing,
// otherwise the category's top used tier. A new grade never falls to used.
const EXCELLENT_VALUES = [
  "PRE_OWNED_EXCELLENT",
  "USED_EXCELLENT",
  "LIKE_NEW",
  "USED_VERY_GOOD",
];
const GRADE_VALUES: Record<string, string[]> = {
  NEW_WITH_TAGS: ["NEW"],
  NEW_NO_TAGS: ["NEW_OTHER"],
  NEW_WITH_DEFECTS: ["NEW_WITH_DEFECTS", "NEW_OTHER"],
  FOR_PARTS_OR_NOT_WORKING: ["FOR_PARTS_OR_NOT_WORKING"],
};

export function defaultEbayCondition(
  grade: string | undefined,
  accepted: string[],
): string {
  const wanted = (grade && GRADE_VALUES[grade]) || EXCELLENT_VALUES;
  return wanted.find((v) => accepted.includes(v)) ?? "";
}

function conditionFields(
  listing: ListingResult,
  accepted: string[],
): Pick<ListingResult, "ebay_condition" | "condition"> {
  const grade = listing.condition;
  const ebay_condition = defaultEbayCondition(grade, accepted);
  if (!ebay_condition) return {};
  return {
    ebay_condition,
    condition: grade && GRADE_VALUES[grade] ? grade : "EXCELLENT",
  };
}

// Fills drafts saved before their condition could be chosen automatically.
export function withConditionDefaults(groups: ItemGroup[]): ItemGroup[] {
  return groups.map((g) => {
    if (!g.listing || !g.preparation || g.listing.ebay_condition) return g;
    const fields = conditionFields(
      g.listing,
      g.preparation.conditions.map((c) => c.value),
    );
    return fields.ebay_condition
      ? { ...g, listing: { ...g.listing, ...fields } }
      : g;
  });
}

// Seller-requested defaults, not facts inferred from the photos. Apply only
// to empty fields while preparing the draft, never during publication.
export function applyListingDefaults(
  listing: ListingResult,
  meta: AspectMeta[],
  acceptedConditions: string[],
): void {
  const sizeType = meta.find((a) => a.name === "Size Type");
  if (
    !listing.item_specifics?.["Size Type"]?.trim() &&
    sizeType &&
    (sizeType.mode === "FREE_TEXT" || sizeType.values.includes("Regular"))
  ) {
    listing.item_specifics = {
      ...listing.item_specifics,
      "Size Type": "Regular",
    };
    if (listing.evidence) {
      listing.evidence = { ...listing.evidence };
      delete listing.evidence["Size Type"];
    }
    if (listing.estimates) {
      listing.estimates = { ...listing.estimates };
      delete listing.estimates["Size Type"];
    }
  }
  if (!listing.ebay_condition)
    Object.assign(listing, conditionFields(listing, acceptedConditions));
}
