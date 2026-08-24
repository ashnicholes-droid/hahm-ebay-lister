export const CURRENCY_CODES = ["USD", "GBP", "EUR", "AUD", "CAD"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyOption {
  code: CurrencyCode;
  symbol: string;
  label: string;
}

export const CURRENCIES: CurrencyOption[] = [
  { code: "USD", symbol: "$", label: "$ US dollars" },
  { code: "GBP", symbol: "£", label: "£ British pounds" },
  { code: "EUR", symbol: "€", label: "€ Euros" },
  { code: "AUD", symbol: "A$", label: "A$ Australian dollars" },
  { code: "CAD", symbol: "C$", label: "C$ Canadian dollars" },
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
  return (
    `For suggested_price: Price realistically in ${opt.code} (${opt.symbol}). ` +
    `Return a number only (e.g. 12.99), no currency symbol. Be honest. ` +
    `If the item can't be identified well enough to price it, use 0 — the seller will price it manually (a wrong guess is worse than no guess).`
  );
}
