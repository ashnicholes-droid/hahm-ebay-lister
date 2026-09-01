import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { isWellFormedImage, toImageBlock } from "@/lib/images";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  accessCodeMatches,
  isPublicPath,
  issueSession,
  verifySession,
} from "@/lib/session-auth";

const SECRET = "correct-horse-battery-staple";

// Valid file headers, base64-encoded, padded out to the 16 chars the sniffer reads.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(20),
]).toString("base64");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]).toString("base64");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(12),
]).toString("base64");

function post(headers: Record<string, string> = {}, ip = "1.2.3.4"): NextRequest {
  return new NextRequest("https://example.test/api/analyze", {
    method: "POST",
    headers: { "x-forwarded-for": ip, ...headers },
  });
}

describe("image signature validation", () => {
  it("accepts real JPEG / PNG / WebP headers", () => {
    expect(isWellFormedImage(JPEG, "image/jpeg")).toBe(true);
    expect(isWellFormedImage(PNG, "image/png")).toBe(true);
    expect(isWellFormedImage(WEBP, "image/webp")).toBe(true);
  });

  it("rejects data whose bytes disagree with the claimed media type", () => {
    expect(isWellFormedImage(PNG, "image/jpeg")).toBe(false);
    expect(isWellFormedImage(JPEG, "image/png")).toBe(false);
  });

  it("rejects non-base64 and truncated payloads", () => {
    expect(isWellFormedImage("not base64 at all!!", "image/jpeg")).toBe(false);
    expect(isWellFormedImage("/9j/", "image/jpeg")).toBe(false);
  });

  it("rejects unknown media types outright", () => {
    expect(isWellFormedImage(JPEG, "image/gif")).toBe(false);
    expect(isWellFormedImage(JPEG, "text/html")).toBe(false);
  });

  it("toImageBlock passes real images through and drops forgeries", () => {
    expect(toImageBlock({ mediaType: "image/jpeg", data: JPEG })).not.toBeNull();
    // Claims JPEG, actually carries PNG bytes — a wasted Anthropic call avoided.
    expect(toImageBlock({ mediaType: "image/jpeg", data: PNG })).toBeNull();
  });

  it("accepts a full data URL, not just bare base64", () => {
    expect(
      toImageBlock({ mediaType: "image/jpeg", data: `data:image/jpeg;base64,${JPEG}` })
    ).not.toBeNull();
  });
});

describe("body size limit", () => {
  it("rejects a request whose declared length exceeds the cap", () => {
    const res = enforceBodyLimit(post({ "content-length": String(BODY_LIMIT_JSON + 1) }), BODY_LIMIT_JSON);
    expect(res?.status).toBe(413);
  });

  it("allows a request within the cap, and one with no content-length", () => {
    expect(enforceBodyLimit(post({ "content-length": "1024" }), BODY_LIMIT_JSON)).toBeNull();
    expect(enforceBodyLimit(post(), BODY_LIMIT_JSON)).toBeNull();
  });
});

describe("access-code guard", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.APP_SECRET = SECRET;
    // Vitest already runs with NODE_ENV=test; only VERCEL_ENV could make the
    // guard think this is a production deployment.
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("lets a correct code through", async () => {
    const res = await guardApiRequest(post({ "x-app-secret": SECRET }, "10.0.0.1"));
    expect(res).toBeNull();
  });

  it("asks for a code when none is supplied", async () => {
    const res = await guardApiRequest(post({}, "10.0.0.2"));
    expect(res?.status).toBe(401);
    expect((await res!.json()).code).toBe("ACCESS_CODE_REQUIRED");
  });

  it("locks out a client after repeated wrong codes, well before the throughput limit", async () => {
    const ip = "10.0.0.3";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await guardApiRequest(post({ "x-app-secret": `guess-${i}` }, ip)))!.status);
    }
    // First few are plain 401s; once the guess budget is spent it becomes a 429.
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual(Array(4).fill(429));
    const locked = await guardApiRequest(post({ "x-app-secret": SECRET }, ip));
    expect(locked?.status).toBe(429);
    expect((await locked!.json()).code).toBe("ACCESS_CODE_LOCKED");
  });

  it("keeps the lockout per-client — one attacker doesn't lock out everyone", async () => {
    for (let i = 0; i < 10; i++) await guardApiRequest(post({ "x-app-secret": "bad" }, "10.0.0.4"));
    expect(await guardApiRequest(post({ "x-app-secret": SECRET }, "10.0.0.5"))).toBeNull();
  });

  it("does not count the credential-less request against the guess budget", async () => {
    const ip = "10.0.0.6";
    for (let i = 0; i < 20; i++) {
      expect((await guardApiRequest(post({}, ip)))?.status).toBe(401);
    }
    expect(await guardApiRequest(post({ "x-app-secret": SECRET }, ip))).toBeNull();
  });

  it("fails closed in production when APP_SECRET is missing", async () => {
    delete process.env.APP_SECRET;
    process.env.VERCEL_ENV = "production";
    const res = await guardApiRequest(post({}, "10.0.0.7"));
    expect(res?.status).toBe(503);
  });

  it("accepts a valid session cookie instead of the header", async () => {
    const token = await issueSession(SECRET);
    const res = await guardApiRequest(post({ cookie: `${SESSION_COOKIE}=${token}` }, "10.0.0.8"));
    expect(res).toBeNull();
  });

  it("rejects a session cookie signed with a different APP_SECRET", async () => {
    const token = await issueSession("some-other-secret-entirely");
    const res = await guardApiRequest(post({ cookie: `${SESSION_COOKIE}=${token}` }, "10.0.0.9"));
    expect(res?.status).toBe(401);
  });
});

describe("session tokens", () => {
  it("round-trips a freshly issued session", async () => {
    expect(await verifySession(await issueSession(SECRET), SECRET)).toBe(true);
  });

  it("rejects a session signed with a different secret — rotating APP_SECRET logs everyone out", async () => {
    const token = await issueSession(SECRET);
    expect(await verifySession(token, "rotated-secret-value")).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const [v, t, sig] = (await issueSession(SECRET)).split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifySession(`${v}.${t}.${flipped}`, SECRET)).toBe(false);
  });

  it("rejects a forged issue time — you cannot re-date someone else's signature", async () => {
    const [v, , sig] = (await issueSession(SECRET, Date.now() - 60_000)).split(".");
    expect(await verifySession(`${v}.${Date.now()}.${sig}`, SECRET)).toBe(false);
  });

  it("expires after the max age, and not before", async () => {
    const expired = await issueSession(SECRET, Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000);
    expect(await verifySession(expired, SECRET)).toBe(false);
    const nearly = await issueSession(SECRET, Date.now() - (SESSION_MAX_AGE_SECONDS - 60) * 1000);
    expect(await verifySession(nearly, SECRET)).toBe(true);
  });

  it("rejects a token issued in the future", async () => {
    const token = await issueSession(SECRET, Date.now() + 10 * 60_000);
    expect(await verifySession(token, SECRET)).toBe(false);
  });

  it("rejects malformed and empty tokens without throwing", async () => {
    for (const bad of ["", "garbage", "v1.abc", "v1.123.sig.extra", "v2.123.sig"]) {
      expect(await verifySession(bad, SECRET)).toBe(false);
    }
    expect(await verifySession(undefined, SECRET)).toBe(false);
    expect(await verifySession(await issueSession(SECRET), undefined)).toBe(false);
  });

  it("matches the access code exactly, and nothing near it", async () => {
    expect(await accessCodeMatches(SECRET, SECRET)).toBe(true);
    expect(await accessCodeMatches(SECRET.toUpperCase(), SECRET)).toBe(false);
    expect(await accessCodeMatches(`${SECRET} `, SECRET)).toBe(false);
    expect(await accessCodeMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(await accessCodeMatches("", SECRET)).toBe(false);
  });
});

describe("public paths", () => {
  it("leaves reachable exactly the paths that must not be gated", () => {
    // eBay redirects a browser to the callback, and requires a publicly
    // reachable privacy policy for the keyset. Gating either breaks posting or
    // developer-account compliance.
    expect(isPublicPath("/api/ebay/callback")).toBe(true);
    expect(isPublicPath("/privacy")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/login")).toBe(true);
    expect(isPublicPath("/api/logout")).toBe(true);
    // The sign-in page links these in its own <head>. Gated, the browser
    // follows the redirect and renders the login HTML as the tab icon.
    expect(isPublicPath("/icon.svg")).toBe(true);
    expect(isPublicPath("/apple-icon.png")).toBe(true);
  });

  it("keeps the icons public with Next's cache-busting query attached", () => {
    // Next serves them as /icon.svg?<hash>; the gate sees pathname only, but
    // this pins the behaviour the <link> in every page head depends on.
    expect(isPublicPath(new URL("https://x/icon.svg?abc123").pathname)).toBe(
      true
    );
  });

  it("gates everything else, including every route that spends money", () => {
    for (const path of [
      "/",
      "/api/analyze",
      "/api/sort",
      "/api/verify",
      "/api/models",
      "/api/ebay/publish",
      "/api/ebay/upload-photos",
      "/api/ebay/connect",
      "/api/ebay/status",
      "/api/ebay/preview",
    ]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("does not let a prefix collision open a gated path", () => {
    // "/privacy" is public; "/privacy-report" is a different path and must not
    // inherit that just because it shares a prefix.
    expect(isPublicPath("/privacy-report")).toBe(false);
    expect(isPublicPath("/login-as-admin")).toBe(false);
    expect(isPublicPath("/api/ebay/callback-hijack")).toBe(false);
    // A real subpath of a public path stays public.
    expect(isPublicPath("/privacy/details")).toBe(true);
  });
});

describe("deployment health probe", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.VERCEL_ENV;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  const probe = async () => {
    const { GET } = await import("@/app/api/ebay/status/route");
    const req = new NextRequest("https://example.test/api/ebay/status", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    return (await GET(req)).json();
  };

  it("reports a missing APP_SECRET in production so the UI can say why nothing works", async () => {
    delete process.env.APP_SECRET;
    process.env.VERCEL_ENV = "production";
    const body = await probe();
    expect(body.setupError).toMatch(/APP_SECRET/);
  });

  it("stays quiet once APP_SECRET is set", async () => {
    process.env.APP_SECRET = SECRET;
    process.env.VERCEL_ENV = "production";
    expect((await probe()).setupError).toBeUndefined();
  });

  it("stays quiet in local development, where the gate is off by design", async () => {
    delete process.env.APP_SECRET;
    expect((await probe()).setupError).toBeUndefined();
  });
});
