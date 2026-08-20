// eBay OAuth scope metadata.
//
// Deliberately free of `process.env` and of anything server-only, because the
// connect UI is a client component and needs this list. Everything that reads
// credentials lives in config.ts, which imports from here rather than the other
// way round.

export interface OptionalScope {
  /** Stable key used in the connect UI and stored with the connection. */
  id: string;
  scope: string;
  label: string;
  /** What stops working without it. */
  enables: string;
}

export const CORE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

/**
 * Everything beyond listing. Each is separately requestable because keysets
 * differ in what eBay grants them, and one unavailable scope must not cost you
 * the other two — or the connection.
 */
export const EBAY_OPTIONAL_SCOPES: OptionalScope[] = [
  {
    id: "marketing",
    scope: "https://api.ebay.com/oauth/api_scope/sell.marketing",
    label: "Promotions",
    enables: "multi-buy discounts on listings with several of the same item",
  },
  {
    id: "analytics",
    scope: "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
    label: "Traffic reports (read-only)",
    enables: "the views and impressions columns in the seller view",
  },
];

// NOT here, deliberately: there is no `sell.negotiation` scope. It was invented,
// and because eBay rejects an entire authorize request over one unknown scope,
// it broke the ability to connect at all.
//
// eBay's Negotiation API — find_eligible_items and send_offer_to_interested_
// buyers, the "send offers to watchers" feature — runs on `sell.inventory` and
// `sell.inventory.readonly`, both of which are in CORE_SCOPES above. Offers need
// no extra permission and no reconnect.
//   https://developer.ebay.com/api-docs/sell/negotiation/resources/offer/methods/sendOfferToInterestedBuyers

export const OPTIONAL_SCOPE_IDS = EBAY_OPTIONAL_SCOPES.map((s) => s.id);

/** The core set, which every connection must have and which always works. */
export const EBAY_SCOPES_LEGACY = CORE_SCOPES.join(" ");

/**
 * Build a scope string from the core set plus whichever extras were asked for.
 * Unknown ids are ignored rather than passed through — a stray value must never
 * become a scope eBay rejects.
 */
export function scopeString(optionalIds: readonly string[] = OPTIONAL_SCOPE_IDS): string {
  const extras = EBAY_OPTIONAL_SCOPES.filter((o) => optionalIds.includes(o.id)).map((o) => o.scope);
  return [...CORE_SCOPES, ...extras].join(" ");
}

/** Which optional ids a stored scope string represents. */
export function optionalIdsFromScopeString(scopes: string | undefined): string[] {
  if (!scopes) return [];
  const parts = new Set(scopes.split(/\s+/).filter(Boolean));
  return EBAY_OPTIONAL_SCOPES.filter((o) => parts.has(o.scope)).map((o) => o.id);
}

/** Everything this build knows how to ask for. */
export const EBAY_SCOPES = scopeString();
