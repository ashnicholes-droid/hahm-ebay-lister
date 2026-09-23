import { expect, it } from "vitest";
import { reconcileAspects } from "@/lib/ebay/publish";
import type { AspectMeta } from "@/lib/ebay/taxonomy";

const sel = (name: string, values: string[]): AspectMeta =>
  ({ name, required: true, usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", values }) as AspectMeta;
const SIZES = ["5", "5.5", "6", "6.5", "7", "7.5", "8", "10.5"];
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
  expect(run("EU 38")["US Shoe Size"]).toBeUndefined();
  expect(run("See photos")["US Shoe Size"]).toBeUndefined();
  expect(run("")["US Shoe Size"]).toBeUndefined();
});
