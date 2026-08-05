import { NextRequest, NextResponse } from "next/server";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { isEbayConfigured } from "@/lib/ebay/config";
import { buildListingPreview } from "@/lib/ebay/preview";
import { sanitizeEbayImageUrls } from "@/lib/ebay/publish";
import type { ListingResult } from "@/lib/types";

// Runs server-side on purpose. The preview is only worth looking at if it's
// built by the same code and the same live eBay taxonomy lookup that publishing
// uses, and that means the eBay credentials — which live on the server.
export const maxDuration = 60;

interface PreviewBody {
  sku?: string;
  listing?: ListingResult;
  imageUrls?: unknown;
  photoCount?: unknown;
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  // The client sends eBay-hosted URLs or nothing — never photo bytes.
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: PreviewBody;
  try {
    body = (await req.json()) as PreviewBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!body.listing || typeof body.listing !== "object") {
    return NextResponse.json({ ok: false, error: "Missing listing." }, { status: 400 });
  }
  // A seller token sharpens the condition metadata, and the app-level token is
  // enough for the category and aspect lookups — so preview works before anyone
  // connects an account. With no eBay credentials at all the builder falls back
  // to the offline category map and labels itself as an approximation, which is
  // still worth showing: title clipping, price, condition tier, and the
  // specifics the app itself derives are all accurate without eBay.
  let accessToken: string | undefined;
  try {
    accessToken = (await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value)) ?? undefined;
  } catch {
    /* not connected — fall through with the app token */
  }

  try {
    const preview = await buildListingPreview({
      sku: String(body.sku || "").slice(0, 50),
      listing: body.listing,
      // Only https URLs eBay could actually serve; anything else is dropped
      // rather than rendered into the preview's <img> tags.
      imageUrls: sanitizeEbayImageUrls(body.imageUrls),
      photoCount: Number.isFinite(Number(body.photoCount))
        ? Math.max(0, Math.min(999, Math.trunc(Number(body.photoCount))))
        : 0,
      accessToken,
    });
    if (!isEbayConfigured()) {
      preview.warnings.unshift(
        "eBay isn't configured on this deployment, so the category and item specifics here are the app's offline best guess."
      );
    }
    return NextResponse.json({ ok: true, preview });
  } catch (e) {
    return safeErrorResponse("ebay/preview", e, "Couldn't build the preview — please try again.");
  }
}
