"use client";

import { useMemo, useState } from "react";
import { DIMENSIONAL_WARNING_PREFIX, estimateShipping } from "@/lib/shipping/estimate";
import { listingQuantity } from "@/lib/quantity";
import type { ListingResult } from "@/lib/types";

interface ShippingPanelProps {
  listing: ListingResult;
  groupId: string;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** Options shown before the list collapses behind "show more". */
const VISIBLE_OPTIONS = 5;

function num(v: unknown): string {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

export function ShippingPanel({ listing, groupId, onEdit }: ShippingPanelProps) {
  const [showAll, setShowAll] = useState(false);
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
        selectedOptionId: listing.shipping_option_id,
      }),
    [
      listing.shipping_weight_oz,
      listing.shipping_length_in,
      listing.shipping_width_in,
      listing.shipping_height_in,
      listing.category,
      listing.shipping_option_id,
    ]
  );

  const price = Number(listing.suggested_price) || 0;
  const quantity = listingQuantity(listing);
  // Every figure below prices what will ACTUALLY be shipped, so a deliberate
  // choice to pay more for a flat-rate envelope shows its real effect on margin
  // instead of the cheapest option's.
  const shipCost = estimate.chosen?.usd ?? 0;
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

  // Show the cheapest handful, plus whatever is selected so a deliberate choice
  // never disappears behind a "show more" button.
  const visibleOptions = useMemo(() => {
    if (showAll) return estimate.options;
    const top = estimate.options.slice(0, VISIBLE_OPTIONS);
    const sel = estimate.options.find((o) => o.id === estimate.chosen?.id);
    return sel && !top.includes(sel) ? [...top, sel] : top;
  }, [estimate.options, estimate.chosen, showAll]);

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
        {estimate.chosen ? (
          <span className="shipping-headline">
            {money(estimate.chosen.usd)} · {estimate.chosen.serviceName}
            {estimate.chosen.flatRate ? "" : ` · ${estimate.chosen.boxName}`}
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

      {/* The single most-asked question this panel has to answer: "I changed the
          weight and nothing happened." It gets answered next to the weight
          field, not in a warning list below the fold. */}
      {estimate.dimensionalOz > 0 && (
        <p className="ship-dim-note">
          <strong>📐 Size is setting this price, not weight.</strong> Packed, this comes to{" "}
          {estimate.chosenPackage && (
            <>
              {estimate.chosenPackage.outer.l}×{estimate.chosenPackage.outer.w}×
              {estimate.chosenPackage.outer.h} in
            </>
          )}{" "}
          — over a cubic foot — so USPS bills it as <strong>{estimate.dimensionalOz} oz</strong> of
          volume however light the item actually is. Editing the weight above won&rsquo;t change the
          cost until the packed weight passes {estimate.dimensionalOz} oz; only smaller dimensions
          will. If the item is really smaller than {estimate.itemDims.l}×{estimate.itemDims.w}×
          {estimate.itemDims.h} in, correct that instead.
        </p>
      )}

      {estimate.chosenPackage && (
        <dl className="ship-summary">
          <div>
            <dt>Packed weight</dt>
            <dd>
              {estimate.chosenPackage.packedOz} oz
              <small> (item + packaging + fill)</small>
            </dd>
          </div>
          <div>
            <dt>Billed as</dt>
            <dd>
              {/* Flat rate ignores weight entirely, so quoting a billable weight
                  next to it would be describing a calculation that isn't
                  happening. */}
              {estimate.chosen?.flatRate ? (
                <>
                  flat rate<small> (weight doesn&rsquo;t matter, up to 70 lb)</small>
                </>
              ) : (
                <>
                  {estimate.billableOz} oz
                  {estimate.dimensionalOz > 0 && <small> (box volume, not the scale)</small>}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{estimate.chosen?.flatRate ? "Container" : "Box"}</dt>
            <dd>
              {estimate.chosenPackage.outer.l}×{estimate.chosenPackage.outer.w}×
              {estimate.chosenPackage.outer.h} in
            </dd>
          </div>
        </dl>
      )}

      {estimate.options.length > 0 && (
        <fieldset className="ship-options">
          <legend>Packaging &amp; service</legend>
          <label className={`ship-option${estimate.manualSelection ? "" : " best"}`}>
            <input
              type="radio"
              name={`ship-opt-${groupId}`}
              checked={!estimate.manualSelection}
              onChange={() => onEdit(groupId, { shipping_option_id: "" })}
            />
            <span className="ship-option-name">
              Cheapest that fits
              {estimate.recommended && (
                <small> — currently {estimate.recommended.serviceName}</small>
              )}
            </span>
            <span className="ship-cost">
              {estimate.recommended ? money(estimate.recommended.usd) : "—"}
            </span>
          </label>

          {visibleOptions.map((o) => (
            <label
              key={o.id}
              className={`ship-option${estimate.manualSelection && o.id === estimate.chosen?.id ? " best" : ""}`}
            >
              <input
                type="radio"
                name={`ship-opt-${groupId}`}
                checked={estimate.manualSelection && o.id === estimate.chosen?.id}
                onChange={() => onEdit(groupId, { shipping_option_id: o.id })}
              />
              <span className="ship-option-name">
                {o.serviceName}
                {o.flatRate ? (
                  <small className="ship-flat-tag">flat rate — any weight</small>
                ) : (
                  <small> — {o.boxName}</small>
                )}
              </span>
              <span className="ship-cost">{money(o.usd)}</span>
            </label>
          ))}

          {estimate.options.length > visibleOptions.length && (
            <button type="button" className="ship-more" onClick={() => setShowAll(true)}>
              Show {estimate.options.length - visibleOptions.length} more packaging option
              {estimate.options.length - visibleOptions.length === 1 ? "" : "s"}
            </button>
          )}
        </fieldset>
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
          <strong>{money(netActive)}</strong>
          {quantity > 1 ? " per unit" : ""} after postage and eBay fees.
          {/* Per-unit postage is right here: multiples of one item bought
              together still ship as separate orders unless the buyer combines
              them, and assuming they will would flatter the total. */}
          {quantity > 1 && (
            <> All {quantity} sold separately comes to <strong>{money(netActive * quantity)}</strong>.</>
          )}
          {netActive < 0 && " This item loses money at that price."}
          {canCompare && !free && netPaid! - netFree! > 0.5 && (
            <> Charging shipping keeps {money(netPaid! - netFree!)} more per sale.</>
          )}
        </p>
      )}

      {/* The dimensional-weight warning is rendered above as a callout, so it is
          filtered out here rather than said twice. */}
      {estimate.warnings
        .filter((w) => !w.startsWith(DIMENSIONAL_WARNING_PREFIX))
        .map((w) => (
          <p className="ship-warning" key={w}>
            ⚠️ {w}
          </p>
        ))}

      {estimate.manualSelection && estimate.chosen?.flatRate && (
        <p className="ship-warning">
          ⚠️ Flat rate is what <em>you</em> will pay at the counter. What the <em>buyer</em> is
          quoted still comes from your eBay shipping policy — if it offers calculated shipping,
          eBay prices by weight and size, not by this flat rate. To charge the buyer the flat
          rate, tick free shipping and build it into your price, or use an eBay policy with a
          fixed shipping cost.
        </p>
      )}

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
