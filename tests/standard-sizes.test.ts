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
  const aspects = { "UK Shoe Size": ["UK 12"], "US Shoe Size": ["8 M"] };
  expect(snapStandardSizes(aspects, meta)).toEqual(["UK Shoe Size"]);
  expect(aspects).toEqual({ "US Shoe Size": ["8 M"] });
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
