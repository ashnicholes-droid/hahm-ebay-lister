// Ending dead stock, and relisting it fresh.
//
// The problem this solves: a listing that has sat for three months with no sale
// doesn't get better by waiting. eBay's search favours newer listings, so at
// some point the useful move is to end it and start again — optionally at a
// lower price.
//
// ⚠️ This is the most destructive thing in the app. Ending a listing is not
// undoable: the item id is gone, and a relist is a NEW listing with a new id.
// Everything here is therefore built to be deliberate rather than convenient —
// nothing is batched, every call is confirmed, and the one genuinely dangerous
// failure (ended but not republished) is reported in the loudest terms the UI
// has, with the offer id needed to recover by hand.
//
// The mechanics, verified against eBay's docs rather than assumed:
//   • POST /offer/{offerId}/withdraw ends the live listing and returns the
//     offer to the UNPUBLISHED state. The offer object survives with all its
//     settings — photos, description, policies, specifics.
//   • POST /offer/{offerId}/publish then creates a NEW listing from it, and
//     returns a NEW listingId. That new id is the entire point: it is what makes
//     the relist read as fresh rather than as the same tired listing.
//
// What it costs, which the seller has to be told before they press the button:
// the relist starts from zero. Watchers are gone, and so is whatever search
// standing the old listing had built up. On a listing with watchers this is
// actively the wrong move — those are the people most likely to buy, and the
// right tool for them is an offer, not a relist.

import { EBAY_INV_BASE } from "./config";
import {
  MAX_PRICE,
  MIN_PRICE,
  ebayMessage,
  findOffer,
  inventoryRequest,
  toOfferRef,
  type OfferRef,
} from "./revise";
import {
  validateContent,
  writeInventoryContent,
  writeOfferContent,
  type ListingContent,
} from "./content";

const NOT_MANAGED =
  "This listing isn't managed by the Inventory API, so it can't be ended here. " +
  "It was created outside this app — end it in Seller Hub instead.";

export interface EndResult {
  ok: boolean;
  /** The listing that was ended. */
  endedListingId?: string;
  /** Kept so a relist can follow without looking the offer up again. */
  offerId?: string;
  error?: string;
  notInventoryManaged?: boolean;
}

export interface RelistResult extends EndResult {
  /** The NEW listing eBay created. Different from the one that was ended. */
  listingId?: string;
  /** What the new listing is priced at. */
  price?: number | null;
  /**
   * The bad one: the old listing is ended and the new one did not go up, so
   * the item is not for sale anywhere. Never buried in a generic error.
   */
  strandedOffer?: string;
}

/**
 * End the live listing behind a SKU.
 *
 * Withdraw rather than delete, always. Deleting would throw away the offer —
 * the photos, the description, the item specifics, everything the writing pass
 * produced — and there is no version of "this isn't selling" that is improved
 * by destroying the listing content.
 */
export async function endListing(accessToken: string, sku: string): Promise<EndResult> {
  const { offer, error } = await findOffer(accessToken, sku);
  if (error) return { ok: false, error };
  if (!offer) return { ok: false, notInventoryManaged: true, error: NOT_MANAGED };

  const r = await inventoryRequest(
    accessToken,
    "POST",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}/withdraw`
  );
  if (!r.ok) return { ok: false, error: ebayMessage(r, "eBay wouldn't end this listing") };

  // eBay returns the ended listingId; fall back to the one we already knew so a
  // terse response doesn't turn a success into a blank confirmation.
  return {
    ok: true,
    offerId: offer.offerId,
    endedListingId: String(r.json?.listingId ?? offer.listingId ?? ""),
  };
}

/**
 * Apply the price and any content changes to the withdrawn offer.
 *
 * Delegates to lib/ebay/content.ts rather than repeating the read-modify-write
 * dance, so the "eBay's PUT is a full replacement" handling lives in one place
 * and can't drift between editing a live listing and relisting one.
 */
async function applyChanges(
  accessToken: string,
  offer: OfferRef,
  sku: string,
  price: number | undefined,
  content: Partial<ListingContent>
): Promise<{ ok: boolean; error?: string }> {
  // Title lives only on the inventory item, so it needs its own write.
  if (content.title !== undefined || content.description !== undefined) {
    const item = await writeInventoryContent(accessToken, sku, content);
    if (!item.ok) return item;
  }
  if (content.description !== undefined || price !== undefined) {
    return await writeOfferContent(accessToken, offer, content, price);
  }
  return { ok: true };
}

/**
 * End a listing and immediately put it back up, optionally at a new price.
 *
 * The order matters and is not negotiable: withdraw, then reprice, then
 * publish. Repricing while the listing is live would revise the very listing
 * that is about to be ended — a wasted write, and one that briefly shows buyers
 * a price that is about to disappear.
 *
 * If the publish fails, the seller is left with nothing live. That case returns
 * `strandedOffer` so the UI can say so in plain words rather than reporting a
 * generic failure that hides an item which is no longer for sale.
 */
export async function relistListing(
  accessToken: string,
  sku: string,
  newPrice?: number,
  content: Partial<ListingContent> = {}
): Promise<RelistResult> {
  // Reject a bad title before anything is ended. Discovering an over-long
  // title after the listing is down is the worst possible moment for it.
  if (content.title !== undefined || content.description !== undefined) {
    const checked = validateContent(content);
    if ("error" in checked) return { ok: false, error: checked.error };
    content = checked.content;
  }

  const { offer, error } = await findOffer(accessToken, sku);
  if (error) return { ok: false, error };
  if (!offer) return { ok: false, notInventoryManaged: true, error: NOT_MANAGED };

  const ended = await inventoryRequest(
    accessToken,
    "POST",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}/withdraw`
  );
  // Nothing has changed yet, so this is the safe failure: report and stop.
  if (!ended.ok) {
    return { ok: false, error: ebayMessage(ended, "eBay wouldn't end this listing") };
  }
  const endedListingId = String(ended.json?.listingId ?? offer.listingId ?? "");

  const hasChanges = newPrice !== undefined || content.title !== undefined || content.description !== undefined;
  if (hasChanges) {
    const priced = await applyChanges(accessToken, offer, sku, newPrice, content);
    if (!priced.ok) {
      // The old listing is already down. Publishing with the OLD content is far
      // better than leaving the item off the market over a rejected edit, so
      // carry on and say what happened.
      const republished = await publish(accessToken, offer.offerId);
      return republished.ok
        ? {
            ok: true,
            offerId: offer.offerId,
            endedListingId,
            listingId: republished.listingId,
            price: offer.price,
            error: `${priced.error} It was relisted with the previous price and wording instead.`,
          }
        : {
            ok: false,
            offerId: offer.offerId,
            endedListingId,
            strandedOffer: offer.offerId,
            error: `${priced.error} ${republished.error}`,
          };
    }
  }

  const republished = await publish(accessToken, offer.offerId);
  if (!republished.ok) {
    return {
      ok: false,
      offerId: offer.offerId,
      endedListingId,
      strandedOffer: offer.offerId,
      error: republished.error,
    };
  }

  // Read the offer back rather than reporting the price that was asked for.
  const after = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`
  );

  return {
    ok: true,
    offerId: offer.offerId,
    endedListingId,
    listingId: republished.listingId,
    price: after.ok ? toOfferRef(after.json).price : (newPrice ?? offer.price),
  };
}

async function publish(
  accessToken: string,
  offerId: string
): Promise<{ ok: true; listingId: string } | { ok: false; error: string }> {
  const r = await inventoryRequest(
    accessToken,
    "POST",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offerId)}/publish`
  );
  if (!r.ok) {
    return {
      ok: false,
      error: ebayMessage(r, "eBay wouldn't publish the new listing"),
    };
  }
  return { ok: true, listingId: String(r.json?.listingId ?? "") };
}

/** Same bounds as a price edit — a relist is not a way around them. */
export function validateRelistPrice(raw: unknown): { price: number } | { error: string } {
  const n = typeof raw === "string" ? parseFloat(raw) : (raw as number);
  if (!Number.isFinite(n)) return { error: "That isn't a number." };
  if (n < MIN_PRICE) return { error: `A price has to be at least $${MIN_PRICE.toFixed(2)}.` };
  if (n > MAX_PRICE) return { error: `$${n} looks like a typo — the cap here is $${MAX_PRICE}.` };
  return { price: Math.round(n * 100) / 100 };
}

// The "should you even do this" judgement lives in a client-safe module, since
// the seller view needs it and this file reaches process.env.
export { relistAdvice, type RelistAdvice } from "@/lib/relistAdvice";
