import { describe, expect, it, afterEach } from "vitest";
import { fetchOrders, markShipped, parseOrder } from "@/lib/ebay/orders";

// Reading real money out of eBay's order payload. Getting this wrong is not a
// cosmetic bug: a misread field becomes a profit figure the seller acts on, and
// the specific failure mode to avoid is a missing value arriving as a confident
// zero.

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const rawOrder = (over: Record<string, any> = {}) => ({
  orderId: "12-34567-89012",
  legacyOrderId: "998877",
  creationDate: "2026-08-04T11:45:00.000Z",
  orderFulfillmentStatus: "NOT_STARTED",
  orderPaymentStatus: "PAID",
  buyer: { username: "thrifty_pat" },
  pricingSummary: {
    priceSubtotal: { value: "42.00", currency: "USD" },
    deliveryCost: { value: "8.10", currency: "USD" },
    total: { value: "50.10", currency: "USD" },
  },
  paymentSummary: {
    totalDueSeller: { value: "43.45", currency: "USD" },
    refunds: [],
  },
  totalMarketplaceFee: { value: "6.65", currency: "USD" },
  totalFeeBasisAmount: { value: "50.10", currency: "USD" },
  cancelStatus: { cancelState: "NONE_REQUESTED" },
  lineItems: [
    {
      lineItemId: "L1",
      legacyItemId: "1122334455",
      sku: "K75-A",
      title: "Vintage Pyrex bowl",
      quantity: 1,
      lineItemCost: { value: "42.00", currency: "USD" },
      deliveryCost: { shippingCost: { value: "8.10", currency: "USD" } },
      lineItemFulfillmentStatus: "NOT_STARTED",
      lineItemFulfillmentInstructions: { shipByDate: "2026-08-06T13:59:59.000Z" },
    },
  ],
  fulfillmentStartInstructions: [
    {
      shippingStep: {
        shipTo: {
          fullName: "Pat Rivera",
          contactAddress: {
            city: "Lansdale",
            stateOrProvince: "PA",
            postalCode: "19446",
            countryCode: "US",
          },
        },
      },
    },
  ],
  ...over,
});

describe("reading one order", () => {
  it("pulls out the money the whole screen is built on", () => {
    const o = parseOrder(rawOrder())!;
    expect(o.buyerPaid).toBe(50.1);
    expect(o.marketplaceFee).toBe(6.65);
    expect(o.deliveryCost).toBe(8.1);
    expect(o.dueSeller).toBe(43.45);
    expect(o.currency).toBe("USD");
  });

  it("keeps the SKU and item id, which is how a sale finds its cost basis", () => {
    const o = parseOrder(rawOrder())!;
    expect(o.items[0].sku).toBe("K75-A");
    expect(o.items[0].legacyItemId).toBe("1122334455");
  });

  it("reports a missing fee as unknown, never as free", () => {
    // eBay leaves this off very fresh orders. Zero here would show the seller a
    // profit that includes eBay's cut.
    const o = parseOrder(rawOrder({ totalMarketplaceFee: undefined }))!;
    expect(o.marketplaceFee).toBeNull();
  });

  it("sums refunds into money that left again", () => {
    const o = parseOrder(
      rawOrder({
        paymentSummary: {
          totalDueSeller: { value: "0.00", currency: "USD" },
          refunds: [
            { amount: { value: "20.00", currency: "USD" } },
            { amount: { value: "5.10", currency: "USD" } },
          ],
        },
      })
    )!;
    expect(o.refunded).toBe(25.1);
  });

  it("prefers the discounted line cost, so a multi-buy sale isn't overstated", () => {
    const raw = rawOrder() as Record<string, any>;
    raw.lineItems[0].discountedLineItemCost = { value: "37.80", currency: "USD" };
    expect(parseOrder(raw)!.items[0].itemCost).toBe(37.8);
  });

  it("notices a cancellation", () => {
    const o = parseOrder(rawOrder({ cancelStatus: { cancelState: "CANCELED" } }))!;
    expect(o.cancelled).toBe(true);
  });

  it("knows whether the order still needs shipping", () => {
    expect(parseOrder(rawOrder())!.shipped).toBe(false);
    expect(parseOrder(rawOrder({ orderFulfillmentStatus: "FULFILLED" }))!.shipped).toBe(true);
  });

  it("reads the ship-to address for the label", () => {
    const o = parseOrder(rawOrder())!;
    expect(o.shipTo).toMatchObject({ name: "Pat Rivera", city: "Lansdale", postalCode: "19446" });
  });

  it("survives an order stripped of everything optional", () => {
    const o = parseOrder({ orderId: "bare" })!;
    expect(o.buyerPaid).toBeNull();
    expect(o.marketplaceFee).toBeNull();
    expect(o.refunded).toBe(0);
    expect(o.items).toEqual([]);
    expect(o.shipTo).toBeNull();
  });

  it("ignores a payload with no order id rather than inventing one", () => {
    expect(parseOrder({})).toBeNull();
  });
});

describe("fetching the window", () => {
  const stub = (handler: (url: string) => Response) => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return handler(String(url));
    }) as typeof fetch;
    return urls;
  };

  const page = (orders: unknown[], total = orders.length) =>
    new Response(JSON.stringify({ orders, total }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("asks eBay for the date range and returns what came back", async () => {
    const urls = stub(() => page([rawOrder()]));
    const r = await fetchOrders("token", 30);
    expect(r.orders).toHaveLength(1);
    expect(urls[0]).toContain("creationdate");
    expect(urls[0]).toContain("/sell/fulfillment/v1/order");
  });

  it("retries without the filter when eBay rejects it, rather than showing no sales", async () => {
    // The failure this guards against is the worst one available: a query-string
    // mistake rendering as "you sold nothing".
    let first = true;
    const urls = stub(() => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ errors: [{ message: "Invalid filter" }] }), {
          status: 400,
        });
      }
      return page([rawOrder()]);
    });
    const r = await fetchOrders("token", 30);
    expect(r.orders).toHaveLength(1);
    expect(urls[1]).not.toContain("filter");
    expect(r.warnings.join(" ")).toMatch(/filtered here instead/i);
  });

  it("applies the window itself, so an ignored filter can't widen it silently", async () => {
    stub(() =>
      page([
        rawOrder({ orderId: "recent", creationDate: new Date().toISOString() }),
        rawOrder({ orderId: "ancient", creationDate: "2019-01-01T00:00:00.000Z" }),
      ])
    );
    const r = await fetchOrders("token", 30);
    expect(r.orders.map((o) => o.orderId)).toEqual(["recent"]);
  });

  it("returns newest first", async () => {
    stub(() =>
      page([
        rawOrder({ orderId: "older", creationDate: "2026-08-01T00:00:00.000Z" }),
        rawOrder({ orderId: "newer", creationDate: "2026-08-20T00:00:00.000Z" }),
      ])
    );
    const r = await fetchOrders("token", 90);
    expect(r.orders.map((o) => o.orderId)).toEqual(["newer", "older"]);
  });

  it("keeps the orders it did read when a later page fails", async () => {
    let call = 0;
    stub(() => {
      call++;
      if (call === 1) return page([rawOrder()], 400);
      return new Response(JSON.stringify({ errors: [{ message: "Rate limited" }] }), {
        status: 429,
      });
    });
    const r = await fetchOrders("token", 90);
    expect(r.orders).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/Rate limited/);
  });

  it("surfaces eBay's own words when the whole call fails", async () => {
    stub(
      () =>
        new Response(JSON.stringify({ errors: [{ longMessage: "Insufficient permissions." }] }), {
          status: 403,
        })
    );
    await expect(fetchOrders("token", 30)).rejects.toThrow(/Insufficient permissions/);
  });
});

describe("marking an order shipped", () => {
  it("strips the spaces eBay rejects out of a tracking number", async () => {
    // Labels print tracking in groups of four. Sending it that way is refused,
    // after the seller has already typed the whole thing.
    let sent: any = null;
    globalThis.fetch = (async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ fulfillmentId: "F1" }), { status: 201 });
    }) as typeof fetch;
    await markShipped("token", {
      orderId: "12-345",
      trackingNumber: "9400 1111 2222 3333 4444 55",
      carrier: "USPS",
    });
    expect(sent.trackingNumber).toBe("94001111222233334444 55".replace(/\s/g, ""));
  });

  it("omits lineItems entirely when shipping the whole order", async () => {
    // eBay reads an absent lineItems as "everything" and an empty array as
    // malformed.
    let sent: any = null;
    globalThis.fetch = (async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ fulfillmentId: "F1" }), { status: 201 });
    }) as typeof fetch;
    await markShipped("token", { orderId: "o", trackingNumber: "123", carrier: "USPS" });
    expect(sent).not.toHaveProperty("lineItems");
  });

  it("refuses an empty tracking number before spending a call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await expect(
      markShipped("token", { orderId: "o", trackingNumber: "   ", carrier: "USPS" })
    ).rejects.toThrow(/tracking number/i);
    expect(called).toBe(false);
  });

  it("passes eBay's rejection back rather than a generic failure", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Invalid line item." }] }), {
        status: 400,
      })) as typeof fetch;
    await expect(
      markShipped("token", { orderId: "o", trackingNumber: "123", carrier: "USPS" })
    ).rejects.toThrow(/Invalid line item/);
  });
});
