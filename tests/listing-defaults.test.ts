import { expect, it } from "vitest";
import {
  applyListingDefaults,
  defaultEbayCondition,
  withConditionDefaults,
} from "@/lib/listing-defaults";
import type { ItemGroup, ListingResult } from "@/lib/types";
import type { AspectMeta } from "@/lib/ebay/taxonomy";
const meta: AspectMeta[] = [
  {
    name: "Size Type",
    values: ["Regular", "Petite"],
    mode: "SELECTION_ONLY",
    required: true,
    usage: "REQUIRED",
    cardinality: "SINGLE",
  },
];
it("fills the seller's Regular and exact Pre-owned Excellent defaults", () => {
  const l: ListingResult = {
    title: "Shirt",
    description: "",
    condition: "GOOD",
    evidence: { "Size Type": [1] },
  };
  applyListingDefaults(l, meta, ["PRE_OWNED_EXCELLENT", "USED_EXCELLENT"]);
  expect(l.item_specifics?.["Size Type"]).toBe("Regular");
  expect(l.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
  expect(l.condition).toBe("EXCELLENT");
  expect(l.evidence?.["Size Type"]).toBeUndefined();
});
it("preserves a seller's alternate size and new-condition choice on repeated preparation", () => {
  const l: ListingResult = {
    title: "Shirt",
    description: "",
    item_specifics: { "Size Type": "Petite" },
    ebay_condition: "NEW",
    condition: "NEW_WITH_TAGS",
  };
  applyListingDefaults(l, meta, ["NEW", "PRE_OWNED_EXCELLENT"]);
  expect(l.item_specifics?.["Size Type"]).toBe("Petite");
  expect(l.ebay_condition).toBe("NEW");
  expect(l.condition).toBe("NEW_WITH_TAGS");
});
it("adds no size type when the category has no such aspect", () => {
  const l: ListingResult = { title: "Item", description: "" };
  applyListingDefaults(l, [], ["USED_EXCELLENT"]);
  expect(l.item_specifics).toBeUndefined();
});
it("defaults non-apparel categories to their closest Excellent condition", () => {
  const l: ListingResult = {
    title: "Plush",
    description: "",
    condition: "GOOD",
  };
  applyListingDefaults(l, [], ["NEW", "USED_EXCELLENT"]);
  expect(l.ebay_condition).toBe("USED_EXCELLENT");
  expect(l.condition).toBe("EXCELLENT");
});
it.each([
  ["NEW_WITH_TAGS", ["NEW", "NEW_OTHER", "USED_EXCELLENT"], "NEW"],
  ["NEW_NO_TAGS", ["NEW", "NEW_OTHER", "USED_EXCELLENT"], "NEW_OTHER"],
  ["NEW_WITH_DEFECTS", ["NEW", "NEW_WITH_DEFECTS"], "NEW_WITH_DEFECTS"],
  ["NEW_WITH_DEFECTS", ["NEW", "NEW_OTHER"], "NEW_OTHER"],
  ["NEW_WITH_DEFECTS", ["NEW", "USED_EXCELLENT"], ""],
  [
    "EXCELLENT",
    ["PRE_OWNED_EXCELLENT", "USED_EXCELLENT"],
    "PRE_OWNED_EXCELLENT",
  ],
  ["GOOD", ["USED_EXCELLENT", "USED_GOOD"], "USED_EXCELLENT"],
  [undefined, ["LIKE_NEW", "USED_VERY_GOOD"], "LIKE_NEW"],
  ["FAIR", ["USED_VERY_GOOD", "USED_GOOD"], "USED_VERY_GOOD"],
  [
    "FOR_PARTS_OR_NOT_WORKING",
    ["USED_EXCELLENT", "FOR_PARTS_OR_NOT_WORKING"],
    "FOR_PARTS_OR_NOT_WORKING",
  ],
  ["FOR_PARTS_OR_NOT_WORKING", ["USED_EXCELLENT"], ""],
] as [string | undefined, string[], string][])(
  "maps grade %s with accepted %j to %s",
  (grade, accepted, expected) => {
    expect(defaultEbayCondition(grade, accepted)).toBe(expected);
  },
);
it("keeps a new grade when applying the default", () => {
  const l: ListingResult = {
    title: "Boxed figure",
    description: "",
    condition: "NEW_WITH_DEFECTS",
  };
  applyListingDefaults(l, [], ["NEW", "NEW_WITH_DEFECTS", "USED_EXCELLENT"]);
  expect(l.ebay_condition).toBe("NEW_WITH_DEFECTS");
  expect(l.condition).toBe("NEW_WITH_DEFECTS");
});
it("fills saved drafts missing a condition without touching seller choices", () => {
  const conditions = [
    { value: "NEW", label: "New" },
    { value: "USED_EXCELLENT", label: "Used" },
    { value: "USED_GOOD", label: "Good" },
  ];
  const group = (id: string, ebay_condition?: string) =>
    ({
      id,
      listing: {
        title: id,
        description: "",
        condition: "GOOD",
        ebay_condition,
      },
      preparation: { conditions },
    }) as unknown as ItemGroup;
  const empty = group("a");
  const chosen = group("b", "USED_GOOD");
  const unprepared = {
    id: "c",
    listing: { title: "c", description: "" },
  } as unknown as ItemGroup;
  const [a, b, c] = withConditionDefaults([empty, chosen, unprepared]);
  expect(a.listing?.ebay_condition).toBe("USED_EXCELLENT");
  expect(a.listing?.condition).toBe("EXCELLENT");
  expect(empty.listing?.ebay_condition).toBeUndefined();
  expect(b).toBe(chosen);
  expect(c).toBe(unprepared);
});
