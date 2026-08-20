import { describe, expect, it } from "vitest";
import {
  CORE_SCOPES,
  EBAY_OPTIONAL_SCOPES,
  EBAY_SCOPES,
  EBAY_SCOPES_LEGACY,
  OPTIONAL_SCOPE_IDS,
  optionalIdsFromScopeString,
  scopeString,
} from "@/lib/ebay/scopes";

// The bug this file exists for: an optional scope eBay wouldn't grant took out
// the ability to connect at all, because every scope shipped in one
// all-or-nothing string. eBay rejects the whole authorize request over one bad
// scope, so the core set must always be reachable on its own.
describe("core access can never be taken out by an extra", () => {
  it("always includes the four listing scopes", () => {
    for (const set of [scopeString([]), scopeString(OPTIONAL_SCOPE_IDS), EBAY_SCOPES]) {
      for (const core of CORE_SCOPES) expect(set).toContain(core);
    }
  });

  it("can be requested with no extras at all", () => {
    expect(scopeString([])).toBe(EBAY_SCOPES_LEGACY);
  });

  it("drops one extra without disturbing the others", () => {
    const without = scopeString(OPTIONAL_SCOPE_IDS.filter((id) => id !== "negotiation"));
    expect(without).toContain("sell.marketing");
    expect(without).toContain("sell.analytics.readonly");
    expect(without).not.toContain("sell.negotiation");
  });

  it("ignores an id it doesn't recognise rather than passing it to eBay", () => {
    // A stray value becoming a scope is exactly how the whole request gets
    // rejected, which is the failure this parameter exists to escape.
    expect(scopeString(["marketing", "not-a-real-scope"])).toBe(
      scopeString(["marketing"])
    );
  });
});

describe("remembering what a connection was granted", () => {
  it("round-trips a scope string back to its optional ids", () => {
    for (const ids of [[], ["marketing"], ["analytics", "negotiation"], OPTIONAL_SCOPE_IDS]) {
      expect(optionalIdsFromScopeString(scopeString(ids)).sort()).toEqual([...ids].sort());
    }
  });

  it("treats a connection with no recorded scopes as core-only", () => {
    // Connections stored before this was recorded must not be assumed to hold
    // permissions they were never granted.
    expect(optionalIdsFromScopeString(undefined)).toEqual([]);
    expect(optionalIdsFromScopeString("")).toEqual([]);
  });

  it("doesn't match a scope by prefix", () => {
    expect(optionalIdsFromScopeString("https://api.ebay.com/oauth/api_scope/sell.marketing.readonly"))
      .toEqual([]);
  });
});

describe("the optional list itself", () => {
  it("has unique ids and scopes", () => {
    expect(new Set(OPTIONAL_SCOPE_IDS).size).toBe(OPTIONAL_SCOPE_IDS.length);
    const scopes = EBAY_OPTIONAL_SCOPES.map((o) => o.scope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("says what each one is for, because the seller has to decide", () => {
    for (const o of EBAY_OPTIONAL_SCOPES) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.enables.length).toBeGreaterThan(0);
      expect(o.scope).toMatch(/^https:\/\/api\.ebay\.com\/oauth\/api_scope\//);
    }
  });

  it("keeps every optional scope out of the core set", () => {
    for (const o of EBAY_OPTIONAL_SCOPES) expect(CORE_SCOPES).not.toContain(o.scope);
  });
});
