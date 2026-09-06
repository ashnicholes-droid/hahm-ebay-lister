import { withDeadline } from "@/lib/network";
import { boundedFetch } from "@/lib/network";
import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { EBAY_INV_BASE } from "@/lib/ebay/config";
import { guardApiRequest } from "@/lib/api-guard";
import { nextIndexFromSkus, sanitizeSku } from "@/lib/sku";

// Where should lettering for a bin continue? Scans the seller's existing
// inventory SKUs so a second batch from bin K31 starts after the last letter
// already used (K31-N, K31-O, …) instead of colliding with K31-A.

export const maxDuration = 30;

const PAGE_SIZE = 200;
const MAX_PAGES = 10; // up to 2000 inventory items scanned

async function handle(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let prefix = "";
  try {
    const body = (await req.json()) as { prefix?: string };
    prefix = sanitizeSku(String(body.prefix ?? ""));
  } catch {
    /* fall through to validation */
  }
  if (!prefix) {
    return NextResponse.json(
      { ok: false, error: "Missing bin prefix." },
      { status: 400 },
    );
  }

  let accessToken: string | null = null;
  try {
    accessToken = await accessTokenFromCookie(
      req.cookies.get(EBAY_COOKIE)?.value,
    );
  } catch {
    /* not connected — treated below */
  }
  if (!accessToken) {
    // Not connected to eBay: no existing SKUs to continue from.
    return NextResponse.json({ ok: true, nextIndex: 0, connected: false });
  }

  try {
    const skus: string[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await boundedFetch(
        `${EBAY_INV_BASE}/inventory_item?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "Accept-Language": "en-US",
          },
        },
      );
      if (!resp.ok) throw new Error("Inventory scan failed. Please retry.");
      const data = await resp.json().catch(() => null);
      const items: { sku?: string }[] = data?.inventoryItems ?? [];
      for (const it of items) if (it.sku) skus.push(it.sku);
      if (items.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1)
        throw new Error(
          "Inventory exceeds the scan limit. Use unique generated SKUs.",
        );
    }
    return NextResponse.json({
      ok: true,
      nextIndex: nextIndexFromSkus(skus, prefix),
      connected: true,
    });
  } catch (e) {
    console.error("[ebay/next-sku]", e);
    // Non-fatal for the client — worst case it starts at A like before.
    return NextResponse.json(
      {
        ok: false,
        error:
          "Inventory scan incomplete; unique item suffixes prevent reused SKUs.",
      },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  return withDeadline(25000, () => handle(req));
}
