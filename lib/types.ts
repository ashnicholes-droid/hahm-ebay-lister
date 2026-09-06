import type { AspectMeta } from "./ebay/taxonomy";
import type { AiUsage } from "./ai-usage";
import type { ShippingSelection } from "./validation";
// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  ebay_condition?: string;
  evidence?: Record<string, number[]>;
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
  search_terms?: string[];
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
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
  original?: Blob;
  uploadData?: string;
  analysisSelected?: boolean;
  data: string; // base64, no prefix
}

export type ItemStatus = "idle" | "writing" | "done" | "error";

export type PostStatus = "idle" | "posting" | "posted" | "error";

// Market price check from active eBay comps (see lib/ebay/comps.ts). Advisory:
// shown beside the AI's estimate so the seller prices with real data in view.
export interface CompsSummary {
  ok: boolean;
  sources?: {
    id: string;
    title: string;
    url: string;
    price: number;
    shipping?: number;
    total?: number;
    condition: string;
  }[];
  checkedAt?: string;
  matchBasis?: string;
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
  cloudBatchId?: string;
  id: string;
  sku: string; // bin reference, e.g. "K75-A"
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;
  error?: string;
  analysisPhotoIds?: string[];
  preparation?: PreparedCategory;
  preparationError?: string;
  usage?: AiUsage[];
  compsStatus?: "loading" | "unavailable" | "ready" | "stale";
  shipping?: Partial<ShippingSelection>;
  imageUrls?: string[];
  uploadedPhotoIds?: string[];
  publicationAttemptSku?: string;
  evidencePhotoIds?: string[];
  // Market price check (fetched right after the listing is written)
  comps?: CompsSummary;
  // eBay posting state (Phase 2)
  postStatus?: PostStatus;
  listingId?: string;
  postError?: string;
  // Non-fatal quality warnings from the last publish (e.g. schema unavailable)
  postWarnings?: string[];
}

export interface PreparedCategory {
  suggestions?: import("./ebay/taxonomy").CategorySuggestion[];
  categoryId: string;
  categoryName: string;
  aspects: AspectMeta[];
  conditions: { value: string; label: string }[];
  expiresAt: number;
  signature: string;
  issues: string[];
}
