// Shipping rate table.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE TRUSTING A NUMBER OUT OF HERE.
//
// These are STATIC BASELINE RATES, not live carrier quotes. This app has no
// USPS/UPS credentials, and eBay exposes no public rate-quote API, so nothing
// here is fetched — it is a table, and tables go stale. Carriers reprice at
// least annually.
//
// What that means in practice:
//   • The PHYSICAL estimate (weight, box, dimensions) is the reliable output,
//     and it is what gets sent to eBay. With calculated shipping, eBay quotes
//     the buyer from those numbers using real, current rates.
//   • The DOLLAR figures here are for your own margin math — "will this be
//     worth listing" — and should be checked against what you actually pay.
//
// To correct them, either edit RATE_TABLE below or set SHIPPING_RATES_JSON in
// your environment to a JSON object of the same shape; the env value wins and
// needs no redeploy of this file. `npm test` covers the shape, so a malformed
// override fails loudly rather than silently zeroing your costs.
// ─────────────────────────────────────────────────────────────────────────────

/** When the built-in numbers were last set. Shown in the UI so staleness is visible. */
export const RATE_TABLE_EFFECTIVE = "2026-01";
export const RATE_SOURCE = "USPS/eBay label pricing, national average zone";

export type ServiceId = "ground_advantage" | "priority" | "priority_flat_rate";

export interface Service {
  id: ServiceId;
  name: string;
  /** Heaviest package this service takes, ounces. */
  maxOz: number;
  /** Flat-rate services ignore weight entirely. */
  flatRateBoxIds?: string[];
}

export const SERVICES: Record<ServiceId, Service> = {
  ground_advantage: { id: "ground_advantage", name: "USPS Ground Advantage", maxOz: 70 * 16 },
  priority: { id: "priority", name: "USPS Priority Mail", maxOz: 70 * 16 },
  priority_flat_rate: {
    id: "priority_flat_rate",
    name: "USPS Priority Flat Rate",
    maxOz: 70 * 16,
    // Every USPS-supplied flat-rate container. Order is cheapest-first only by
    // coincidence; the estimator sorts priced options by cost.
    flatRateBoxIds: [
      "usps-fre",
      "usps-fre-legal",
      "usps-fre-padded",
      "usps-fr-sm",
      "usps-fr-md",
      "usps-fr-md-side",
      "usps-fr-lg",
      "usps-fr-boardgame",
    ],
  },
};

/**
 * Weight-break pricing: the first entry whose `maxOz` is >= the billable weight
 * sets the price. Ascending, and the final entry is the ceiling for the service.
 */
export interface RateBreak {
  maxOz: number;
  usd: number;
}

export interface RateTable {
  effective: string;
  source: string;
  ground_advantage: RateBreak[];
  priority: RateBreak[];
  /** Flat-rate boxes price by box, not by weight. */
  flat_rate_by_box: Record<string, number>;
}

const RATE_TABLE: RateTable = {
  effective: RATE_TABLE_EFFECTIVE,
  source: RATE_SOURCE,
  ground_advantage: [
    { maxOz: 4, usd: 4.6 },
    { maxOz: 8, usd: 5.2 },
    { maxOz: 12, usd: 6.1 },
    { maxOz: 16, usd: 7.0 },
    { maxOz: 32, usd: 9.1 },
    { maxOz: 48, usd: 11.4 },
    { maxOz: 64, usd: 13.2 },
    { maxOz: 80, usd: 15.0 },
    { maxOz: 112, usd: 18.4 },
    { maxOz: 160, usd: 23.0 },
    { maxOz: 240, usd: 31.5 },
    { maxOz: 320, usd: 40.0 },
    { maxOz: 480, usd: 55.0 },
    { maxOz: 800, usd: 78.0 },
    { maxOz: 1120, usd: 104.0 },
  ],
  priority: [
    { maxOz: 16, usd: 9.0 },
    { maxOz: 32, usd: 11.5 },
    { maxOz: 48, usd: 13.6 },
    { maxOz: 64, usd: 15.4 },
    { maxOz: 80, usd: 17.2 },
    { maxOz: 112, usd: 21.0 },
    { maxOz: 160, usd: 26.5 },
    { maxOz: 240, usd: 35.5 },
    { maxOz: 320, usd: 45.0 },
    { maxOz: 480, usd: 62.0 },
    { maxOz: 800, usd: 88.0 },
    { maxOz: 1120, usd: 118.0 },
  ],
  flat_rate_by_box: {
    "usps-fre": 9.9,
    "usps-fre-legal": 10.2,
    "usps-fre-padded": 10.6,
    "usps-fr-sm": 10.5,
    "usps-fr-md": 18.0,
    "usps-fr-md-side": 18.0,
    "usps-fr-lg": 23.5,
    "usps-fr-boardgame": 23.5,
  },
};

function isRateBreaks(v: unknown): v is RateBreak[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (b) =>
        b &&
        typeof b === "object" &&
        Number.isFinite((b as RateBreak).maxOz) &&
        Number.isFinite((b as RateBreak).usd)
    )
  );
}

/**
 * Validate an override before letting it replace the built-in table. A typo in
 * an env var must not silently produce $0 shipping on every listing — that is
 * exactly the error that gets discovered after fifty items are live.
 */
export function parseRateTable(raw: string | undefined): RateTable | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RateTable>;
    if (!isRateBreaks(parsed.ground_advantage) || !isRateBreaks(parsed.priority)) return null;
    const flat = parsed.flat_rate_by_box;
    if (!flat || typeof flat !== "object") return null;
    if (!Object.values(flat).every((n) => Number.isFinite(n))) return null;
    return {
      effective: String(parsed.effective ?? "custom"),
      source: String(parsed.source ?? "SHIPPING_RATES_JSON override"),
      ground_advantage: [...parsed.ground_advantage].sort((a, b) => a.maxOz - b.maxOz),
      priority: [...parsed.priority].sort((a, b) => a.maxOz - b.maxOz),
      flat_rate_by_box: flat as Record<string, number>,
    };
  } catch {
    return null;
  }
}

export function rateTable(env: string | undefined = process.env.SHIPPING_RATES_JSON): RateTable {
  return parseRateTable(env) ?? RATE_TABLE;
}

/** Price for a billable weight on a weight-based service, or null if over the cap. */
export function weightBasedRate(
  service: "ground_advantage" | "priority",
  billableOz: number,
  table: RateTable = rateTable()
): number | null {
  const breaks = table[service];
  const hit = breaks.find((b) => billableOz <= b.maxOz);
  return hit ? hit.usd : null;
}

/**
 * The weight band a price sits in, and what the next one costs.
 *
 * Postage is banded, not continuous: everything from 16 to 32 oz costs the
 * same. That makes the estimator look broken from the seller's chair — you
 * change the box size, the packed weight visibly moves, and the price doesn't.
 * It didn't fail to update; there was nothing to update to.
 *
 * Returning the band turns that into something useful: how much headroom is
 * left before the price steps, and what it steps to.
 */
export interface WeightBand {
  /** Top of the current band, in ounces. */
  maxOz: number;
  /** Ounces of headroom before the price increases. */
  headroomOz: number;
  /** What it costs once that's used up, or null at the top of the table. */
  nextUsd: number | null;
}

export function weightBand(
  service: "ground_advantage" | "priority",
  billableOz: number,
  table: RateTable = rateTable()
): WeightBand | null {
  const breaks = table[service];
  const i = breaks.findIndex((b) => billableOz <= b.maxOz);
  if (i === -1) return null;
  const next = breaks[i + 1];
  return {
    maxOz: breaks[i].maxOz,
    headroomOz: Math.max(0, Math.round((breaks[i].maxOz - billableOz) * 10) / 10),
    nextUsd: next ? next.usd : null,
  };
}

export function flatRateFor(boxId: string, table: RateTable = rateTable()): number | null {
  const usd = table.flat_rate_by_box[boxId];
  return Number.isFinite(usd) ? usd : null;
}

// ── Dimensional weight ───────────────────────────────────────────────────────
//
// Carriers bill the greater of actual weight and volume-derived "dimensional"
// weight once a package passes 1 cubic foot. This is the single biggest reason
// a shipping estimate comes in far under what you actually pay: a big, light
// item (a lampshade, a boxed toy) is priced as though it were heavy.
export const DIM_DIVISOR = 166;
export const DIM_THRESHOLD_IN3 = 1728; // 1 cubic foot

export function dimensionalOz(dims: { l: number; w: number; h: number }): number {
  const volume = dims.l * dims.w * dims.h;
  if (volume <= DIM_THRESHOLD_IN3) return 0;
  return Math.ceil((volume / DIM_DIVISOR) * 16);
}

/** What the carrier actually charges on: the greater of scale and dimensional weight. */
export function billableOz(actualOz: number, dims: { l: number; w: number; h: number }): number {
  return Math.max(Math.ceil(actualOz), dimensionalOz(dims));
}
