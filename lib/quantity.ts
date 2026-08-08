// How many of this item there are, and what a buyer saves for taking more than
// one.
//
// One module because four places need the same answer and must not disagree:
// the card's inputs, the eBay preview, the publish payload, and the CSV/JSON
// export. A listing that displays "3 available" while publishing 1 is worse
// than having no quantity field at all.
//
// The default is deliberately a single unique item. Most of what goes through
// this app is one-of-a-kind resale, and a quantity that quietly defaults to
// something else oversells stock the seller doesn't have. Multiples are opt-in:
// `multi_quantity` must be explicitly true before `quantity` is read at all.

import type { ListingResult } from "./types";

/**
 * Cap on quantity. eBay itself allows far more, but this app writes listings
 * from photographs of a specific pile of stuff — a four-digit quantity is a
 * typo, not inventory, and eBay will happily let you oversell on a typo.
 */
export const MAX_QUANTITY = 999;

/** A multi-buy discount below 2 is not a multi-buy discount. */
export const MIN_DISCOUNT_QUANTITY = 2;

/**
 * eBay rejects 0% and 100%. The upper bound here is lower than eBay's on
 * purpose: past this, a "discount" is almost certainly a misplaced decimal.
 */
export const MAX_DISCOUNT_PERCENT = 80;

export interface VolumeDiscount {
  /** Buy this many or more to get the discount. */
  minQuantity: number;
  /** Percent off each item, whole numbers only (eBay's own UI works this way). */
  percentOff: number;
}

const int = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

/**
 * How many units to publish. Always a whole number ≥ 1, whatever the listing
 * says — eBay rejects 0 and there is no sane reading of a negative quantity.
 */
export function listingQuantity(listing: Pick<ListingResult, "multi_quantity" | "quantity">): number {
  if (listing.multi_quantity !== true) return 1;
  const n = int(listing.quantity);
  if (n === null || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

/** True when this listing is more than one of the same thing. */
export function isMultiQuantity(listing: Pick<ListingResult, "multi_quantity" | "quantity">): boolean {
  return listingQuantity(listing) > 1;
}

/**
 * The multi-buy tier to apply, or null.
 *
 * Returns null rather than something unusable whenever the discount couldn't
 * apply — a single-unit listing, a missing percentage, a minimum the stock
 * can't reach. Callers get "no discount", not a malformed one, and the reason
 * is available separately from `quantityWarnings`.
 */
export function volumeDiscount(
  listing: Pick<ListingResult, "multi_quantity" | "quantity" | "volume_discount_percent" | "volume_discount_min">
): VolumeDiscount | null {
  const stock = listingQuantity(listing);
  if (stock < MIN_DISCOUNT_QUANTITY) return null;

  const pct = int(listing.volume_discount_percent);
  if (pct === null || pct < 1) return null;

  const min = int(listing.volume_discount_min) ?? MIN_DISCOUNT_QUANTITY;
  // A minimum above the stock on hand can never trigger, so there is no
  // discount to apply — say so rather than silently lowering the bar the seller
  // typed.
  if (min > stock) return null;

  return {
    minQuantity: Math.max(MIN_DISCOUNT_QUANTITY, min),
    percentOff: Math.min(pct, MAX_DISCOUNT_PERCENT),
  };
}

/**
 * Things about the quantity setup worth telling the seller before they post.
 * Every one of these is a case where what they typed and what will happen
 * differ, which is exactly the class of problem that otherwise gets discovered
 * from a buyer's message.
 */
export function quantityWarnings(
  listing: Pick<
    ListingResult,
    "multi_quantity" | "quantity" | "volume_discount_percent" | "volume_discount_min"
  >
): string[] {
  const out: string[] = [];
  if (listing.multi_quantity !== true) return out;

  const raw = int(listing.quantity);
  const stock = listingQuantity(listing);

  if (raw !== null && raw > MAX_QUANTITY) {
    out.push(
      `Quantity ${raw} looks like a typo, so ${MAX_QUANTITY} will be listed. Raise it on eBay if you really have that many.`
    );
  }
  if (stock === 1) {
    out.push(
      'Marked as multiples but the quantity is 1 — this publishes as a single item. Set a quantity above 1, or untick "I have multiples".'
    );
  }

  const pct = int(listing.volume_discount_percent);
  if (pct !== null && pct >= 1) {
    if (stock < MIN_DISCOUNT_QUANTITY) {
      out.push("A multi-buy discount needs at least 2 in stock — it won't be applied.");
    } else {
      const min = int(listing.volume_discount_min) ?? MIN_DISCOUNT_QUANTITY;
      if (min > stock) {
        out.push(
          `The multi-buy discount starts at ${min} but you only have ${stock} — no buyer can reach it, so it won't be applied.`
        );
      }
      if (pct > MAX_DISCOUNT_PERCENT) {
        out.push(
          `A ${pct}% discount is capped at ${MAX_DISCOUNT_PERCENT}% — check for a misplaced decimal point.`
        );
      }
    }
  } else if (listing.volume_discount_min !== undefined && listing.volume_discount_min !== "") {
    out.push("A multi-buy minimum was set with no percentage off, so no discount will be applied.");
  }

  return out;
}

/** Buyer-facing wording for a tier, used in the preview and the card. */
export function describeVolumeDiscount(d: VolumeDiscount): string {
  return `Buy ${d.minQuantity} or more, save ${d.percentOff}% each`;
}

/** What one unit costs a buyer who takes the discounted tier. */
export function discountedUnitPrice(price: number, d: VolumeDiscount): number {
  return Math.round(price * (1 - d.percentOff / 100) * 100) / 100;
}
