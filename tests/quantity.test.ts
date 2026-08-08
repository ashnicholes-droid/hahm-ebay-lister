import { describe, expect, it } from "vitest";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_QUANTITY,
  describeVolumeDiscount,
  discountedUnitPrice,
  isMultiQuantity,
  listingQuantity,
  quantityWarnings,
  volumeDiscount,
} from "@/lib/quantity";
import { promotionName } from "@/lib/ebay/promotions";
import { inventoryAvailability, offerQuantityFields } from "@/lib/ebay/publish";
import type { ListingResult } from "@/lib/types";

const L = (over: Partial<ListingResult>) => over as ListingResult;

// The single most important property in this module: a lister full of
// one-of-a-kind items must never publish more than one of anything by accident.
describe("multiples are opt-in", () => {
  it("publishes one when nothing says otherwise", () => {
    expect(listingQuantity(L({}))).toBe(1);
    expect(isMultiQuantity(L({}))).toBe(false);
  });

  it("ignores a quantity that was left behind when the box is unticked", () => {
    // Untick-then-repost must not resurrect a stale 8.
    expect(listingQuantity(L({ multi_quantity: false, quantity: 8 }))).toBe(1);
    expect(listingQuantity(L({ quantity: 8 }))).toBe(1);
  });

  it("uses the quantity once the box is ticked", () => {
    expect(listingQuantity(L({ multi_quantity: true, quantity: 5 }))).toBe(5);
    expect(isMultiQuantity(L({ multi_quantity: true, quantity: 5 }))).toBe(true);
  });

  it("treats a truthy-but-not-true flag as unticked", () => {
    // Guards against a stray string from an import or an older export.
    expect(listingQuantity({ multi_quantity: "yes", quantity: 9 } as unknown as ListingResult)).toBe(1);
  });
});

describe("quantities eBay would reject", () => {
  it("never returns less than one", () => {
    for (const q of [0, -3, "", "abc", null, undefined, NaN]) {
      expect(listingQuantity(L({ multi_quantity: true, quantity: q as never }))).toBe(1);
    }
  });

  it("accepts a numeric string, as the input element produces", () => {
    expect(listingQuantity(L({ multi_quantity: true, quantity: "12" }))).toBe(12);
  });

  it("floors a fractional quantity rather than sending eBay a decimal", () => {
    expect(listingQuantity(L({ multi_quantity: true, quantity: 3.9 }))).toBe(3);
  });

  it("caps a runaway quantity and says so", () => {
    const listing = L({ multi_quantity: true, quantity: 100000 });
    expect(listingQuantity(listing)).toBe(MAX_QUANTITY);
    expect(quantityWarnings(listing).join(" ")).toMatch(/typo/i);
  });

  it("flags ticking the box but leaving the quantity at one", () => {
    expect(quantityWarnings(L({ multi_quantity: true, quantity: 1 })).join(" ")).toMatch(
      /publishes as a single item/i
    );
  });

  it("stays quiet about an ordinary single item", () => {
    expect(quantityWarnings(L({}))).toEqual([]);
    expect(quantityWarnings(L({ multi_quantity: false, quantity: 4 }))).toEqual([]);
  });
});

describe("multi-buy discount", () => {
  it("is absent unless a percentage was set", () => {
    expect(volumeDiscount(L({ multi_quantity: true, quantity: 5 }))).toBeNull();
    expect(
      volumeDiscount(L({ multi_quantity: true, quantity: 5, volume_discount_percent: 0 }))
    ).toBeNull();
    expect(
      volumeDiscount(L({ multi_quantity: true, quantity: 5, volume_discount_percent: "" }))
    ).toBeNull();
  });

  it("defaults the threshold to two", () => {
    const d = volumeDiscount(L({ multi_quantity: true, quantity: 5, volume_discount_percent: 10 }));
    expect(d).toEqual({ minQuantity: 2, percentOff: 10 });
  });

  it("honours a higher threshold the stock can reach", () => {
    const d = volumeDiscount(
      L({ multi_quantity: true, quantity: 6, volume_discount_percent: 15, volume_discount_min: 3 })
    );
    expect(d).toEqual({ minQuantity: 3, percentOff: 15 });
  });

  it("refuses a threshold no buyer could reach, and explains why", () => {
    const listing = L({
      multi_quantity: true,
      quantity: 2,
      volume_discount_percent: 10,
      volume_discount_min: 5,
    });
    expect(volumeDiscount(listing)).toBeNull();
    expect(quantityWarnings(listing).join(" ")).toMatch(/no buyer can reach it/i);
  });

  it("cannot exist on a single item", () => {
    const listing = L({ multi_quantity: true, quantity: 1, volume_discount_percent: 20 });
    expect(volumeDiscount(listing)).toBeNull();
    expect(quantityWarnings(listing).join(" ")).toMatch(/at least 2 in stock/i);
  });

  it("never applies to a listing that isn't marked as multiples", () => {
    expect(volumeDiscount(L({ quantity: 9, volume_discount_percent: 25 }))).toBeNull();
  });

  it("caps an implausible percentage instead of passing it to eBay", () => {
    const listing = L({ multi_quantity: true, quantity: 4, volume_discount_percent: 500 });
    expect(volumeDiscount(listing)!.percentOff).toBe(MAX_DISCOUNT_PERCENT);
    expect(quantityWarnings(listing).join(" ")).toMatch(/decimal point/i);
  });

  it("warns when a threshold was set with no percentage", () => {
    expect(
      quantityWarnings(L({ multi_quantity: true, quantity: 4, volume_discount_min: 3 })).join(" ")
    ).toMatch(/no percentage off/i);
  });

  it("never lets the threshold fall below two", () => {
    const d = volumeDiscount(
      L({ multi_quantity: true, quantity: 5, volume_discount_percent: 10, volume_discount_min: 1 })
    );
    expect(d!.minQuantity).toBe(2);
  });
});

describe("the money a buyer sees", () => {
  it("computes the discounted unit price to the cent", () => {
    expect(discountedUnitPrice(45, { minQuantity: 2, percentOff: 10 })).toBe(40.5);
    expect(discountedUnitPrice(19.99, { minQuantity: 3, percentOff: 15 })).toBe(16.99);
  });

  it("describes a tier in the seller's own terms", () => {
    expect(describeVolumeDiscount({ minQuantity: 3, percentOff: 12 })).toBe(
      "Buy 3 or more, save 12% each"
    );
  });
});

describe("promotion identity", () => {
  // Promotions are reused across listings by name, so identical terms MUST
  // produce an identical name — otherwise a 200-item batch creates 200
  // promotions and hits eBay's cap.
  it("is stable for identical terms", () => {
    expect(promotionName({ minQuantity: 2, percentOff: 10 })).toBe(
      promotionName({ minQuantity: 2, percentOff: 10 })
    );
  });

  it("differs when the terms differ", () => {
    const a = promotionName({ minQuantity: 2, percentOff: 10 });
    expect(a).not.toBe(promotionName({ minQuantity: 3, percentOff: 10 }));
    expect(a).not.toBe(promotionName({ minQuantity: 2, percentOff: 15 }));
  });

  it("stays inside eBay's 90-character name limit", () => {
    expect(promotionName({ minQuantity: 999, percentOff: 80 }).length).toBeLessThanOrEqual(90);
  });
});

// What actually reaches eBay. These two payload fragments are the whole
// difference between "5 available" and overselling or underselling.
describe("the eBay payload", () => {
  it("sends a stock of one and caps it at one per buyer for a unique item", () => {
    expect(offerQuantityFields(L({}))).toEqual({
      availableQuantity: 1,
      quantityLimitPerBuyer: 1,
    });
    expect(inventoryAvailability(L({}))).toEqual({
      shipToLocationAvailability: { quantity: 1 },
    });
  });

  it("lifts the per-buyer cap once there are multiples", () => {
    // Left at 1, a buyer physically cannot take a second unit — which also
    // makes any multi-buy discount unearnable.
    const fields = offerQuantityFields(L({ multi_quantity: true, quantity: 5 }));
    expect(fields).toEqual({ availableQuantity: 5 });
    expect(fields).not.toHaveProperty("quantityLimitPerBuyer");
  });

  it("keeps the offer and the inventory item in agreement", () => {
    for (const q of [1, 2, 40, 5000]) {
      const listing = L({ multi_quantity: true, quantity: q });
      const offer = offerQuantityFields(listing) as { availableQuantity: number };
      const inv = inventoryAvailability(listing) as {
        shipToLocationAvailability: { quantity: number };
      };
      expect(offer.availableQuantity).toBe(inv.shipToLocationAvailability.quantity);
    }
  });

  it("never sends eBay a quantity it would reject", () => {
    for (const q of [0, -1, "", "junk", 1e9]) {
      const f = offerQuantityFields(L({ multi_quantity: true, quantity: q as never })) as {
        availableQuantity: number;
      };
      expect(f.availableQuantity).toBeGreaterThanOrEqual(1);
      expect(f.availableQuantity).toBeLessThanOrEqual(MAX_QUANTITY);
      expect(Number.isInteger(f.availableQuantity)).toBe(true);
    }
  });
});
