import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { sendOfferToInterestedBuyers, validateOffer } from "@/lib/ebay/negotiation";

export const maxDuration = 60;

interface OfferBody {
  listingId?: string;
  discountPercent?: number | string;
  message?: string;
  durationDays?: number;
  allowCounterOffer?: boolean;
  quantity?: number;
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: OfferBody;
  try {
    body = (await req.json()) as OfferBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const listingId = String(body.listingId ?? "").trim();
  if (!listingId) {
    return NextResponse.json({ ok: false, error: "No listing selected." }, { status: 400 });
  }

  const discountPercent = Number(body.discountPercent);
  // Validate here as well as in the module: an offer is irreversible once sent,
  // so a bad number should never reach the point of being transmitted.
  const check = validateOffer({
    discountPercent,
    message: body.message,
    durationDays: body.durationDays,
  });
  if ("error" in check) {
    return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
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
    const result = await sendOfferToInterestedBuyers(accessToken, {
      listingId,
      discountPercent,
      message: body.message,
      durationDays: body.durationDays,
      allowCounterOffer: body.allowCounterOffer,
      quantity: body.quantity,
    });
    // A refused offer is a business outcome, not a server fault.
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/offer] unhandled error listing=${listingId}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
