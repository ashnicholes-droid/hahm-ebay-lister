"use client";

// Reading and writing the pricing rules in the browser.
//
// localStorage rather than a database, for the same reason the rest of this app
// has no database: there isn't one, and a handful of numbers per person doesn't
// justify adding one. The trade-off is real and worth stating — these settings
// live on the device that set them, so changing them on a laptop doesn't change
// them on a phone.
//
// Kept apart from lib/pricingRules.ts so the rule itself stays a pure function
// that tests and server code can use without touching storage.

import { RULES_STORAGE_KEY, normalizeRules, type PricingRules } from "./pricingRules";

/** Load the saved rules, falling back to defaults on anything unreadable. */
export function loadRules(): PricingRules {
  try {
    const raw = localStorage.getItem(RULES_STORAGE_KEY);
    if (!raw) return normalizeRules(null);
    return normalizeRules(JSON.parse(raw));
  } catch {
    // Private browsing, disabled storage, or corrupt JSON. Defaults are always
    // a working answer, so none of these is worth an error message.
    return normalizeRules(null);
  }
}

export function saveRules(rules: PricingRules): boolean {
  try {
    localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(normalizeRules(rules)));
    // Same-tab listeners don't get the storage event, so fire our own. This is
    // what lets a card reprice the moment settings change.
    window.dispatchEvent(new CustomEvent(RULES_CHANGED));
    return true;
  } catch {
    return false;
  }
}

/** Fired on this tab when the rules change; `storage` covers other tabs. */
export const RULES_CHANGED = "listing-writer:pricing-rules-changed";
