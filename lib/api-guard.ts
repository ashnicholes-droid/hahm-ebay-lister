import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { SESSION_COOKIE, verifySession } from "@/lib/session-auth";

/**
 * Access guard for the AI-powered API routes.
 *
 * These routes spend real money (Anthropic API calls) on every request, so a
 * public deployment must not leave them open. Set APP_SECRET in your
 * environment and the app will ask for the access code once per device
 * (it's remembered in the browser afterwards).
 *
 * If APP_SECRET is unset the guard allows everything in local development,
 * but FAILS CLOSED in production (NODE_ENV=production or VERCEL_ENV=production):
 * every guarded route returns 503 until the variable is configured. A forgotten
 * secret must never silently expose money-spending endpoints.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
// High enough that a legitimate batch session (sort chunks + parallel listing
// writes + post-all publishes + status checks) never trips it; APP_SECRET is
// the real access gate, this only blunts anonymous hammering.
const RATE_LIMIT_MAX_REQUESTS = 40;

// Wrong access codes get their own, far tighter budget. Sharing the throughput
// limiter above gave an attacker 40 guesses a minute — plenty to walk a short
// human-chosen code. A client that has *never* sent a correct code gets this
// many failures per window, then is locked out even if it stops hammering.
const AUTH_FAIL_WINDOW_MS = 15 * 60_000;
const AUTH_FAIL_MAX = 8;

// Per-serverless-instance limiter. Not a global guarantee (each warm lambda
// has its own map), but it blunts burst abuse at zero infra cost.
const hits = new Map<string, number[]>();
const authFails = new Map<string, number[]>();

// Bound memory without handing an attacker a reset button: spraying addresses
// used to call hits.clear(), wiping every honest client's counters too. Evict
// the oldest entries instead (Map preserves insertion order).
const MAX_TRACKED_CLIENTS = 5000;

function evictOldest(map: Map<string, number[]>, limit: number): void {
  if (map.size <= limit) return;
  const excess = map.size - Math.floor(limit * 0.9);
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++removed >= excess) break;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function recentCount(
  map: Map<string, number[]>,
  key: string,
  windowMs: number,
  record: boolean
): number {
  const now = Date.now();
  const windowStart = now - windowMs;
  const recent = (map.get(key) ?? []).filter((t) => t > windowStart);
  if (record) recent.push(now);
  if (recent.length) map.set(key, recent);
  else map.delete(key);
  evictOldest(map, MAX_TRACKED_CLIENTS);
  return recent.length;
}

function rateLimited(ip: string): boolean {
  return recentCount(hits, ip, RATE_LIMIT_WINDOW_MS, true) > RATE_LIMIT_MAX_REQUESTS;
}

/** True once this client has burned its access-code guesses for the window. */
function authLockedOut(ip: string): boolean {
  return recentCount(authFails, ip, AUTH_FAIL_WINDOW_MS, false) >= AUTH_FAIL_MAX;
}

function recordAuthFailure(ip: string): void {
  recentCount(authFails, ip, AUTH_FAIL_WINDOW_MS, true);
}

/** Clear the lockout counter after a correct code — honest typos shouldn't stack up. */
function clearAuthFailures(ip: string): void {
  authFails.delete(ip);
}

const lockoutResponse = () =>
  NextResponse.json(
    {
      ok: false,
      code: "ACCESS_CODE_LOCKED",
      error: "Too many incorrect access codes. Wait 15 minutes and try again.",
    },
    { status: 429 }
  );

/**
 * Drive the guess-lockout counter from the login route, which owns the actual
 * code check. Returns a 429 from `"check"` when the client is already locked
 * out; `"fail"` and `"success"` only record and always return null.
 */
export function recordAuthOutcome(
  req: NextRequest,
  outcome: "check" | "fail" | "success"
): NextResponse | null {
  const ip = clientIp(req);
  if (outcome === "check") {
    if (rateLimited(ip)) {
      return NextResponse.json(
        { ok: false, error: "Too many requests — wait a minute and try again." },
        { status: 429 }
      );
    }
    return authLockedOut(ip) ? lockoutResponse() : null;
  }
  if (outcome === "fail") recordAuthFailure(ip);
  else clearAuthFailures(ip);
  return null;
}

/**
 * Rate limiting only — for routes that must stay reachable without the access
 * code (the eBay OAuth callback, the status probe) but shouldn't be hammered.
 */
export function rateLimitRequest(req: NextRequest): NextResponse | null {
  if (rateLimited(clientIp(req))) {
    return NextResponse.json(
      { ok: false, error: "Too many requests — wait a minute and try again." },
      { status: 429 }
    );
  }
  return null;
}

/**
 * Reject an oversized request before its body is read into memory.
 *
 * Next.js route handlers do NOT honour `experimental.serverActions.bodySizeLimit`
 * (that setting only covers Server Actions), so without this a caller past the
 * access gate could stream an arbitrarily large JSON body at a photo route and
 * exhaust the function's memory. Content-Length is advisory — a client can lie —
 * so treat this as a cheap first cut, not the only defence; the per-image size
 * and count caps downstream are what actually bound the work.
 */
export function enforceBodyLimit(req: NextRequest, maxBytes: number): NextResponse | null {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return NextResponse.json(
      {
        ok: false,
        error: `That request was too large (${Math.round(declared / 1e6)} MB). Send fewer or smaller photos.`,
      },
      { status: 413 }
    );
  }
  return null;
}

/** Body caps by route shape. Photos are browser-resized well under these. */
export const BODY_LIMIT_PHOTOS = 12 * 1024 * 1024;
export const BODY_LIMIT_JSON = 512 * 1024;

/**
 * Returns an error response when the request isn't allowed, or null to proceed.
 *
 * Middleware already gates every one of these routes, so in normal operation
 * this is the second of two locks on the same door. It stays because the two
 * fail in different ways: a matcher typo or a Next upgrade that changes
 * middleware semantics silently opens the first lock, and nothing about that
 * failure is visible until someone finds the hole. A route that also checks for
 * itself cannot be opened by an error in the layer above it.
 *
 * Two credentials are accepted, both proving knowledge of APP_SECRET:
 *   • the session cookie, which is what the browser actually sends; and
 *   • an x-app-secret header, for scripts and curl that have no cookie jar.
 */
export async function guardApiRequest(req: NextRequest): Promise<NextResponse | null> {
  const limited = rateLimitRequest(req);
  if (limited) return limited;

  const secret = process.env.APP_SECRET;
  if (!secret) {
    // Fail closed in production — never run a deployed app without an access code.
    if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This deployment has no APP_SECRET configured. Set it in Vercel → Settings → Environment Variables, then redeploy.",
        },
        { status: 503 }
      );
    }
    return null; // local development only
  }

  const ip = clientIp(req);
  if (authLockedOut(ip)) return lockoutResponse();

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret)) {
    return null;
  }

  const provided = req.headers.get("x-app-secret") ?? "";
  if (!provided || !timingSafeEqual(provided, secret)) {
    // Only a *wrong* code counts against the lockout. A request with no header
    // and no cookie is the normal pre-login state, not a guess.
    if (provided) recordAuthFailure(ip);
    return NextResponse.json(
      { ok: false, code: "ACCESS_CODE_REQUIRED", error: "Access code required." },
      { status: 401 }
    );
  }

  clearAuthFailures(ip);
  return null;
}

/** Log the real error server-side; return only a safe message to the client. */
export function safeErrorResponse(
  context: string,
  e: unknown,
  fallback: string
): NextResponse {
  console.error(`[${context}]`, e);
  return NextResponse.json({ ok: false, error: fallback }, { status: 500 });
}
