import { afterEach, expect, it, vi } from "vitest";
import {
  getEbayAppCreds,
  getEbayCreds,
  isEbayAppConfigured,
  isEbayConfigured,
} from "@/lib/ebay/config";
afterEach(() => vi.unstubAllEnvs());
it("permits public research credentials while seller OAuth remains unconfigured", () => {
  vi.stubEnv("EBAY_CLIENT_ID", "test-id");
  vi.stubEnv("EBAY_CLIENT_SECRET", "test-secret");
  vi.stubEnv("EBAY_RU_NAME", undefined);
  expect(isEbayAppConfigured()).toBe(true);
  expect(getEbayAppCreds().clientId).toBe("test-id");
  expect(isEbayConfigured()).toBe(false);
  expect(() => getEbayCreds()).toThrow("EBAY_RU_NAME");
});
it("requires both app credentials for research", () => {
  vi.stubEnv("EBAY_CLIENT_ID", "test-id");
  vi.stubEnv("EBAY_CLIENT_SECRET", undefined);
  expect(isEbayAppConfigured()).toBe(false);
  expect(() => getEbayAppCreds()).toThrow("EBAY_CLIENT_SECRET");
});
