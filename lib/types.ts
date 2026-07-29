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
  mediaType: string;
  data: string;
  previewUrl: string;
}

export type ItemStatus =
  | "idle"
  | "writing"
  | "done"
  | "error";

export type PostStatus =
  | "idle"
  | "saving"
  | "draft-saved"
  // Published live and enrolled in a Promoted Listings campaign.
  | "published"
  | "error";

// Which action is in flight / produced the current state. Both buttons share
// postStatus, so without this each one can't tell whether the spinner is its own.
export type PostMode = "draft" | "promote";

export interface ItemGroup {
  id: string;
  sku: string;
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;

  // eBay draft state
  postStatus?: PostStatus;
  postMode?: PostMode;
  offerId?: string;
  listingId?: string;
  postError?: string;

  // Promote-only. A listing can go live but fail to enrol in the ad campaign,
  // so promoted=false with a reason is a distinct outcome from success.
  promoted?: boolean;
  promoteError?: string;
}