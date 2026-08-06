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
}

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
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
export interface CompsSummary {
  ok: boolean;
  query: string;
  count: number;
  median?: number;
  trimmedMean?: number;
  low?: number;
  high?: number;
  confidence: number;
  basis: string;
  // Median with the deployment's PRICE_MARKUP_PERCENT applied — what the
  // "use median" button should set. Absent when no markup is configured.
  listPrice?: number;
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
