import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTrafficReport } from "@/lib/ebay/traffic";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const stub = (body: unknown, status = 200, asText?: string) => {
  const capture: { url?: string } = {};
  globalThis.fetch = (async (url: string) => {
    capture.url = String(url);
    return new Response(asText ?? JSON.stringify(body), {
      status,
      headers: { "Content-Type": asText ? "text/html" : "application/json" },
    });
  }) as unknown as typeof fetch;
  return capture;
};

const REPORT = {
  header: {
    dimensionKeys: [{ key: "LISTING" }],
    metrics: [{ key: "LISTING_IMPRESSION_TOTAL" }, { key: "LISTING_VIEWS_TOTAL" }],
  },
  records: [
    { dimensionValues: [{ value: "110586123400" }], metricValues: [{ value: 2400 }, { value: 120 }] },
    { dimensionValues: [{ value: "110586123401" }], metricValues: [{ value: 900 }, { value: 45 }] },
  ],
};

describe("the request eBay actually receives", () => {
  it("leaves eBay's filter punctuation unencoded", async () => {
    // URLSearchParams escapes { } [ ] : and , — eBay's own examples don't, and
    // several of its endpoints reject the escaped form. A prime suspect for a
    // report that returns nothing on perfectly good credentials.
    const cap = stub(REPORT);
    await fetchTrafficReport("token");
    expect(cap.url).toContain("filter=marketplace_ids:{EBAY_US}");
    expect(cap.url).toContain("date_range:[");
    expect(cap.url).not.toContain("%7B");
    expect(cap.url).not.toContain("%5B");
  });

  it("stops the window before today, because eBay's data lags", async () => {
    const cap = stub(REPORT);
    await fetchTrafficReport("token");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const range = /date_range:\[(\d{8})\.\.(\d{8})\]/.exec(cap.url ?? "");
    expect(range).not.toBeNull();
    expect(Number(range![2])).toBeLessThan(Number(today));
    expect(Number(range![1])).toBeLessThan(Number(range![2]));
  });

  it("asks for both metrics", async () => {
    const cap = stub(REPORT);
    await fetchTrafficReport("token");
    expect(cap.url).toContain("LISTING_VIEWS_TOTAL");
    expect(cap.url).toContain("LISTING_IMPRESSION_TOTAL");
  });
});

describe("reading the report", () => {
  it("maps views and impressions onto listing ids", async () => {
    stub(REPORT);
    const r = await fetchTrafficReport("token");
    expect(r.byListing["110586123400"]).toEqual({ views: 120, impressions: 2400 });
    expect(r.byListing["110586123401"]).toEqual({ views: 45, impressions: 900 });
    expect(r.unavailable).toBeUndefined();
  });

  it("reads the metric order from the header rather than assuming it", async () => {
    // eBay does not promise the order the metrics were requested in.
    stub({
      ...REPORT,
      header: {
        dimensionKeys: [{ key: "LISTING" }],
        metrics: [{ key: "LISTING_VIEWS_TOTAL" }, { key: "LISTING_IMPRESSION_TOTAL" }],
      },
    });
    const r = await fetchTrafficReport("token");
    expect(r.byListing["110586123400"]).toEqual({ views: 2400, impressions: 120 });
  });

  it("accepts LISTING_ID as the dimension key too", async () => {
    stub({ ...REPORT, header: { ...REPORT.header, dimensionKeys: [{ key: "LISTING_ID" }] } });
    const r = await fetchTrafficReport("token");
    expect(Object.keys(r.byListing)).toHaveLength(2);
  });
});

describe("when it doesn't work, saying why", () => {
  it("names the missing permission on a 403", async () => {
    stub({ errors: [{ errorId: 1100, message: "Insufficient permissions" }] }, 403);
    const r = await fetchTrafficReport("token");
    expect(r.unavailable).toMatch(/analytics permission/i);
    expect(r.unavailable).toMatch(/reconnect/i);
    expect(r.debug?.httpStatus).toBe(403);
  });

  it("relays eBay's own sentence on any other failure", async () => {
    // The first version collapsed every failure into one generic line, which
    // made a broken report impossible to diagnose from the screen.
    stub(
      { errors: [{ errorId: 3001, message: "Bad filter", longMessage: "date_range is malformed." }] },
      400
    );
    const r = await fetchTrafficReport("token");
    expect(r.unavailable).toContain("date_range is malformed.");
    expect(r.debug?.errors?.[0].errorId).toBe(3001);
  });

  it("keeps a non-JSON body so a proxy error is still readable", async () => {
    stub(null, 502, "<html>Bad Gateway</html>");
    const r = await fetchTrafficReport("token");
    expect(r.debug?.raw).toContain("Bad Gateway");
  });

  it("reports what it parsed when the call succeeded but nothing matched", async () => {
    stub({ header: { dimensionKeys: [{ key: "DAY" }], metrics: [] }, records: [{}] });
    const r = await fetchTrafficReport("token");
    expect(r.unavailable).toMatch(/couldn't match/i);
    expect(r.debug?.parsed?.recordCount).toBe(1);
  });

  it("distinguishes an empty report from a broken one", async () => {
    stub({ header: REPORT.header, records: [] });
    const r = await fetchTrafficReport("token");
    expect(r.unavailable).toMatch(/no traffic data/i);
  });

  it("never throws, whatever the network does", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await fetchTrafficReport("token");
    expect(r.byListing).toEqual({});
    expect(r.unavailable).toContain("ECONNRESET");
  });

  it("carries no credentials in the debug payload", async () => {
    stub({ errors: [{ errorId: 1, message: "x" }] }, 400);
    const r = await fetchTrafficReport("super-secret-token");
    expect(JSON.stringify(r.debug)).not.toContain("super-secret-token");
  });
});
