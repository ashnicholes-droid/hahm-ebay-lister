import { describe, expect, test } from "vitest";
import {
  chunkImagesForUpload,
  MAX_BATCH_BASE64_CHARS,
  MAX_BATCH_PHOTOS,
} from "../lib/uploadBatches";

const img = (id: string, chars: number) => ({
  mediaType: "image/jpeg",
  data: id.repeat(chars),
});

describe("chunkImagesForUpload", () => {
  test("returns no batches for no images", () => {
    expect(chunkImagesForUpload([])).toEqual([]);
  });

  test("keeps a small set in a single batch", () => {
    const images = [img("a", 100), img("b", 100), img("c", 100)];
    expect(chunkImagesForUpload(images)).toEqual([images]);
  });

  test("caps the number of photos per batch", () => {
    const images = Array.from({ length: 9 }, (_, i) => img(String(i), 10));
    const batches = chunkImagesForUpload(images);
    expect(batches.map((b) => b.length)).toEqual([4, 4, 1]);
  });

  test("starts a new batch when the base64 budget would overflow", () => {
    const third = Math.ceil(MAX_BATCH_BASE64_CHARS / 3);
    // Two fit under the budget; the third would overflow it.
    const images = [img("a", third), img("b", third), img("c", third)];
    const batches = chunkImagesForUpload(images);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  test("rejects oversize photos before creating an invalid upload request", () => {
    const images = [img("a", MAX_BATCH_BASE64_CHARS + 10), img("b", 100)];
    expect(() => chunkImagesForUpload(images)).toThrow(
      "exceeds the upload size limit",
    );
  });

  test("preserves photo order across batches", () => {
    const images = Array.from({ length: MAX_BATCH_PHOTOS * 2 + 1 }, (_, i) =>
      img(`${i}`, 10),
    );
    const flattened = chunkImagesForUpload(images).flat();
    expect(flattened).toEqual(images);
  });

  test("honors custom limits", () => {
    const images = [img("a", 5), img("b", 5), img("c", 5)];
    expect(chunkImagesForUpload(images, 100, 2).map((b) => b.length)).toEqual([
      2, 1,
    ]);
    expect(chunkImagesForUpload(images, 9, 4).map((b) => b.length)).toEqual([
      1, 1, 1,
    ]);
  });
});
