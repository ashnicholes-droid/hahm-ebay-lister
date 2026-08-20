// Seller-initiated offers to interested buyers.
//
// eBay lets you send a discount to people who watched or carted a listing but
// didn't buy. Two calls: one asks which listings currently have such buyers, the
// other sends the offer.
//
// ⚠️ Written from eBay's Negotiation API docs and not exercised against a live
// seller account from here. This one WRITES something a buyer sees and can
// accept, so it is the most consequential module in the app — an offer cannot be
// unsent. Everything below is built accordingly: eligibility comes from eBay
// rather than being inferred, every bound is checked before the call, and the
// UI confirms the actual discounted price before anything is sent.

import { EBAY_MARKETPLACE_ID } from "./config";

const NEGOTIATION_BASE = "https://api.ebay.com/sell/negotiation/v1";

/**
 * eBay requires a real discount — Seller Hub enforces 5% as the floor, and
 * anything less is rejected. The ceiling is this app's, not eBay's: past this a
 * "discount" is far more likely to be a typo than an intention.
 */
export const MIN_DISCOUNT_PERCENT = 5;
export const MAX_DISCOUNT_PERCENT = 60;

/** eBay caps the buyer-facing note. */
export const MAX_OFFER_MESSAGE = 250;

/** eBay accepts 1 or 2 days for a seller-initiated offer. */
export const OFFER_DURATION_DAYS = [1, 2] as const;

export interface EligibleItems {
  /** Listing ids eBay says currently have interested buyers. */
  listingIds: Set<string>;
  /** Set when eligibility couldn't be determined — never guessed at. */
  unavailable?: string;
  debug?: NegotiationDebug;
}

export interface NegotiationDebug {
  httpStatus: number;
  endpoint: string;
  errors?: {
    errorId: number;
    message?: string;
    longMessage?: string;
    parameters?: { name: string; value: string }[];
  }[];
  raw?: string;
}

export interface SendOfferInput {
  listingId: string;
  discountPercent: number;
  message?: string;
  durationDays?: number;
  allowCounterOffer?: boolean;
  quantity?: number;
}

export interface SendOfferResult {
  ok: boolean;
  offerId?: string;
  error?: string;
  debug?: NegotiationDebug;
}

interface Resp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function negotiationRequest(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Resp> {
  const resp = await fetch(`${NEGOTIATION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
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

function collectDebug(endpoint: string, r: Resp): NegotiationDebug {
  const errs = Array.isArray(r.json?.errors) ? r.json.errors : [];
  return {
    httpStatus: r.status,
    endpoint,
    ...(errs.length
      ? {
          errors: errs.slice(0, 5).map((e: any) => ({
            errorId: Number(e?.errorId || 0),
            ...(e?.message ? { message: String(e.message).slice(0, 400) } : {}),
            ...(e?.longMessage ? { longMessage: String(e.longMessage).slice(0, 400) } : {}),
            ...(Array.isArray(e?.parameters) && e.parameters.length
              ? {
                  parameters: e.parameters.slice(0, 8).map((p: any) => ({
                    name: String(p?.name ?? ""),
                    value: String(p?.value ?? "").slice(0, 200),
                  })),
                }
              : {}),
          })),
        }
      : {}),
    ...(errs.length === 0 && r.text ? { raw: r.text.slice(0, 800) } : {}),
  };
}

function ebaySentence(debug: NegotiationDebug, fallback: string): string {
  const first = debug.errors?.[0];
  const said = first?.longMessage || first?.message;
  return said || `${fallback} (HTTP ${debug.httpStatus})`;
}

const SCOPE_HINT =
  "Sending offers needs eBay's negotiation permission, which this connection doesn't have. Disconnect and reconnect eBay once to add it.";

/**
 * Which listings currently have buyers worth offering to.
 *
 * This is eBay's answer, not a guess from watch counts. A listing can have
 * watchers and still be ineligible — eBay applies its own rules about how
 * recently interest was shown and how many offers a listing has already had —
 * and inventing eligibility would produce a button that fails when pressed.
 *
 * Never throws; an unavailable result leaves the rest of the page working.
 */
export async function fetchEligibleItems(accessToken: string): Promise<EligibleItems> {
  const listingIds = new Set<string>();
  const limit = 200;

  try {
    for (let offset = 0, page = 0; page < 5; page++, offset += limit) {
      const path = `/find_eligible_items?limit=${limit}&offset=${offset}`;
      const r = await negotiationRequest(accessToken, "GET", path);

      if (r.status === 401 || r.status === 403) {
        return { listingIds, unavailable: SCOPE_HINT, debug: collectDebug(path, r) };
      }
      if (!r.ok) {
        const debug = collectDebug(path, r);
        return {
          listingIds,
          unavailable: ebaySentence(debug, "eBay couldn't say which listings can take an offer"),
          debug,
        };
      }

      const items: any[] = Array.isArray(r.json?.eligibleItems) ? r.json.eligibleItems : [];
      for (const item of items) {
        const id = String(item?.listingId ?? "").trim();
        if (id) listingIds.add(id);
      }
      if (items.length < limit) break;
    }
    return { listingIds };
  } catch (e) {
    return {
      listingIds,
      unavailable: `Couldn't check offer eligibility (${(e as Error).message}).`,
    };
  }
}

/** Reject anything eBay would reject, before an irreversible call is made. */
export function validateOffer(
  input: Pick<SendOfferInput, "discountPercent" | "message" | "durationDays">
): { ok: true } | { error: string } {
  const pct = Number(input.discountPercent);
  if (!Number.isFinite(pct)) return { error: "The discount has to be a number." };
  if (!Number.isInteger(pct)) return { error: "eBay only accepts whole-number discounts." };
  if (pct < MIN_DISCOUNT_PERCENT) {
    return {
      error: `eBay requires at least ${MIN_DISCOUNT_PERCENT}% off for a seller offer — anything less is rejected.`,
    };
  }
  if (pct > MAX_DISCOUNT_PERCENT) {
    return {
      error: `${pct}% off looks like a typo. The cap here is ${MAX_DISCOUNT_PERCENT}%.`,
    };
  }
  if ((input.message ?? "").length > MAX_OFFER_MESSAGE) {
    return { error: `The message to buyers is capped at ${MAX_OFFER_MESSAGE} characters.` };
  }
  const days = input.durationDays ?? OFFER_DURATION_DAYS[OFFER_DURATION_DAYS.length - 1];
  if (!OFFER_DURATION_DAYS.includes(days as (typeof OFFER_DURATION_DAYS)[number])) {
    return { error: `eBay allows an offer to run for ${OFFER_DURATION_DAYS.join(" or ")} days.` };
  }
  return { ok: true };
}

/** What the buyer would pay at this discount. */
export function offeredPrice(price: number, discountPercent: number): number {
  return Math.round(price * (1 - discountPercent / 100) * 100) / 100;
}

/**
 * Send one offer to everyone watching one listing.
 *
 * Deliberately one listing per call rather than batching the whole page: the
 * batch endpoint reports per-item failures inside a success response, and
 * unpicking that to tell a seller which of forty offers actually went out is
 * more ways to be wrong than sending them one at a time.
 */
export async function sendOfferToInterestedBuyers(
  accessToken: string,
  input: SendOfferInput
): Promise<SendOfferResult> {
  const check = validateOffer(input);
  if ("error" in check) return { ok: false, error: check.error };
  if (!input.listingId.trim()) {
    return { ok: false, error: "No listing id, so there's nothing to send an offer on." };
  }

  const path = "/send_offer_to_interested_buyers";
  const body = {
    offeredItems: [
      {
        listingId: input.listingId,
        quantity: Math.max(1, Math.floor(input.quantity ?? 1)),
        discountPercentage: String(Math.round(input.discountPercent)),
      },
    ],
    allowCounterOffer: input.allowCounterOffer ?? true,
    offerDuration: { unit: "DAY", value: input.durationDays ?? 2 },
    ...(input.message?.trim() ? { message: input.message.trim().slice(0, MAX_OFFER_MESSAGE) } : {}),
  };

  try {
    const r = await negotiationRequest(accessToken, "POST", path, body);
    const debug = collectDebug(path, r);

    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: SCOPE_HINT, debug };
    }
    if (!r.ok) {
      return { ok: false, error: ebaySentence(debug, "eBay refused the offer"), debug };
    }

    // A 2xx with no offer in it is not a success worth reporting as one.
    const offers: any[] = Array.isArray(r.json?.offers) ? r.json.offers : [];
    const offerId = String(offers[0]?.offerId ?? "").trim();
    if (!offerId) {
      return {
        ok: false,
        error:
          "eBay accepted the request but didn't return an offer, so it isn't clear anything was sent. Check Seller Hub before resending.",
        debug,
      };
    }
    return { ok: true, offerId };
  } catch (e) {
    return { ok: false, error: `The offer couldn't be sent (${(e as Error).message}).` };
  }
}
