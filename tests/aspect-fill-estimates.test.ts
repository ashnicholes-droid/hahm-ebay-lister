import { expect, it, vi } from "vitest";

const facts = [
  { name: "Upper Material", value: "Leather", basis: "estimate", quote: "", photoIndices: [1], confidence: 75 },
  { name: "Shoe Width", value: "Wide", basis: "estimate", quote: "", photoIndices: [1], confidence: 40 },
  { name: "US Shoe Size", value: "6.5", basis: "label", quote: "US 6.5", photoIndices: [1], confidence: 99 },
];
vi.mock("@/lib/anthropic", () => ({
  getClient: () => ({}),
  parseModelJson: (t: string) => JSON.parse(t),
}));
vi.mock("@/lib/ai-usage", () => ({
  measuredMessage: async () => ({
    content: [{ type: "text", text: JSON.stringify({ facts }) }],
  }),
}));

it("fills confident estimates, marks them, and leaves low-confidence aspects blank", async () => {
  const { fillRecommendedAspects } = await import("@/lib/ebay/aspectFill");
  const listing = { title: "adidas Superstar", description: "" } as any;
  const aspects: Record<string, string[]> = {};
  const meta = ["Upper Material", "Shoe Width", "US Shoe Size"].map((name) => ({
    name,
    required: false,
    usage: "RECOMMENDED",
    mode: "FREE_TEXT",
    cardinality: "SINGLE",
    values: [],
  })) as any;
  await fillRecommendedAspects(listing, aspects, meta, "t", [
    { data: "aGVsbG8=", mediaType: "image/jpeg" } as any,
  ]);
  expect(aspects["Upper Material"]).toEqual(["Leather"]);
  expect(aspects["US Shoe Size"]).toEqual(["6.5"]);
  expect(aspects["Shoe Width"]).toBeUndefined();
  expect(listing.estimates).toEqual({ "Upper Material": 75 });
});
