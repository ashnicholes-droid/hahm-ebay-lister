// eBay API constants + credential loading for the web app.
//
// Phase 2 uses a SEPARATE eBay keyset from the Python lister (so the two never
// interfere). These come from environment variables:
//   EBAY_CLIENT_ID      — the App ID (Client ID)
//   EBAY_CLIENT_SECRET  — the Cert ID (Client Secret)
//   EBAY_RU_NAME        — the RuName, whose "auth accepted URL" in the eBay
//                         developer portal must point at this app's callback
//                         (e.g. https://your-app.example.com/api/ebay/callback)
//   SESSION_SECRET      — random string used to encrypt the stored eBay token

export const EBAY_OAUTH_URL = "https://auth.ebay.com/oauth2/authorize";
export const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const EBAY_INV_BASE = "https://api.ebay.com/sell/inventory/v1";
export const EBAY_ACC_BASE = "https://api.ebay.com/sell/account/v1";
export const EBAY_META_BASE = "https://api.ebay.com/sell/metadata/v1";
export const EBAY_TAX_BASE = "https://api.ebay.com/commerce/taxonomy/v1";
export const EBAY_TRADING = "https://api.ebay.com/ws/api.dll";
export const EBAY_MARKETPLACE_ID = "EBAY_US";
export const EBAY_CATEGORY_TREE_ID = "0";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

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
      "eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME in your environment variables."
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
