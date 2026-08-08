"use client";

import { useMemo } from "react";
import { estimateShipping } from "@/lib/shipping/estimate";
import type { ListingResult } from "@/lib/types";

interface ShippingPanelProps {
  listing: ListingResult;
  groupId: string;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

function num(v: unknown): string {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

export function ShippingPanel({ listing, groupId, onEdit }: ShippingPanelProps) {
  const estimate = useMemo(
    () =>
      estimateShipping({
        itemOz: listing.shipping_weight_oz,
        itemDims: {
          l: Number(listing.shipping_length_in) || undefined,
          w: Number(listing.shipping_width_in) || undefined,
          h: Number(listing.shipping_height_in) || undefined,
        },
        category: listing.category,
      }),
    [
      listing.shipping_weight_oz,
      listing.shipping_length_in,
      listing.shipping_width_in,
      listing.shipping_height_in,
      listing.category,
    ]
  );

  const price = Number(listing.suggested_price) || 0;
  const shipCost = estimate.recommended?.usd ?? 0;
  const free = listing.shipping_free === true;

  // eBay's final value fee is roughly 13.25% + $0.40 on most categories — close
  // enough to tell a marginal item from a good one, which is the decision this
  // supports. Both modes are computed, because the interesting question isn't
  // "what do I net" but "which of these two nets me more".
  //
  // The asymmetry is easy to miss: eBay charges its fee on the ORDER TOTAL, so
  // when the buyer pays shipping you are also charged a fee on that shipping.
  // Free shipping costs you the postage but saves the fee on it.
  const fee = (total: number) => total * 0.1325 + 0.4;
  const canCompare = price > 0 && shipCost > 0;
  const netFree = canCompare ? price - shipCost - fee(price) : null;
  const netPaid = canCompare ? price - fee(price + shipCost) : null;
  const netActive = free ? netFree : netPaid;

  // Every field shows the figure the estimate is ACTUALLY using, as a
  // placeholder, whenever the seller (or the photos) didn't supply one. Leaving
  // them blank was the real defect behind "my edits don't do anything": the
  // panel was quietly costing a 11×9×6 category guess while showing three empty
  // boxes, so typing one real dimension composed with two invisible ones and
  // usually moved no number at all.
  const field = (
    key: keyof ListingResult,
    label: string,
    unit: string,
    assumed: number,
    supplied: boolean
  ) => (
    <label className={`ship-field${supplied ? "" : " assumed"}`} key={key}>
      <span>
        {label}
        {!supplied && <em className="ship-guess">assumed</em>}
      </span>
      <span className="ship-input">
        <input
          type="number"
          min="0"
          step="0.1"
          inputMode="decimal"
          value={num(listing[key])}
          placeholder={String(Math.round(assumed * 10) / 10)}
          onChange={(e) =>
            onEdit(groupId, { [key]: e.target.value === "" ? "" : Number(e.target.value) })
          }
        />
        <em>{unit}</em>
      </span>
    </label>
  );

  return (
    <section className={`shipping shipping-${estimate.basis}`} aria-labelledby={`ship-${groupId}`}>
      <header className="shipping-head">
        <strong id={`ship-${groupId}`}>📦 Shipping</strong>
        {estimate.recommended ? (
          <span className="shipping-headline">
            {money(estimate.recommended.usd)} · {estimate.recommended.serviceName} ·{" "}
            {estimate.recommended.boxName}
          </span>
        ) : (
          <span className="shipping-headline warn">No standard box fits — price manually</span>
        )}
      </header>

      <p className="shipping-basis">
        {estimate.basis === "photos"
          ? "Weight and size read from the photos. Edit anything that looks off — these go to eBay."
          : "Greyed figures below are category guesses the estimate is already using. Type over them — every box you fill in is used for the quote and sent to eBay."}
      </p>

      <div className="ship-fields">
        {field("shipping_weight_oz", "Item weight", "oz", estimate.itemOz, estimate.provided.weight)}
        {field("shipping_length_in", "Length", "in", estimate.itemDims.l, estimate.provided.l)}
        {field("shipping_width_in", "Width", "in", estimate.itemDims.w, estimate.provided.w)}
        {field("shipping_height_in", "Height", "in", estimate.itemDims.h, estimate.provided.h)}
      </div>

      {estimate.box && (
        <dl className="ship-summary">
          <div>
            <dt>Packed weight</dt>
            <dd>
              {estimate.packedOz} oz
              <small> (item + box + fill)</small>
            </dd>
          </div>
          <div>
            <dt>Billed as</dt>
            <dd>
              {estimate.billableOz} oz
              {estimate.dimensionalOz > 0 && <small> (box volume, not the scale)</small>}
            </dd>
          </div>
          <div>
            <dt>Box</dt>
            <dd>
              {estimate.box.outer.l}×{estimate.box.outer.w}×{estimate.box.outer.h} in
            </dd>
          </div>
        </dl>
      )}

      {estimate.options.length > 0 && (
        <table className="ship-options">
          <tbody>
            {estimate.options.map((o) => (
              <tr key={`${o.serviceId}-${o.boxId}`} className={o === estimate.recommended ? "best" : ""}>
                <td>{o.serviceName}</td>
                <td className="ship-box">{o.boxName}</td>
                <td className="ship-cost">{money(o.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ship-mode">
        <label className="ship-toggle">
          <input
            type="checkbox"
            checked={free}
            onChange={(e) => onEdit(groupId, { shipping_free: e.target.checked })}
          />
          <span>
            <strong>Free shipping</strong> — you pay the postage. Unchecked, the buyer pays it.
          </span>
        </label>

        {canCompare && (
          <table className="ship-net-compare">
            <tbody>
              <tr className={free ? "best" : ""}>
                <td>Free shipping</td>
                <td className={netFree! < 0 ? "ship-cost negative" : "ship-cost"}>
                  {money(netFree!)}
                </td>
              </tr>
              <tr className={!free ? "best" : ""}>
                <td>Buyer pays shipping</td>
                <td className={netPaid! < 0 ? "ship-cost negative" : "ship-cost"}>
                  {money(netPaid!)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {netActive !== null && (
        <p className={`ship-net${netActive < 0 ? " negative" : ""}`}>
          At {money(price)} with {free ? "free shipping" : "buyer-paid shipping"} you net about{" "}
          <strong>{money(netActive)}</strong> after postage and eBay fees.
          {netActive < 0 && " This item loses money at that price."}
          {canCompare && !free && netPaid! - netFree! > 0.5 && (
            <> Charging shipping keeps {money(netPaid! - netFree!)} more per sale.</>
          )}
        </p>
      )}

      {estimate.warnings.map((w) => (
        <p className="ship-warning" key={w}>
          ⚠️ {w}
        </p>
      ))}

      <p className="ship-footnote">
        Costs are from a built-in rate table ({estimate.rateSource}, {estimate.rateTableEffective}) —
        an estimate for your margin maths, not a live carrier quote. The weight and box size above
        are what get sent to eBay, so with calculated shipping eBay quotes buyers at real current
        rates. Posting picks the eBay business policy matching the choice above; if your account
        has no policy of that kind, the listing says so rather than silently using the other one.
      </p>
    </section>
  );
}
