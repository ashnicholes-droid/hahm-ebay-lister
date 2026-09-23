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
  expect(acceptedPhotoFact(fact({ confidence: 59 }), 2)).toBe(false);
  expect(acceptedPhotoFact(fact({ confidence: undefined }), 2)).toBe(false);
  expect(acceptedPhotoFact(fact({ confidence: "high" }), 2)).toBe(false);
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
