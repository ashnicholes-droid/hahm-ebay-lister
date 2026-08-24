// Where your parcels ship FROM.
//
// This is not cosmetic. eBay quotes calculated shipping from the postal code on
// your inventory location, so a wrong one quotes every buyer from the wrong
// place — and the gap is money, in whichever direction it falls.
//
// It was previously only settable through EBAY_LOCATION_POSTAL_CODE, and only
// read when the app had to CREATE a location. Any account that already had one
// — which is every account that has ever published — ignored the variable
// entirely and kept whatever it was first given, which for a deployment that
// never set the variable was the hardcoded fallback: 10001, Manhattan.
//
// Worse, eBay does not allow an existing location's address to be edited at
// all. updateInventoryLocation can change the name, phone and opening hours,
// and explicitly cannot change the address. So "fix my ZIP" genuinely means
// "select or create a different location", which is what resolveLocation does.

/** The last-resort default, kept only so a first publish can't fail outright. */
export const FALLBACK_POSTAL_CODE = "10001";

export const SHIP_FROM_COOKIE = "lw_ship_from";
/** Matches the eBay connection's lifetime, so the two expire together. */
export const SHIP_FROM_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * A US ZIP, normalised to five digits.
 *
 * ZIP+4 is accepted and truncated: eBay wants the five-digit form, and a seller
 * copying their full postal code shouldn't be told they're wrong.
 */
export function normalizeZip(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(s);
  return m ? m[1] : null;
}

export function validateZip(raw: unknown): { zip: string } | { error: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "Enter a ZIP code." };
  const zip = normalizeZip(s);
  if (!zip) {
    return {
      error: "That isn't a US ZIP code. Use five digits, like 19446.",
    };
  }
  return { zip };
}

/** eBay's key rules: letters, digits, underscore and hyphen, up to 36 chars. */
export function locationKeyForZip(zip: string): string {
  return `SHIPFROM_${zip}`;
}

export interface EbayLocation {
  merchantLocationKey?: string;
  merchantLocationStatus?: string;
  location?: { address?: { postalCode?: string } };
}

export interface LocationChoice {
  /** The key to send on the offer. */
  key: string | null;
  /** The ZIP that key actually ships from, when known. */
  zip: string | null;
  /** True when a location has to be created because none matches. */
  mustCreate: boolean;
  /**
   * True when a location was picked that does NOT match the requested ZIP —
   * the case worth telling the seller about, since their listings are quoting
   * from somewhere they didn't choose.
   */
  mismatch: boolean;
}

/**
 * Pick which inventory location to publish against.
 *
 * The old rule was "the first ENABLED location eBay returns", in whatever order
 * eBay returned them. That is why setting the ZIP appeared to do nothing: the
 * setting was consulted only at creation, and creation only happens once.
 *
 * Now a requested ZIP wins outright — an existing location that matches is
 * reused, and one is created if none does. Without a requested ZIP the old
 * behaviour stands, so nothing changes for anyone who hasn't set this.
 */
export function resolveLocation(
  locations: EbayLocation[],
  requestedZip: string | null
): LocationChoice {
  const enabled = locations.filter(
    (l) => l.merchantLocationStatus === "ENABLED" && l.merchantLocationKey
  );

  const zipOf = (l: EbayLocation) => normalizeZip(l.location?.address?.postalCode);

  if (requestedZip) {
    const match = enabled.find((l) => zipOf(l) === requestedZip);
    if (match) {
      return {
        key: match.merchantLocationKey!,
        zip: requestedZip,
        mustCreate: false,
        mismatch: false,
      };
    }
    // Nothing on the account ships from there yet. Create it rather than
    // quietly using a location from a different town.
    return {
      key: locationKeyForZip(requestedZip),
      zip: requestedZip,
      mustCreate: true,
      mismatch: false,
    };
  }

  const first = enabled[0];
  if (first) {
    return {
      key: first.merchantLocationKey!,
      zip: zipOf(first),
      mustCreate: false,
      mismatch: false,
    };
  }

  return { key: null, zip: null, mustCreate: true, mismatch: false };
}
