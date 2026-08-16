import { describe, expect, it } from "vitest";
import {
  CONDITION_ENUM_LABELS,
  collectDebug as collectDebugForTest,
  acceptedConditionsFor,
  conditionCandidates,
  conditionOutcome,
  normalizeConditionInput,
} from "@/lib/ebay/publish";

// eBay condition ids used below:
//  1000 New · 1500 New other (open box) · 2000 Certified Refurbished
//  2500 Seller Refurbished · 2750 Like new · 2990 Pre-owned Excellent
//  3000 Used Excellent · 3010 Pre-owned Fair · 5000 Used Good · 7000 For parts
const ids = (...n: number[]) => new Set(n);

describe("grades a seller can now express", () => {
  it("keeps open box distinct from new-without-tags", () => {
    // These collapsed onto the same grade before, losing the distinction on
    // exactly the items that trade on it.
    expect(normalizeConditionInput("OPEN_BOX")).toBe("OPEN_BOX");
    expect(normalizeConditionInput("Open Box")).toBe("OPEN_BOX");
    expect(normalizeConditionInput("NEW_WITHOUT_TAGS")).toBe("NEW_NO_TAGS");
  });

  it("understands the ways people write refurbished", () => {
    for (const word of ["refurbished", "Renewed", "reconditioned", "SELLER REFURBISHED"]) {
      expect(normalizeConditionInput(word)).toBe("SELLER_REFURBISHED");
    }
    expect(normalizeConditionInput("Manufacturer Refurbished")).toBe("CERTIFIED_REFURBISHED");
  });

  it("understands for-parts", () => {
    for (const word of ["for parts", "not working", "PARTS_ONLY", "broken"]) {
      expect(normalizeConditionInput(word)).toBe("FOR_PARTS");
    }
  });

  it("still defaults to Good for anything unrecognised", () => {
    expect(normalizeConditionInput("banana")).toBe("GOOD");
    expect(normalizeConditionInput(undefined)).toBe("GOOD");
  });
});

describe("open box reaches eBay as open box", () => {
  it("sends NEW_OTHER when the category accepts it", () => {
    expect(conditionCandidates("OPEN_BOX", ids(1000, 1500, 3000), "electronics")[0]).toBe(
      "NEW_OTHER"
    );
  });

  it("falls back rather than failing when the category has no open-box tier", () => {
    const got = conditionCandidates("OPEN_BOX", ids(1000, 3000, 5000), "electronics")[0];
    expect(got).toBeTruthy();
    expect(got).not.toBe("NEW_OTHER");
  });
});

describe("refurbished", () => {
  it("reaches Seller Refurbished when the category allows it", () => {
    expect(conditionCandidates("SELLER_REFURBISHED", ids(1000, 2500, 3000), "electronics")[0]).toBe(
      "SELLER_REFURBISHED"
    );
  });

  it("prefers Certified when asked for it and the category allows it", () => {
    expect(
      conditionCandidates("CERTIFIED_REFURBISHED", ids(1000, 2000, 2500, 3000), "electronics")[0]
    ).toBe("CERTIFIED_REFURBISHED");
  });

  it("is never reached by accident for an ordinary used item", () => {
    // The catch-all sweep over everything a category accepts must not land a
    // plain used item on a refurbished tier — that advertises a repair that
    // never happened.
    for (const grade of ["GOOD", "EXCELLENT", "VERY_GOOD", "FAIR", "NEW_WITH_TAGS"]) {
      const got = conditionCandidates(grade, ids(1000, 2000, 2500, 3000, 5000), "electronics");
      expect(got).not.toContain("SELLER_REFURBISHED");
      expect(got).not.toContain("CERTIFIED_REFURBISHED");
    }
  });

  it("does not send a refurbished id to an apparel category", () => {
    // Apparel has no refurbished tier at all.
    const got = conditionCandidates("SELLER_REFURBISHED", ids(1000, 1500, 2990, 3000, 3010), "womens_coat");
    expect(got[0]).toBe("NEW_OTHER");
  });
});

describe("what the category will accept", () => {
  it("lists conditions with eBay's own wording", () => {
    const allowed = acceptedConditionsFor(ids(1000, 1500, 2500, 3000));
    expect(allowed.map((c) => c.enumValue)).toEqual([
      "NEW",
      "NEW_OTHER",
      "SELLER_REFURBISHED",
      "USED_EXCELLENT",
    ]);
    expect(allowed[1].label).toBe("New (open box)");
  });

  it("flags the tiers eBay gates behind approval", () => {
    const allowed = acceptedConditionsFor(ids(2000, 2500, 3000));
    expect(allowed.find((c) => c.enumValue === "CERTIFIED_REFURBISHED")!.approvalOnly).toBe(true);
    expect(allowed.find((c) => c.enumValue === "SELLER_REFURBISHED")!.approvalOnly).toBe(false);
  });

  it("ignores ids it has no enum for rather than inventing one", () => {
    expect(acceptedConditionsFor(ids(1000, 99999)).map((c) => c.id)).toEqual([1000]);
  });

  it("says nothing when eBay's metadata was unreachable", () => {
    expect(acceptedConditionsFor(new Set())).toEqual([]);
  });
});

describe("telling the seller when a grade won't survive", () => {
  it("reports no downgrade when the category takes what was asked", () => {
    const out = conditionOutcome("OPEN_BOX", ids(1000, 1500, 3000), "electronics");
    expect(out.enumValue).toBe("NEW_OTHER");
    expect(out.downgraded).toBe(false);
  });

  it("reports a downgrade when it doesn't", () => {
    const out = conditionOutcome("OPEN_BOX", ids(3000, 5000), "electronics");
    expect(out.downgraded).toBe(true);
    expect(out.label).toBeTruthy();
  });

  it("always names a buyer-facing label for what will publish", () => {
    for (const grade of ["OPEN_BOX", "SELLER_REFURBISHED", "GOOD", "FOR_PARTS"]) {
      const out = conditionOutcome(grade, ids(1000, 1500, 2500, 3000, 5000, 7000), "electronics");
      expect(CONDITION_ENUM_LABELS[out.enumValue]).toBeTruthy();
      expect(out.label).toBe(CONDITION_ENUM_LABELS[out.enumValue]);
    }
  });
});

// The debug payload behind "Show eBay's full response". Its whole job is to
// carry the parts of eBay's reply the one-line error throws away — and to carry
// nothing that shouldn't leave the server.
describe("eBay error detail", () => {
  const resp = (json: unknown, status = 400, text = "") =>
    ({ ok: false, status, json, text } as never);

  it("keeps every error, not just the first", () => {
    const d = collectDebugForTest("offer creation", "K1", resp({
      errors: [
        { errorId: 25002, message: "a" },
        { errorId: 25007, message: "b" },
      ],
    }));
    expect(d.errors.map((e) => e.errorId)).toEqual([25002, 25007]);
  });

  it("keeps longMessage and parameters, which name the actual problem", () => {
    const d = collectDebugForTest("inventory item", "K1", resp({
      errors: [
        {
          errorId: 25021,
          message: "Invalid condition",
          longMessage: "The condition is not valid for this category.",
          parameters: [{ name: "conditionIds", value: "1000,1500,2500" }],
        },
      ],
    }));
    expect(d.errors[0].longMessage).toMatch(/not valid for this category/);
    expect(d.errors[0].parameters).toEqual([{ name: "conditionIds", value: "1000,1500,2500" }]);
  });

  it("records what was sent, so the reply can be read against it", () => {
    const d = collectDebugForTest("inventory item", "K1", resp({ errors: [] }), {
      conditionSent: "SELLER_REFURBISHED",
      categoryId: "175672",
    });
    expect(d.conditionSent).toBe("SELLER_REFURBISHED");
    expect(d.categoryId).toBe("175672");
  });

  it("falls back to the raw body when eBay sent something unparseable", () => {
    const d = collectDebugForTest("publish", "K1", resp(null, 502, "<html>Bad Gateway</html>"));
    expect(d.raw).toContain("Bad Gateway");
  });

  it("bounds what it carries so a huge reply can't bloat the response", () => {
    const d = collectDebugForTest("publish", "K1", resp({
      errors: Array.from({ length: 50 }, (_, i) => ({
        errorId: i,
        longMessage: "x".repeat(5000),
      })),
    }));
    expect(d.errors.length).toBeLessThanOrEqual(10);
    expect(d.errors[0].longMessage!.length).toBeLessThanOrEqual(600);
  });
});
