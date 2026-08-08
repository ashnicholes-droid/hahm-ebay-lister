// Multi-buy ("volume") discounts, via eBay's Marketing API.
//
// ⚠️ READ THIS BEFORE TRUSTING IT. Unlike the rest of the publish pipeline, this
// module has NOT been exercised against a live eBay account — it is written from
// the Marketing API documentation for createItemPromotion / updateItemPromotion.
// The first real run is the real test. Everything here is therefore built so
// that being wrong is cheap:
//
//   • It runs AFTER the listing is live, never before. A promotion failure
//     cannot cost you a published listing.
//   • It never throws. Every failure comes back as a warning that lands on the
//     item's card, so a silent no-op is impossible.
//   • It is opt-in per listing. Sellers who don't tick the box never touch it.
//
// Design note on promotion reuse: eBay models a multi-buy discount as an
// account-level *promotion* containing a set of listing IDs, not as a property
// of one listing. Creating one promotion per listing would leave someone who
// lists a few hundred items with a few hundred near-identical promotions and,
// past eBay's cap, failures. So promotions are keyed by their terms — "buy 2+,
// save 10%" is one promotion that accumulates listing IDs — and a new listing
// joins the existing one.

import { EBAY_MARKETPLACE_ID } from "./config";
import { describeVolumeDiscount, type VolumeDiscount } from "@/lib/quantity";

const MARKETING_BASE = "https://api.ebay.com/sell/marketing/v1";

/**
 * eBay's documented ceiling on listing IDs in one INVENTORY_BY_VALUE promotion.
 * Enforced here so a full promotion produces an explanation rather than an
 * opaque platform error.
 */
const MAX_LISTINGS_PER_PROMOTION = 500;

/** Pages of promotions to scan when looking for an existing one. */
const MAX_LIST_PAGES = 5;
const LIST_LIMIT = 100;

export interface VolumeDiscountOutcome {
  applied: boolean;
  /** Present whenever the seller needs to know something. */
  warning?: string;
}

interface Resp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function marketingRequest(
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

/**
 * A connection made before `sell.marketing` was added to the requested scopes
 * has a token that cannot call this API at all. That is a reconnect, not a bug,
 * and the message has to say so — a bare "403 Forbidden" sends people hunting
 * through their eBay account settings for a permission that isn't the problem.
 */
function isScopeFailure(r: Resp): boolean {
  return (
    r.status === 401 ||
    r.status === 403 ||
    /insufficient\s*permissions|scope/i.test(r.text || "")
  );
}

const RECONNECT_HINT =
  "The listing published fine, but the multi-buy discount was not applied: this " +
  "app's connection to eBay predates the permission needed to manage discounts. " +
  "Disconnect and reconnect eBay once (Settings → Disconnect, then Connect) and " +
  "it will work on the next listing.";

function ebayMessage(r: Resp, fallback: string): string {
  const errs = r.json?.errors;
  if (Array.isArray(errs) && errs.length) {
    const first = errs[0];
    const parts = [first.message, first.longMessage].filter(Boolean);
    if (parts.length) return String(parts[parts.length - 1]).slice(0, 300);
  }
  return `${fallback} (HTTP ${r.status})`;
}

/** Stable, human-readable identity for a set of terms. eBay caps names at 90. */
export function promotionName(d: VolumeDiscount): string {
  return `Multi-buy: ${d.minQuantity}+ save ${d.percentOff}%`.slice(0, 90);
}

function promotionBody(d: VolumeDiscount, listingIds: string[]): Record<string, unknown> {
  return {
    name: promotionName(d),
    description: describeVolumeDiscount(d).slice(0, 250),
    marketplaceId: EBAY_MARKETPLACE_ID,
    promotionType: "VOLUME_DISCOUNT",
    promotionStatus: "RUNNING",
    // A single tier. eBay supports up to three ("buy 2 save 5, buy 3 save 10"),
    // and this shape extends to them without a data migration, but the UI offers
    // one because one is what a photo-driven bulk lister actually needs.
    discountRules: [
      {
        ruleOrder: 1,
        discountBenefit: { percentageOffItem: String(d.percentOff) },
        discountSpecification: { minQuantity: d.minQuantity },
      },
    ],
    inventoryCriterion: {
      inventoryCriterionType: "INVENTORY_BY_VALUE",
      listingIds,
    },
  };
}

interface FoundPromotion {
  promotionId: string;
  listingIds: string[];
}

/** Locate the promotion matching these exact terms, if the account has one. */
async function findPromotion(
  accessToken: string,
  d: VolumeDiscount
): Promise<{ found: FoundPromotion | null; error?: Resp }> {
  const wanted = promotionName(d);
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url =
      `${MARKETING_BASE}/item_promotion?marketplace_id=${encodeURIComponent(EBAY_MARKETPLACE_ID)}` +
      `&limit=${LIST_LIMIT}&offset=${page * LIST_LIMIT}`;
    const r = await marketingRequest(accessToken, "GET", url);
    if (!r.ok) return { found: null, error: r };
    const promos: any[] = Array.isArray(r.json?.promotions) ? r.json.promotions : [];
    const hit = promos.find(
      (p) => p?.promotionType === "VOLUME_DISCOUNT" && p?.name === wanted
    );
    if (hit?.promotionId) {
      // The list response is a summary; the listing IDs need the detail call.
      const detail = await marketingRequest(
        accessToken,
        "GET",
        `${MARKETING_BASE}/item_promotion/${encodeURIComponent(hit.promotionId)}`
      );
      const ids: string[] = Array.isArray(detail.json?.inventoryCriterion?.listingIds)
        ? detail.json.inventoryCriterion.listingIds.map(String)
        : [];
      return { found: { promotionId: String(hit.promotionId), listingIds: ids } };
    }
    if (promos.length < LIST_LIMIT) break;
  }
  return { found: null };
}

/**
 * Put one live listing into the multi-buy promotion for these terms, creating
 * the promotion if the account doesn't have it yet.
 *
 * Never throws. `applied: false` always comes with a warning explaining why.
 */
export async function applyVolumeDiscount(
  accessToken: string,
  args: { sku: string; listingId: string; discount: VolumeDiscount }
): Promise<VolumeDiscountOutcome> {
  const { sku, listingId, discount } = args;
  if (!listingId) {
    return {
      applied: false,
      warning:
        "Multi-buy discount skipped: eBay didn't return a listing ID for this item, and a discount can only be attached to a known listing. Add it from the eBay listing page.",
    };
  }

  try {
    const lookup = await findPromotion(accessToken, discount);
    if (lookup.error) {
      if (isScopeFailure(lookup.error)) return { applied: false, warning: RECONNECT_HINT };
      return {
        applied: false,
        warning: `Multi-buy discount skipped: ${ebayMessage(lookup.error, "eBay wouldn't list your existing promotions")}.`,
      };
    }

    // Already a member — nothing to do. This is the common case on a re-publish.
    if (lookup.found?.listingIds.includes(listingId)) {
      return { applied: true };
    }

    if (lookup.found) {
      if (lookup.found.listingIds.length >= MAX_LISTINGS_PER_PROMOTION) {
        return {
          applied: false,
          warning: `Multi-buy discount skipped: your "${promotionName(discount)}" promotion already holds eBay's maximum of ${MAX_LISTINGS_PER_PROMOTION} listings. Use slightly different terms (e.g. a different percentage) for the rest of this batch, or retire some old listings from it.`,
        };
      }
      const ids = [...lookup.found.listingIds, listingId];
      const upd = await marketingRequest(
        accessToken,
        "PUT",
        `${MARKETING_BASE}/item_promotion/${encodeURIComponent(lookup.found.promotionId)}`,
        promotionBody(discount, ids)
      );
      if (!upd.ok) {
        if (isScopeFailure(upd)) return { applied: false, warning: RECONNECT_HINT };
        return {
          applied: false,
          warning: `Multi-buy discount skipped: ${ebayMessage(upd, "eBay rejected the promotion update")}.`,
        };
      }
      return { applied: true };
    }

    // No promotion with these terms yet — create it around this listing.
    const created = await marketingRequest(
      accessToken,
      "POST",
      `${MARKETING_BASE}/item_promotion`,
      promotionBody(discount, [listingId])
    );
    if (created.ok) return { applied: true };
    if (isScopeFailure(created)) return { applied: false, warning: RECONNECT_HINT };

    // Two items from the same batch can race to create the same promotion —
    // "Post all" publishes concurrently. Whoever loses finds it on a second look
    // and joins it, rather than reporting a failure that isn't one.
    const second = await findPromotion(accessToken, discount);
    if (second.found && !second.found.listingIds.includes(listingId)) {
      const upd = await marketingRequest(
        accessToken,
        "PUT",
        `${MARKETING_BASE}/item_promotion/${encodeURIComponent(second.found.promotionId)}`,
        promotionBody(discount, [...second.found.listingIds, listingId])
      );
      if (upd.ok) return { applied: true };
    } else if (second.found) {
      return { applied: true };
    }

    console.warn(
      `[ebay/promotions] sku=${sku} volume discount failed ${created.status}: ${(created.text || "").slice(0, 400)}`
    );
    return {
      applied: false,
      warning: `Multi-buy discount skipped: ${ebayMessage(created, "eBay rejected the promotion")}. The listing itself is live — you can add the discount from eBay's Promotions manager.`,
    };
  } catch (e) {
    // A network fault here must not turn a successful publish into a failure.
    console.warn(`[ebay/promotions] sku=${sku} volume discount error:`, e);
    return {
      applied: false,
      warning: `Multi-buy discount skipped (${(e as Error).message}). The listing itself is live.`,
    };
  }
}
