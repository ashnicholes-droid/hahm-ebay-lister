import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest } from "@/lib/api-guard";
import { isEbayConfigured } from "@/lib/ebay/config";
import { EBAY_COOKIE, openConnection } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

// Lightweight check the UI calls on load: is eBay set up + connected, and is
// this deployment configured at all? Returns booleans and one operator-facing
// message, so it stays outside the access code — but not outside the rate
// limiter.
//
// This is the app's health probe, so it is where a misconfigured deployment has
// to be caught. Without APP_SECRET every other route answers 503 and the UI just
// looks broken; the seller is left guessing at something only the server knows.
// Reporting it leaks nothing: with APP_SECRET set this route is behind the gate,
// and without it the deployment is already open to anyone who asks.
export async function GET(req: NextRequest) {
  const limited = rateLimitRequest(req);
  if (limited) return limited;

  const configured = isEbayConfigured();
  const conn = await openConnection(req.cookies.get(EBAY_COOKIE)?.value);
  const isProd =
    process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
  const setupError =
    isProd && !process.env.APP_SECRET
      ? "APP_SECRET isn't set, so every action is disabled and the app is unprotected. Add it in Vercel → Settings → Environment Variables, then redeploy."
      : undefined;

  return NextResponse.json({
    configured,
    connected: Boolean(conn),
    ...(setupError ? { setupError } : {}),
  });
}
