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

import { boxById, fillOz, fits, selectBox, type Box } from "./boxes";
import {
  SERVICES,
  billableOz,
  dimensionalOz,
  flatRateFor,
  rateTable,
  weightBasedRate,
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
}

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

function outerOf(box: Box): Dimensions {
  return {
    l: Math.round((box.inner.l + WALL_IN) * 10) / 10,
    w: Math.round((box.inner.w + WALL_IN) * 10) / 10,
    h: Math.round((box.inner.h + WALL_IN) * 10) / 10,
  };
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

  const box = selectBox(itemDims);
  if (!box) {
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

  const packedOz = Math.round((itemOz + box.emptyOz + fillOz(box, itemDims)) * 10) / 10;
  const outer = outerOf(box);
  const billable = billableOz(packedOz, outer);
  const dimOz = dimensionalOz(outer);
  const dimensional = dimOz > Math.ceil(packedOz);
  if (dimensional) {
    // Spell out the consequence, not just the fact. While volume is setting the
    // price, editing the weight moves no visible number, which reads as a
    // broken input rather than as arithmetic.
    warnings.push(
      `Priced on dimensional weight (${billable} oz of box volume) rather than actual (${Math.ceil(packedOz)} oz) — the box is over 1 cubic foot. Changing the item's weight won't change the cost until the packed weight passes ${billable} oz; a smaller box will.`
    );
  }

  const options: ShippingOption[] = [];
  for (const serviceId of ["ground_advantage", "priority"] as const) {
    if (billable > SERVICES[serviceId].maxOz) continue;
    const usd = weightBasedRate(serviceId, billable, table);
    if (usd === null) continue;
    options.push({
      id: optionId(serviceId, box.id),
      serviceId,
      serviceName: SERVICES[serviceId].name,
      boxId: box.id,
      boxName: box.name,
      usd,
      dimensionalPricing: dimensional,
      flatRate: false,
    });
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
    });
  }

  options.sort((a, b) => a.usd - b.usd);

  // Resolve the seller's pick. A selection that no longer fits is dropped with a
  // warning rather than honoured: dimensions get corrected after a container is
  // chosen, and publishing a package the item demonstrably cannot go in is the
  // one outcome worse than reverting to the cheapest that works.
  const recommended = options[0] ?? null;
  const picked = input.selectedOptionId
    ? options.find((o) => o.id === input.selectedOptionId) ?? null
    : null;
  if (input.selectedOptionId && !picked) {
    warnings.push(
      "The packaging you picked no longer fits this item at these dimensions, so the cheapest option that does is being used. Pick again if you want something else."
    );
  }

  const chosen = picked ?? recommended;
  const chosenBox = chosen ? boxById(chosen.boxId) : null;
  const chosenPackage = chosenBox
    ? {
        boxId: chosenBox.id,
        name: chosenBox.name,
        outer: outerOf(chosenBox),
        packedOz:
          Math.round((itemOz + chosenBox.emptyOz + fillOz(chosenBox, itemDims)) * 10) / 10,
      }
    : null;

  return {
    itemOz,
    packedOz,
    billableOz: billable,
    box: { id: box.id, name: box.name, outer },
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
