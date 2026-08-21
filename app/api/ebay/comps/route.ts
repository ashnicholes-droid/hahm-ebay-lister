import { NextRequest, NextResponse } from "next/server";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { isEbayConfigured } from "@/lib/ebay/config";
import { appToken } from "@/lib/ebay/taxonomy";
import { searchComps } from "@/lib/ebay/comps";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";
import type { ListingResult } from "@/lib/types";

// One Browse-API search; quick.
export const maxDuration = 30;

// Market price check for a drafted listing: active-comp count, median, and
// range. Uses the app-level eBay token, so it works before a seller connects.
export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  if (!isEbayConfigured()) {
    return NextResponse.json({ ok: false, error: "eBay isn't configured." }, { status: 200 });
  }

  let body: { listing?: ListingResult };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!body.listing?.title) {
    return NextResponse.json({ ok: false, error: "Missing listing." }, { status: 400 });
  }

  try {
    const token = await appToken();
    const comps = await searchComps(token, body.listing);
    // The band stays raw market truth. The markup travels alongside it so the
    // card can apply the seller's pricing rule and the storewide markup in one
    // place — the recommendation depends on settings that live in the browser,
    // so the server can't compute the final figure.
    const markup = priceMarkupPercent();
    if (markup > 0 && comps.median !== undefined && comps.median > 0) {
      return NextResponse.json({
        ok: true,
        markupPercent: markup,
        comps: { ...comps, listPrice: applyPriceMarkup(comps.median, markup) },
      });
    }
    return NextResponse.json({ ok: true, markupPercent: 0, comps });
  } catch (e) {
    // Comps are advisory — never let a market-check failure look like an outage.
    console.warn(`[ebay/comps] lookup failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: "Market check unavailable." }, { status: 200 });
  }
}
