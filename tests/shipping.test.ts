import { afterEach, describe, expect, it } from "vitest";
import { BOXES, CUT_TO_FIT_ID, PADDING_IN, fits, selectBox, volumeIn3 } from "@/lib/shipping/boxes";
import {
  DIM_THRESHOLD_IN3,
  billableOz,
  dimensionalOz,
  parseRateTable,
  rateTable,
  weightBasedRate,
} from "@/lib/shipping/rates";
import {
  DIMENSIONAL_WARNING_PREFIX,
  ebayPackageFromEstimate,
  estimateShipping,
} from "@/lib/shipping/estimate";
import { isFreeShippingPolicy, selectFulfillmentPolicy,
  buildShippingOverride,
  describePolicyCost,
  positiveMoney,
} from "@/lib/ebay/publish";
import { defaultPackageWeightAndSize } from "@/lib/ebay/publish";
import type { AccountSetup } from "@/lib/ebay/publish";
import type { ListingResult } from "@/lib/types";

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
  // Only id/name/free matter to policy SELECTION; the cost fields exist for
  // labelling and for aiming a per-listing override, so they're filled in here
  // rather than made part of every case.
  const setup = (policies: { id: string; name: string; free: boolean }[]): AccountSetup => ({
    fulfillmentPolicyId: policies[0]?.id ?? "",
    fulfillmentPolicies: policies.map((p) => ({
      ...p,
      costType: "unknown" as const,
      flatCost: null,
      domesticPriority: null,
    })),
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

// ── What actually reaches eBay ───────────────────────────────────────────────
//
// This is the regression that mattered most: a seller corrected the weight in
// the UI and the item published with the class-default guess anyway.

describe("edits reaching the published package", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  const weightOf = (pkg: Record<string, any>) => pkg.weight.value;
  const dimsOf = (pkg: Record<string, any>) => [
    pkg.dimensions.length,
    pkg.dimensions.width,
    pkg.dimensions.height,
  ];

  it("uses a hand-entered weight even when no dimensions were given", () => {
    // The exact reported failure: the model returns 0 for dimensions (it is
    // told to rather than invent them), the seller fixes only the weight.
    const pkg = defaultPackageWeightAndSize("kitchenware", {
      shipping_weight_oz: 200,
    } as ListingResult);
    // 200 oz item + box + fill, not the 48 oz kitchenware profile.
    expect(weightOf(pkg)).toBeGreaterThan(200);
  });

  it("uses hand-entered dimensions even when no weight was given", () => {
    const pkg = defaultPackageWeightAndSize("kitchenware", {
      shipping_length_in: 20,
      shipping_width_in: 15,
      shipping_height_in: 3,
    } as ListingResult);
    // A 20-inch item cannot fit the 14×11×6 kitchenware profile box.
    expect(dimsOf(pkg)[0]).toBeGreaterThanOrEqual(20);
  });

  it("honours a single edited dimension instead of discarding all three", () => {
    const pkg = defaultPackageWeightAndSize("book", {
      shipping_length_in: 22,
    } as ListingResult);
    expect(dimsOf(pkg)[0]).toBeGreaterThanOrEqual(22);
  });

  it("falls back to the class profile only when nothing at all was supplied", () => {
    const pkg = defaultPackageWeightAndSize("book", {} as ListingResult);
    const bare = defaultPackageWeightAndSize("book");
    expect(weightOf(pkg)).toBe(weightOf(bare));
  });

  it("lets a per-item edit outrank a deployment-wide env default", () => {
    // A global default is the crudest source available, so it must not beat a
    // figure entered for this specific item.
    process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ = "16";
    const edited = defaultPackageWeightAndSize("book", {
      shipping_weight_oz: 300,
    } as ListingResult);
    expect(weightOf(edited)).toBeGreaterThan(300);
  });

  it("still applies the env default when the item says nothing", () => {
    process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ = "37";
    expect(weightOf(defaultPackageWeightAndSize("book"))).toBe(37);
  });

  it("changing the weight changes what publishes", () => {
    const light = defaultPackageWeightAndSize("kitchenware", {
      shipping_weight_oz: 20, shipping_length_in: 9, shipping_width_in: 7, shipping_height_in: 3,
    } as ListingResult);
    const heavy = defaultPackageWeightAndSize("kitchenware", {
      shipping_weight_oz: 240, shipping_length_in: 9, shipping_width_in: 7, shipping_height_in: 3,
    } as ListingResult);
    expect(weightOf(heavy)).toBeGreaterThan(weightOf(light) + 200);
  });

  it("never publishes a zero or negative weight", () => {
    for (const listing of [
      { shipping_weight_oz: 0 },
      { shipping_weight_oz: -10 },
      { shipping_weight_oz: "" },
    ]) {
      expect(weightOf(defaultPackageWeightAndSize("book", listing as ListingResult))).toBeGreaterThan(0);
    }
  });
});

// Whatever the estimate is costing, the panel has to be able to show it. The
// bug this covers: the seller saw three empty dimension boxes while the quote
// was quietly built on a category guess, so typing one real number composed
// with two invisible ones and usually moved nothing on screen.
describe("what the panel can tell the seller", () => {
  it("reports per-axis which figures are real and which are assumed", () => {
    const e = estimateShipping({ itemOz: 40, itemDims: { l: 12 }, category: "kitchenware" });
    expect(e.provided).toEqual({ weight: true, l: true, w: false, h: false });
  });

  it("marks everything assumed when the photos showed nothing", () => {
    const e = estimateShipping({ category: "book" });
    expect(e.provided).toEqual({ weight: false, l: false, w: false, h: false });
  });

  it("always exposes the figure it used, so a blank field can display it", () => {
    const e = estimateShipping({ itemOz: 40, category: "kitchenware" });
    // The assumed dimensions are the ones the seller never saw.
    expect(e.itemDims.l).toBeGreaterThan(0);
    expect(e.itemDims.w).toBeGreaterThan(0);
    expect(e.itemDims.h).toBeGreaterThan(0);
    expect(e.itemOz).toBe(40);
  });

  it("names the dimensional weight when volume, not the scale, sets the price", () => {
    // A big light box: priced on volume, so weight edits move no number.
    const e = estimateShipping({ itemOz: 8, itemDims: { l: 17, w: 13, h: 9 } });
    expect(e.dimensionalOz).toBeGreaterThan(Math.ceil(e.packedOz));
    expect(e.billableOz).toBe(e.dimensionalOz);
    expect(e.warnings.join(" ")).toMatch(/won't change the cost/i);
  });

  it("reports no dimensional weight when the scale is what's billed", () => {
    const e = estimateShipping({ itemOz: 60, itemDims: { l: 8, w: 6, h: 3 } });
    expect(e.dimensionalOz).toBe(0);
    expect(e.billableOz).toBe(Math.ceil(e.packedOz));
  });

  it("names exactly which figures are still guesses in the warning", () => {
    const e = estimateShipping({ itemOz: 40, itemDims: { l: 12, w: 9 }, category: "kitchenware" });
    const w = e.warnings.join(" ");
    expect(w).toMatch(/height/);
    expect(w).not.toMatch(/weight,/);
  });
});

// USPS flat-rate packaging, and the seller's ability to choose it. Flat rate
// ignores weight entirely, which is exactly why it can't be left to the
// cheapest-wins default: for a small heavy item it wins by a wide margin, and
// for a light one it loses, and only the seller knows which trade they want.
describe("flat-rate containers", () => {
  const envelopeItem = { l: 10, w: 7, h: 0.4 };

  it("offers the flat-rate envelopes for something flat and small", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: envelopeItem });
    const ids = e.options.map((o) => o.boxId);
    expect(ids).toContain("usps-fre");
    expect(ids).toContain("usps-fre-legal");
    expect(ids).toContain("usps-fre-padded");
  });

  it("does not force a carton's packing allowance onto an envelope", () => {
    // With the 1.5" box padding applied to a 0.75" envelope, nothing on earth
    // fits one — which is how they came to be missing in the first place.
    const env = BOXES.find((b) => b.id === "usps-fre")!;
    expect(fits({ l: 10, w: 7, h: 0.4 }, env)).toBe(true);
    expect(fits({ l: 10, w: 7, h: 3 }, env)).toBe(false);
    expect(fits({ l: 14, w: 7, h: 0.2 }, env)).toBe(false);
  });

  it("wins outright for something small and heavy", () => {
    // 4 lb of coins in a padded envelope: flat rate beats every weight break.
    const e = estimateShipping({ itemOz: 64, itemDims: { l: 9, w: 6, h: 0.8 } });
    expect(e.recommended?.flatRate).toBe(true);
    expect(e.recommended?.usd).toBeLessThan(
      e.options.find((o) => !o.flatRate)!.usd
    );
  });

  it("loses for something light, and is still offered", () => {
    const e = estimateShipping({ itemOz: 2, itemDims: { l: 8, w: 5, h: 0.3 } });
    expect(e.recommended?.flatRate).toBe(false);
    expect(e.options.some((o) => o.flatRate)).toBe(true);
  });

  it("never offers an envelope for a thick item", () => {
    const e = estimateShipping({ itemOz: 40, itemDims: { l: 10, w: 8, h: 5 } });
    expect(e.options.filter((o) => o.boxId.startsWith("usps-fre"))).toEqual([]);
  });

  it("prices every flat-rate container it offers", () => {
    const e = estimateShipping({ itemOz: 30, itemDims: { l: 8, w: 5, h: 1 } });
    for (const o of e.options.filter((x) => x.flatRate)) {
      expect(o.usd).toBeGreaterThan(0);
    }
  });
});

describe("choosing the packaging", () => {
  const item = { itemOz: 20, itemDims: { l: 9, w: 6, h: 0.6 } };

  it("takes the cheapest when nothing is chosen", () => {
    const e = estimateShipping(item);
    expect(e.manualSelection).toBe(false);
    expect(e.chosen).toBe(e.recommended);
  });

  it("honours a deliberate pick over the cheapest", () => {
    const auto = estimateShipping(item);
    const padded = auto.options.find((o) => o.boxId === "usps-fre-padded")!;
    const e = estimateShipping({ ...item, selectedOptionId: padded.id });
    expect(e.manualSelection).toBe(true);
    expect(e.chosen!.boxId).toBe("usps-fre-padded");
    // The cheapest is still reported, so the panel can show what it costs.
    expect(e.recommended!.id).toBe(auto.recommended!.id);
  });

  it("prices the item on the chosen option, not the cheapest", () => {
    const auto = estimateShipping(item);
    const dearest = [...auto.options].sort((a, b) => b.usd - a.usd)[0];
    const e = estimateShipping({ ...item, selectedOptionId: dearest.id });
    expect(e.chosen!.usd).toBe(dearest.usd);
    expect(e.chosen!.usd).toBeGreaterThan(e.recommended!.usd);
  });

  it("drops a selection the item no longer fits, and says so", () => {
    const flat = estimateShipping(item);
    const env = flat.options.find((o) => o.boxId === "usps-fre")!;
    // Same pick, but the seller has since corrected the height to 4 inches.
    const e = estimateShipping({
      itemOz: 20,
      itemDims: { l: 9, w: 6, h: 4 },
      selectedOptionId: env.id,
    });
    expect(e.manualSelection).toBe(false);
    expect(e.chosen).toBe(e.recommended);
    expect(e.warnings.join(" ")).toMatch(/no longer fits/i);
  });

  it("ignores an unrecognised option id rather than throwing", () => {
    const e = estimateShipping({ ...item, selectedOptionId: "nonsense:not-a-box" });
    expect(e.chosen).toBe(e.recommended);
  });

  it("describes the package the seller actually chose", () => {
    const auto = estimateShipping(item);
    const padded = auto.options.find((o) => o.boxId === "usps-fre-padded")!;
    const e = estimateShipping({ ...item, selectedOptionId: padded.id });
    expect(e.chosenPackage!.boxId).toBe("usps-fre-padded");
    // The general-carton figures still describe the carton — they drive the
    // weight-based options — but they are no longer what's being mailed.
    expect(e.box!.id).not.toBe("usps-fre-padded");
  });
});

describe("what a chosen flat-rate container publishes", () => {
  const item = { itemOz: 20, itemDims: { l: 9, w: 6, h: 0.6 } };

  it("sends the envelope's size, not the carton's", () => {
    const auto = estimateShipping(item);
    const env = auto.options.find((o) => o.boxId === "usps-fre")!;
    const e = estimateShipping({ ...item, selectedOptionId: env.id });
    const pkg = ebayPackageFromEstimate(e)!;
    expect(pkg.h).toBeLessThan(2);
    expect(pkg.packageType).toBe("USPS_FLAT_RATE_ENVELOPE");
  });

  it("uses the generic package type for ordinary cartons", () => {
    const pkg = ebayPackageFromEstimate(estimateShipping(item))!;
    expect(pkg.packageType).toBeUndefined();
  });

  it("reaches the published payload even with no hand-entered figures", () => {
    // Choosing packaging is itself a decision the publish step must respect;
    // requiring a weight edit alongside it would silently drop the choice.
    const auto = estimateShipping({ category: "media" });
    const flat = auto.options.find((o) => o.flatRate);
    if (!flat) return;
    const pkg = defaultPackageWeightAndSize(
      "media",
      { shipping_option_id: flat.id } as ListingResult
    );
    const h = (pkg.dimensions as { height: number }).height;
    expect(h).toBeLessThan(4);
  });
});

// The reported bug, and the property that prevents its whole class.
//
// A 10×12×4 item at 8 oz was quoted $31.50 because the catalogue jumped from a
// 14×11×6 (too narrow) straight to a 16×12×8, which crosses a cubic foot and so
// gets billed on 169 oz of volume instead of its actual 23 oz. Editing the
// weight moved nothing, because weight wasn't what set the price.
describe("no item pays for a gap in the box catalogue", () => {
  const WALL = 0.5;
  const snugOuterVolume = (d: { l: number; w: number; h: number }) =>
    (d.l + PADDING_IN + WALL) * (d.w + PADDING_IN + WALL) * (d.h + PADDING_IN + WALL);

  it("quotes the reported item sanely", () => {
    const e = estimateShipping({ itemOz: 8, itemDims: { l: 10, w: 12, h: 4 } });
    expect(e.recommended!.usd).toBeLessThan(12);
    expect(e.recommended!.dimensionalPricing).toBe(false);
    expect(e.dimensionalOz).toBe(0);
  });

  it("lets weight drive the price for that item across the whole range", () => {
    const prices = [2, 32, 128, 320].map(
      (oz) => estimateShipping({ itemOz: oz, itemDims: { l: 10, w: 12, h: 4 } }).recommended!.usd
    );
    // Strictly increasing: nothing is pinned by volume.
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThan(prices[i - 1]);
  });

  it("never bills on volume when a box that avoids it would fit", () => {
    // The property, swept over realistic shapes rather than asserted on one.
    const offenders: string[] = [];
    for (let l = 4; l <= 24; l += 1) {
      for (let w = 3; w <= l; w += 1) {
        for (const h of [0.5, 1, 2, 3, 4, 6, 8, 10]) {
          if (h > w) continue;
          const dims = { l, w, h };
          if (snugOuterVolume(dims) > DIM_THRESHOLD_IN3) continue;
          const e = estimateShipping({ itemOz: 8, itemDims: dims });
          if (e.recommended?.dimensionalPricing) offenders.push(`${l}x${w}x${h}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the summary box and the recommended option in agreement", () => {
    for (const dims of [
      { l: 10, w: 12, h: 4 },
      { l: 19, w: 7, h: 5 },
      { l: 6, w: 4, h: 2 },
      { l: 13, w: 10, h: 6 },
    ]) {
      const e = estimateShipping({ itemOz: 10, itemDims: dims });
      // Whatever is in force, the summary describes that container.
      if (e.chosen && !e.chosen.flatRate) expect(e.chosenPackage!.boxId).toBe(e.chosen.boxId);
    }
  });
});

describe("cut-to-fit carton", () => {
  it("rescues a shape no stock size covers", () => {
    // 19×7×5 had nothing between the long boxes (too narrow) and a 24×18×12.
    const e = estimateShipping({ itemOz: 8, itemDims: { l: 19, w: 7, h: 5 } });
    expect(e.recommended!.usd).toBeLessThan(20);
    expect(e.recommended!.dimensionalPricing).toBe(false);
  });

  it("is not offered when cutting a box saves nothing", () => {
    // A small item sits inside a stock box without crossing any weight break,
    // so there is no reason to reach for a knife.
    const e = estimateShipping({ itemOz: 4, itemDims: { l: 5, w: 4, h: 2 } });
    const cut = e.options.filter((o) => o.boxId === CUT_TO_FIT_ID);
    for (const c of cut) {
      const stock = e.options.find((o) => o.serviceId === c.serviceId && o.boxId !== CUT_TO_FIT_ID);
      if (stock) expect(c.usd).toBeLessThan(stock.usd);
    }
  });

  it("follows the item's dimensions rather than being dropped when they change", () => {
    // Its id is stable on purpose: "cut a box to fit" stays true after an edit,
    // where a stock size might genuinely stop fitting.
    const a = estimateShipping({ itemOz: 8, itemDims: { l: 19, w: 7, h: 5 } });
    const picked = a.options.find((o) => o.boxId === CUT_TO_FIT_ID);
    if (!picked) return;
    const b = estimateShipping({
      itemOz: 8,
      itemDims: { l: 21, w: 8, h: 5 },
      selectedOptionId: picked.id,
    });
    expect(b.manualSelection).toBe(true);
    expect(b.chosenPackage!.outer.l).toBeGreaterThan(a.chosenPackage!.outer.l);
    expect(b.warnings.join(" ")).not.toMatch(/no longer fits/i);
  });

  it("refuses to make an unmailable item mailable", () => {
    // USPS caps a parcel at 108 in long and 130 in length plus girth. A knife
    // does not change that.
    const e = estimateShipping({ itemOz: 400, itemDims: { l: 60, w: 40, h: 30 } });
    expect(e.options.some((o) => o.boxId === CUT_TO_FIT_ID)).toBe(false);
  });

  it("publishes the cut box's own size", () => {
    const a = estimateShipping({ itemOz: 8, itemDims: { l: 19, w: 7, h: 5 } });
    const picked = a.options.find((o) => o.boxId === CUT_TO_FIT_ID);
    if (!picked) return;
    const e = estimateShipping({ itemOz: 8, itemDims: { l: 19, w: 7, h: 5 }, selectedOptionId: picked.id });
    const pkg = ebayPackageFromEstimate(e)!;
    expect(pkg.l).toBeLessThan(22);
    expect(pkg.weightOz).toBeGreaterThan(8);
  });
});

describe("the generated carton catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = BOXES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays sorted smallest-volume-first, which selectBox depends on", () => {
    const vols = BOXES.map((b) => volumeIn3(b.inner));
    expect(vols).toEqual([...vols].sort((a, b) => a - b));
  });

  it("gives every carton a believable empty weight", () => {
    for (const b of BOXES) {
      expect(b.emptyOz).toBeGreaterThan(0);
      // Nothing in this catalogue is heavier than the item it usually carries.
      expect(b.emptyOz).toBeLessThan(60);
    }
  });
});

describe("when volume, not weight, sets the price", () => {
  // An 18×10×11 item needs a ~3,100 in³ box. USPS bills that on volume, so the
  // price genuinely cannot move with weight — which reads as a broken input
  // unless the panel says so where the weight is typed.
  const bulky = { l: 18, w: 10, h: 11 };

  it("is correct arithmetic, not a bug", () => {
    const prices = [4, 12, 40, 200].map(
      (oz) => estimateShipping({ itemOz: oz, itemDims: bulky }).recommended!.usd
    );
    expect(new Set(prices).size).toBe(1);
  });

  it("still moves once the weight passes the dimensional weight", () => {
    const light = estimateShipping({ itemOz: 12, itemDims: bulky });
    const heavy = estimateShipping({ itemOz: 400, itemDims: bulky });
    expect(heavy.recommended!.usd).toBeGreaterThan(light.recommended!.usd);
  });

  it("exposes the dimensional weight so the panel can explain the flat price", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: bulky });
    expect(e.dimensionalOz).toBeGreaterThan(Math.ceil(e.chosenPackage!.packedOz));
    expect(e.billableOz).toBe(e.dimensionalOz);
  });

  it("tags the warning so the panel can lift it out of the list", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: bulky });
    const dim = e.warnings.filter((w) => w.startsWith(DIMENSIONAL_WARNING_PREFIX));
    expect(dim).toHaveLength(1);
  });

  it("says nothing of the kind when the scale is what's billed", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 8, w: 6, h: 3 } });
    expect(e.dimensionalOz).toBe(0);
    expect(e.warnings.filter((w) => w.startsWith(DIMENSIONAL_WARNING_PREFIX))).toEqual([]);
  });
});

describe("more than one box to choose from", () => {
  it("offers several stock cartons, not just the single best one", () => {
    // "I don't see box options" — the estimator picking the ideal box is not the
    // same as the seller owning it.
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 18, w: 10, h: 11 } });
    const cartons = new Set(e.options.filter((o) => !o.flatRate).map((o) => o.boxId));
    expect(cartons.size).toBeGreaterThanOrEqual(3);
  });

  it("covers tall items, which had only two boxes in the whole catalogue", () => {
    const fitting = BOXES.filter((b) => !b.flatRate && fits({ l: 18, w: 10, h: 11 }, b));
    expect(fitting.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the list price-sorted and recommends the cheapest suitable option", () => {
    // "Suitable" matters: with no category given, a poly bag is listed but not
    // recommended, so the cheapest row is not always the recommendation.
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 18, w: 10, h: 11 } });
    const costs = e.options.map((o) => o.usd);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    const suitable = e.options.filter((o) => !o.polyBag).map((o) => o.usd);
    expect(e.recommended!.usd).toBe(Math.min(...suitable));
  });
});

// Poly mailers. The point of a bag is that it has no volume of its own — it
// takes the item's shape — so for anything bulky and light it dodges the
// dimensional weight a carton cannot.
describe("poly mailers", () => {
  const jacket = { l: 14, w: 11, h: 4 };

  it("wraps rather than encloses, so width and height are added, not compared", () => {
    const bag = BOXES.find((b) => b.id === "poly-19x14.5")!;
    // 12 + 1 fits the 14.5 flat width...
    expect(fits({ l: 14, w: 8, h: 4 }, bag)).toBe(true);
    // ...but 10 + 6 does not, even though each is under 14.5 on its own.
    expect(fits({ l: 14, w: 10, h: 6 }, bag)).toBe(false);
    // And nothing longer than the bag goes in it.
    expect(fits({ l: 20, w: 4, h: 2 }, bag)).toBe(false);
  });

  it("is priced on the item's own volume, not a carton's", () => {
    const e = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    const bag = e.options.find((o) => o.polyBag)!;
    // Against a real stock carton, not the cut-to-fit box, which can tie.
    const stockBox = e.options.find(
      (o) => !o.polyBag && !o.flatRate && o.boxId !== CUT_TO_FIT_ID
    )!;
    expect(bag.usd).toBeLessThan(stockBox.usd);
  });

  it("saves a bulky light item from dimensional weight entirely", () => {
    // In a carton this jacket crosses a cubic foot and bills at 168 oz.
    const e = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    expect(e.recommended!.polyBag).toBe(true);
    expect(e.recommended!.dimensionalPricing).toBe(false);
  });

  it("adds no void fill, because there is no void", () => {
    const e = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    // Item plus the bag itself, and nothing else.
    expect(e.chosenPackage!.packedOz).toBeLessThan(36);
  });

  it("is never recommended for something fragile", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 18, w: 10, h: 11 }, category: "glassware" });
    expect(e.recommended!.polyBag).toBe(false);
    // But it stays on the list — the seller knows their item.
    expect(e.options.some((o) => o.polyBag)).toBe(true);
  });

  it("explains itself when it declines to recommend the cheapest thing", () => {
    const e = estimateShipping({ itemOz: 12, itemDims: { l: 18, w: 10, h: 11 }, category: "glassware" });
    const cheapest = Math.min(...e.options.map((o) => o.usd));
    expect(e.recommended!.usd).toBeGreaterThan(cheapest);
    expect(e.warnings.join(" ")).toMatch(/no protection/i);
  });

  it("does not crowd the list with bigger bags that cost the same", () => {
    const e = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    const bagIds = new Set(e.options.filter((o) => o.polyBag).map((o) => o.boxId));
    expect(bagIds.size).toBe(1);
  });

  it("keeps a cut-to-fit box on the list even when a bag matches its price", () => {
    // A bag and a box at the same price are not the same offer, and the box is
    // the only right answer for anything that can be crushed.
    const e = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    expect(e.options.some((o) => o.boxId === CUT_TO_FIT_ID)).toBe(true);
  });

  it("publishes the item's own size when a bag is chosen", () => {
    const a = estimateShipping({ itemOz: 32, itemDims: jacket, category: "mens_coat" });
    const bag = a.options.find((o) => o.polyBag)!;
    const e = estimateShipping({
      itemOz: 32,
      itemDims: jacket,
      category: "mens_coat",
      selectedOptionId: bag.id,
    });
    const pkg = ebayPackageFromEstimate(e)!;
    // Close to the jacket, not to a 18x14x6 carton.
    expect(pkg.h).toBeLessThan(6);
    expect(pkg.l).toBeLessThan(16);
  });
});

describe("weight bands — why a size change can move no money", () => {
  // The complaint this answers: "shipping isn't updating costs when I update
  // the size". It was updating; postage is BANDED, so 19.4oz, 24.3oz and
  // 28.3oz all price identically at $9.10. Showing the band turns "it's
  // broken" into "there's headroom", which is also the more useful fact.
  it("prices a whole range of sizes identically, by design", () => {
    const at = (l: number, w: number, h: number) =>
      estimateShipping({ itemOz: 16, itemDims: { l, w, h }, category: "hard_goods" }).chosen?.usd;
    expect(at(6, 4, 2)).toBe(at(10, 8, 4));
    expect(at(10, 8, 4)).toBe(at(14, 10, 6));
  });

  it("reports the band so the flat stretch is explainable", () => {
    const e = estimateShipping({ itemOz: 16, itemDims: { l: 6, w: 4, h: 2 }, category: "hard_goods" });
    const band = e.chosen?.band;
    expect(band).toBeTruthy();
    // Billable is above the band floor and at or below its ceiling.
    expect(e.billableOz).toBeLessThanOrEqual(band!.maxOz);
    expect(band!.headroomOz).toBeCloseTo(band!.maxOz - e.billableOz, 1);
    expect(band!.nextUsd).toBeGreaterThan(e.chosen!.usd);
  });

  it("headroom shrinks as the package gets heavier within one band", () => {
    const light = estimateShipping({ itemOz: 17, itemDims: { l: 6, w: 4, h: 2 }, category: "hard_goods" });
    const heavy = estimateShipping({ itemOz: 26, itemDims: { l: 6, w: 4, h: 2 }, category: "hard_goods" });
    expect(light.chosen?.usd).toBe(heavy.chosen?.usd);
    expect(heavy.chosen!.band!.headroomOz).toBeLessThan(light.chosen!.band!.headroomOz);
  });

  it("carries no band for flat-rate packaging, where weight sets nothing", () => {
    const e = estimateShipping({ itemOz: 40, itemDims: { l: 8, w: 5, h: 1 }, category: "hard_goods" });
    const flat = e.options.find((o) => o.flatRate);
    if (flat) expect(flat.band).toBeNull();
  });
});

describe("reading what a policy actually does", () => {
  // The field that answers "flat or calculated" was being thrown away, leaving
  // a dropdown of names like "1 Day Handling" with no way to tell which one
  // charges a fixed amount. That was the whole complaint.
  const policyWith = (over: Record<string, unknown>) => ({
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [{ sortOrderId: 1, shippingCost: { value: "6.50", currency: "USD" } }],
        ...over,
      },
    ],
  });

  it("reads a flat-rate policy's amount and its service priority", () => {
    const d = describePolicyCost(policyWith({}));
    expect(d).toEqual({ costType: "flat", flatCost: 6.5, domesticPriority: 1 });
  });

  it("reports a calculated policy without inventing a price", () => {
    // A calculated policy quotes at checkout. Reporting its placeholder as the
    // buyer's cost would be a lie the seller would price against.
    const d = describePolicyCost(policyWith({ costType: "CALCULATED" }));
    expect(d.costType).toBe("calculated");
    expect(d.flatCost).toBeNull();
  });

  it("assumes priority 1 when eBay omits the sort order", () => {
    const d = describePolicyCost(policyWith({ shippingServices: [{ shippingCost: { value: "5" } }] }));
    expect(d.domesticPriority).toBe(1);
  });

  it("ignores the international option and reads the domestic one", () => {
    const d = describePolicyCost({
      shippingOptions: [
        { optionType: "INTERNATIONAL", costType: "CALCULATED", shippingServices: [] },
        {
          optionType: "DOMESTIC",
          costType: "FLAT_RATE",
          shippingServices: [{ sortOrderId: 2, shippingCost: { value: "9.99" } }],
        },
      ],
    });
    expect(d).toEqual({ costType: "flat", flatCost: 9.99, domesticPriority: 2 });
  });

  it("says unknown rather than guessing on a policy with no options", () => {
    expect(describePolicyCost({}).costType).toBe("unknown");
  });
});

describe("fixing the postage a buyer is charged, per listing", () => {
  // eBay has no per-listing shipping price. shippingCostOverrides changes the
  // cost of a service in the policy FOR THIS OFFER ONLY, which is what makes
  // one flat-rate policy enough for every price point instead of one per price.
  const flat = {
    id: "p-flat",
    name: "Flat rate",
    free: false,
    costType: "flat" as const,
    flatCost: 6.5,
    domesticPriority: 1,
  };

  it("builds the override eBay expects", () => {
    const r = buildShippingOverride(flat, 12.5, "USD");
    expect(r.overrides).toEqual([
      {
        shippingServiceType: "DOMESTIC",
        priority: 1,
        shippingCost: { value: "12.50", currency: "USD" },
      },
    ]);
    expect(r.warning).toBeUndefined();
  });

  it("sends nothing when no figure was set", () => {
    expect(buildShippingOverride(flat, null, "USD").overrides).toBeNull();
  });

  it("accepts zero, which is a real choice", () => {
    expect(buildShippingOverride(flat, 0, "USD").overrides?.[0].shippingCost.value).toBe("0.00");
  });

  it("refuses a calculated policy, and says why", () => {
    // The override changes an AMOUNT; it can't change how the amount is arrived
    // at. Sending it anyway would leave a seller believing they'd fixed the
    // postage while eBay quotes from the buyer's address.
    const calc = { ...flat, costType: "calculated" as const, flatCost: null };
    const r = buildShippingOverride(calc, 12.5, "USD");
    expect(r.overrides).toBeNull();
    expect(r.warning).toMatch(/calculated rate/i);
    expect(r.warning).toMatch(/FLAT-RATE/);
  });

  it("refuses a free policy rather than contradicting it", () => {
    const r = buildShippingOverride({ ...flat, free: true }, 12.5, "USD");
    expect(r.overrides).toBeNull();
    expect(r.warning).toMatch(/free-shipping policy/i);
  });

  it("refuses when there is no domestic service to attach to", () => {
    const r = buildShippingOverride({ ...flat, domesticPriority: null }, 12.5, "USD");
    expect(r.overrides).toBeNull();
    expect(r.warning).toMatch(/no domestic shipping service/i);
  });

  it("says something when the policy couldn't be read at all", () => {
    // Silence here would look exactly like success.
    const r = buildShippingOverride(undefined, 12.5, "USD");
    expect(r.overrides).toBeNull();
    expect(r.warning).toMatch(/couldn't be read/i);
  });

  it("ignores a nonsense figure instead of sending it", () => {
    for (const bad of [-1, NaN, Infinity]) {
      expect(buildShippingOverride(flat, bad, "USD").overrides).toBeNull();
    }
  });
});

describe("reading a typed money value", () => {
  it("accepts what a number input actually gives you", () => {
    expect(positiveMoney("12.50")).toBe(12.5);
    expect(positiveMoney(12.499)).toBe(12.5);
    expect(positiveMoney(0)).toBe(0);
  });

  it("treats blank and junk as 'not set', not as zero", () => {
    // Zero is a real postage choice; blank is the absence of one, and folding
    // them together would silently charge buyers nothing.
    for (const v of ["", null, undefined, "abc", -5]) {
      expect(positiveMoney(v)).toBeNull();
    }
  });
});
