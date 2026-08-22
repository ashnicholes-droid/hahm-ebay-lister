import { describe, expect, it, vi, afterEach } from "vitest";
import { TITLE_MAX } from "@/lib/ebay/contentLimits";

// Title and description are split across two eBay objects and both PUTs are
// full replacements, so what matters is exactly what body goes over the wire.
function scriptFetch(handlers: ((url: string, init: RequestInit) => Response)[]) {
  const calls: { method: string; url: string; body: any }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({
      method: init.method ?? "GET",
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const h = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return h(String(url), init);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A full inventory item, so a partial PUT is visibly destructive. */
const inventoryItem = () =>
  json({
    sku: "K75-A",
    locale: "en_US",
    condition: "USED_EXCELLENT",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    packageWeightAndSize: { weight: { value: 24, unit: "OUNCE" } },
    product: {
      title: "Old Title",
      description: "<p>Old description</p>",
      aspects: { Brand: ["Lodge"] },
      imageUrls: ["https://i.ebayimg.com/a.jpg"],
    },
  });

const offerLookup = () =>
  json({
    offers: [
      {
        offerId: "OFF-1",
        sku: "K75-A",
        status: "PUBLISHED",
        listing: { listingId: "110000000001" },
        pricingSummary: { price: { value: "45.50", currency: "USD" } },
      },
    ],
  });

const offer = () =>
  json({
    offerId: "OFF-1",
    sku: "K75-A",
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    status: "PUBLISHED",
    listing: { listingId: "110000000001" },
    categoryId: "20642",
    listingDescription: "<p>Old description</p>",
    listingPolicies: { fulfillmentPolicyId: "FP-1" },
    pricingSummary: { price: { value: "45.50", currency: "USD" } },
  });

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.resetModules();
});

const load = () => import("@/lib/ebay/content");

describe("validateContent", () => {
  it("rejects an over-long title with the actual count", async () => {
    const { validateContent } = await load();
    const r = validateContent({ title: "x".repeat(TITLE_MAX + 5) });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(new RegExp(`${TITLE_MAX + 5}`));
  });

  it("accepts a title exactly at the cap", async () => {
    const { validateContent } = await load();
    expect(validateContent({ title: "x".repeat(TITLE_MAX) })).toHaveProperty("content");
  });

  it("refuses to blank a title or description", async () => {
    const { validateContent } = await load();
    expect(validateContent({ title: "   " })).toHaveProperty("error");
    expect(validateContent({ description: "  " })).toHaveProperty("error");
  });

  it("trims the title but leaves the description's whitespace alone", async () => {
    const { validateContent } = await load();
    const r = validateContent({ title: "  Padded  ", description: "  <p>x</p>\n" });
    expect(r).toEqual({ content: { title: "Padded", description: "  <p>x</p>\n" } });
  });

  it("says so when nothing was passed", async () => {
    const { validateContent } = await load();
    expect(validateContent({})).toHaveProperty("error");
  });
});

describe("reading current content", () => {
  it("prefers the offer's description — that's the copy buyers read", async () => {
    scriptFetch([
      () => inventoryItem(),
      () => offerLookup(),
      () => json({ ...JSON.parse(JSON.stringify({})), listingDescription: "<p>Offer copy</p>" }),
    ]);
    const { fetchContent } = await load();
    const r = await fetchContent("token", "K75-A");
    expect(r.ok).toBe(true);
    expect(r.content?.title).toBe("Old Title");
    expect(r.content?.description).toBe("<p>Offer copy</p>");
  });

  it("falls back to the inventory item's description when the offer has none", async () => {
    scriptFetch([() => inventoryItem(), () => offerLookup(), () => json({})]);
    const { fetchContent } = await load();
    expect((await fetchContent("token", "K75-A")).content?.description).toBe(
      "<p>Old description</p>"
    );
  });

  it("reports a listing that isn't inventory-managed rather than failing oddly", async () => {
    scriptFetch([() => json({}, 404)]);
    const { fetchContent } = await load();
    const r = await fetchContent("token", "NOPE");
    expect(r.ok).toBe(false);
    expect(r.notInventoryManaged).toBe(true);
    expect(r.error).toMatch(/Seller Hub/);
  });
});

describe("writing content", () => {
  it("merges into the whole inventory item rather than replacing it", async () => {
    // eBay's PUT is a full replacement: a partial body drops the photos, the
    // aspects and the package weight along with everything it omits.
    const calls = scriptFetch([() => inventoryItem(), () => new Response(null, { status: 204 })]);
    const { writeInventoryContent } = await load();
    await writeInventoryContent("token", "K75-A", { title: "New Title" });

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.product.title).toBe("New Title");
    // Everything else survives.
    expect(put.body.product.imageUrls).toEqual(["https://i.ebayimg.com/a.jpg"]);
    expect(put.body.product.aspects).toEqual({ Brand: ["Lodge"] });
    expect(put.body.product.description).toBe("<p>Old description</p>");
    expect(put.body.packageWeightAndSize).toBeDefined();
    expect(put.body.condition).toBe("USED_EXCELLENT");
    // Read-only fields must not be echoed back.
    expect(put.body).not.toHaveProperty("sku");
    expect(put.body).not.toHaveProperty("locale");
  });

  it("truncates rather than letting eBay reject an over-long title", async () => {
    const calls = scriptFetch([() => inventoryItem(), () => new Response(null, { status: 204 })]);
    const { writeInventoryContent } = await load();
    await writeInventoryContent("token", "K75-A", { title: "y".repeat(200) });
    expect(calls.find((c) => c.method === "PUT")!.body.product.title).toHaveLength(TITLE_MAX);
  });

  it("leaves the offer alone when only the price is absent and nothing changed", async () => {
    const calls = scriptFetch([() => offer()]);
    const { writeOfferContent } = await load();
    const r = await writeOfferContent(
      "token",
      { offerId: "OFF-1", currency: "USD" } as never,
      {},
      undefined
    );
    expect(r.ok).toBe(true);
    // No point spending two calls to change nothing.
    expect(calls).toHaveLength(0);
  });

  it("merges the description into the offer without dropping its policies", async () => {
    const calls = scriptFetch([() => offer(), () => new Response(null, { status: 204 })]);
    const { writeOfferContent } = await load();
    await writeOfferContent("token", { offerId: "OFF-1", currency: "USD" } as never, {
      description: "<p>New</p>",
    });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.listingDescription).toBe("<p>New</p>");
    expect(put.body.listingPolicies).toEqual({ fulfillmentPolicyId: "FP-1" });
    expect(put.body.categoryId).toBe("20642");
    for (const f of ["offerId", "sku", "marketplaceId", "format", "listing", "status"]) {
      expect(put.body).not.toHaveProperty(f);
    }
  });
});

describe("editing a live listing", () => {
  it("writes the description to BOTH places, since eBay keeps two copies", async () => {
    const calls = scriptFetch([
      () => offerLookup(), // findOffer
      () => inventoryItem(), // GET item
      () => new Response(null, { status: 204 }), // PUT item
      () => offer(), // GET offer
      () => new Response(null, { status: 204 }), // PUT offer
      () => inventoryItem(), // read-back: GET item
      () => offerLookup(),
      () => offer(),
    ]);
    const { editLiveContent } = await load();
    const r = await editLiveContent("token", "K75-A", {
      title: "Better Keywords Here",
      description: "<p>New</p>",
    });

    expect(r.ok).toBe(true);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    // Leaving one of them stale is how the listing page and the inventory
    // record end up disagreeing about what the item is.
    expect(puts[0].body.product.description).toBe("<p>New</p>");
    expect(puts[1].body.listingDescription).toBe("<p>New</p>");
    expect(puts[0].body.product.title).toBe("Better Keywords Here");
  });

  it("never ends the listing — that's the whole point of editing in place", async () => {
    const calls = scriptFetch([
      () => offerLookup(),
      () => inventoryItem(),
      () => new Response(null, { status: 204 }),
      () => offer(),
      () => new Response(null, { status: 204 }),
      () => inventoryItem(),
      () => offerLookup(),
      () => offer(),
    ]);
    const { editLiveContent } = await load();
    await editLiveContent("token", "K75-A", { title: "New" });
    expect(calls.some((c) => /withdraw|publish/.test(c.url))).toBe(false);
  });

  it("rejects a bad title before spending a single eBay call", async () => {
    const calls = scriptFetch([() => offerLookup()]);
    const { editLiveContent } = await load();
    const r = await editLiveContent("token", "K75-A", { title: "z".repeat(120) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports a half-applied edit as partial, not as a flat failure", async () => {
    // The title landed and the description didn't. Saying "it failed" would
    // send someone hunting for a change that already happened.
    scriptFetch([
      () => offerLookup(),
      () => inventoryItem(),
      () => new Response(null, { status: 204 }), // item PUT succeeds
      () => offer(),
      () => json({ errors: [{ errorId: 25002, longMessage: "Bad description." }] }, 400),
    ]);
    const { editLiveContent } = await load();
    const r = await editLiveContent("token", "K75-A", {
      title: "New Title",
      description: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.error).toMatch(/title was updated/i);
    expect(r.error).toMatch(/Bad description/);
  });

  it("stops before writing anything when the listing isn't inventory-managed", async () => {
    const calls = scriptFetch([() => json({ offers: [] }, 404)]);
    const { editLiveContent } = await load();
    const r = await editLiveContent("token", "ELSEWHERE", { title: "New" });
    expect(r.notInventoryManaged).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("relisting with new content", () => {
  it("rewrites the title on the withdrawn offer, in the right order", async () => {
    const calls = scriptFetch([
      () => offerLookup(), // findOffer
      () => json({ listingId: "110000000001" }), // withdraw
      () => inventoryItem(), // GET item
      () => new Response(null, { status: 204 }), // PUT item
      () => offer(), // GET offer
      () => new Response(null, { status: 204 }), // PUT offer
      () => json({ listingId: "220000000002" }), // publish
      () => offer(), // read back
    ]);
    const { relistListing } = await import("@/lib/ebay/relist");
    const r = await relistListing("token", "K75-A", 29.99, {
      title: "Rewritten For Search",
      description: "<p>New</p>",
    });

    expect(r.ok).toBe(true);
    expect(r.listingId).toBe("220000000002");
    const order = calls.map((c) => c.url.match(/withdraw|publish/)?.[0] ?? c.method);
    // Content must be written while the listing is DOWN — writing it first
    // would revise the very listing about to be ended.
    expect(order.indexOf("withdraw")).toBeLessThan(order.indexOf("PUT"));
    expect(order.lastIndexOf("PUT")).toBeLessThan(order.indexOf("publish"));
    expect(calls.filter((c) => c.method === "PUT")[0].body.product.title).toBe(
      "Rewritten For Search"
    );
  });

  it("refuses a bad title before ending anything", async () => {
    // The worst possible moment to discover an 80-character cap is after the
    // listing is already down.
    const calls = scriptFetch([() => offerLookup()]);
    const { relistListing } = await import("@/lib/ebay/relist");
    const r = await relistListing("token", "K75-A", undefined, { title: "q".repeat(200) });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.includes("withdraw"))).toBe(false);
  });
});
