import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { endListing, relistListing, validateRelistPrice } from "@/lib/ebay/relist";

// Up to five sequential eBay calls: look up, withdraw, read, update, publish.
export const maxDuration = 60;

interface RelistBody {
  sku?: string;
  /** "end" takes the listing down. "relist" ends it and puts it back up. */
  action?: "end" | "relist";
  /** Optional new price, relist only. */
  price?: number | string;
  /** Optional new title/description, relist only. */
  title?: string;
  description?: string;
  /**
   * Must be exactly true. Ending a listing can't be undone, so the intent is
   * carried explicitly rather than inferred from the request existing.
   */
  confirm?: boolean;
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: RelistBody;
  try {
    body = (await req.json()) as RelistBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const sku = String(body.sku ?? "").trim();
  if (!sku) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This listing has no SKU, so there's no offer to end. Listings without a SKU have to be ended in Seller Hub.",
      },
      { status: 400 }
    );
  }

  const action = body.action === "relist" ? "relist" : "end";

  // A destructive call that arrives without explicit confirmation is refused
  // rather than obeyed. This is the one route in the app where a stray retry,
  // a double-click, or a replayed request destroys something real.
  if (body.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: "Ending a listing has to be confirmed." },
      { status: 400 }
    );
  }

  let price: number | undefined;
  if (action === "relist" && body.price !== undefined && body.price !== "") {
    const checked = validateRelistPrice(body.price);
    if ("error" in checked) {
      return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
    }
    price = checked.price;
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
    const result =
      action === "relist"
        ? await relistListing(accessToken, sku, price, {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          })
        : await endListing(accessToken, sku);

    // A stranded offer means the listing is DOWN and nothing replaced it. Log
    // it at error level with the offer id: this is the one outcome here that
    // needs a human, and the server log is what survives a closed tab.
    if ("strandedOffer" in result && result.strandedOffer) {
      console.error(
        `[ebay/relist] STRANDED sku=${sku} offerId=${result.strandedOffer} — ` +
          `listing ${result.endedListingId} was ended and the republish failed: ${result.error}`
      );
    }

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/relist] unhandled error sku=${sku} action=${action}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
