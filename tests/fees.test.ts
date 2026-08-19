import { describe, expect, it } from "vitest";
import { FEE_FIXED, FEE_PERCENT, finalValueFee, netAtPrice } from "@/lib/fees";

describe("eBay's cut", () => {
  it("is charged on the order total, not the item price", () => {
    // The part that catches people out: charge the buyer for shipping and you
    // are charged a fee on that shipping too.
    expect(finalValueFee(100)).toBeCloseTo(100 * FEE_PERCENT + FEE_FIXED, 6);
    expect(finalValueFee(110)).toBeGreaterThan(finalValueFee(100));
  });
});

describe("what you keep, by shipping arrangement", () => {
  it("nets more when the buyer pays postage than when you do", () => {
    // The whole reason this sits next to the price field.
    const buyerPays = netAtPrice(50, "flat", 8);
    const youPay = netAtPrice(50, "free");
    expect(buyerPays.net).toBeGreaterThan(youPay.net - 8);
    expect(buyerPays.label).toMatch(/Buyer pays \$8\.00/);
    expect(youPay.label).toMatch(/You pay the postage/);
  });

  it("charges the fee on price plus shipping when the buyer pays a flat rate", () => {
    const r = netAtPrice(50, "flat", 10);
    expect(r.net).toBeCloseTo(50 - finalValueFee(60), 6);
  });

  it("charges the fee on the price alone under free shipping", () => {
    const r = netAtPrice(50, "free");
    expect(r.net).toBeCloseTo(50 - finalValueFee(50), 6);
  });

  it("flags free shipping as excluding a postage cost it cannot know", () => {
    // Guessing the label price from a live listing would be inventing a number.
    const r = netAtPrice(50, "free");
    expect(r.postageExcluded).toBe(true);
    expect(r.label).toMatch(/minus whatever the label costs/i);
  });

  it("says calculated shipping varies rather than pretending to a figure", () => {
    const r = netAtPrice(50, "calculated");
    expect(r.label).toMatch(/calculated/i);
    expect(r.label).toMatch(/also takes its cut/i);
  });

  it("admits when the arrangement is unknown", () => {
    const r = netAtPrice(50, "unknown");
    expect(r.label).toMatch(/unknown/i);
  });

  it("says nothing useless for a missing price", () => {
    for (const p of [0, -5, NaN]) {
      expect(netAtPrice(p, "free").label).toMatch(/Set a price/i);
    }
  });

  it("moves as the price moves, which is the point of showing it live", () => {
    const a = netAtPrice(40, "flat", 8).net;
    const b = netAtPrice(60, "flat", 8).net;
    expect(b).toBeGreaterThan(a);
  });
});
