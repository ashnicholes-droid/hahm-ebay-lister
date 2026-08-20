import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { buildAuthorizeUrl } from "@/lib/ebay/oauth";
import { EBAY_SCOPE_COOKIE, EBAY_STATE_COOKIE } from "@/lib/ebay/session";
import { OPTIONAL_SCOPE_IDS } from "@/lib/ebay/scopes";

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
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  // Which optional capabilities to ask eBay for. Filtered against the known set
  // so a stray value can never become a scope that gets the whole authorize
  // request rejected — which is the failure this parameter exists to escape.
  let optional = OPTIONAL_SCOPE_IDS;
  try {
    const body = (await req.json()) as { optionalScopes?: unknown };
    if (Array.isArray(body?.optionalScopes)) {
      const asked = body.optionalScopes.map(String);
      optional = OPTIONAL_SCOPE_IDS.filter((id) => asked.includes(id));
    }
  } catch {
    /* no body — ask for everything, which is the old behaviour */
  }

  try {
    const state = crypto.randomUUID();
    const url = buildAuthorizeUrl(state, optional);
    const res = NextResponse.json({ ok: true, url, optionalScopes: optional });
    setStateCookie(res, state);
    // Remember the choice for the connect step, which is a separate request.
    res.cookies.set(EBAY_SCOPE_COOKIE, optional.join(","), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
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
