// How a suggested price is derived from the market band.
//
// The old rule was "use the median", which is the wrong anchor for a reseller
// clearing stock. A median-priced listing sits in the middle of a page of
// identical items and waits; the ones that actually move are near the bottom of
// the delivered-price range. So the recommendation is anchored to the BOTTOM of
// the band and lifted by a margin the seller controls — undercut the market by
// a little, deliberately, rather than land in the middle by default.
//
// Pure and client-safe: no process.env, no eBay client. The settings page reads
// and writes these values in the browser, and the card applies them to whatever
// band the comps API returned, so changing a setting reprices every card
// without another API call.

import type { CompsSummary } from "./types";

export interface PricingRules {
  /**
   * Which percentile of the delivered-price band counts as "the bottom".
   * 10 = the 10th percentile, i.e. cheaper than 90% of the market. Not 0,
   * because the single cheapest listing is usually damaged, mis-titled, or a
   * mistake, and anchoring to it would chase a price nobody meant to set.
   */
  bottomPercentile: number;
  /** How far above that bottom to sit, as a percent. */
  percentAboveBottom: number;
  /**
   * Whether the recommendation is a DELIVERED price (what the buyer pays, all
   * in) or an item price. Delivered is the honest comparison; item-price mode
   * exists for sellers who always ship free and think in item prices.
   */
  basis: "delivered" | "item";
  /** Round the result to a price that looks deliberate (X.99 / X.95 / none). */
  rounding: "none" | "99" | "95" | "whole";
}

export const DEFAULT_RULES: PricingRules = {
  bottomPercentile: 10,
  percentAboveBottom: 5,
  basis: "delivered",
  rounding: "99",
};

export const RULES_STORAGE_KEY = "listing-writer:pricing-rules";

/** Clamp anything a stored/edited value could be into something usable. */
export function normalizeRules(raw: Partial<PricingRules> | null | undefined): PricingRules {
  const r = raw ?? {};
  const num = (v: unknown, fallback: number, lo: number, hi: number) => {
    const n = typeof v === "string" ? parseFloat(v) : (v as number);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    // 0 would anchor to the single cheapest listing; 50 is the median, past
    // which "bottom of the market" stops meaning anything.
    bottomPercentile: num(r.bottomPercentile, DEFAULT_RULES.bottomPercentile, 0, 50),
    // Negative would undercut the bottom of the market, which is a real choice
    // — but past -50 it is a typo, not a strategy.
    percentAboveBottom: num(r.percentAboveBottom, DEFAULT_RULES.percentAboveBottom, -50, 200),
    basis: r.basis === "item" ? "item" : "delivered",
    rounding:
      r.rounding === "none" || r.rounding === "95" || r.rounding === "whole" ? r.rounding : "99",
  };
}

/**
 * Snap a price to something that looks chosen rather than computed.
 *
 * $43.72 reads as an algorithm's output. $43.99 reads as a decision.
 *
 * Rounds to the NEAREST .99 rather than always downwards. Always rounding down
 * sounds more competitive but distorts the setting: $24.73 would become $23.99,
 * a 3% cut on an item whose margin was set to 5%, which quietly overrides the
 * seller's own number. Nearest keeps the error under half a dollar in either
 * direction. The invariant that actually matters — never landing below the
 * bottom of the market — is enforced by the caller, which knows the anchor.
 */
export function roundPrice(value: number, mode: PricingRules["rounding"]): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (mode === "none") return Math.round(value * 100) / 100;
  if (mode === "whole") return Math.max(1, Math.round(value));

  const cents = mode === "99" ? 0.99 : 0.95;
  const base = Math.floor(value);
  // Below a dollar the .99 convention is meaningless.
  if (base < 1) return Math.round(value * 100) / 100;
  const up = base + cents;
  const down = base - 1 + cents;
  if (down < cents) return up;
  return Math.abs(up - value) <= Math.abs(value - down) ? up : down;
}

export interface Recommendation {
  /** What to charge. */
  price: number;
  /** The band figure it was derived from, before the margin. */
  bottom: number;
  /** One sentence explaining where the number came from. */
  explanation: string;
  /** True when the band came from too few comps to lean on. */
  thin: boolean;
}

/** Interpolated percentile over a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

/**
 * The recommended asking price for a listing, given the market and the rules.
 *
 * Recomputed from the raw comps rather than from the stored `low`, so changing
 * bottomPercentile in settings actually moves the anchor instead of just
 * re-scaling a fixed 10th-percentile figure.
 *
 * Returns null rather than a number when there is nothing to base it on. A
 * fabricated recommendation is worse than none: the seller would price against
 * it believing it meant something.
 */
export function recommendedPrice(
  comps: CompsSummary | undefined,
  rules: PricingRules,
  markupPercent = 0
): Recommendation | null {
  if (!comps?.ok) return null;

  const values = (comps.comps ?? [])
    .map((c) => (rules.basis === "item" ? c.itemPrice : c.delivered))
    .filter((v): v is number => typeof v === "number" && v > 0)
    .sort((a, b) => a - b);

  // Fall back to the summary band when the comps themselves weren't returned
  // (an older cached response), so the card still shows something sensible.
  const bottom =
    values.length > 0 ? percentile(values, rules.bottomPercentile / 100) : (comps.low ?? 0);
  if (!(bottom > 0)) return null;

  const withMargin = bottom * (1 + rules.percentAboveBottom / 100);
  // The storewide markup is applied last, for the same reason it always was:
  // it exists to survive a store-level discount, and it should scale whatever
  // price the pricing rule arrived at.
  const marked = markupPercent > 0 ? withMargin * (1 + markupPercent / 100) : withMargin;
  let price = roundPrice(marked, rules.rounding);
  // Rounding must never drop the price below the anchor it was built from. A
  // seller who asked to sit 5% ABOVE the bottom of the market should never be
  // handed a number below it because of a cosmetic .99.
  if (rules.percentAboveBottom >= 0 && price < bottom) {
    price = roundPrice(bottom + Math.max(0.5, bottom * 0.02), rules.rounding);
    if (price < bottom) price = Math.round(bottom * 100) / 100;
  }

  const n = values.length || comps.pricedCount || comps.count;
  const basisWord = rules.basis === "item" ? "item price" : "delivered";
  const direction =
    rules.percentAboveBottom === 0
      ? "at"
      : rules.percentAboveBottom > 0
        ? `${rules.percentAboveBottom}% above`
        : `${Math.abs(rules.percentAboveBottom)}% below`;

  return {
    price,
    bottom: Math.round(bottom * 100) / 100,
    thin: n < 5,
    explanation:
      `${direction} the ${ordinal(rules.bottomPercentile)} percentile ` +
      `($${bottom.toFixed(2)} ${basisWord}) of ${n} active comp${n === 1 ? "" : "s"}` +
      (markupPercent > 0 ? `, plus the ${markupPercent}% storewide markup` : "") +
      ".",
  };
}

function ordinal(n: number): string {
  const r = Math.round(n);
  const suffix = r % 100 >= 11 && r % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][r % 10] || "th";
  return `${r}${suffix}`;
}
