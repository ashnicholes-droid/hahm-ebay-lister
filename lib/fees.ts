// What you actually keep from a sale.
//
// One module because two screens ask the same question and must not answer it
// differently: the shipping panel while writing a listing, and the seller view
// while repricing a live one.

/**
 * eBay's final value fee, roughly. ~13.25% plus $0.40 per order on most
 * categories — close enough to tell a marginal item from a good one, which is
 * the decision this supports. Some categories differ; a seller pricing to the
 * last cent should check their own rate.
 */
export const FEE_PERCENT = 0.1325;
export const FEE_FIXED = 0.4;

/**
 * The fee is charged on the ORDER TOTAL, not the item price. That is the part
 * that catches people out: when the buyer pays shipping, you are charged a fee
 * on their shipping too.
 */
export function finalValueFee(orderTotal: number): number {
  return orderTotal * FEE_PERCENT + FEE_FIXED;
}

/** How the buyer's postage is arranged on a live listing. */
export type ShippingArrangement = "free" | "flat" | "calculated" | "unknown";

export interface NetEstimate {
  /** What lands in your account, as far as this can be known. */
  net: number;
  /**
   * True when postage is NOT included in `net` because its amount isn't
   * knowable from the listing alone. Free shipping means you pay it, and how
   * much depends on the box — so the figure is an upper bound, not a promise.
   */
  postageExcluded: boolean;
  /** Plain-language summary, ready to render. */
  label: string;
}

/**
 * Net proceeds at a given asking price, given how shipping is arranged.
 *
 * The three arrangements genuinely differ, and the difference is the whole
 * point of showing this next to a price field:
 *
 *   • flat, buyer pays $S — you are charged a fee on price + S, and keep the S.
 *     Net is exact.
 *   • free — you keep no shipping and pay the postage out of the sale price.
 *     The fee is smaller (no shipping in the total), but the postage is real
 *     and unknown here, so it is excluded and flagged rather than guessed.
 *   • calculated — the buyer pays a figure that varies by their address, so the
 *     fee on it varies too. Net is quoted before that, and flagged.
 */
export function netAtPrice(
  price: number,
  arrangement: ShippingArrangement,
  buyerPaysShipping = 0
): NetEstimate {
  if (!Number.isFinite(price) || price <= 0) {
    return { net: 0, postageExcluded: false, label: "Set a price to see your net." };
  }

  if (arrangement === "flat" && buyerPaysShipping > 0) {
    const net = price - finalValueFee(price + buyerPaysShipping);
    return {
      net,
      postageExcluded: true,
      label: `Buyer pays $${buyerPaysShipping.toFixed(2)} postage. You net $${net.toFixed(2)} before your own postage cost.`,
    };
  }

  if (arrangement === "free") {
    const net = price - finalValueFee(price);
    return {
      net,
      postageExcluded: true,
      label: `You pay the postage. $${net.toFixed(2)} after fees, minus whatever the label costs.`,
    };
  }

  if (arrangement === "calculated") {
    const net = price - finalValueFee(price);
    return {
      net,
      postageExcluded: false,
      label: `Buyer pays calculated postage. You net about $${net.toFixed(2)}; eBay also takes its cut of their shipping.`,
    };
  }

  const net = price - finalValueFee(price);
  return {
    net,
    postageExcluded: false,
    label: `About $${net.toFixed(2)} after eBay fees. Shipping arrangement unknown.`,
  };
}
