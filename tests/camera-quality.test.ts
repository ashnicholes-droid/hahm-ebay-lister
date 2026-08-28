import { describe, expect, it } from "vitest";
import {
  ZOOM_DIM,
  captureQuality,
  countBelowZoom,
  photoIsZoomCapable,
} from "@/lib/cameraQuality";

// The app encodes a 1600px copy for eBay, because that is where eBay turns on
// buyer zoom. But encoding never invents detail — so the 1600px copy is only
// 1600px if the SOURCE had the pixels.
//
// On an iPhone it doesn't. Safari hands getUserMedia a 720p track no matter
// what the constraints ask for, so the in-app shutter tops out at 1280x720 and
// the zoom fix is silently defeated on the device most likely to be used. The
// phone's own Camera app has no such cap.
//
// These tests hold the honesty: measure what the stream actually gave, say so,
// and never claim zoom for a photo that can't have it.

describe("what the live camera can actually deliver", () => {
  it("clears the bar on a 1080p stream in full frame", () => {
    const q = captureQuality(1920, 1080, "full");
    expect(q.longestSide).toBe(1920);
    expect(q.zoomCapable).toBe(true);
    // Nothing to warn about, so nothing is said.
    expect(q.message).toBe("");
  });

  it("falls short on the 720p stream Safari gives an iPhone", () => {
    // The case this whole module exists for.
    const q = captureQuality(1280, 720, "full");
    expect(q.longestSide).toBe(1280);
    expect(q.zoomCapable).toBe(false);
    expect(q.message).toMatch(/1280px/);
    expect(q.message).toMatch(/1600px/);
  });

  it("counts the SQUARE crop, not the stream it came from", () => {
    // Easy to get wrong and expensive: a square crop of 1920x1080 is 1080x1080,
    // so choosing Square costs 44% of the long side and drops a stream that
    // WOULD have zoomed below the threshold.
    expect(captureQuality(1920, 1080, "full").zoomCapable).toBe(true);
    expect(captureQuality(1920, 1080, "square").longestSide).toBe(1080);
    expect(captureQuality(1920, 1080, "square").zoomCapable).toBe(false);
  });

  it("tells you full frame would help, but only when you're on square", () => {
    expect(captureQuality(1920, 1080, "square").message).toMatch(/Full frame/);
    expect(captureQuality(1280, 720, "full").message).not.toMatch(/Full frame/);
  });

  it("treats exactly 1600px as good enough, since that is the threshold", () => {
    expect(captureQuality(ZOOM_DIM, 900, "full").zoomCapable).toBe(true);
    expect(captureQuality(ZOOM_DIM - 1, 900, "full").zoomCapable).toBe(false);
  });

  it("says nothing at all before the stream has opened", () => {
    // A warning that flashes up while the camera is still starting would be
    // noise, and worse, briefly wrong.
    for (const [w, h] of [
      [0, 0],
      [0, 720],
      [-1, 100],
      [NaN, NaN],
    ]) {
      const q = captureQuality(w, h, "full");
      expect(q.message).toBe("");
      expect(q.longestSide).toBe(0);
    }
  });

  it("reports how far short it falls, for a caller that wants to grade it", () => {
    expect(captureQuality(1280, 720, "full").shortfall).toBeCloseTo((1600 - 1280) / 1600, 4);
    expect(captureQuality(1920, 1080, "full").shortfall).toBe(0);
  });
});

describe("judging a finished photo", () => {
  it("passes a full-resolution phone photo", () => {
    // What the Camera app actually produces — nowhere near the cap.
    expect(photoIsZoomCapable(4032, 3024)).toBe(true);
  });

  it("fails a 720p capture whichever way round it is", () => {
    expect(photoIsZoomCapable(1280, 720)).toBe(false);
    expect(photoIsZoomCapable(720, 1280)).toBe(false);
  });

  it("uses the LONG side, so a tall portrait photo counts", () => {
    expect(photoIsZoomCapable(1200, 1800)).toBe(true);
  });
});

describe("grading a whole batch", () => {
  it("counts only the photos actually known to fall short", () => {
    // undefined is not false: a photo imported before this existed has no
    // verdict, and guessing one would put a warning on a good photo.
    expect(
      countBelowZoom([
        { zoomCapable: true },
        { zoomCapable: false },
        { zoomCapable: false },
        {},
      ])
    ).toBe(2);
  });

  it("is zero for an empty batch", () => {
    expect(countBelowZoom([])).toBe(0);
  });
});
