// Deterministic photo → item grouping using QR delimiters.
//
// The AI sorter (lib/sortPipeline.ts) guesses which photos belong together, and
// on a big mixed batch it sometimes guesses wrong — which is why the review step
// exists. If instead you photograph a QR label carrying the item's inventory
// number as you finish each item, the grouping stops being a guess: the photo
// stream is split at the labels, and each item arrives with its SKU already
// attached. No model call, no review pass, no ambiguity.
//
// Shape of a batch, with the default `markerPosition: "after"`:
//
//   [ shoe front, shoe side, shoe sole, QR(K75-A), mug front, mug base, QR(K75-B) ]
//     └────────────── item K75-A ─────────────┘  └───────── item K75-B ────────┘
//
// Everything here is pure so the edge cases below are covered by unit tests
// rather than discovered on a 300-photo batch.

/** One photo in the incoming stream, annotated with any QR code found in it. */
export interface ScannedPhoto {
  id: string;
  /** Inventory number decoded from a QR code in this photo, if any. */
  sku?: string;
}

export interface GroupedItem {
  /** Photo ids that make up the listing, in capture order. */
  photoIds: string[];
  /** Inventory number from the delimiter, or "" when the item had no label. */
  sku: string;
  /** The delimiter photo's id, kept so the UI can show what produced the SKU. */
  markerPhotoId?: string;
}

export interface GroupingWarning {
  code: "empty-marker" | "unlabelled-tail" | "duplicate-sku" | "no-markers";
  message: string;
  /** Photo ids the warning is about, so the UI can point at them. */
  photoIds: string[];
}

export interface GroupingResult {
  items: GroupedItem[];
  /** Photos that could not be attached to any item. */
  orphanIds: string[];
  warnings: GroupingWarning[];
}

export interface GroupingOptions {
  /**
   * Where the label sits relative to its item's photos. "after" (the default)
   * matches "shoot the item, then shoot its inventory tag"; "before" matches
   * "scan the bin tag, then shoot what's in it".
   */
  markerPosition?: "after" | "before";
  /**
   * Keep the QR photo itself as the item's last listing photo. Off by default —
   * a label photo is inventory bookkeeping, not something buyers want to see.
   */
  includeMarkerPhoto?: boolean;
}

/** Make every SKU unique, appending -2, -3… to repeats. Returns the clashes. */
function dedupeSkus(items: GroupedItem[]): Map<string, string[]> {
  const seen = new Map<string, number>();
  const clashes = new Map<string, string[]>();
  for (const item of items) {
    if (!item.sku) continue;
    const key = item.sku.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      const original = item.sku;
      item.sku = `${item.sku}-${count + 1}`;
      clashes.set(original, [...(clashes.get(original) ?? []), ...item.photoIds]);
    }
  }
  return clashes;
}

/**
 * Split an ordered photo stream into items at its QR delimiters.
 *
 * Photos are consumed in the order given — that order is the eBay photo order,
 * so photoIds[0] becomes each listing's cover image.
 */
export function groupByQrDelimiters(
  photos: ScannedPhoto[],
  options: GroupingOptions = {}
): GroupingResult {
  const { markerPosition = "after", includeMarkerPhoto = false } = options;
  const warnings: GroupingWarning[] = [];

  const markerCount = photos.filter((p) => p.sku).length;
  if (markerCount === 0) {
    return {
      items: [],
      orphanIds: photos.map((p) => p.id),
      warnings: [
        {
          code: "no-markers",
          message:
            "No QR labels were found in these photos. Either add a label photo after each item, or use AI sorting instead.",
          photoIds: [],
        },
      ],
    };
  }

  // "before" is the mirror image of "after": reverse the stream, group it the
  // same way, then un-reverse. Keeps one set of edge cases instead of two.
  const stream = markerPosition === "before" ? [...photos].reverse() : photos;

  const items: GroupedItem[] = [];
  const orphanIds: string[] = [];
  let pending: string[] = [];

  for (const photo of stream) {
    if (!photo.sku) {
      pending.push(photo.id);
      continue;
    }
    if (pending.length === 0) {
      // A label with nothing before it — usually two labels shot back to back,
      // or the very first photo of the batch. There's no item to attach it to.
      warnings.push({
        code: "empty-marker",
        message: `QR label "${photo.sku}" had no photos before it — skipped.`,
        photoIds: [photo.id],
      });
      orphanIds.push(photo.id);
      continue;
    }
    const photoIds = markerPosition === "before" ? [...pending].reverse() : pending;
    if (includeMarkerPhoto) {
      if (markerPosition === "before") photoIds.unshift(photo.id);
      else photoIds.push(photo.id);
    } else {
      orphanIds.push(photo.id);
    }
    items.push({ photoIds, sku: photo.sku, markerPhotoId: photo.id });
    pending = [];
  }

  // Photos trailing the last label belong to an item whose label was never
  // shot. Keep them as a real item rather than dropping them — the seller can
  // type the SKU in on the review board — but say so loudly.
  if (pending.length > 0) {
    const photoIds = markerPosition === "before" ? [...pending].reverse() : pending;
    warnings.push({
      code: "unlabelled-tail",
      message: `${pending.length} photo(s) came ${
        markerPosition === "before" ? "before the first" : "after the last"
      } QR label — grouped as one item with no inventory number. Check it before posting.`,
      photoIds,
    });
    items.push({ photoIds, sku: "" });
  }

  if (markerPosition === "before") {
    items.reverse();
    orphanIds.reverse();
  }

  for (const [sku, photoIds] of dedupeSkus(items)) {
    warnings.push({
      code: "duplicate-sku",
      message: `Inventory number "${sku}" was scanned more than once — the later item(s) were renumbered so eBay doesn't reject them as duplicates.`,
      photoIds,
    });
  }

  return { items, orphanIds, warnings };
}
