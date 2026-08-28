// What actually sold, and what eBay actually paid you for it.
//
// Everything else in this app happens BEFORE a sale: it writes listings, prices
// them against comps, estimates postage, estimates fees, and publishes. Then an
// item sold and the app never found out. That left two holes worth closing:
//
//   1. Profit was always an ESTIMATE. lib/fees.ts models eBay's cut as 13.25%
//      + $0.40, which is right for most categories and wrong for some, and it
//      cannot know about promoted-listing fees, international surcharges, or a
//      below-standard penalty. eBay reports the real number per order in
//      `totalMarketplaceFee`. Reading it turns every profit figure in the app
//      from a projection into a fact — and lets the estimate be scored against
//      reality (see lib/realizedProfit.ts).
//   2. There was no answer to "what did I make last month", which is also the
//      number needed at tax time.
//
// This runs on `sell.fulfillment`, which has been in CORE_SCOPES since the
// first version of the OAuth flow — so no reconnect and no new permission.
//
// ⚠️ Written from eBay's docs and not yet run against a live seller account.
// It is read-only apart from markShipped, so a wrong guess costs a view that
// doesn't load rather than anything on eBay. Two specific defences below: the
// date filter is applied AGAIN client-side, and a filter eBay rejects falls back
// to an unfiltered read. A silent empty list here would read as "you sold
// nothing", which is the worst possible way for this to be wrong.

import { EBAY_FUL_BASE } from "./config";

/** eBay's cap per page. */
export const ORDERS_PAGE_SIZE = 200;

/** How far back to look by default. */
export const ORDERS_WINDOW_DAYS = 90;

export interface OrderItem {
  lineItemId: string;
  /** The listing this line came from, for linking back to it. */
  legacyItemId: string;
  /** Our SKU — how a sale is matched to the cost we recorded when listing. */
  sku: string;
  title: string;
  quantity: number;
  /** What the buyer paid for the item alone, before postage. */
  itemCost: number | null;
  /** Postage attributed to this line. */
  shippingCost: number | null;
  fulfilled: boolean;
}

export interface ShipTo {
  name: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  countryCode: string;
}

export interface SoldOrder {
  orderId: string;
  /** The number eBay shows in Seller Hub, which is what a seller recognises. */
  legacyOrderId: string;
  creationDate: string;
  currency: string;
  /** NOT_STARTED | IN_PROGRESS | FULFILLED — whether it still needs shipping. */
  fulfillmentStatus: string;
  paymentStatus: string;
  buyerUsername: string;
  /**
   * What the buyer paid in total, postage included.
   *
   * Not the item price: eBay charges its fee on the whole order, so this is the
   * figure every other number here is derived from.
   */
  buyerPaid: number | null;
  /** Postage the buyer was charged. Zero on a free-shipping listing. */
  deliveryCost: number | null;
  /**
   * eBay's ACTUAL fee for this order. Null when eBay didn't report one — which
   * happens on very fresh orders — and null must not be read as "no fee".
   */
  marketplaceFee: number | null;
  /** What eBay charged that fee on, for checking it against our estimate. */
  feeBasis: number | null;
  /** Refunds already issued. Money that left again. */
  refunded: number;
  /** eBay's own figure for what it owes the seller, when it gives one. */
  dueSeller: number | null;
  cancelled: boolean;
  items: OrderItem[];
  shipTo: ShipTo | null;
  /** When eBay expects it handed to the carrier. */
  shipByDate: string;
  /** Whether tracking has already been uploaded for the whole order. */
  shipped: boolean;
}

export interface OrdersResult {
  orders: SoldOrder[];
  /** How far back this actually looked. */
  windowDays: number;
  /**
   * Non-fatal notes — a rejected filter, a truncated page. Surfaced rather than
   * swallowed, because "no orders" and "we couldn't read your orders" look
   * identical on screen and mean opposite things.
   */
  warnings: string[];
}

export class FulfillmentApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** eBay money is `{value: "12.34", currency: "USD"}`, with value a string. */
function money(node: unknown): number | null {
  const v = (node as { value?: unknown })?.value;
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function currencyOf(...nodes: unknown[]): string {
  for (const n of nodes) {
    const c = (n as { currency?: unknown })?.currency;
    if (typeof c === "string" && c) return c;
  }
  return "USD";
}

function parseItem(raw: Record<string, any>): OrderItem {
  return {
    lineItemId: String(raw.lineItemId ?? ""),
    legacyItemId: String(raw.legacyItemId ?? ""),
    sku: String(raw.sku ?? ""),
    title: String(raw.title ?? ""),
    quantity: Number(raw.quantity) || 1,
    // discountedLineItemCost is what the buyer actually paid when a promotion
    // applied; lineItemCost is the pre-discount figure. Preferring the wrong one
    // overstates every sale that used a multi-buy discount.
    itemCost: money(raw.discountedLineItemCost) ?? money(raw.lineItemCost),
    shippingCost: money(raw.deliveryCost?.shippingCost),
    fulfilled: String(raw.lineItemFulfillmentStatus ?? "") === "FULFILLED",
  };
}

function parseShipTo(raw: Record<string, any>): ShipTo | null {
  const step = raw.fulfillmentStartInstructions?.[0]?.shippingStep;
  const addr = step?.shipTo?.contactAddress;
  if (!addr) return null;
  return {
    name: String(step.shipTo?.fullName ?? ""),
    city: String(addr.city ?? ""),
    stateOrProvince: String(addr.stateOrProvince ?? ""),
    postalCode: String(addr.postalCode ?? ""),
    countryCode: String(addr.countryCode ?? ""),
  };
}

export function parseOrder(raw: Record<string, any>): SoldOrder | null {
  const orderId = String(raw.orderId ?? "");
  if (!orderId) return null;

  const pricing = raw.pricingSummary ?? {};
  const payment = raw.paymentSummary ?? {};
  const refunds: unknown[] = Array.isArray(payment.refunds) ? payment.refunds : [];
  const fulfillmentStatus = String(raw.orderFulfillmentStatus ?? "");

  return {
    orderId,
    legacyOrderId: String(raw.legacyOrderId ?? ""),
    creationDate: String(raw.creationDate ?? ""),
    currency: currencyOf(pricing.total, pricing.priceSubtotal, raw.totalMarketplaceFee),
    fulfillmentStatus,
    paymentStatus: String(raw.orderPaymentStatus ?? ""),
    buyerUsername: String(raw.buyer?.username ?? ""),
    buyerPaid: money(pricing.total),
    deliveryCost: money(pricing.deliveryCost),
    marketplaceFee: money(raw.totalMarketplaceFee),
    feeBasis: money(raw.totalFeeBasisAmount),
    refunded: refunds.reduce<number>((sum, r) => sum + (money((r as any)?.amount) ?? 0), 0),
    dueSeller: money(payment.totalDueSeller),
    // Anything past NONE_REQUESTED means the sale is unwinding, and counting it
    // as revenue would overstate the month.
    cancelled: String(raw.cancelStatus?.cancelState ?? "NONE_REQUESTED") !== "NONE_REQUESTED",
    items: (Array.isArray(raw.lineItems) ? raw.lineItems : []).map(parseItem),
    shipTo: parseShipTo(raw),
    shipByDate: String(
      raw.lineItems?.[0]?.lineItemFulfillmentInstructions?.shipByDate ?? ""
    ),
    shipped: fulfillmentStatus === "FULFILLED",
  };
}

async function ebayJson(
  accessToken: string,
  url: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is itself the error message */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

/** eBay's first error sentence, or a fallback naming the status. */
function errorMessage(json: any, text: string, status: number): string {
  const e = json?.errors?.[0];
  const msg = e?.longMessage || e?.message;
  if (msg) return String(msg);
  if (status === 401 || status === 403) {
    return "eBay refused the request. Reconnect your account and try again.";
  }
  return text.slice(0, 300) || `eBay returned HTTP ${status}.`;
}

/**
 * Orders created in the last `windowDays`.
 *
 * The date filter is sent to eBay AND applied again here. That is not
 * belt-and-braces for its own sake: if the filter syntax is wrong, eBay's most
 * likely responses are a 400 (handled — we retry without it) or a silently
 * ignored parameter that returns everything. Filtering locally means the answer
 * is right in both cases, and the window is never quietly wider than it claims.
 */
export async function fetchOrders(
  accessToken: string,
  windowDays = ORDERS_WINDOW_DAYS
): Promise<OrdersResult> {
  const warnings: string[] = [];
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const sinceIso = since.toISOString();

  const page = async (offset: number, withFilter: boolean) => {
    const params = new URLSearchParams({
      limit: String(ORDERS_PAGE_SIZE),
      offset: String(offset),
    });
    // eBay's syntax: creationdate:[<start>..]. URLSearchParams percent-encodes
    // the brackets and colon; eBay decodes them, and this is what its own SDKs
    // send. The fallback below covers the case where it doesn't.
    if (withFilter) params.set("filter", `creationdate:[${sinceIso}..]`);
    return ebayJson(accessToken, `${EBAY_FUL_BASE}/order?${params}`);
  };

  let useFilter = true;
  let first = await page(0, true);
  if (!first.ok && first.status === 400) {
    // Most likely the filter. Losing the whole view over a query parameter
    // would be a poor trade when the window can be applied locally instead.
    warnings.push("eBay rejected the date filter, so orders were filtered here instead.");
    useFilter = false;
    first = await page(0, false);
  }
  if (!first.ok) {
    throw new FulfillmentApiError(
      errorMessage(first.json, first.text, first.status),
      first.status
    );
  }

  const raw: Record<string, any>[] = [...(first.json?.orders ?? [])];
  const total = Number(first.json?.total) || raw.length;

  // Page through the rest, with a hard stop so a bad `total` can't spin.
  for (let offset = ORDERS_PAGE_SIZE; offset < total && offset < 2000; offset += ORDERS_PAGE_SIZE) {
    const next = await page(offset, useFilter);
    if (!next.ok) {
      warnings.push(
        `Only the first ${raw.length} orders could be read — ${errorMessage(next.json, next.text, next.status)}`
      );
      break;
    }
    const batch = next.json?.orders ?? [];
    if (!batch.length) break;
    raw.push(...batch);
  }

  const cutoff = since.getTime();
  const orders = raw
    .map(parseOrder)
    .filter((o): o is SoldOrder => o !== null)
    .filter((o) => {
      const t = Date.parse(o.creationDate);
      return Number.isNaN(t) ? true : t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.creationDate) - Date.parse(a.creationDate));

  return { orders, windowDays, warnings };
}

export interface ShipmentInput {
  orderId: string;
  trackingNumber: string;
  /** eBay's carrier code — USPS, UPS, FedEx… */
  carrier: string;
  /** Which lines went in the box. Empty means the whole order. */
  lineItems?: { lineItemId: string; quantity: number }[];
  shippedDate?: string;
}

/**
 * Add tracking and mark an order shipped.
 *
 * The one write in this module. eBay wants only alphanumerics in a tracking
 * number — the number printed on a label is often spaced in groups of four, and
 * sending it with the spaces is rejected — so it is stripped here rather than
 * relying on whoever is typing.
 */
export async function markShipped(
  accessToken: string,
  input: ShipmentInput
): Promise<{ fulfillmentId: string | null }> {
  const tracking = input.trackingNumber.replace(/[^A-Za-z0-9]/g, "");
  if (!tracking) throw new FulfillmentApiError("Enter a tracking number.", 400);
  if (!input.carrier.trim()) throw new FulfillmentApiError("Choose a carrier.", 400);

  const body: Record<string, unknown> = {
    trackingNumber: tracking,
    shippingCarrierCode: input.carrier.trim(),
    shippedDate: input.shippedDate || new Date().toISOString(),
  };
  // Omitted entirely rather than sent empty: eBay treats an absent lineItems as
  // "everything in the order", and an empty array as a malformed request.
  if (input.lineItems?.length) body.lineItems = input.lineItems;

  const { ok, status, json, text } = await ebayJson(
    accessToken,
    `${EBAY_FUL_BASE}/order/${encodeURIComponent(input.orderId)}/shipping_fulfillment`,
    { method: "POST", body: JSON.stringify(body) }
  );
  if (!ok) throw new FulfillmentApiError(errorMessage(json, text, status), status);

  return { fulfillmentId: json?.fulfillmentId ?? null };
}

/**
 * Carriers eBay accepts, for a dropdown rather than a free-text field.
 *
 * A mistyped carrier code is rejected by eBay after the seller has already
 * typed the tracking number, which is exactly the moment to not waste.
 */
export const SHIPPING_CARRIERS = [
  { code: "USPS", label: "USPS" },
  { code: "UPS", label: "UPS" },
  { code: "FedEx", label: "FedEx" },
  { code: "DHL", label: "DHL" },
  { code: "OTHER", label: "Other" },
] as const;
