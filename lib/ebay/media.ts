// Uploading listing photos to eBay Picture Services via the Media API.
//
// Why this exists: eBay is decommissioning UploadSiteHostedPictures — the
// Trading-API call this app has always used — on 30 September 2026. It was
// deprecated in November 2025 and has been returning deprecation warnings in
// its response headers since. After that date the call fails, and since every
// photo of every listing goes through it, posting stops working.
//
// The replacement is the Media API's create_image_from_file: same idea, same
// multipart upload, a REST endpoint instead of an XML one. It runs on the
// `sell.inventory` scope, which is already one of this app's core scopes — so
// no reconnect, no new permission, and none of the invalid_scope trouble a new
// scope would bring.
//
// ⚠️ Written from eBay's docs and NOT yet exercised against a live account.
// Two details resisted confirmation: the exact path under /image, and whether
// the EPS URL comes back in the body or only via the Location header. Both are
// handled defensively below, and lib/ebay/publish.ts falls back to the old call
// when this one doesn't produce a URL — so being wrong costs a wasted request
// rather than a broken publish, right up until eBay switches the old one off.

/**
 * Media API root. Sandbox swaps in apim.sandbox.ebay.com.
 *
 * Overridable so the host can be corrected without a code change if eBay's docs
 * turn out to disagree with eBay's servers.
 */
export const EBAY_MEDIA_BASE =
  process.env.EBAY_MEDIA_BASE || "https://apim.ebay.com/commerce/media/v1_beta";

/** The day UploadSiteHostedPictures stops working. */
export const TRADING_UPLOAD_SUNSET = "2026-09-30";

/**
 * Which upload path to use.
 *
 * "auto" (the default) tries the Media API and falls back to Trading, which is
 * the only safe posture while the new path is unproven and the old one still
 * works. The other two exist to force a decision — "media" to prove the new
 * path end to end, "trading" to get back to known-good behaviour immediately if
 * something is badly wrong.
 */
export type UploadMode = "auto" | "media" | "trading";

export function uploadMode(raw = process.env.EBAY_PHOTO_UPLOAD): UploadMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "media" || v === "trading" ? v : "auto";
}

export interface MediaUploadResult {
  /** The EPS URL to put in the listing, or null when this path didn't work. */
  url: string | null;
  /** eBay's own words, kept so a failure can be read rather than guessed at. */
  debug?: {
    httpStatus: number;
    endpoint: string;
    location?: string;
    body?: string;
  };
}

/**
 * Pull the EPS image URL out of whatever shape eBay returns.
 *
 * Deliberately tolerant. The docs describe a 201 with the image URL in the
 * response payload AND a getImage URI in the Location header, and the field
 * naming isn't nailed down in anything I could read directly. Rather than bet
 * on one shape, this accepts the plausible ones and reports null when none
 * matched, which the caller treats as "fall back".
 *
 * The Location header is NOT usable as a listing image on its own — it points
 * at the Media API resource, not at the picture — so it is only returned as a
 * last resort for the caller to resolve.
 */
export function imageUrlFromMediaResponse(
  json: unknown,
  locationHeader?: string | null
): { imageUrl: string | null; imageId: string | null } {
  const j = (json ?? {}) as Record<string, any>;
  const candidates = [j.imageUrl, j.image?.imageUrl, j.imageUrls?.[0], j.url];
  const imageUrl = candidates.find(
    (c) => typeof c === "string" && /^https?:\/\//i.test(c)
  ) as string | undefined;

  // The image id is the last path segment of the Location URI.
  const fromHeader = locationHeader?.trim().replace(/\/+$/, "").split("/").pop();
  const imageId =
    (typeof j.imageId === "string" && j.imageId) ||
    (fromHeader && fromHeader !== "image" ? fromHeader : null) ||
    null;

  return { imageUrl: imageUrl ?? null, imageId };
}

/**
 * Upload one photo and return its EPS URL.
 *
 * Mirrors the old Trading call exactly in what it takes and what it gives back:
 * base64 in, a URL string or null out. Everything downstream — the four-way
 * concurrency, the SKU-based naming, the twelve-photo cap — is untouched.
 */
export async function uploadImageViaMedia(
  accessToken: string,
  base64: string,
  mediaType: string,
  name: string
): Promise<MediaUploadResult> {
  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  const bytes = Buffer.from(data, "base64");
  const endpoint = `${EBAY_MEDIA_BASE}/image/create_image_from_file`;

  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    body: form,
  });

  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 201 with an empty body is expected — the URL may be header-only */
  }

  if (!resp.ok) {
    return {
      url: null,
      debug: {
        httpStatus: resp.status,
        endpoint,
        body: text.slice(0, 600),
      },
    };
  }

  const location = resp.headers.get("location");
  const { imageUrl, imageId } = imageUrlFromMediaResponse(json, location);
  if (imageUrl) return { url: imageUrl };

  // A 201 with only an id means one more call to turn it into a picture URL.
  if (imageId) {
    const got = await fetch(`${EBAY_MEDIA_BASE}/image/${encodeURIComponent(imageId)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const gotText = await got.text();
    if (got.ok) {
      try {
        const resolved = imageUrlFromMediaResponse(JSON.parse(gotText), null);
        if (resolved.imageUrl) return { url: resolved.imageUrl };
      } catch {
        /* fall through to the failure below */
      }
    }
    return {
      url: null,
      debug: {
        httpStatus: got.status,
        endpoint: `${EBAY_MEDIA_BASE}/image/${imageId}`,
        location: location ?? undefined,
        body: gotText.slice(0, 600),
      },
    };
  }

  // Accepted, but nothing usable came back. Worth reporting rather than
  // retrying blindly — the response shape is the thing still unconfirmed.
  return {
    url: null,
    debug: {
      httpStatus: resp.status,
      endpoint,
      location: location ?? undefined,
      body: text.slice(0, 600),
    },
  };
}
