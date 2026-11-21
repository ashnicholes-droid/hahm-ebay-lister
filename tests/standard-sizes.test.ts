import { expect, it } from "vitest";
import { snapStandardSize, snapStandardSizes } from "@/lib/ebay/aspects";
import { validateAspects } from "@/lib/ebay/draft";
import type { AspectMeta } from "@/lib/ebay/taxonomy";

// eBay lists these as FREE_TEXT but rejects custom values at publish (25129).
const free = (name: string, values: string[], required = false): AspectMeta =>
  ({
    name,
    required,
    usage: required ? "REQUIRED" : "OPTIONAL",
    mode: "FREE_TEXT",
    cardinality: "SINGLE",
    values,
  }) as AspectMeta;
const UK = ["4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5"];
const EU = ["37", "38", "39", "40"];

it("snaps printed size labels onto eBay's standard values", () => {
  expect(snapStandardSize("UK 7", UK)).toBe("7");
  expect(snapStandardSize("uk6.5", UK)).toBe("6.5");
  expect(snapStandardSize("6 1/2", UK)).toBe("6.5");
  expect(snapStandardSize("7.0", UK)).toBe("7");
  expect(snapStandardSize("Women's UK 5", UK)).toBe("5");
  expect(snapStandardSize("EU 38", EU)).toBe("38");
  expect(snapStandardSize("UK 12", UK)).toBeNull();
});

it("drops an optional size eBay won't accept, keeps a required one for review", () => {
  const meta = [free("UK Shoe Size", UK), free("US Shoe Size", ["8", "8.5"], true)];
  const aspects = { "UK Shoe Size": ["UK 12"], "US Shoe Size": ["13 M"] };
  expect(snapStandardSizes(aspects, meta)).toEqual(["UK Shoe Size"]);
  expect(aspects).toEqual({ "US Shoe Size": ["13 M"] });
  expect(validateAspects(aspects, meta)).toContain(
    "Choose an allowed value for US Shoe Size",
  );
});

it("rewrites a mappable size to the standard value", () => {
  const meta = [free("UK Shoe Size", UK)];
  const aspects = { "UK Shoe Size": ["UK 6.5"] };
  snapStandardSizes(aspects, meta);
  expect(aspects).toEqual({ "UK Shoe Size": ["6.5"] });
  expect(validateAspects(aspects, meta)).toEqual([]);
});

it("leaves size aspects without a value list alone", () => {
  const meta = [free("UK Shoe Size", [])];
  const aspects = { "UK Shoe Size": ["UK 6.5"] };
  expect(snapStandardSizes(aspects, meta)).toEqual([]);
  expect(validateAspects(aspects, meta)).toEqual([]);
});

// Apparel "Size" is locked the same way (25129: "…custom values for Size").
const LETTERS = ["XS", "S", "M", "L", "XL", "2XL"];
const NUMS = ["4", "6", "8", "10", "12"];

it("reduces a multi-system clothing size to eBay's single standard value", () => {
  expect(snapStandardSize("US M / UK M / EU M", LETTERS)).toBe("M");
  expect(snapStandardSize("US M", LETTERS)).toBe("M");
  expect(snapStandardSize("Medium", LETTERS)).toBe("M");
  expect(snapStandardSize("Women's XXL", LETTERS)).toBe("2XL");
  expect(snapStandardSize("M", ["Small", "Medium", "Large"])).toBe("Medium");
  expect(snapStandardSize("US 8 / UK 12 / EU 40", NUMS)).toBe("8");
  // Another system's number is never passed off as the US size.
  expect(snapStandardSize("UK 12 / EU 40", NUMS)).toBeNull();
  expect(snapStandardSize("UK M / EU M", LETTERS)).toBe("M");
  expect(snapStandardSize("US 9 / UK 7 / EU 40", UK, "UK")).toBe("7");
});

it("treats plain Size as selection-only when eBay supplies a value list", () => {
  const meta = [free("Size", LETTERS, true)];
  const aspects = { Size: ["US M / UK M / EU M"] };
  expect(snapStandardSizes(aspects, meta)).toEqual([]);
  expect(aspects).toEqual({ Size: ["M"] });
  expect(validateAspects(aspects, meta)).toEqual([]);
  const odd = { Size: ["Fits like a 10"] };
  snapStandardSizes(odd, meta);
  expect(validateAspects(odd, meta)).toContain("Choose an allowed value for Size");
});

// ── Audit hardening: the ways a size label is actually written ──────────────
const WOMEN = [
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "1X", "2X", "3X",
  "0", "2", "4", "6", "8", "10", "12", "14", "16",
  "14W", "16W", "18W", "0P", "2P", "4P", "6P", "8P", "One Size",
];
const MEN_PANTS = ["28", "29", "30", "31", "32", "33", "34", "36", "38", "40", "S", "M", "L", "XL", "2XL"];
const KIDS = [
  "2T", "3T", "4T", "4", "5", "6", "7", "8", "10", "12", "14", "16",
  "XS", "S", "M", "L", "XL", "10-12", "14-16", "7-8",
  "0-3 Months", "3-6 Months", "6-12 Months", "12 Months", "18 Months", "24 Months",
];
const SHOE = ["5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "12", "13"];

it.each([
  ["Size M", "M"], ["M (8-10)", "M"], ["Ladies L", "L"], ["Womens M", "M"],
  ["L/G", "L"], ["S/P", "S"], ["XL/TG", "XL"], ["Plus 2X", "2X"], ["16W", "16W"],
  ["8P", "8P"], ["8 Petite", "8P"], ["Petite M", "M"], ["PM", "M"],
  ["Size 8", "8"], ["US 8", "8"], ["08", "8"], ["OSFM", "One Size"],
  ["LT", "L"], ["Large Tall", "L"], ["Small Petite", "S"], ["XXL", "2XL"],
])("women's clothing %s → %s", (label, want) => {
  expect(snapStandardSize(label, WOMEN)).toBe(want);
});

it.each(["S/M", "M/L", "8/10", "EU 38", "IT 42", "38", "Fits like a 10"])(
  "leaves %s for the seller instead of guessing",
  (label) => {
    expect(snapStandardSize(label, WOMEN)).toBeNull();
  },
);

it.each([
  ["32x30", "32"], ["32 x 30", "32"], ["W32 L30", "32"], ["32W 30L", "32"],
  ["32/30", "32"], ["Waist 32", "32"], ["XL Tall", "XL"],
])("men's pants %s → %s", (label, want) => {
  expect(snapStandardSize(label, MEN_PANTS)).toBe(want);
});

it.each([
  ["10/12", "10-12"], ["M (10-12)", "M"], ["Youth L", "L"], ["YL", "L"],
  ["Youth Large", "L"], ["Size 6", "6"], ["3-6M", "3-6 Months"],
  ["12M", "12 Months"], ["18 mo", "18 Months"], ["Kids M", "M"],
  ["Boys 8", "8"], ["Girls 10", "10"], ["4T", "4T"],
])("kids %s → %s", (label, want) => {
  expect(snapStandardSize(label, KIDS)).toBe(want);
});

it.each([
  ["8 M", "8"], ["8.5 B", "8.5"], ["8M", "8"], ["8.5W", "8.5"], ["Size 9", "9"],
  ["9.5 Wide", "9.5"], ["US M 10 D / UK 9 / EU 44", "10"], ["9 1/2", "9.5"],
])("US shoe size %s → %s", (label, want) => {
  const meta = [free("US Shoe Size", SHOE, true)];
  const aspects = { "US Shoe Size": [label] };
  snapStandardSizes(aspects, meta);
  expect(aspects["US Shoe Size"]).toEqual([want]);
});

it("won't pick a department for a unisex shoe tag", () => {
  const meta = [free("US Shoe Size", SHOE, true)];
  const aspects = { "US Shoe Size": ["US Men 4.5 / Women 6 / EU 36"] };
  snapStandardSizes(aspects, meta);
  expect(validateAspects(aspects, meta)).toContain(
    "Choose an allowed value for US Shoe Size",
  );
  const women = {
    Department: ["Women"],
    "US Shoe Size": ["US Men 4.5 / Women 6 / EU 36"],
  };
  snapStandardSizes(women, meta);
  expect(women["US Shoe Size"]).toEqual(["6"]);
});

it("drops the raw printed label as a custom Size in shoe categories", () => {
  const meta = [free("US Shoe Size", SHOE, true), free("Brand", [])];
  const aspects = {
    Size: ["US M 10 D / UK 9 / EU 44"],
    "US Shoe Size": ["10"],
  };
  expect(snapStandardSizes(aspects, meta)).toEqual(["Size"]);
  expect(aspects).toEqual({ "US Shoe Size": ["10"] });
});

it("keeps an unmappable optional clothing Size for review instead of dropping it", () => {
  const meta = [free("Size", WOMEN), free("Department", ["Women", "Men"])];
  const aspects = { Size: ["IT 42"] };
  expect(snapStandardSizes(aspects, meta)).toEqual([]);
  expect(aspects).toEqual({ Size: ["IT 42"] });
  expect(validateAspects(aspects, meta)).toContain("Choose an allowed value for Size");
});

it("leaves Size as free text outside apparel (rugs, bedding, art)", () => {
  const rug = [free("Size", ["2x3", "3x5", "5x8", "8x10"], true), free("Brand", [])];
  const custom = { Size: ["5'3\" x 7'7\""] };
  expect(snapStandardSizes(custom, rug)).toEqual([]);
  expect(custom).toEqual({ Size: ["5'3\" x 7'7\""] });
  expect(validateAspects(custom, rug)).toEqual([]);
  const bedding = [free("Size", ["Twin", "Full", "Queen", "King"])];
  const odd = { Size: ["Olympic Queen"] };
  expect(snapStandardSizes(odd, bedding)).toEqual([]);
  expect(odd).toEqual({ Size: ["Olympic Queen"] });
  expect(validateAspects(odd, bedding)).toEqual([]);
});

it("locks Size for apparel filed outside the clothing tree", () => {
  // Collectibles > Disneyana > Apparel: no Department aspect, clothing sizes.
  const meta = [free("Size", ["XS", "S", "M", "L", "XL", "2XL", "3XL"], true)];
  const aspects = { Size: ["US M / UK M / EU M"] };
  snapStandardSizes(aspects, meta);
  expect(aspects).toEqual({ Size: ["M"] });
});
