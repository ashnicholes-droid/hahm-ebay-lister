"use client";

import { useEffect, useRef, useState } from "react";
import type { CompsSummary } from "@/lib/types";
import type { Recommendation } from "@/lib/pricingRules";

// The comps behind a suggested price, listed so they can be judged.
//
// A band and a confidence score ask to be trusted. The actual listings can be
// checked — and checking is the point, because the filter that builds this band
// is keyword matching and it will sometimes pull in the wrong thing entirely.
// Seeing "Lot of 12" or a different model in the list is how a seller catches a
// bad recommendation before publishing it.
//
// A real <dialog> rather than a div: it gets Escape, focus trapping, and the
// backdrop for free, and it is inert to screen readers when closed.

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;

function shippingLabel(c: { shippingType: string; shippingCost: number | null }): string {
  if (c.shippingType === "free") return "free";
  if (c.shippingType === "flat") return money(c.shippingCost);
  if (c.shippingType === "calculated") return "at checkout";
  return "unknown";
}

export function CompsDialog({
  comps,
  recommendation,
  currentPrice,
  onUse,
  onClose,
}: {
  comps: CompsSummary;
  recommendation: Recommendation | null;
  currentPrice: number | null;
  onUse: (price: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sort, setSort] = useState<"delivered" | "item">("delivered");

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const rows = [...(comps.comps ?? [])].sort((a, b) => {
    const av = sort === "item" ? a.itemPrice : (a.delivered ?? Infinity);
    const bv = sort === "item" ? b.itemPrice : (b.delivered ?? Infinity);
    return av - bv;
  });

  const unpriced = rows.filter((c) => c.delivered === null).length;

  return (
    <dialog ref={ref} className="comps-dialog" onClose={onClose}>
      <div className="comps-dialog-head">
        <div>
          <h3>Market check</h3>
          <p>
            {comps.pricedCount ?? comps.count} active listings matching{" "}
            <strong>“{comps.query}”</strong>
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </div>

      {/* Said once, plainly, where the decision is being made — not buried in a
          tooltip. The gap between asking and sold is the biggest caveat here. */}
      <p className="comps-caveat">
        These are <strong>asking</strong> prices, not sold prices. eBay has no open sold-price API,
        and asking prices skew high because the ones priced right already sold.
      </p>

      {recommendation && (
        <div className="comps-rec">
          <div>
            <span className="k">Suggested</span>
            <strong>${recommendation.price.toFixed(2)}</strong>
            <small>{recommendation.explanation}</small>
            {recommendation.thin && (
              <small className="comps-thin">
                ⚠️ Only a handful of comps — treat this as a hint, not a market.
              </small>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={currentPrice === recommendation.price}
            onClick={() => {
              onUse(recommendation.price);
              ref.current?.close();
            }}
          >
            {currentPrice === recommendation.price
              ? "✓ Already set"
              : `Use $${recommendation.price.toFixed(2)}`}
          </button>
        </div>
      )}

      <div className="comps-sort">
        <span>Sort by</span>
        <button
          type="button"
          className={sort === "delivered" ? "active" : ""}
          onClick={() => setSort("delivered")}
        >
          Delivered
        </button>
        <button
          type="button"
          className={sort === "item" ? "active" : ""}
          onClick={() => setSort("item")}
        >
          Item price
        </button>
      </div>

      <div className="comps-table-wrap">
        <table className="comps-table">
          <thead>
            <tr>
              <th>Listing</th>
              <th>Item</th>
              <th>Postage</th>
              <th>Delivered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.url}-${i}`} className={c.delivered === null ? "unpriced" : undefined}>
                <td>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer noopener">
                      {c.title}
                    </a>
                  ) : (
                    c.title
                  )}
                  {c.condition && <small> · {c.condition}</small>}
                </td>
                <td>{money(c.itemPrice)}</td>
                <td>{shippingLabel(c)}</td>
                <td>
                  <strong>{money(c.delivered)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <p className="ebay-empty">No comps came back for this search.</p>}

      {unpriced > 0 && (
        <p className="comps-footnote">
          {unpriced} listing{unpriced === 1 ? " quotes" : "s quote"} postage at checkout, so
          there&rsquo;s no single delivered price. {unpriced === 1 ? "It\u2019s" : "They\u2019re"}{" "}
          shown for context but excluded from the band — counting{" "}
          {unpriced === 1 ? "it" : "them"} as free postage would drag the whole thing down.
        </p>
      )}

      <p className="comps-footnote">
        The anchor and margin come from{" "}
        <a href="/settings" target="_blank" rel="noreferrer">
          pricing settings
        </a>
        .
      </p>
    </dialog>
  );
}
