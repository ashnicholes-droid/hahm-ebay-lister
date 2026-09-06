import { expect, it } from "vitest";
import { categoryMatches } from "@/lib/category-selection";
import { acceptedPhotoFact } from "@/lib/photo-facts";
import { joinOverlappingGroups } from "@/lib/sortPipeline";
it("rejects a mens T-Shirts leaf for a womens draft despite identical leaf names", () => {
  const l = {
    title: "Character shirt",
    description: "",
    category: "womens_top",
  };
  expect(
    categoryMatches(
      {
        id: "15687",
        name: "T-Shirts",
        path: "Clothing > Men > Men's Clothing > T-Shirts",
      },
      l,
    ),
  ).toBe(false);
  expect(
    categoryMatches(
      {
        id: "63869",
        name: "Tops",
        path: "Clothing > Women > Women's Clothing > Tops",
      },
      l,
    ),
  ).toBe(true);
});
it("does not invent Regular fit from appearance or allowed values", () => {
  expect(
    acceptedPhotoFact(
      {
        name: "Fit",
        value: "Regular",
        basis: "visible_feature",
        quote: "",
        photoIndices: [1],
      },
      2,
    ),
  ).toBe(false);
  expect(
    acceptedPhotoFact(
      {
        name: "Fit",
        value: "Slim",
        basis: "label",
        quote: "SLIM FIT",
        photoIndices: [2],
      },
      2,
    ),
  ).toBe(true);
  expect(
    acceptedPhotoFact(
      {
        name: "Material",
        value: "Cashmere",
        basis: "label",
        quote: "",
        photoIndices: [2],
      },
      2,
    ),
  ).toBe(false);
});
it("joins a final detail across overlapping batch windows without merging different items", () => {
  const out = joinOverlappingGroups([
    { name: "pants", indices: [20, 21, 22, 23, 24] },
    { name: "cardigan", indices: [25, 26, 27, 28, 29] },
    { name: "pants", indices: [24] },
    { name: "knit detail", indices: [25, 26, 27, 28, 29, 30] },
  ]);
  expect(out.map((x) => x.indices)).toEqual([
    [20, 21, 22, 23, 24],
    [25, 26, 27, 28, 29, 30],
  ]);
});

it("preserves distinctive collaboration and fiber search terms", async () => {
  const { buildCompQuery } = await import("@/lib/ebay/comps");
  expect(
    buildCompQuery({
      title: "Collaboration shirt",
      description: "",
      brand: "Example",
      item_type: "Shirt",
      search_terms: ["Trevor Project"],
    }),
  ).toContain("Trevor Project");
  expect(
    buildCompQuery({
      title: "Cardigan",
      description: "",
      brand: "Example",
      item_type: "Cardigan",
      material: "100% Cashmere",
    }),
  ).toContain("100% Cashmere");
});
it("uses GTIN retrieval without requiring a barcode in the seller title", async () => {
  const { vi } = await import("vitest");
  const { searchComps } = await import("@/lib/ebay/comps");
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          itemSummaries: [
            {
              itemId: "gtin-test",
              title: "Example Originals Pants XXL",
              itemWebUrl: "https://www.ebay.com/itm/123",
              price: { value: "40", currency: "USD" },
              conditionId: "3000",
              shippingOptions: [
                { shippingCost: { value: "5", currency: "USD" } },
              ],
            },
          ],
        }),
      );
    }),
  );
  try {
    const r = await searchComps("token", {
      title: "Example pants",
      description: "",
      brand: "Example",
      condition: "GOOD",
      item_specifics: { UPC: "195038240532" },
    });
    expect(new URL(urls[0]).searchParams.get("gtin")).toBe("195038240532");
    expect(r.median).toBe(45);
    expect(r.matchBasis).toBe("GTIN-matched asking prices");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("accepts single-letter size labels but rejects inferred negatives and copyright years", () => {
  const fact = {
    name: "Size",
    value: "M",
    basis: "label",
    quote: "M",
    photoIndices: [1],
  };
  expect(acceptedPhotoFact(fact, 1)).toBe(true);
  expect(
    acceptedPhotoFact(
      { ...fact, name: "Handmade", value: "No", quote: "Machine washable" },
      1,
    ),
  ).toBe(false);
  expect(
    acceptedPhotoFact(
      {
        ...fact,
        name: "Year Manufactured",
        value: "2024",
        quote: "Copyright 2024",
      },
      1,
    ),
  ).toBe(false);
});

it("keeps collaboration and graphic identity without duplicate brand phrases", async () => {
  const { comparisonTerms } = await import("@/lib/ebay/comps");
  expect(
    comparisonTerms({
      title: "Shirt",
      description: "",
      brand: "Abercrombie & Fitch",
      search_terms: ["Abercrombie & Fitch for The Trevor Project"],
    }),
  ).toEqual(["the trevor project"]);
  expect(
    comparisonTerms({
      title: "Shirt",
      description: "",
      brand: "Hello Kitty",
      item_type: "Graphic T-Shirt",
      material: "100% Cotton",
      search_terms: ["Hello Kitty burger"],
    }),
  ).toEqual(["100% Cotton", "burger"]);
});
it("photo-only output cannot claim a new sale condition or tape measurements", async () => {
  const { AI_LISTING_SCHEMA } = await import("@/lib/ai-schema");
  expect(
    AI_LISTING_SCHEMA.properties.condition.enum.some((c) =>
      c.startsWith("NEW"),
    ),
  ).toBe(false);
  expect(AI_LISTING_SCHEMA.properties.measurements.enum).toEqual([""]);
});

it("rejects relaxed-search apparel sizes and possessive false matches", async () => {
  const { matchesApparelSize } = await import("@/lib/ebay/comps");
  const l = {
    title: "Pants",
    description: "",
    category: "mens_bottom",
    size: "XXL",
  };
  expect(matchesApparelSize("Chubbies Mens XXL 30 Inseam", l)).toBe(true);
  expect(matchesApparelSize("Chubbies Extra Extra Large Pants", l)).toBe(true);
  expect(matchesApparelSize("Chubbies Mens Large Pants", l)).toBe(false);
  expect(matchesApparelSize("Chubbies XL Extra Large Pants", l)).toBe(false);
  expect(matchesApparelSize("Men's Shirt", { ...l, size: "S" })).toBe(false);
  expect(matchesApparelSize("Shirt Extra Large", { ...l, size: "L" })).toBe(
    false,
  );
});
