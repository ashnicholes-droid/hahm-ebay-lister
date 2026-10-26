import { expect, it } from "vitest";
import { reconcileAspects } from "@/lib/ebay/publish";
import { parseUsShoeSize, syncShoeSizeSpecifics } from "@/lib/ebay/shoe-size";
import type { AspectMeta } from "@/lib/ebay/taxonomy";

const sel = (name: string, values: string[]): AspectMeta =>
  ({ name, required: true, usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", values }) as AspectMeta;
const SIZES = ["4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "9", "10", "10.5"];
const meta = [
  sel("US Shoe Size", SIZES),
  sel("Shoe Width", ["Narrow", "Medium", "Wide", "Extra Wide"]),
  sel("Department", ["Women", "Men"]),
];
const run = (size: string, category = "womens_shoes", extra: Record<string, string[]> = {}) => {
  const aspects: Record<string, string[]> = { Size: [size], ...extra };
  reconcileAspects(aspects, meta, { title: "", description: "", size, category } as any, category);
  return aspects;
};

it("copies a printed size with a width letter into US Shoe Size and Shoe Width", () => {
  const a = run("7.5 M");
  expect(a["US Shoe Size"]).toEqual(["7.5"]);
  expect(a["Shoe Width"]).toEqual(["Medium"]);
});

it("reads US-prefixed and department-prefixed sizes", () => {
  expect(run("W US 6.5")["US Shoe Size"]).toEqual(["6.5"]);
  expect(run("US 10.5 D", "mens_shoes")["US Shoe Size"]).toEqual(["10.5"]);
  expect(run("US 10.5 D", "mens_shoes")["Shoe Width"]).toEqual(["Medium"]);
  expect(run("8W")["Shoe Width"]).toEqual(["Wide"]);
});

it("picks the size for the item's department from a unisex label", () => {
  expect(run("M US 5 / W US 6.5")["US Shoe Size"]).toEqual(["6.5"]);
  expect(run("M US 5 / W US 6.5", "mens_shoes")["US Shoe Size"]).toEqual(["5"]);
});

it("never overwrites a seller value or invents a size eBay does not accept", () => {
  expect(run("7.5 M", "womens_shoes", { "US Shoe Size": ["8"] })["US Shoe Size"]).toEqual(["8"]);
  expect(run("See photos")["US Shoe Size"]).toBeUndefined();
  expect(run("")["US Shoe Size"]).toBeUndefined();
});

it("reads department words written after US (\"US Men 4.5 / Women 6\")", () => {
  expect(run("US Men 4.5 / Women 6", "mens_shoes")["US Shoe Size"]).toEqual(["4.5"]);
  expect(run("US Men 4.5 / Women 6", "womens_shoes")["US Shoe Size"]).toEqual(["6"]);
  expect(run("US M 4.5 / W 6", "mens_shoes")["US Shoe Size"]).toEqual(["4.5"]);
  expect(run("Men's US 10", "mens_shoes")["US Shoe Size"]).toEqual(["10"]);
});

it("converts an EU-only size to US for the item's department", () => {
  expect(run("EU 38")["US Shoe Size"]).toEqual(["7"]);
  expect(run("EU 44", "mens_shoes")["US Shoe Size"]).toEqual(["10"]);
  expect(run("EUR 42.5", "mens_shoes")["US Shoe Size"]).toEqual(["9"]);
});

it("converts a UK-only size, and prefers a printed US size over any conversion", () => {
  expect(run("UK 9", "mens_shoes")["US Shoe Size"]).toEqual(["10"]);
  expect(run("UK 5")["US Shoe Size"]).toEqual(["7"]);
  expect(run("UK 9 / EU 44 / US 9.5", "mens_shoes")["US Shoe Size"]).toBeUndefined(); // 9.5 not in this test's allowed list
  expect(run("EU 44 / US 10.5", "mens_shoes")["US Shoe Size"]).toEqual(["10.5"]);
});

it("does not convert when the department is unknown", () => {
  expect(parseUsShoeSize("EU 40", "")).toBeNull();
  expect(parseUsShoeSize("EU 40", "men")).toEqual({ size: "7", width: "" });
});

it("updates US Shoe Size and Shoe Width when the seller edits the size", () => {
  const listing = {
    size: "EU 44",
    category: "mens_shoes",
    item_specifics: { "US Shoe Size": "9", "Shoe Width": "Wide", Brand: "Nike" },
  };
  expect(syncShoeSizeSpecifics(listing, meta)).toEqual({
    "US Shoe Size": "10",
    "Shoe Width": "Wide",
    Brand: "Nike",
  });
  expect(syncShoeSizeSpecifics({ ...listing, size: "10.5 D" }, meta)).toMatchObject({
    "US Shoe Size": "10.5",
    "Shoe Width": "Medium",
  });
  // Unreadable sizes leave the existing specifics alone.
  expect(syncShoeSizeSpecifics({ ...listing, size: "see photos" }, meta)).toBe(listing.item_specifics);
});
