import { describe, expect, test } from "vitest";
import {
  formatMoney,
  resolveCurrency,
  suggestedPriceGuidance,
} from "@/lib/currency";

describe("resolveCurrency", () => {
  test("accepts common marketplace codes", () => {
    expect(resolveCurrency("gbp")).toBe("GBP");
    expect(resolveCurrency("USD")).toBe("USD");
    expect(resolveCurrency(" eur ")).toBe("EUR");
    expect(resolveCurrency("AUD")).toBe("AUD");
    expect(resolveCurrency("CAD")).toBe("CAD");
  });

  test("falls back to USD for unknown values", () => {
    expect(resolveCurrency("yen")).toBe("USD");
    expect(resolveCurrency("")).toBe("USD");
    expect(resolveCurrency(undefined)).toBe("USD");
  });
});

describe("formatMoney", () => {
  test("uses the requested symbol", () => {
    expect(formatMoney(12.5, 2, "GBP")).toBe("£12.50");
    expect(formatMoney(12.5, 2, "USD")).toBe("$12.50");
    expect(formatMoney(12.5, 2, "EUR")).toBe("€12.50");
    expect(formatMoney(12.5, 2, "AUD")).toBe("$12.50");
    expect(formatMoney(12.5, 2, "CAD")).toBe("$12.50");
  });
});

describe("suggestedPriceGuidance", () => {
  test("asks the model for the selected currency", () => {
    expect(suggestedPriceGuidance("GBP")).toMatch(/GBP/);
    expect(suggestedPriceGuidance("USD")).toMatch(/USD/);
  });
});
