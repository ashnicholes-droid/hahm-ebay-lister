// eBay OAuth: authorize URL, code exchange, and token refresh.
// Ported from _get_oauth_code / _exchange_code / _refresh_token in the script.

import {
  EBAY_OAUTH_URL,
  EBAY_TOKEN_URL,
  EBAY_SCOPES,
  basicAuthHeader,
  getEbayCreds,
  type EbayCreds,
} from "./config";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type: string;
}

// Step 1: the URL we send the user to so they can authorize the app.
// `redirect_uri` is the RuName (per eBay's flow); the RuName's configured
// "auth accepted URL" is what the browser actually returns to.
export function buildAuthorizeUrl(state: string): string {
  const creds = getEbayCreds();
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.ruName,
    response_type: "code",
    scope: EBAY_SCOPES,
    state,
  });
  return `${EBAY_OAUTH_URL}?${params.toString()}`;
}

// Turn eBay's raw token-endpoint failure into an actionable message. eBay
// distinguishes the failures people actually hit clearly enough to give each a
// targeted hint:
//   401 / invalid_client → the App ID + Cert ID pair was rejected. This is the
//     first step that sends the Cert ID, so the consent screen having worked
//     doesn't rule it out. Almost always a wrong/mis-pasted EBAY_CLIENT_SECRET,
//     a Sandbox-vs-Production keyset mix-up, or env vars set but not redeployed.
//   invalid_request → eBay rejected the redirect_uri, which is the RuName.
//     Usually EBAY_RU_NAME holds the long "Sign In (OAuth)" URL instead of the
//     short RuName identifier (or it doesn't match the keyset).
//   invalid_grant → the authorization code (or refresh token) itself is bad,
//     expired, or already used — not a credentials problem.
function tokenErrorMessage(status: number, body: string): string {
  if (status === 401 || /invalid_client/i.test(body)) {
    return (
      "eBay rejected your app credentials (401 invalid_client). This is the App ID / " +
      "Cert ID pair, not the authorization code you pasted. Check that EBAY_CLIENT_SECRET " +
      "(Cert ID) and EBAY_CLIENT_ID (App ID) come from the same Production keyset — sandbox " +
      "keys won't work — have no stray spaces or line breaks, and that you redeployed " +
      "after setting them."
    );
  }
  if (/invalid_request/i.test(body)) {
    return (
      "eBay rejected the request parameters (400 invalid_request) — specifically the redirect " +
      "URI, which is your RuName. Make sure EBAY_RU_NAME is the short RuName identifier (like " +
      '"Name-XXXX-XXXX-XXXX"), not the long "eBay Production Sign In (OAuth)" URL, then redeploy.'
    );
  }
  if (/invalid_grant/i.test(body)) {
    return (
      "eBay rejected the authorization code (it may have expired or already been used). " +
      "Start the connection again and paste the fresh URL right away."
    );
  }
  return `eBay token request failed (${status}): ${body.slice(0, 300)}`;
}

async function postToken(
  creds: EbayCreds,
  body: Record<string, string>
): Promise<TokenResponse> {
  const resp = await fetch(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(creds),
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(tokenErrorMessage(resp.status, text));
  }
  return (await resp.json()) as TokenResponse;
}

// Step 2: exchange the authorization code for access + refresh tokens.
export function exchangeCode(code: string): Promise<TokenResponse> {
  const creds = getEbayCreds();
  return postToken(creds, {
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.ruName,
  });
}

// Mint a fresh short-lived access token from a stored refresh token.
export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const creds = getEbayCreds();
  return postToken(creds, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: EBAY_SCOPES,
  });
}
