import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-auth";

// Public by design: signing out has to work from a session that is already
// expired or malformed, which is exactly when you can't pass the gate.
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
