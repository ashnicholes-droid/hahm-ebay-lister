// Packaging catalogue.
//
// Picking the box is what turns "this item weighs 3 lb" into a shippable
// estimate: the box adds its own weight, and — more expensively — its own
// volume, because carriers bill large-but-light packages on dimensional weight
// rather than what the scale says.

export interface Box {
  id: string;
  name: string;
  /** Usable interior, inches. Sorted ascending by volume in BOXES. */
  inner: { l: number; w: number; h: number };
  /** The empty box/mailer itself, ounces. Real cardboard is not weightless. */
  emptyOz: number;
  /**
   * USPS Priority Flat Rate ships for one price regardless of weight, up to
   * 70 lb. Whether that beats weight-based pricing depends entirely on the
   * item, which is why the estimator prices every option and compares.
   */
  flatRate?: boolean;
}

/**
 * Padding allowance around the item, inches per axis (total, not per side).
 * Under-padding is how a "fits exactly" box becomes a damaged-item case.
 */
export const PADDING_IN = 1.5;
/** Bubble wrap / paper fill, ounces, scaled by how much air is in the box. */
export const FILL_OZ_PER_CUBIC_FOOT = 3;

// Sorted smallest-volume-first at module load rather than by hand, so
// selectBox's "first that fits" is genuinely "smallest that fits" and stays
// that way when someone adds a box to the middle of this list.
export const BOXES: Box[] = [
  { id: "poly-sm", name: "Poly mailer, small (10×13)", inner: { l: 12.5, w: 9.5, h: 1 }, emptyOz: 0.6 },
  { id: "box-8x6x4", name: "Box 8×6×4", inner: { l: 8, w: 6, h: 4 }, emptyOz: 3 },
  { id: "usps-fr-sm", name: "USPS Priority Flat Rate, small", inner: { l: 8.6, w: 5.4, h: 1.6 }, emptyOz: 1.5, flatRate: true },
  { id: "poly-lg", name: "Poly mailer, large (14×17)", inner: { l: 16.5, w: 13.5, h: 1.5 }, emptyOz: 1.2 },
  { id: "box-10x8x6", name: "Box 10×8×6", inner: { l: 10, w: 8, h: 6 }, emptyOz: 5 },
  { id: "usps-fr-md", name: "USPS Priority Flat Rate, medium", inner: { l: 11, w: 8.5, h: 5.5 }, emptyOz: 4, flatRate: true },
  { id: "box-12x9x4", name: "Box 12×9×4", inner: { l: 12, w: 9, h: 4 }, emptyOz: 5 },
  { id: "box-12x12x8", name: "Box 12×12×8", inner: { l: 12, w: 12, h: 8 }, emptyOz: 8 },
  { id: "usps-fr-lg", name: "USPS Priority Flat Rate, large", inner: { l: 12, w: 12, h: 5.5 }, emptyOz: 6, flatRate: true },
  { id: "box-14x11x6", name: "Box 14×11×6", inner: { l: 14, w: 11, h: 6 }, emptyOz: 9 },
  { id: "box-16x12x8", name: "Box 16×12×8", inner: { l: 16, w: 12, h: 8 }, emptyOz: 13 },
  { id: "box-18x14x10", name: "Box 18×14×10", inner: { l: 18, w: 14, h: 10 }, emptyOz: 19 },
  { id: "box-20x16x12", name: "Box 20×16×12", inner: { l: 20, w: 16, h: 12 }, emptyOz: 26 },
  { id: "box-24x18x12", name: "Box 24×18×12", inner: { l: 24, w: 18, h: 12 }, emptyOz: 34 },

  // Flat-and-wide. Without these, anything broad but thin — a skillet, a framed
  // print, a record, a laptop — has no box whose two largest sides are big
  // enough except a deep cube, which pushes it over a cubic foot and gets it
  // billed on dimensional weight. That mistake more than doubled the estimate
  // for a 13-inch pan in testing.
  { id: "box-12x12x3", name: "Box 12×12×3 (flat)", inner: { l: 12, w: 12, h: 3 }, emptyOz: 6 },
  { id: "box-14x14x4", name: "Box 14×14×4 (flat)", inner: { l: 14, w: 14, h: 4 }, emptyOz: 8 },
  { id: "box-16x16x4", name: "Box 16×16×4 (flat)", inner: { l: 16, w: 16, h: 4 }, emptyOz: 10 },
  { id: "box-20x16x4", name: "Box 20×16×4 (flat)", inner: { l: 20, w: 16, h: 4 }, emptyOz: 12 },
  { id: "box-24x20x4", name: "Box 24×20×4 (flat)", inner: { l: 24, w: 20, h: 4 }, emptyOz: 16 },

  // Long-and-narrow, for tools, curtain rods, bats, lamp stems.
  { id: "box-20x6x6", name: "Box 20×6×6 (long)", inner: { l: 20, w: 6, h: 6 }, emptyOz: 9 },
  { id: "box-30x6x6", name: "Box 30×6×6 (long)", inner: { l: 30, w: 6, h: 6 }, emptyOz: 13 },
  { id: "box-36x8x8", name: "Box 36×8×8 (long)", inner: { l: 36, w: 8, h: 8 }, emptyOz: 20 },
].sort((a, b) => volumeIn3(a.inner) - volumeIn3(b.inner));

// A function declaration, not a const arrow: BOXES sorts itself with this at
// module load, which happens before a const on this line would be initialised.
/** Volume in cubic inches. */
export function volumeIn3(d: { l: number; w: number; h: number }): number {
  return d.l * d.w * d.h;
}

/**
 * Does an item of these dimensions fit this box, allowing for padding?
 *
 * Both are sorted before comparing, because an item is not "too long" for a box
 * it fits diagonally-agnostically — a 10×2×2 item goes into an 8×6×4 box the
 * long way only if some box axis is ≥ 10. Sorting both sides matches longest to
 * longest and is the standard way to answer this.
 */
export function fits(
  item: { l: number; w: number; h: number },
  box: Box,
  padding = PADDING_IN
): boolean {
  const i = [item.l, item.w, item.h].sort((a, b) => b - a);
  const b = [box.inner.l, box.inner.w, box.inner.h].sort((a, b) => b - a);
  return i.every((v, idx) => v + padding <= b[idx]);
}

/**
 * Smallest general-purpose box the item fits in, or null when nothing works.
 *
 * Flat-rate boxes are excluded on purpose: USPS supplies them for Priority Flat
 * Rate only, and shipping Ground Advantage in one is against their terms. The
 * estimator prices flat rate as its own option using those same boxes, so they
 * are still considered — just not as a generic carton.
 */
export function selectBox(item: { l: number; w: number; h: number }): Box | null {
  return BOXES.find((box) => !box.flatRate && fits(item, box)) ?? null;
}

/** Packing material weight for the air left around the item. */
export function fillOz(box: Box, item: { l: number; w: number; h: number }): number {
  const air = Math.max(0, volumeIn3(box.inner) - volumeIn3(item));
  return Math.round((air / 1728) * FILL_OZ_PER_CUBIC_FOOT * 10) / 10;
}
