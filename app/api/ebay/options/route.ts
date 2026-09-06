import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { accessTokenFromCookie, EBAY_COOKIE } from "@/lib/ebay/session";
import { fetchAccountOptions } from "@/lib/ebay/publish";
import { withDeadline } from "@/lib/network";
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return withDeadline(25_000, async () => {
    try {
      const token = await accessTokenFromCookie(
        req.cookies.get(EBAY_COOKIE)?.value,
      );
      if (!token)
        return NextResponse.json(
          {
            ok: false,
            error: "Connect eBay to choose policies and shipping origin.",
          },
          { status: 401 },
        );
      return NextResponse.json({
        ok: true,
        options: await fetchAccountOptions(token),
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: (e as Error).message },
        { status: 502 },
      );
    }
  });
}
