// Should you buy this?
//
// Every other screen in this app starts once the item is already yours. But the
// decision that decides whether a reselling month is profitable happens earlier
// and faster: standing in a thrift store with a $6 sticker in your hand and
// about fifteen seconds to decide.
//
// The maths is the same maths the listing card already does — comps, eBay's
// fee, postage — run backwards. Instead of "what should I charge?", the
// question is "what can I pay?"
//
// Pure and client-safe: no network, no process.env, so the verdict recomputes
// instantly as you type a price, and every rule here is testable.

import { finalValueFee } from "./fees";

/**
 * Active comps are ASKING prices, not sale prices — and this is the single
 * biggest way a scouting tool lies to you.
 *
 * eBay retired findCompletedItems in February 2025 and Marketplace Insights
 * (real sold data) is a closed Limited Release, so active listings are what
 * this app can see. Active listings are self-selecting: the ones that were
 * priced right already sold and left, and what remains skews high — including
 * items that have sat unsold for a year at a fantasy price.
 *
 * When you're pricing something you already own, that bias costs you a slow
 * sale. When you're deciding whether to BUY, it costs you real money on an item
 * you can't return. So the plan corrects for it — see planningPrice, which
 * makes the correction ONE way and not two — and the screen says out loud which
 * correction it applied.
 */
export const DEFAULT_ACTIVE_COMP_HAIRCUT = 0.12;

/** Below this many priced comps, no verdict is offered at all. */
export const MIN_COMPS_FOR_VERDICT = 3;

export interface ScoutSettings {
  /** Don't bother below this many dollars of profit, however good the ratio. */
  minProfit: number;
  /**
   * Minimum return on the cash you put in, as a fraction. 1.0 = double your
   * money. Resellers think in multiples, not margins, because shelf space and
   * the time to list are the real constraints — a $3 profit on a $2 item is a
   * great ratio and still not worth the trip to the post office.
   */
  minRoi: number;
  /** Which end of the comp range to plan on. */
  basis: "low" | "median";
  /** How much to discount the MEDIAN by. Unused on the low basis — see
   *  planningPrice for why stacking both corrections double-counts. */
  haircut: number;
}

export const DEFAULT_SCOUT_SETTINGS: ScoutSettings = {
  // $10 rather than $12: at $12 the tool called a $6 item with a $10.52 profit
  // and a 175% return "your call", which is a deal most resellers would take
  // without hesitating. A sourcing tool that hedges on good buys gets ignored.
  minProfit: 10,
  minRoi: 1,
  basis: "low",
  haircut: DEFAULT_ACTIVE_COMP_HAIRCUT,
};

export const SCOUT_SETTINGS_KEY = "listing-writer:scout-settings";

export function normalizeScoutSettings(raw: Partial<ScoutSettings> | null | undefined): ScoutSettings {
  const d = DEFAULT_SCOUT_SETTINGS;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    minProfit: num(raw?.minProfit, d.minProfit, 0, 10_000),
    minRoi: num(raw?.minRoi, d.minRoi, 0, 100),
    basis: raw?.basis === "median" ? "median" : "low",
    haircut: num(raw?.haircut, d.haircut, 0, 0.9),
  };
}

export interface CompBand {
  /** How many comps had a delivered price — the only ones that inform this. */
  pricedCount: number;
  low?: number;
  median?: number;
  high?: number;
}

export type Verdict = "buy" | "marginal" | "skip" | "unknown";

export interface ScoutResult {
  verdict: Verdict;
  /**
   * The delivered price this plan assumes, corrected for asking-price bias.
   * Null when the comps can't support one.
   */
  expectedSale: number | null;
  /** eBay's cut at that price, using this app's fee model. */
  fee: number | null;
  /** Postage you'd pay. Comps are delivered prices, so this always comes off. */
  shipping: number;
  /** What lands in your account before you pay for the item. */
  net: number | null;
  /** net − what the shop wants. Null until you enter a price. */
  profit: number | null;
  /** profit ÷ asking price. Null when either side is unknown. */
  roi: number | null;
  /**
   * The most you can pay and still clear BOTH thresholds.
   *
   * The most useful number on the screen, and the only one that's useful before
   * you've even looked at the sticker: it turns "is this worth $6?" into "walk
   * up and check whether it's under $8.40."
   */
  maxBuy: number | null;
  /** Why there's no verdict, ready to render instead of a number. */
  blocked: "no-comps" | "no-price" | null;
  /** One line explaining the verdict, in the terms the decision was made on. */
  reason: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The delivered price to plan on.
 *
 * The two settings are two different ways of making the same correction, and
 * they must NOT be stacked. Both exist because active comps are asking prices:
 *
 *   • "low" takes the 10th percentile of the asking band. The cheapest active
 *     listings are the ones actually about to sell, so this already lands near
 *     a realistic sale price — the correction is baked in.
 *   • "median" takes the middle of the asking band, which is genuinely too
 *     high, and applies the haircut to bring it down.
 *
 * Applying the haircut to the low basis as well double-counted: on a band of
 * $30–$70 it planned on $26.40, below every single comp in the set, and turned
 * a good $4 buy into "your call". Conservative is the point; impossible isn't.
 */
export function planningPrice(band: CompBand, settings: ScoutSettings): number | null {
  if (band.pricedCount < MIN_COMPS_FOR_VERDICT) return null;
  if (settings.basis === "median") {
    const median = band.median;
    if (median === undefined || median === null || !(median > 0)) return null;
    return round2(median * (1 - settings.haircut));
  }
  // Low basis: already the conservative read, so it is taken as-is. Falling
  // back to a haircut median when there's no low end keeps that intent.
  const low = band.low;
  if (low !== undefined && low !== null && low > 0) return round2(low);
  const median = band.median;
  if (median === undefined || median === null || !(median > 0)) return null;
  return round2(median * (1 - settings.haircut));
}

/**
 * Net proceeds at a delivered sale price.
 *
 * Worth stating because it is not obvious: it does NOT matter whether you offer
 * free postage or charge the buyer for it. Comps here are compared on DELIVERED
 * price — what the buyer's card is charged — and eBay's fee is charged on that
 * same order total either way. Charge $5 postage and you collect it and hand it
 * to the carrier; offer free postage and you collect $5 more and hand that to
 * the carrier. Same net. So the scout screen has no free-vs-paid toggle, and
 * doesn't need one.
 */
export function netAtDelivered(delivered: number, shipping: number): number {
  return round2(delivered - finalValueFee(delivered) - shipping);
}

/**
 * The most you can pay and still clear both thresholds.
 *
 * Two constraints, and which one binds flips with price. On a cheap item the
 * flat minimum is the ceiling (net $20 allows $10 by the doubling rule, but
 * that leaves only $10 profit); on a dear one the ratio is (net $300 would
 * allow $290 under a $10 floor, at a 3% return). Having both is the point.
 */
export function maxBuyPrice(net: number, settings: ScoutSettings): number | null {
  const byProfit = net - settings.minProfit;
  const byRoi = settings.minRoi >= 0 ? net / (1 + settings.minRoi) : net;
  const max = Math.min(byProfit, byRoi);
  return max > 0 ? round2(max) : null;
}

export interface ScoutInput {
  band: CompBand;
  /** Postage you'd pay to send it. */
  shipping: number;
  /** What the shop wants. Null before you've typed it. */
  asking: number | null;
  settings?: ScoutSettings;
}

export function scout(input: ScoutInput): ScoutResult {
  const settings = input.settings ?? DEFAULT_SCOUT_SETTINGS;
  const shipping = Number.isFinite(input.shipping) ? Math.max(0, input.shipping) : 0;

  const expectedSale = planningPrice(input.band, settings);

  // No verdict on a thin comp set. The tempting failure is to price off two
  // listings and call it a buy — which is how a scouting tool talks someone
  // into a $40 mistake on an item nobody is actually selling.
  if (expectedSale === null) {
    return {
      verdict: "unknown",
      expectedSale: null,
      fee: null,
      shipping,
      net: null,
      profit: null,
      roi: null,
      maxBuy: null,
      blocked: "no-comps",
      reason:
        input.band.pricedCount === 0
          ? "No comparable listings found — this app can't tell you what it's worth."
          : `Only ${input.band.pricedCount} comparable ${input.band.pricedCount === 1 ? "listing" : "listings"} — too few to judge. Trust your own knowledge here.`,
    };
  }

  const fee = round2(finalValueFee(expectedSale));
  const net = netAtDelivered(expectedSale, shipping);
  const maxBuy = maxBuyPrice(net, settings);

  if (net <= 0) {
    return {
      verdict: "skip",
      expectedSale,
      fee,
      shipping,
      net,
      profit: input.asking === null ? null : round2(net - input.asking),
      roi: null,
      maxBuy: null,
      reason: `Fees and postage eat the whole sale price. Nothing left at $${expectedSale.toFixed(2)} delivered.`,
      blocked: null,
    };
  }

  if (input.asking === null || !Number.isFinite(input.asking)) {
    return {
      verdict: "unknown",
      expectedSale,
      fee,
      shipping,
      net,
      profit: null,
      roi: null,
      maxBuy,
      blocked: "no-price",
      reason: maxBuy
        ? `Pay up to $${maxBuy.toFixed(2)} and this clears your rules.`
        : "Even free, this wouldn't clear your rules once fees and postage come off.",
    };
  }

  const asking = Math.max(0, input.asking);
  const profit = round2(net - asking);
  const roi = asking > 0 ? profit / asking : null;

  const meetsProfit = profit >= settings.minProfit;
  // A free item is pure profit, and dividing by zero to prove it helps nobody.
  const meetsRoi = asking === 0 ? true : (roi ?? 0) >= settings.minRoi;

  if (meetsProfit && meetsRoi) {
    return {
      verdict: "buy",
      expectedSale,
      fee,
      shipping,
      net,
      profit,
      roi,
      maxBuy,
      blocked: null,
      reason: `$${profit.toFixed(2)} profit${roi === null ? "" : ` · ${Math.round(roi * 100)}% return`} — clears both your rules.`,
    };
  }

  // Positive but short of a rule. Named separately from "skip" because this is
  // the judgement call a person should actually make: a $9 profit on a $3 item
  // may well be worth it on a slow day, and the tool shouldn't pretend that
  // decision is arithmetic.
  if (profit > 0) {
    const misses = [
      !meetsProfit ? `under your $${settings.minProfit} minimum` : null,
      !meetsRoi ? `under your ${Math.round(settings.minRoi * 100)}% return rule` : null,
    ].filter(Boolean);
    return {
      verdict: "marginal",
      expectedSale,
      fee,
      shipping,
      net,
      profit,
      roi,
      maxBuy,
      blocked: null,
      reason: `$${profit.toFixed(2)} profit — ${misses.join(" and ")}. Your call.`,
    };
  }

  return {
    verdict: "skip",
    expectedSale,
    fee,
    shipping,
    net,
    profit,
    roi,
    maxBuy,
    blocked: null,
    reason:
      maxBuy === null
        ? `You'd lose $${Math.abs(profit).toFixed(2)}. Not worth it at any price.`
        : `You'd lose $${Math.abs(profit).toFixed(2)} at $${asking.toFixed(2)}. Worth it under $${maxBuy.toFixed(2)}.`,
  };
}

/** Short label for the verdict chip. */
export function verdictLabel(v: Verdict): string {
  return v === "buy" ? "BUY" : v === "marginal" ? "YOUR CALL" : v === "skip" ? "SKIP" : "CAN'T TELL";
}

/**
 * The chip to show for a result, which is NOT always the verdict's own label.
 *
 * Two states both come back as "unknown" and they mean opposite things to the
 * person holding the item:
 *
 *   • no-comps — the app genuinely cannot value this. "CAN'T TELL" is right.
 *   • no-price — the app knows exactly what it's worth and is waiting for you
 *     to read the sticker. Labelling that "CAN'T TELL" next to a confident
 *     "Pay up to $4.52" reads as a contradiction and undersells a good answer.
 */
export function chipLabel(result: ScoutResult): string {
  if (result.blocked === "no-price") return "ADD PRICE";
  return verdictLabel(result.verdict);
}

/** Which colour treatment the chip and card get. */
export function chipTone(result: ScoutResult): Verdict | "waiting" {
  return result.blocked === "no-price" ? "waiting" : result.verdict;
}
