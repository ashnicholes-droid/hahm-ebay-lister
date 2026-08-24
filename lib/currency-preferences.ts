"use client";

import { defaultCurrency, isCurrencyCode, type CurrencyCode } from "./currency";

const KEY = "listing-writer:currency";

export function getCurrency(): CurrencyCode {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (isCurrencyCode(saved)) return saved;
  } catch {
    /* private browsing */
  }
  return defaultCurrency();
}

export function saveCurrency(code: CurrencyCode): void {
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    /* private browsing — pref won't persist */
  }
}
