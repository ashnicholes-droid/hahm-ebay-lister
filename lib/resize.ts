// Resize photos in the browser before upload.
//
// THREE sizes per photo, because three jobs want genuinely different things:
//
//   • previewUrl — ~360px. On-screen display and the sort step, which only has
//                  to tell items apart. Keeping the sort payload tiny is what
//                  stops a whole batch hitting Vercel's 4.5 MB body limit.
//   • data       — ~1024px. What the model reads. Enough to make out a tag or a
//                  maker's mark, and deliberately NOT bigger: Claude downsamples
//                  to about 1568px anyway, so a larger file buys no accuracy and
//                  would push a 12-photo analyze request against the body limit.
//   • full       — ~1600px. What eBay receives. eBay turns on buyer ZOOM at
//                  1600px on the longest side; below that, nobody can magnify
//                  your photos. Uploading the 1024px copy — which is what this
//                  used to do — quietly gave that away on every listing.
//
// Splitting the last two is the whole point. One file cannot be both small
// enough to batch a dozen into an analysis request and large enough to earn
// eBay's zoom, so the same capture is encoded twice at different sizes.

import { scanQrSku } from "@/lib/qrScan";
import { photoIsZoomCapable } from "@/lib/cameraQuality";

const FULL_DIM = 1024;
const FULL_QUALITY = 0.82;
const THUMB_DIM = 360;
const THUMB_QUALITY = 0.5;
/** eBay enables buyer zoom at 1600px on the longest side. */
export const EBAY_DIM = 1600;
export const EBAY_QUALITY = 0.85;

export interface ResizedImage {
  mediaType: "image/jpeg";
  data: string; // base64 (no prefix) ~1024px — for listing analysis
  previewUrl: string; // data url ~400px — for display + sorting
  /**
   * base64 (no prefix) ~1600px — what eBay receives.
   *
   * Absent when the source was already smaller than 1600px on its long side, in
   * which case `data` is as good as it gets and re-encoding larger would add
   * bytes without adding detail.
   */
  full?: string;
  /**
   * Whether the SOURCE had enough pixels to earn eBay's buyer zoom.
   *
   * Recorded at import because this is the only moment the original is in hand.
   * False is a real and common answer — an iPhone's in-app camera is capped at
   * 720p by Safari — and it is the difference between a listing buyers can
   * magnify and one they can't.
   */
  zoomCapable?: boolean;
  // Inventory number decoded from a QR label in this photo, when there is one.
  // Set during import because that's the one moment the full-resolution bitmap
  // is already in hand — re-decoding a thumbnail later loses QR modules.
  sku?: string;
}

export async function resizeImage(
  file: File,
  { detectQr = true }: { detectQr?: boolean } = {}
): Promise<ResizedImage> {
  const bitmap = await loadBitmap(file);
  const full = drawToJpeg(bitmap, FULL_DIM, FULL_QUALITY);
  const thumb = drawToJpeg(bitmap, THUMB_DIM, THUMB_QUALITY);
  // Only worth encoding when the original actually has the pixels. Upscaling a
  // 900px photo to 1600 adds bytes and no detail, and eBay's zoom would have
  // nothing extra to show.
  const longest = Math.max(
    "width" in bitmap ? bitmap.width : 0,
    "height" in bitmap ? bitmap.height : 0
  );
  const ebay = longest > FULL_DIM ? drawToJpeg(bitmap, EBAY_DIM, EBAY_QUALITY) : null;
  const zoomCapable = photoIsZoomCapable(
    "width" in bitmap ? bitmap.width : 0,
    "height" in bitmap ? bitmap.height : 0
  );
  // Scan before releasing the bitmap. A failed scan is never fatal — the photo
  // is simply treated as an ordinary item photo.
  let sku = "";
  if (detectQr) {
    try {
      sku = await scanQrSku(bitmap);
    } catch {
      /* decoder unavailable or image unreadable — treat as "no label" */
    }
  }
  if ("close" in bitmap) bitmap.close();
  return {
    mediaType: "image/jpeg",
    data: full.split(",")[1],
    previewUrl: thumb,
    ...(ebay ? { full: ebay.split(",")[1] } : {}),
    zoomCapable,
    ...(sku ? { sku } : {}),
  };
}

function drawToJpeg(
  src: ImageBitmap | HTMLImageElement,
  maxDim: number,
  quality: number
): string {
  const w = "width" in src ? src.width : 0;
  const h = "height" in src ? src.height : 0;
  const { width, height } = scaleDown(w, h, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image.");
  ctx.drawImage(src, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function scaleDown(w: number, h: number, max: number) {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path (e.g. some HEIC/Safari cases).
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image file."));
    };
    img.src = url;
  });
}
