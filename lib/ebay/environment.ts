// Which eBay you are talking to.
//
// Every eBay host in this app used to be hardcoded to api.ebay.com, spread
// across seven modules. That was fine while there was one deployment, and
// became a hazard the moment there was a second: a dev deployment sharing the
// production keyset doesn't test against a copy of your account, it acts ON
// your account. Given this app now ends listings, relists them, sends offers to
// buyers, and marks orders shipped, "let me just try it on dev" could cost real
// listings and real money.
//
// eBay's sandbox is a full parallel environment with its own keyset, its own
// seller account, and its own test buyers. Everything is identical except the
// hostname — which is exactly why the hostnames belong in one place.
//
// Deliberately free of `process.env` so the client can import the type and the
// label without dragging server config into the bundle, in the same way
// scopes.ts is. config.ts is the file that reads the environment variable and
// calls into here; nothing here reads it.

export type EbayEnv = "production" | "sandbox";

/**
 * Read an environment name, defaulting to production.
 *
 * Production is the default because an unset or misspelt value must never
 * silently point a production deployment at the sandbox — the listings would
 * appear to publish and then not exist. The reverse risk (sandbox silently
 * behaving as production) is handled by requiring the word explicitly and by
 * showing a banner whenever it is set.
 */
export function normalizeEbayEnv(raw: string | undefined): EbayEnv {
  return String(raw ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "production";
}

export interface EbayBases {
  env: EbayEnv;
  oauthUrl: string;
  tokenUrl: string;
  inventory: string;
  account: string;
  metadata: string;
  taxonomy: string;
  fulfillment: string;
  analytics: string;
  marketing: string;
  negotiation: string;
  browseSearch: string;
  media: string;
  trading: string;
  /** Where a live listing is viewed, for links out of the seller view. */
  itemPrefix: string;
}

/**
 * Every eBay URL this app calls, for one environment.
 *
 * Sandbox differs from production only by hostname:
 *   api.ebay.com   → api.sandbox.ebay.com
 *   auth.ebay.com  → auth.sandbox.ebay.com
 *   apim.ebay.com  → apim.sandbox.ebay.com
 *   www.ebay.com   → www.sandbox.ebay.com
 *
 * ⚠️ OAuth SCOPE strings are not in this list and must never be rewritten. They
 * look like URLs — "https://api.ebay.com/oauth/api_scope/sell.inventory" — but
 * they are identifiers, and eBay expects the api.ebay.com spelling in both
 * environments. Rewriting them to the sandbox host produces an invalid_scope
 * rejection of the whole authorize request, which is the failure this codebase
 * has already been bitten by once (see lib/ebay/scopes.ts).
 */
export function ebayBases(env: EbayEnv): EbayBases {
  const api = env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const auth = env === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
  const apim = env === "sandbox" ? "https://apim.sandbox.ebay.com" : "https://apim.ebay.com";
  const www = env === "sandbox" ? "https://www.sandbox.ebay.com" : "https://www.ebay.com";

  return {
    env,
    oauthUrl: `${auth}/oauth2/authorize`,
    tokenUrl: `${api}/identity/v1/oauth2/token`,
    inventory: `${api}/sell/inventory/v1`,
    account: `${api}/sell/account/v1`,
    metadata: `${api}/sell/metadata/v1`,
    taxonomy: `${api}/commerce/taxonomy/v1`,
    fulfillment: `${api}/sell/fulfillment/v1`,
    analytics: `${api}/sell/analytics/v1`,
    marketing: `${api}/sell/marketing/v1`,
    negotiation: `${api}/sell/negotiation/v1`,
    browseSearch: `${api}/buy/browse/v1/item_summary/search`,
    media: `${apim}/commerce/media/v1_beta`,
    trading: `${api}/ws/api.dll`,
    itemPrefix: `${www}/itm/`,
  };
}

/** For the banner. Short, and unmistakable at a glance. */
export function ebayEnvLabel(env: EbayEnv): string {
  return env === "sandbox" ? "eBay Sandbox" : "eBay Production";
}

/**
 * Where to view a listing, when eBay didn't hand back a URL of its own.
 *
 * Client-safe, and environment-aware for a reason worth stating: a sandbox
 * listing does not exist on www.ebay.com. Linking there gives a 404 that looks
 * like the publish failed, when it actually succeeded — the exact confusion a
 * separate test environment is supposed to remove.
 */
export function ebayItemUrl(itemId: string, env: EbayEnv): string {
  return `${ebayBases(env).itemPrefix}${itemId}`;
}
