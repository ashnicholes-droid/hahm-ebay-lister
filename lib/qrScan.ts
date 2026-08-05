"use client";

// Browser-side QR detection for the delimiter flow.
//
// Two decoders, tried in order:
//   1. The native BarcodeDetector API (Chrome/Edge/Android, and Safari 17+).
//      Hardware-accelerated and free of any bundle cost.
//   2. jsQR, a pure-JS fallback bundled with the app. Slower, but works
//      everywhere and — crucially — needs no network. The app's CSP is
//      `script-src 'self'`, so a CDN-hosted decoder would simply be blocked.
//
// Everything runs locally in the browser: a label photo never leaves the device
// unless it ends up attached to a listing.

import jsQR from "jsqr";
import { extractSku } from "@/lib/qr";

// QR modules are large relative to the image; decoding a downscaled copy is both
// faster and more reliable than working at full camera resolution.
const SCAN_DIM = 800;

type BarcodeDetectorCtor = new (opts: { formats: string[] }) => {
  detect(source: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]>;
};

function nativeDetector(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

function toCanvas(src: ImageBitmap | HTMLImageElement): HTMLCanvasElement | null {
  const w = src.width;
  const h = src.height;
  if (!w || !h) return null;
  const ratio = Math.min(1, SCAN_DIM / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Decode a QR inventory number from an already-decoded image.
 *
 * Returns the sanitised SKU, or "" when the photo holds no usable label —
 * which is the normal case for the item photos themselves.
 */
export async function scanQrSku(src: ImageBitmap | HTMLImageElement): Promise<string> {
  const Detector = nativeDetector();
  if (Detector) {
    try {
      const results = await new Detector({ formats: ["qr_code"] }).detect(src);
      for (const r of results) {
        const sku = extractSku(r.rawValue);
        if (sku) return sku;
      }
      // A native detector that ran and found nothing is authoritative — no need
      // to pay for the JS fallback on every item photo in the batch.
      return "";
    } catch {
      // Some browsers expose the constructor but throw for unsupported formats.
      // Fall through to jsQR.
    }
  }

  const canvas = toCanvas(src);
  if (!canvas) return "";
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Labels get photographed against dark bins and shiny plastic sleeves as often
  // as on white paper, so try the inverted image too before giving up.
  const found = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return found ? extractSku(found.data) : "";
}

/** True when this browser can decode QR codes at all (it always can — jsQR ships with the app). */
export function qrScanningAvailable(): boolean {
  return typeof document !== "undefined";
}
