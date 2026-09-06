import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { isEbayAppConfigured } from "@/lib/ebay/config";
import { appToken } from "@/lib/ebay/taxonomy";
import { searchComps } from "@/lib/ebay/comps";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";
import type { ListingResult } from "@/lib/types";

// One Browse-API search; quick.
export const maxDuration = 30;

// Market price check for a drafted listing: active-comp count, median, and
// range. Uses the app-level eBay token, so it works before a seller connects.
export async function researchListing(input: unknown) {
  if (!isEbayAppConfigured()) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't configured." },
      { status: 200 },
    );
  }

  let body: { listing?: ListingResult };
  try {
    body = input as { listing?: ListingResult };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request." },
      { status: 400 },
    );
  }
  if (!body.listing?.title) {
    return NextResponse.json(
      { ok: false, error: "Missing listing." },
      { status: 400 },
    );
  }

  try {
    const token = await appToken();
    const comps = await searchComps(token, body.listing);
    // The band stays raw market truth; the "use median" affordance carries the
    // deployment's storewide markup so it matches analysis-suggested pricing.
    const markup = priceMarkupPercent();
    if (markup > 0 && comps.median !== undefined && comps.median > 0) {
      return NextResponse.json({
        ok: true,
        comps: { ...comps, listPrice: applyPriceMarkup(comps.median, markup) },
      });
    }
    return NextResponse.json({ ok: true, comps });
  } catch (e) {
    // Comps are advisory — never let a market-check failure look like an outage.
    console.warn(`[ebay/comps] lookup failed: ${(e as Error).message}`);
    return NextResponse.json(
      { ok: false, error: "Market check unavailable." },
      { status: 200 },
    );
  }
}
