// Split a listing's photos into upload batches that stay far under Vercel's
// 4.5 MB serverless request-body limit.
//
// Photos reach eBay via /api/ebay/upload-photos in these batches; the publish
// request then carries only the returned eBay-hosted URLs, so no request in
// the posting flow can ever hit the body limit again (the old single-request
// flow shipped all 12 base64 photos at once and 413-failed on photo-heavy
// items like chunky knits).

export interface UploadImage {
  mediaType: string;
  data: string; // raw base64, no data-url prefix
}

// ~2.8 MB of base64 (~2.1 MB of image data) per request. Photos bound for eBay
// are now encoded at 1600px — the size that earns buyer zoom — which runs
// ~400 KB–1.4 MB of base64 each, so batches hold two or three rather than the
// four a 1024px copy allowed. That is exactly what a byte budget is for: bigger
// photos make more, smaller requests instead of one that 413s. Even a worst-case
// single photo shipped alone stays well under the 4.5 MB platform limit.
export const MAX_BATCH_BASE64_CHARS = 2_800_000;
// Bound the count too, so many tiny photos don't pile into one slow request.
export const MAX_BATCH_PHOTOS = 4;

export function chunkImagesForUpload<T extends UploadImage>(
  images: T[],
  maxChars: number = MAX_BATCH_BASE64_CHARS,
  maxPhotos: number = MAX_BATCH_PHOTOS
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const img of images) {
    const size = img.data.length;
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= maxPhotos || currentChars + size > maxChars);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    // An oversize single photo still ships alone rather than being dropped —
    // one browser-resized photo can't approach the platform limit.
    current = [...current, img];
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
