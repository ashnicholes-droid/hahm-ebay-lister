// Resize photos in the browser before upload.
//
// We produce TWO sizes per photo:
//   • data      — ~1024px, used for writing the listing (needs detail: tags, etc.)
//   • previewUrl — ~400px thumbnail, used for on-screen display AND for the
//                  sort step (which only needs to tell items apart). Keeping the
//                  sort payload tiny avoids Vercel's 4.5 MB request-body limit
//                  when a whole batch is sent at once.

import { scanQrSku } from "@/lib/qrScan";

const FULL_DIM = 1024;
const FULL_QUALITY = 0.82;
const THUMB_DIM = 360;
const THUMB_QUALITY = 0.5;

export interface ResizedImage {
  mediaType: "image/jpeg";
  data: string; // base64 (no prefix) ~1024px — for listing analysis
  previewUrl: string; // data url ~400px — for display + sorting
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
