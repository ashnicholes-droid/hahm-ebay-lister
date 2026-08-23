import { describe, expect, it } from "vitest";
import { cropRect } from "@/lib/cameraFraming";

// The bug this guards: the viewfinder used object-fit: cover while the capture
// drew the full video frame, so the seller composed inside the visible box and
// eBay received everything outside it too. Widest on a Continuity Camera, where
// the stream is 1920×1080 and the stage is nowhere near that shape.

describe("full frame", () => {
  it("keeps every pixel, so nothing is silently discarded", () => {
    expect(cropRect(1920, 1080, "full")).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it("is the identity whatever the stream shape", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [640, 480],
      [1000, 1000],
    ]) {
      expect(cropRect(w, h, "full")).toEqual({ sx: 0, sy: 0, sw: w, sh: h });
    }
  });
});

describe("square framing", () => {
  it("takes a centred square from a 16:9 stream", () => {
    // 1920×1080 → the 1080 square in the middle. 420px trimmed from each side.
    expect(cropRect(1920, 1080, "square")).toEqual({ sx: 420, sy: 0, sw: 1080, sh: 1080 });
  });

  it("takes a centred square from a portrait stream", () => {
    expect(cropRect(1080, 1920, "square")).toEqual({ sx: 0, sy: 420, sw: 1080, sh: 1080 });
  });

  it("is a no-op on an already-square stream", () => {
    expect(cropRect(1000, 1000, "square")).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 1000 });
  });

  it("always produces a square", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [640, 480],
      [1080, 1920],
      [999, 1001],
    ]) {
      const r = cropRect(w, h, "square");
      expect(r.sw).toBe(r.sh);
    }
  });

  it("never reads outside the frame — that would draw transparent pixels", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [1279, 721],
    ]) {
      const r = cropRect(w, h, "square");
      expect(r.sx).toBeGreaterThanOrEqual(0);
      expect(r.sy).toBeGreaterThanOrEqual(0);
      expect(r.sx + r.sw).toBeLessThanOrEqual(w);
      expect(r.sy + r.sh).toBeLessThanOrEqual(h);
    }
  });

  it("stays centred — an off-centre crop moves the item out of the shot", () => {
    const r = cropRect(1920, 1080, "square");
    expect(r.sx).toBeCloseTo(1920 / 2 - r.sw / 2, 6);
  });
});

describe("degenerate input", () => {
  it("doesn't invent a crop before the stream has dimensions", () => {
    // videoWidth is 0 until metadata loads; a crop computed then would be
    // nonsense and drawImage would throw.
    expect(cropRect(0, 0, "square")).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
    expect(cropRect(0, 1080, "square")).toEqual({ sx: 0, sy: 0, sw: 0, sh: 1080 });
  });
});
