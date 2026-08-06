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

import { BOXES, PADDING_IN, fillOz, selectBox, type Box } from "./boxes";
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
  serviceId: ServiceId;
  serviceName: string;
  boxId: string;
  boxName: string;
  usd: number;
  /** True when volume, not the scale, set the price. */
  dimensionalPricing: boolean;
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
  /** Where the weight came from — evidence or a category guess. */
  basis: "photos" | "category-default";
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

  const itemOz = statedOz ?? fallback.oz;
  const itemDims: Dimensions = haveDims
    ? { l: l!, w: w!, h: h! }
    : { ...fallback.dims };

  const basis: ShippingEstimate["basis"] =
    statedOz !== null && haveDims ? "photos" : "category-default";
  if (basis === "category-default") {
    warnings.push(
      statedOz === null && !haveDims
        ? "Weight and size are a category guess — the photos didn't show either. Weigh the item before posting if shipping cost matters."
        : "Part of this estimate is a category guess. Fill in the missing figure for an accurate quote."
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
      basis,
      warnings,
      rateTableEffective: table.effective,
      rateSource: table.source,
    };
  }

  const packedOz = Math.round((itemOz + box.emptyOz + fillOz(box, itemDims)) * 10) / 10;
  const outer = outerOf(box);
  const billable = billableOz(packedOz, outer);
  const dimensional = dimensionalOz(outer) > Math.ceil(packedOz);
  if (dimensional) {
    warnings.push(
      `Priced on dimensional weight (${billable} oz) rather than actual (${Math.ceil(packedOz)} oz) — the box is over 1 cubic foot. A smaller box would cost less.`
    );
  }

  const options: ShippingOption[] = [];
  for (const serviceId of ["ground_advantage", "priority"] as const) {
    if (billable > SERVICES[serviceId].maxOz) continue;
    const usd = weightBasedRate(serviceId, billable, table);
    if (usd === null) continue;
    options.push({
      serviceId,
      serviceName: SERVICES[serviceId].name,
      boxId: box.id,
      boxName: box.name,
      usd,
      dimensionalPricing: dimensional,
    });
  }

  // Flat rate is worth pricing whenever the item fits a flat-rate box, even if
  // that isn't the smallest box overall — for anything heavy it usually wins.
  for (const frId of SERVICES.priority_flat_rate.flatRateBoxIds ?? []) {
    const frBox = BOXES.find((b) => b.id === frId);
    if (!frBox) continue;
    const i = [itemDims.l, itemDims.w, itemDims.h].sort((a, b) => b - a);
    const bx = [frBox.inner.l, frBox.inner.w, frBox.inner.h].sort((a, b) => b - a);
    if (!i.every((v, idx) => v + PADDING_IN <= bx[idx])) continue;
    const usd = flatRateFor(frId, table);
    if (usd === null) continue;
    options.push({
      serviceId: "priority_flat_rate",
      serviceName: `${SERVICES.priority_flat_rate.name} (${frBox.name.replace("USPS Priority Flat Rate, ", "")})`,
      boxId: frId,
      boxName: frBox.name,
      usd,
      dimensionalPricing: false,
    });
  }

  options.sort((a, b) => a.usd - b.usd);
  return {
    itemOz,
    packedOz,
    billableOz: billable,
    box: { id: box.id, name: box.name, outer },
    itemDims,
    options,
    recommended: options[0] ?? null,
    basis,
    warnings,
    rateTableEffective: table.effective,
    rateSource: table.source,
  };
}

/**
 * The package payload eBay needs. Derived from the recommended option's box so
 * what publishes matches what was estimated — the alternative is a listing
 * quoting buyers for one box while the estimate assumed another.
 */
export function ebayPackageFromEstimate(
  estimate: ShippingEstimate
): { weightOz: number; l: number; w: number; h: number } | null {
  const chosen = estimate.recommended;
  const box = chosen ? BOXES.find((b) => b.id === chosen.boxId) : null;
  if (!box) {
    if (!estimate.box) return null;
    return {
      weightOz: Math.max(1, Math.ceil(estimate.packedOz)),
      l: estimate.box.outer.l,
      w: estimate.box.outer.w,
      h: estimate.box.outer.h,
    };
  }
  const outer = outerOf(box);
  const packed = Math.max(1, Math.ceil(estimate.itemOz + box.emptyOz + fillOz(box, estimate.itemDims)));
  return { weightOz: packed, l: outer.l, w: outer.w, h: outer.h };
}
