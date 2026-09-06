import { afterEach, expect, it, vi } from "vitest";
import { ownerFromCookie, newOwner, cloudEnabled } from "@/lib/cloud/store";
afterEach(() => vi.unstubAllEnvs());
it("rejects forged ownership cookies and cookies from another environment", () => {
  vi.stubEnv("SESSION_SECRET", "a".repeat(64));
  vi.stubEnv("VERCEL_ENV", "preview");
  const o = newOwner();
  expect(ownerFromCookie(o.cookie)).toBe(o.id);
  expect(ownerFromCookie(o.cookie.replace(o.id, "0".repeat(36)))).toBeNull();
  expect(ownerFromCookie("malformed")).toBeNull();
  vi.stubEnv("VERCEL_ENV", "production");
  expect(ownerFromCookie(o.cookie)).toBeNull();
});
it("requires an explicit rollout flag and every service credential", () => {
  vi.stubEnv("CLOUD_BATCH_ENABLED", "false");
  expect(cloudEnabled()).toBe(false);
  vi.stubEnv("CLOUD_BATCH_ENABLED", "true");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  expect(cloudEnabled()).toBe(false);
});
