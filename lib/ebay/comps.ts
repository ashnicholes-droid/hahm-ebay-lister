// Comparable-listing price research via eBay's Browse API.
//
// The analysis model's suggested_price is a visual guess with no market data
// behind it. This module grounds it: search active eBay listings for the same
// kind of item, filter out bad comps (lots, wrong condition, parts,
// reproductions), and compute a price band with a confidence score.
//
// ⚠️ These are ASKING prices, not sold prices, and that gap is real — asking
// prices skew high because the ones that were priced right already sold. eBay
// has no open sold-price API: findCompletedItems was decommissioned in February
// 2025, and the Marketplace Insights API that replaced it is a restricted
// release eBay is not currently admitting new developers to. So this is a
// sanity band, not gospel, and every label says "asking".
//
// What this DOES get right is the delivered price. A $20 item with $8 postage
// and a $26 item with free postage are not a $6 difference, and comparing the
// item prices alone quietly misprices everything. Each comp is therefore
// reduced to what a buyer actually pays — item + postage — and comps whose
// postage is calculated at checkout (so unknowable from here) are kept for
// display but excluded from the band rather than silently counted as free.

import { EBAY_CURRENCY, EBAY_MARKETPLACE_ID, EBAY_BROWSE_SEARCH as BROWSE_SEARCH } from "./config";
import type { ShippingArrangement } from "@/lib/fees";
import type { Comp, CompsSummary, ListingResult } from "@/lib/types";

const EBAY_BROWSE_SEARCH = BROWSE_SEARCH;

export type { Comp, CompsSummary };

// Comps that poison the statistics: multi-item lots when ours is one item,
// parts/repair listings, reproductions, and empty-box scams. (No "x 12"-style
// quantity heuristic — it false-positived on dimension titles like "16 x 20".)
const BAD_COMP_TITLE_RE =
  /\b(lot(?:\sof)?|bundle|wholesale|reseller|bulk|for\sparts|parts\sonly|repair|broken|damaged|repro(?:duction)?|replica|fake|style\sof|box\sonly|case\sonly|manual\sonly)\b/i;

const NEW_CONDITION_IDS = new Set([1000, 1500, 1750]);

function isNewGrade(condition: string | undefined): boolean {
  return /^NEW/i.test(String(condition || ""));
}

export function buildCompQuery(listing: ListingResult): string {
  const brand = String(listing.brand || "").trim();
  const usableBrand = brand && !/^(no\s?brand|unbranded|unknown)$/i.test(brand) ? brand : "";
  const itemType = String(listing.item_type || "").trim();
  const parts = [usableBrand, itemType].filter(Boolean);
  if (parts.length) return parts.join(" ").slice(0, 100);
  // No brand/type — fall back to the first few title words.
  return String(listing.title || "").split(/\s+/).slice(0, 6).join(" ").slice(0, 100);
}

interface BrowseItem {
  title?: string;
  price?: { value?: string; currency?: string };
  conditionId?: string;
  condition?: string;
  itemGroupType?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  shippingOptions?: {
    shippingCostType?: string;
    shippingCost?: { value?: string; currency?: string };
  }[];
}

/**
 * How postage is arranged on one comp.
 *
 * Deliberately the same four-way distinction lib/fees.ts already uses for the
 * seller's own listings, so "free" means the same thing on both screens.
 */
export function compShipping(it: BrowseItem): {
  shippingType: ShippingArrangement;
  shippingCost: number | null;
} {
  const opt = it.shippingOptions?.[0];
  if (!opt) return { shippingType: "unknown", shippingCost: null };

  const cost = Number(opt.shippingCost?.value);
  const hasCost = Number.isFinite(cost) && cost >= 0;
  // A calculated quote depends on the buyer's address, so there is no single
  // delivered price to compare against. Saying so beats inventing one.
  if (/CALCULATED/i.test(String(opt.shippingCostType || "")) && !hasCost) {
    return { shippingType: "calculated", shippingCost: null };
  }
  if (!hasCost) return { shippingType: "unknown", shippingCost: null };
  if (cost === 0) return { shippingType: "free", shippingCost: 0 };
  return { shippingType: "flat", shippingCost: cost };
}

export function filterComps(items: BrowseItem[], listingCondition: string | undefined): Comp[] {
  const wantNew = isNewGrade(listingCondition);
  const comps: Comp[] = [];
  for (const it of items) {
    const price = Number(it.price?.value);
    if (!Number.isFinite(price) || price <= 0) continue;
    // Comps must be priced in the currency the listing will publish in —
    // mixing currencies would corrupt the median/band silently.
    if (it.price?.currency && it.price.currency !== EBAY_CURRENCY) continue;
    if (BAD_COMP_TITLE_RE.test(String(it.title || ""))) continue;
    const condId = Number(it.conditionId);
    if (Number.isFinite(condId) && condId > 0) {
      const compIsNew = NEW_CONDITION_IDS.has(condId);
      if (compIsNew !== wantNew) continue;
    }
    const { shippingType, shippingCost } = compShipping(it);
    comps.push({
      title: String(it.title || "").slice(0, 140),
      itemPrice: round2(price),
      shippingType,
      shippingCost,
      // Null, not a guess: a calculated quote has no single delivered figure.
      delivered: shippingCost === null ? null : round2(price + shippingCost),
      condition: String(it.condition || ""),
      url: String(it.itemWebUrl || ""),
      imageUrl: String(it.image?.imageUrl || ""),
    });
  }
  return comps;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Median, 10–90% band, trimmed mean, and a confidence heuristic.
 *
 * Takes comps rather than bare numbers so the band can be built from DELIVERED
 * prices. Comps whose postage is calculated at checkout carry no delivered
 * figure and are excluded from the maths — counting them at their item price
 * would drag the whole band down by however much postage costs, which is
 * exactly the error this is meant to remove. They are still returned for
 * display, and `pricedCount` says how many actually fed the band.
 */
export function compStats(comps: Comp[]): Omit<CompsSummary, "ok" | "query" | "basis"> {
  const priced = comps.filter((c) => c.delivered !== null);
  const sorted = priced.map((c) => c.delivered as number).sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count: 0, pricedCount: 0, confidence: 0 };

  const median = percentile(sorted, 0.5);
  const low = percentile(sorted, 0.1);
  const high = percentile(sorted, 0.9);
  const trimStart = Math.floor(count * 0.1);
  const trimmed = sorted.slice(trimStart, count - trimStart || count);
  const trimmedMean = trimmed.reduce((s, n) => s + n, 0) / trimmed.length;

  // Confidence: volume (12+ comps → full marks) damped by dispersion — a band
  // spanning 3× the median means the query matched too many different things.
  const volumeScore = Math.min(1, count / 12);
  const spread = median > 0 ? (high - low) / median : 1;
  const tightness = Math.max(0.2, 1 - spread / 3);
  const confidence = Math.round(volumeScore * tightness * 100) / 100;

  return {
    count: comps.length,
    pricedCount: count,
    median: round2(median),
    trimmedMean: round2(trimmedMean),
    low: round2(low),
    high: round2(high),
    confidence,
  };
}

// Identical items in a batch (or a re-analyze) shouldn't re-spend Browse API
// quota — cache per warm lambda for a while.
const compsCache = new Map<string, { summary: CompsSummary; expiresAt: number }>();
const COMPS_TTL_MS = 10 * 60_000;
const COMPS_CACHE_MAX = 200;

// Search active comps for a listing. `appToken` comes from the taxonomy
// module's client-credentials flow — the Browse API accepts the same scope.
export async function searchComps(
  appToken: string,
  listing: ListingResult
): Promise<CompsSummary> {
  const query = buildCompQuery(listing);
  const empty: CompsSummary = {
    ok: false,
    query,
    count: 0,
    pricedCount: 0,
    confidence: 0,
    basis: "",
    comps: [],
  };
  if (!query) return empty;

  const wantNew = isNewGrade(listing.condition);
  const cacheKey = `${query}|${wantNew ? "new" : "used"}`;
  const cached = compsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    filter: `buyingOptions:{FIXED_PRICE},conditions:{${wantNew ? "NEW" : "USED"}},priceCurrency:${EBAY_CURRENCY}`,
  });
  const resp = await fetch(`${EBAY_BROWSE_SEARCH}?${params}`, {
    headers: {
      Authorization: `Bearer ${appToken}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
    },
  });
  if (!resp.ok) return empty;
  const data = await resp.json().catch(() => null);
  const items: BrowseItem[] = data?.itemSummaries ?? [];
  const comps = filterComps(items, listing.condition);
  const stats = compStats(comps);

  const unpriced = comps.length - (stats.pricedCount ?? 0);
  const summary: CompsSummary = {
    ok: (stats.pricedCount ?? 0) > 0,
    query,
    ...stats,
    // Cheapest first: the recommendation is anchored to the bottom of the
    // market, so that is the end of the list worth reading.
    comps: [...comps].sort((a, b) => (a.delivered ?? Infinity) - (b.delivered ?? Infinity)),
    basis:
      (stats.pricedCount ?? 0) > 0
        ? `${stats.pricedCount} active ${wantNew ? "new" : "pre-owned"} listings matching “${query}”, ` +
          `priced as delivered (item + postage). Asking prices, not sold prices` +
          (unpriced > 0
            ? ` — ${unpriced} more matched but quote postage at checkout, so they're listed without a delivered price.`
            : ".")
        : "",
  };
  if (compsCache.size > COMPS_CACHE_MAX) compsCache.clear();
  compsCache.set(cacheKey, { summary, expiresAt: Date.now() + COMPS_TTL_MS });
  return summary;
}
