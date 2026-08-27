import { describe, expect, it } from "vitest";
import { byMonth, feeAccuracy, realize, summarize } from "@/lib/realizedProfit";
import type { RealizableOrder } from "@/lib/realizedProfit";

// Until orders came back from eBay, every profit number in this app was a
// projection built on a 13.25% + $0.40 fee model, and nothing had ever checked
// it against a real invoice. These tests hold the module that turns projections
// into facts.
//
// The rule they exist to protect: an unknown must never render as a zero. Three
// things can genuinely be unknown per order — acquisition cost, the fee on a
// fresh order, the buyer's payment — and each one silently treated as zero
// INFLATES profit. A profit figure that is too high is the one kind of error a
// seller will never go looking for.

const order = (over: Partial<RealizableOrder> = {}): RealizableOrder => ({
  orderId: "o1",
  creationDate: "2026-08-04T12:00:00.000Z",
  currency: "USD",
  buyerPaid: 100,
  marketplaceFee: 13.65,
  refunded: 0,
  cancelled: false,
  ...over,
});

describe("one order's outcome", () => {
  it("nets buyer paid less eBay's real fee", () => {
    const r = realize(order(), null);
    expect(r.net).toBe(86.35);
  });

  it("subtracts the acquisition cost to give profit and margin", () => {
    const r = realize(order(), 20);
    expect(r.profit).toBe(66.35);
    expect(r.margin).toBeCloseTo(0.6635, 4);
    expect(r.missing).toBeNull();
  });

  it("takes refunds out of the net", () => {
    expect(realize(order({ refunded: 25 }), 20).net).toBe(61.35);
  });

  it("leaves the fee alone when a refund happens", () => {
    // eBay credits fees on refunds separately and on its own schedule.
    // Subtracting a credit here would count it twice.
    const r = realize(order({ refunded: 100 }), 20);
    expect(r.net).toBe(-13.65);
  });
});

describe("what it refuses to guess", () => {
  it("reports no profit when the cost was never recorded", () => {
    // The tempting wrong answer is 86.35 — treating an unrecorded cost as free.
    const r = realize(order(), null);
    expect(r.profit).toBeNull();
    expect(r.missing).toBe("cost");
    // The net is still known and still useful, so it is still shown.
    expect(r.net).toBe(86.35);
  });

  it("reports nothing at all when eBay hasn't posted a fee yet", () => {
    const r = realize(order({ marketplaceFee: null }), 20);
    expect(r.net).toBeNull();
    expect(r.profit).toBeNull();
    expect(r.missing).toBe("fee");
  });

  it("reports nothing when eBay didn't say what the buyer paid", () => {
    const r = realize(order({ buyerPaid: null }), 20);
    expect(r.missing).toBe("revenue");
  });

  it("treats a cancelled order as a known zero, not an unknown", () => {
    const r = realize(order({ cancelled: true }), 20);
    expect(r.net).toBe(0);
    expect(r.profit).toBe(0);
    expect(r.missing).toBeNull();
  });
});

describe("a period's totals", () => {
  const costs: Record<string, number | null> = { a: 10, b: 25, c: null };
  const costOf = (o: RealizableOrder) => costs[o.orderId] ?? null;

  it("adds up gross, fees and net across orders", () => {
    const s = summarize(
      [
        order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65 }),
        order({ orderId: "b", buyerPaid: 50, marketplaceFee: 7.03 }),
      ],
      costOf
    );
    expect(s.orders).toBe(2);
    expect(s.gross).toBe(150);
    expect(s.fees).toBe(20.68);
    expect(s.net).toBe(129.32);
    expect(s.profit).toBe(94.32);
    expect(s.complete).toBe(true);
  });

  it("excludes an order with no recorded cost from profit, and says how many", () => {
    // The whole point. `c` contributes to gross and net — that money is real —
    // but folding it into profit would report its entire net as earnings.
    const s = summarize(
      [
        order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65 }),
        order({ orderId: "c", buyerPaid: 80, marketplaceFee: 11 }),
      ],
      costOf
    );
    expect(s.gross).toBe(180);
    expect(s.net).toBe(155.35);
    expect(s.profit).toBe(76.35); // order a only
    expect(s.profitBasis).toBe(86.35); // and the net it came from
    expect(s.unknownCost).toBe(1);
    expect(s.complete).toBe(false);
  });

  it("keeps cancellations out of the totals but counts them", () => {
    const s = summarize(
      [
        order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65 }),
        order({ orderId: "b", buyerPaid: 999, marketplaceFee: 99, cancelled: true }),
      ],
      costOf
    );
    expect(s.orders).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.gross).toBe(100);
    expect(s.complete).toBe(true);
  });

  it("holds an order with no posted fee out of every total, together", () => {
    // Letting it into gross but not into fees produced a strip whose gross,
    // fees and net visibly didn't subtract to each other. The money is still
    // reported — just separately, where it can't break the arithmetic.
    const s = summarize(
      [
        order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65 }),
        order({ orderId: "b", buyerPaid: 25, marketplaceFee: null }),
      ],
      costOf
    );
    expect(s.orders).toBe(1);
    expect(s.gross).toBe(100);
    expect(s.pending).toBe(1);
    expect(s.pendingGross).toBe(25);
    expect(s.complete).toBe(false);
  });

  it("keeps gross − fees − refunds exactly equal to net", () => {
    // The property a reader checks by eye, on every mix of orders.
    for (const orders of [
      [order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65 })],
      [
        order({ orderId: "a", buyerPaid: 100, marketplaceFee: 13.65, refunded: 10 }),
        order({ orderId: "c", buyerPaid: 80, marketplaceFee: 11 }),
        order({ orderId: "d", buyerPaid: 25, marketplaceFee: null }),
        order({ orderId: "e", buyerPaid: 60, marketplaceFee: 9, cancelled: true }),
      ],
    ]) {
      const s = summarize(orders, costOf);
      expect(s.net).toBeCloseTo(s.gross - s.fees - s.refunds, 2);
    }
  });

  it("does not round its way into a wrong total over many orders", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      order({ orderId: `x${i}`, buyerPaid: 19.99, marketplaceFee: 3.05 })
    );
    const s = summarize(many, () => 5);
    expect(s.gross).toBe(1999);
    expect(s.fees).toBe(305);
    expect(s.net).toBe(1694);
    expect(s.profit).toBe(1194);
  });

  it("survives an empty period without producing NaN", () => {
    const s = summarize([], costOf);
    expect(s).toMatchObject({ orders: 0, gross: 0, profit: 0, complete: true });
  });
});

describe("scoring our fee estimate against eBay's invoice", () => {
  // lib/fees.ts sits underneath every recommended price and break-even in the
  // app. This is the first thing that has ever checked it.
  it("finds the estimate close when eBay charges about what we predict", () => {
    const a = feeAccuracy([
      { buyerPaid: 100, marketplaceFee: 13.65, cancelled: false },
      { buyerPaid: 50, marketplaceFee: 7.03, cancelled: false },
    ]);
    expect(a.sampled).toBe(2);
    expect(a.close).toBe(true);
    expect(Math.abs(a.difference)).toBeLessThan(0.05);
  });

  it("flags an under-estimate, which is the direction that costs money", () => {
    // What promoted listings do: the real rate is well above 13.25%.
    const a = feeAccuracy([
      { buyerPaid: 100, marketplaceFee: 22, cancelled: false },
      { buyerPaid: 100, marketplaceFee: 22, cancelled: false },
    ]);
    expect(a.difference).toBeGreaterThan(0);
    expect(a.close).toBe(false);
    expect(a.impliedPercent).toBeCloseTo(0.22, 4);
  });

  it("ignores orders it cannot score rather than scoring them as zero", () => {
    const a = feeAccuracy([
      { buyerPaid: 100, marketplaceFee: null, cancelled: false },
      { buyerPaid: 100, marketplaceFee: 99, cancelled: true },
    ]);
    expect(a.sampled).toBe(0);
    expect(a.impliedPercent).toBeNull();
    // Nothing to judge is not the same as a bad estimate.
    expect(a.close).toBe(true);
  });
});

describe("grouping a year the way a seller reads it", () => {
  it("groups by calendar month, newest first", () => {
    const groups = byMonth([
      { creationDate: "2026-08-04T00:00:00Z" },
      { creationDate: "2026-07-30T00:00:00Z" },
      { creationDate: "2026-08-20T00:00:00Z" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["August 2026", "July 2026"]);
    expect(groups[0].orders).toHaveLength(2);
  });

  it("does not silently drop an order with an unreadable date", () => {
    const groups = byMonth([{ creationDate: "" }]);
    expect(groups[0].label).toBe("Undated");
    expect(groups[0].orders).toHaveLength(1);
  });
});
