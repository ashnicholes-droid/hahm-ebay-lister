import { NextRequest, NextResponse } from "next/server";
import { BODY_LIMIT_JSON, enforceBodyLimit, guardApiRequest } from "@/lib/api-guard";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { EBAY_INV_BASE } from "@/lib/ebay/config";
import {
  SHIP_FROM_COOKIE,
  SHIP_FROM_MAX_AGE,
  normalizeZip,
  resolveLocation,
  validateZip,
  type EbayLocation,
} from "@/lib/shipFrom";

// One eBay call to read the account's locations.
export const maxDuration = 30;

/**
 * Where the ZIP is stored, and why it's a cookie.
 *
 * Same shape as the eBay connection: httpOnly, long-lived, set once and it
 * sticks. There is no database, and an environment variable is the wrong tool
 * — it needs a redeploy to change and it silently did nothing for accounts
 * that already had an eBay location, which is what made this confusing in the
 * first place.
 *
 * It isn't a secret, so it isn't encrypted. It IS re-validated on every read,
 * so a tampered cookie can only ever produce another valid five-digit ZIP —
 * something the owner could have typed anyway.
 */
function storedZip(req: NextRequest): string | null {
  return normalizeZip(req.cookies.get(SHIP_FROM_COOKIE)?.value);
}

/** What eBay actually has, which is the thing worth being able to check. */
async function liveLocations(
  req: NextRequest,
  requested: string | null
): Promise<{
  locations?: EbayLocation[];
  activeZip?: string | null;
  currentZip?: string | null;
  error?: string;
}> {
  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!accessToken) return {};

  try {
    const resp = await fetch(`${EBAY_INV_BASE}/location`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) return { error: `eBay returned HTTP ${resp.status} listing your locations.` };
    const json = await resp.json().catch(() => null);
    const locations: EbayLocation[] = json?.locations ?? [];
    const choice = resolveLocation(locations, requested);
    // Two different questions, and conflating them is what hides the problem:
    // what the setting WILL use, and what the account uses right now.
    const current = resolveLocation(locations, null);
    return {
      locations,
      activeZip: choice.mustCreate ? null : choice.zip,
      currentZip: current.zip,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function GET(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  const zip = storedZip(req);
  const envZip = normalizeZip(process.env.EBAY_LOCATION_POSTAL_CODE);
  const effective = zip ?? envZip;
  const live = await liveLocations(req, effective);

  return NextResponse.json({
    ok: true,
    zip,
    envZip,
    effective,
    // The whole point of the diagnostic: what listings publish from TODAY, as
    // opposed to what the setting says they should.
    activeZip: live.activeZip ?? null,
    /** What the account ships from today, whatever the setting says. */
    currentZip: live.currentZip ?? null,
    known: (live.locations ?? [])
      .filter((l) => l.merchantLocationStatus === "ENABLED")
      .map((l) => ({
        key: l.merchantLocationKey ?? "",
        zip: normalizeZip(l.location?.address?.postalCode),
      })),
    ...(live.error ? { warning: live.error } : {}),
  });
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_JSON);
  if (oversized) return oversized;

  let body: { zip?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  // An empty value clears the setting and hands control back to the env var
  // (or, failing that, eBay's existing location).
  const clearing = String(body.zip ?? "").trim() === "";
  const checked = clearing ? { zip: "" } : validateZip(body.zip);
  if ("error" in checked) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, zip: clearing ? null : checked.zip });
  if (clearing) {
    res.cookies.set(SHIP_FROM_COOKIE, "", { path: "/", maxAge: 0 });
  } else {
    res.cookies.set(SHIP_FROM_COOKIE, checked.zip, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SHIP_FROM_MAX_AGE,
    });
  }
  return res;
}
