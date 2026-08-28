import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import {
  FulfillmentApiError,
  ORDERS_WINDOW_DAYS,
  fetchOrders,
  markShipped,
} from "@/lib/ebay/orders";
import { SOLD_WINDOW_DAYS, costFor, emptyCostIndex, fetchSoldCosts } from "@/lib/ebay/soldNotes";

// Two eBay calls, one of them a paged Trading request over up to 60 days of
// sales. Slower than the listings view and just as useless half-loaded.
export const maxDuration = 60;

async function tokenOrError(req: NextRequest) {
  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return { error: NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }) };
  }
  if (!accessToken) {
    return {
      error: NextResponse.json(
        { ok: false, error: "eBay isn't connected. Connect your account and try again." },
        { status: 401 }
      ),
    };
  }
  return { accessToken };
}

export async function GET(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  const auth = await tokenOrError(req);
  if (auth.error) return auth.error;

  const days = Math.min(
    365,
    Math.max(1, Number(req.nextUrl.searchParams.get("days")) || ORDERS_WINDOW_DAYS)
  );

  try {
    // Orders are the point of the screen; costs are an enrichment. A failure to
    // read private notes must not cost the seller the sales list, so the cost
    // lookup is allowed to fail into an empty index — every profit figure then
    // reads "cost not recorded", which is true, rather than vanishing.
    const [orders, costs] = await Promise.all([
      fetchOrders(auth.accessToken, days),
      fetchSoldCosts(auth.accessToken, Math.min(SOLD_WINDOW_DAYS, days)).catch(() =>
        emptyCostIndex(Math.min(SOLD_WINDOW_DAYS, days))
      ),
    ]);

    const warnings = [...orders.warnings];
    if (costs.scanned === 0 && orders.orders.length > 0) {
      warnings.push(
        "Couldn't read cost basis from eBay's private notes, so profit is unavailable for these sales."
      );
    }

    // The cost is attached per order here rather than in the browser: the join
    // rule (item id, then SKU, to survive a relist) belongs next to the data.
    const withCosts = orders.orders.map((o) => {
      const perLine = o.items.map((i) => ({
        lineItemId: i.lineItemId,
        cost: costFor(costs, i),
      }));
      const known = perLine.filter((l) => l.cost !== null);
      return {
        ...o,
        // Multi-line orders sum, and quantity multiplies — two of the same item
        // in one order cost twice as much to acquire.
        cost:
          known.length === o.items.length && o.items.length > 0
            ? round(
                o.items.reduce(
                  (sum, i, n) => sum + (perLine[n].cost ?? 0) * Math.max(1, i.quantity),
                  0
                )
              )
            : null,
        costPartial: known.length > 0 && known.length < o.items.length,
      };
    });

    return NextResponse.json({
      ok: true,
      orders: withCosts,
      windowDays: orders.windowDays,
      costWindowDays: costs.windowDays,
      warnings,
    });
  } catch (e) {
    const err = e as FulfillmentApiError & { code?: string };
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return NextResponse.json({ ok: false, error: err.message }, { status });
  }
}

/** Add tracking to an order and mark it shipped. */
export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  const auth = await tokenOrError(req);
  if (auth.error) return auth.error;

  let body: { orderId?: string; trackingNumber?: string; carrier?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!body.orderId) {
    return NextResponse.json({ ok: false, error: "Missing order." }, { status: 400 });
  }

  try {
    const result = await markShipped(auth.accessToken, {
      orderId: body.orderId,
      trackingNumber: String(body.trackingNumber ?? ""),
      carrier: String(body.carrier ?? ""),
    });
    return NextResponse.json({ ok: true, fulfillmentId: result.fulfillmentId });
  } catch (e) {
    const err = e as FulfillmentApiError;
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return NextResponse.json({ ok: false, error: err.message }, { status });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
