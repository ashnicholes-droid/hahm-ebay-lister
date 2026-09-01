// Signed session cookie for the app-wide access gate.
//
// APP_SECRET is the password; this module turns a successful password check into
// a cookie that proves it, so the secret itself is never stored in the browser.
// The cookie is an HMAC over its own issue time, keyed by APP_SECRET — meaning
// changing APP_SECRET invalidates every outstanding session for free, and a
// stolen cookie expires on its own.
//
// Everything here uses Web Crypto rather than node:crypto, because the same
// verification has to run in TWO runtimes: middleware.ts (Edge) gates the pages,
// and lib/api-guard.ts (Node) gates the routes. Two implementations of one token
// format is exactly the kind of thing that drifts and fails open, so there is
// only this one — Node 18+ exposes globalThis.crypto.subtle too.

const VERSION = "v1";
export const SESSION_COOKIE = "lw_session";
// Long enough that a phone used a few times a week doesn't keep re-asking,
// short enough that a cookie lifted off an old device eventually dies.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function toBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

/**
 * Compare two strings without leaking where they diverge.
 *
 * The length check is safe here: both operands are fixed-length HMAC digests,
 * so a length mismatch already means "not our token" and reveals nothing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a session token for a client that just proved it knows APP_SECRET. */
export async function issueSession(secret: string, now = Date.now()): Promise<string> {
  const payload = `${VERSION}.${now}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** True when `token` is a live session minted by this exact APP_SECRET. */
export async function verifySession(
  token: string | undefined,
  secret: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, issuedAt, signature] = parts;
  if (version !== VERSION) return false;

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  const ageSeconds = (now - issued) / 1000;
  // Reject the future as well as the past: a clock-skewed or hand-crafted
  // issue time must not buy an unbounded session.
  if (ageSeconds < -60 || ageSeconds > SESSION_MAX_AGE_SECONDS) return false;

  return timingSafeEqual(signature, await sign(`${version}.${issuedAt}`, secret));
}

/** Constant-time check of a submitted access code against APP_SECRET. */
export async function accessCodeMatches(
  provided: string,
  secret: string
): Promise<boolean> {
  if (!provided || !secret) return false;
  // Hash first so the comparison operands are fixed-length regardless of how
  // long the submitted code is.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return timingSafeEqual(toBase64Url(a), toBase64Url(b));
}

/**
 * Paths that must stay reachable without a session, and why. Getting this list
 * wrong is the difference between "locked down" and "eBay posting silently
 * stopped working", so each entry earns its place:
 *
 *   /api/ebay/callback — eBay redirects the seller's BROWSER here after consent.
 *                        That request carries no access code and never will. It
 *                        is protected instead by the OAuth state cookie.
 *   /privacy           — eBay requires a publicly reachable privacy policy URL
 *                        for your RuName. Gating it breaks keyset compliance.
 *   /login, /api/login — the gate itself; gating it is an infinite redirect.
 *   /api/logout        — must work even from a session that's already expired.
 *   /icon.svg,
 *   /apple-icon.png    — the tab and home-screen icons, which the sign-in page
 *                        itself links to. Gated, the browser follows the 307,
 *                        gets the login HTML back as its image, and the tab
 *                        shows a broken icon to anyone not yet signed in. They
 *                        are two flat shapes and leak nothing the login page
 *                        does not already show.
 */
const PUBLIC_PATHS = [
  "/api/ebay/callback",
  "/privacy",
  "/login",
  "/api/login",
  "/api/logout",
  "/icon.svg",
  "/apple-icon.png",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
