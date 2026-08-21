"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { netAtPrice, type ShippingArrangement } from "@/lib/fees";
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
function OfferPanel({ listing }: { listing: SellerListing }) {
  const [percent, setPercent] = useState(String(MIN_DISCOUNT_PERCENT * 2));
  const [message, setMessage] = useState("");
  const [days, setDays] = useState<number>(OFFER_DURATION_DAYS[OFFER_DURATION_DAYS.length - 1]);
  const [counter, setCounter] = useState(true);
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
        allowCounterOffer: counter,
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
    <details className="lm-offer">
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

        <label className="lm-offer-counter">
          <input type="checkbox" checked={counter} onChange={(e) => setCounter(e.target.checked)} />
          <span>Let buyers counter-offer</span>
        </label>

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
      {state === "saved" && <span className="lm-ok">✓ Live on eBay</span>}
      {error && <span className="lm-err">{error}</span>}
    </div>
  );
}

export function ListingsManager() {
  const [data, setData] = useState<ListingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");

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

  const listings = (data?.listings ?? []).filter((l) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q);
  });

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
        <button type="button" className="btn-ghost" onClick={() => load(page)} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

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
        {listings.map((l) => (
          <article className="lm-row" key={l.itemId}>
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

            {l.sku ? (
              <PriceEditor listing={l} onSaved={(p) => applyPrice(l.itemId, p)} />
            ) : (
              <div className="lm-price">
                <span className="lm-price-static">{money(l.price, l.currency)}</span>
                <span className="lm-net approx">
                  {netAtPrice(l.price ?? 0, l.shipping, l.shippingCost ?? 0).label}
                </span>
              </div>
            )}

            {/* Full width, below the row. Squeezed into the price column the
                open form stretched the row to three times its height and left
                everything else stranded in the middle of it. */}
            {l.sku && l.offerEligible && <OfferPanel listing={l} />}
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

      {/* Say something about offers even when none are available.
          Previously the eligible count only rendered above zero and the "Send
          an offer" control only appears on eligible rows, so an account with
          nothing eligible saw no mention of the feature anywhere and could
          only conclude it hadn't shipped. */}
      {data?.ok && data.offers?.eligibleCount !== undefined && !data.offers.unavailable && (
        <p className="lm-offer-status">
          {data.offers.eligibleCount > 0 ? (
            <>
              💌 <strong>{data.offers.eligibleCount}</strong> listing
              {data.offers.eligibleCount === 1 ? "" : "s"} can take an offer right now — look for{" "}
              <strong>Send an offer</strong> on those rows.
            </>
          ) : (
            <>
              💌 <strong>No listings can take an offer right now.</strong> eBay only allows one on a
              listing someone has recently watched or carted and that hasn&rsquo;t just had one, so
              the <strong>Send an offer</strong> control appears on those rows when it applies —
              eBay decides that, not this app.
            </>
          )}
        </p>
      )}

      <p className="footnote">
        Views and impressions cover the last {data?.traffic?.windowDays ?? 30} days. Watch counts
        are live. Changing a price here updates the listing on eBay immediately — the figure shown
        after saving is what eBay reports back, not what was typed.
      </p>
    </section>
  );
}
