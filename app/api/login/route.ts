import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  accessCodeMatches,
  issueSession,
} from "@/lib/session-auth";
import { BODY_LIMIT_JSON, enforceBodyLimit, recordAuthOutcome } from "@/lib/api-guard";

// The one endpoint that trades an access code for a session cookie. It has to
// stay reachable without a session (see isPublicPath), which makes it the single
// place an attacker can guess at — so the lockout counter lives here.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  const secret = process.env.APP_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This deployment has no APP_SECRET configured. Set it in Vercel → Settings → Environment Variables, then redeploy.",
      },
      { status: 503 }
    );
  }

  let code = "";
  try {
    const body = (await req.json()) as { code?: unknown };
    code = String(body?.code ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const locked = recordAuthOutcome(req, "check");
  if (locked) return locked;

  if (!code || !(await accessCodeMatches(code, secret))) {
    recordAuthOutcome(req, "fail");
    return NextResponse.json(
      { ok: false, error: "That code didn't match." },
      { status: 401 }
    );
  }

  recordAuthOutcome(req, "success");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await issueSession(secret), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
