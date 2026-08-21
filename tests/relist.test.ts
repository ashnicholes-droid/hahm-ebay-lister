import { describe, expect, it, vi, afterEach } from "vitest";
import { relistAdvice } from "@/lib/relistAdvice";
import { validateRelistPrice } from "@/lib/ebay/relist";

// The offer lookup, the withdraw, the reprice and the publish are four separate
// eBay calls, and what matters is what happens when one of them fails partway
// through — so fetch is stubbed with a scripted sequence rather than a single
// canned reply.
function scriptFetch(handlers: ((url: string, init: RequestInit) => Response)[]) {
  const calls: { method: string; url: string; body: any }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({
      method: init.method ?? "GET",
      url: u,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const h = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return h(u, init);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A factory, not a value: a Response body can only be read once, so a shared
// instance would be empty by the second test.
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

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.resetModules();
});

async function load() {
  return await import("@/lib/ebay/relist");
}

describe("ending a listing", () => {
  it("withdraws rather than deletes, so the listing content survives", async () => {
    const calls = scriptFetch([() => offerLookup(), () => json({ listingId: "110000000001" })]);
    const { endListing } = await load();
    const r = await endListing("token", "K75-A");

    expect(r.ok).toBe(true);
    expect(r.endedListingId).toBe("110000000001");
    // The destructive call is the one eBay documents as *keeping* the offer.
    expect(calls[1].url).toContain("/offer/OFF-1/withdraw");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reports a listing that isn't inventory-managed instead of failing oddly", async () => {
    scriptFetch([() => json({ offers: [] }, 404)]);
    const { endListing } = await load();
    const r = await endListing("token", "MADE-ELSEWHERE");
    expect(r.ok).toBe(false);
    expect(r.notInventoryManaged).toBe(true);
    expect(r.error).toMatch(/Seller Hub/);
  });

  it("passes eBay's own words through when the withdraw is refused", async () => {
    scriptFetch([
      () => offerLookup(),
      () => json({ errors: [{ errorId: 25001, longMessage: "Listing has a pending order." }] }, 400),
    ]);
    const { endListing } = await load();
    const r = await endListing("token", "K75-A");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pending order/);
  });
});

describe("relisting", () => {
  it("withdraws, then publishes, and reports the NEW listing id", async () => {
    const calls = scriptFetch([
      () => offerLookup(),
      () => json({ listingId: "110000000001" }), // withdraw
      () => json({ listingId: "220000000002" }), // publish
      () => json({ pricingSummary: { price: { value: "45.50", currency: "USD" } } }), // read back
    ]);
    const { relistListing } = await load();
    const r = await relistListing("token", "K75-A");

    expect(r.ok).toBe(true);
    expect(r.endedListingId).toBe("110000000001");
    // The new id is the entire point of a relist.
    expect(r.listingId).toBe("220000000002");
    expect(r.listingId).not.toBe(r.endedListingId);
    expect(calls[1].url).toContain("/withdraw");
    expect(calls[2].url).toContain("/publish");
  });

  it("reprices only after ending, never before", async () => {
    const calls = scriptFetch([
      () => offerLookup(),
      () => json({ listingId: "110000000001" }), // withdraw
      () => json({ pricingSummary: { price: { value: "45.50", currency: "USD" } } }), // GET
      () => new Response(null, { status: 204 }), // PUT
      () => json({ listingId: "220000000002" }), // publish
      () => json({ pricingSummary: { price: { value: "29.99", currency: "USD" } } }),
    ]);
    const { relistListing } = await load();
    const r = await relistListing("token", "K75-A", 29.99);

    expect(r.ok).toBe(true);
    expect(r.price).toBe(29.99);
    const order = calls.map((c) => (c.url.match(/withdraw|publish/)?.[0] ?? c.method));
    // Repricing a listing that is about to be ended would be a wasted write and
    // would briefly show buyers a price that is about to vanish.
    expect(order.indexOf("withdraw")).toBeLessThan(order.indexOf("PUT"));
    expect(order.indexOf("PUT")).toBeLessThan(order.indexOf("publish"));
  });

  it("sends the price as a full merged offer, not a bare price field", async () => {
    // eBay's offer update is a replacement — a partial body blanks the listing.
    const calls = scriptFetch([
      () => offerLookup(),
      () => json({ listingId: "1" }),
      () =>
        json({
          offerId: "OFF-1",
          sku: "K75-A",
          status: "PUBLISHED",
          listing: { listingId: "1" },
          categoryId: "20642",
          listingDescription: "<p>keep me</p>",
          pricingSummary: { price: { value: "45.50", currency: "USD" } },
        }),
      () => new Response(null, { status: 204 }),
      () => json({ listingId: "2" }),
      () => json({ pricingSummary: { price: { value: "29.99", currency: "USD" } } }),
    ]);
    const { relistListing } = await load();
    await relistListing("token", "K75-A", 29.99);

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.listingDescription).toBe("<p>keep me</p>");
    expect(put.body.pricingSummary.price.value).toBe("29.99");
    // Read-only fields eBay rejects on update must not be echoed back.
    for (const f of ["offerId", "sku", "marketplaceId", "format", "listing", "status"]) {
      expect(put.body).not.toHaveProperty(f);
    }
  });

  it("flags a stranded offer when the listing ends but won't republish", async () => {
    // The one genuinely dangerous outcome: nothing is for sale any more.
    scriptFetch([
      () => offerLookup(),
      () => json({ listingId: "110000000001" }),
      () => json({ errors: [{ errorId: 25002, longMessage: "Missing item specifics." }] }, 400),
    ]);
    const { relistListing } = await load();
    const r = await relistListing("token", "K75-A");

    expect(r.ok).toBe(false);
    expect(r.strandedOffer).toBe("OFF-1");
    expect(r.endedListingId).toBe("110000000001");
    expect(r.error).toMatch(/item specifics/i);
  });

  it("republishes at the old price rather than leaving the item off the market", async () => {
    // A refused price must not cost the seller their listing.
    scriptFetch([
      () => offerLookup(),
      () => json({ listingId: "110000000001" }), // withdraw
      () => json({ pricingSummary: { price: { value: "45.50", currency: "USD" } } }), // GET
      () => json({ errors: [{ errorId: 25709, longMessage: "Invalid price." }] }, 400), // PUT
      () => json({ listingId: "220000000002" }), // publish anyway
    ]);
    const { relistListing } = await load();
    const r = await relistListing("token", "K75-A", 0.5);

    expect(r.ok).toBe(true);
    expect(r.listingId).toBe("220000000002");
    expect(r.price).toBe(45.5);
    expect(r.error).toMatch(/relisted at the old price/i);
    expect(r.strandedOffer).toBeUndefined();
  });

  it("does not end anything when the offer lookup fails", async () => {
    const calls = scriptFetch([() => json({ errors: [{ message: "Token expired." }] }, 401)]);
    const { relistListing } = await load();
    const r = await relistListing("token", "K75-A");
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.includes("withdraw"))).toBe(false);
  });
});

describe("relist price validation", () => {
  it("holds the same bounds as a price edit", () => {
    expect(validateRelistPrice("29.99")).toEqual({ price: 29.99 });
    expect(validateRelistPrice("0")).toHaveProperty("error");
    expect(validateRelistPrice("abc")).toHaveProperty("error");
    expect(validateRelistPrice(9_999_999)).toHaveProperty("error");
  });
});

describe("whether to relist at all", () => {
  it("argues against relisting something with watchers", () => {
    const a = relistAdvice({ watchCount: 4, quantitySold: 0 });
    expect(a.discourage).toBe(true);
    expect(a.warning).toMatch(/4 watchers/);
    // and points at the tool that IS right for them
    expect(a.warning).toMatch(/offer/i);
  });

  it("uses singular wording for one watcher", () => {
    expect(relistAdvice({ watchCount: 1, quantitySold: 0 }).warning).toMatch(/the 1 watcher/);
  });

  it("argues against ending something that is selling", () => {
    expect(relistAdvice({ watchCount: 0, quantitySold: 2 }).discourage).toBe(true);
  });

  it("says nothing about a genuinely dead listing", () => {
    const a = relistAdvice({ watchCount: 0, quantitySold: 0 });
    expect(a.discourage).toBe(false);
    expect(a.warning).toBe("");
  });

  it("treats an unknown watch count as no reason to object", () => {
    // null means eBay didn't say. Inventing a warning from missing data would
    // discourage exactly the relists that should happen.
    expect(relistAdvice({ watchCount: null, quantitySold: null }).discourage).toBe(false);
  });
});
