import type { VerificationReport } from "@/lib/verification";
import type { ShippingEstimate } from "@/lib/shipping/estimate";

// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  brand?: string;
  item_type?: string;
  color?: string[] | string;
  size?: string;
  material?: string;
  condition?: string;
  condition_notes?: string;
  measurements?: string;
  description: string;
  suggested_price?: number | string;
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
  // The ITEM alone, unpackaged, as read or judged from the photos. The shipping
  // estimator adds box, padding, and fill (see lib/shipping/estimate.ts). Zero
  // or absent means "couldn't tell" and falls back to a category profile.
  shipping_weight_oz?: number | string;
  shipping_length_in?: number | string;
  shipping_width_in?: number | string;
  shipping_height_in?: number | string;
  // Who pays postage. true = free to the buyer (you absorb it), false = buyer
  // pays. Undefined means "no preference": publish keeps using whatever
  // fulfillment policy the account lists first, which is the old behaviour.
  shipping_free?: boolean;
  // The seller's chosen service + container, e.g. "priority_flat_rate:usps-fre".
  // Absent means "whatever is cheapest", which is the default and what most
  // items should stay on. See lib/shipping/estimate.ts `optionId`.
  shipping_option_id?: string;
  /**
   * Postage cost the seller is fixing by hand, in dollars.
   *
   * The estimate is a national-average table, not a quote. A seller who knows
   * what their label actually costs — a negotiated rate, a regional zone, a
   * carrier the app doesn't model — should be able to say so, and have every
   * margin figure use it. Empty means "use the estimate".
   */
  shipping_cost_override?: number | string;
  // Multiples of an identical item. Opt-in: unless `multi_quantity` is exactly
  // true, this publishes as a single unique item and `quantity` is ignored
  // entirely. See lib/quantity.ts — nothing should read these fields raw.
  //
  // The model never sets these. Whether you have five of something is a fact
  // about your shelf, not about the photograph, so guessing it from pixels
  // would only ever oversell stock that isn't there.
  multi_quantity?: boolean;
  quantity?: number | string;
  /** Percent off each item at the multi-buy tier. Absent/0 = no discount. */
  volume_discount_percent?: number | string;
  /** Units a buyer must take to earn the discount. Defaults to 2. */
  volume_discount_min?: number | string;
}

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
  /**
   * What the seller says the item is, when they're correcting a wrong
   * identification. Treated as established fact about the item's identity —
   * see buildIdentityHint in lib/prompts.ts.
   */
  hint?: string;
  // Optional model overrides; server falls back to its defaults when omitted.
  analysisModel?: string;
  routerModel?: string;
}

export interface AnalyzeResponse {
  ok: boolean;
  listing?: ListingResult;
  error?: string;
}

export interface SortResponse {
  ok: boolean;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────

export interface Photo {
  id: string;
  previewUrl: string;
  mediaType: string;
  data: string; // base64, no prefix
  // Inventory number read from a QR label in this photo during import. Its
  // presence is what makes the photo an item delimiter (see lib/qrGrouping.ts).
  sku?: string;
}

export type ItemStatus = "idle" | "writing" | "done" | "error";

export type PostStatus = "idle" | "posting" | "posted" | "error";

// Market price check from active eBay comps (see lib/ebay/comps.ts). Advisory:
// shown beside the AI's estimate so the seller prices with real data in view.
/** One comparable active listing, reduced to what a buyer actually pays. */
export interface Comp {
  title: string;
  /** The asking price on its own. */
  itemPrice: number;
  /** What the buyer is charged for postage; null when quoted at checkout. */
  shippingCost: number | null;
  shippingType: "free" | "flat" | "calculated" | "unknown";
  /** itemPrice + postage. Null when postage isn't knowable from here. */
  delivered: number | null;
  condition: string;
  url: string;
  imageUrl: string;
}

export interface CompsSummary {
  ok: boolean;
  query: string;
  /** Every comp that survived filtering, including ones with no delivered price. */
  count: number;
  /** How many actually fed the band — the rest quote postage at checkout. */
  pricedCount?: number;
  /** The comps themselves, cheapest delivered first, for the review popup. */
  comps?: Comp[];
  median?: number;
  trimmedMean?: number;
  low?: number;
  high?: number;
  confidence: number;
  basis: string;
  // Median with the deployment's PRICE_MARKUP_PERCENT applied — what the
  // "use median" button should set. Absent when no markup is configured.
  listPrice?: number;
  /** The deployment's storewide markup, so the card can apply it to its own rule. */
  markupPercent?: number;
}

/** Mirrors PublishDebug in lib/ebay/publish.ts — kept here so client code can
 *  hold it without importing the server publish module. */
export interface PublishDebug {
  stage: string;
  httpStatus: number;
  sku: string;
  conditionSent?: string;
  categoryId?: string;
  errors: {
    errorId: number;
    domain?: string;
    category?: string;
    message?: string;
    longMessage?: string;
    parameters?: { name: string; value: string }[];
  }[];
  raw?: string;
}

export interface ItemGroup {
  id: string;
  sku: string; // bin reference, e.g. "K75-A"
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;
  error?: string;
  // Market price check (fetched right after the listing is written)
  comps?: CompsSummary;
  // eBay posting state (Phase 2)
  postStatus?: PostStatus;
  listingId?: string;
  postError?: string;
  // Everything eBay said about the failure — its error ids, long messages, and
  // the `parameters` that usually name the actual problem (which aspect, which
  // condition ids the category allows). Shown behind a disclosure on the card
  // so an unclear rejection can be read instead of guessed at.
  postDebug?: PublishDebug;
  // Non-fatal quality warnings from the last publish (e.g. schema unavailable)
  postWarnings?: string[];
  // Accuracy check over the listing as it currently stands (see lib/verification.ts).
  verification?: VerificationReport;
  verifying?: boolean;
  // Set when this item came from a QR label rather than the AI sorter.
  markerPhotoId?: string;
  // Packaging + cost estimate, recomputed whenever the weight/size fields change.
  shipping?: ShippingEstimate;
}
