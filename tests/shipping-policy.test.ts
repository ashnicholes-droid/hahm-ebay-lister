import { describe, expect, it } from "vitest";
import {
  KEEP_SHIPPING,
  changesArrangement,
  describeArrangement,
  groupPolicies,
  netUnder,
  validateShippingChoice,
  type ShippingPolicyOption,
} from "@/lib/ebay/shippingPolicy";
import { finalValueFee } from "@/lib/fees";

// Moving a listing between free and buyer-paid postage when it's relisted.
//
// On eBay's Inventory API shipping is a business POLICY the offer points at, not
// a field on the listing — so this is a choice between the policies the seller
// actually created, and the app can't invent one. A free/paid toggle would be a
// lie for a seller with three paid policies at different rates, and would fail
// outright for one with no free policy at all.

const POLICIES: ShippingPolicyOption[] = [
  { id: "p-free", name: "Free shipping", free: true },
  { id: "p-flat", name: "Flat $6.50", free: false },
  { id: "p-calc", name: "Calculated", free: false },
];

describe("presenting the seller's policies", () => {
  it("splits them the way a seller thinks about them", () => {
    const g = groupPolicies(POLICIES);
    expect(g.free.map((p) => p.id)).toEqual(["p-free"]);
    expect(g.buyerPays.map((p) => p.id)).toEqual(["p-flat", "p-calc"]);
  });

  it("copes with an account that has only one kind", () => {
    const g = groupPolicies([POLICIES[1]]);
    expect(g.free).toEqual([]);
    expect(g.buyerPays).toHaveLength(1);
  });
});

describe("saying what the listing does today", () => {
  it("names the arrangement and who pays", () => {
    expect(describeArrangement("free", 0)).toMatch(/you pay the postage/i);
    expect(describeArrangement("flat", 6.5)).toContain("$6.50");
    expect(describeArrangement("calculated", null)).toMatch(/from their address/i);
  });

  it("admits when eBay didn't say, rather than guessing", () => {
    // Telling a seller their buyer pays postage when they actually eat it is
    // worse than saying nothing — the same rule lib/ebay/listings.ts follows.
    expect(describeArrangement("unknown", null)).toMatch(/didn't say/i);
  });

  it("includes the service name when there is one", () => {
    expect(describeArrangement("flat", 6.5, "USPS Ground")).toContain("USPS Ground");
  });
});

describe("whether the change is worth ending a listing for", () => {
  it("says nothing changes when keeping the current policy", () => {
    expect(changesArrangement("free", KEEP_SHIPPING, POLICIES)).toBe(false);
  });

  it("spots a free listing being moved to another free policy", () => {
    // Ending a listing costs its watchers and its search age. Doing that to
    // land on the postage it already had is a bad trade worth reconsidering.
    expect(changesArrangement("free", { kind: "policy", id: "p-free" }, POLICIES)).toBe(false);
  });

  it("spots a real switch in either direction", () => {
    expect(changesArrangement("free", { kind: "policy", id: "p-flat" }, POLICIES)).toBe(true);
    expect(changesArrangement("flat", { kind: "policy", id: "p-free" }, POLICIES)).toBe(true);
  });

  it("treats flat and calculated as the same for the buyer-pays question", () => {
    expect(changesArrangement("flat", { kind: "policy", id: "p-calc" }, POLICIES)).toBe(false);
  });

  it("assumes a change when the current arrangement is unknown", () => {
    // Reassuring someone that nothing will change, on no information, is the
    // wrong way to be wrong here.
    expect(changesArrangement("unknown", { kind: "policy", id: "p-free" }, POLICIES)).toBe(true);
  });
});

describe("validating the choice before anything is ended", () => {
  it("passes a policy the seller actually owns", () => {
    const r = validateShippingChoice({ kind: "policy", id: "p-free" }, POLICIES);
    expect(r.ok).toBe(true);
    expect(r.fulfillmentPolicyId).toBe("p-free");
  });

  it("refuses one that isn't on the account", () => {
    // eBay would reject it too — but by then the listing is already down, which
    // is the worst place for this failure to land.
    const r = validateShippingChoice({ kind: "policy", id: "p-gone" }, POLICIES);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't on your eBay account/i);
  });

  it("sends nothing at all when keeping the current policy", () => {
    const r = validateShippingChoice(KEEP_SHIPPING, POLICIES);
    expect(r.ok).toBe(true);
    expect(r.fulfillmentPolicyId).toBeUndefined();
  });
});

describe("what the change does to your money", () => {
  // The reason anyone opens this. Free postage lowers eBay's fee, because the
  // fee is charged on a smaller order total — but you pay the label, which
  // almost always costs more than the fee saved.
  it("shows free shipping netting less, despite the smaller fee", () => {
    const paid = netUnder(40, false, 8, finalValueFee);
    const free = netUnder(40, true, 8, finalValueFee);
    expect(free.net).toBeLessThan(paid.net!);
    // And the gap is roughly the postage minus the fee saved on it.
    expect(paid.net! - free.net!).toBeCloseTo(8 - 8 * 0.1325, 2);
  });

  it("charges the fee on the postage too when the buyer pays it", () => {
    expect(netUnder(40, false, 8, finalValueFee).net).toBeCloseTo(40 - finalValueFee(48), 2);
  });

  it("takes the postage off the sale price when you absorb it", () => {
    expect(netUnder(40, true, 8, finalValueFee).net).toBeCloseTo(40 - finalValueFee(40) - 8, 2);
  });

  it("refuses to price free shipping when the postage isn't known", () => {
    // The tempting wrong answer reports the fee saving as if it were profit.
    const r = netUnder(40, true, null, finalValueFee);
    expect(r.net).toBeNull();
    expect(r.note).toMatch(/no weight recorded/i);
  });

  it("still answers for buyer-paid with unknown postage, and says what's excluded", () => {
    const r = netUnder(40, false, null, finalValueFee);
    expect(r.net).toBeCloseTo(40 - finalValueFee(40), 2);
    expect(r.note).toMatch(/on top/i);
  });

  it("asks for a price rather than reporting zero", () => {
    for (const p of [0, -5, NaN]) {
      expect(netUnder(p, true, 8, finalValueFee).net).toBeNull();
    }
  });
});
