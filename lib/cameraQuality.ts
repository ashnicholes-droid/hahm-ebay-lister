// Can this camera actually produce a photo eBay will let buyers zoom?
//
// The app now encodes a 1600px copy for eBay, because that is where eBay turns
// on buyer zoom. But encoding never invents detail — lib/resize.ts and the
// camera sheet both refuse to upscale — so the 1600px copy is only 1600px if
// the SOURCE had that many pixels.
//
// On an iPhone, the in-app camera does not. Safari hands `getUserMedia` a 720p
// track and nothing you put in the constraints changes it: the sheet asks for
// 1920×1080 and gets 1280×720. Every photo taken with the in-app shutter on an
// iPhone therefore tops out at 720p, which is below the zoom threshold, and the
// fix that shipped is silently defeated on the device most likely to be used.
//
// The native camera is NOT capped — a file input hands back the full-resolution
// JPEG the Camera app produced, tens of megapixels. So the capability is
// already there; what was missing is any way for the person holding the phone
// to know which button gets it.
//
// This module is the honest answer, computed from the stream that actually
// opened rather than from sniffing the user agent. Device detection would be
// wrong the moment Safari lifts the cap, or on any device that has its own.

import { cropRect, type FramingMode } from "./cameraFraming";

/** eBay enables buyer zoom at 1600px on the longest side. */
export const ZOOM_DIM = 1600;

export interface CaptureQuality {
  /** Longest side, in pixels, of the photo this stream would produce. */
  longestSide: number;
  /** True when that clears eBay's zoom threshold. */
  zoomCapable: boolean;
  /** How far short it falls, as a fraction. 0 when it doesn't. */
  shortfall: number;
  /** Ready to render. Empty when there is nothing worth saying. */
  message: string;
}

/**
 * What the live camera can actually deliver, given its stream and the framing.
 *
 * Framing matters and is easy to miss: a square crop of a 1280×720 stream is
 * 720×720, so choosing Square costs you another 44% of the long side. Judging
 * the stream alone would call that one right for full-frame and wrong for
 * square.
 */
export function captureQuality(
  videoWidth: number,
  videoHeight: number,
  framing: FramingMode
): CaptureQuality {
  if (!(videoWidth > 0) || !(videoHeight > 0)) {
    return { longestSide: 0, zoomCapable: false, shortfall: 0, message: "" };
  }
  const crop = cropRect(videoWidth, videoHeight, framing);
  const longestSide = Math.round(Math.max(crop.sw, crop.sh));
  const zoomCapable = longestSide >= ZOOM_DIM;
  const shortfall = zoomCapable ? 0 : (ZOOM_DIM - longestSide) / ZOOM_DIM;

  return {
    longestSide,
    zoomCapable,
    shortfall,
    message: zoomCapable
      ? ""
      : `This camera gives ${longestSide}px — under the ${ZOOM_DIM}px eBay needs for buyer zoom.` +
        (framing === "square" ? " Full frame would give more." : ""),
  };
}

/**
 * Whether an imported photo cleared the threshold.
 *
 * Same question, asked of a finished file rather than a live stream — for
 * photos that arrive through the file picker, where there is no stream to
 * measure.
 */
export function photoIsZoomCapable(width: number, height: number): boolean {
  return Math.max(width, height) >= ZOOM_DIM;
}

/**
 * How many photos in a batch fall short.
 *
 * A per-photo badge answers "is this one good?"; a seller about to post forty
 * items needs "how many of these are a problem?" without opening each one.
 */
export function countBelowZoom(photos: { full?: string; zoomCapable?: boolean }[]): number {
  return photos.filter((p) => p.zoomCapable === false).length;
}
