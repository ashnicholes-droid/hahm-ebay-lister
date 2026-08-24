import { describe, expect, it } from "vitest";
import {
  locationKeyForZip,
  normalizeZip,
  resolveLocation,
  validateZip,
  type EbayLocation,
} from "@/lib/shipFrom";

// The bug this replaces: the ZIP was consulted ONLY when creating a location,
// and creation happens once. Every account that had ever published kept
// whatever location it was first given — for a deployment that never set the
// env var, the hardcoded 10001 (Manhattan). Calculated shipping quoted every
// buyer from there.

const loc = (key: string, zip: string | null, status = "ENABLED"): EbayLocation => ({
  merchantLocationKey: key,
  merchantLocationStatus: status,
  location: zip === null ? {} : { address: { postalCode: zip } },
});

describe("normalizeZip", () => {
  it("accepts five digits", () => {
    expect(normalizeZip("19446")).toBe("19446");
  });

  it("accepts ZIP+4 and keeps the five eBay wants", () => {
    // Someone copying their full postal code shouldn't be told they're wrong.
    expect(normalizeZip("19446-1234")).toBe("19446");
    expect(normalizeZip("194461234")).toBe("19446");
  });

  it("preserves a leading zero", () => {
    // 02134 must not become 2134 — that isn't a ZIP at all.
    expect(normalizeZip("02134")).toBe("02134");
  });

  it("rejects anything that isn't a US ZIP", () => {
    for (const bad of ["", "  ", "1944", "abcde", "19446-12", "SW1A 1AA", null, undefined]) {
      expect(normalizeZip(bad)).toBeNull();
    }
  });
});

describe("validateZip", () => {
  it("explains the format rather than just refusing", () => {
    const r = validateZip("nope");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/five digits/i);
  });

  it("asks for a value when empty", () => {
    expect(validateZip("")).toHaveProperty("error");
  });

  it("returns the normalised form", () => {
    expect(validateZip(" 19446-9999 ")).toEqual({ zip: "19446" });
  });
});

describe("locationKeyForZip", () => {
  it("is deterministic, so a second publish reuses the same location", () => {
    expect(locationKeyForZip("19446")).toBe(locationKeyForZip("19446"));
  });

  it("stays inside eBay's key rules", () => {
    // Letters, digits, underscore and hyphen, 36 characters max.
    const key = locationKeyForZip("19446");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBeLessThanOrEqual(36);
  });
});

describe("resolveLocation", () => {
  it("reuses an existing location that already ships from the right ZIP", () => {
    const r = resolveLocation([loc("HOME_OFFICE", "10001"), loc("SHIPFROM_19446", "19446")], "19446");
    expect(r.key).toBe("SHIPFROM_19446");
    expect(r.mustCreate).toBe(false);
  });

  it("creates one when nothing on the account matches", () => {
    // This is the actual fix. eBay forbids editing an existing location's
    // address, so honouring a changed ZIP means making a new location.
    const r = resolveLocation([loc("HOME_OFFICE", "10001")], "19446");
    expect(r.mustCreate).toBe(true);
    expect(r.key).toBe("SHIPFROM_19446");
    expect(r.zip).toBe("19446");
  });

  it("does NOT silently fall back to a location in another town", () => {
    // The old behaviour: take the first enabled location whatever its ZIP.
    // That is precisely why setting the ZIP appeared to do nothing.
    const r = resolveLocation([loc("HOME_OFFICE", "10001")], "19446");
    expect(r.key).not.toBe("HOME_OFFICE");
  });

  it("matches on ZIP+4 stored at eBay", () => {
    const r = resolveLocation([loc("OLD", "19446-1234")], "19446");
    expect(r.key).toBe("OLD");
    expect(r.mustCreate).toBe(false);
  });

  it("ignores disabled locations", () => {
    const r = resolveLocation([loc("DEAD", "19446", "DISABLED")], "19446");
    expect(r.mustCreate).toBe(true);
  });

  it("keeps the old behaviour when no ZIP is requested", () => {
    // Nobody who hasn't set this should see a change.
    const r = resolveLocation([loc("HOME_OFFICE", "10001"), loc("OTHER", "19446")], null);
    expect(r.key).toBe("HOME_OFFICE");
    expect(r.mustCreate).toBe(false);
    expect(r.zip).toBe("10001");
  });

  it("reports the active ZIP, which is what makes the mismatch visible", () => {
    const r = resolveLocation([loc("HOME_OFFICE", "10001")], null);
    expect(r.zip).toBe("10001");
  });

  it("asks for a creation when the account has no locations at all", () => {
    expect(resolveLocation([], null)).toEqual({
      key: null,
      zip: null,
      mustCreate: true,
      mismatch: false,
    });
  });

  it("survives a location eBay returned without an address", () => {
    const r = resolveLocation([loc("WEIRD", null)], "19446");
    expect(r.mustCreate).toBe(true);
    // and without a requested ZIP it is still usable, just with an unknown ZIP
    expect(resolveLocation([loc("WEIRD", null)], null).key).toBe("WEIRD");
    expect(resolveLocation([loc("WEIRD", null)], null).zip).toBeNull();
  });
});
