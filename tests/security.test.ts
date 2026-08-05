import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { isWellFormedImage, toImageBlock } from "@/lib/images";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";

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
    process.env.APP_SECRET = "correct-horse-battery-staple";
    // Vitest already runs with NODE_ENV=test; only VERCEL_ENV could make the
    // guard think this is a production deployment.
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("lets a correct code through", () => {
    const res = guardApiRequest(post({ "x-app-secret": "correct-horse-battery-staple" }, "10.0.0.1"));
    expect(res).toBeNull();
  });

  it("asks for a code when none is supplied", async () => {
    const res = guardApiRequest(post({}, "10.0.0.2"));
    expect(res?.status).toBe(401);
    expect((await res!.json()).code).toBe("ACCESS_CODE_REQUIRED");
  });

  it("locks out a client after repeated wrong codes, well before the throughput limit", async () => {
    const ip = "10.0.0.3";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(guardApiRequest(post({ "x-app-secret": `guess-${i}` }, ip))!.status);
    }
    // First few are plain 401s; once the guess budget is spent it becomes a 429.
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual(Array(4).fill(429));
    const locked = guardApiRequest(post({ "x-app-secret": "correct-horse-battery-staple" }, ip));
    expect(locked?.status).toBe(429);
    expect((await locked!.json()).code).toBe("ACCESS_CODE_LOCKED");
  });

  it("keeps the lockout per-client — one attacker doesn't lock out everyone", () => {
    for (let i = 0; i < 10; i++) guardApiRequest(post({ "x-app-secret": "bad" }, "10.0.0.4"));
    const other = guardApiRequest(post({ "x-app-secret": "correct-horse-battery-staple" }, "10.0.0.5"));
    expect(other).toBeNull();
  });

  it("does not count the header-less handshake against the guess budget", () => {
    const ip = "10.0.0.6";
    for (let i = 0; i < 20; i++) {
      expect(guardApiRequest(post({}, ip))?.status).toBe(401);
    }
    expect(guardApiRequest(post({ "x-app-secret": "correct-horse-battery-staple" }, ip))).toBeNull();
  });

  it("fails closed in production when APP_SECRET is missing", async () => {
    delete process.env.APP_SECRET;
    process.env.VERCEL_ENV = "production";
    const res = guardApiRequest(post({}, "10.0.0.7"));
    expect(res?.status).toBe(503);
  });
});
