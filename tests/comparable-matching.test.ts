import { expect, it, vi } from "vitest";
import { apparelMatchScore, apparelQuery } from "@/lib/ebay/apparel-comps";
import { searchComps } from "@/lib/ebay/comps";
import { cleanGeneratedDescription } from "@/lib/description";
import type { ListingResult } from "@/lib/types";
const shirt: ListingResult = {
  title: "Faherty striped pocket tee",
  description: "",
  brand: "Faherty",
  category: "mens_top",
  size: "M",
  item_type: "T-Shirt",
  condition: "EXCELLENT",
  item_specifics: { Style: "Basic", "Size Type": "Regular" },
  search_terms: ["pocket t-shirt", "striped tee"],
};
it("matches reordered tee synonyms without requiring Basic or repeated type words", () => {
  expect(
    apparelMatchScore("Faherty Mens Medium Stripe Pocket Tee Blue", shirt),
  ).toBeGreaterThan(0);
  expect(apparelQuery(shirt)).not.toContain("basic");
  for (const title of [
    "Otherbrand Stripe Pocket Tee M",
    "Faherty Plain Pocket Tee M",
    "Faherty Womens Striped Pocket T-Shirt M",
    "Faherty Kids Striped Pocket Tee M",
  ])
    expect(apparelMatchScore(title, shirt)).toBe(0);
});
it("does not require every fiber percentage in sweatshirt titles", () => {
  const l = {
    ...shirt,
    title: "Sailor Moon crewneck sweatshirt",
    brand: "Sailor Moon",
    category: "womens_top",
    item_type: "Sweatshirt",
    material: "62% Polyester 33% Rayon 5% Spandex",
    search_terms: ["Sailor Scouts", "Naoko Takeuchi"],
    item_specifics: { Style: "Crewneck Sweatshirt" },
  };
  expect(apparelQuery(l)).not.toMatch(/62|rayon|Naoko/);
  expect(
    apparelMatchScore("Sailor Moon Scouts Women's Crewneck Sweatshirt M", l),
  ).toBeGreaterThan(0);
  expect(apparelMatchScore("Sailor Moon Women's T-Shirt M", l)).toBe(0);
});
it("retains premium fiber and garment construction", () => {
  const l = {
    ...shirt,
    title: "Tahari cashmere colorblock waterfall cardigan",
    brand: "Tahari",
    category: "womens_sweater",
    item_type: "Cardigan",
    material: "100% Cashmere",
    item_specifics: { Style: "Open Front Cardigan" },
    search_terms: ["colorblock cascade"],
  };
  expect(
    apparelMatchScore("Tahari Cashmere Color Block Draped Cardigan M", l),
  ).toBeGreaterThan(0);
  expect(
    apparelMatchScore("Tahari Cotton Colorblock Waterfall Cardigan M", l),
  ).toBe(0);
  expect(apparelMatchScore("Tahari Cashmere Solid Cardigan M", l)).toBe(0);
});
it("keeps collaboration and graphic identity without insisting on decorative synonyms", () => {
  const l = {
    ...shirt,
    title: "Abercrombie rainbow wave camp shirt",
    brand: "Abercrombie & Fitch",
    item_type: "Button-Up Shirt",
    item_specifics: { "Product Line": "The Trevor Project" },
    search_terms: ["rainbow wave embroidery", "camp collar shirt"],
  };
  expect(
    apparelMatchScore(
      "Abercrombie Fitch Trevor Project Wavy Rainbow Shirt M",
      l,
    ),
  ).toBeGreaterThan(0);
  expect(
    apparelMatchScore("Abercrombie Fitch Trevor Project Crochet Shirt M", l),
  ).toBe(0);
  expect(
    apparelMatchScore("Abercrombie Fitch Rainbow Wave Camp Shirt M", l),
  ).toBe(0);
});
it("preserves named styles while allowing an omitted stock number", () => {
  const l = {
    ...shirt,
    title: "Chubbies Dark N Stormies Originals Pant",
    brand: "Chubbies",
    item_type: "Chino Pants",
    category: "mens_pants",
    item_specifics: {
      Model: "The Dark N Stormies",
      MPN: "777243-026",
      "Product Line": "Originals Pant",
    },
    search_terms: [],
  };
  expect(
    apparelMatchScore("Chubbies Dark N Stormies Originals Pant Medium", l),
  ).toBeGreaterThan(0);
  expect(apparelMatchScore("Chubbies Other Originals Pant Medium", l)).toBe(0);
});
it("brand by manufacturer and burger synonyms do not lose graphic identity", () => {
  const l = {
    ...shirt,
    title: "Hello Kitty Burger T-Shirt",
    brand: "Hello Kitty by Sanrio",
    category: "womens_top",
    search_terms: ["Hello Kitty burger", "YUM YUM YUM", "Bioworld"],
  };
  expect(
    apparelMatchScore("Hello Kitty Hamburger Tee Medium", l),
  ).toBeGreaterThan(0);
  expect(apparelMatchScore("Hello Kitty Rainbow Tee Medium", l)).toBe(0);
});
it("uses one broader search, filters wrong sizes and conditions, and deduplicates", async () => {
  const urls: string[] = [];
  const item = (
    id: string,
    title: string,
    conditionId = "3000",
    shipping = true,
  ) => ({
    itemId: id,
    title,
    conditionId,
    itemWebUrl: `https://www.ebay.com/itm/${id}`,
    price: { value: "25", currency: "USD" },
    shippingOptions: shipping
      ? [{ shippingCost: { value: "5", currency: "USD" } }]
      : [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          itemSummaries:
            urls.length === 1
              ? []
              : [
                  item("a", "Faherty Stripe Pocket Tee Medium"),
                  item("a", "Faherty Stripe Pocket Tee Medium"),
                  item("b", "Faherty Stripe Pocket Tee XL"),
                  item("c", "Faherty Stripe Pocket Tee Medium", "1000"),
                  item("d", "Faherty Stripe Pocket Tee Medium", "3000", false),
                ],
        }),
      );
    }),
  );
  try {
    const r = await searchComps("token", {
      ...shirt,
      title: "fallback fixture",
    });
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get("q")).toBe("faherty t shirt m");
    expect(r.sources?.map((s) => s.id)).toEqual(["a", "d"]);
    expect(r.count).toBe(1);
    expect(r.median).toBe(30);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("uses seller-selected new condition even when preliminary grade is used", async () => {
  let filter = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      filter = new URL(url).searchParams.get("filter") || "";
      return new Response(JSON.stringify({ itemSummaries: [] }));
    }),
  );
  try {
    await searchComps("token", {
      ...shirt,
      ebay_condition: "NEW",
      title: "new condition fixture",
    });
    expect(filter).toContain("conditions:{NEW}");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("removes review labels while preserving actual flaws and measurements wording", () => {
  expect(
    cleanGeneratedDescription(
      "Shirt. Preliminary used cosmetic condition with a small hole at the cuff. See photos for measurements.",
    ),
  ).toBe("Shirt. A small hole at the cuff. See photos for measurements.");
  expect(
    cleanGeneratedDescription(
      "Preliminary used cosmetic grade; please review all photos. Buyer to verify measurements.",
    ),
  ).toBe("Please review all photos. See photos for measurements.");
  expect(
    cleanGeneratedDescription(
      "Untested. Stain on back; missing button. Tags are attached.",
    ),
  ).toBe("Untested. Stain on back; missing button. Tags are attached.");
});
it("rejects the wrong color, hood, sizing and graphic found in live retrieval", () => {
  const l = {
    ...shirt,
    title: "Sailor Moon Scouts sweatshirt",
    brand: "Sailor Moon",
    category: "womens_sweater",
    item_type: "Sweatshirt",
    size: "L",
    search_terms: ["Sailor Scouts"],
    item_specifics: {
      Color: "Blue",
      Pattern: "Graphic Print",
      Neckline: "Crew Neck",
      "Size Type": "Regular",
    },
  };
  expect(
    apparelMatchScore(
      "Sailor Moon Scouts Blue Graphic Crewneck Sweatshirt L",
      l,
    ),
  ).toBeGreaterThan(0);
  for (const title of [
    "Sailor Moon Pink Scouts Sweatshirt L",
    "Sailor Moon Scouts Blue Hoodie Sweatshirt L",
    "Sailor Moon Scouts Blue Sweatshirt Petites L",
    "Sailor Moon Moon Power Blue Embroidered Sweatshirt L",
    "Sailor Moon Blue Chibi-Usa Luna Sweatshirt L",
  ])
    expect(apparelMatchScore(title, l)).toBe(0);
});
