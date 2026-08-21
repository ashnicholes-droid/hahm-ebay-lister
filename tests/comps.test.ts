import { describe, expect, test } from "vitest";
import { buildCompQuery, compShipping, compStats, filterComps } from "@/lib/ebay/comps";
import type { ListingResult } from "@/lib/types";

const listing = (over: Partial<ListingResult>): ListingResult => ({
  title: "Ralph Lauren Wool Sweater Blue Men's L",
  description: "",
  ...over,
});

describe("buildCompQuery", () => {
  test("prefers brand + item type", () => {
    expect(
      buildCompQuery(listing({ brand: "Ralph Lauren", item_type: "Cable Knit Sweater" }))
    ).toBe("Ralph Lauren Cable Knit Sweater");
  });
  test("ignores No Brand and falls back to the first title words", () => {
    expect(buildCompQuery(listing({ brand: "No Brand" }))).toBe(
      "Ralph Lauren Wool Sweater Blue Men's"
    );
  });
});

describe("filterComps", () => {
  const item = (title: string, price: number, conditionId?: string) => ({
    title,
    price: { value: String(price), currency: "USD" },
    conditionId,
    // Free postage keeps these fixtures about filtering, not about shipping.
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0", currency: "USD" } }],
  });
  const delivered = (comps: { delivered: number | null }[]) => comps.map((c) => c.delivered);

  test("excludes lots, parts, and reproductions", () => {
    const prices = filterComps(
      [
        item("Ralph Lauren Sweater", 40),
        item("Lot of 5 Ralph Lauren Sweaters", 120),
        item("Ralph Lauren Sweater for parts", 5),
        item("Reproduction Ralph Lauren style Sweater", 15),
      ],
      "EXCELLENT"
    );
    expect(delivered(prices)).toEqual([40]);
  });

  test("dimension titles are NOT mistaken for lots", () => {
    const prices = filterComps(
      [item("Framed Watercolor 16 x 20 Landscape", 45)],
      "EXCELLENT"
    );
    expect(delivered(prices)).toEqual([45]);
  });

  test("excludes wrong-condition comps when condition ids are present", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "EXCELLENT"
    );
    expect(delivered(prices)).toEqual([40]);
  });

  test("keeps new comps for new items", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "NEW_WITH_TAGS"
    );
    expect(delivered(prices)).toEqual([90]);
  });

  test("delivered price is item + postage, so a cheap item with $9 postage isn't cheap", () => {
    const [a, b] = filterComps(
      [
        { title: "Sweater", price: { value: "20", currency: "USD" },
          shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "9.00", currency: "USD" } }] },
        { title: "Sweater", price: { value: "26", currency: "USD" },
          shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0", currency: "USD" } }] },
      ],
      "EXCELLENT"
    );
    expect(a.delivered).toBe(29);
    expect(b.delivered).toBe(26);
    // The "cheaper" listing is the dearer one once postage is counted.
    expect(a.delivered!).toBeGreaterThan(b.delivered!);
  });

  test("a comp that quotes postage at checkout carries no delivered price", () => {
    const [c] = filterComps(
      [{ title: "Sweater", price: { value: "20", currency: "USD" },
         shippingOptions: [{ shippingCostType: "CALCULATED" }] }],
      "EXCELLENT"
    );
    // Null, not 20 — pretending postage is free would misprice it.
    expect(c.delivered).toBeNull();
    expect(c.shippingType).toBe("calculated");
  });
});

describe("compShipping", () => {
  test("reads free, flat, calculated and absent", () => {
    expect(compShipping({ shippingOptions: [{ shippingCost: { value: "0" } }] }).shippingType).toBe("free");
    expect(compShipping({ shippingOptions: [{ shippingCost: { value: "4.99" } }] }).shippingCost).toBe(4.99);
    expect(compShipping({ shippingOptions: [{ shippingCostType: "CALCULATED" }] }).shippingType).toBe("calculated");
    expect(compShipping({}).shippingType).toBe("unknown");
  });

  test("a calculated option that still quotes a figure is usable", () => {
    // eBay sometimes returns CALCULATED with an estimate to a default address.
    const s = compShipping({
      shippingOptions: [{ shippingCostType: "CALCULATED", shippingCost: { value: "7.25" } }],
    });
    expect(s.shippingCost).toBe(7.25);
  });
});

describe("compStats", () => {
  // compStats works on delivered prices now, so build minimal comps from them.
  const asComps = (prices: number[]) =>
    prices.map((p) => ({
      title: "t", itemPrice: p, shippingCost: 0, shippingType: "free" as const,
      delivered: p, condition: "Used", url: "", imageUrl: "",
    }));

  test("empty prices → zero confidence and no median", () => {
    const s = compStats([]);
    expect(s.count).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.median).toBeUndefined();
  });

  test("computes a sane median and band", () => {
    const s = compStats(asComps([48, 52, 55, 60, 62, 64, 70, 74, 80, 85, 90, 95]));
    expect(s.count).toBe(12);
    expect(s.median).toBeGreaterThan(60);
    expect(s.median).toBeLessThan(70);
    expect(s.low).toBeLessThan(s.median!);
    expect(s.high).toBeGreaterThan(s.median!);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  test("wildly dispersed comps lower confidence", () => {
    const tight = compStats(asComps([50, 52, 54, 55, 56, 58, 60, 61, 62, 63, 64, 65]));
    const loose = compStats(asComps([5, 20, 45, 55, 90, 150, 300, 12, 75, 33, 210, 400]));
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });
});
