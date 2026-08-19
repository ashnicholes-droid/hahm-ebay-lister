// Views and search impressions per listing, from eBay's Analytics API.
//
// Watch counts come free with the listings call; views do not. eBay retired the
// old Trading hit counter, and the only supported source is the traffic report,
// which needs its own read-only scope.
//
// Everything here is best-effort by design. A missing scope, a rate limit, or an
// account with no traffic history must degrade to "views unavailable" and leave
// the rest of the screen working — the seller came to change a price, and losing
// that because a statistics call failed would be a bad trade.

import { EBAY_MARKETPLACE_ID } from "./config";

const ANALYTICS_BASE = "https://api.ebay.com/sell/analytics/v1";

/** How far back the report looks. eBay serves at most ~90 days. */
export const TRAFFIC_WINDOW_DAYS = 30;

export interface ListingTraffic {
  views: number | null;
  impressions: number | null;
}

export interface TrafficReport {
  /** Keyed by eBay listing id. */
  byListing: Record<string, ListingTraffic>;
  /** Set when the numbers couldn't be fetched — shown instead of blank cells. */
  unavailable?: string;
  windowDays: number;
}

const empty = (reason: string): TrafficReport => ({
  byListing: {},
  unavailable: reason,
  windowDays: TRAFFIC_WINDOW_DAYS,
});

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Traffic for the seller's listings over the last TRAFFIC_WINDOW_DAYS.
 *
 * Never throws. A caller that gets `unavailable` back should render the reason
 * once, not per row.
 */
export async function fetchTrafficReport(accessToken: string): Promise<TrafficReport> {
  const end = new Date();
  const start = new Date(end.getTime() - TRAFFIC_WINDOW_DAYS * 86400_000);

  const params = new URLSearchParams({
    dimension: "LISTING",
    filter: `marketplace_ids:{${EBAY_MARKETPLACE_ID}},date_range:[${yyyymmdd(start)}..${yyyymmdd(end)}]`,
    metric: "LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL",
  });

  try {
    const resp = await fetch(`${ANALYTICS_BASE}/traffic_report?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      return empty(
        "Views need eBay's analytics permission, which this connection doesn't have yet. Disconnect and reconnect eBay once to add it — watch counts work either way."
      );
    }
    if (!resp.ok) {
      return empty(`eBay couldn't return traffic figures right now (HTTP ${resp.status}).`);
    }

    const json = (await resp.json()) as any;
    // The report is a header row plus positional records, so the column order
    // has to be read rather than assumed — eBay does not promise the order the
    // metrics were requested in.
    const headers: string[] = Array.isArray(json?.header?.dimensionKeys)
      ? json.header.dimensionKeys.map((k: any) => String(k?.key ?? ""))
      : [];
    const metricKeys: string[] = Array.isArray(json?.header?.metrics)
      ? json.header.metrics.map((m: any) => String(m?.key ?? ""))
      : [];

    const listingIdIndex = headers.findIndex((h) => h === "LISTING_ID" || h === "listingId");
    const viewsIndex = metricKeys.indexOf("LISTING_VIEWS_TOTAL");
    const imprIndex = metricKeys.indexOf("LISTING_IMPRESSION_TOTAL");

    const byListing: Record<string, ListingTraffic> = {};
    for (const record of Array.isArray(json?.records) ? json.records : []) {
      const dims: any[] = Array.isArray(record?.dimensionValues) ? record.dimensionValues : [];
      const vals: any[] = Array.isArray(record?.metricValues) ? record.metricValues : [];
      const id = String(
        (listingIdIndex >= 0 ? dims[listingIdIndex]?.value : dims[0]?.value) ?? ""
      );
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
        unavailable: "eBay returned no traffic data for this period yet.",
      };
    }
    return { byListing, windowDays: TRAFFIC_WINDOW_DAYS };
  } catch (e) {
    return empty(`Traffic figures couldn't be loaded (${(e as Error).message}).`);
  }
}
