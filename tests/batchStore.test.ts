import { describe, expect, it } from "vitest";
import { isQuotaError, savedAgo } from "@/lib/batchStore";

// The IndexedDB paths need a browser and are covered end-to-end in the Playwright
// run (write a batch, reload, restore it). These are the pure helpers around them.

describe("how long ago a batch was saved", () => {
  const ago = (ms: number) => savedAgo(Date.now() - ms);

  it("reads naturally at every scale", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(60_000)).toBe("a minute ago");
    expect(ago(20 * 60_000)).toBe("20 minutes ago");
    expect(ago(60 * 60_000)).toBe("an hour ago");
    expect(ago(5 * 60 * 60_000)).toBe("5 hours ago");
    expect(ago(24 * 60 * 60_000)).toBe("yesterday");
    expect(ago(4 * 24 * 60 * 60_000)).toBe("4 days ago");
  });

  it("never reports a save from the future as negative", () => {
    // Clock skew between save and read shouldn't produce "-3 minutes ago".
    expect(savedAgo(Date.now() + 60_000)).toBe("just now");
  });
});

describe("telling a full disk from a broken one", () => {
  it("recognises the quota error by name", () => {
    const e = new Error("nope");
    e.name = "QuotaExceededError";
    expect(isQuotaError(e)).toBe(true);
  });

  it("recognises it by message when the name is missing", () => {
    expect(isQuotaError(new Error("The quota has been exceeded."))).toBe(true);
  });

  it("does not mistake an ordinary failure for a full disk", () => {
    // These need different advice: one says "post and clear", the other says
    // "your batch isn't being saved".
    expect(isQuotaError(new Error("Local storage write failed."))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
