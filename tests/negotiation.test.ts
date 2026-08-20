import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_OFFER_MESSAGE,
  MIN_DISCOUNT_PERCENT,
  fetchEligibleItems,
  offeredPrice,
  sendOfferToInterestedBuyers,
  validateOffer,
} from "@/lib/ebay/negotiation";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const stub = (body: unknown, status = 200, asText?: string) => {
  const seen: { url?: string; body?: any; method?: string } = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = String(url);
    seen.method = init?.method;
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(asText ?? JSON.stringify(body), {
      status,
      headers: { "Content-Type": asText ? "text/html" : "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
};

describe("what eBay will accept as an offer", () => {
  it("requires a real discount", () => {
    // eBay rejects anything under 5%; catching it here saves an irreversible
    // call that would have failed anyway.
    expect(validateOffer({ discountPercent: MIN_DISCOUNT_PERCENT - 1 })).toHaveProperty("error");
    expect(validateOffer({ discountPercent: MIN_DISCOUNT_PERCENT })).toEqual({ ok: true });
  });

  it("caps an implausible discount", () => {
    const r = validateOffer({ discountPercent: MAX_DISCOUNT_PERCENT + 1 });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/typo/i);
  });

  it("insists on whole numbers, which is what eBay takes", () => {
    expect(validateOffer({ discountPercent: 12.5 })).toHaveProperty("error");
  });

  it("rejects something that isn't a number at all", () => {
    expect(validateOffer({ discountPercent: NaN })).toHaveProperty("error");
  });

  it("caps the buyer-facing message", () => {
    expect(validateOffer({ discountPercent: 10, message: "x".repeat(MAX_OFFER_MESSAGE) })).toEqual({
      ok: true,
    });
    expect(
      validateOffer({ discountPercent: 10, message: "x".repeat(MAX_OFFER_MESSAGE + 1) })
    ).toHaveProperty("error");
  });

  it("only allows the durations eBay supports", () => {
    expect(validateOffer({ discountPercent: 10, durationDays: 2 })).toEqual({ ok: true });
    expect(validateOffer({ discountPercent: 10, durationDays: 7 })).toHaveProperty("error");
  });
});

describe("what the buyer would pay", () => {
  it("applies the discount to the cent", () => {
    expect(offeredPrice(45.5, 10)).toBe(40.95);
    expect(offeredPrice(19.99, 15)).toBe(16.99);
  });

  it("gets cheaper as the discount grows", () => {
    expect(offeredPrice(100, 20)).toBeLessThan(offeredPrice(100, 10));
  });
});

describe("which listings can take an offer", () => {
  it("takes eBay's answer rather than inferring from watch counts", async () => {
    stub({ eligibleItems: [{ listingId: "111" }, { listingId: "222" }], total: 2 });
    const r = await fetchEligibleItems("token");
    expect([...r.listingIds].sort()).toEqual(["111", "222"]);
    expect(r.unavailable).toBeUndefined();
  });

  it("does not blame a missing permission on a 403", async () => {
    // Offers run on sell.inventory, which every connection has. Telling the
    // seller to reconnect would send them to fix something that isn't broken —
    // and there is no `sell.negotiation` scope to add.
    stub({ errors: [{ errorId: 1100, message: "Insufficient permissions" }] }, 403);
    const r = await fetchEligibleItems("token");
    expect(r.unavailable).toMatch(/same permission as listing/i);
    expect(r.unavailable).not.toMatch(/reconnect(ing)? eBay once/i);
  });

  it("relays eBay's own sentence on other failures", async () => {
    stub({ errors: [{ errorId: 2, longMessage: "Marketplace not supported." }] }, 400);
    const r = await fetchEligibleItems("token");
    expect(r.unavailable).toContain("Marketplace not supported.");
  });

  it("returns nothing eligible rather than throwing when the network fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await fetchEligibleItems("token");
    expect(r.listingIds.size).toBe(0);
    expect(r.unavailable).toContain("ECONNRESET");
  });
});

describe("sending one", () => {
  it("sends the shape eBay documents", async () => {
    const seen = stub({ offers: [{ offerId: "OF-1" }] });
    const r = await sendOfferToInterestedBuyers("token", {
      listingId: "111",
      discountPercent: 15,
      message: "Thanks for watching",
      durationDays: 1,
      allowCounterOffer: false,
    });
    expect(r.ok).toBe(true);
    expect(r.offerId).toBe("OF-1");
    expect(seen.method).toBe("POST");
    expect(seen.url).toContain("/send_offer_to_interested_buyers");
    expect(seen.body.offeredItems).toEqual([
      { listingId: "111", quantity: 1, discountPercentage: "15" },
    ]);
    expect(seen.body.offerDuration).toEqual({ unit: "DAY", value: 1 });
    expect(seen.body.allowCounterOffer).toBe(false);
    expect(seen.body.message).toBe("Thanks for watching");
  });

  it("omits an empty message rather than sending a blank one", async () => {
    const seen = stub({ offers: [{ offerId: "OF-2" }] });
    await sendOfferToInterestedBuyers("token", {
      listingId: "111",
      discountPercent: 10,
      message: "   ",
    });
    expect(seen.body).not.toHaveProperty("message");
  });

  it("refuses to send an invalid discount at all", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendOfferToInterestedBuyers("token", { listingId: "1", discountPercent: 2 });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("does not claim success when eBay returned no offer", async () => {
    // A 2xx with an empty body is not proof anything reached a buyer, and
    // reporting it as sent would invite a duplicate.
    stub({ offers: [] });
    const r = await sendOfferToInterestedBuyers("token", {
      listingId: "111",
      discountPercent: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't clear anything was sent/i);
  });

  it("relays eBay's refusal with its detail", async () => {
    stub(
      {
        errors: [
          {
            errorId: 190004,
            longMessage: "This listing already has an active offer.",
            parameters: [{ name: "listingId", value: "111" }],
          },
        ],
      },
      400
    );
    const r = await sendOfferToInterestedBuyers("token", {
      listingId: "111",
      discountPercent: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already has an active offer");
    expect(r.debug?.errors?.[0].parameters?.[0]).toEqual({ name: "listingId", value: "111" });
  });

  it("carries no credentials in the debug payload", async () => {
    stub({ errors: [{ errorId: 1, message: "x" }] }, 400);
    const r = await sendOfferToInterestedBuyers("super-secret-token", {
      listingId: "111",
      discountPercent: 10,
    });
    expect(JSON.stringify(r.debug)).not.toContain("super-secret-token");
  });
});
