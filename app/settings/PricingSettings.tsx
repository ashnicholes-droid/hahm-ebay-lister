"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RULES,
  normalizeRules,
  recommendedPrice,
  type PricingRules,
} from "@/lib/pricingRules";
import { loadRules, saveRules } from "@/lib/pricingSettings";
import type { Comp, CompsSummary } from "@/lib/types";

// How a suggested price is derived from the market.
//
// Every control here is shown against a worked example that updates as it is
// changed. A percentile setting is abstract; "on this market, that means
// $23.10" is not, and the second is the only way to tell whether the number is
// the one you meant.

/** A stand-in market, so the preview is concrete rather than hypothetical. */
const SAMPLE: Comp[] = [
  { itemPrice: 18, shippingCost: 4.5, delivered: 22.5 },
  { itemPrice: 24, shippingCost: 0, delivered: 24 },
  { itemPrice: 21, shippingCost: 5.95, delivered: 26.95 },
  { itemPrice: 29, shippingCost: 0, delivered: 29 },
  { itemPrice: 27, shippingCost: 6.5, delivered: 33.5 },
  { itemPrice: 35, shippingCost: 0, delivered: 35 },
  { itemPrice: 32, shippingCost: 7.25, delivered: 39.25 },
  { itemPrice: 44, shippingCost: 0, delivered: 44 },
].map((c) => ({
  ...c,
  title: "Example listing",
  shippingType: c.shippingCost === 0 ? ("free" as const) : ("flat" as const),
  condition: "Used",
  url: "",
  imageUrl: "",
}));

const SAMPLE_SUMMARY: CompsSummary = {
  ok: true,
  query: "example",
  count: SAMPLE.length,
  pricedCount: SAMPLE.length,
  comps: SAMPLE,
  confidence: 0.8,
  basis: "",
};

export function PricingSettings() {
  const [rules, setRules] = useState<PricingRules>(DEFAULT_RULES);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read on mount, not during render: localStorage doesn't exist on the server
  // and touching it during render would break hydration.
  useEffect(() => {
    setRules(loadRules());
    setLoaded(true);
  }, []);

  const update = (patch: Partial<PricingRules>) => {
    const next = normalizeRules({ ...rules, ...patch });
    setRules(next);
    setFailed(!saveRules(next));
    setSaved(true);
  };

  const preview = useMemo(() => recommendedPrice(SAMPLE_SUMMARY, rules), [rules]);
  const sorted = useMemo(
    () =>
      [...SAMPLE].sort(
        (a, b) =>
          (rules.basis === "item" ? a.itemPrice : (a.delivered ?? 0)) -
          (rules.basis === "item" ? b.itemPrice : (b.delivered ?? 0))
      ),
    [rules.basis]
  );

  const nearestIndex = useMemo(() => {
    if (!preview) return -1;
    let best = -1;
    let bestGap = Infinity;
    sorted.forEach((c, i) => {
      const v = rules.basis === "item" ? c.itemPrice : (c.delivered ?? 0);
      const gap = Math.abs(v - preview.bottom);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best;
  }, [sorted, preview, rules.basis]);

  if (!loaded) return null;

  return (
    <>
      <section className="panel">
        <div className="result-head">
          <h3>How prices get suggested</h3>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => update(DEFAULT_RULES)}
            disabled={JSON.stringify(rules) === JSON.stringify(DEFAULT_RULES)}
          >
            Reset to defaults
          </button>
        </div>

        <p className="lm-intro">
          Suggested prices are anchored to the <strong>bottom</strong> of the market rather than the
          middle. A median-priced listing sits in the middle of a page of identical items and waits;
          the ones that move are near the bottom of the range. These settings decide how far down,
          and by how much you undercut.
        </p>

        <div className="ps-grid">
          <label className="ps-field">
            <span className="ps-label">What counts as “the bottom”</span>
            <span className="ps-control">
              <input
                type="range"
                min="0"
                max="50"
                step="5"
                value={rules.bottomPercentile}
                onChange={(e) => update({ bottomPercentile: Number(e.target.value) })}
              />
              <output>{rules.bottomPercentile}th percentile</output>
            </span>
            <small>
              {rules.bottomPercentile === 0
                ? "The single cheapest comp. Usually damaged, mis-titled, or a mistake — anchoring here chases a price nobody meant to set."
                : rules.bottomPercentile >= 50
                  ? "The median — the middle of the market, not the bottom of it."
                  : `Cheaper than ${100 - rules.bottomPercentile}% of the market, while ignoring the few outliers at the very bottom.`}
            </small>
          </label>

          <label className="ps-field">
            <span className="ps-label">How far above that to sit</span>
            <span className="ps-control">
              <input
                type="number"
                min="-50"
                max="200"
                step="1"
                inputMode="decimal"
                value={rules.percentAboveBottom}
                onChange={(e) => update({ percentAboveBottom: Number(e.target.value) })}
              />
              <output>%</output>
            </span>
            <small>
              {rules.percentAboveBottom < 0
                ? "Below the bottom of the band — deliberately undercutting everyone."
                : rules.percentAboveBottom === 0
                  ? "Exactly at the anchor."
                  : "Above the anchor. Small numbers stay competitive; large ones put you back in the middle of the pack."}
            </small>
          </label>

          <fieldset className="ps-field">
            <legend className="ps-label">Compare on</legend>
            <div className="ps-radios">
              <label>
                <input
                  type="radio"
                  name="basis"
                  checked={rules.basis === "delivered"}
                  onChange={() => update({ basis: "delivered" })}
                />
                Delivered price (item + postage)
              </label>
              <label>
                <input
                  type="radio"
                  name="basis"
                  checked={rules.basis === "item"}
                  onChange={() => update({ basis: "item" })}
                />
                Item price only
              </label>
            </div>
            <small>
              Delivered is the honest comparison: a $20 item with $9 postage is dearer than a $26
              one with free postage, and comparing item prices alone gets that backwards. Choose
              item price only if you always ship free and think in item prices.
            </small>
          </fieldset>

          <fieldset className="ps-field">
            <legend className="ps-label">Round to</legend>
            <div className="ps-radios">
              {(
                [
                  ["99", "$X.99"],
                  ["95", "$X.95"],
                  ["whole", "Whole dollars"],
                  ["none", "Don’t round"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="rounding"
                    checked={rules.rounding === value}
                    onChange={() => update({ rounding: value })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <small>
              Rounding never goes <em>up</em> past the computed price — that would quietly add
              margin you didn’t ask for.
            </small>
          </fieldset>
        </div>

        {failed && (
          <p className="note note-warn">
            These settings couldn’t be saved — this browser is blocking local storage. They apply
            for now but won’t survive a reload.
          </p>
        )}
        {saved && !failed && <p className="lm-ok">✓ Saved on this device</p>}
      </section>

      <section className="panel">
        <div className="result-head">
          <h3>What that does to a real market</h3>
        </div>
        <p className="lm-intro">
          An example market of {SAMPLE.length} comps. Change a setting above and watch the
          recommendation move.
        </p>

        <div className="ps-preview">
          <div className="ps-rec">
            <span className="k">Would suggest</span>
            <strong>${preview ? preview.price.toFixed(2) : "—"}</strong>
            <small>{preview?.explanation}</small>
          </div>
          <table className="ps-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Postage</th>
                <th>Delivered</th>
                <th aria-label="Anchor" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => {
                const value = rules.basis === "item" ? c.itemPrice : (c.delivered ?? 0);
                // The anchor is an interpolated percentile, so it usually falls
                // BETWEEN two comps and never equals one exactly. Highlighting
                // the nearest is what makes an abstract percentile legible as a
                // position in a real market.
                const isAnchor = preview !== null && i === nearestIndex;
                return (
                  <tr key={i} className={isAnchor ? "anchor" : undefined}>
                    <td>${c.itemPrice.toFixed(2)}</td>
                    <td>{c.shippingCost === 0 ? "free" : `$${c.shippingCost?.toFixed(2)}`}</td>
                    <td>${c.delivered?.toFixed(2)}</td>
                    <td className="ps-anchor-cell">{isAnchor ? "← anchor" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="result-head">
          <h3>Why these are asking prices, not sold prices</h3>
        </div>
        <p className="lm-intro">
          Comps come from eBay’s Browse API, which only indexes <strong>active</strong> listings.
          That matters: asking prices skew high, because the listings that were priced right already
          sold and left the data.
        </p>
        <p className="lm-intro">
          eBay has no open sold-price API. <code>findCompletedItems</code> was decommissioned in
          February 2025, and the <strong>Marketplace Insights API</strong> that replaced it is a
          Limited Release that eBay states is “restricted and not open to new users at this time.”
          Anchoring to the bottom of the asking-price band is partly a correction for that gap — the
          bottom of asking is closer to sold than the middle is.
        </p>
      </section>
    </>
  );
}
