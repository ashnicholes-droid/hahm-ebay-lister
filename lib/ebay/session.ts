// Encrypted eBay connection stored in an httpOnly cookie.
//
// We keep only the long-lived refresh token (encrypted with SESSION_SECRET).
// Short-lived access tokens are minted on demand from it, so nothing sensitive
// is exposed to the browser. The app's database holds scheduling records only —
// eBay credentials and tokens are never written to it.

import { refreshAccessToken } from "./oauth";

export const EBAY_COOKIE = "ebay_conn";
export const EBAY_STATE_COOKIE = "ebay_oauth_state";
// Browsers cap persistent cookies at ~400 days; eBay refresh tokens last ~18mo.
export const EBAY_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

interface Connection {
  refreshToken: string;
  refreshExpiresAt: number; // epoch ms
}

async function aesKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set. Add it in Vercel env vars.");
  }
  if (secret.length < 32) {
    // A short human-chosen passphrase would make the cookie encryption
    // brute-forceable. Require real entropy.
    throw new Error(
      'SESSION_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealConnection(conn: Connection): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(conn));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data)
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return Buffer.from(out).toString("base64url");
}

export async function openConnection(
  sealed: string | undefined
): Promise<Connection | null> {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const key = await aesKey();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const conn = JSON.parse(new TextDecoder().decode(pt)) as Connection;
    if (!conn.refreshToken) return null;
    if (conn.refreshExpiresAt && conn.refreshExpiresAt < Date.now()) return null;
    return conn;
  } catch {
    return null;
  }
}

// Build a Connection from a fresh token-exchange response.
export function connectionFromToken(refreshToken: string, refreshExpiresIn?: number): Connection {
  const ttl = (refreshExpiresIn ?? 47304000) * 1000; // default ~18 months
  return { refreshToken, refreshExpiresAt: Date.now() + ttl };
}

// Access tokens live ~2h. Minting one per publish means an extra eBay
// round-trip on every item of a batch (and risks eBay throttling the refresh
// grant), so cache them in the warm lambda keyed by refresh token.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Mint a short-lived access token from the stored connection cookie value.
export async function accessTokenFromCookie(
  sealed: string | undefined
): Promise<string | null> {
  const conn = await openConnection(sealed);
  if (!conn) return null;
  const cached = tokenCache.get(conn.refreshToken);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = await refreshAccessToken(conn.refreshToken);
  if (tokenCache.size > 100) tokenCache.clear(); // bound memory
  tokenCache.set(conn.refreshToken, {
    token: token.access_token,
    // Refresh 5 minutes before eBay's stated expiry.
    expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000,
  });
  return token.access_token;
}
