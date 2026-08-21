import { describe, expect, it } from "vitest";
import {
  MIN_AGE_DAYS,
  STALE_DAYS,
  ageInDays,
  triageListing,
  triageSummary,
} from "@/lib/triage";

const NOW = Date.parse("2026-08-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();

const judge = (over: Partial<Parameters<typeof triageListing>[0]> = {}) =>
  triageListing(
    {
      startTime: daysAgo(60),
      impressions: 2000,
      views: 80,
      watchCount: 0,
      quantitySold: 0,
      ...over,
    },
    NOW
  );

describe("saying nothing when there's nothing to say", () => {
  // The most important property. A weak nudge on a listing that's simply young
  // trains the seller to ignore the column, and a wrong "this is dead" costs a
  // price cut for no reason.
  it("leaves anything that's selling alone", () => {
    expect(judge({ quantitySold: 1 }).verdict).toBe("fine");
    expect(judge({ quantitySold: 3, watchCount: 9 }).priority).toBe(0);
  });

  it("leaves a young listing alone however bad it looks", () => {
    const young = judge({ startTime: daysAgo(3), impressions: 5, views: 0 });
    expect(young.verdict).toBe("fine");
    expect(young.headline).toBe("Still new");
  });

  it("holds off right up to the age threshold", () => {
    // Crossing the threshold makes a listing eligible to be judged; it does not
    // force a verdict. Bad numbers are ignored below it and heeded above it.
    const bad = { impressions: 40, views: 2 };
    expect(judge({ ...bad, startTime: daysAgo(MIN_AGE_DAYS - 1) }).verdict).toBe("fine");
    expect(judge({ ...bad, startTime: daysAgo(MIN_AGE_DAYS) }).priority).toBeGreaterThan(0);
  });

  it("stays quiet on a healthy listing however old it is, short of stale", () => {
    expect(judge({ startTime: daysAgo(STALE_DAYS - 1) }).verdict).toBe("fine");
  });

  it("leaves a listing with healthy traffic alone", () => {
    const ok = judge({ startTime: daysAgo(20), impressions: 3000, views: 200, watchCount: 0 });
    expect(ok.verdict).toBe("fine");
  });
});

describe("distinguishing the three ways a listing fails", () => {
  it("calls a findability problem a findability problem", () => {
    // Almost nobody is being shown it. Cutting the price wouldn't help.
    const t = judge({ impressions: 40, views: 3 });
    expect(t.verdict).toBe("invisible");
    expect(t.suggestion).toMatch(/findability|title|specifics/i);
    expect(t.suggestion).not.toMatch(/lower price|cut the price/i);
  });

  it("calls a scroll-past problem what it is", () => {
    // Plenty of impressions, almost no clicks: the search tile isn't working.
    const t = judge({ impressions: 4000, views: 12 });
    expect(t.verdict).toBe("poor-clickthrough");
    expect(t.suggestion).toMatch(/photo|price shown/i);
    expect(t.evidence).toContain("4000 impressions");
  });

  it("ranks watchers-who-didn't-buy highest, since an offer is right there", () => {
    const watched = judge({ watchCount: 6 });
    expect(watched.verdict).toBe("watched-not-bought");
    expect(watched.headline).toMatch(/6 watchers/);
    expect(watched.priority).toBeGreaterThan(judge({ impressions: 40, views: 3 }).priority);
  });

  it("calls an old listing with traffic and no watchers stale", () => {
    const t = judge({ startTime: daysAgo(STALE_DAYS), watchCount: 0 });
    expect(t.verdict).toBe("stale");
    expect(t.suggestion).toMatch(/lower price|end it/i);
  });

  it("uses the singular for one watcher", () => {
    expect(judge({ watchCount: 1 }).headline).toBe("1 watcher, no sale");
  });
});

describe("working without traffic figures", () => {
  // Views and impressions need eBay's analytics permission. Without them the
  // column must still be useful rather than blank.
  it("still spots an old listing with watchers", () => {
    const t = judge({ impressions: null, views: null, watchCount: 4 });
    expect(t.verdict).toBe("watched-not-bought");
    expect(t.suggestion).toMatch(/offer/i);
  });

  it("still spots an old listing with nothing", () => {
    const t = judge({ impressions: null, views: null, watchCount: 0 });
    expect(t.verdict).toBe("stale");
    expect(t.evidence).toMatch(/analytics permission/i);
  });

  it("says nothing about a middle-aged listing it can't judge", () => {
    const t = judge({ startTime: daysAgo(20), impressions: null, views: null, watchCount: 0 });
    expect(t.verdict).toBe("fine");
  });
});

describe("every verdict carries its evidence", () => {
  it("never asks to be believed without showing the numbers", () => {
    for (const over of [
      { impressions: 40, views: 3 },
      { impressions: 4000, views: 12 },
      { watchCount: 6 },
      { startTime: daysAgo(STALE_DAYS) },
    ]) {
      const t = judge(over);
      expect(t.priority).toBeGreaterThan(0);
      expect(t.headline.length).toBeGreaterThan(0);
      expect(t.evidence.length).toBeGreaterThan(0);
      expect(t.suggestion.length).toBeGreaterThan(0);
    }
  });
});

describe("age", () => {
  it("counts whole days", () => {
    expect(ageInDays(daysAgo(30), NOW)).toBe(30);
    expect(ageInDays(daysAgo(0), NOW)).toBe(0);
  });

  it("returns null for a date eBay didn't send", () => {
    expect(ageInDays("", NOW)).toBeNull();
    expect(ageInDays("not a date", NOW)).toBeNull();
  });

  it("never goes negative on clock skew", () => {
    expect(ageInDays(new Date(NOW + 86400_000).toISOString(), NOW)).toBe(0);
  });
});

describe("the summary line", () => {
  it("says so plainly when nothing is stuck", () => {
    expect(triageSummary([judge({ quantitySold: 1 }), judge({ startTime: daysAgo(2) })])).toMatch(
      /Nothing looks stuck/
    );
  });

  it("counts what needs attention and calls out watchers", () => {
    const s = triageSummary([judge({ watchCount: 3 }), judge({ impressions: 40, views: 2 })]);
    expect(s).toMatch(/2 listings worth a look/);
    expect(s).toMatch(/1 with watchers/);
  });

  it("is empty for an empty list", () => {
    expect(triageSummary([])).toBe("");
  });
});
