// Changing a live listing's price and Best Offer terms.
//
// ⚠️ Written from eBay's docs and not yet run against a live seller account.
// Unlike the read path this one WRITES, so it is built to fail closed: every
// change is validated before it is sent, the offer is re-read after the write
// to confirm what eBay actually stored, and nothing is ever guessed.
//
// Why this module has to exist at all: a listing created through the Sell
// Inventory API is *managed* by that API. eBay restricts Seller Hub's quick-edit
// on those listings and rejects Trading's ReviseFixedPriceItem for them, so for
// anything this app posted, an in-app editor is not a convenience — it is the
// only way to change the price.
//
// Listings made elsewhere (Seller Hub, another tool) are NOT inventory-managed
// and need the Trading path instead. Rather than guess which is which from the
// listing data, `findOffer` asks: a SKU that resolves to an offer is
// inventory-managed, and one that doesn't isn't. That is a fact, not a heuristic.

import { EBAY_INV_BASE, EBAY_MARKETPLACE_ID } from "./config";

/** Nothing in this app should ever push a price outside these bounds. */
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 500000;

export interface OfferRef {
  offerId: string;
  sku: string;
  listingId: string;
  price: number | null;
  currency: string;
  bestOfferEnabled: boolean;
  autoAcceptPrice: number | null;
  autoDeclinePrice: number | null;
}

export interface ReviseResult {
  ok: boolean;
  /** What eBay reports the offer holds AFTER the write. */
  offer?: OfferRef;
  error?: string;
  /** True when the listing isn't managed by the Inventory API at all. */
  notInventoryManaged?: boolean;
}

interface Resp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function inventoryRequest(
  accessToken: string,
  method: string,
  url: string,
  body?: unknown
): Promise<Resp> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* empty 204 or an HTML error page */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

function ebayMessage(r: Resp, fallback: string): string {
  const errs = r.json?.errors;
  if (Array.isArray(errs) && errs.length) {
    const first = errs[0];
    const msg = first.longMessage || first.message;
    if (msg) return `${String(msg).slice(0, 300)} (eBay error ${first.errorId ?? "?"})`;
  }
  return `${fallback} (HTTP ${r.status})`;
}

function toOfferRef(o: any): OfferRef {
  const terms = o?.listingPolicies?.bestOfferTerms ?? {};
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    offerId: String(o?.offerId ?? ""),
    sku: String(o?.sku ?? ""),
    listingId: String(o?.listing?.listingId ?? ""),
    price: num(o?.pricingSummary?.price?.value),
    currency: String(o?.pricingSummary?.price?.currency ?? "USD"),
    bestOfferEnabled: terms?.bestOfferEnabled === true,
    autoAcceptPrice: num(terms?.autoAcceptPrice?.value),
    autoDeclinePrice: num(terms?.autoDeclinePrice?.value),
  };
}

/**
 * The offer behind a SKU, or null when this listing isn't inventory-managed.
 *
 * Resolved on demand rather than for the whole list: the browse view draws from
 * one Trading call, and paying an extra API call per row to prefetch offer ids
 * nobody will use would make the screen slow for no benefit.
 */
export async function findOffer(
  accessToken: string,
  sku: string
): Promise<{ offer: OfferRef | null; error?: string }> {
  if (!sku.trim()) return { offer: null };
  const url =
    `${EBAY_INV_BASE}/offer?sku=${encodeURIComponent(sku)}` +
    `&marketplace_id=${encodeURIComponent(EBAY_MARKETPLACE_ID)}&limit=10`;
  const r = await inventoryRequest(accessToken, "GET", url);

  // 404 is the documented "no offers for this SKU" answer, which here means
  // "not inventory-managed" rather than an error worth showing.
  if (r.status === 404) return { offer: null };
  if (!r.ok) return { offer: null, error: ebayMessage(r, "Couldn't look up this listing") };

  const offers: any[] = Array.isArray(r.json?.offers) ? r.json.offers : [];
  // A SKU can carry more than one offer across marketplaces; take the published
  // one, since that is the listing the seller is looking at.
  const published =
    offers.find((o) => o?.status === "PUBLISHED" && o?.listing?.listingId) ?? offers[0];
  return { offer: published ? toOfferRef(published) : null };
}

/** Reject anything eBay would reject, before spending a call on it. */
export function validatePrice(raw: unknown): { price: number } | { error: string } {
  const n = typeof raw === "string" ? parseFloat(raw) : (raw as number);
  if (!Number.isFinite(n)) return { error: "That isn't a number." };
  if (n < MIN_PRICE) return { error: `A price has to be at least $${MIN_PRICE.toFixed(2)}.` };
  if (n > MAX_PRICE) return { error: `$${n} looks like a typo — the cap here is $${MAX_PRICE}.` };
  return { price: Math.round(n * 100) / 100 };
}

export interface BestOfferInput {
  enabled: boolean;
  /** Offers at or above this are accepted automatically. Null clears it. */
  autoAcceptPrice?: number | null;
  /** Offers below this are declined automatically. Null clears it. */
  autoDeclinePrice?: number | null;
}

/**
 * Best Offer terms only make sense in a particular order. Checked here so the
 * seller gets a sentence rather than an eBay error id.
 */
export function validateBestOffer(
  input: BestOfferInput,
  price: number
): { ok: true } | { error: string } {
  if (!input.enabled) return { ok: true };
  const accept = input.autoAcceptPrice ?? null;
  const decline = input.autoDeclinePrice ?? null;
  if (accept !== null && (!Number.isFinite(accept) || accept <= 0)) {
    return { error: "The auto-accept price has to be a positive number." };
  }
  if (decline !== null && (!Number.isFinite(decline) || decline <= 0)) {
    return { error: "The auto-decline price has to be a positive number." };
  }
  if (accept !== null && accept > price) {
    return {
      error: `Auto-accept ($${accept.toFixed(2)}) is above the asking price ($${price.toFixed(2)}), so it could never trigger.`,
    };
  }
  if (accept !== null && decline !== null && decline > accept) {
    return {
      error: `Auto-decline ($${decline.toFixed(2)}) is above auto-accept ($${accept.toFixed(2)}), which would decline offers you'd have accepted.`,
    };
  }
  return { ok: true };
}

/**
 * Apply a price and/or Best Offer change to a published offer.
 *
 * eBay's offer update is a full replacement, so the current offer is fetched
 * and merged rather than PUT from scratch — sending only the changed field
 * would blank the rest of the listing.
 */
export async function reviseOffer(
  accessToken: string,
  args: { sku: string; price?: number; bestOffer?: BestOfferInput }
): Promise<ReviseResult> {
  const { offer, error } = await findOffer(accessToken, args.sku);
  if (error) return { ok: false, error };
  if (!offer) {
    return {
      ok: false,
      notInventoryManaged: true,
      error:
        "This listing isn't managed by the Inventory API, so it can't be edited here. It was almost certainly created outside this app — edit it in Seller Hub instead.",
    };
  }

  const current = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`
  );
  if (!current.ok) {
    return { ok: false, error: ebayMessage(current, "Couldn't read the current listing") };
  }

  const body: any = { ...current.json };
  // These are set at creation and rejected on update.
  delete body.offerId;
  delete body.sku;
  delete body.marketplaceId;
  delete body.format;
  delete body.listing;
  delete body.status;

  const price = args.price ?? offer.price ?? 0;
  if (args.price !== undefined) {
    body.pricingSummary = {
      ...(body.pricingSummary ?? {}),
      price: { value: args.price.toFixed(2), currency: offer.currency },
    };
  }

  if (args.bestOffer) {
    const check = validateBestOffer(args.bestOffer, price);
    if ("error" in check) return { ok: false, error: check.error };
    const policies = { ...(body.listingPolicies ?? {}) };
    if (args.bestOffer.enabled) {
      policies.bestOfferTerms = {
        bestOfferEnabled: true,
        ...(args.bestOffer.autoAcceptPrice != null
          ? {
              autoAcceptPrice: {
                value: args.bestOffer.autoAcceptPrice.toFixed(2),
                currency: offer.currency,
              },
            }
          : {}),
        ...(args.bestOffer.autoDeclinePrice != null
          ? {
              autoDeclinePrice: {
                value: args.bestOffer.autoDeclinePrice.toFixed(2),
                currency: offer.currency,
              },
            }
          : {}),
      };
    } else {
      policies.bestOfferTerms = { bestOfferEnabled: false };
    }
    body.listingPolicies = policies;
  }

  const upd = await inventoryRequest(
    accessToken,
    "PUT",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`,
    body
  );
  if (!upd.ok) return { ok: false, error: ebayMessage(upd, "eBay rejected the change") };

  // Read it back. A 204 means eBay accepted the request, not that the live
  // listing now shows what was asked for — and "did my price actually change"
  // is the entire question this screen exists to answer.
  const after = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`
  );
  if (!after.ok) {
    return {
      ok: true,
      error: "The change was accepted, but eBay wouldn't confirm the new value. Refresh to check.",
    };
  }
  return { ok: true, offer: toOfferRef(after.json) };
}
