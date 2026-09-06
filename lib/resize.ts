// Resize photos in the browser before upload.
//
// We produce TWO sizes per photo:
//   • data      — ~1024px, used for writing the listing (needs detail: tags, etc.)
//   • previewUrl — ~400px thumbnail, used for on-screen display AND for the
//                  sort step (which only needs to tell items apart). Keeping the
//                  sort payload tiny avoids Vercel's 4.5 MB request-body limit
//                  when a whole batch is sent at once.

const FULL_DIM = 1024;
const FULL_QUALITY = 0.82;
const THUMB_DIM = 360;
const THUMB_QUALITY = 0.5;

export interface ResizedImage {
  original: Blob;
  uploadData: string;
  mediaType: "image/jpeg";
  data: string; // base64 (no prefix) ~1024px — for listing analysis
  previewUrl: string; // data url ~400px — for display + sorting
}

export async function resizeImage(file: File): Promise<ResizedImage> {
  const bitmap = await loadBitmap(file);
  const full = drawToJpeg(bitmap, FULL_DIM, FULL_QUALITY);
  // Retain the original locally; upload a high-detail derivative bounded for Vercel.
  let upload = drawToJpeg(bitmap, 2400, 0.9);
  if (upload.length > 2_700_000) upload = drawToJpeg(bitmap, 2000, 0.8);
  if (upload.length > 2_700_000) upload = drawToJpeg(bitmap, 1600, 0.75);
  if (upload.length > 2_700_000)
    throw new Error("Photo is too large to upload.");
  const thumb = drawToJpeg(bitmap, THUMB_DIM, THUMB_QUALITY);
  if ("close" in bitmap) bitmap.close();
  return {
    original: file,
    uploadData: upload.split(",")[1],
    mediaType: "image/jpeg",
    data: full.split(",")[1],
    previewUrl: thumb,
  };
}

function drawToJpeg(
  src: ImageBitmap | HTMLImageElement,
  maxDim: number,
  quality: number,
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
