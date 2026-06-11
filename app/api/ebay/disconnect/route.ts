import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { EBAY_COOKIE } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

// Forget the stored eBay connection.
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(EBAY_COOKIE);
  return res;
}
