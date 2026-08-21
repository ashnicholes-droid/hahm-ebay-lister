import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { MAX_NOTE_LENGTH, parseNote, validateCost, writeCostIntoNote } from "@/lib/costBasis";
import { setUserNotes } from "@/lib/ebay/notes";
import { TradingApiError } from "@/lib/ebay/listings";

// One Trading write.
export const maxDuration = 30;

interface CostBody {
  itemId?: string;
  /** "" or null clears the recorded cost. */
  cost?: number | string | null;
  /** The note's existing prose, so saving a cost doesn't erase it. */
  note?: string;
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: CostBody;
  try {
    body = (await req.json()) as CostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const itemId = String(body.itemId ?? "").trim();
  if (!/^\d{6,20}$/.test(itemId)) {
    return NextResponse.json({ ok: false, error: "Missing item id." }, { status: 400 });
  }

  const checked = validateCost(body.cost);
  if ("error" in checked) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  }

  // Merge rather than overwrite: the note may be something the seller typed in
  // Seller Hub, and losing it to a price entry would be an unpleasant surprise.
  const note = writeCostIntoNote(String(body.note ?? ""), checked.cost);
  if (note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: `eBay caps a listing note at ${MAX_NOTE_LENGTH} characters and this would be ${note.length}. Shorten the note in Seller Hub first.`,
      },
      { status: 400 }
    );
  }

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      {
        ok: false,
        error: "eBay isn't connected. Connect your account and try again.",
      },
      { status: 401 }
    );
  }

  try {
    const { warnings } = await setUserNotes(accessToken, itemId, note);
    // Echo back what was actually stored, parsed the same way the list view
    // parses it, so the row can't disagree with eBay about what was saved.
    const stored = parseNote(note);
    return NextResponse.json({
      ok: true,
      cost: stored.cost,
      note: stored.text,
      warnings,
    });
  } catch (e) {
    if (e instanceof TradingApiError) {
      const isAuth = e.code === "931" || e.code === "932" || e.code === "21917053";
      return NextResponse.json(
        {
          ok: false,
          error: isAuth
            ? "eBay rejected the saved connection. Disconnect and reconnect eBay, then try again."
            : e.message,
        },
        { status: isAuth ? 401 : 422 }
      );
    }
    console.error(`[ebay/cost] unhandled error item=${itemId}:`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
