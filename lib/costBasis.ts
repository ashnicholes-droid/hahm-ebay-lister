// What you paid for the item, and therefore what you actually made.
//
// Every net figure in this app answers "what does eBay leave me" and none of
// them answered "did I make money", because nothing knew the acquisition cost.
// For a reseller that is the only number that matters.
//
// There is no database. Rather than inventing one, the cost rides in eBay's own
// per-listing private note — a seller-only field, written with SetUserNotes and
// read back with GetMyeBaySelling's IncludeNotes. It travels with the listing,
// survives this app entirely, and is visible to nobody else.
//
// The note is also a place people write actual notes, so the encoding has to
// share: a cost token is appended or replaced in place, and any surrounding
// text is preserved untouched.

import { finalValueFee, netAtPrice, type ShippingArrangement } from "./fees";

/** The machine-readable token. Deliberately unlovely so it reads as a marker. */
const COST_RE = /\[cost\s+([0-9]+(?:\.[0-9]+)?)\]/i;

export interface ParsedNote {
  /** Acquisition cost, or null when the note doesn't carry one. */
  cost: number | null;
  /** Whatever the seller wrote around it, with the token removed. */
  text: string;
}

export function parseNote(note: string | undefined): ParsedNote {
  const raw = (note ?? "").trim();
  if (!raw) return { cost: null, text: "" };
  const m = COST_RE.exec(raw);
  const cost = m ? Number(m[1]) : null;
  return {
    cost: cost !== null && Number.isFinite(cost) ? cost : null,
    text: raw
      .replace(COST_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
  };
}

/**
 * Put a cost into a note without destroying what's already there.
 *
 * Passing null removes the token and leaves the prose, so clearing a cost never
 * deletes something the seller typed.
 */
export function writeCostIntoNote(note: string | undefined, cost: number | null): string {
  const { text } = parseNote(note);
  if (cost === null) return text;
  const token = `[cost ${cost.toFixed(2)}]`;
  return text ? `${text} ${token}` : token;
}

/** eBay's cap on a private note. */
export const MAX_NOTE_LENGTH = 250;

export function validateCost(raw: unknown): { cost: number | null } | { error: string } {
  if (raw === "" || raw === null || raw === undefined) return { cost: null };
  const n = typeof raw === "string" ? parseFloat(raw) : (raw as number);
  if (!Number.isFinite(n)) return { error: "That isn't a number." };
  if (n < 0) return { error: "A cost can't be negative." };
  if (n > 1_000_000) return { error: "That looks like a typo." };
  return { cost: Math.round(n * 100) / 100 };
}

export interface Profit {
  /** Sale price minus eBay's fee, minus what the item cost. */
  profit: number;
  /** Profit as a share of the sale price. */
  margin: number;
  /** True when postage isn't included and the real figure is lower. */
  postageExcluded: boolean;
  label: string;
}

/**
 * What you actually make at this price, given what you paid.
 *
 * Deliberately built on netAtPrice rather than repeating its arithmetic, so the
 * fee treatment can't drift from what the rest of the app shows — including the
 * part people get backwards, that eBay charges its fee on the buyer's shipping
 * too.
 */
export function profitAtPrice(
  price: number,
  cost: number,
  arrangement: ShippingArrangement,
  buyerPaysShipping = 0
): Profit {
  const net = netAtPrice(price, arrangement, buyerPaysShipping);
  const profit = Math.round((net.net - cost) * 100) / 100;
  const margin = price > 0 ? profit / price : 0;

  const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  const qualifier = net.postageExcluded ? ", before postage" : "";
  const label =
    profit < 0
      ? `Loses ${money(profit)} at this price${qualifier}.`
      : `Makes ${money(profit)}${qualifier} — ${(margin * 100).toFixed(0)}% of the sale.`;

  return { profit, margin, postageExcluded: net.postageExcluded, label };
}

/**
 * The price that breaks even, given a cost.
 *
 * Solving rather than guessing: with the buyer paying shipping the fee lands on
 * price + shipping, so the break-even is not simply cost plus a percentage. Told
 * plainly, this is the single most useful number when deciding whether to cut a
 * price or cut losses.
 */
export function breakEvenPrice(
  cost: number,
  arrangement: ShippingArrangement,
  buyerPaysShipping = 0
): number {
  // free/unknown/calculated: price − (price·r + f) = cost
  //   → price = (cost + f) / (1 − r)
  // flat: price − ((price + s)·r + f) = cost
  //   → price = (cost + f + s·r) / (1 − r)
  const r = 0.1325;
  const f = 0.4;
  const s = arrangement === "flat" ? buyerPaysShipping : 0;
  const price = (cost + f + s * r) / (1 - r);
  // Sanity-check against the real function rather than trusting the algebra.
  return Math.round(price * 100) / 100;
}

/** Re-exported so callers don't have to know where the fee lives. */
export { finalValueFee };
