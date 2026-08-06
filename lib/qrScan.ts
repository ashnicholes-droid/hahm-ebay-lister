"use client";

// Browser-side QR detection for the delimiter flow.
//
// Two decoders. The native BarcodeDetector API is tried first where it exists
// (Android Chrome, Edge) because it's hardware-accelerated and free; jsQR is
// bundled as the fallback and works everywhere — including iOS Safari, which has
// no native detector, and it needs no network, which matters because the app's
// CSP is `script-src 'self'` and would block a CDN-hosted decoder.
//
// A native detector that returns nothing is NOT treated as authoritative. It
// used to be, as an optimization, and that was a mistake: Chrome exposes
// BarcodeDetector on devices where the platform backend can't actually service
// it, so `detect()` resolves to an empty array for a perfectly good label and
// the reliable decoder never got a turn. Correctness first — jsQR runs whenever
// the native pass comes up empty.
//
// Everything runs locally. A label photo never leaves the device to be decoded.

import jsQR from "jsqr";
import { extractSku } from "@/lib/qr";

// Scan passes, in increasing cost. Most photos in a batch are item photos with
// no label at all, so the cheap pass runs on everything and the expensive ones
// only on photos that came up empty.
const QUICK_PASSES = [1000, 1600] as const;
// Only for an explicit "scan harder" retry: a centre crop rescues a label that
// is small and far away, at the cost of missing labels near the frame edge.
const THOROUGH_CROP = { dim: 1400, crop: 0.55 } as const;

type BarcodeDetectorCtor = new (opts: { formats: string[] }) => {
  detect(source: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]>;
};

type Source = ImageBitmap | HTMLImageElement;

function nativeDetector(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

/** Draw `src` (optionally a centred crop of it) into a canvas at most `dim` across. */
function draw(src: Source, dim: number, crop = 1): ImageData | null {
  const sw = src.width;
  const sh = src.height;
  if (!sw || !sh) return null;

  const cw = sw * crop;
  const ch = sh * crop;
  const sx = (sw - cw) / 2;
  const sy = (sh - ch) / 2;

  const ratio = Math.min(1, dim / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * ratio));
  canvas.height = Math.max(1, Math.round(ch * ratio));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function decode(image: ImageData | null): string {
  if (!image) return "";
  // Labels get photographed against dark bins and inside shiny sleeves as often
  // as on white paper, so try the inverted image too before giving up.
  const found = jsQR(image.data, image.width, image.height, {
    inversionAttempts: "attemptBoth",
  });
  return found ? extractSku(found.data) : "";
}

async function tryNative(src: Source): Promise<string> {
  const Detector = nativeDetector();
  if (!Detector) return "";
  try {
    for (const r of await new Detector({ formats: ["qr_code"] }).detect(src)) {
      const sku = extractSku(r.rawValue);
      if (sku) return sku;
    }
  } catch {
    // Some browsers expose the constructor but reject the format. Not fatal —
    // jsQR is about to run anyway.
  }
  return "";
}

/**
 * Decode a QR inventory number from an already-decoded image.
 *
 * Returns the sanitised SKU, or "" when the photo holds no usable label —
 * which is the normal answer for the item photos themselves.
 *
 * `thorough` adds a centre-crop pass for labels that are small and distant. It
 * roughly doubles the cost, so it's reserved for an explicit rescan rather than
 * charged to every photo on import.
 */
export async function scanQrSku(
  src: Source,
  { thorough = false }: { thorough?: boolean } = {}
): Promise<string> {
  const native = await tryNative(src);
  if (native) return native;

  for (const dim of QUICK_PASSES) {
    const sku = decode(draw(src, dim));
    if (sku) return sku;
  }

  if (thorough) {
    const sku = decode(draw(src, THOROUGH_CROP.dim, THOROUGH_CROP.crop));
    if (sku) return sku;
  }

  return "";
}

/** Load a data URL / object URL into an image element scanning can use. */
export async function loadImageForScan(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read this image."));
    img.src = src;
  });
}

/** Which decoder this browser will lead with — surfaced in the UI when a scan finds nothing. */
export function decoderName(): string {
  return nativeDetector() ? "native + bundled decoder" : "bundled decoder";
}
