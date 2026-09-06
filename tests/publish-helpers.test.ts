import { describe, expect, test } from "vitest";
import { sanitizeEbayImageUrls, validListingPrice } from "@/lib/ebay/publish";
import { prioritizeAspects } from "@/lib/ebay/aspectFill";
import type { AspectMeta } from "@/lib/ebay/taxonomy";

describe("validListingPrice", () => {
  test("passes real prices through unchanged — no 18% markup", () => {
    expect(validListingPrice(20)).toBe(20);
    expect(validListingPrice("49.99")).toBe(49.99);
    expect(validListingPrice(100)).toBe(100);
  });

  test("rounds to cents", () => {
    expect(validListingPrice(19.999)).toBe(20);
  });

  test("missing/invalid prices block publish instead of becoming $35.39", () => {
    expect(validListingPrice(undefined)).toBeNull();
    expect(validListingPrice(0)).toBeNull();
    expect(validListingPrice(-5)).toBeNull();
    expect(validListingPrice("")).toBeNull();
    expect(validListingPrice("abc")).toBeNull();
  });
});

describe("prioritizeAspects", () => {
  const meta = (name: string, usage: AspectMeta["usage"]): AspectMeta => ({
    name,
    required: usage === "REQUIRED",
    usage,
    mode: "FREE_TEXT",
    cardinality: "SINGLE",
    values: [],
  });

  test("required aspects come first, then recommended, then optional", () => {
    const sorted = prioritizeAspects([
      meta("Opt1", "OPTIONAL"),
      meta("Rec1", "RECOMMENDED"),
      meta("Req1", "REQUIRED"),
      meta("Opt2", "OPTIONAL"),
      meta("Rec2", "RECOMMENDED"),
    ]);
    expect(sorted.map((a) => a.usage)).toEqual([
      "REQUIRED",
      "RECOMMENDED",
      "RECOMMENDED",
      "OPTIONAL",
      "OPTIONAL",
    ]);
    // Stable within a tier.
    expect(sorted.map((a) => a.name)).toEqual([
      "Req1",
      "Rec1",
      "Rec2",
      "Opt1",
      "Opt2",
    ]);
  });
});

describe("sanitizeEbayImageUrls", () => {
  const eps = (n: number) =>
    `https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/pic${n}.jpg`;

  test("accepts https eBay Picture Services URLs, preserving order", () => {
    const urls = [eps(1), eps(2), eps(3)];
    expect(sanitizeEbayImageUrls(urls)).toEqual(urls);
  });

  test("rejects non-eBay hosts, plain http, and junk", () => {
    expect(
      sanitizeEbayImageUrls([
        "https://evil.example.com/pic.jpg",
        "http://i.ebayimg.com/insecure.jpg",
        "https://notebayimg.com/pic.jpg",
        "https://fakeebayimg.com.evil.net/pic.jpg",
        "not a url",
        42,
        null,
      ]),
    ).toEqual([]);
  });

  test("dedupes and caps at eBay's 24-photo limit", () => {
    const urls = Array.from({ length: 30 }, (_, i) => eps(i));
    expect(sanitizeEbayImageUrls(urls)).toHaveLength(24);
    expect(sanitizeEbayImageUrls([eps(1), eps(1), eps(2)])).toEqual([
      eps(1),
      eps(2),
    ]);
  });

  test("non-array input yields no URLs", () => {
    expect(sanitizeEbayImageUrls(undefined)).toEqual([]);
    expect(sanitizeEbayImageUrls("https://i.ebayimg.com/x.jpg")).toEqual([]);
  });
});
