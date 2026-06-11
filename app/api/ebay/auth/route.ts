import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { buildAuthorizeUrl } from "@/lib/ebay/oauth";
import { EBAY_STATE_COOKIE } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

function setStateCookie(res: NextResponse, state: string): void {
  // Short-lived CSRF guard, verified in the callback.
  res.cookies.set(EBAY_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
}

// Kick off the eBay connection after the app access code has been verified.
// This cannot be a plain link/GET, because GET redirects cannot carry the
// x-app-secret header stored by the browser.
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  try {
    const state = crypto.randomUUID();
    const url = buildAuthorizeUrl(state);
    const res = NextResponse.json({ ok: true, url });
    setStateCookie(res, state);
    return res;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, code: "ACCESS_CODE_REQUIRED", error: "Use the app to start eBay authorization." },
    { status: 401 }
  );
}
