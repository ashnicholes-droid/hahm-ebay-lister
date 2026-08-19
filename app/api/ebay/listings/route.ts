import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { LISTINGS_PAGE_SIZE, TradingApiError, fetchActiveListings } from "@/lib/ebay/listings";
import { fetchTrafficReport } from "@/lib/ebay/traffic";

// One Trading call plus one analytics call. Both are network-bound and the
// listings page is useless until they land, so give them room.
export const maxDuration = 60;

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

  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") || 1) || 1);

  try {
    // Traffic is decorative next to the listings themselves, so it runs in
    // parallel and can fail without taking the page down with it.
    const [listings, traffic] = await Promise.all([
      fetchActiveListings(accessToken, page, LISTINGS_PAGE_SIZE),
      fetchTrafficReport(accessToken),
    ]);

    const withTraffic = listings.listings.map((l) => {
      const t = traffic.byListing[l.itemId];
      return { ...l, views: t?.views ?? null, impressions: t?.impressions ?? null };
    });

    return NextResponse.json({
      ok: true,
      ...listings,
      listings: withTraffic,
      traffic: {
        unavailable: traffic.unavailable,
        windowDays: traffic.windowDays,
      },
    });
  } catch (e) {
    if (e instanceof TradingApiError) {
      // 931/932 are eBay's token errors. Say "reconnect" rather than relaying a
      // sentence about IAF tokens that means nothing to a seller.
      const isAuth = e.code === "931" || e.code === "932" || e.code === "21917053";
      return NextResponse.json(
        {
          ok: false,
          error: isAuth
            ? "eBay rejected the saved connection. Disconnect and reconnect eBay, then try again."
            : e.message,
        },
        { status: isAuth ? 401 : 502 }
      );
    }
    console.error("[ebay/listings] unhandled error:", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
