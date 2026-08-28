// Views and search impressions per listing, from eBay's Analytics API.
//
// Watch counts come free with the listings call; views do not. eBay retired the
// old Trading hit counter, and the only supported source is the traffic report,
// which needs its own read-only scope.
//
// Everything here is best-effort: a missing scope, a rate limit, or an account
// with no traffic history must degrade to "views unavailable" and leave the rest
// of the screen working. But best-effort is not the same as silent. The first
// version of this module collapsed every failure into one generic sentence,
// which meant a seller could see empty columns with no way to find out why —
// the same mistake the publish path used to make with eBay's rejections. eBay's
// actual reply is now kept and surfaced.

import { EBAY_ANALYTICS_BASE, EBAY_MARKETPLACE_ID } from "./config";

const ANALYTICS_BASE = EBAY_ANALYTICS_BASE;

/** How far back the report looks. eBay serves at most 90 days. */
export const TRAFFIC_WINDOW_DAYS = 30;

/**
 * eBay's traffic data lags roughly a day, and a range that includes today can
 * come back empty or rejected. Ending yesterday is the documented safe bound.
 */
const REPORT_LAG_DAYS = 1;

export interface ListingTraffic {
  views: number | null;
  impressions: number | null;
}

export interface TrafficDebug {
  httpStatus: number;
  /** The exact URL requested, minus nothing sensitive — it carries no token. */
  requestUrl: string;
  errors?: {
    errorId: number;
    message?: string;
    longMessage?: string;
    parameters?: { name: string; value: string }[];
  }[];
  /** eBay's body when it wasn't the JSON we expected. */
  raw?: string;
  /** What the parser found, for the case where the call succeeded but nothing matched. */
  parsed?: { dimensionKeys: string[]; metricKeys: string[]; recordCount: number };
}

export interface TrafficReport {
  /** Keyed by eBay listing id. */
  byListing: Record<string, ListingTraffic>;
  /** Set when the numbers couldn't be fetched — shown instead of blank cells. */
  unavailable?: string;
  /** Everything eBay said, for when the sentence above isn't enough. */
  debug?: TrafficDebug;
  windowDays: number;
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseErrors(json: any): TrafficDebug["errors"] {
  if (!Array.isArray(json?.errors)) return undefined;
  return json.errors.slice(0, 5).map((e: any) => ({
    errorId: Number(e?.errorId || 0),
    ...(e?.message ? { message: String(e.message).slice(0, 400) } : {}),
    ...(e?.longMessage ? { longMessage: String(e.longMessage).slice(0, 400) } : {}),
    ...(Array.isArray(e?.parameters) && e.parameters.length
      ? {
          parameters: e.parameters.slice(0, 8).map((p: any) => ({
            name: String(p?.name ?? ""),
            value: String(p?.value ?? "").slice(0, 200),
          })),
        }
      : {}),
  }));
}

/**
 * Build the query by hand rather than with URLSearchParams.
 *
 * eBay's filter syntax uses `{`, `}`, `[`, `]`, `:` and `,` structurally, and
 * URLSearchParams percent-encodes all of them. eBay's own examples show them
 * unencoded, and several of its endpoints reject the encoded form. This is a
 * prime suspect for a traffic report that returns nothing while the credentials
 * are perfectly good.
 */
function buildQuery(startDate: string, endDate: string): string {
  const filter = `marketplace_ids:{${EBAY_MARKETPLACE_ID}},date_range:[${startDate}..${endDate}]`;
  return (
    `dimension=LISTING` +
    `&filter=${filter}` +
    `&metric=LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL`
  );
}

/**
 * Traffic for the seller's listings.
 *
 * Never throws. A caller that gets `unavailable` back should render the reason
 * once, not per row, and offer `debug` behind a disclosure.
 */
export async function fetchTrafficReport(accessToken: string): Promise<TrafficReport> {
  const end = new Date(Date.now() - REPORT_LAG_DAYS * 86400_000);
  const start = new Date(end.getTime() - TRAFFIC_WINDOW_DAYS * 86400_000);
  const query = buildQuery(yyyymmdd(start), yyyymmdd(end));
  const url = `${ANALYTICS_BASE}/traffic_report?${query}`;

  const fail = (reason: string, debug: TrafficDebug): TrafficReport => ({
    byListing: {},
    unavailable: reason,
    debug,
    windowDays: TRAFFIC_WINDOW_DAYS,
  });

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
      },
    });

    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* eBay returned something that isn't JSON */
    }

    const debug: TrafficDebug = {
      httpStatus: resp.status,
      requestUrl: url,
      ...(parseErrors(json) ? { errors: parseErrors(json) } : {}),
      ...(json === null && text ? { raw: text.slice(0, 800) } : {}),
    };

    if (resp.status === 401 || resp.status === 403) {
      return fail(
        "Views and impressions need eBay's analytics permission, which this connection doesn't have. Disconnect and reconnect eBay once to add it — everything else on this page works either way.",
        debug
      );
    }
    if (!resp.ok) {
      // eBay's own sentence beats a generic one whenever it gave us one.
      const first = debug.errors?.[0];
      const said = first?.longMessage || first?.message;
      return fail(
        said
          ? `eBay couldn't return traffic figures: ${said}`
          : `eBay couldn't return traffic figures right now (HTTP ${resp.status}).`,
        debug
      );
    }

    // The report is a header plus positional records, so column order has to be
    // read rather than assumed. eBay has used both LISTING and LISTING_ID as the
    // dimension key, so accept either and fall back to the first column.
    const dimensionKeys: string[] = Array.isArray(json?.header?.dimensionKeys)
      ? json.header.dimensionKeys.map((k: any) => String(k?.key ?? k ?? ""))
      : [];
    const metricKeys: string[] = Array.isArray(json?.header?.metrics)
      ? json.header.metrics.map((m: any) => String(m?.key ?? m ?? ""))
      : [];
    const records: any[] = Array.isArray(json?.records) ? json.records : [];

    debug.parsed = { dimensionKeys, metricKeys, recordCount: records.length };

    const listingIdIndex = dimensionKeys.findIndex((h) =>
      ["LISTING_ID", "LISTING", "listingId"].includes(h)
    );
    const indexOfMetric = (name: string) => {
      const i = metricKeys.indexOf(name);
      return i >= 0 ? i : metricKeys.findIndex((k) => k.toUpperCase() === name);
    };
    const viewsIndex = indexOfMetric("LISTING_VIEWS_TOTAL");
    const imprIndex = indexOfMetric("LISTING_IMPRESSION_TOTAL");

    const byListing: Record<string, ListingTraffic> = {};
    for (const record of records) {
      const dims: any[] = Array.isArray(record?.dimensionValues) ? record.dimensionValues : [];
      const vals: any[] = Array.isArray(record?.metricValues) ? record.metricValues : [];
      const id = String(
        (listingIdIndex >= 0 ? dims[listingIdIndex]?.value : dims[0]?.value) ?? ""
      ).trim();
      if (!id) continue;
      const num = (i: number): number | null => {
        if (i < 0) return null;
        const v = Number(vals[i]?.value);
        return Number.isFinite(v) ? v : null;
      };
      byListing[id] = { views: num(viewsIndex), impressions: num(imprIndex) };
    }

    if (Object.keys(byListing).length === 0) {
      return {
        byListing,
        windowDays: TRAFFIC_WINDOW_DAYS,
        debug,
        unavailable:
          records.length > 0
            ? "eBay returned traffic rows this app couldn't match to your listings. The details below say what came back."
            : "eBay returned no traffic data for this period. New listings can take a day or two to report, and the report excludes today.",
      };
    }
    return { byListing, windowDays: TRAFFIC_WINDOW_DAYS };
  } catch (e) {
    return fail(`Traffic figures couldn't be loaded (${(e as Error).message}).`, {
      httpStatus: 0,
      requestUrl: url,
      raw: (e as Error).message,
    });
  }
}
