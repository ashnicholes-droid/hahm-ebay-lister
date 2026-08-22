import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { editLiveContent, fetchContent } from "@/lib/ebay/content";

// Read is two eBay calls; the edit is four.
export const maxDuration = 60;

async function token(req: NextRequest): Promise<string | NextResponse> {
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
  return accessToken;
}

/** What the listing currently says, so it can be edited rather than replaced blind. */
export async function GET(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  const sku = String(req.nextUrl.searchParams.get("sku") ?? "").trim();
  if (!sku) return NextResponse.json({ ok: false, error: "Missing SKU." }, { status: 400 });

  const t = await token(req);
  if (typeof t !== "string") return t;

  try {
    const result = await fetchContent(t, sku);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/content] read failed sku=${sku}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** Revise the live listing in place — no ending, no new item number. */
export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: { sku?: string; title?: string; description?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const sku = String(body.sku ?? "").trim();
  if (!sku) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This listing has no SKU, so there's no inventory item to edit. Edit it in Seller Hub instead.",
      },
      { status: 400 }
    );
  }

  const t = await token(req);
  if (typeof t !== "string") return t;

  try {
    const result = await editLiveContent(t, sku, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
    // A half-applied edit is logged: the two copies of the description can end
    // up disagreeing, and that is worth being able to find later.
    if (result.partial) {
      console.error(`[ebay/content] PARTIAL edit sku=${sku}: ${result.error}`);
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/content] edit failed sku=${sku}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
