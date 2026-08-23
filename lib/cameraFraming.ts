// What part of the camera frame a photo keeps.
//
// This exists because the viewfinder and the capture used to disagree. The
// preview was styled `object-fit: cover` — showing the middle of a 16:9 stream
// inside a much squarer box — while the capture drew the FULL video frame. You
// composed the shot inside the square you could see, and eBay received a far
// wider picture containing everything outside it. The mismatch was worst on a
// Continuity Camera, where the stream is 1920×1080 and the stage is nowhere
// near that shape.
//
// The viewfinder now shows the whole frame, and this decides what is kept, so
// the two cannot drift apart again. Pure and testable, away from the component,
// because the arithmetic is the part that has to be exactly right.

export type FramingMode = "full" | "square";

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The source rectangle to draw from a video frame.
 *
 * "full" keeps every pixel the sensor gave. "square" takes a centred square,
 * which is the shape eBay's gallery and search results use.
 */
export function cropRect(vw: number, vh: number, mode: FramingMode): CropRect {
  if (mode === "full" || vw <= 0 || vh <= 0) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const side = Math.min(vw, vh);
  return { sx: (vw - side) / 2, sy: (vh - side) / 2, sw: side, sh: side };
}
