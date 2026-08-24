import { describe, expect, test } from "vitest";
import {
  formatMoney,
  resolveCurrency,
  suggestedPriceGuidance,
} from "@/lib/currency";

describe("resolveCurrency", () => {
  test("accepts the three symbols' codes", () => {
    expect(resolveCurrency("gbp")).toBe("GBP");
    expect(resolveCurrency("USD")).toBe("USD");
    expect(resolveCurrency(" eur ")).toBe("EUR");
  });

  test("treats other dollar markets as $", () => {
    expect(resolveCurrency("AUD")).toBe("USD");
    expect(resolveCurrency("CAD")).toBe("USD");
  });

  test("falls back to USD for unknown values", () => {
    expect(resolveCurrency("yen")).toBe("USD");
    expect(resolveCurrency("")).toBe("USD");
    expect(resolveCurrency(undefined)).toBe("USD");
  });
});

describe("formatMoney", () => {
  test("uses the symbol only", () => {
    expect(formatMoney(12.5, 2, "GBP")).toBe("£12.50");
    expect(formatMoney(12.5, 2, "USD")).toBe("$12.50");
    expect(formatMoney(12.5, 2, "EUR")).toBe("€12.50");
  });
});

describe("suggestedPriceGuidance", () => {
  test("asks the model for the selected symbol", () => {
    expect(suggestedPriceGuidance("GBP")).toMatch(/pound/i);
    expect(suggestedPriceGuidance("USD")).toMatch(/dollar/i);
  });
});
