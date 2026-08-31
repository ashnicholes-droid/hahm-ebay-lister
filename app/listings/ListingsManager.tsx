"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { netAtPrice, type ShippingArrangement } from "@/lib/fees";
import { breakEvenPrice, profitAtPrice } from "@/lib/costBasis";
import { relistAdvice } from "@/lib/relistAdvice";
import {
  changesArrangement,
  describeArrangement,
  groupPolicies,
  netUnder,
  policyLabel,
  policyKind,
  type ShippingPolicyOption,
} from "@/lib/ebay/shippingPolicy";
import { finalValueFee } from "@/lib/fees";
import { ContentEditor, ContentFields, useContent, type Content } from "./ContentEditor";
import { triageListing, triageSummary, type Triage } from "@/lib/triage";
import {
  MAX_OFFER_MESSAGE,
  MIN_DISCOUNT_PERCENT,
  OFFER_DURATION_DAYS,
  offeredPrice,
  validateOffer,
} from "@/lib/ebay/negotiation";

// The seller view: your live eBay listings, with the one edit that Seller Hub
// won't let you make on them.
//
// This is a separate route rather than a tab inside the posting flow on
// purpose. The posting flow is a wizard holding photos in memory — navigating
// into and out of it would destroy an in-progress batch — and it is about
// DRAFTS, while this screen is about listings that are already live. Different
// data, different lifecycle, and a real route is linkable and survives a
// refresh.

interface SellerListing {
  itemId: string;
  title: string;
  sku: string;
  price: number | null;
  currency: string;
  quantity: number | null;
  quantitySold: number | null;
  watchCount: number | null;
  views?: number | null;
  impressions?: number | null;
  imageUrl: string;
  viewUrl: string;
  bestOfferEnabled: boolean;
  shipping: ShippingArrangement;
  shippingCost: number | null;
  shippingService: string;
  /** eBay says this listing currently has buyers worth offering to. */
  offerEligible?: boolean;
  startTime?: string;
  /** What it cost you, kept in eBay's seller-only note. Null = never recorded. */
  cost?: number | null;
  /** The rest of that note, preserved so saving a cost can't overwrite prose. */
  note?: string;
  /** Ended from this screen. Kept visible, dimmed, until the next refresh. */
  ended?: boolean;
}

interface ListingsResponse {
  ok: boolean;
  listings?: SellerListing[];
  page?: number;
  totalPages?: number;
  totalItems?: number;
  traffic?: { unavailable?: string; windowDays: number; debug?: unknown };
  offers?: { unavailable?: string; debug?: unknown; eligibleCount?: number };
  error?: string;
}

const money = (v: number | null, currency: string) => {
  if (v === null) return "—";
  const symbol = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return symbol ? `${symbol}${v.toFixed(2)}` : `${v.toFixed(2)} ${currency}`;
};

/** A stat that eBay didn't report reads "—", never "0". */
const stat = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

/**
 * Who pays the postage, at a glance.
 *
 * "free" is the one that costs the seller money, so it is the one styled to
 * catch the eye — that is the whole question being asked next to a price field.
 */
function ShippingBadge({ listing }: { listing: SellerListing }) {
  const { shipping, shippingCost, shippingService } = listing;
  const title = shippingService || undefined;
  if (shipping === "free") {
    return (
      <span className="lm-ship lm-ship-free" title={title}>
        Free shipping — you pay
      </span>
    );
  }
  if (shipping === "flat") {
    return (
      <span className="lm-ship lm-ship-paid" title={title}>
        Buyer pays {money(shippingCost, listing.currency)}
      </span>
    );
  }
  if (shipping === "calculated") {
    return (
      <span className="lm-ship lm-ship-paid" title={title}>
        Buyer pays — calculated
      </span>
    );
  }
  return (
    <span className="lm-ship lm-ship-unknown" title="eBay didn't return shipping details for this listing">
      Shipping unknown
    </span>
  );
}

/**
 * Send a discount to the people watching one listing.
 *
 * Two things make this different from the price editor beside it. An offer
 * cannot be unsent — a buyer can accept it the moment it lands — so it is
 * behind a disclosure rather than a bare input, and the confirm button states
 * the actual price the buyer will see rather than the percentage. And
 * eligibility is eBay's answer, so a listing with watchers but no offer button
 * is not a bug: eBay has its own rules about recency and how many offers a
 * listing has already had.
 */
function OfferPanel({
  listing,
  autoOpen,
}: {
  listing: SellerListing;
  /** Opened from the banner at the top rather than by clicking the summary. */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(String(MIN_DISCOUNT_PERCENT * 2));
  const [message, setMessage] = useState("");
  const [days, setDays] = useState<number>(OFFER_DURATION_DAYS[OFFER_DURATION_DAYS.length - 1]);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const pct = Number(percent);
  const price = listing.price ?? 0;
  const valid = validateOffer({ discountPercent: pct, message, durationDays: days });
  const problem = "error" in valid ? valid.error : null;
  const buyerPays = problem ? null : offeredPrice(price, pct);
  const net =
    buyerPays === null
      ? null
      : netAtPrice(buyerPays, listing.shipping, listing.shippingCost ?? 0);

  // Jumping here from the banner should land on an OPEN form — arriving at a
  // collapsed summary means the click only did half the job.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  const send = async () => {
    if (problem || buyerPays === null) return;
    setState("sending");
    setError(null);
    try {
      const res = await apiPost("/api/ebay/offer", {
        listingId: listing.itemId,
        discountPercent: pct,
        message: message.trim() || undefined,
        durationDays: days,
        quantity: 1,
      });
      const data = (await res.json()) as { ok: boolean; error?: string; offerId?: string };
      if (!data.ok) throw new Error(data.error || "eBay refused the offer.");
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  if (state === "sent") {
    return (
      <p className="lm-offer-sent">
        ✓ Offer sent to watchers at {money(buyerPays, listing.currency)}. It runs for {days} day
        {days === 1 ? "" : "s"}.
      </p>
    );
  }

  return (
    <details className="lm-offer" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        💌 Send an offer
        {listing.watchCount ? <small> to {listing.watchCount} watching</small> : null}
      </summary>

      <div className="lm-offer-body">
        <div className="lm-offer-fields">
          <label>
            <span>Discount</span>
            <span className="lm-offer-input">
              <input
                type="number"
                min={MIN_DISCOUNT_PERCENT}
                max={60}
                step="1"
                inputMode="numeric"
                value={percent}
                onChange={(e) => {
                  setPercent(e.target.value);
                  setState("idle");
                  setError(null);
                }}
              />
              <em>% off</em>
            </span>
          </label>

          <label>
            <span>Expires in</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {OFFER_DURATION_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="lm-offer-msg">
          <span>
            Message <small>optional, {MAX_OFFER_MESSAGE - message.length} left</small>
          </span>
          <input
            type="text"
            maxLength={MAX_OFFER_MESSAGE}
            placeholder="e.g. Thanks for watching — here's a discount."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        {/* Not a toggle, because it can't be one. eBay's docs on this field
            say "Currently, you must set this field to false; counter-offers
            are not supported in this release" — offering the choice just
            produced a rejected request. */}
        <p className="lm-offer-counter">
          Buyers can accept or ignore this offer. eBay doesn&rsquo;t support counter-offers on
          seller-sent offers yet.
        </p>

        {problem ? (
          <p className="lm-err">{problem}</p>
        ) : (
          <p className="lm-offer-preview">
            Buyer pays <strong>{money(buyerPays, listing.currency)}</strong> instead of{" "}
            {money(listing.price, listing.currency)}. {net?.label}
          </p>
        )}

        {error && <p className="lm-err">{error}</p>}

        <button
          type="button"
          className="btn btn-primary lm-offer-send"
          disabled={Boolean(problem) || state === "sending"}
          onClick={send}
        >
          {state === "sending"
            ? "Sending…"
            : `Send offer at ${money(buyerPays, listing.currency)}`}
        </button>
        <p className="lm-offer-warn">
          This goes to everyone watching and can&rsquo;t be withdrawn — a buyer can accept it
          immediately.
        </p>
      </div>
    </details>
  );
}

/**
 * What the item cost, stored on eBay rather than here.
 *
 * There is no database behind this app, so the figure goes into eBay's own
 * per-listing private note — seller-only, and it travels with the listing. That
 * makes saving a network round-trip rather than a keystroke, so it saves on
 * blur or Enter rather than on every character.
 */
function CostEditor({
  listing,
  onSaved,
}: {
  listing: SellerListing;
  onSaved: (cost: number | null) => void;
}) {
  const initial = listing.cost === null || listing.cost === undefined ? "" : String(listing.cost);
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state === "idle" || state === "saved") setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.cost]);

  const save = async () => {
    const trimmed = value.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    // Nothing typed, nothing changed — don't spend an eBay write on a blur.
    if (next === (listing.cost ?? null)) return;
    if (next !== null && !Number.isFinite(next)) {
      setError("That isn't a number.");
      setState("error");
      return;
    }
    setState("saving");
    setError(null);
    try {
      const res = await apiPost("/api/ebay/cost", {
        itemId: listing.itemId,
        cost: trimmed === "" ? null : trimmed,
        note: listing.note ?? "",
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        cost?: number | null;
      };
      if (!data.ok) throw new Error(data.error || "eBay refused the note.");
      const confirmed = data.cost ?? null;
      onSaved(confirmed);
      setValue(confirmed === null ? "" : String(confirmed));
      setState("saved");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="lm-cost">
      <label className="lm-cost-row">
        <span>Paid</span>
        <span aria-hidden="true">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          placeholder="—"
          value={value}
          aria-label={`What you paid for ${listing.title}`}
          disabled={state === "saving"}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
            setError(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      {state === "saving" && <span className="lm-cost-hint">Saving…</span>}
      {state === "saved" && <span className="lm-ok">✓ Saved to eBay</span>}
      {error && <span className="lm-err">{error}</span>}
      {state === "idle" && (listing.cost ?? null) === null && (
        <span className="lm-cost-hint">Kept in eBay&rsquo;s private note — only you see it.</span>
      )}
    </div>
  );
}

/**
 * Profit at the price currently typed, plus the price that breaks even.
 *
 * The break-even is the number worth showing while someone drags a price down:
 * it is not cost plus a percentage, because eBay's fee lands on the buyer's
 * shipping too, and guessing it by eye is how a "small discount" turns into a
 * loss.
 */
function ProfitLine({
  price,
  cost,
  shipping,
  shippingCost,
}: {
  price: number;
  cost: number;
  shipping: ShippingArrangement;
  shippingCost: number | null;
}) {
  const p = profitAtPrice(price, cost, shipping, shippingCost ?? 0);
  const floor = breakEvenPrice(cost, shipping, shippingCost ?? 0);
  return (
    <span className={`lm-profit${p.profit < 0 ? " loss" : ""}`}>
      {p.label} <small>Break-even ${floor.toFixed(2)}.</small>
    </span>
  );
}

function PriceEditor({
  listing,
  onSaved,
}: {
  listing: SellerListing;
  onSaved: (price: number) => void;
}) {
  const [value, setValue] = useState(listing.price === null ? "" : String(listing.price));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // If the row is refreshed from eBay, follow it — unless the seller is
  // mid-edit, where clobbering what they typed would be its own bug.
  useEffect(() => {
    if (state === "idle" || state === "saved") {
      setValue(listing.price === null ? "" : String(listing.price));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.price]);

  const changed = value.trim() !== "" && Number(value) !== listing.price;

  // Recomputed as they type, from the price in the box rather than the one
  // currently live — the question is "what would this price net me", and
  // answering it about the old price would be useless.
  const typed = Number(value);
  const net = netAtPrice(
    Number.isFinite(typed) ? typed : 0,
    listing.shipping,
    listing.shippingCost ?? 0
  );

  const save = async () => {
    if (!changed) return;
    setState("saving");
    setError(null);
    try {
      const res = await apiPost("/api/ebay/revise", { sku: listing.sku, price: Number(value) });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        offer?: { price: number | null };
      };
      if (!data.ok) throw new Error(data.error || "eBay refused the change.");
      // Trust eBay's read-back over what was typed: a 204 means "accepted", and
      // the only figure worth showing is the one the live listing now holds.
      const confirmed = data.offer?.price ?? Number(value);
      onSaved(confirmed);
      setValue(String(confirmed));
      setState("saved");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="lm-price">
      <div className="lm-price-row">
        <span aria-hidden="true">$</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          value={value}
          aria-label={`Price for ${listing.title}`}
          disabled={state === "saving"}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button
          type="button"
          className="btn-ghost lm-save"
          disabled={!changed || state === "saving"}
          onClick={save}
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      {/* No net figure beside a rejected price — quoting proceeds for an amount
          eBay just refused reads as if it were going to happen. */}
      {!error && (
        <span className={`lm-net${net.postageExcluded ? " approx" : ""}`}>{net.label}</span>
      )}
      {/* Net answers "what does eBay leave me". Profit answers the question the
          seller is actually asking, and only exists once a cost is recorded. */}
      {!error &&
        listing.cost !== null &&
        listing.cost !== undefined &&
        Number.isFinite(typed) &&
        typed > 0 && (
          <ProfitLine
            price={typed}
            cost={listing.cost}
            shipping={listing.shipping}
            shippingCost={listing.shippingCost}
          />
        )}
      {state === "saved" && <span className="lm-ok">✓ Live on eBay</span>}
      {error && <span className="lm-err">{error}</span>}
    </div>
  );
}

/**
 * Ending a listing, and relisting it fresh.
 *
 * The most destructive control in the app, and built to feel like it. It stays
 * folded away behind a disclosure, it names the listing being ended, and the
 * button only arms once a checkbox is ticked — because the outcome cannot be
 * undone and the item id does not come back.
 *
 * It also argues with the seller when it should: a listing with watchers is the
 * wrong thing to relist, and the panel says so rather than quietly obeying.
 */
/**
 * The seller's shipping policies, fetched once and shared.
 *
 * Module-level rather than per-panel: opening three relist panels should cost
 * one request, not three, and the answer is identical for all of them.
 */
let policyCache: ShippingPolicyOption[] | null = null;
let policyInFlight: Promise<ShippingPolicyOption[]> | null = null;

function useShippingPolicies(enabled: boolean) {
  const [policies, setPolicies] = useState<ShippingPolicyOption[] | null>(policyCache);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || policies !== null) return;
    let live = true;
    if (!policyInFlight) {
      policyInFlight = apiGet("/api/ebay/shipping-policies")
        .then((r) => r.json())
        .then((d: { ok?: boolean; policies?: ShippingPolicyOption[] }) => {
          policyCache = d.ok && Array.isArray(d.policies) ? d.policies : [];
          return policyCache;
        })
        .catch(() => {
          // Cleared so a later panel can retry — a transient failure shouldn't
          // disable the feature for the rest of the session.
          policyInFlight = null;
          return [];
        });
    }
    void policyInFlight.then((p) => {
      if (!live) return;
      setPolicies(p);
      setFailed(p.length === 0);
    });
    return () => {
      live = false;
    };
  }, [enabled, policies]);

  return { policies, failed };
}

/**
 * Pick which business policy the relisted offer uses for postage.
 *
 * Real policies by name, not a free/paid toggle. eBay stores shipping as a
 * policy the offer points at, so a toggle would be a lie for a seller with
 * three paid policies at different rates and would fail outright for one with
 * no free policy at all — this app cannot create a policy on their behalf.
 *
 * The net-proceeds line is the reason anyone opens this. Free postage lowers
 * eBay's fee, because the fee is charged on a smaller order total — but you pay
 * the label, which almost always costs more than the fee saved. Two numbers
 * side by side turn that from a hunch into arithmetic.
 */
function ShippingChoiceFields({
  listing,
  policies,
  failed,
  policyId,
  onChange,
  fixedPostage,
  onFixedPostage,
  price,
}: {
  listing: SellerListing;
  policies: ShippingPolicyOption[] | null;
  failed: boolean;
  policyId: string;
  onChange: (id: string) => void;
  fixedPostage: string;
  onFixedPostage: (v: string) => void;
  price: number | null;
}) {
  if (policies === null && !failed) {
    return (
      <p className="ce-hint">
        <span className="spinner" aria-hidden="true" /> Reading your shipping policies…
      </p>
    );
  }
  if (failed || (policies && policies.length === 0)) {
    return (
      <p className="lm-relist-warn" role="note">
        No shipping business policies came back from eBay, so postage can&rsquo;t be changed here.
        Set them up in eBay → Account → Business policies, or relist without changing shipping.
      </p>
    );
  }

  const list = policies ?? [];
  const groups = groupPolicies(list);
  const picked = list.find((p) => p.id === policyId) ?? null;
  const current = listing.shipping;
  // Two DIFFERENT postage figures, and conflating them makes the comparison
  // meaningless: "now" is what the listing charges today, "after" is what the
  // seller just typed. Using the typed figure on both sides reported a $12.50
  // postage change as "Difference +$0.00" — the change looked free when it
  // actually costs the eBay fee on that postage.
  const typed = fixedPostage.trim() === "" ? null : Number(fixedPostage);
  const typedOk = typed !== null && Number.isFinite(typed) && typed >= 0;
  const postageNow = listing.shippingCost;
  const postageAfter = typedOk ? typed : listing.shippingCost;

  // Setting a different amount IS a change, even on the same kind of policy —
  // so the "nothing would change" warning has to stand down when one is typed.
  const noChange =
    picked !== null &&
    fixedPostage.trim() === "" &&
    !changesArrangement(current, { kind: "policy", id: picked.id }, list);

  const before =
    price === null || !Number.isFinite(price)
      ? null
      : netUnder(price, current === "free", postageNow, finalValueFee);
  const after =
    picked === null || price === null || !Number.isFinite(price)
      ? null
      : netUnder(price, picked.free, postageAfter, finalValueFee);

  return (
    <div className="lm-shipping">
      <p className="ce-hint">
        Now: <strong>{describeArrangement(current, postageNow, listing.shippingService)}</strong>
      </p>

      <label className="lm-shipping-pick">
        Relist under
        <select value={policyId} onChange={(e) => onChange(e.target.value)}>
          <option value="">Keep the current policy</option>
          {groups.free.length > 0 && (
            <optgroup label="Free to the buyer — you pay postage">
              {groups.free.map((p) => (
                <option key={p.id} value={p.id}>
                  {policyLabel(p)}
                </option>
              ))}
            </optgroup>
          )}
          {groups.flat.length > 0 && (
            <optgroup label="Buyer pays a fixed amount">
              {groups.flat.map((p) => (
                <option key={p.id} value={p.id}>
                  {policyLabel(p)}
                </option>
              ))}
            </optgroup>
          )}
          {groups.calculated.length > 0 && (
            <optgroup label="Buyer pays a calculated rate">
              {groups.calculated.map((p) => (
                <option key={p.id} value={p.id}>
                  {policyLabel(p)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      {/* The field that means one flat-rate policy covers every price point.
          eBay has no per-listing shipping price of its own — this is sent as a
          shippingCostOverrides on the offer, which changes the policy's amount
          for THIS listing only and leaves the policy alone. */}
      {picked !== null && !picked.free && picked.costType === "flat" && (
        <label className="lm-shipping-pick">
          Charge the buyer
          <span className="lm-shipping-amount">
            <span aria-hidden="true">$</span>
            <input
              type="number"
              min="0"
              max="1000"
              step="0.01"
              inputMode="decimal"
              placeholder={picked.flatCost === null ? "" : picked.flatCost.toFixed(2)}
              value={fixedPostage}
              onChange={(e) => onFixedPostage(e.target.value)}
            />
          </span>
          <small>
            For this listing only — your &ldquo;{picked.name}&rdquo; policy is untouched. Leave
            blank to use its own rate
            {picked.flatCost === null ? "" : ` of $${picked.flatCost.toFixed(2)}`}.
          </small>
        </label>
      )}

      {picked !== null && picked.costType === "calculated" && fixedPostage.trim() !== "" && (
        <p className="lm-relist-warn" role="note">
          A fixed amount can&rsquo;t be applied to a calculated policy — eBay quotes that from the
          buyer&rsquo;s address. Pick a flat-rate policy to set your own figure.
        </p>
      )}

      {/* Ending a listing costs its watchers and its search age. Doing that to
          land on the postage it already had is a bad trade worth reconsidering. */}
      {noChange && (
        <p className="lm-relist-warn" role="note">
          That policy charges the buyer the same as the current one, so the relist wouldn&rsquo;t
          change anything about postage.
        </p>
      )}

      {after && before && (
        <div className="lm-shipping-net">
          <span className="sold-fig">
            <em>Net now</em>
            {before.net === null ? <span className="sold-unknown">—</span> : `$${before.net.toFixed(2)}`}
          </span>
          <span className="sold-fig">
            <em>Net after</em>
            {after.net === null ? <span className="sold-unknown">—</span> : `$${after.net.toFixed(2)}`}
          </span>
          {before.net !== null && after.net !== null && (
            <span
              className={`sold-fig profit${after.net < before.net ? " loss" : ""}`}
            >
              <em>Difference</em>
              {after.net - before.net < 0 ? "−" : "+"}$
              {Math.abs(after.net - before.net).toFixed(2)}
            </span>
          )}
        </div>
      )}
      {after && <p className="ce-hint">{after.note}</p>}
      {picked?.free && postageAfter === null && (
        <p className="ce-hint">
          This listing has no flat postage figure on eBay, so the cost of the label you&rsquo;d be
          absorbing can&rsquo;t be estimated here.
        </p>
      )}
    </div>
  );
}

function EndRelistPanel({
  listing,
  onEnded,
  onRelisted,
}: {
  listing: SellerListing;
  onEnded: (itemId: string) => void;
  onRelisted: (
    itemId: string,
    listingId: string,
    price: number | null,
    /** The arrangement the relist moved to, so the row stops showing the old one. */
    shipping?: { shipping: ShippingArrangement; shippingCost: number | null }
  ) => void;
}) {
  const [mode, setMode] = useState<"relist" | "end">("relist");
  const [price, setPrice] = useState("");
  const [editContent, setEditContent] = useState(false);
  // "" means keep the offer's current policy — the default, because a relist is
  // destructive enough without a shipping change nobody asked for.
  const [policyId, setPolicyId] = useState("");
  // The dollar amount the buyer is charged for this one listing. Blank means
  // "use the policy's own rate".
  const [fixedPostage, setFixedPostage] = useState("");
  const [editShipping, setEditShipping] = useState(false);
  const { policies, failed: policiesFailed } = useShippingPolicies(editShipping);
  const { content, loading: contentLoading } = useContent(listing.sku, editContent);
  const [draft, setDraft] = useState<Content | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [stranded, setStranded] = useState<string | null>(null);
  const [done, setDone] = useState<{ listingId?: string; price?: number | null } | null>(null);

  const advice = relistAdvice(listing);

  useEffect(() => {
    if (content && draft === null) setDraft(content);
  }, [content, draft]);

  const run = async () => {
    if (!confirmed || state === "working") return;
    setState("working");
    setError(null);
    setStranded(null);
    try {
      // Content only travels when the seller actually opened the editor and
      // changed something — sending the unchanged text back would be a pointless
      // extra write on a listing that is already down.
      const edited =
        mode === "relist" && editContent && draft && content
          ? {
              ...(draft.title !== content.title ? { title: draft.title } : {}),
              ...(draft.description !== content.description
                ? { description: draft.description }
                : {}),
            }
          : {};
      const res = await apiPost("/api/ebay/relist", {
        sku: listing.sku,
        action: mode,
        confirm: true,
        ...(mode === "relist" && price.trim() !== "" ? { price: price.trim() } : {}),
        ...(mode === "relist" && editShipping && policyId ? { fulfillmentPolicyId: policyId } : {}),
        ...(mode === "relist" && editShipping && fixedPostage.trim() !== ""
          ? { fixedPostage: fixedPostage.trim() }
          : {}),
        ...edited,
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        listingId?: string;
        price?: number | null;
        strandedOffer?: string;
      };
      // A stranded offer is a failure the seller must see even though the
      // request "completed" — the item is off the market.
      if (data.strandedOffer) {
        setStranded(data.strandedOffer);
        setError(data.error ?? "The listing was ended but couldn't be republished.");
        setState("error");
        onEnded(listing.itemId);
        return;
      }
      if (!data.ok) throw new Error(data.error || "eBay refused.");
      setDone({ listingId: data.listingId, price: data.price });
      setState("done");
      if (mode === "relist" && data.listingId) {
        // The row's shipping chip is stale the moment a policy changed, and a
        // confirmation sitting above "Buyer pays $8.10" reads as if the switch
        // to free postage didn't take. Only sent when a policy was actually
        // applied and we know what it does.
        const movedTo =
          editShipping && policyId && policies
            ? policies.find((p) => p.id === policyId)
            : undefined;
        onRelisted(
          listing.itemId,
          data.listingId,
          data.price ?? null,
          movedTo
            ? {
                shipping: movedTo.free ? "free" : "flat",
                shippingCost: movedTo.free ? 0 : listing.shippingCost,
              }
            : undefined
        );
      } else {
        onEnded(listing.itemId);
      }
      // A partial success still carries eBay's words (e.g. relisted, but at the
      // old price because the new one was refused).
      if (data.error) setError(data.error);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <p className="lm-relist-done">
        {done?.listingId ? (
          <>
            ✓ Relisted as <strong>#{done.listingId}</strong>
            {done.price != null && <> at ${done.price.toFixed(2)}</>}. The old listing is ended.
            {error && <span className="lm-relist-caveat"> {error}</span>}
          </>
        ) : (
          <>✓ Listing ended. It&rsquo;s no longer for sale.</>
        )}
      </p>
    );
  }

  return (
    <details className="lm-relist">
      <summary>⏹ End or relist</summary>
      <div className="lm-relist-body">
        {advice.discourage && (
          <p className="lm-relist-warn" role="note">
            ⚠️ {advice.warning}
          </p>
        )}

        <div className="lm-relist-modes">
          <label>
            <input
              type="radio"
              name={`mode-${listing.itemId}`}
              checked={mode === "relist"}
              onChange={() => {
                setMode("relist");
                setConfirmed(false);
              }}
            />
            End and relist fresh
          </label>
          <label>
            <input
              type="radio"
              name={`mode-${listing.itemId}`}
              checked={mode === "end"}
              onChange={() => {
                setMode("end");
                setConfirmed(false);
              }}
            />
            Just end it
          </label>
        </div>

        {mode === "relist" && (
          <>
            <label className="lm-relist-price">
              New price (optional)
              <span aria-hidden="true">$</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder={listing.price === null ? "" : String(listing.price)}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <small>Leave blank to relist at the same price.</small>
            </label>

            <label className="lm-relist-confirm">
              <input
                type="checkbox"
                checked={editShipping}
                onChange={(e) => {
                  setEditShipping(e.target.checked);
                  if (!e.target.checked) {
                    setPolicyId("");
                    setFixedPostage("");
                  }
                }}
              />
              Also change how postage is arranged
            </label>

            {editShipping && (
              <ShippingChoiceFields
                listing={listing}
                policies={policies}
                failed={policiesFailed}
                policyId={policyId}
                onChange={setPolicyId}
                fixedPostage={fixedPostage}
                onFixedPostage={setFixedPostage}
                price={price.trim() !== "" ? Number(price) : listing.price}
              />
            )}

            <label className="lm-relist-confirm">
              <input
                type="checkbox"
                checked={editContent}
                onChange={(e) => setEditContent(e.target.checked)}
              />
              Also rewrite the title and description
            </label>

            {editContent && (
              <div className="lm-relist-content">
                {contentLoading && !content && (
                  <p className="ce-hint">
                    <span className="spinner" aria-hidden="true" /> Reading the current wording…
                  </p>
                )}
                {draft && (
                  <>
                    {/* The reason to bother: a relist is the moment a bad title
                        is worth fixing, since the new listing gets re-indexed
                        from scratch under whatever keywords it carries. */}
                    <p className="ce-hint">
                      The new listing is indexed from scratch, so this is the moment a weak title
                      is worth rewriting. Leave it alone to carry the current wording over.
                    </p>
                    <ContentFields
                      value={draft}
                      onChange={setDraft}
                      disabled={state === "working"}
                      idPrefix={`relist-${listing.itemId}`}
                    />
                  </>
                )}
              </div>
            )}
          </>
        )}

        <p className="lm-relist-explain">
          {mode === "relist" ? (
            <>
              Ends <strong>#{listing.itemId}</strong> and immediately puts it back up as a{" "}
              <strong>new listing with a new item number</strong>. Photos, description and
              specifics carry over. Watchers, and whatever search standing the old listing had, do
              not.
            </>
          ) : (
            <>
              Ends <strong>#{listing.itemId}</strong>. The item stops being for sale. The listing
              content is kept, so it can be relisted later.
            </>
          )}
        </p>

        <label className="lm-relist-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I understand this can&rsquo;t be undone.
        </label>

        {stranded && (
          <p className="note note-error" role="alert">
            <strong>The listing is ended and is not for sale.</strong> eBay refused to publish the
            replacement, so nothing went back up. The listing content is safe in offer{" "}
            <code>{stranded}</code> — retry the relist, or publish it from Seller Hub.
          </p>
        )}
        {error && !stranded && <p className="lm-err">{error}</p>}

        <button
          type="button"
          className="btn-ghost lm-relist-go"
          disabled={!confirmed || state === "working"}
          onClick={run}
        >
          {state === "working"
            ? mode === "relist"
              ? "Relisting…"
              : "Ending…"
            : mode === "relist"
              ? "End and relist"
              : "End listing"}
        </button>
      </div>
    </details>
  );
}

/**
 * Which listings can take an offer, right now, at the top of the page.
 *
 * This used to be a single sentence at the very bottom saying "N listings can
 * take an offer — look for Send an offer on those rows", which is only useful
 * if you already know which rows those are. On a page of a hundred listings it
 * meant scrolling to the end, reading a number, then scrolling back up hunting
 * for a control that appears on a handful of rows and nowhere else.
 *
 * eBay decides eligibility and it changes daily, so the answer is worth putting
 * where it is read first — and worth making clickable, since the only thing a
 * seller wants to do with it is go to the listing.
 */
function OfferBanner({
  eligible,
  eligibleCount,
  onJump,
}: {
  /** Eligible listings on THIS page, in display order. */
  eligible: SellerListing[];
  /** eBay's account-wide count, which can exceed what this page holds. */
  eligibleCount: number;
  onJump: (itemId: string) => void;
}) {
  if (eligibleCount === 0) {
    return (
      <p className="lm-offer-status">
        💌 <strong>No listings can take an offer right now.</strong> eBay only allows one on a
        listing someone has recently watched or carted and that hasn&rsquo;t just had one — eBay
        decides that, not this app.
      </p>
    );
  }

  // Eligibility is account-wide but the rows are one page, so the two numbers
  // genuinely differ. Saying only "12 eligible" while showing three would read
  // as a bug.
  const elsewhere = Math.max(0, eligibleCount - eligible.length);

  return (
    <div className="lm-offer-status lm-offer-banner">
      <p className="lm-offer-banner-head">
        💌 <strong>{eligibleCount}</strong> listing{eligibleCount === 1 ? "" : "s"} can take an
        offer right now
        {eligible.length > 0 && <> — jump straight to {eligible.length === 1 ? "it" : "them"}:</>}
      </p>

      {eligible.length > 0 && (
        <ul className="lm-offer-jumps">
          {eligible.map((l) => (
            <li key={l.itemId}>
              <button type="button" className="lm-offer-jump" onClick={() => onJump(l.itemId)}>
                <span className="lm-offer-jump-title">{l.title}</span>
                <span className="lm-offer-jump-meta">
                  {l.watchCount ? `${l.watchCount} watching` : "eligible"}
                  {l.price !== null && <> · {money(l.price, l.currency)}</>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {elsewhere > 0 && (
        <p className="lm-offer-elsewhere">
          {elsewhere} more {elsewhere === 1 ? "is" : "are"} eligible on another page of your
          listings.
        </p>
      )}
    </div>
  );
}

export function ListingsManager() {
  const [data, setData] = useState<ListingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  // Sorting by what needs attention is opt-in. eBay's own order (ending
  // soonest) is what a seller expects on arrival, and silently reordering
  // someone's inventory is disorienting.
  const [sortStuck, setSortStuck] = useState(false);
  // The listing the offer banner was last asked to jump to.
  const [focusOffer, setFocusOffer] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await apiGet(`/api/ebay/listings?page=${p}`);
      const json = (await res.json()) as ListingsResponse;
      setData(json);
    } catch (e) {
      setData({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [load, page]);

  const applyPrice = (itemId: string, price: number) => {
    setData((d) =>
      d?.listings
        ? { ...d, listings: d.listings.map((l) => (l.itemId === itemId ? { ...l, price } : l)) }
        : d
    );
  };

  // An ended listing stays on screen, marked and dimmed, rather than vanishing.
  // Removing the row would take the confirmation with it and leave the seller
  // guessing whether the click worked. The next refresh clears it for real.
  const applyEnded = (itemId: string) => {
    setData((d) =>
      d?.listings
        ? {
            ...d,
            listings: d.listings.map((l) => (l.itemId === itemId ? { ...l, ended: true } : l)),
          }
        : d
    );
  };

  // A relist is a different listing with a different id, and its stats start at
  // zero. Re-pointing the row rather than mutating it in place keeps the view
  // honest: showing the old watcher and view counts against a listing that just
  // started would misreport it as instantly popular.
  const applyRelisted = (
    itemId: string,
    listingId: string,
    price: number | null,
    shipping?: { shipping: ShippingArrangement; shippingCost: number | null }
  ) => {
    setData((d) =>
      d?.listings
        ? {
            ...d,
            listings: d.listings.map((l) =>
              l.itemId === itemId
                ? {
                    ...l,
                    itemId: listingId,
                    price: price ?? l.price,
                    viewUrl: `https://www.ebay.com/itm/${listingId}`,
                    startTime: new Date().toISOString(),
                    watchCount: 0,
                    views: 0,
                    impressions: 0,
                    quantitySold: 0,
                    offerEligible: false,
                    ...(shipping ?? {}),
                  }
                : l
            ),
          }
        : d
    );
  };

  // A revised title has to show on the row immediately; leaving the old one
  // there would read as though the save hadn't taken.
  const applyContent = (itemId: string, content: Content) => {
    setData((d) =>
      d?.listings
        ? {
            ...d,
            listings: d.listings.map((l) =>
              l.itemId === itemId ? { ...l, title: content.title } : l
            ),
          }
        : d
    );
  };

  const applyCost = (itemId: string, cost: number | null) => {
    setData((d) =>
      d?.listings
        ? {
            ...d,
            listings: d.listings.map((l) => (l.itemId === itemId ? { ...l, cost } : l)),
          }
        : d
    );
  };

  // Judged once per render pass and carried with the row, so the sort and the
  // badge can never disagree about a listing.
  const judged = (data?.listings ?? []).map((l) => ({
    listing: l,
    triage: triageListing({
      startTime: l.startTime ?? "",
      impressions: l.impressions ?? null,
      views: l.views ?? null,
      watchCount: l.watchCount,
      quantitySold: l.quantitySold,
    }),
  }));

  const filtered = judged.filter(({ listing: l }) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q);
  });

  const listings = sortStuck
    ? [...filtered].sort((a, b) => b.triage.priority - a.triage.priority)
    : filtered;

  const stuckCount = filtered.filter((j) => j.triage.priority > 0).length;

  // Eligible rows on this page, in the order they're displayed — the banner
  // links have to match what the eye will find when it gets there.
  const eligible = (data?.listings ?? []).filter((l) => l.sku && l.offerEligible && !l.ended);

  /**
   * Go to a listing's offer form.
   *
   * Clears the filter first when it would hide the target: a link that silently
   * does nothing because a filter is active is worse than no link.
   */
  const jumpToOffer = (itemId: string) => {
    const hidden = !listings.some(({ listing: l }) => l.itemId === itemId);
    if (hidden) setFilter("");
    setFocusOffer(itemId);
  };

  // Scroll after the row has actually rendered — doing it in the click handler
  // would run before a cleared filter has put the row back on screen.
  useEffect(() => {
    if (!focusOffer) return;
    const el = document.getElementById(`listing-${focusOffer}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusOffer, listings.length]);

  return (
    <section className="panel">
      <div className="result-head">
        <h3>Your live eBay listings</h3>
        <span className="badge">
          {data?.totalItems !== undefined ? `${data.totalItems} active` : "—"}
        </span>
      </div>

      <p className="lm-intro">
        Listings this app posted are managed by eBay&rsquo;s Inventory API, which is why Seller
        Hub&rsquo;s quick-edit pencil is greyed out on them. Prices change here instead.
      </p>

      {/* Above the fold, not below a hundred rows. An offer is time-limited and
          eBay's eligibility changes daily, so this is the thing most worth
          acting on when the page loads. */}
      {data?.ok && data.offers?.eligibleCount !== undefined && !data.offers.unavailable && (
        <OfferBanner
          eligible={eligible}
          eligibleCount={data.offers.eligibleCount}
          onJump={jumpToOffer}
        />
      )}

      {data?.traffic?.unavailable && (
        <div className="note note-warn">
          <p style={{ margin: 0 }}>{data.traffic.unavailable}</p>
          {data.traffic.debug != null && (
            <details className="ebay-debug lm-traffic-debug">
              <summary>What eBay actually returned</summary>
              <pre className="ebay-debug-raw">{JSON.stringify(data.traffic.debug, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {data && !data.ok && (
        <p className="note note-error" role="alert">
          {data.error}
        </p>
      )}

      {data?.offers?.unavailable && (
        <div className="note note-warn">
          <p style={{ margin: 0 }}>{data.offers.unavailable}</p>
          {data.offers.debug != null && (
            <details className="ebay-debug lm-traffic-debug">
              <summary>What eBay actually returned</summary>
              <pre className="ebay-debug-raw">{JSON.stringify(data.offers.debug, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      <div className="lm-toolbar">
        <input
          type="text"
          className="lm-filter"
          placeholder="Filter by title or SKU…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className={`btn-ghost${sortStuck ? " active" : ""}`}
          onClick={() => setSortStuck((v) => !v)}
          disabled={stuckCount === 0}
          title={
            stuckCount === 0
              ? "Nothing on this page looks stuck"
              : "Bring the listings worth acting on to the top"
          }
        >
          {sortStuck ? "✓ Needs attention first" : `⚠ Needs attention (${stuckCount})`}
        </button>
        <button type="button" className="btn-ghost" onClick={() => load(page)} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {data?.ok && judged.length > 0 && (
        <p className="lm-triage-summary">{triageSummary(judged.map((j) => j.triage))}</p>
      )}

      {loading && !data && (
        <div className="loading-card">
          <span className="spinner" aria-hidden="true" />
          <span>Asking eBay for your active listings…</span>
        </div>
      )}

      {data?.ok && listings.length === 0 && !loading && (
        <p className="ebay-empty">
          {filter ? "Nothing matches that filter." : "No active listings on this account."}
        </p>
      )}

      <div className="lm-rows">
        {listings.map(({ listing: l, triage }) => (
          // Keyed by SKU, not item id: a relist gives the listing a NEW item
          // id, and keying on that would unmount the row mid-action and throw
          // away the confirmation the seller needs to read.
          <article
            id={`listing-${l.itemId}`}
            className={`lm-row${l.ended ? " ended" : ""}${
              focusOffer === l.itemId ? " focused" : ""
            }`}
            key={l.sku || `item:${l.itemId}`}
          >
            {l.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="lm-thumb" src={l.imageUrl} alt="" />
            ) : (
              <div className="lm-thumb placeholder" />
            )}

            <div className="lm-main">
              <a className="lm-title" href={l.viewUrl} target="_blank" rel="noreferrer noopener">
                {l.title}
              </a>
              <div className="lm-meta">
                {l.sku && <span className="sku-tag">{l.sku}</span>}
                <span>#{l.itemId}</span>
                <ShippingBadge listing={l} />
                {triage.priority > 0 && (
                  <span className={`lm-triage lm-triage-${triage.verdict}`} title={triage.evidence}>
                    {triage.headline}
                  </span>
                )}
                {l.bestOfferEnabled && <span className="lm-tag">Best Offer on</span>}
                {!l.sku && (
                  <span className="lm-tag warn" title="Without a SKU there's no offer to look up">
                    no SKU — edit in Seller Hub
                  </span>
                )}
              </div>
            </div>

            <dl className="lm-stats">
              <div>
                <dt>Watchers</dt>
                <dd>{stat(l.watchCount)}</dd>
              </div>
              <div>
                <dt>Views</dt>
                <dd>{stat(l.views)}</dd>
              </div>
              <div>
                <dt>Impressions</dt>
                <dd>{stat(l.impressions)}</dd>
              </div>
              <div>
                <dt>Sold</dt>
                <dd>
                  {stat(l.quantitySold)}
                  {l.quantity !== null && <small> of {l.quantity}</small>}
                </dd>
              </div>
            </dl>

            {l.sku && !l.ended ? (
              <PriceEditor listing={l} onSaved={(p) => applyPrice(l.itemId, p)} />
            ) : (
              <div className="lm-price">
                <span className="lm-price-static">{money(l.price, l.currency)}</span>
                <span className="lm-net approx">
                  {netAtPrice(l.price ?? 0, l.shipping, l.shippingCost ?? 0).label}
                </span>
                {l.cost !== null && l.cost !== undefined && (l.price ?? 0) > 0 && (
                  <ProfitLine
                    price={l.price ?? 0}
                    cost={l.cost}
                    shipping={l.shipping}
                    shippingCost={l.shippingCost}
                  />
                )}
              </div>
            )}

            {/* Cost is recordable on every listing, SKU or not — it's a note on
                the item, not an edit to the offer. */}
            <CostEditor listing={l} onSaved={(c) => applyCost(l.itemId, c)} />

            {/* The evidence, spelled out. A verdict the seller can't check is
                one they have to take on faith, and this one costs money to act
                on. */}
            {triage.priority > 0 && !l.ended && (
              <p className="lm-triage-note">
                <strong>{triage.evidence}</strong> {triage.suggestion}
              </p>
            )}

            {/* Full width, below the row. Squeezed into the price column the
                open form stretched the row to three times its height and left
                everything else stranded in the middle of it. */}
            {l.sku && l.offerEligible && !l.ended && (
              <OfferPanel listing={l} autoOpen={focusOffer === l.itemId} />
            )}

            {/* Editing in place keeps the watchers and the search history, so
                it sits ABOVE the relist control and is reached first. */}
            {l.sku && !l.ended && (
              <ContentEditor sku={l.sku} onSaved={(c) => applyContent(l.itemId, c)} />
            )}

            {/* Last in the row, and folded away. Ending a listing is the one
                action here that destroys something. */}
            {l.sku && (
              <EndRelistPanel
                listing={l}
                onEnded={applyEnded}
                onRelisted={applyRelisted}
              />
            )}
          </article>
        ))}
      </div>

      {data?.ok && (data.totalPages ?? 1) > 1 && (
        <div className="lm-pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Previous
          </button>
          <span>
            Page {data.page} of {data.totalPages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= (data.totalPages ?? 1) || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}

      <p className="footnote">
        Views and impressions cover the last {data?.traffic?.windowDays ?? 30} days. Watch counts
        are live. Changing a price here updates the listing on eBay immediately — the figure shown
        after saving is what eBay reports back, not what was typed.
      </p>
    </section>
  );
}
