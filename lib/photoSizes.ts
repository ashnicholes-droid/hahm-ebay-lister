// Which encoding of a photo goes where.
//
// Every photo is now held at three sizes (see lib/resize.ts), and the whole
// point of the split is that different destinations get different files:
//
//   • eBay gets the 1600px copy, because eBay turns on buyer ZOOM at 1600px on
//     the longest side. Below that, nobody can magnify the picture.
//   • Claude gets the 1024px copy, because it downsamples to about 1568px
//     anyway — a bigger file buys no accuracy and a twelve-photo request at
//     1600px would push against the request body limit.
//
// This lived as a bare `p.full ?? p.data` at the call sites, which is precisely
// how the wrong copy ends up on a listing: the two fields look interchangeable
// and are not. Naming the choice makes it reviewable, and makes the rule
// testable without a browser.

import type { Photo } from "./types";

export interface OutboundImage {
  mediaType: string;
  data: string; // raw base64, no data-url prefix
}

/**
 * The copy that PUBLISHES — the largest one available.
 *
 * `full` is absent only when the source photo never had more than ~1024px on
 * its long side (an old download, a low-res camera, a restored batch that had
 * to shed the big copies to fit in storage). Then `data` genuinely is the best
 * there is, and sending it is right — there is nothing larger to send.
 */
export function publishImages(photos: Photo[]): OutboundImage[] {
  return photos.map((p) => ({ mediaType: p.mediaType, data: p.full ?? p.data }));
}

/**
 * The copy the MODEL reads — deliberately the smaller one.
 *
 * Never `full`. Twelve 1600px photos in one analyze request is how that route
 * starts returning 413s, and the extra pixels change nothing about what Claude
 * sees.
 */
export function analysisImages(photos: Photo[]): OutboundImage[] {
  return photos.map((p) => ({ mediaType: p.mediaType, data: p.data }));
}

/**
 * A displayable URL for the copy that publishes.
 *
 * For the screens whose whole promise is "this is what the buyer gets" — the
 * full-size viewer and the eBay preview. Showing them the analysis copy would
 * make them quietly wrong about the one thing they exist to show.
 */
export function publishDataUrl(p: Photo): string {
  const bytes = p.full ?? p.data;
  return bytes.startsWith("data:") ? bytes : `data:${p.mediaType};base64,${bytes}`;
}
