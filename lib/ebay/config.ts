// eBay API constants + credential loading for the web app.
//
// Phase 2 uses a SEPARATE eBay keyset from the Python lister (so the two never
// interfere). These come from environment variables set in Vercel:
//   EBAY_CLIENT_ID      — the App ID (Client ID)
//   EBAY_CLIENT_SECRET  — the Cert ID (Client Secret)
//   EBAY_RU_NAME        — the RuName, whose "auth accepted URL" in the eBay
//                         developer portal must point at this app's callback
//                         (e.g. https://your-app.vercel.app/api/ebay/callback)
//   SESSION_SECRET      — random string used to encrypt the stored eBay token
//   EBAY_ENV            — "sandbox" to point this whole deployment at eBay's
//                         sandbox instead of the live site. Anything else, or
//                         unset, means production.
//
// Optional marketplace overrides (defaults are the US site). Set all three
// together for another marketplace, e.g. UK: EBAY_MARKETPLACE_ID=EBAY_GB,
// EBAY_CATEGORY_TREE_ID=3, EBAY_CURRENCY=GBP. After changing them, regenerate
// the offline category fallback with scripts/refresh-category-map.ts.

/**
 * Which eBay this deployment talks to.
 *
 * Set EBAY_ENV=sandbox on a dev deployment, together with a SANDBOX keyset and
 * RuName, and nothing it does can touch your real listings, orders or money.
 * Unset or anything else means production — see lib/ebay/environment.ts for why
 * production is the default rather than the safer-sounding option.
 */
export const EBAY_ENV: EbayEnv = normalizeEbayEnv(process.env.EBAY_ENV);
export const IS_SANDBOX = EBAY_ENV === "sandbox";

const BASES = ebayBases(EBAY_ENV);

export const EBAY_OAUTH_URL = BASES.oauthUrl;
export const EBAY_TOKEN_URL = BASES.tokenUrl;
export const EBAY_INV_BASE = BASES.inventory;
export const EBAY_ACC_BASE = BASES.account;
export const EBAY_META_BASE = BASES.metadata;
export const EBAY_TAX_BASE = BASES.taxonomy;
export const EBAY_FUL_BASE = BASES.fulfillment;
export const EBAY_ANALYTICS_BASE = BASES.analytics;
export const EBAY_MARKETING_BASE = BASES.marketing;
export const EBAY_NEGOTIATION_BASE = BASES.negotiation;
export const EBAY_BROWSE_SEARCH = BASES.browseSearch;
export const EBAY_TRADING = BASES.trading;
export const EBAY_ITEM_PREFIX = BASES.itemPrefix;
/** Overridable on its own, since eBay's Media docs and servers may disagree. */
export const EBAY_MEDIA_BASE = process.env.EBAY_MEDIA_BASE || BASES.media;
export const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
export const EBAY_CATEGORY_TREE_ID = process.env.EBAY_CATEGORY_TREE_ID || "0";
export const EBAY_CURRENCY = process.env.EBAY_CURRENCY || "USD";

// eBay OAuth scopes.
//
// Two hard lessons are encoded in lib/ebay/scopes.ts, which holds the actual
// list:
//
// 1. eBay rejects an ENTIRE authorize request if any single scope in it isn't
//    available to your developer keyset — `{"error_id":"invalid_scope"}`, at
//    eBay's own page, before the browser ever comes back. So an optional
//    capability bundled into one all-or-nothing string can take out the ability
//    to connect at all. That happened. Optional scopes are individually
//    droppable and the connect screen lets you drop them.
//
// 2. eBay refuses a refresh that asks for a scope the refresh token was never
//    granted, so the refresh asks for what was actually granted rather than
//    what this build would like. The granted set is stored with the connection
//    (see session.ts) and replayed on refresh.
//
// Re-exported here so existing imports keep working; the list itself lives in
// scopes.ts because the connect UI is a client component and must not pull in
// anything that reads credentials.
export {
  EBAY_OPTIONAL_SCOPES,
  EBAY_SCOPES,
  EBAY_SCOPES_LEGACY,
  OPTIONAL_SCOPE_IDS,
  optionalIdsFromScopeString,
  scopeString,
  type OptionalScope,
} from "./scopes";
import { ebayBases, normalizeEbayEnv, type EbayEnv } from "./environment";

export interface EbayCreds {
  clientId: string;
  clientSecret: string;
  ruName: string;
}

export function getEbayCreds(): EbayCreds {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RU_NAME;
  if (!clientId || !clientSecret || !ruName) {
    throw new Error(
      `eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME in Vercel` +
        (IS_SANDBOX
          ? " — this deployment is set to EBAY_ENV=sandbox, so they must be your SANDBOX keyset, not your production one."
          : ".")
    );
  }
  return { clientId, clientSecret, ruName };
}

export function isEbayConfigured(): boolean {
  return Boolean(
    process.env.EBAY_CLIENT_ID &&
      process.env.EBAY_CLIENT_SECRET &&
      process.env.EBAY_RU_NAME
  );
}

export function basicAuthHeader(creds: EbayCreds): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}
