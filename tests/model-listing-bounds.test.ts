import { expect, it } from "vitest";
import { boundModelListing, parseListing } from "@/lib/validation";

it("trims over-long model lists so one extra term doesn't fail the listing", () => {
  const raw = {
    title: "Nike Air Max 90",
    description: "Sneakers",
    search_terms: ["a", "b", "c", "d", "e"],
    seo_keywords: Array.from({ length: 12 }, (_, i) => `k${i}`),
    key_features: ["x"],
  };
  expect(() => parseListing(raw)).toThrow();
  const listing = parseListing(boundModelListing(raw));
  expect(listing.search_terms).toEqual(["a", "b", "c", "d"]);
  expect(listing.seo_keywords).toHaveLength(10);
  expect(listing.key_features).toEqual(["x"]);
  expect(raw.search_terms).toHaveLength(5);
});
