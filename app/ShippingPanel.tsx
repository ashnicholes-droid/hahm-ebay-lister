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
  // What the seller keeps if they absorb shipping. eBay's final value fee is
  // roughly 13.25% + $0.40 on most categories; close enough to tell a
  // marginal item from a good one, which is the decision this supports.
  const netIfFree = price > 0 && shipCost > 0 ? price - shipCost - (price * 0.1325 + 0.4) : null;

  const field = (key: keyof ListingResult, label: string, unit: string) => (
    <label className="ship-field" key={key}>
      <span>{label}</span>
      <span className="ship-input">
        <input
          type="number"
          min="0"
          step="0.1"
          inputMode="decimal"
          value={num(listing[key])}
          placeholder="—"
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
          : "Weight and size are a category guess. Fill them in for a real number."}
      </p>

      <div className="ship-fields">
        {field("shipping_weight_oz", "Item weight", "oz")}
        {field("shipping_length_in", "Length", "in")}
        {field("shipping_width_in", "Width", "in")}
        {field("shipping_height_in", "Height", "in")}
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
              {estimate.billableOz > Math.ceil(estimate.packedOz) && <small> (dimensional)</small>}
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

      {netIfFree !== null && (
        <p className={`ship-net${netIfFree < 0 ? " negative" : ""}`}>
          Free shipping at {money(price)} nets about <strong>{money(netIfFree)}</strong> after
          postage and eBay fees.
          {netIfFree < 0 && " This item loses money at that price."}
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
        rates.
      </p>
    </section>
  );
}
