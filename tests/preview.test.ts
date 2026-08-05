import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AspectMeta } from "@/lib/ebay/taxonomy";
import type { ListingResult } from "@/lib/types";

// The preview's whole value is that it reports what eBay will really do, so the
// taxonomy layer is stubbed rather than the builder — that keeps buildAspects,
// reconcileAspects, enforceCardinality, sanitizeNumericAspects and
// conditionCandidates running for real, exactly as publish.ts runs them.
const taxonomy = vi.hoisted(() => ({
  suggestions: [] as { id: string; name: string }[],
  aspects: [] as AspectMeta[],
  conditionIds: new Set<number>(),
}));

vi.mock("@/lib/ebay/taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ebay/taxonomy")>();
  return {
    ...actual,
    suggestLeafCategories: async () => taxonomy.suggestions,
    categoryAspects: async () => taxonomy.aspects,
    acceptedConditionIds: async () => taxonomy.conditionIds,
  };
});

// publish.ts imports taxonomy by relative path; mock that specifier too so both
// modules see the same stub.
vi.mock("./taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ebay/taxonomy")>();
  return {
    ...actual,
    suggestLeafCategories: async () => taxonomy.suggestions,
    categoryAspects: async () => taxonomy.aspects,
    acceptedConditionIds: async () => taxonomy.conditionIds,
  };
});

const { buildListingPreview } = await import("@/lib/ebay/preview");

// Mirrors how taxonomy.ts builds AspectMeta: `usage` is derived from `required`.
const aspect = (over: Partial<AspectMeta> & { name: string }): AspectMeta => {
  const required = over.usage === "REQUIRED" || over.required === true;
  return {
    mode: "FREE_TEXT",
    cardinality: "SINGLE",
    dataType: "STRING",
    values: [],
    ...over,
    required,
    usage: required ? "REQUIRED" : over.usage ?? "OPTIONAL",
  };
};

const listing: ListingResult = {
  title: "Patagonia Better Sweater Fleece Jacket Mens Medium Gray Full Zip",
  brand: "Patagonia",
  category: "mens_coat",
  size: "M",
  color: "Gray",
  condition: "EXCELLENT",
  condition_notes: "Light pilling at the cuffs.",
  description: "A gray Patagonia fleece jacket in size M.",
  suggested_price: 55,
};

const build = (over: Partial<ListingResult> = {}, photoCount = 4) =>
  buildListingPreview({ sku: "K75-A", listing: { ...listing, ...over }, photoCount });

beforeEach(() => {
  taxonomy.suggestions = [{ id: "57988", name: "Coats & Jackets" }];
  taxonomy.aspects = [
    aspect({ name: "Brand", usage: "REQUIRED" }),
    aspect({ name: "Size", usage: "REQUIRED" }),
    aspect({ name: "Department", usage: "REQUIRED" }),
    aspect({ name: "Color", usage: "RECOMMENDED" }),
  ];
  // eBay's apparel condition policy (2990 = Pre-owned Excellent).
  taxonomy.conditionIds = new Set([1000, 1500, 2990, 3000, 3010]);
});

describe("preview reflects the real publish payload", () => {
  it("uses eBay's live leaf category, not the offline map", async () => {
    const preview = await build();
    expect(preview.categoryId).toBe("57988");
    expect(preview.categoryName).toBe("Coats & Jackets");
    expect(preview.fromLiveTaxonomy).toBe(true);
  });

  it("falls back to the offline map and says so when eBay doesn't answer", async () => {
    taxonomy.suggestions = [];
    taxonomy.aspects = [];
    const preview = await build();
    expect(preview.fromLiveTaxonomy).toBe(false);
    expect(preview.warnings.join(" ")).toMatch(/offline category map/i);
  });

  it("clips the title where eBay clips it, and flags that it did", async () => {
    const long = "A".repeat(95);
    const preview = await build({ title: long });
    expect(preview.title).toHaveLength(80);
    expect(preview.titleClipped).toBe(true);

    const short = await build();
    expect(short.titleClipped).toBe(false);
  });

  it("shows the condition tier eBay will display, not the grade the seller picked", async () => {
    // Apparel has no "Very Good" tier, so eBay renders this as Good — the exact
    // surprise this preview exists to remove.
    const preview = await build({ condition: "VERY_GOOD" });
    expect(preview.conditionEnum).toBe("USED_EXCELLENT");
    expect(preview.conditionLabel).toBe("Pre-owned · Good");
    expect(preview.warnings.join(" ")).toMatch(/will display it as/i);
  });

  it("maps an excellent grade to eBay's apparel tier when the category allows it", async () => {
    const preview = await build();
    expect(preview.conditionEnum).toBe("PRE_OWNED_EXCELLENT");
    expect(preview.conditionLabel).toBe("Pre-owned · Excellent");
  });

  it("lists item specifics built by the publish pipeline, required ones first", async () => {
    const preview = await build();
    const names = preview.specifics.map((s) => s.name);
    expect(names).toContain("Brand");
    expect(names).toContain("Size");
    // Required specifics sort ahead of the rest.
    const firstOptional = preview.specifics.findIndex((s) => !s.required);
    const lastRequired = preview.specifics.map((s) => s.required).lastIndexOf(true);
    expect(lastRequired).toBeLessThan(firstOptional === -1 ? Infinity : firstOptional);
    expect(preview.specifics.find((s) => s.name === "Brand")?.values).toEqual(["Patagonia"]);
  });

  it("names the required specifics eBay wants that the listing can't fill", async () => {
    taxonomy.aspects = [
      aspect({ name: "Brand", usage: "REQUIRED" }),
      aspect({ name: "Character", usage: "REQUIRED" }),
      aspect({ name: "Franchise", usage: "REQUIRED" }),
    ];
    const preview = await build();
    expect(preview.missingRequired).toEqual(["Character", "Franchise"]);
  });

  it("reports a missing price rather than inventing one", async () => {
    const preview = await build({ suggested_price: undefined });
    expect(preview.price).toBeNull();
    expect(preview.warnings.join(" ")).toMatch(/no price/i);
  });

  it("rounds the price the way the publish path does", async () => {
    expect((await build({ suggested_price: "55.556" })).price).toBe(55.56);
  });

  it("caps photos at eBay's limit of 12 and says which ones won't post", async () => {
    const preview = await build({}, 18);
    expect(preview.photoCount).toBe(12);
    expect(preview.warnings.join(" ")).toMatch(/last 6 won't be posted/i);
  });

  it("warns when there are no photos at all", async () => {
    const preview = await build({}, 0);
    expect(preview.warnings.join(" ")).toMatch(/eBay requires at least one/i);
  });

  it("drops a prose value from a NUMBER-typed aspect, as publish does, and reports it", async () => {
    taxonomy.aspects = [aspect({ name: "Fabric Weight", dataType: "NUMBER" })];
    const preview = await build({
      item_specifics: { "Fabric Weight": "Heavyweight" },
    });
    expect(preview.specifics.find((s) => s.name === "Fabric Weight")).toBeUndefined();
    expect(preview.warnings.join(" ")).toMatch(/Fabric Weight/);
  });

  it("carries the SKU and description through unchanged", async () => {
    const preview = await build();
    expect(preview.sku).toBe("K75-A");
    expect(preview.description).toBe(listing.description);
  });
});
