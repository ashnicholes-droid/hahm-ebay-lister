// What you actually made, as opposed to what the app predicted you would.
//
// Pure and client-safe on purpose: no eBay import, no process.env, so the Sold
// screen can compute totals as the seller filters and sorts without a round
// trip, and so every rule here is testable without a network.
//
// The governing principle is that an unknown must never be rendered as a zero.
// Three things can be genuinely unknown per order — the acquisition cost, the
// marketplace fee on a very fresh order, and the postage the seller paid — and
// each of them, silently treated as zero, inflates profit. An inflated profit
// figure is worse than no figure at all, because nobody goes looking for it.
// So every total below carries a count of what it had to leave out.

import { FEE_FIXED, FEE_PERCENT } from "./fees";

/** The subset of an order this module needs. Keeps it free of the API shape. */
export interface RealizableOrder {
  orderId: string;
  creationDate: string;
  currency: string;
  buyerPaid: number | null;
  marketplaceFee: number | null;
  refunded: number;
  cancelled: boolean;
}

export interface Realized {
  /** Buyer paid, less eBay's real fee, less refunds. Null if unknowable. */
  net: number | null;
  /** net − cost. Null when either side is unknown. */
  profit: number | null;
  /** Margin on what the buyer paid, as a fraction. Null when profit is. */
  margin: number | null;
  /** Why a figure is missing, ready to render instead of a blank. */
  missing: "fee" | "cost" | "revenue" | null;
}

/**
 * One order's outcome.
 *
 * A cancelled order nets zero rather than null: it is genuinely known, and
 * known to be nothing. Refunds are subtracted from the net but the fee is left
 * as eBay reported it — eBay credits fees on refunds separately and on its own
 * schedule, so subtracting a fee credit here would double-count it.
 */
export function realize(order: RealizableOrder, cost: number | null): Realized {
  // A cancelled order is known, and known to be nothing: the money went back and
  // so did the item. Zero rather than null, and excluded from the period totals
  // entirely so it can't drag an average down as if it were a bad sale.
  if (order.cancelled) {
    return { net: 0, profit: 0, margin: 0, missing: null };
  }
  if (order.buyerPaid === null) {
    return { net: null, profit: null, margin: null, missing: "revenue" };
  }
  if (order.marketplaceFee === null) {
    return { net: null, profit: null, margin: null, missing: "fee" };
  }

  const net = round(order.buyerPaid - order.marketplaceFee - order.refunded);
  if (cost === null) {
    return { net, profit: null, margin: null, missing: "cost" };
  }
  const profit = round(net - cost);
  return {
    net,
    profit,
    margin: order.buyerPaid > 0 ? profit / order.buyerPaid : null,
    missing: null,
  };
}

export interface PeriodSummary {
  currency: string;
  /**
   * Orders in the money figures below: settled, non-cancelled sales.
   *
   * "Settled" means eBay has posted a fee. Very recent orders haven't got one
   * yet, and they are held out of gross/fees/net together rather than being let
   * into gross alone — otherwise the strip prints a gross, a fee total, and a
   * net that visibly don't subtract, and a money screen whose arithmetic fails
   * in front of the reader is worth less than no screen. They are reported
   * separately as `pending` / `pendingGross`.
   */
  orders: number;
  cancelled: number;
  /** Everything buyers paid on those orders, postage included. */
  gross: number;
  /** What eBay actually took, summed from its own per-order figures. */
  fees: number;
  refunds: number;
  /** Exactly gross − fees − refunds. */
  net: number;
  /** Acquisition cost of the items whose cost is known. */
  cost: number;
  /**
   * net − cost, over the orders where BOTH are known.
   *
   * Deliberately not "net minus the costs we happen to have": mixing orders
   * with a known cost into a net that includes orders without one produces a
   * number that is neither revenue nor profit.
   */
  profit: number;
  /** Net over that same subset, so profit has a denominator it belongs to. */
  profitBasis: number;
  /** Orders left out of `profit` because no cost was ever recorded. */
  unknownCost: number;
  /** Sales too recent for eBay to have posted a fee, held out of every total. */
  pending: number;
  /** What buyers paid on those, so the money isn't invisible. */
  pendingGross: number;
  /** True when every order contributed — i.e. the profit figure is complete. */
  complete: boolean;
}

export function summarize(
  orders: RealizableOrder[],
  costOf: (order: RealizableOrder) => number | null
): PeriodSummary {
  const s: PeriodSummary = {
    currency: orders.find((o) => o.currency)?.currency ?? "USD",
    orders: 0,
    cancelled: 0,
    gross: 0,
    fees: 0,
    refunds: 0,
    net: 0,
    cost: 0,
    profit: 0,
    profitBasis: 0,
    unknownCost: 0,
    pending: 0,
    pendingGross: 0,
    complete: true,
  };

  for (const o of orders) {
    if (o.cancelled) {
      s.cancelled++;
      continue;
    }

    // Held out of gross, fees and net together, so those three keep subtracting
    // to each other. Counted and valued separately so the money still shows up.
    if (o.marketplaceFee === null || o.buyerPaid === null) {
      s.pending++;
      s.pendingGross += o.buyerPaid ?? 0;
      s.complete = false;
      continue;
    }

    s.orders++;
    s.gross += o.buyerPaid;
    s.refunds += o.refunded;
    s.fees += o.marketplaceFee;

    const cost = costOf(o);
    const r = realize(o, cost);
    if (r.net !== null) s.net += r.net;

    if (r.profit === null) {
      if (r.missing === "cost") s.unknownCost++;
      s.complete = false;
      continue;
    }
    s.cost += cost ?? 0;
    s.profit += r.profit;
    s.profitBasis += r.net ?? 0;
  }

  for (const k of [
    "gross",
    "fees",
    "refunds",
    "net",
    "cost",
    "profit",
    "profitBasis",
    "pendingGross",
  ] as const) {
    s[k] = round(s[k]);
  }
  return s;
}

export interface FeeAccuracy {
  /** Orders that had both a real fee and a knowable basis. */
  sampled: number;
  /** What lib/fees.ts would have predicted, in total. */
  estimated: number;
  /** What eBay actually charged, in total. */
  actual: number;
  /** actual − estimated. Positive means the app is UNDER-estimating fees. */
  difference: number;
  /** The rate eBay actually charged, implied by the sample. */
  impliedPercent: number | null;
  /** True when the estimate is within a cent-per-dollar of reality. */
  close: boolean;
}

/**
 * Score the app's fee model against eBay's actual charges.
 *
 * Worth its own function because lib/fees.ts (13.25% + $0.40) sits underneath
 * every recommended price, every break-even, and every profit projection in the
 * app — and until orders came back, nothing had ever checked it. Promoted
 * listings, category rates, and international surcharges all push the real rate
 * up, and a seller pricing on a rate that is quietly 3 points low is losing
 * money on every marginal item.
 */
export function feeAccuracy(
  orders: { buyerPaid: number | null; marketplaceFee: number | null; cancelled: boolean }[]
): FeeAccuracy {
  let sampled = 0;
  let estimated = 0;
  let actual = 0;
  let basis = 0;

  for (const o of orders) {
    if (o.cancelled || o.buyerPaid === null || o.marketplaceFee === null) continue;
    sampled++;
    estimated += o.buyerPaid * FEE_PERCENT + FEE_FIXED;
    actual += o.marketplaceFee;
    basis += o.buyerPaid;
  }

  const difference = round(actual - estimated);
  return {
    sampled,
    estimated: round(estimated),
    actual: round(actual),
    difference,
    impliedPercent: basis > 0 ? actual / basis : null,
    // Within a cent per dollar of order value, across the sample. Tighter than
    // that is noise; looser than that changes which items are worth listing.
    close: sampled === 0 || Math.abs(difference) <= basis * 0.01,
  };
}

/** Orders grouped by calendar month, newest first — how a seller reads a year. */
export function byMonth<T extends { creationDate: string }>(orders: T[]): {
  key: string;
  label: string;
  orders: T[];
}[] {
  const groups = new Map<string, T[]>();
  for (const o of orders) {
    const d = new Date(o.creationDate);
    const key = Number.isNaN(d.getTime())
      ? "unknown"
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, list]) => ({ key, label: monthLabel(key), orders: list }));
}

function monthLabel(key: string): string {
  if (key === "unknown") return "Undated";
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Money rounds to cents, and only at the point it is reported. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
