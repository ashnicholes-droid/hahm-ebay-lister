import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// eBay Marketplace Account Deletion / Closure notification endpoint.
//
// Required once this app persists data (scheduled listing records), since we can
// no longer claim eBay's "not persisting eBay data" exemption. eBay uses this
// endpoint two ways:
//   GET  — a one-time challenge when you register/verify the endpoint.
//   POST — the actual notifications when an eBay user closes their account.
//
// Register the URL below plus EBAY_VERIFICATION_TOKEN in the eBay developer
// portal under Alerts & Notifications → Marketplace account deletion.
//
// NOTE: unlike the other unauthenticated eBay routes, this one deliberately does
// NOT call rateLimitRequest(). That limiter allows 40 requests/minute per IP
// across all routes; eBay's senders share IPs and can arrive in bursts, and a
// 429 tells eBay the endpoint is down. Enough failures and eBay disables the
// production keyset, which would break publishing. Both handlers are cheap
// (a hash, or a log line), so there is nothing here worth protecting.

export const dynamic = "force-dynamic";

const ENDPOINT_PATH = "/api/ebay/account-deletion";

// The URL that goes into the challenge hash must be byte-identical to the one
// registered with eBay. Deriving it from the request is how this silently fails:
// on Vercel the host can arrive as the deployment URL
// (my-app-abc123.vercel.app) rather than the registered production URL, and the
// hash then mismatches with no useful error. Prefer APP_URL, exactly as the
// OAuth callback does.
function endpointUrl(req: NextRequest): string {
  const base = process.env.APP_URL || req.nextUrl.origin;
  return new URL(ENDPOINT_PATH, base).toString();
}

export async function GET(req: NextRequest) {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");
  if (!challengeCode) {
    return NextResponse.json(
      { error: "Missing challenge_code query parameter." },
      { status: 400 }
    );
  }

  const token = process.env.EBAY_VERIFICATION_TOKEN;
  if (!token) {
    // Fail loudly. Hashing with an empty token would return a well-formed but
    // wrong response, and eBay's only feedback is "validation failed" — which is
    // far harder to diagnose than an explicit error here.
    console.error(
      "[ebay/account-deletion] EBAY_VERIFICATION_TOKEN is not set — cannot answer eBay's challenge. Set it in Vercel → Settings → Environment Variables."
    );
    return NextResponse.json(
      { error: "Endpoint is not configured." },
      { status: 500 }
    );
  }

  // eBay's required order: challengeCode + verificationToken + endpoint URL.
  const challengeResponse = crypto
    .createHash("sha256")
    .update(challengeCode)
    .update(token)
    .update(endpointUrl(req))
    .digest("hex");

  return NextResponse.json({ challengeResponse }, { status: 200 });
}

interface DeletionNotification {
  metadata?: { topic?: string };
  notification?: {
    notificationId?: string;
    data?: { username?: string; userId?: string; eiasToken?: string };
  };
}

export async function POST(req: NextRequest) {
  // Always answer 200, even on a malformed body: a non-2xx marks the endpoint
  // as failing on eBay's side, and we cannot ask them to resend.
  try {
    const body = (await req.json()) as DeletionNotification;
    const data = body.notification?.data;
    console.log("[ebay/account-deletion] notification received", {
      topic: body.metadata?.topic,
      notificationId: body.notification?.notificationId,
      username: data?.username,
      userId: data?.userId,
    });

    // TODO: once the scheduling tables exist, delete any stored rows belonging
    // to this eBay user here (scheduled listing records keyed by userId).
  } catch (e) {
    console.error("[ebay/account-deletion] could not parse notification body", e);
  }

  return new NextResponse(null, { status: 200 });
}
