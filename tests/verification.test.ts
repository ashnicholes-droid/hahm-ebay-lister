import { describe, expect, it } from "vitest";
import {
  buildReport,
  reportStatus,
  runRuleChecks,
  verdictsFromClaims,
  type PhotoClaim,
  type Verdict,
} from "@/lib/verification";
import type { CompsSummary, ListingResult } from "@/lib/types";

const base: ListingResult = {
  title: "Patagonia Better Sweater Fleece Jacket Mens Medium Gray Full Zip",
  brand: "Patagonia",
  category: "mens_coat",
  size: "M",
  condition: "EXCELLENT",
  condition_notes: "Light pilling at the cuffs, no holes or stains.",
  description:
    "Patagonia Better Sweater fleece jacket in gray, size M. Full zip with two hand pockets. Light pilling at the cuffs.",
  suggested_price: 55,
};

const comps = (over: Partial<CompsSummary> = {}): CompsSummary => ({
  ok: true,
  query: "patagonia better sweater",
  count: 24,
  median: 60,
  low: 40,
  high: 95,
  confidence: 0.8,
  basis: "active listings",
  ...over,
});

const find = (verdicts: Verdict[], field: Verdict["field"]) =>
  verdicts.filter((v) => v.field === field);
const has = (verdicts: Verdict[], field: Verdict["field"], status: Verdict["status"]) =>
  find(verdicts, field).some((v) => v.status === status);

describe("rule checks — a clean listing", () => {
  it("raises no failures on a well-formed listing with supporting comps", () => {
    const verdicts = runRuleChecks(base, comps());
    expect(verdicts.filter((v) => v.status === "fail")).toEqual([]);
    expect(has(verdicts, "price", "ok")).toBe(true);
  });

  it("marks everything as rule-sourced — rules never claim photo evidence", () => {
    expect(runRuleChecks(base, comps()).every((v) => v.source === "rule")).toBe(true);
  });
});

describe("rule checks — title", () => {
  it("fails a title past eBay's 80-character cap", () => {
    const verdicts = runRuleChecks({ ...base, title: "x".repeat(81) }, comps());
    expect(has(verdicts, "title", "fail")).toBe(true);
  });

  it("warns when the brand field never made it into the title", () => {
    const verdicts = runRuleChecks(
      { ...base, title: "Mens Fleece Jacket Medium Gray Full Zip Warm" },
      comps()
    );
    expect(has(verdicts, "title", "warn")).toBe(true);
  });

  it("does not warn about brand when the brand is explicitly unbranded", () => {
    const verdicts = runRuleChecks(
      { ...base, brand: "Unbranded", title: "Mens Fleece Jacket Medium Gray Full Zip Warm Cozy" },
      comps()
    );
    expect(find(verdicts, "title")).toEqual([]);
  });

  it("flags unprovable authenticity language", () => {
    const verdicts = runRuleChecks(
      { ...base, title: "Authentic Patagonia Better Sweater Fleece Jacket Mens M Gray" },
      comps()
    );
    expect(
      find(verdicts, "title").some((v) => v.message.toLowerCase().includes("authentic"))
    ).toBe(true);
  });
});

describe("rule checks — price", () => {
  it("fails a missing or zero price", () => {
    expect(has(runRuleChecks({ ...base, suggested_price: undefined }, comps()), "price", "fail")).toBe(true);
    expect(has(runRuleChecks({ ...base, suggested_price: 0 }, comps()), "price", "fail")).toBe(true);
    expect(has(runRuleChecks({ ...base, suggested_price: "" }, comps()), "price", "fail")).toBe(true);
  });

  it("accepts a numeric string price", () => {
    expect(has(runRuleChecks({ ...base, suggested_price: "55" }, comps()), "price", "ok")).toBe(true);
  });

  it("warns when the price is far above the market median", () => {
    const verdicts = runRuleChecks({ ...base, suggested_price: 400 }, comps());
    expect(has(verdicts, "price", "warn")).toBe(true);
  });

  it("warns when the price is far below the market median", () => {
    const verdicts = runRuleChecks({ ...base, suggested_price: 10 }, comps());
    expect(has(verdicts, "price", "warn")).toBe(true);
  });

  it("says so when there is no market data to check against", () => {
    expect(has(runRuleChecks(base, undefined), "price", "warn")).toBe(true);
    expect(has(runRuleChecks(base, comps({ count: 1 })), "price", "warn")).toBe(true);
  });
});

describe("rule checks — condition", () => {
  it("fails a 'new' grade whose own text describes damage", () => {
    const verdicts = runRuleChecks(
      { ...base, condition: "NEW_WITH_TAGS", condition_notes: "Small stain on the left sleeve." },
      comps()
    );
    expect(has(verdicts, "condition", "fail")).toBe(true);
  });

  it("warns when a pre-owned item ships with no condition notes", () => {
    const verdicts = runRuleChecks({ ...base, condition_notes: "" }, comps());
    expect(has(verdicts, "condition", "warn")).toBe(true);
  });

  it("does not demand condition notes on a new item", () => {
    const verdicts = runRuleChecks(
      {
        ...base,
        condition: "NEW_WITH_TAGS",
        condition_notes: "",
        description: "Brand new with tags attached.",
      },
      comps()
    );
    expect(has(verdicts, "condition", "warn")).toBe(false);
  });
});

describe("rule checks — size", () => {
  it("fails apparel with no size", () => {
    const verdicts = runRuleChecks({ ...base, size: "" }, comps());
    expect(has(verdicts, "size", "fail")).toBe(true);
  });

  it("warns when the size appears nowhere in the listing prose", () => {
    const verdicts = runRuleChecks(
      { ...base, size: "XXL", title: "Patagonia Fleece Jacket Gray Full Zip", description: "A jacket." },
      comps()
    );
    expect(has(verdicts, "size", "warn")).toBe(true);
  });

  it("does not require a size outside apparel categories", () => {
    const verdicts = runRuleChecks(
      { ...base, category: "electronics", size: "", title: "Sony Walkman Portable Cassette Player" },
      comps()
    );
    expect(find(verdicts, "size")).toEqual([]);
  });
});

describe("rule checks — description and specifics", () => {
  it("warns when the description just points at the photos", () => {
    const verdicts = runRuleChecks({ ...base, description: "See photos for details." }, comps());
    expect(has(verdicts, "description", "warn")).toBe(true);
  });

  it("warns when most item specifics are unsupported by the rest of the listing", () => {
    const verdicts = runRuleChecks(
      {
        ...base,
        item_specifics: {
          Fit: "Slim",
          Closure: "Snap Button",
          Lining: "Sherpa",
          Occasion: "Formal",
          Pattern: "Houndstooth",
        },
      },
      comps()
    );
    expect(has(verdicts, "specifics", "warn")).toBe(true);
  });

  it("stays quiet when the specifics echo what the listing already says", () => {
    const verdicts = runRuleChecks(
      { ...base, item_specifics: { Brand: "Patagonia", Size: "M", Color: "Gray" } },
      comps()
    );
    expect(find(verdicts, "specifics")).toEqual([]);
  });

  it("returns nothing at all for a listing that hasn't been written yet", () => {
    expect(runRuleChecks(undefined, comps())).toEqual([]);
  });
});

describe("photo-grounding claims", () => {
  const claims: PhotoClaim[] = [
    { field: "brand", claim: "Patagonia", status: "supported" },
    { field: "size", claim: "Size M", status: "not_visible", note: "no tag photographed" },
    {
      field: "condition",
      claim: "no holes or stains",
      status: "contradicted",
      note: "dark mark on right cuff",
    },
  ];

  it("reports only the claims the photos failed to support", () => {
    const verdicts = verdictsFromClaims(claims);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((v) => v.source === "photo")).toBe(true);
  });

  it("treats a contradiction as blocking and a gap as a warning", () => {
    const verdicts = verdictsFromClaims(claims);
    expect(verdicts.find((v) => v.field === "condition")?.status).toBe("fail");
    expect(verdicts.find((v) => v.field === "size")?.status).toBe("warn");
  });

  it("carries the model's note into the message so it's actionable", () => {
    const message = verdictsFromClaims(claims).find((v) => v.field === "condition")!.message;
    expect(message).toContain("dark mark on right cuff");
  });
});

describe("report assembly", () => {
  it("blocks on any failure and marks whether the photo pass has run", () => {
    const failing = buildReport(runRuleChecks({ ...base, size: "" }, comps()));
    expect(failing.blocking).toBe(true);
    expect(failing.photoChecked).toBe(false);

    const clean = buildReport(runRuleChecks(base, comps()), [], true);
    expect(clean.blocking).toBe(false);
    expect(clean.photoChecked).toBe(true);
  });

  it("summarises to the worst status present", () => {
    expect(reportStatus(undefined)).toBe("unchecked");
    expect(reportStatus(buildReport([]))).toBe("ok");
    expect(reportStatus(buildReport(runRuleChecks(base, undefined)))).toBe("warn");
    expect(reportStatus(buildReport(runRuleChecks({ ...base, size: "" }, comps())))).toBe("fail");
  });
});
