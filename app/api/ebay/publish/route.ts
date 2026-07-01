import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { fetchAccountSetup, publishListing } from "@/lib/ebay/publish";
import type { PublishInput } from "@/lib/ebay/publish";

// Photo upload + several eBay calls + recovery loops — give it room.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  // Check access + rate limit BEFORE parsing the (potentially large) body.
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: PublishInput;
  try {
    body = (await req.json()) as PublishInput;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  if (!body.sku || !body.listing || !Array.isArray(body.images) || body.images.length === 0) {
    return NextResponse.json(
      { success: false, error: "Missing SKU, listing, or photos." },
      { status: 400 }
    );
  }

  // Mint a fresh access token from the encrypted connection cookie.
  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { success: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  try {
    const setup = await fetchAccountSetup(accessToken);
    const result = await publishListing(accessToken, setup, body);
    // A failed publish is a business outcome (eBay rejected the listing), not a
    // server error. Return 422 so it can't be confused with Vercel's own
    // platform 502 (function crash/timeout). The client keys off `success`, not
    // the HTTP status. True server faults still throw and surface as 500 below.
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/publish] unhandled error sku=${body.sku}:`, e);
    return NextResponse.json(
      { success: false, sku: body.sku, error: (e as Error).message },
      { status: 500 }
    );
  }
}
