import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { reviseOffer, validatePrice, type BestOfferInput } from "@/lib/ebay/revise";

// A lookup, a read, a write, and a read-back — four sequential eBay calls.
export const maxDuration = 60;

interface ReviseBody {
  sku?: string;
  price?: number | string;
  bestOffer?: BestOfferInput;
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: ReviseBody;
  try {
    body = (await req.json()) as ReviseBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const sku = String(body.sku ?? "").trim();
  if (!sku) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This listing has no SKU, so there's no way to find its offer. Listings without a SKU have to be edited in Seller Hub.",
      },
      { status: 400 }
    );
  }

  // Validate before spending any eBay calls, so a typo comes back instantly
  // with a sentence rather than as an eBay error id four requests later.
  let price: number | undefined;
  if (body.price !== undefined && body.price !== "") {
    const checked = validatePrice(body.price);
    if ("error" in checked) {
      return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
    }
    price = checked.price;
  }

  if (price === undefined && !body.bestOffer) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

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
    const result = await reviseOffer(accessToken, { sku, price, bestOffer: body.bestOffer });
    // A refused edit is a business outcome, not a server fault — 422 keeps it
    // distinguishable from a crash, as the publish route already does.
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/revise] unhandled error sku=${sku}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
