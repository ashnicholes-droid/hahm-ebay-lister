import { describe, expect, it } from "vitest";
import { BOXES, fits, selectBox } from "@/lib/shipping/boxes";
import {
  billableOz,
  dimensionalOz,
  parseRateTable,
  rateTable,
  weightBasedRate,
} from "@/lib/shipping/rates";
import { ebayPackageFromEstimate, estimateShipping } from "@/lib/shipping/estimate";
import { isFreeShippingPolicy, selectFulfillmentPolicy } from "@/lib/ebay/publish";
import type { AccountSetup } from "@/lib/ebay/publish";

describe("box selection", () => {
  it("picks the smallest box the item actually fits, with padding", () => {
    const box = selectBox({ l: 6, w: 4, h: 2 });
    expect(box?.id).toBe("box-8x6x4");
  });

  it("matches longest side to longest side rather than l-to-l", () => {
    // A long, thin item fits a box whose *height* is the long axis.
    expect(fits({ l: 1, w: 1, h: 10 }, BOXES.find((b) => b.id === "box-12x9x4")!)).toBe(true);
  });

  it("refuses a box the item only fits with no padding at all", () => {
    const box = BOXES.find((b) => b.id === "box-8x6x4")!;
    expect(fits({ l: 8, w: 6, h: 4 }, box)).toBe(false);
    expect(fits({ l: 6.4, w: 4.4, h: 2.4 }, box)).toBe(true);
  });

  it("returns null for something bigger than the catalogue", () => {
    expect(selectBox({ l: 40, w: 30, h: 20 })).toBeNull();
  });

  it("puts a broad, thin item in a flat box rather than a deep cube", () => {
    // A 13-inch skillet. Without flat boxes the only fit was 20×16×12, which
    // pushed it over a cubic foot and got it billed on dimensional weight.
    const box = selectBox({ l: 13, w: 13, h: 2.5 })!;
    expect(box.inner.h).toBeLessThanOrEqual(4);
    expect(box.inner.l * box.inner.w * box.inner.h).toBeLessThan(1728);
  });

  it("puts a long, narrow item in a long box rather than a large square one", () => {
    const box = selectBox({ l: 28, w: 3, h: 3 })!;
    expect(box.id).toBe("box-30x6x6");
    // Long enough for the item, and not a big square box it would rattle in.
    expect(Math.max(box.inner.l, box.inner.w, box.inner.h)).toBeGreaterThanOrEqual(29.5);
    expect(box.inner.l * box.inner.w * box.inner.h).toBeLessThan(1728);
  });

  it("lists boxes smallest-volume first, so 'first that fits' is 'smallest that fits'", () => {
    const vols = BOXES.map((b) => b.inner.l * b.inner.w * b.inner.h);
    expect([...vols].sort((a, b) => a - b)).toEqual(vols);
  });

  it("never picks a USPS flat-rate box as a general carton", () => {
    // Those boxes are supplied for Priority Flat Rate only; using one for
    // Ground Advantage breaks USPS terms. Flat rate is priced separately.
    for (const dims of [
      { l: 6, w: 4, h: 1 },
      { l: 8, w: 6, h: 3 },
      { l: 10, w: 9, h: 3 },
    ]) {
      expect(selectBox(dims)?.flatRate).toBeFalsy();
    }
  });
});

describe("dimensional weight", () => {
  it("does not apply under one cubic foot", () => {
    expect(dimensionalOz({ l: 10, w: 8, h: 6 })).toBe(0); // 480 in³
    expect(billableOz(20, { l: 10, w: 8, h: 6 })).toBe(20);
  });

  it("applies over one cubic foot and can exceed actual weight", () => {
    // 18×14×10 = 2520 in³ → 2520/166 ≈ 15.2 lb → 243 oz.
    const dims = { l: 18, w: 14, h: 10 };
    expect(dimensionalOz(dims)).toBeGreaterThan(200);
    expect(billableOz(40, dims)).toBe(dimensionalOz(dims));
  });

  it("bills actual weight when the item is heavy for its size", () => {
    const dims = { l: 13, w: 11, h: 13 }; // just over a cubic foot
    expect(billableOz(600, dims)).toBe(600);
  });

  it("rounds partial ounces up — carriers do not round in your favour", () => {
    expect(billableOz(20.1, { l: 6, w: 6, h: 6 })).toBe(21);
  });
});

describe("rate lookup", () => {
  it("prices at the first weight break at or above the billable weight", () => {
    const t = rateTable();
    expect(weightBasedRate("ground_advantage", 4, t)).toBe(weightBasedRate("ground_advantage", 1, t));
    expect(weightBasedRate("ground_advantage", 5, t)).toBeGreaterThan(
      weightBasedRate("ground_advantage", 4, t)!
    );
  });

  it("rises monotonically with weight", () => {
    const t = rateTable();
    let prev = 0;
    for (const oz of [1, 8, 16, 32, 64, 160, 320, 800]) {
      const usd = weightBasedRate("ground_advantage", oz, t)!;
      expect(usd).toBeGreaterThanOrEqual(prev);
      prev = usd;
    }
  });

  it("returns null above the service ceiling instead of a bogus price", () => {
    expect(weightBasedRate("ground_advantage", 99_999)).toBeNull();
  });
});

describe("rate table override", () => {
  const valid = JSON.stringify({
    effective: "2027-01",
    ground_advantage: [{ maxOz: 16, usd: 1 }, { maxOz: 999, usd: 2 }],
    priority: [{ maxOz: 999, usd: 3 }],
    flat_rate_by_box: { "usps-fr-sm": 4 },
  });

  it("accepts a well-formed override and uses it", () => {
    const t = parseRateTable(valid)!;
    expect(t.effective).toBe("2027-01");
    expect(weightBasedRate("ground_advantage", 10, t)).toBe(1);
  });

  it("sorts override breaks so an out-of-order table still prices correctly", () => {
    const t = parseRateTable(
      JSON.stringify({
        ground_advantage: [{ maxOz: 999, usd: 9 }, { maxOz: 16, usd: 1 }],
        priority: [{ maxOz: 999, usd: 3 }],
        flat_rate_by_box: {},
      })
    )!;
    expect(weightBasedRate("ground_advantage", 10, t)).toBe(1);
  });

  it("rejects malformed overrides rather than silently zeroing shipping", () => {
    for (const bad of [
      "",
      "not json",
      "{}",
      JSON.stringify({ ground_advantage: [], priority: [], flat_rate_by_box: {} }),
      JSON.stringify({ ground_advantage: [{ maxOz: "x", usd: 1 }], priority: [{ maxOz: 1, usd: 1 }], flat_rate_by_box: {} }),
      JSON.stringify({ ground_advantage: [{ maxOz: 1, usd: 1 }], priority: [{ maxOz: 1, usd: 1 }], flat_rate_by_box: { a: "free" } }),
    ]) {
      expect(parseRateTable(bad)).toBeNull();
    }
  });

  it("falls back to the built-in table when the override is bad", () => {
    expect(rateTable("garbage").effective).toBe(rateTable(undefined).effective);
  });
});

describe("end-to-end estimate", () => {
  it("uses the photo-derived weight and size when both are present", () => {
    const e = estimateShipping({ itemOz: 22, itemDims: { l: 9, w: 7, h: 3 } });
    expect(e.basis).toBe("photos");
    expect(e.itemOz).toBe(22);
    expect(e.warnings).toEqual([]);
  });

  it("adds the box and packing material to the item weight", () => {
    const e = estimateShipping({ itemOz: 20, itemDims: { l: 6, w: 4, h: 2 } });
    expect(e.packedOz).toBeGreaterThan(20);
    expect(e.box?.id).toBe("box-8x6x4");
  });

  it("falls back to a category profile and says so when the photos showed nothing", () => {
    const e = estimateShipping({ category: "book" });
    expect(e.basis).toBe("category-default");
    expect(e.warnings.join(" ")).toMatch(/category guess/i);
    expect(e.itemOz).toBe(14);
  });

  it("flags a partial estimate — a weight with no dimensions is still a guess", () => {
    const e = estimateShipping({ itemOz: 30, category: "tool" });
    expect(e.basis).toBe("category-default");
    expect(e.itemOz).toBe(30); // the stated weight is still honoured
  });

  it("recommends the cheapest option and sorts the rest by price", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 6, w: 4, h: 1 } });
    expect(e.recommended).not.toBeNull();
    expect(e.recommended!.usd).toBe(Math.min(...e.options.map((o) => o.usd)));
    expect(e.options.map((o) => o.usd)).toEqual([...e.options.map((o) => o.usd)].sort((a, b) => a - b));
  });

  it("offers flat rate for a heavy item that fits a flat-rate box, and prefers it", () => {
    // Dense and small: exactly where flat rate beats weight-based pricing.
    const e = estimateShipping({ itemOz: 200, itemDims: { l: 8, w: 6, h: 3 } });
    expect(e.options.some((o) => o.serviceId === "priority_flat_rate")).toBe(true);
    expect(e.recommended!.serviceId).toBe("priority_flat_rate");
  });

  it("warns when volume rather than weight sets the price", () => {
    const e = estimateShipping({ itemOz: 30, itemDims: { l: 17, w: 13, h: 9 } });
    expect(e.billableOz).toBeGreaterThan(Math.ceil(e.packedOz));
    expect(e.warnings.join(" ")).toMatch(/dimensional weight/i);
    expect(e.recommended?.dimensionalPricing).toBe(true);
  });

  it("reports honestly when nothing in the catalogue fits, instead of inventing a price", () => {
    const e = estimateShipping({ itemOz: 400, itemDims: { l: 40, w: 30, h: 20 } });
    expect(e.box).toBeNull();
    expect(e.options).toEqual([]);
    expect(e.recommended).toBeNull();
    expect(e.warnings.join(" ")).toMatch(/freight|custom carton/i);
  });

  it("carries the rate table's vintage so the UI can show how stale it is", () => {
    const e = estimateShipping({ itemOz: 10, itemDims: { l: 5, w: 4, h: 2 } });
    expect(e.rateTableEffective).toMatch(/^\d{4}-\d{2}$/);
  });

  it("ignores nonsense weights and dimensions rather than trusting them", () => {
    const e = estimateShipping({
      itemOz: -5,
      itemDims: { l: 0, w: NaN, h: 4 },
      category: "book",
    });
    expect(e.basis).toBe("category-default");
    expect(e.itemOz).toBe(14);
  });
});

describe("eBay package payload", () => {
  it("matches the box the estimate recommended, so quote and listing agree", () => {
    const e = estimateShipping({ itemOz: 200, itemDims: { l: 8, w: 6, h: 3 } });
    const pkg = ebayPackageFromEstimate(e)!;
    expect(e.recommended!.boxId).toBe("usps-fr-md");
    // Flat-rate medium is 11×8.5×5.5 inner → outer adds the wall thickness.
    expect(pkg.l).toBeCloseTo(11.5, 1);
    expect(pkg.weightOz).toBeGreaterThan(200);
  });

  it("never reports a zero weight — eBay rejects that with error 25020", () => {
    const pkg = ebayPackageFromEstimate(estimateShipping({ itemOz: 0.01, itemDims: { l: 1, w: 1, h: 1 } }))!;
    expect(pkg.weightOz).toBeGreaterThanOrEqual(1);
  });

  it("returns null when there is no box to describe", () => {
    expect(ebayPackageFromEstimate(estimateShipping({ itemDims: { l: 40, w: 30, h: 20 } }))).toBeNull();
  });
});

// ── eBay fulfillment policy selection ────────────────────────────────────────

const policy = (services: unknown[], optionType = "DOMESTIC") => ({
  shippingOptions: [{ optionType, shippingServices: services }],
});

describe("classifying a fulfillment policy as free", () => {
  it("treats an explicit freeShipping flag as free", () => {
    expect(isFreeShippingPolicy(policy([{ freeShipping: true }]))).toBe(true);
  });

  it("treats a zero shipping cost as free", () => {
    expect(isFreeShippingPolicy(policy([{ shippingCost: { value: "0.0" } }]))).toBe(true);
  });

  it("treats a priced service as not free", () => {
    expect(isFreeShippingPolicy(policy([{ shippingCost: { value: "7.95" } }]))).toBe(false);
  });

  it("is not free when only SOME domestic services are free", () => {
    // A free ground option with a paid expedited upgrade still charges some
    // buyers — calling that policy "free" would mis-select it.
    expect(
      isFreeShippingPolicy(policy([{ freeShipping: true }, { shippingCost: { value: "12.00" } }]))
    ).toBe(false);
  });

  it("ignores international options when judging domestic shipping", () => {
    const p = {
      shippingOptions: [
        { optionType: "DOMESTIC", shippingServices: [{ freeShipping: true }] },
        { optionType: "INTERNATIONAL", shippingServices: [{ shippingCost: { value: "40" } }] },
      ],
    };
    expect(isFreeShippingPolicy(p)).toBe(true);
  });

  it("is not free when there are no services to judge", () => {
    expect(isFreeShippingPolicy({})).toBe(false);
    expect(isFreeShippingPolicy(policy([]))).toBe(false);
  });

  it("treats a calculated-shipping policy as not free", () => {
    expect(isFreeShippingPolicy(policy([{ shippingCost: {} }]))).toBe(false);
  });
});

describe("selecting the policy a listing asked for", () => {
  const setup = (policies: { id: string; name: string; free: boolean }[]): AccountSetup => ({
    fulfillmentPolicyId: policies[0]?.id ?? "",
    fulfillmentPolicies: policies,
    paymentPolicyId: "pay",
    returnPolicyId: "ret",
    locationKey: "loc",
  });

  const both = setup([
    { id: "paid-1", name: "Calculated", free: false },
    { id: "free-1", name: "Free ground", free: true },
  ]);

  it("picks the free policy when the listing asked for free shipping", () => {
    expect(selectFulfillmentPolicy(both, true)).toEqual({ policyId: "free-1" });
  });

  it("picks the paid policy when the listing asked the buyer to pay", () => {
    expect(selectFulfillmentPolicy(both, false)).toEqual({ policyId: "paid-1" });
  });

  it("keeps the old behaviour when the listing has no preference", () => {
    expect(selectFulfillmentPolicy(both, undefined)).toEqual({ policyId: "paid-1" });
  });

  it("warns loudly rather than silently listing under the wrong kind", () => {
    const onlyPaid = setup([{ id: "paid-1", name: "Calculated", free: false }]);
    const result = selectFulfillmentPolicy(onlyPaid, true);
    expect(result.policyId).toBe("paid-1");
    expect(result.warning).toMatch(/free shipping/i);
    expect(result.warning).toMatch(/Business policies/i);
  });

  it("warns the other direction too", () => {
    const onlyFree = setup([{ id: "free-1", name: "Free ground", free: true }]);
    const result = selectFulfillmentPolicy(onlyFree, false);
    expect(result.policyId).toBe("free-1");
    expect(result.warning).toMatch(/buyer-paid/i);
  });

  it("falls back without a warning when the account has no policies at all", () => {
    const none = { ...setup([]), fulfillmentPolicyId: "" };
    expect(selectFulfillmentPolicy(none, true)).toEqual({ policyId: "" });
  });
});
