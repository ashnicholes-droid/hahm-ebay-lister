import { afterEach, describe, expect, it, vi } from "vitest";
import { parseListing, shippingSchema } from "@/lib/validation";
import {
  reconcileAspects,
  conditionCandidates,
  publishListing,
} from "@/lib/ebay/publish";
import { validateAspects } from "@/lib/ebay/draft";
import { signReview } from "@/lib/review";
import { searchComps } from "@/lib/ebay/comps";
import { processFiles } from "@/lib/intake";
import { listingsToCsv } from "@/lib/export";
import type { AspectMeta } from "@/lib/ebay/taxonomy";
import type { PublishInput } from "@/lib/ebay/publish";
vi.mock("@/lib/ebay/taxonomy", () => ({
  categoryAspects: vi.fn(async () => [
    {
      name: "Brand",
      required: true,
      usage: "REQUIRED",
      mode: "FREE_TEXT",
      cardinality: "SINGLE",
      values: [],
    },
  ]),
  acceptedConditionIds: vi.fn(async () => new Set([3000])),
  suggestLeafCategories: vi.fn(async () => []),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const meta = (name: string, values: string[]): AspectMeta => ({
  name,
  required: true,
  usage: "REQUIRED",
  mode: "SELECTION_ONLY",
  cardinality: "SINGLE",
  values,
});
it("does not invent required facts from defaults or taxonomy order", () => {
  const a: Record<string, string[]> = {};
  reconcileAspects(
    a,
    [
      meta("Closure", ["Pull-On", "Zip"]),
      meta("Gemstone Treatment", ["Heated", "Not Enhanced"]),
    ],
    { title: "Unknown item", description: "" },
    "jewelry",
  );
  expect(a).toEqual({});
  expect(validateAspects(a, [meta("Closure", ["Zip"])])).toEqual([
    "Enter Closure",
  ]);
});
it("never upgrades FAIR to NEW or another grade", () => {
  expect(
    conditionCandidates("FAIR", new Set([1000, 3000, 5000, 6000]), "book"),
  ).toEqual(["USED_ACCEPTABLE"]);
  expect(conditionCandidates("FAIR", new Set([1000]), "book")).toEqual([]);
  expect(
    conditionCandidates("FAIR", new Set([2990, 3000, 3010]), "womens_dress"),
  ).toEqual(["PRE_OWNED_FAIR"]);
});
it("normalizes numeric facts and rejects invalid object shapes and infinite prices", () => {
  expect(
    parseListing({
      title: "Book",
      description: "",
      item_specifics: { Year: 1990 },
    }).item_specifics?.Year,
  ).toBe("1990");
  expect(() =>
    parseListing({
      title: "Book",
      description: "",
      item_specifics: { Year: { wrong: 1 } },
    }),
  ).toThrow();
  expect(() =>
    parseListing({ title: "Book", description: "", suggested_price: Infinity }),
  ).toThrow();
  expect(() =>
    parseListing({
      title: "Book",
      description: "",
      suggested_price: "10 dollars",
    }),
  ).toThrow();
});
it("checks dependencies and refuses changing numeric facts at publication", () => {
  expect(
    validateAspects({ Weight: ["6 oz"] }, [
      { ...meta("Weight", []), mode: "FREE_TEXT", dataType: "NUMBER" },
    ]),
  ).toContain("Enter a number for Weight");
  expect(
    validateAspects({ Size: ["M"] }, [
      {
        ...meta("Size", ["M"]),
        constraints: { M: [{ name: "Department", values: ["Women"] }] },
      },
    ]),
  ).toContain("Size: M requires Department: Women");
});
it("requires real shipping measurements and policies", () => {
  expect(shippingSchema.safeParse({}).success).toBe(false);
});
it("keeps successful images when another fails and caps before processing", async () => {
  const f = [
    { name: "one" },
    { name: "bad" },
    { name: "three" },
    { name: "four" },
  ] as File[];
  const process = vi.fn(async (file: File) => {
    if (file.name === "bad") throw new Error("Unreadable");
    return file.name;
  });
  const result = await processFiles(f, 3, process);
  expect(result.values).toEqual(["one", "three"]);
  expect(process).toHaveBeenCalledTimes(3);
  expect(result.errors).toHaveLength(2);
});
it("neutralizes spreadsheet formulas", () => {
  expect(
    listingsToCsv([
      {
        id: "1",
        sku: "=1+1",
        name: "name",
        photoIds: [],
        status: "done",
        listing: { title: "@formula", description: "" },
      },
    ]),
  ).toContain("'=1+1");
});
function input(): PublishInput {
  vi.stubEnv("APP_SECRET", "unit-test-secret");
  const expiresAt = Date.now() + 3600_000;
  return {
    sku: "TEST-unique",
    listing: {
      title: "Canon R5",
      description: "Visible scuff; untested.",
      brand: "Canon",
      condition: "GOOD",
      ebay_condition: "USED_EXCELLENT",
      category_id: "625",
      suggested_price: 200,
      item_specifics: { Brand: "Canon" },
    },
    imageUrls: ["https://i.ebayimg.com/photo1.jpg"],
    expectedPhotoCount: 1,
    shipping: {
      fulfillmentPolicyId: "ship",
      paymentPolicyId: "pay",
      returnPolicyId: "ret",
      locationKey: "home",
      weightOz: 24,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 6,
    },
    review: {
      categoryId: "625",
      expiresAt,
      signature: signReview("625", expiresAt),
    },
  };
}
function fakeEbay(
  opts: {
    live?: boolean;
    lookupFailure?: boolean;
    publishError?: boolean;
    timeoutAfterPublish?: boolean;
    conflict?: boolean;
    returnsAccepted?: boolean;
  } = {},
) {
  const writes: { url: string; body: any; method: string }[] = [];
  let publishAttempted = false;
  const fetch = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const u = String(url),
      method = init.method || "GET";
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (method !== "GET")
      writes.push({
        url: u,
        body: init.body ? JSON.parse(String(init.body)) : null,
        method,
      });
    if (u.includes("/fulfillment_policy"))
      return reply({
        fulfillmentPolicies: [
          { fulfillmentPolicyId: "ship", name: "Shipping" },
        ],
      });
    if (u.includes("/payment_policy"))
      return reply({ paymentPolicies: [{ paymentPolicyId: "pay" }] });
    if (u.includes("/return_policy"))
      return reply({
        returnPolicies: [
          {
            returnPolicyId: "ret",
            returnsAccepted: opts.returnsAccepted ?? true,
          },
        ],
      });
    if (u.includes("/location"))
      return reply({
        locations: [
          {
            merchantLocationKey: "home",
            merchantLocationStatus: "ENABLED",
            name: "Home",
          },
        ],
      });
    if (u.includes("/offer?")) {
      if (opts.lookupFailure) return reply({}, 503);
      return reply({
        offers:
          opts.live || (opts.timeoutAfterPublish && publishAttempted)
            ? [
                {
                  status: "PUBLISHED",
                  offerId: "offer1",
                  listing: { listingId: "123" },
                },
              ]
            : [],
      });
    }
    if (u.includes("/inventory_item/") && method === "GET")
      return opts.conflict
        ? reply({ product: { title: "Other item", description: "different" } })
        : reply({}, 404);
    if (u.includes("/inventory_item/") && method === "PUT") return reply({});
    if (u.endsWith("/offer") && method === "POST")
      return reply({ offerId: "offer1" }, 201);
    if (u.endsWith("/publish")) {
      publishAttempted = true;
      if (opts.timeoutAfterPublish) throw new Error("Connection lost");
      return opts.publishError
        ? reply(
            { errors: [{ errorId: 25021, message: "Condition invalid" }] },
            400,
          )
        : reply({ listingId: "123" });
    }
    throw new Error("Unexpected request " + method + " " + u);
  });
  vi.stubGlobal("fetch", fetch);
  return { writes, fetch };
}
describe("publication preserves reviewed facts", () => {
  it("posts exact reviewed category, specifics, condition, shipping, title and price", async () => {
    const i = input();
    const { writes } = fakeEbay();
    const r = await publishListing("token", i);
    expect(r.success).toBe(true);
    const inv = writes.find((w) => w.url.includes("inventory_item"))!.body;
    expect(inv.condition).toBe("USED_EXCELLENT");
    expect(inv.product.title).toBe(i.listing.title);
    expect(inv.product.aspects).toEqual({ Brand: ["Canon"] });
    expect(inv.packageWeightAndSize.weight.value).toBe(24);
    const offer = writes.find((w) => w.url.endsWith("/offer"))!.body;
    expect(offer.categoryId).toBe("625");
    expect(offer.pricingSummary.price.value).toBe("200.00");
    expect(offer.includeCatalogProductDetails).toBe(false);
  });
  it("does not try other condition grades when eBay rejects publication", async () => {
    const i = input();
    const { writes } = fakeEbay({ publishError: true });
    const r = await publishListing("token", i);
    expect(r.success).toBe(false);
    expect(writes.filter((w) => w.url.endsWith("/publish"))).toHaveLength(1);
    expect(writes.filter((w) => w.url.includes("inventory_item"))).toHaveLength(
      1,
    );
  });
  it("does no writes if live-state lookup fails", async () => {
    const i = input();
    const { writes } = fakeEbay({ lookupFailure: true });
    await expect(publishListing("token", i)).rejects.toThrow(
      "Could not verify",
    );
    expect(writes).toEqual([]);
  });
  it("does not overwrite an existing live SKU", async () => {
    const i = input();
    const { writes } = fakeEbay({ live: true });
    const r = await publishListing("token", i);
    expect(r.alreadyListed).toBe(true);
    expect(writes).toEqual([]);
  });
  it("blocks a conflicting unpublished inventory item", async () => {
    const i = input();
    const { writes } = fakeEbay({ conflict: true });
    await expect(publishListing("token", i)).rejects.toThrow("different draft");
    expect(writes).toEqual([]);
  });
  it("reconciles a lost publish response without another publish", async () => {
    const i = input();
    const { writes } = fakeEbay({ timeoutAfterPublish: true });
    const r = await publishListing("token", i);
    expect(r.listingId).toBe("123");
    expect(writes.filter((w) => w.url.endsWith("/publish"))).toHaveLength(1);
  });
  it("blocks missing selected photos before writes", async () => {
    const i = input();
    i.expectedPhotoCount = 2;
    const { writes } = fakeEbay();
    await expect(publishListing("token", i)).rejects.toThrow(
      "Every selected photo",
    );
    expect(writes).toEqual([]);
  });
  it("blocks missing required facts before writes", async () => {
    const i = input();
    i.listing.item_specifics = {};
    const { writes } = fakeEbay();
    await expect(publishListing("token", i)).rejects.toThrow("Enter Brand");
    expect(writes).toEqual([]);
  });
  it("blocks stale category receipts", async () => {
    const i = input();
    i.listing.category_id = "123";
    const { writes } = fakeEbay();
    await expect(publishListing("token", i)).rejects.toThrow("Prepare");
    expect(writes).toEqual([]);
  });
});
it("excludes near-identical models and includes known shipping in the comp median", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            itemSummaries: [
              {
                itemId: "r5",
                title: "Canon R5 camera",
                itemWebUrl: "https://www.ebay.com/itm/1",
                price: { value: "100", currency: "USD" },
                conditionId: "3000",
                shippingOptions: [
                  { shippingCost: { value: "10", currency: "USD" } },
                ],
              },
              {
                itemId: "r50",
                title: "Canon R50 camera",
                itemWebUrl: "https://www.ebay.com/itm/2",
                price: { value: "800", currency: "USD" },
                conditionId: "3000",
                shippingOptions: [
                  { shippingCost: { value: "0", currency: "USD" } },
                ],
              },
            ],
          }),
        ),
    ),
  );
  const r = await searchComps("token", {
    title: "Canon R5",
    description: "",
    brand: "Canon",
    item_type: "camera",
    item_specifics: { Model: "R5" },
    condition: "GOOD",
  });
  expect(r.median).toBe(110);
  expect(r.sources).toHaveLength(1);
  expect(r.sources?.[0].id).toBe("r5");
});

it("blocks a no-returns policy before any eBay listing writes", async () => {
  const api = fakeEbay({ returnsAccepted: false });
  vi.stubGlobal("fetch", api.fetch);
  await expect(publishListing("token", input())).rejects.toThrow(
    "accepts returns",
  );
  expect(api.writes).toEqual([]);
});
