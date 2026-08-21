import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_LENGTH,
  breakEvenPrice,
  parseNote,
  profitAtPrice,
  validateCost,
  writeCostIntoNote,
} from "@/lib/costBasis";
import { netAtPrice } from "@/lib/fees";

describe("parseNote", () => {
  it("reads a cost token", () => {
    expect(parseNote("[cost 12.50]").cost).toBe(12.5);
  });

  it("returns null rather than 0 when there's no token", () => {
    // The distinction matters: a free item and an unrecorded one are different
    // facts, and showing $0 for the second invents a 100% margin.
    expect(parseNote("just a note").cost).toBeNull();
    expect(parseNote(undefined).cost).toBeNull();
    expect(parseNote("").cost).toBeNull();
  });

  it("keeps surrounding prose and strips only the token", () => {
    const p = parseNote("Goodwill Tuesday [cost 4.00] shelf B");
    expect(p.cost).toBe(4);
    expect(p.text).toBe("Goodwill Tuesday shelf B");
  });

  it("tolerates whole numbers and odd case", () => {
    expect(parseNote("[COST 7]").cost).toBe(7);
  });

  it("ignores a token that isn't a number", () => {
    expect(parseNote("[cost lots]").cost).toBeNull();
    // and leaves it alone rather than silently eating it
    expect(parseNote("[cost lots]").text).toBe("[cost lots]");
  });
});

describe("writeCostIntoNote", () => {
  it("adds a token to an empty note", () => {
    expect(writeCostIntoNote("", 3)).toBe("[cost 3.00]");
  });

  it("replaces an existing token rather than stacking a second one", () => {
    const once = writeCostIntoNote("shelf B [cost 4.00]", 9.99);
    expect(once).toBe("shelf B [cost 9.99]");
    expect(parseNote(once).cost).toBe(9.99);
  });

  it("clearing a cost keeps what the seller typed", () => {
    // The failure this guards against is a price entry silently deleting a note
    // written in Seller Hub.
    expect(writeCostIntoNote("estate sale lot 12 [cost 4.00]", null)).toBe("estate sale lot 12");
  });

  it("round-trips through parseNote", () => {
    const note = writeCostIntoNote("bin 4", 18.25);
    const back = parseNote(note);
    expect(back.cost).toBe(18.25);
    expect(back.text).toBe("bin 4");
  });

  it("stays inside eBay's note cap for ordinary notes", () => {
    expect(writeCostIntoNote("thrift", 12).length).toBeLessThan(MAX_NOTE_LENGTH);
  });
});

describe("validateCost", () => {
  it("treats blank as clearing", () => {
    expect(validateCost("")).toEqual({ cost: null });
    expect(validateCost(null)).toEqual({ cost: null });
    expect(validateCost(undefined)).toEqual({ cost: null });
  });

  it("rounds to cents", () => {
    expect(validateCost("3.999")).toEqual({ cost: 4 });
  });

  it("rejects nonsense with a sentence, not a code", () => {
    expect(validateCost("abc")).toHaveProperty("error");
    expect(validateCost(-1)).toHaveProperty("error");
    expect(validateCost(5_000_000)).toHaveProperty("error");
  });

  it("accepts zero, which is a real cost for a gift or a found item", () => {
    expect(validateCost("0")).toEqual({ cost: 0 });
  });
});

describe("profitAtPrice", () => {
  it("is net minus cost, never price minus cost", () => {
    const price = 50;
    const cost = 20;
    const net = netAtPrice(price, "free");
    const p = profitAtPrice(price, cost, "free");
    expect(p.profit).toBeCloseTo(net.net - cost, 2);
    // and that is meaningfully less than the naive figure
    expect(p.profit).toBeLessThan(price - cost);
  });

  it("charges the fee on the buyer's shipping when they pay it", () => {
    // The part sellers get backwards. Flat $10 postage costs ~$1.33 in extra fee.
    const withShip = profitAtPrice(50, 20, "flat", 10);
    const without = profitAtPrice(50, 20, "free");
    expect(withShip.profit).toBeLessThan(without.profit);
    // ±½c: profit is rounded to whole cents, and 10 × 13.25% is $1.325.
    expect(without.profit - withShip.profit).toBeCloseTo(10 * 0.1325, 1);
  });

  it("says 'loses' and reads negative when underwater", () => {
    const p = profitAtPrice(10, 20, "free");
    expect(p.profit).toBeLessThan(0);
    expect(p.label).toMatch(/^Loses /);
    // The minus sign must survive into the label, or a loss reads as a gain.
    expect(p.label).toContain("−$");
  });

  it("reports margin against the sale price", () => {
    const p = profitAtPrice(100, 50, "unknown");
    expect(p.margin).toBeCloseTo(p.profit / 100, 6);
  });

  it("carries the postage caveat through from netAtPrice", () => {
    expect(profitAtPrice(50, 20, "free").postageExcluded).toBe(true);
    expect(profitAtPrice(50, 20, "calculated").postageExcluded).toBe(false);
  });
});

describe("breakEvenPrice", () => {
  it("actually breaks even when checked against profitAtPrice", () => {
    // Solved algebraically, so verify against the real function rather than
    // trusting the derivation.
    for (const arrangement of ["free", "calculated", "unknown"] as const) {
      const price = breakEvenPrice(25, arrangement);
      expect(profitAtPrice(price, 25, arrangement).profit).toBeCloseTo(0, 1);
    }
  });

  it("accounts for the fee on flat postage", () => {
    const price = breakEvenPrice(25, "flat", 12);
    expect(profitAtPrice(price, 25, "flat", 12).profit).toBeCloseTo(0, 1);
    // and is therefore higher than the same cost with no buyer postage
    expect(price).toBeGreaterThan(breakEvenPrice(25, "free"));
  });

  it("is above cost plus the flat fee — the fee percentage is not free", () => {
    expect(breakEvenPrice(25, "free")).toBeGreaterThan(25.4);
  });
});
