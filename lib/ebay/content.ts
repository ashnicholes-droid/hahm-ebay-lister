// Editing the title and description of a listing that is already live.
//
// The gap this closes: triage tells a seller "barely showing in search — fix
// the title keywords", and until now the app gave them no way to do it. The
// advice was real and the tool was missing.
//
// Where these fields actually live is the awkward part, because eBay splits
// them across two objects:
//
//   • TITLE lives only on the inventory item, at product.title, capped at 80.
//   • DESCRIPTION lives in BOTH places — product.description on the inventory
//     item, and listingDescription on the offer. The offer's copy is what a
//     buyer reads on the listing page, so writing only one of them leaves the
//     two disagreeing, and which one wins depends on the operation. Both are
//     written here, always.
//
// Both PUTs are full replacements, so every write is read-modify-write. Sending
// a partial body doesn't patch the listing — it blanks whatever it omits.

import { EBAY_INV_BASE } from "./config";
import { ebayMessage, findOffer, inventoryRequest, type OfferRef } from "./revise";
import { TITLE_MAX } from "./contentLimits";

// Re-exported so server callers don't need to know it lives in a separate
// client-safe module.
export { TITLE_MAX } from "./contentLimits";

export interface ListingContent {
  title: string;
  description: string;
}

export interface ContentResult {
  ok: boolean;
  content?: ListingContent;
  error?: string;
  notInventoryManaged?: boolean;
}

const NOT_MANAGED =
  "This listing isn't managed by the Inventory API, so its title and description " +
  "can't be edited here. Edit it in Seller Hub instead.";

/**
 * Read what the listing currently says.
 *
 * Fetched rather than taken from the seller-view row, because the row only
 * carries the title — and editing a description you can't see first is how
 * someone overwrites three paragraphs they wanted to keep.
 */
export async function fetchContent(accessToken: string, sku: string): Promise<ContentResult> {
  const item = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/inventory_item/${encodeURIComponent(sku)}`
  );
  if (item.status === 404) return { ok: false, notInventoryManaged: true, error: NOT_MANAGED };
  if (!item.ok) return { ok: false, error: ebayMessage(item, "Couldn't read this listing") };

  const product = item.json?.product ?? {};
  // Prefer the offer's description: it is the one buyers actually see, so if
  // the two have drifted, that is the copy worth editing.
  const { offer } = await findOffer(accessToken, sku);
  let description = String(product.description ?? "");
  if (offer) {
    const off = await inventoryRequest(
      accessToken,
      "GET",
      `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`
    );
    if (off.ok && typeof off.json?.listingDescription === "string" && off.json.listingDescription) {
      description = off.json.listingDescription;
    }
  }

  return { ok: true, content: { title: String(product.title ?? ""), description } };
}

export function validateContent(
  input: Partial<ListingContent>
): { content: Partial<ListingContent> } | { error: string } {
  const out: Partial<ListingContent> = {};

  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) return { error: "A title can't be empty." };
    if (title.length > TITLE_MAX) {
      return {
        error: `eBay caps titles at ${TITLE_MAX} characters; this one is ${title.length}.`,
      };
    }
    out.title = title;
  }

  if (input.description !== undefined) {
    const description = String(input.description);
    // An empty description is legal on eBay but almost never intended, and a
    // blank one after a relist looks like the listing broke.
    if (!description.trim()) return { error: "A description can't be empty." };
    out.description = description;
  }

  if (out.title === undefined && out.description === undefined) {
    return { error: "Nothing to change." };
  }
  return { content: out };
}

/**
 * Write a new title and/or description onto the inventory item.
 *
 * Read-modify-write, because eBay's PUT replaces the whole inventory item —
 * a partial body would drop the photos, the aspects, and the package
 * dimensions along with everything else.
 */
export async function writeInventoryContent(
  accessToken: string,
  sku: string,
  content: Partial<ListingContent>
): Promise<{ ok: boolean; error?: string }> {
  const current = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/inventory_item/${encodeURIComponent(sku)}`
  );
  if (!current.ok) {
    return { ok: false, error: ebayMessage(current, "Couldn't read the item back") };
  }

  const body: any = { ...current.json };
  // Read-only on update; echoing them back is rejected.
  delete body.sku;
  delete body.locale;
  body.product = { ...(body.product ?? {}) };
  if (content.title !== undefined) body.product.title = content.title.slice(0, TITLE_MAX);
  if (content.description !== undefined) body.product.description = content.description;

  const upd = await inventoryRequest(
    accessToken,
    "PUT",
    `${EBAY_INV_BASE}/inventory_item/${encodeURIComponent(sku)}`,
    body
  );
  if (!upd.ok) return { ok: false, error: ebayMessage(upd, "eBay rejected the new title") };
  return { ok: true };
}

/** Write the description onto the offer, which is the copy buyers read. */
export async function writeOfferContent(
  accessToken: string,
  offer: OfferRef,
  content: Partial<ListingContent>,
  price?: number,
  /**
   * Swap which business policy decides postage.
   *
   * Folded into this same read-modify-write rather than given its own PUT: two
   * writes could half-apply, leaving a listing repriced but still on the old
   * shipping — and this runs while the listing is ENDED, which is the worst
   * moment to have to reason about partial state.
   */
  fulfillmentPolicyId?: string
): Promise<{ ok: boolean; error?: string }> {
  if (
    content.description === undefined &&
    price === undefined &&
    fulfillmentPolicyId === undefined
  ) {
    return { ok: true };
  }

  const current = await inventoryRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`
  );
  if (!current.ok) {
    return { ok: false, error: ebayMessage(current, "Couldn't read the offer back") };
  }

  const body: any = { ...current.json };
  delete body.offerId;
  delete body.sku;
  delete body.marketplaceId;
  delete body.format;
  delete body.listing;
  delete body.status;
  if (content.description !== undefined) body.listingDescription = content.description;
  if (price !== undefined) {
    body.pricingSummary = {
      ...(body.pricingSummary ?? {}),
      price: { value: price.toFixed(2), currency: offer.currency },
    };
  }
  if (fulfillmentPolicyId !== undefined) {
    // Only this one field is replaced. listingPolicies also carries the payment
    // and return policies, and rebuilding the object would drop them.
    body.listingPolicies = {
      ...(body.listingPolicies ?? {}),
      fulfillmentPolicyId,
    };
  }

  const upd = await inventoryRequest(
    accessToken,
    "PUT",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offer.offerId)}`,
    body
  );
  if (!upd.ok) return { ok: false, error: ebayMessage(upd, "eBay rejected the change") };
  return { ok: true };
}

export interface EditResult {
  ok: boolean;
  content?: ListingContent;
  error?: string;
  notInventoryManaged?: boolean;
  /** True when the title changed but the description write failed, or vice versa. */
  partial?: boolean;
}

/**
 * Edit a LIVE listing's title and/or description in place.
 *
 * No ending, no new item number: eBay allows a fixed-price listing to be
 * revised while it runs, and doing it this way keeps the watchers and whatever
 * search history the listing has built up. That makes this the right tool for
 * a bad title, and the relist the wrong one — the relist exists to reset a
 * stale listing's age, which is a different problem.
 *
 * The two writes can't be atomic, so a half-applied edit is reported as such
 * rather than as a flat failure. Saying "it failed" when the title did change
 * would send someone to Seller Hub looking for a change that already happened.
 */
export async function editLiveContent(
  accessToken: string,
  sku: string,
  input: Partial<ListingContent>
): Promise<EditResult> {
  const checked = validateContent(input);
  if ("error" in checked) return { ok: false, error: checked.error };
  const content = checked.content;

  const { offer, error } = await findOffer(accessToken, sku);
  if (error) return { ok: false, error };
  if (!offer) return { ok: false, notInventoryManaged: true, error: NOT_MANAGED };

  const itemWrite = await writeInventoryContent(accessToken, sku, content);
  if (!itemWrite.ok) return { ok: false, error: itemWrite.error };

  const offerWrite = await writeOfferContent(accessToken, offer, content);
  if (!offerWrite.ok) {
    return {
      ok: false,
      partial: true,
      error:
        `${offerWrite.error} The title was updated, but the description on the live ` +
        `listing was not — they may now disagree. Try saving again.`,
    };
  }

  // Read it back rather than reporting what was sent.
  const after = await fetchContent(accessToken, sku);
  return { ok: true, content: after.content };
}
