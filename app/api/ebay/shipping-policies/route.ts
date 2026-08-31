import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { fetchAccountSetup } from "@/lib/ebay/publish";
import { SHIP_FROM_COOKIE, normalizeZip } from "@/lib/shipFrom";

// The seller's own shipping business policies, so a relist can move a listing
// between them.
//
// A separate route rather than a field on /api/ebay/listings, and fetched only
// when a relist panel is actually opened. fetchAccountSetup costs four eBay
// calls on a cold cache, and the listings page — which every visit hits — should
// not pay for a feature most visits don't use. The setup is cached server-side
// for ten minutes, so opening several panels costs one round trip.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  try {
    const shipFromZip =
      normalizeZip(req.cookies.get(SHIP_FROM_COOKIE)?.value) ??
      normalizeZip(process.env.EBAY_LOCATION_POSTAL_CODE);
    const setup = await fetchAccountSetup(accessToken, shipFromZip);

    return NextResponse.json({
      ok: true,
      policies: setup.fulfillmentPolicies ?? [],
      /** The account's default, so the UI can mark which one a new listing gets. */
      defaultPolicyId: setup.fulfillmentPolicyId || null,
    });
  } catch (e) {
    // Advisory: a seller who can't read their policies can still relist, just
    // without changing the shipping. Failing the whole panel over this would
    // take away a feature that already worked.
    console.warn(`[ebay/shipping-policies] ${(e as Error).message}`);
    return NextResponse.json(
      { ok: false, error: "Couldn't read your shipping policies from eBay." },
      { status: 200 }
    );
  }
}
