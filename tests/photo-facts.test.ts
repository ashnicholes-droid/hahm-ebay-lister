import { expect, it } from "vitest";
import { acceptedPhotoFact, MIN_ESTIMATE_CONFIDENCE } from "@/lib/photo-facts";

const fact = (over: Record<string, unknown>) => ({
  name: "Upper Material",
  value: "Canvas",
  basis: "estimate",
  quote: "",
  photoIndices: [1],
  confidence: 75,
  ...over,
});

it("uses a 60% threshold for educated guesses", () => {
  expect(MIN_ESTIMATE_CONFIDENCE).toBe(60);
});

it("accepts confident educated guesses for any category aspect", () => {
  expect(acceptedPhotoFact(fact({}), 2)).toBe(true);
  expect(
    acceptedPhotoFact(fact({ name: "Shoe Width", value: "Medium", confidence: 60 }), 2),
  ).toBe(true);
  expect(
    acceptedPhotoFact(
      fact({ name: "Closure", value: "Lace Up", basis: "visible_feature", confidence: 90 }),
      2,
    ),
  ).toBe(true);
});

it("leaves an aspect blank when confidence is under 60% or missing", () => {
  const width = { name: "Shoe Width", value: "Medium" };
  expect(acceptedPhotoFact(fact({ ...width, confidence: 59 }), 2)).toBe(false);
  expect(acceptedPhotoFact(fact({ ...width, confidence: undefined }), 2)).toBe(false);
  expect(acceptedPhotoFact(fact({ ...width, confidence: "high" }), 2)).toBe(false);
});

it("never guesses identifiers, provenance or measurements", () => {
  for (const name of [
    "UPC",
    "EAN",
    "ISBN",
    "MPN",
    "Year Manufactured",
    "Country/Region of Manufacture",
    "Vintage",
    "Handmade",
    "Personalize",
    "Inseam",
  ])
    expect(acceptedPhotoFact(fact({ name, value: "X", confidence: 95 }), 2)).toBe(false);
});

it("still accepts label-read identifiers that match their quote", () => {
  expect(
    acceptedPhotoFact(
      fact({ name: "US Shoe Size", value: "6.5", basis: "label", quote: "W US 6.5", confidence: 99 }),
      2,
    ),
  ).toBe(true);
  expect(
    acceptedPhotoFact(
      fact({ name: "UPC", value: "012345678905", basis: "label", quote: "012345678905" }),
      2,
    ),
  ).toBe(true);
});

it("always accepts a best guess for Upper Material, whatever the confidence", () => {
  expect(acceptedPhotoFact(fact({ confidence: 20 }), 2)).toBe(true);
  expect(acceptedPhotoFact(fact({ name: "upper material", confidence: 0 }), 2)).toBe(true);
  expect(acceptedPhotoFact(fact({ confidence: undefined }), 2)).toBe(false);
  expect(acceptedPhotoFact(fact({ name: "Lining Material", confidence: 20 }), 2)).toBe(false);
});

it("accepts a label size the model wrote with department words added", () => {
  const size = (value: string, quote: string) =>
    acceptedPhotoFact(fact({ name: "US Shoe Size", value, basis: "label", quote }), 2);
  expect(size("US Men's 10 D", "US M 10 D UK 9 EU 44")).toBe(true);
  expect(size("Men's 10", "US 10 UK 9 EU 44")).toBe(true);
  // The numbers must still line up with the same size system.
  expect(size("US Men's 10", "US 9 UK 10")).toBe(false);
  // A unisex tag can't confirm either department's size.
  expect(size("US Women's 9", "US M 9 W 10.5")).toBe(false);
  // Department words alone never pass as label evidence.
  expect(
    acceptedPhotoFact(fact({ name: "Department", value: "Men", basis: "label", quote: "M" }), 2),
  ).toBe(false);
});
