export const CURRENCY_CODES = ["USD", "GBP", "EUR", "AUD", "CAD"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyOption {
  code: CurrencyCode;
  symbol: string;
  label: string;
  marketplaceId: string;
  listingHost: string;
}

// Common eBay selling currencies. USD is first: that's the tested default
// marketplace. The in-app Settings picker can switch the rest per device.
export const CURRENCIES: CurrencyOption[] = [
  {
    code: "USD",
    symbol: "$",
    label: "$ US dollars",
    marketplaceId: "EBAY_US",
    listingHost: "www.ebay.com",
  },
  {
    code: "GBP",
    symbol: "£",
    label: "£ British pounds",
    marketplaceId: "EBAY_GB",
    listingHost: "www.ebay.co.uk",
  },
  {
    code: "EUR",
    symbol: "€",
    label: "€ Euros",
    marketplaceId: "EBAY_DE",
    listingHost: "www.ebay.de",
  },
  {
    code: "AUD",
    symbol: "A$",
    label: "A$ Australian dollars",
    marketplaceId: "EBAY_AU",
    listingHost: "www.ebay.com.au",
  },
  {
    code: "CAD",
    symbol: "C$",
    label: "C$ Canadian dollars",
    marketplaceId: "EBAY_CA",
    listingHost: "www.ebay.ca",
  },
];

const FALLBACK: CurrencyCode = "USD";

export function defaultCurrency(): CurrencyCode {
  return resolveCurrency(
    process.env.NEXT_PUBLIC_EBAY_CURRENCY || process.env.EBAY_CURRENCY
  );
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && CURRENCY_CODES.includes(value as CurrencyCode);
}

/** Allowlist a client-supplied code; fall back to the deployment default. */
export function resolveCurrency(requested: unknown): CurrencyCode {
  const raw = typeof requested === "string" ? requested.trim().toUpperCase() : "";
  if (isCurrencyCode(raw)) return raw;
  const fallback = (
    process.env.NEXT_PUBLIC_EBAY_CURRENCY ||
    process.env.EBAY_CURRENCY ||
    FALLBACK
  )
    .trim()
    .toUpperCase();
  return isCurrencyCode(fallback) ? fallback : FALLBACK;
}

export function currencyOption(code?: unknown): CurrencyOption {
  const resolved = resolveCurrency(code);
  return CURRENCIES.find((c) => c.code === resolved) ?? CURRENCIES[0];
}

export function currencySymbol(code?: unknown): string {
  return currencyOption(code).symbol;
}

export function currencyCode(): CurrencyCode {
  return defaultCurrency();
}

export function formatMoney(
  value: number | string | undefined | null,
  fractionDigits = 2,
  code?: unknown
): string {
  const symbol = currencySymbol(code);
  const n = typeof value === "string" ? parseFloat(value) : value ?? undefined;
  if (n === undefined || Number.isNaN(n)) {
    return `${symbol}${(0).toFixed(fractionDigits)}`;
  }
  return `${symbol}${n.toFixed(fractionDigits)}`;
}

export function suggestedPriceGuidance(code?: unknown): string {
  const opt = currencyOption(code);
  const market =
    opt.code === "GBP"
      ? "eBay UK"
      : opt.code === "EUR"
        ? "eBay in euros"
        : opt.code === "AUD"
          ? "eBay Australia"
          : opt.code === "CAD"
            ? "eBay Canada"
            : "eBay US";
  return (
    `For suggested_price: Price realistically in ${opt.code} (${opt.symbol}) for what this exact item sells for on ${market}. ` +
    `Return a number only (e.g. 12.99), no currency symbol. Do not convert from another currency. Be honest. ` +
    `If the item can't be identified well enough to price it, use 0 — the seller will price it manually (a wrong guess is worse than no guess).`
  );
}
