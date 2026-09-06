import { withDeadline } from "@/lib/network";
import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { uploadPhotos } from "@/lib/ebay/publish";

// Uploads ONE small batch of photos to eBay Picture Services and returns the
// hosted URLs. The client splits a listing's photos into batches sized well
// under Vercel's 4.5 MB body limit (lib/uploadBatches.ts), then publishes with
// the URLs — so the posting flow can never 413 no matter how photo-heavy an
// item is.

// A batch is ≤4 photos uploaded with internal concurrency; 120s is generous
// headroom for eBay Picture Services on a slow day.
export const maxDuration = 120;

// Hard cap on photos per request — the client sends at most 4 (MAX_BATCH_PHOTOS);
// anything larger is a misbehaving caller, not our flow.
const MAX_PHOTOS_PER_REQUEST = 6;

interface UploadBody {
  sku?: string;
  images?: { mediaType?: string; data?: string }[];
  // How many photos of this listing were uploaded in earlier batches — keeps
  // eBay picture names numbered continuously across batches.
  startIndex?: number;
}

async function handle(req: NextRequest) {
  // Check access + rate limit BEFORE parsing the (potentially large) body.
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request." },
      { status: 400 },
    );
  }

  const sku = String(body.sku || "").trim();
  const images = (Array.isArray(body.images) ? body.images : []).filter(
    (i): i is { mediaType: string; data: string } =>
      Boolean(
        i &&
        typeof i.mediaType === "string" &&
        typeof i.data === "string" &&
        i.data,
      ),
  );
  if (!sku || images.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing SKU or photos." },
      { status: 400 },
    );
  }
  if (images.length > MAX_PHOTOS_PER_REQUEST) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many photos in one batch (max ${MAX_PHOTOS_PER_REQUEST}).`,
      },
      { status: 400 },
    );
  }

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(
      req.cookies.get(EBAY_COOKIE)?.value,
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
  if (!accessToken) {
    return NextResponse.json(
      {
        ok: false,
        error: "eBay isn't connected. Connect your account and try again.",
      },
      { status: 401 },
    );
  }

  const startIndex =
    Number.isInteger(body.startIndex) && (body.startIndex as number) > 0
      ? (body.startIndex as number)
      : 0;

  try {
    const urls = await uploadPhotos(accessToken, images, sku, startIndex);
    // Report partial results so the client blocks publication until all photos upload.
    return NextResponse.json({
      ok: true,
      urls,
      failed: images.length - urls.length,
    });
  } catch (e) {
    console.error(`[ebay/upload-photos] unhandled error sku=${sku}:`, e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  return withDeadline(100000, () => handle(req));
}
