// Turn "what is this item" into "what will it cost to ship, and in what box".
//
// Two inputs, in order of trust:
//   1. What the model read off the photos (a stated shipping weight on a box, a
//      measured dimension) — best, because it is evidence.
//   2. A per-category fallback profile — a guess, and flagged as one.
//
// The output feeds two different consumers with different tolerances:
//   • eBay gets weight + dimensions. With calculated shipping it quotes the
//     buyer from those using real current rates, so accuracy here is what stops
//     you eating the difference.
//   • The seller gets a dollar figure for margin math, from a static table
//     (see rates.ts) that is explicitly a baseline, not a quote.

import {
  CUT_TO_FIT_ID,
  boxById,
  cutToFitBox,
  fillOz,
  fits,
  polyMailersFor,
  selectBoxes,
  volumeIn3,
  type Box,
} from "./boxes";
import {
  SERVICES,
  billableOz,
  dimensionalOz,
  flatRateFor,
  rateTable,
  weightBand,
  weightBasedRate,
  type WeightBand,
  type RateTable,
  type ServiceId,
} from "./rates";

export interface Dimensions {
  l: number;
  w: number;
  h: number;
}

export interface ShippingOption {
  /** Stable identity for the service + container pair, used to select one. */
  id: string;
  serviceId: ServiceId;
  serviceName: string;
  boxId: string;
  boxName: string;
  usd: number;
  /** True when volume, not the scale, set the price. */
  dimensionalPricing: boolean;
  /** True for USPS-supplied flat-rate packaging. */
  flatRate: boolean;
  /** True for a poly mailer, which is priced on the item's own volume. */
  polyBag: boolean;
  /**
   * The weight band this price sits in.
   *
   * Postage is banded, not continuous — everything from 16 to 32 oz costs the
   * same — which makes the estimator look broken: you change the size, the
   * packed weight visibly moves, and the price doesn't. It didn't fail to
   * update; there was nothing to update to. Null for flat-rate packaging, where
   * weight doesn't set the price at all.
   */
  band: WeightBand | null;
}

/**
 * Marker for the dimensional-weight warning.
 *
 * The panel renders this one as a callout beside the weight field rather than in
 * the warning list at the bottom, because "why did editing the weight do
 * nothing" is a question you ask while looking at the weight field, and an
 * answer 800 pixels below it is an answer nobody reads. Exported so the panel
 * can pull it out of the list by identity instead of by guessing at its wording.
 */
export const DIMENSIONAL_WARNING_PREFIX = "Priced on dimensional weight";

/** Identity of a service + container pair. */
export function optionId(serviceId: ServiceId, boxId: string): string {
  return `${serviceId}:${boxId}`;
}

export interface ShippingEstimate {
  /** The item alone, ounces. */
  itemOz: number;
  /** Item + box + packing material — what the scale will read. */
  packedOz: number;
  /** What the carrier bills on (max of packed and dimensional). */
  billableOz: number;
  box: { id: string; name: string; outer: Dimensions } | null;
  itemDims: Dimensions;
  options: ShippingOption[];
  /** Cheapest workable option, or null when nothing fits. */
  recommended: ShippingOption | null;
  /**
   * The option actually in force: the seller's pick when they made one, else
   * the cheapest. This — not `recommended` — is what the headline shows and what
   * the package sent to eBay is derived from.
   *
   * Kept separate from `recommended` so the panel can still say "the cheapest is
   * $9.90" next to a deliberate choice to pay more for Priority.
   */
  chosen: ShippingOption | null;
  /** True when the seller picked this rather than taking the cheapest. */
  manualSelection: boolean;
  /**
   * The physical package for `chosen` — which container, how big, what the scale
   * will read with the item in it.
   *
   * Distinct from `box`/`packedOz` above, which always describe the general
   * carton the weight-based options are priced from. Pick a flat-rate envelope
   * and those two stop describing what you're actually mailing; this doesn't.
   */
  chosenPackage: { boxId: string; name: string; outer: Dimensions; packedOz: number } | null;
  /** Where the weight came from — evidence or a category guess. */
  basis: "photos" | "category-default";
  /**
   * Which figures were actually supplied (by the model or by the seller), as
   * opposed to filled in from a category profile. Per axis, because a seller
   * who measures the length and nothing else has still told us something real.
   *
   * This is separate from `basis` on purpose. `basis` answers "should the UI
   * warn about this", and demands everything. Publishing asks a different
   * question — "did a human or the photos tell us anything at all" — and an
   * edited weight with no dimensions must count as yes. Conflating the two is
   * what caused a hand-entered weight to be silently replaced by a class
   * default at publish time.
   */
  provided: { weight: boolean; l: boolean; w: boolean; h: boolean };
  /**
   * The carrier's volume-based weight for the chosen box, in ounces, or 0 when
   * the box is under the cubic-foot threshold.
   *
   * Surfaced because it explains an edit that appears to do nothing: while this
   * exceeds the packed weight, the price is set by the box, and changing the
   * item's weight moves no number the seller can see.
   */
  dimensionalOz: number;
  warnings: string[];
  rateTableEffective: string;
  rateSource: string;
}

/**
 * Per-category fallbacks, used only when the model couldn't estimate. Ounces and
 * inches, describing the ITEM, not the packed box.
 */
const CATEGORY_ITEM_DEFAULTS: Record<string, { oz: number; dims: Dimensions }> = {
  womens_coat: { oz: 32, dims: { l: 14, w: 10, h: 3 } },
  mens_coat: { oz: 38, dims: { l: 15, w: 11, h: 3.5 } },
  womens_shoes: { oz: 30, dims: { l: 12, w: 8, h: 4.5 } },
  mens_shoes: { oz: 40, dims: { l: 13, w: 9, h: 5 } },
  handbag: { oz: 20, dims: { l: 13, w: 10, h: 4 } },
  book: { oz: 14, dims: { l: 9, w: 6, h: 1.2 } },
  media: { oz: 6, dims: { l: 7.5, w: 5.5, h: 0.6 } },
  vinyl_record: { oz: 9, dims: { l: 12.5, w: 12.5, h: 0.3 } },
  electronics: { oz: 32, dims: { l: 10, w: 7, h: 4 } },
  small_appliance: { oz: 80, dims: { l: 13, w: 10, h: 10 } },
  kitchenware: { oz: 40, dims: { l: 11, w: 9, h: 6 } },
  glassware: { oz: 24, dims: { l: 8, w: 8, h: 8 } },
  pottery_ceramics: { oz: 32, dims: { l: 9, w: 9, h: 9 } },
  art: { oz: 40, dims: { l: 18, w: 14, h: 2 } },
  tool: { oz: 56, dims: { l: 14, w: 7, h: 5 } },
  sporting_goods: { oz: 48, dims: { l: 16, w: 10, h: 6 } },
  musical_instrument: { oz: 96, dims: { l: 20, w: 12, h: 8 } },
  toy: { oz: 20, dims: { l: 10, w: 8, h: 5 } },
  collectible: { oz: 18, dims: { l: 8, w: 6, h: 5 } },
};

const DEFAULT_ITEM = { oz: 16, dims: { l: 10, w: 8, h: 3 } };

/** Cardboard adds roughly this much to each outer dimension. */
const WALL_IN = 0.5;

/**
 * How many stock cartons to price alongside the cut-to-fit one.
 *
 * More than one because the estimator picking the ideal box is not the same as
 * the seller owning it; capped because a hundred near-identical rows is not a
 * choice, it's a wall.
 */
const STOCK_BOX_CHOICES = 3;

/**
 * Item classes where a poly mailer is sound packaging rather than a gamble.
 * Soft, flat, or robust enough that nothing inside can be crushed.
 */
const SOFT_GOODS_CATEGORIES = new Set([
  "womens_coat",
  "mens_coat",
  "womens_top",
  "mens_top",
  "womens_dress",
  "womens_pants",
  "mens_pants",
  "womens_skirt",
  "activewear",
  "sleepwear",
  "swimwear",
  "outerwear",
  "sweater",
  "linens",
  "plush",
  "textile",
  "fabric",
  "accessory",
  "scarf",
  "hat",
  "bag",
]);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The outside of a packed container.
 *
 * A carton has a size of its own and the item rattles around inside it. A poly
 * bag has no size until you fill it — it takes the item's shape plus the
 * thickness of the film — so its dimensions, and therefore its dimensional
 * weight, come from the item. That difference is the whole reason a bag is
 * cheaper for something bulky and light.
 */
function outerOf(box: Box, item?: Dimensions): Dimensions {
  if (box.polyBag && item) {
    const slack = 0.5;
    return {
      l: round1(item.l + slack),
      w: round1(item.w + slack),
      h: round1(item.h + slack),
    };
  }
  return {
    l: round1(box.inner.l + WALL_IN),
    w: round1(box.inner.w + WALL_IN),
    h: round1(box.inner.h + WALL_IN),
  };
}

/**
 * USPS domestic parcel limits: 108" longest side, and 130" for length plus girth
 * (the distance around the other two). A cut-to-fit box has no size of its own,
 * so without this it would happily "fit" a wardrobe.
 */
function withinCarrierLimits(box: Box): boolean {
  const [long, mid, short] = [box.inner.l, box.inner.w, box.inner.h].sort((a, b) => b - a);
  return long <= 108 && long + 2 * (mid + short) <= 130;
}

const positive = (n: unknown): number | null => {
  const v = typeof n === "string" ? parseFloat(n) : (n as number);
  return Number.isFinite(v) && v > 0 ? v : null;
};

export interface EstimateInput {
  /** Model's read of the item's own weight, ounces. */
  itemOz?: number | string;
  /** Model's read of the item's own size, inches. */
  itemDims?: Partial<Dimensions>;
  /** Fallback when the above are missing. */
  category?: string;
  rates?: RateTable;
  /**
   * The seller's chosen service + container (see `optionId`). Ignored when the
   * item no longer fits it — a selection made before the dimensions were
   * corrected must not silently publish a package the item can't go in.
   */
  selectedOptionId?: string;
}

/**
 * Estimate packaging and cost for one item.
 *
 * Always returns an estimate — a listing with no shipping data cannot publish
 * under calculated shipping (eBay error 25020), so falling back to a flagged
 * category guess beats returning nothing.
 */
export function estimateShipping(input: EstimateInput): ShippingEstimate {
  const table = input.rates ?? rateTable();
  const warnings: string[] = [];
  const softGoods = SOFT_GOODS_CATEGORIES.has(String(input.category ?? ""));
  const recommendable = (o: ShippingOption) => !o.polyBag || softGoods;

  const fallback = CATEGORY_ITEM_DEFAULTS[String(input.category ?? "")] ?? DEFAULT_ITEM;

  const statedOz = positive(input.itemOz);
  const l = positive(input.itemDims?.l);
  const w = positive(input.itemDims?.w);
  const h = positive(input.itemDims?.h);
  const haveDims = l !== null && w !== null && h !== null;
  const someDims = l !== null || w !== null || h !== null;

  const itemOz = statedOz ?? fallback.oz;
  // Fall back PER AXIS. All-or-nothing meant typing one real dimension was
  // thrown away entirely along with the other two, so a partly-measured item
  // was treated as if it had never been measured.
  const itemDims: Dimensions = {
    l: l ?? fallback.dims.l,
    w: w ?? fallback.dims.w,
    h: h ?? fallback.dims.h,
  };

  const provided = { weight: statedOz !== null, l: l !== null, w: w !== null, h: h !== null };
  const basis: ShippingEstimate["basis"] =
    statedOz !== null && haveDims ? "photos" : "category-default";
  if (basis === "category-default") {
    const missing = [
      statedOz === null ? "weight" : null,
      l === null ? "length" : null,
      w === null ? "width" : null,
      h === null ? "height" : null,
    ].filter(Boolean);
    warnings.push(
      !provided.weight && !someDims
        ? "Weight and size are a category guess — the photos didn't show either. Weigh the item before posting if shipping cost matters."
        : `Still guessing ${missing.join(", ")} from the category. Fill in the rest for an accurate quote.`
    );
  }

  // Two general cartons are considered, not one: the smallest stock size that
  // fits, and a box cut down to the item. Whichever is cheaper wins, and both
  // are offered. Relying on stock sizes alone is what left a 19×7×5 item paying
  // $78 to ship in a 24×18×12 — no seller would do that rather than spend a
  // minute with a knife.
  const stockBoxes = selectBoxes(itemDims, STOCK_BOX_CHOICES);
  const cut = cutToFitBox(itemDims);
  // The smallest poly mailer that fits. Only one: bigger bags cost the same to
  // ship (the item sets the volume either way), so listing four of them is four
  // identical prices and no decision.
  const poly = polyMailersFor(itemDims).slice(0, 1);
  const cartons: Box[] = [...stockBoxes, ...poly];
  // Only when USPS would actually take it: cutting a box to fit does not make a
  // 40-inch item mailable, and silently pricing one as a parcel would be worse
  // than saying so.
  if (withinCarrierLimits(cut)) cartons.push(cut);

  // Per-carton physics, computed once and reused for both the priced options and
  // the summary figures — so the box named in the summary is always the box the
  // recommended option is actually priced from.
  const packing = cartons.map((carton) => {
    const cOuter = outerOf(carton, itemDims);
    // No void fill in a bag — there is no void.
    const fill = carton.polyBag ? 0 : fillOz(carton, itemDims);
    const cPacked = Math.round((itemOz + carton.emptyOz + fill) * 10) / 10;
    const cDimOz = dimensionalOz(cOuter);
    return {
      carton,
      outer: cOuter,
      packedOz: cPacked,
      billable: billableOz(cPacked, cOuter),
      dimOz: cDimOz,
      dimensional: cDimOz > Math.ceil(cPacked),
    };
  });

  if (packing.length === 0) {
    warnings.push(
      `This item (${itemDims.l}×${itemDims.w}×${itemDims.h} in) is larger than the biggest box in the catalogue. It needs freight or a custom carton — price it manually.`
    );
    return {
      itemOz,
      packedOz: itemOz,
      billableOz: Math.ceil(itemOz),
      box: null,
      itemDims,
      options: [],
      recommended: null,
      chosen: null,
      manualSelection: false,
      chosenPackage: null,
      basis,
      provided,
      dimensionalOz: 0,
      warnings,
      rateTableEffective: table.effective,
      rateSource: table.source,
    };
  }

  // Every carton in play gets priced on both weight-based services, so a
  // cut-to-fit box that dodges dimensional weight can beat a stock box that
  // doesn't — which is the entire reason it exists.
  //
  // Whether to OFFER the cut-to-fit box is then decided on price, not on a
  // volume ratio. A ratio test looks reasonable and is subtly wrong: a
  // 13×10×6 item needs a box 81% the volume of the stock 16×12×8, which a
  // "must be 20% smaller" rule rejects — while the stock box crosses a cubic
  // foot and the cut one doesn't, a $22 difference. If cutting a box saves
  // nothing it is dropped below; if it saves anything, it is worth a minute
  // with a knife and the seller gets to see it.
  const options: ShippingOption[] = [];
  for (const pk of packing) {
    for (const serviceId of ["ground_advantage", "priority"] as const) {
      if (pk.billable > SERVICES[serviceId].maxOz) continue;
      const usd = weightBasedRate(serviceId, pk.billable, table);
      if (usd === null) continue;
      options.push({
        id: optionId(serviceId, pk.carton.id),
        serviceId,
        serviceName: SERVICES[serviceId].name,
        boxId: pk.carton.id,
        boxName: pk.carton.name,
        usd,
        dimensionalPricing: pk.dimensional,
        flatRate: false,
        polyBag: Boolean(pk.carton.polyBag),
        band: weightBand(serviceId, pk.billable, table),
      });
    }
  }

  // Every flat-rate container the item fits, priced — envelopes included. Flat
  // rate ignores weight entirely, so for anything small and heavy (a lens, brake
  // pads, a stack of coins) an envelope beats weight-based pricing outright,
  // while for anything light it loses. Neither is knowable in advance, which is
  // why all of them get priced and the seller can take whichever they want.
  //
  // `fits` uses each container's own padding allowance: a quarter inch for an
  // envelope, an inch and a half for a carton.
  for (const frId of SERVICES.priority_flat_rate.flatRateBoxIds ?? []) {
    const frBox = boxById(frId);
    if (!frBox || !fits(itemDims, frBox)) continue;
    const usd = flatRateFor(frId, table);
    if (usd === null) continue;
    options.push({
      id: optionId("priority_flat_rate", frId),
      serviceId: "priority_flat_rate",
      serviceName: frBox.name.startsWith("USPS")
        ? frBox.name
        : `${SERVICES.priority_flat_rate.name} (${frBox.name})`,
      boxId: frId,
      boxName: frBox.name,
      usd,
      dimensionalPricing: false,
      flatRate: true,
      polyBag: false,
      // Flat rate means weight doesn't set the price, so there is no band.
      band: null,
    });
  }

  // Drop a cut-to-fit option that costs the same as (or more than) the stock box
  // on the same service — no one should cut cardboard for zero saving.
  //
  // Compared against stock CARTONS only. Comparing against a poly bag as well
  // would drop the cut-to-fit box whenever a bag matched its price — losing the
  // only right answer for anything fragile, since a bag and a box at the same
  // price are not the same offer.
  const stockPrice = new Map<string, number>();
  for (const o of options) {
    if (o.boxId !== CUT_TO_FIT_ID && !o.polyBag) {
      const prev = stockPrice.get(o.serviceId);
      if (prev === undefined || o.usd < prev) stockPrice.set(o.serviceId, o.usd);
    }
  }
  const priced = options.filter(
    (o) => o.boxId !== CUT_TO_FIT_ID || o.usd < (stockPrice.get(o.serviceId) ?? Infinity)
  );
  options.length = 0;
  options.push(...priced);

  // The carton the summary describes is the one behind the cheapest surviving
  // weight-based option — never a box that was priced and then dropped.
  const cheapestCarton = options
    .filter((o) => !o.flatRate && recommendable(o))
    .sort((a, b) => a.usd - b.usd)[0];
  const primary =
    packing.find((pk) => pk.carton.id === cheapestCarton?.boxId) ??
    packing.slice().sort((a, b) => volumeIn3(a.carton.inner) - volumeIn3(b.carton.inner))[0];
  const box = primary.carton;
  const packedOz = primary.packedOz;
  const billable = primary.billable;
  const dimOz = primary.dimOz;
  const dimensional = primary.dimensional;
  if (dimensional) {
    // Spell out the consequence, not just the fact. While volume is setting the
    // price, editing the weight moves no visible number, which reads as a
    // broken input rather than as arithmetic.
    warnings.push(
      `Priced on dimensional weight (${billable} oz of box volume) rather than actual (${Math.ceil(packedOz)} oz) — the box is over 1 cubic foot. Changing the item's weight won't change the cost until the packed weight passes ${billable} oz; a smaller box will.`
    );
  }

  options.sort((a, b) => a.usd - b.usd);

  // Resolve the seller's pick. A selection that no longer fits is dropped with a
  // warning rather than honoured: dimensions get corrected after a container is
  // chosen, and publishing a package the item demonstrably cannot go in is the
  // one outcome worse than reverting to the cheapest that works.
  // A bag is usually the cheapest thing that "fits" a vase, and recommending one
  // would be advice that breaks the vase. Poly stays selectable for everything —
  // the seller knows their item — but is only recommended for goods that can
  // take it.
  const recommended = options.find(recommendable) ?? options[0] ?? null;

  // When a bag is cheaper but isn't being recommended, say why. Otherwise the
  // panel silently recommends $55 with $31.50 visible one row below, which
  // reads as a bug rather than as a judgement about fragility.
  const cheaperBag = options.find((o) => o.polyBag);
  if (!softGoods && cheaperBag && recommended && cheaperBag.usd < recommended.usd) {
    warnings.push(
      `A poly mailer would cost ${(recommended.usd - cheaperBag.usd).toFixed(2)} less, but it isn't recommended for this kind of item — a bag offers no protection. Pick it below if this one can take it.`
    );
  }
  const picked = input.selectedOptionId
    ? options.find((o) => o.id === input.selectedOptionId) ?? null
    : null;
  if (input.selectedOptionId && !picked) {
    warnings.push(
      "The packaging you picked no longer fits this item at these dimensions, so the cheapest option that does is being used. Pick again if you want something else."
    );
  }

  const chosen = picked ?? recommended;

  // Reuse the packing entry computed above rather than recomputing it here.
  // Recomputing was a real bug: this copy added void fill to a poly bag and took
  // the bag's nominal size instead of the item's, so a jacket in a mailer
  // published as a carton — the exact thing choosing a bag is meant to avoid.
  const chosenPacking = chosen ? packing.find((pk) => pk.carton.id === chosen.boxId) : null;
  // Flat-rate containers are not in `packing` (they are priced by box, not by
  // weight), so they still need their own figures.
  const flatRateBox = chosen && !chosenPacking ? boxById(chosen.boxId) : null;
  const chosenPackage = chosenPacking
    ? {
        boxId: chosenPacking.carton.id,
        name: chosenPacking.carton.name,
        outer: chosenPacking.outer,
        packedOz: chosenPacking.packedOz,
      }
    : flatRateBox
      ? {
          boxId: flatRateBox.id,
          name: flatRateBox.name,
          outer: outerOf(flatRateBox, itemDims),
          packedOz:
            Math.round((itemOz + flatRateBox.emptyOz + fillOz(flatRateBox, itemDims)) * 10) / 10,
        }
      : null;

  return {
    itemOz,
    packedOz,
    billableOz: billable,
    box: { id: box.id, name: box.name, outer: primary.outer },
    itemDims,
    options,
    recommended,
    chosen,
    manualSelection: picked !== null,
    chosenPackage,
    basis,
    provided,
    dimensionalOz: dimensional ? dimOz : 0,
    warnings,
    rateTableEffective: table.effective,
    rateSource: table.source,
  };
}

/**
 * The package payload eBay needs. Derived from the CHOSEN option's container so
 * what publishes matches what the seller is actually going to put in the mail —
 * the alternative is a listing quoting buyers for one box while the label goes
 * on another.
 */
export function ebayPackageFromEstimate(
  estimate: ShippingEstimate
): { weightOz: number; l: number; w: number; h: number; packageType?: string } | null {
  const pkg = estimate.chosenPackage;
  if (!pkg) {
    if (!estimate.box) return null;
    return {
      weightOz: Math.max(1, Math.ceil(estimate.packedOz)),
      l: estimate.box.outer.l,
      w: estimate.box.outer.w,
      h: estimate.box.outer.h,
    };
  }
  const box = boxById(pkg.boxId);
  return {
    weightOz: Math.max(1, Math.ceil(pkg.packedOz)),
    l: pkg.outer.l,
    w: pkg.outer.w,
    h: pkg.outer.h,
    ...(box?.ebayPackageType ? { packageType: box.ebayPackageType } : {}),
  };
}
