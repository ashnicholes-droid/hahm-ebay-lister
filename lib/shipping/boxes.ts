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
  /**
   * Envelopes are not small boxes. USPS asks only that the contents fit inside
   * and that the flap closes on its own adhesive, so the useful clearance is a
   * fraction of an inch, not the 1.5" of packing room a carton needs. Applying
   * box padding to an envelope makes every envelope look like it fits nothing.
   */
  paddingIn?: number;
  /**
   * Envelopes only: the thickest the contents may be, inches.
   *
   * Set this and the fit test changes shape — clearance on the two flat axes,
   * a hard ceiling on the third. A single padding number cannot express that. A
   * carton wants room on every side for packing material; an envelope wants a
   * little slack side-to-side and nothing at all through the thickness, because
   * that dimension is the flap closing rather than a wall.
   */
  maxThicknessIn?: number;
  /**
   * eBay's ShippingPackageEnum value for this container, when a specific one
   * exists. Most packaging has none and uses SAFE_PACKAGE_TYPE — see publish.ts,
   * where anything eBay rejects falls back to that.
   */
  ebayPackageType?: string;
  /** True for USPS-supplied packaging that must not be used on other services. */
  carrierSupplied?: boolean;
  /**
   * A poly mailer: a bag, not a container with a shape of its own.
   *
   * Two things follow, and both are worth real money. It has no fixed volume —
   * it takes the shape of what's inside, so dimensional weight is computed from
   * the ITEM rather than from a carton several inches larger on every axis. And
   * it weighs an ounce or two instead of ten to thirty.
   *
   * Fit works differently too: a bag wraps, so what matters is length along the
   * bag and the item's WIDTH PLUS HEIGHT against the bag's flat width, not three
   * independent axes.
   */
  polyBag?: { flatL: number; flatW: number };
  /** Poly bags offer no protection; only sensible for soft or robust goods. */
  softGoodsOnly?: boolean;
}

/**
 * Padding allowance around the item, inches per axis (total, not per side).
 * Under-padding is how a "fits exactly" box becomes a damaged-item case.
 */
export const PADDING_IN = 1.5;
/** Bubble wrap / paper fill, ounces, scaled by how much air is in the box. */
export const FILL_OZ_PER_CUBIC_FOOT = 3;

/**
 * Poly mailer sizes, as sold: flat length × flat width, in inches, with the
 * empty weight of the bag.
 *
 * These matter most for exactly the items cartons handle worst — bulky, light,
 * and not fragile. A carton for an 18×10×11 item is 20×12×13 outside and gets
 * billed on 301 oz of volume; the same item in a bag is billed on the item's own
 * volume and saves both that and the carton's own weight.
 */
const POLY_SIZES: [number, number, number][] = [
  [9, 6, 0.4],
  [12, 9, 0.5],
  [13, 10, 0.6],
  [15.5, 12, 0.8],
  [19, 14.5, 1.1],
  [24, 19, 1.8],
  [24, 24, 2.2],
  [30, 26, 3],
  [36, 28, 3.8],
];

function polyMailer([flatL, flatW, oz]: [number, number, number]): Box {
  // A nominal capacity, used only to keep BOXES sorted by how much each
  // container swallows. The real fit test is the wrap rule in `fits`.
  const half = flatW / 2;
  return {
    id: `poly-${flatL}x${flatW}`,
    name: `Poly mailer ${flatL}×${flatW}`,
    inner: { l: flatL - 1, w: half, h: half },
    emptyOz: oz,
    polyBag: { flatL, flatW },
    softGoodsOnly: true,
    paddingIn: 0,
  };
}

/**
 * Standard corrugated carton sizes, inner dimensions in inches.
 *
 * This list is DENSE on purpose, and the density is the whole point. Carriers
 * bill on volume once a package passes a cubic foot, so the gap between one
 * stock size and the next is paid for in cash by whoever ships the item that
 * falls between them. With a sparse catalogue a 12×10×4 item — a perfectly
 * ordinary shape — had nothing between a 14×11×6 (too narrow) and a 16×12×8,
 * and the 16×12×8 crosses a cubic foot: billed at 169 oz of volume instead of
 * its actual 23 oz, $31.50 instead of $9.10. A sweep of realistic item shapes
 * found 560 of them landing in gaps like that.
 *
 * Every size below is a stock corrugated size sold by the usual suppliers, so
 * this is a denser list, not a fictional one.
 */
const CARTON_SIZES: [number, number, number][] = [
  // Small parcels.
  [6, 4, 4], [6, 6, 4], [6, 6, 6], [7, 5, 3], [7, 7, 5],
  [8, 6, 2], [8, 6, 4], [8, 8, 4], [8, 8, 6], [8, 8, 8],
  [9, 6, 3], [9, 6, 4], [9, 9, 3], [9, 9, 6],
  [10, 6, 3], [10, 6, 4], [10, 8, 2], [10, 8, 4], [10, 8, 6],
  [10, 10, 3], [10, 10, 4], [10, 10, 6], [10, 10, 8], [10, 10, 10],
  [11, 8, 2], [11, 8, 4], [11, 8, 6], [11, 11, 3], [11, 11, 5],
  // The 12–16 inch band, where most household goods land and where the old
  // catalogue was thinnest.
  [12, 6, 4], [12, 9, 2], [12, 9, 3], [12, 9, 4], [12, 9, 6],
  [12, 10, 3], [12, 10, 4], [12, 10, 6], [12, 12, 2], [12, 12, 3],
  [12, 12, 4], [12, 12, 5], [12, 12, 6], [12, 12, 8], [12, 12, 10], [12, 12, 12],
  [13, 9, 3], [13, 10, 4], [13, 10, 6], [13, 11, 3], [13, 13, 4], [13, 13, 6],
  [14, 10, 3], [14, 10, 4], [14, 10, 6], [14, 11, 4], [14, 11, 6],
  [14, 12, 3], [14, 12, 4], [14, 12, 6], [14, 14, 3], [14, 14, 4], [14, 14, 6],
  [15, 11, 3], [15, 11, 5], [15, 12, 4], [15, 12, 6], [15, 15, 3], [15, 15, 5],
  [16, 10, 4], [16, 12, 3], [16, 12, 4], [16, 12, 6], [16, 12, 8],
  [16, 14, 4], [16, 16, 3], [16, 16, 4], [16, 16, 5], [16, 16, 6],
  [17, 11, 3], [17, 14, 4], [17, 17, 5],
  [18, 12, 3], [18, 12, 4], [18, 12, 6], [18, 14, 4], [18, 14, 6], [18, 14, 10],
  [18, 18, 4], [18, 18, 6], [18, 18, 18],
  [20, 12, 3], [20, 12, 4], [20, 14, 4], [20, 14, 6], [20, 16, 4], [20, 16, 6],
  [20, 16, 12], [20, 20, 4], [20, 20, 6],
  [22, 16, 4], [22, 18, 6],
  [24, 12, 4], [24, 18, 4], [24, 18, 6], [24, 18, 12], [24, 20, 4], [24, 24, 6],
  // Tall and cube-ish. Without these the list jumps from a 12-inch-deep 20×16×12
  // straight to a 24×18×12, so anything around a foot tall — a lamp, a boxed
  // appliance, a vase — had two options and both were far bigger than it needed.
  [10, 10, 12], [12, 10, 10], [12, 12, 14], [14, 10, 10], [14, 12, 8],
  [14, 12, 10], [14, 12, 12], [14, 14, 8], [14, 14, 10], [14, 14, 12],
  [16, 12, 10], [16, 12, 12], [16, 14, 8], [16, 14, 10], [16, 14, 12],
  [16, 16, 8], [16, 16, 10], [16, 16, 12],
  [18, 12, 8], [18, 12, 10], [18, 12, 12], [18, 14, 8], [18, 14, 12],
  [18, 16, 10], [18, 16, 12], [18, 18, 10], [18, 18, 12],
  [20, 12, 6], [20, 12, 8], [20, 12, 10], [20, 12, 12], [20, 14, 8],
  [20, 14, 10], [20, 14, 12], [20, 16, 8], [20, 16, 10], [20, 20, 10], [20, 20, 12],
  [22, 14, 10], [22, 14, 12], [22, 16, 10], [22, 16, 12], [22, 18, 12],
  [24, 14, 10], [24, 14, 12], [24, 16, 10], [24, 16, 12], [24, 20, 12],
  // Long and narrow: tools, rods, bats, lamp stems, curtain poles.
  [18, 6, 4], [20, 6, 6], [22, 4, 4], [24, 4, 4], [24, 6, 6],
  [26, 6, 6], [30, 4, 4], [30, 6, 6], [36, 6, 6], [36, 8, 8], [40, 8, 8],
];

/**
 * Empty weight of a carton, ounces, from its surface area.
 *
 * Derived rather than typed per box, because a hundred hand-entered weights is a
 * hundred chances to be wrong. The coefficients come from fitting the previously
 * hand-picked values (an 8×6×4 at 3 oz, a 16×12×8 at 13, a 24×18×12 at 34) and
 * reproduce all of them within about 15%; bigger cartons use heavier board,
 * hence the step.
 */
function cartonOz(l: number, w: number, h: number): number {
  const area = 2 * (l * w + l * h + w * h);
  return Math.max(1.5, Math.round(area * (area > 1200 ? 0.018 : 0.015) * 10) / 10);
}

function carton([l, w, h]: [number, number, number]): Box {
  // A shape tag, because "Box 20×16×4" and "Box 20×16×12" are very different
  // things to reach for and the list is long.
  const sorted = [l, w, h].sort((a, b) => b - a);
  const shape =
    sorted[2] <= 4 && sorted[1] >= 10 ? " (flat)" : sorted[0] >= 3 * sorted[1] ? " (long)" : "";
  return {
    id: `box-${l}x${w}x${h}`,
    name: `Box ${l}×${w}×${h}${shape}`,
    inner: { l, w, h },
    emptyOz: cartonOz(l, w, h),
  };
}

// Sorted smallest-volume-first at module load rather than by hand, so
// selectBox's "first that fits" is genuinely "smallest that fits" and stays
// that way when someone adds a box to the middle of this list.
export const BOXES: Box[] = [
  ...POLY_SIZES.map(polyMailer),
  { id: "usps-fr-sm", name: "USPS Priority Flat Rate, small box", inner: { l: 8.6, w: 5.4, h: 1.6 }, emptyOz: 1.5, flatRate: true, carrierSupplied: true },
  { id: "usps-fr-md", name: "USPS Priority Flat Rate, medium box (top-load)", inner: { l: 11, w: 8.5, h: 5.5 }, emptyOz: 4, flatRate: true, carrierSupplied: true },
  { id: "usps-fr-lg", name: "USPS Priority Flat Rate, large box", inner: { l: 12, w: 12, h: 5.5 }, emptyOz: 6, flatRate: true, carrierSupplied: true },

  ...CARTON_SIZES.map(carton),

  // ── USPS Priority Flat Rate envelopes ──────────────────────────────────────
  //
  // One price to anywhere in the US up to 70 lb, which makes them the cheapest
  // way to move anything small and heavy — a lens, a pair of brake pads, a stack
  // of silver coins. Weight-based pricing loses badly on those and wins on
  // anything light, so the estimator prices both and lets the seller pick.
  //
  // The height figure is a realistic thickness the flap will still close over,
  // not a wall of a box. Padding is a quarter inch for the same reason.
  {
    id: "usps-fre",
    name: "USPS Flat Rate Envelope (12½×9½)",
    inner: { l: 12.5, w: 9.5, h: 0.75 },
    emptyOz: 0.8,
    flatRate: true,
    carrierSupplied: true,
    paddingIn: 0.5,
    maxThicknessIn: 0.75,
    ebayPackageType: "USPS_FLAT_RATE_ENVELOPE",
  },
  {
    id: "usps-fre-legal",
    name: "USPS Legal Flat Rate Envelope (15×9½)",
    inner: { l: 15, w: 9.5, h: 0.75 },
    emptyOz: 0.9,
    flatRate: true,
    carrierSupplied: true,
    paddingIn: 0.5,
    maxThicknessIn: 0.75,
    ebayPackageType: "USPS_FLAT_RATE_ENVELOPE",
  },
  {
    id: "usps-fre-padded",
    name: "USPS Padded Flat Rate Envelope (12½×9½)",
    inner: { l: 12.5, w: 9.5, h: 1 },
    emptyOz: 1.8,
    flatRate: true,
    carrierSupplied: true,
    paddingIn: 0.5,
    maxThicknessIn: 1,
    ebayPackageType: "USPS_FLAT_RATE_ENVELOPE",
  },

  // Two more flat-rate boxes with shapes nothing else covers: the side-loading
  // medium is broad and shallow where the top-loading one is deep, and the board
  // game box is the only flat-rate container over 15 inches long.
  {
    id: "usps-fr-md-side",
    name: "USPS Priority Flat Rate, medium box (side-load)",
    inner: { l: 13.6, w: 11.8, h: 3.4 },
    emptyOz: 5,
    flatRate: true,
    carrierSupplied: true,
  },
  {
    id: "usps-fr-boardgame",
    name: "USPS Priority Flat Rate, large board game box",
    inner: { l: 24.1, w: 11.8, h: 3.1 },
    emptyOz: 9,
    flatRate: true,
    carrierSupplied: true,
  },

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
  padding = box.paddingIn ?? PADDING_IN
): boolean {
  const i = [item.l, item.w, item.h].sort((a, b) => b - a);
  const b = [box.inner.l, box.inner.w, box.inner.h].sort((a, b) => b - a);

  // Poly bags wrap rather than enclose. The longest axis runs along the bag; the
  // other two go around it, so what has to fit the bag's flat width is their
  // SUM, not each of them separately. Treating a bag as a box with three
  // independent axes is why a 19×14.5 mailer looked unable to take a folded
  // jacket.
  if (box.polyBag) {
    const seal = 1;
    return i[0] + seal <= box.polyBag.flatL && i[1] + i[2] + seal <= box.polyBag.flatW;
  }

  // Envelopes: clearance across the face, a hard ceiling through the thickness.
  // Treating the thickness like another padded axis is what made every envelope
  // appear to fit nothing — a 0.6" item "needed" 0.85" of a 0.75" envelope.
  if (box.maxThicknessIn !== undefined) {
    if (i[2] > box.maxThicknessIn) return false;
    return i[0] + padding <= b[0] && i[1] + padding <= b[1];
  }

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
  return BOXES.find((box) => !box.flatRate && !box.polyBag && fits(item, box)) ?? null;
}

/** Every poly mailer the item fits, smallest first. */
export function polyMailersFor(item: { l: number; w: number; h: number }): Box[] {
  return BOXES.filter((b) => b.polyBag && fits(item, b));
}

/**
 * The smallest general-purpose boxes the item fits, cheapest-first by volume.
 *
 * More than one, because "the estimator already picked the best box" is not the
 * same as "you own that box". A seller with a stack of 20×16×12 needs to see it
 * priced next to the ideal one and decide, rather than being shown a single
 * carton and no way to say they have something else.
 */
export function selectBoxes(
  item: { l: number; w: number; h: number },
  limit: number
): Box[] {
  const out: Box[] = [];
  for (const box of BOXES) {
    if (box.flatRate || box.polyBag || !fits(item, box)) continue;
    out.push(box);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A carton cut down to this item, for when no stock size is close.
 *
 * A fixed catalogue can never cover every shape, and when it misses, the miss is
 * expensive and silent: a 19×7×5 item had nothing between the long boxes (too
 * narrow) and a 24×18×12, which is nearly four times the volume it needs and
 * bills at $78 of dimensional weight. No seller would ever actually do that —
 * they would cut a box down, which takes a minute and costs nothing.
 *
 * So that option is modelled explicitly and priced alongside the stock sizes,
 * rather than pretending the seller owns every carton ever made. Dimensions
 * follow the item, so this stays selected through a dimension edit instead of
 * being dropped as "no longer fits".
 */
export const CUT_TO_FIT_ID = "cut-to-fit";

export function cutToFitBox(item: { l: number; w: number; h: number }): Box {
  const snug = (n: number) => Math.ceil((n + PADDING_IN) * 2) / 2;
  const l = snug(item.l);
  const w = snug(item.w);
  const h = snug(item.h);
  return {
    id: CUT_TO_FIT_ID,
    name: `Cut-to-fit box ${l}×${w}×${h}`,
    inner: { l, w, h },
    emptyOz: cartonOz(l, w, h),
  };
}

/** Every flat-rate container, in the order a seller would scan a list. */
export function flatRateContainers(): Box[] {
  return BOXES.filter((b) => b.flatRate);
}

/** Look one up by id. */
export function boxById(id: string | undefined): Box | null {
  return BOXES.find((b) => b.id === id) ?? null;
}

/** Packing material weight for the air left around the item. */
export function fillOz(box: Box, item: { l: number; w: number; h: number }): number {
  const air = Math.max(0, volumeIn3(box.inner) - volumeIn3(item));
  return Math.round((air / 1728) * FILL_OZ_PER_CUBIC_FOOT * 10) / 10;
}
