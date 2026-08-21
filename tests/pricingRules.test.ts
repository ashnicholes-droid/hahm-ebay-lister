import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  normalizeRules,
  recommendedPrice,
  roundPrice,
  type PricingRules,
} from "@/lib/pricingRules";
import type { Comp, CompsSummary } from "@/lib/types";

const comp = (delivered: number | null, itemPrice = delivered ?? 0): Comp => ({
  title: "thing",
  itemPrice,
  shippingCost: delivered === null ? null : Math.round((delivered - itemPrice) * 100) / 100,
  shippingType: delivered === null ? "calculated" : delivered === itemPrice ? "free" : "flat",
  delivered,
  condition: "Used",
  url: "",
  imageUrl: "",
});

const summary = (comps: Comp[], over: Partial<CompsSummary> = {}): CompsSummary => ({
  ok: true,
  query: "q",
  count: comps.length,
  pricedCount: comps.filter((c) => c.delivered !== null).length,
  comps,
  confidence: 0.8,
  basis: "",
  low: 10,
  ...over,
});

const rules = (over: Partial<PricingRules> = {}): PricingRules => ({ ...DEFAULT_RULES, ...over });

describe("normalizeRules", () => {
  it("falls back to defaults for junk", () => {
    expect(normalizeRules(null)).toEqual(DEFAULT_RULES);
    expect(normalizeRules({ bottomPercentile: NaN })).toEqual(DEFAULT_RULES);
    expect(normalizeRules({ basis: "nonsense" as never }).basis).toBe("delivered");
  });

  it("clamps a percentile past the median — 'bottom' stops meaning anything there", () => {
    expect(normalizeRules({ bottomPercentile: 90 }).bottomPercentile).toBe(50);
    expect(normalizeRules({ bottomPercentile: -5 }).bottomPercentile).toBe(0);
  });

  it("allows a negative margin, because undercutting the bottom is a real choice", () => {
    expect(normalizeRules({ percentAboveBottom: -10 }).percentAboveBottom).toBe(-10);
    expect(normalizeRules({ percentAboveBottom: -999 }).percentAboveBottom).toBe(-50);
  });

  it("accepts numeric strings, since they come from input fields", () => {
    expect(normalizeRules({ percentAboveBottom: "7" as never }).percentAboveBottom).toBe(7);
  });
});

describe("roundPrice", () => {
  it("rounds to the NEAREST .99, so the seller's margin isn't distorted", () => {
    // Always rounding down would turn 43.72 into 42.99 — a 1.7% cut nobody
    // asked for, on top of whatever margin was configured.
    expect(roundPrice(43.72, "99")).toBe(43.99);
    expect(roundPrice(43.2, "99")).toBe(42.99);
    expect(roundPrice(43.99, "99")).toBe(43.99);
  });

  it("stays within half a dollar of the computed price either way", () => {
    for (const v of [10.01, 12.4, 12.5, 12.6, 19.99, 20.0, 87.34]) {
      expect(Math.abs(roundPrice(v, "99") - v)).toBeLessThanOrEqual(0.51);
    }
  });

  it("handles the .95 convention the same way", () => {
    expect(roundPrice(43.7, "95")).toBe(43.95);
    expect(roundPrice(43.1, "95")).toBe(42.95);
  });

  it("leaves the figure alone when asked to", () => {
    expect(roundPrice(43.216, "none")).toBe(43.22);
  });

  it("rounds to whole dollars on request", () => {
    expect(roundPrice(43.2, "whole")).toBe(43);
  });

  it("doesn't produce a nonsense price under a dollar", () => {
    expect(roundPrice(0.4, "99")).toBe(0.4);
    expect(roundPrice(0, "99")).toBe(0);
  });
});

describe("recommendedPrice", () => {
  const market = [comp(20), comp(24), comp(28), comp(32), comp(36), comp(40)];

  it("anchors to the bottom of the market, not the middle", () => {
    const rec = recommendedPrice(summary(market), rules({ rounding: "none" }))!;
    const median = 30;
    expect(rec.price).toBeLessThan(median);
    // p10 of 20..40 is 22, +5% = 23.10
    expect(rec.bottom).toBeCloseTo(22, 2);
    expect(rec.price).toBeCloseTo(23.1, 2);
  });

  it("never recommends below the anchor when the margin is positive", () => {
    // The invariant rounding must not break: asking to sit ABOVE the bottom of
    // the market and being handed a price below it would be plainly wrong.
    for (const pct of [0, 1, 2, 5, 10]) {
      for (const scale of [1, 1.3, 2.7, 5.5, 11.2]) {
        const scaled = market.map((c) => comp(Math.round(c.delivered! * scale * 100) / 100));
        const rec = recommendedPrice(summary(scaled), rules({ percentAboveBottom: pct }))!;
        expect(rec.price).toBeGreaterThanOrEqual(rec.bottom);
      }
    }
  });

  it("moves when the percentile setting moves", () => {
    const low = recommendedPrice(summary(market), rules({ bottomPercentile: 0, rounding: "none" }))!;
    const high = recommendedPrice(
      summary(market),
      rules({ bottomPercentile: 50, rounding: "none" })
    )!;
    expect(low.bottom).toBe(20);
    expect(high.bottom).toBe(30);
    expect(high.price).toBeGreaterThan(low.price);
  });

  it("moves when the margin setting moves", () => {
    const a = recommendedPrice(summary(market), rules({ percentAboveBottom: 0, rounding: "none" }))!;
    const b = recommendedPrice(
      summary(market),
      rules({ percentAboveBottom: 20, rounding: "none" })
    )!;
    expect(a.price).toBeCloseTo(22, 2);
    expect(b.price).toBeCloseTo(26.4, 2);
  });

  it("prices on delivered by default, and on item price when asked", () => {
    // Same items, but $8 postage each: delivered is 8 higher than item price.
    const shipped = [comp(28, 20), comp(32, 24), comp(36, 28), comp(40, 32)];
    const delivered = recommendedPrice(summary(shipped), rules({ rounding: "none" }))!;
    const itemOnly = recommendedPrice(
      summary(shipped),
      rules({ basis: "item", rounding: "none" })
    )!;
    // The whole point: ignoring postage would price this $8 too low.
    expect(delivered.bottom - itemOnly.bottom).toBeCloseTo(8, 2);
  });

  it("ignores comps whose postage is quoted at checkout", () => {
    // A calculated comp has no delivered price; counting its item price would
    // drag the anchor down by the cost of postage.
    const mixed = [comp(30, 30), comp(34, 34), comp(null, 5)];
    const rec = recommendedPrice(summary(mixed), rules({ bottomPercentile: 0, rounding: "none" }))!;
    expect(rec.bottom).toBe(30);
  });

  it("applies the storewide markup last, on top of the rule", () => {
    const plain = recommendedPrice(summary(market), rules({ rounding: "none" }), 0)!;
    const marked = recommendedPrice(summary(market), rules({ rounding: "none" }), 50)!;
    expect(marked.price).toBeCloseTo(plain.price * 1.5, 2);
    expect(marked.explanation).toMatch(/50% storewide markup/);
  });

  it("returns null rather than inventing a price with no market", () => {
    expect(recommendedPrice(undefined, rules())).toBeNull();
    expect(recommendedPrice(summary([], { ok: false }), rules())).toBeNull();
    expect(recommendedPrice(summary([comp(null, 5)], { low: 0 }), rules())).toBeNull();
  });

  it("flags a thin band instead of quietly presenting it as solid", () => {
    expect(recommendedPrice(summary([comp(20), comp(30)]), rules())!.thin).toBe(true);
    expect(recommendedPrice(summary(market), rules())!.thin).toBe(false);
  });

  it("explains itself in terms the seller can check", () => {
    const rec = recommendedPrice(summary(market), rules())!;
    expect(rec.explanation).toMatch(/5% above the 10th percentile/);
    expect(rec.explanation).toMatch(/\$22\.00 delivered/);
    expect(rec.explanation).toMatch(/6 active comps/);
  });

  it("says 'at' rather than '0% above' when the margin is zero", () => {
    expect(recommendedPrice(summary(market), rules({ percentAboveBottom: 0 }))!.explanation).toMatch(
      /^at the 10th/
    );
  });

  it("falls back to the summary band when comps weren't returned", () => {
    const stale = summary([], { count: 8, pricedCount: 8, low: 40, comps: undefined });
    const rec = recommendedPrice(stale, rules({ rounding: "none" }))!;
    expect(rec.bottom).toBe(40);
  });
});
