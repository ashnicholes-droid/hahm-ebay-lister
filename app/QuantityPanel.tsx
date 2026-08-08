"use client";

import {
  MAX_DISCOUNT_PERCENT,
  MAX_QUANTITY,
  MIN_DISCOUNT_QUANTITY,
  discountedUnitPrice,
  listingQuantity,
  quantityWarnings,
  volumeDiscount,
} from "@/lib/quantity";
import type { ListingResult } from "@/lib/types";

interface QuantityPanelProps {
  listing: ListingResult;
  groupId: string;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

function inputValue(v: unknown): string {
  if (v === "" || v === undefined || v === null) return "";
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

export function QuantityPanel({ listing, groupId, onEdit }: QuantityPanelProps) {
  const multi = listing.multi_quantity === true;
  const quantity = listingQuantity(listing);
  const discount = volumeDiscount(listing);
  const warnings = quantityWarnings(listing);
  const price = Number(listing.suggested_price) || 0;

  // Ticking the box has to leave a usable listing immediately, so it seeds a
  // quantity of 2 — "I have multiples" and "I have one" are contradictory, and
  // an empty field would publish as 1 while claiming otherwise. Unticking clears
  // the discount too: a discount left dangling on a single item is invisible
  // here and confusing when the box is ticked again later.
  const toggle = (on: boolean) =>
    onEdit(
      groupId,
      on
        ? { multi_quantity: true, quantity: quantity > 1 ? quantity : 2 }
        : {
            multi_quantity: false,
            quantity: "",
            volume_discount_percent: "",
            volume_discount_min: "",
          }
    );

  return (
    <section className="qty-panel" aria-labelledby={`qty-${groupId}`}>
      <label className="qty-toggle">
        <input type="checkbox" checked={multi} onChange={(e) => toggle(e.target.checked)} />
        <span id={`qty-${groupId}`}>
          <strong>I have multiples of this item</strong> — otherwise it lists as a single
          one-of-a-kind item.
        </span>
      </label>

      {multi && (
        <div className="qty-body">
          <div className="qty-fields">
            <label className="qty-field">
              <span>Quantity</span>
              <input
                type="number"
                min="1"
                max={MAX_QUANTITY}
                step="1"
                inputMode="numeric"
                value={inputValue(listing.quantity)}
                placeholder="2"
                onChange={(e) =>
                  onEdit(groupId, {
                    quantity: e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
              />
            </label>

            <label className="qty-field">
              <span>Multi-buy discount</span>
              <span className="qty-input">
                <input
                  type="number"
                  min="0"
                  max={MAX_DISCOUNT_PERCENT}
                  step="1"
                  inputMode="numeric"
                  value={inputValue(listing.volume_discount_percent)}
                  placeholder="none"
                  onChange={(e) =>
                    onEdit(groupId, {
                      volume_discount_percent:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
                <em>% off</em>
              </span>
            </label>

            <label className="qty-field">
              <span>When buying</span>
              <span className="qty-input">
                <input
                  type="number"
                  min={MIN_DISCOUNT_QUANTITY}
                  max={MAX_QUANTITY}
                  step="1"
                  inputMode="numeric"
                  value={inputValue(listing.volume_discount_min)}
                  placeholder={String(MIN_DISCOUNT_QUANTITY)}
                  onChange={(e) =>
                    onEdit(groupId, {
                      volume_discount_min: e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
                <em>or more</em>
              </span>
            </label>
          </div>

          <p className="qty-summary">
            {quantity} available.
            {discount && price > 0 ? (
              <>
                {" "}
                A buyer taking {discount.minQuantity} pays{" "}
                <strong>{money(discountedUnitPrice(price, discount))}</strong> each instead of{" "}
                {money(price)} — {money(discount.minQuantity * (price - discountedUnitPrice(price, discount)))}{" "}
                off that order, and you clear{" "}
                <strong>{money(discount.minQuantity * discountedUnitPrice(price, discount))}</strong>{" "}
                in one sale.
              </>
            ) : discount ? (
              <> Multi-buy: {discount.percentOff}% off each when buying {discount.minQuantity} or more.</>
            ) : warnings.length > 0 ? (
              // A warning is already explaining why there's no discount; repeating
              // "leave the percentage blank" at someone who just typed one reads
              // as the app not having noticed.
              null
            ) : (
              <> No multi-buy discount — leave the percentage blank to keep it that way.</>
            )}
          </p>

          {warnings.map((w) => (
            <p className="qty-warning" key={w}>
              ⚠️ {w}
            </p>
          ))}

          <p className="qty-footnote">
            Quantity is sent to eBay with the listing. The multi-buy discount is applied
            afterwards through eBay&rsquo;s Promotions manager, and listings sharing the same
            terms are grouped into one promotion. If your eBay connection predates this feature,
            reconnect once — posting will tell you if that&rsquo;s needed.
          </p>
        </div>
      )}
    </section>
  );
}
