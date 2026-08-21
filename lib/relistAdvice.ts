// Whether a listing should be relisted at all.
//
// Pure data and judgement, with no eBay client behind it, so the seller view
// can import it directly. lib/ebay/relist.ts reaches process.env through
// lib/ebay/config.ts and would break a client component — the same reason
// lib/ebay/scopes.ts exists apart from that config.
//
// This lives on its own rather than inside triage.ts because it answers the
// opposite question: triage says "this listing isn't working", and this says
// "and relisting is still the wrong fix". The two disagree often, deliberately.

export interface RelistAdvice {
  /** True when relisting would throw away something worth keeping. */
  discourage: boolean;
  /** Why, in the seller's terms. Empty when there's nothing to warn about. */
  warning: string;
}

/**
 * Should this listing be relisted?
 *
 * Worth saying out loud because the honest answer is often no, and the app is
 * the only thing positioned to say so before the click rather than after.
 * Watchers are the case that matters: a relist discards them, and they are the
 * people most likely to buy — the app already has a "send an offer" control
 * aimed at exactly those listings.
 */
export function relistAdvice(listing: {
  watchCount: number | null;
  quantitySold: number | null;
}): RelistAdvice {
  const watchers = listing.watchCount ?? 0;
  if (watchers > 0) {
    return {
      discourage: true,
      warning:
        `Relisting drops ${watchers === 1 ? "the 1 watcher" : `all ${watchers} watchers`} ` +
        `and starts over. Those are the people most likely to buy — send them an offer first.`,
    };
  }
  if ((listing.quantitySold ?? 0) > 0) {
    return {
      discourage: true,
      warning: "This listing has already sold at least one. Ending it stops a working listing.",
    };
  }
  return { discourage: false, warning: "" };
}
