import { describe, expect, it } from "vitest";
import { analysisImages, publishDataUrl, publishImages } from "@/lib/photoSizes";
import { chunkImagesForUpload } from "@/lib/uploadBatches";
import type { Photo } from "@/lib/types";

// The listing photos were going to eBay at 1024px — the size chosen for the
// model — which is below eBay's 1600px zoom threshold, so buyers could not
// magnify any picture in any listing this app ever posted. The fix is to keep
// two encodings per photo and send the right one to each place.
//
// These tests are the guard on "the right one". The two fields are both base64
// strings on the same object and look interchangeable at a call site; getting
// the choice backwards degrades every listing silently, which is exactly the
// kind of mistake that needs a test rather than care.

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: "p1",
  previewUrl: "data:image/jpeg;base64,thumb",
  mediaType: "image/jpeg",
  data: "SMALL-1024",
  full: "BIG-1600",
  ...over,
});

describe("what eBay receives", () => {
  it("sends the big copy, not the one sized for the model", () => {
    expect(publishImages([photo()])).toEqual([{ mediaType: "image/jpeg", data: "BIG-1600" }]);
  });

  it("falls back to the small copy when the source had no more pixels", () => {
    // A 900px original, or a batch restored after storage shed the big copies.
    // Sending the small one is correct here — there is nothing larger.
    expect(publishImages([photo({ full: undefined })])[0].data).toBe("SMALL-1024");
  });

  it("keeps order, which is what decides the eBay gallery image", () => {
    const out = publishImages([
      photo({ id: "a", full: "A" }),
      photo({ id: "b", full: "B" }),
      photo({ id: "c", full: undefined, data: "C" }),
    ]);
    expect(out.map((i) => i.data)).toEqual(["A", "B", "C"]);
  });

  it("carries the media type through untouched", () => {
    expect(publishImages([photo({ mediaType: "image/png" })])[0].mediaType).toBe("image/png");
  });
});

describe("the screens that promise “this is what the buyer gets”", () => {
  // The full-size viewer and the eBay preview. Showing the analysis copy there
  // would make both of them quietly wrong about their one job — and the viewer
  // would report a size below the zoom threshold for a photo that publishes
  // above it.
  it("renders the big copy as a data url", () => {
    expect(publishDataUrl(photo())).toBe("data:image/jpeg;base64,BIG-1600");
  });

  it("falls back to the small copy when there is no big one", () => {
    expect(publishDataUrl(photo({ full: undefined }))).toBe("data:image/jpeg;base64,SMALL-1024");
  });

  it("does not double-prefix bytes that already carry one", () => {
    expect(publishDataUrl(photo({ full: "data:image/jpeg;base64,ALREADY" }))).toBe(
      "data:image/jpeg;base64,ALREADY"
    );
  });
});

describe("what the model reads", () => {
  it("never sends the big copy", () => {
    // Twelve 1600px photos in one request is how /api/analyze starts 413ing,
    // and the extra pixels buy nothing: Claude downsamples anyway.
    expect(analysisImages([photo()])).toEqual([{ mediaType: "image/jpeg", data: "SMALL-1024" }]);
  });

  it("is unaffected by whether a big copy exists at all", () => {
    expect(analysisImages([photo({ full: undefined })])[0].data).toBe("SMALL-1024");
  });
});

describe("bigger photos and the request body limit", () => {
  // The reason this is safe: uploads are budgeted in bytes, so tripling the
  // photo size makes MORE requests rather than one oversized one.
  const bytes = (n: number) => "x".repeat(n);

  it("splits a dozen 1600px photos into batches that each stay under the cap", () => {
    const photos = Array.from({ length: 12 }, (_, i) =>
      photo({ id: `p${i}`, full: bytes(1_100_000), data: bytes(300_000) })
    );
    const batches = chunkImagesForUpload(publishImages(photos));
    expect(batches.flat()).toHaveLength(12);
    for (const b of batches) {
      expect(b.reduce((n, i) => n + i.data.length, 0)).toBeLessThan(2_800_000);
    }
  });

  it("makes more batches for the big copies than it did for the small ones", () => {
    const photos = Array.from({ length: 12 }, (_, i) =>
      photo({ id: `p${i}`, full: bytes(1_100_000), data: bytes(300_000) })
    );
    expect(chunkImagesForUpload(publishImages(photos)).length).toBeGreaterThan(
      chunkImagesForUpload(analysisImages(photos)).length
    );
  });

  it("still ships a single oversized photo rather than dropping it", () => {
    const batches = chunkImagesForUpload(publishImages([photo({ full: bytes(3_000_000) })]));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });
});
