import { describe, expect, it } from "vitest";
import {
  chipLabel,
  chipTone,
  DEFAULT_SCOUT_SETTINGS,
  MIN_COMPS_FOR_VERDICT,
  maxBuyPrice,
  netAtDelivered,
  normalizeScoutSettings,
  planningPrice,
  scout,
  verdictLabel,
  type CompBand,
  type ScoutSettings,
} from "@/lib/scout";
import { finalValueFee } from "@/lib/fees";

// Deciding whether to buy something, standing in a shop with fifteen seconds.
//
// This is the highest-stakes arithmetic in the app, because it's the only screen
// whose output is spent on an item you cannot return. Two rules matter more than
// the rest:
//
//   1. A thin comp set produces NO verdict. Pricing off two listings and calling
//      it a buy is how a scouting tool talks someone into a bad purchase.
//   2. Active comps are ASKING prices, so the plan is deliberately pessimistic.
//      Over-estimating costs real money; under-estimating costs a missed deal.

const band = (over: Partial<CompBand> = {}): CompBand => ({
  pricedCount: 12,
  low: 30,
  median: 45,
  high: 70,
  ...over,
});

const settings = (over: Partial<ScoutSettings> = {}): ScoutSettings => ({
  ...DEFAULT_SCOUT_SETTINGS,
  ...over,
});

describe("what price to plan on", () => {
  it("plans on the low end, not the median", () => {
    // The pessimistic default: half the market sits above the median unsold.
    const p = planningPrice(band(), settings())!;
    expect(p).toBeLessThan(band().median!);
    expect(p).toBe(30);
  });

  it("does not stack the haircut on top of the low end", () => {
    // The two settings are two ways of making the SAME correction for active
    // comps being asking prices. Applying both planned on $26.40 against a band
    // whose cheapest listing was $30 — below every comp in the set — and turned
    // a good $4 buy into "your call". Conservative is the point; impossible is
    // not.
    const band30to70 = band();
    expect(planningPrice(band30to70, settings({ basis: "low" }))).toBe(30);
    expect(planningPrice(band30to70, settings({ basis: "low", haircut: 0.5 }))).toBe(30);
    expect(planningPrice(band30to70, settings())).toBeGreaterThanOrEqual(band30to70.low!);
  });

  it("applies the haircut to the median, which genuinely is too high", () => {
    expect(planningPrice(band(), settings({ basis: "median" }))).toBeCloseTo(45 * 0.88, 2);
    expect(planningPrice(band(), settings({ basis: "median", haircut: 0 }))).toBe(45);
  });

  it("refuses to plan on too few comps", () => {
    for (let n = 0; n < MIN_COMPS_FOR_VERDICT; n++) {
      expect(planningPrice(band({ pricedCount: n }), settings())).toBeNull();
    }
    expect(planningPrice(band({ pricedCount: MIN_COMPS_FOR_VERDICT }), settings())).not.toBeNull();
  });

  it("falls back to a haircut median when the band has no low end", () => {
    // Keeps the conservative intent of the low basis when there's no low end
    // to read — an uncorrected median would be the optimistic answer.
    expect(planningPrice(band({ low: undefined }), settings())).toBeCloseTo(45 * 0.88, 2);
  });

  it("refuses a band of zeroes rather than planning on nothing", () => {
    expect(planningPrice(band({ low: 0, median: 0 }), settings())).toBeNull();
  });
});

describe("net proceeds", () => {
  it("takes eBay's fee and the postage off the delivered price", () => {
    expect(netAtDelivered(50, 8)).toBeCloseTo(50 - finalValueFee(50) - 8, 2);
  });

  it("is the same whether the buyer pays postage or you do", () => {
    // Non-obvious and worth pinning: comps are DELIVERED prices and eBay's fee
    // is charged on the order total either way, so the arrangement washes out.
    // This is why the scout screen has no free-vs-paid toggle.
    const delivered = 50;
    const postage = 8;
    const freeShipping = delivered - finalValueFee(delivered) - postage;
    const buyerPays = delivered - postage - finalValueFee(delivered) + postage - postage;
    expect(netAtDelivered(delivered, postage)).toBeCloseTo(freeShipping, 2);
    expect(freeShipping).toBeCloseTo(buyerPays, 2);
  });
});

describe("the most you should pay", () => {
  it("is limited by the flat minimum on a cheap item", () => {
    // net $20. The ROI rule would allow $10 (double your money), but paying $10
    // leaves only $10 profit — under the $12 floor. So $8 is the real ceiling.
    expect(maxBuyPrice(20, settings({ minProfit: 12, minRoi: 1 }))).toBe(8);
  });

  it("is limited by the ROI rule on an expensive item", () => {
    // net $300. The $12 floor would allow $288, but that's a 4% return. The
    // doubling rule caps it at $150 — which is the point of having both rules:
    // on cheap items the flat minimum binds, on dear ones the ratio does.
    expect(maxBuyPrice(300, settings({ minProfit: 12, minRoi: 1 }))).toBe(150);
    // Loosen the ratio and the flat minimum takes over again.
    expect(maxBuyPrice(300, settings({ minProfit: 50, minRoi: 0.1 }))).toBe(250);
  });

  it("reports nothing payable when the item can't clear the rules at any price", () => {
    expect(maxBuyPrice(5, settings({ minProfit: 12, minRoi: 1 }))).toBeNull();
  });
});

describe("the verdict", () => {
  it("says buy when both rules clear", () => {
    const r = scout({ band: band(), shipping: 5, asking: 4 });
    expect(r.verdict).toBe("buy");
    expect(r.profit).toBeGreaterThan(0);
    expect(r.reason).toMatch(/clears both your rules/);
  });

  it("says skip when you'd lose money, and names the price that would work", () => {
    const r = scout({ band: band(), shipping: 5, asking: 40 });
    expect(r.verdict).toBe("skip");
    expect(r.profit).toBeLessThan(0);
    expect(r.reason).toMatch(/Worth it under \$/);
  });

  it("says your call when it's profitable but under a rule", () => {
    // The judgement a person should make, not one the arithmetic should make
    // for them: a small profit on a cheap item may still be worth a slow day.
    const r = scout({
      band: band({ low: 22, median: 26 }),
      shipping: 5,
      asking: 6,
      settings: settings({ minProfit: 12, minRoi: 1 }),
    });
    expect(r.verdict).toBe("marginal");
    expect(r.profit).toBeGreaterThan(0);
    expect(r.reason).toMatch(/Your call/);
  });

  it("gives no verdict at all on a thin comp set", () => {
    // The rule that matters most. Two listings is not a market.
    const r = scout({ band: band({ pricedCount: 2 }), shipping: 5, asking: 3 });
    expect(r.verdict).toBe("unknown");
    expect(r.blocked).toBe("no-comps");
    expect(r.expectedSale).toBeNull();
    expect(r.profit).toBeNull();
    // And it says so in words a person can act on.
    expect(r.reason).toMatch(/too few to judge/);
  });

  it("distinguishes 'no comps at all' from 'not enough comps'", () => {
    expect(scout({ band: band({ pricedCount: 0 }), shipping: 5, asking: 3 }).reason).toMatch(
      /No comparable listings/
    );
  });

  it("gives you the max-buy price before you've even looked at the sticker", () => {
    // The most useful state in a shop: you know what it's worth before you know
    // what they want for it.
    const r = scout({ band: band(), shipping: 5, asking: null });
    expect(r.blocked).toBe("no-price");
    expect(r.maxBuy).toBeGreaterThan(0);
    expect(r.reason).toMatch(/Pay up to \$/);
    // The sale-side figures are known and shown even without a price.
    expect(r.expectedSale).not.toBeNull();
    expect(r.net).not.toBeNull();
  });

  it("skips an item whose postage exceeds what it sells for", () => {
    const r = scout({ band: band({ low: 8, median: 10 }), shipping: 14, asking: 1 });
    expect(r.verdict).toBe("skip");
    expect(r.net).toBeLessThanOrEqual(0);
    expect(r.reason).toMatch(/eat the whole sale price/);
  });

  it("treats a free item as pure profit without dividing by zero", () => {
    const r = scout({ band: band(), shipping: 5, asking: 0 });
    expect(r.verdict).toBe("buy");
    expect(Number.isFinite(r.profit!)).toBe(true);
    expect(r.roi).toBeNull();
  });

  it("never reports a profit it can't stand behind", () => {
    // Across a wide sweep, profit and roi are either both real or both absent.
    for (const pricedCount of [0, 1, 2, 3, 20]) {
      for (const asking of [null, 0, 5, 500]) {
        const r = scout({ band: band({ pricedCount }), shipping: 6, asking });
        if (r.profit !== null) {
          expect(Number.isFinite(r.profit)).toBe(true);
          expect(r.expectedSale).not.toBeNull();
        }
        if (r.verdict === "unknown") expect(r.blocked).not.toBeNull();
        else expect(r.blocked).toBeNull();
      }
    }
  });
});

describe("settings", () => {
  it("falls back to sane defaults for junk", () => {
    expect(normalizeScoutSettings(null)).toEqual(DEFAULT_SCOUT_SETTINGS);
    expect(normalizeScoutSettings({ minProfit: NaN, minRoi: undefined })).toEqual(
      DEFAULT_SCOUT_SETTINGS
    );
  });

  it("accepts numbers typed as strings, the way an input gives them", () => {
    const s = normalizeScoutSettings({ minProfit: "20" as unknown as number });
    expect(s.minProfit).toBe(20);
  });

  it("clamps a haircut that would make every item look worthless", () => {
    expect(normalizeScoutSettings({ haircut: 5 }).haircut).toBeLessThanOrEqual(0.9);
    expect(normalizeScoutSettings({ haircut: -1 }).haircut).toBe(0);
  });
});

describe("labels", () => {
  it("names each verdict in words that fit a chip", () => {
    expect(verdictLabel("buy")).toBe("BUY");
    expect(verdictLabel("marginal")).toBe("YOUR CALL");
    expect(verdictLabel("skip")).toBe("SKIP");
    expect(verdictLabel("unknown")).toBe("CAN'T TELL");
  });
});

describe("what the chip says", () => {
  // Two states both come back as "unknown" and mean opposite things to someone
  // holding the item. Labelling them the same was a real defect: the screen
  // showed "CAN'T TELL" directly above a confident "Pay up to $4.52".
  it("says CAN'T TELL only when the market data really isn't there", () => {
    const r = scout({ band: band({ pricedCount: 1 }), shipping: 5, asking: 3 });
    expect(chipLabel(r)).toBe("CAN'T TELL");
    expect(chipTone(r)).toBe("unknown");
  });

  it("asks for the price when that's the only thing missing", () => {
    const r = scout({ band: band(), shipping: 5, asking: null });
    expect(chipLabel(r)).toBe("ADD PRICE");
    expect(chipTone(r)).toBe("waiting");
    // And it is genuinely not an absence of knowledge.
    expect(r.maxBuy).toBeGreaterThan(0);
  });

  it("shows the real verdict once a price is in", () => {
    const r = scout({ band: band(), shipping: 5, asking: 4 });
    expect(chipLabel(r)).toBe("BUY");
    expect(chipTone(r)).toBe("buy");
  });
});
