"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { FEE_FIXED, FEE_PERCENT } from "@/lib/fees";
import {
  byMonth,
  feeAccuracy,
  realize,
  summarize,
  type RealizableOrder,
} from "@/lib/realizedProfit";
import { SHIPPING_CARRIERS } from "@/lib/ebay/orders";

// What actually sold, and what you actually made.
//
// Every other screen in this app is about a listing that hasn't sold yet, and
// every profit number on those screens is a projection. This is the only screen
// built from facts: eBay's own per-order fee, the buyer's actual payment, and
// the cost recorded when the item was listed.
//
// The design rule throughout is that a number the app cannot know is shown as
// unknown, never as zero. An unrecorded cost silently treated as free would
// report the whole net as profit — flattering, wrong, and invisible.

interface SoldItem {
  lineItemId: string;
  legacyItemId: string;
  sku: string;
  title: string;
  quantity: number;
  itemCost: number | null;
  shippingCost: number | null;
}

interface Order extends RealizableOrder {
  legacyOrderId: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  buyerUsername: string;
  deliveryCost: number | null;
  feeBasis: number | null;
  dueSeller: number | null;
  items: SoldItem[];
  shipTo: {
    name: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    countryCode: string;
  } | null;
  shipByDate: string;
  shipped: boolean;
  /** Joined from the private note by the route. Null = never recorded. */
  cost: number | null;
  /** Some lines had a cost and some didn't — the total would be misleading. */
  costPartial?: boolean;
}

interface OrdersResponse {
  ok: boolean;
  orders?: Order[];
  windowDays?: number;
  costWindowDays?: number;
  warnings?: string[];
  error?: string;
}

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

const money = (v: number | null, currency = "USD") => {
  if (v === null || v === undefined) return "—";
  const symbol = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  const body = `${Math.abs(v).toFixed(2)}`;
  const signed = v < 0 ? `−${body}` : body;
  return symbol ? `${symbol}${signed}`.replace("$−", "−$") : `${signed} ${currency}`;
};

const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export function SoldManager() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [costWindowDays, setCostWindowDays] = useState<number | null>(null);

  const load = useCallback(async (window: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet(`/api/ebay/orders?days=${window}`);
      const data = (await res.json().catch(() => ({}))) as OrdersResponse;
      if (!res.ok || !data.ok) {
        setError(data.error || "Couldn't read your sales from eBay.");
        setOrders([]);
        return;
      }
      setOrders(data.orders ?? []);
      setWarnings(data.warnings ?? []);
      setCostWindowDays(data.costWindowDays ?? null);
    } catch (e) {
      setError((e as Error).message || "Couldn't reach eBay.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const costOf = useCallback((o: RealizableOrder) => (o as Order).cost ?? null, []);
  const summary = useMemo(() => summarize(orders, costOf), [orders, costOf]);
  const fees = useMemo(() => feeAccuracy(orders), [orders]);
  const months = useMemo(() => byMonth(orders), [orders]);
  const unshipped = useMemo(
    () => orders.filter((o) => !o.shipped && !o.cancelled && o.paymentStatus === "PAID"),
    [orders]
  );

  const onShipped = (orderId: string) =>
    setOrders((prev) =>
      prev.map((o) =>
        o.orderId === orderId ? { ...o, shipped: true, fulfillmentStatus: "FULFILLED" } : o
      )
    );

  return (
    <>
      <p className="lm-intro">
        Your completed sales, with eBay&rsquo;s <strong>actual</strong> fees rather than this
        app&rsquo;s estimate of them — and, where a cost was recorded when you listed the item, what
        you really made on it.
      </p>

      <div className="sold-windows" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            className={`btn-ghost${days === w.days ? " active" : ""}`}
            onClick={() => setDays(w.days)}
            disabled={loading}
          >
            {w.label}
          </button>
        ))}
        <button type="button" className="btn-ghost" onClick={() => void load(days)} disabled={loading}>
          ↻ Refresh
        </button>
      </div>

      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {warnings.map((w) => (
        <p className="note note-warn" key={w}>
          {w}
        </p>
      ))}

      {loading && (
        <p className="ebay-empty">
          <span className="spinner" aria-hidden="true" /> Reading your sales…
        </p>
      )}

      {!loading && !error && orders.length === 0 && (
        <p className="ebay-empty">No sales in this period.</p>
      )}

      {!loading && orders.length > 0 && (
        <>
          <SummaryStrip summary={summary} days={days} costWindowDays={costWindowDays} />
          <FeeCheck accuracy={fees} currency={summary.currency} />
          {unshipped.length > 0 && <ShipQueue orders={unshipped} onShipped={onShipped} />}

          {months.map((m) => (
            <section className="panel sold-month" key={m.key}>
              <h2>{m.label}</h2>
              <div className="sold-rows">
                {m.orders.map((o) => (
                  <OrderRow key={o.orderId} order={o} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}

function SummaryStrip({
  summary,
  days,
  costWindowDays,
}: {
  summary: ReturnType<typeof summarize>;
  days: number;
  costWindowDays: number | null;
}) {
  const c = summary.currency;
  return (
    <section className="panel sold-summary">
      <h2>Last {days} days</h2>
      <div className="sold-stats">
        <div className="stat">
          <span className="k">Sold</span>
          <span className="v">{summary.orders}</span>
        </div>
        <div className="stat">
          <span className="k">Buyers paid</span>
          <span className="v">{money(summary.gross, c)}</span>
        </div>
        <div className="stat">
          <span className="k">eBay fees</span>
          <span className="v">−{money(summary.fees, c).replace("−", "")}</span>
        </div>
        {summary.refunds > 0 && (
          <div className="stat">
            <span className="k">Refunds</span>
            <span className="v">−{money(summary.refunds, c).replace("−", "")}</span>
          </div>
        )}
        <div className="stat">
          <span className="k">Net to you</span>
          <span className="v price">{money(summary.net, c)}</span>
        </div>
        <div className="stat">
          <span className="k">Cost of goods</span>
          <span className="v">−{money(summary.cost, c).replace("−", "")}</span>
        </div>
        <div className={`stat${summary.profit < 0 ? " needs-attention" : ""}`}>
          <span className="k">Profit</span>
          <span className="v price">{money(summary.profit, c)}</span>
        </div>
        {summary.profitBasis > 0 && (
          <div className="stat">
            <span className="k">Margin</span>
            <span className="v">{percent(summary.profit / summary.profitBasis)}</span>
          </div>
        )}
      </div>

      {/* The honesty line. A profit total assembled from a subset has to say so,
          otherwise it reads as the whole picture and quietly understates. */}
      {!summary.complete && (
        <p className="sold-incomplete">
          {summary.unknownCost > 0 && (
            <>
              <strong>
                {summary.unknownCost} of {summary.orders}
              </strong>{" "}
              {summary.orders === 1 ? "sale" : "sales"}{" "}
              {summary.unknownCost === 1 ? "has" : "have"} no recorded cost, so profit excludes{" "}
              {summary.unknownCost === 1 ? "it" : "them"} — the real figure is higher than
              what&rsquo;s shown here.{" "}
              {costWindowDays !== null && (
                <>eBay only returns notes for the last {costWindowDays} days of sales. </>
              )}
              Record a cost on each listing before it sells and this becomes exact.
            </>
          )}
          {summary.pending > 0 && (
            <>
              {" "}
              {summary.pending} more {summary.pending === 1 ? "sale" : "sales"} (
              {money(summary.pendingGross, c)}){" "}
              {summary.pending === 1 ? "is" : "are"} too recent for eBay to have posted a fee, so{" "}
              {summary.pending === 1 ? "it isn't" : "they aren't"} in these totals yet.
            </>
          )}
          {summary.cancelled > 0 && (
            <>
              {" "}
              {summary.cancelled} cancelled {summary.cancelled === 1 ? "order is" : "orders are"}{" "}
              excluded.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * How well the app's fee model matches eBay's invoice.
 *
 * lib/fees.ts (13.25% + $0.40) sits underneath every recommended price, every
 * break-even, and every profit projection this app makes. Nothing had ever
 * checked it against reality. If the real rate is three points higher —
 * promoted listings and some categories will do that — then every marginal item
 * has been priced on a number that was wrong in the expensive direction.
 */
function FeeCheck({
  accuracy,
  currency,
}: {
  accuracy: ReturnType<typeof feeAccuracy>;
  currency: string;
}) {
  // Below a handful of orders this is noise, and a scary banner built on noise
  // is worse than no banner.
  if (accuracy.sampled < 3) return null;

  const estimatedPct = `${(FEE_PERCENT * 100).toFixed(2)}% + ${money(FEE_FIXED, currency)}`;
  return (
    <section className={`panel sold-feecheck${accuracy.close ? "" : " off"}`}>
      <h2>Is the fee estimate right?</h2>
      <p>
        This app prices everything assuming eBay takes <strong>{estimatedPct}</strong> per order.
        Across {accuracy.sampled} sales it actually took{" "}
        <strong>{money(accuracy.actual, currency)}</strong> against an estimated{" "}
        {money(accuracy.estimated, currency)} — an effective rate of{" "}
        <strong>{percent(accuracy.impliedPercent)}</strong>.
      </p>
      {accuracy.close ? (
        <p className="sold-feecheck-verdict">
          Close enough — your suggested prices and break-evens are built on the right number.
        </p>
      ) : (
        <p className="sold-feecheck-verdict">
          {accuracy.difference > 0 ? (
            <>
              eBay is taking <strong>{money(accuracy.difference, currency)} more</strong> than the
              app assumes. Every break-even and suggested price is optimistic by roughly that much —
              worth checking whether promoted listings or your category rate explains it.
            </>
          ) : (
            <>
              eBay is taking {money(Math.abs(accuracy.difference), currency)} less than the app
              assumes, so your prices are slightly conservative.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Orders waiting on tracking.
 *
 * At the top, for the same reason the offer banner is: the thing that needs
 * doing today should not be something you scroll to find.
 */
function ShipQueue({
  orders,
  onShipped,
}: {
  orders: Order[];
  onShipped: (orderId: string) => void;
}) {
  return (
    <section className="panel sold-ship">
      <h2>
        📦 {orders.length} {orders.length === 1 ? "order needs" : "orders need"} shipping
      </h2>
      <div className="sold-rows">
        {orders.map((o) => (
          <ShipRow key={o.orderId} order={o} onShipped={() => onShipped(o.orderId)} />
        ))}
      </div>
    </section>
  );
}

function ShipRow({ order, onShipped }: { order: Order; onShipped: () => void }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState<string>(SHIPPING_CARRIERS[0].code);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiPost("/api/ebay/orders", {
        orderId: order.orderId,
        trackingNumber: tracking,
        carrier,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErr(data.error || "eBay wouldn't accept that tracking number.");
        return;
      }
      onShipped();
    } catch (e) {
      setErr((e as Error).message || "Couldn't reach eBay.");
    } finally {
      setBusy(false);
    }
  };

  const to = order.shipTo;
  return (
    <div className="sold-shiprow">
      <div className="sold-shiprow-what">
        <strong>{order.items[0]?.title || `Order ${order.legacyOrderId}`}</strong>
        <span className="sold-meta">
          {to ? `${to.name} · ${to.city}, ${to.stateOrProvince} ${to.postalCode}` : "No address"}
          {order.shipByDate && <> · ship by {shortDate(order.shipByDate)}</>}
        </span>
      </div>
      <div className="sold-shiprow-do">
        <select
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          aria-label="Carrier"
          disabled={busy}
        >
          {SHIPPING_CARRIERS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="sold-tracking"
          placeholder="Tracking number"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          aria-label="Tracking number"
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void send()}
          disabled={busy || !tracking.trim()}
        >
          {busy ? "Sending…" : "Mark shipped"}
        </button>
      </div>
      {err && (
        <p className="lm-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function OrderRow({ order }: { order: Order }) {
  const r = realize(order, order.cost);
  const c = order.currency;
  const item = order.items[0];

  return (
    <div className={`sold-row${order.cancelled ? " cancelled" : ""}`}>
      <div className="sold-row-what">
        <strong>{item?.title || `Order ${order.legacyOrderId}`}</strong>
        <span className="sold-meta">
          {shortDate(order.creationDate)}
          {item?.sku && <> · {item.sku}</>}
          {order.items.length > 1 && <> · {order.items.length} items</>}
          {order.buyerUsername && <> · {order.buyerUsername}</>}
          {order.cancelled && <> · cancelled</>}
          {!order.shipped && !order.cancelled && <> · not yet shipped</>}
        </span>
      </div>

      <div className="sold-row-money">
        <span className="sold-fig">
          <em>Paid</em>
          {money(order.buyerPaid, c)}
        </span>
        <span className="sold-fig">
          <em>eBay fee</em>
          {order.marketplaceFee === null ? (
            <span className="sold-unknown" title="eBay hasn't posted a fee for this order yet">
              pending
            </span>
          ) : (
            `−${money(order.marketplaceFee, c).replace("−", "")}`
          )}
        </span>
        {order.refunded > 0 && (
          <span className="sold-fig">
            <em>Refunded</em>−{money(order.refunded, c).replace("−", "")}
          </span>
        )}
        <span className="sold-fig">
          <em>Net</em>
          {money(r.net, c)}
        </span>
        <span className="sold-fig">
          <em>Cost</em>
          {order.cost === null ? (
            <span className="sold-unknown" title="No cost was recorded on this listing">
              not recorded
            </span>
          ) : (
            money(order.cost, c)
          )}
        </span>
        <span className={`sold-fig profit${r.profit !== null && r.profit < 0 ? " loss" : ""}`}>
          <em>Profit</em>
          {r.profit === null ? (
            <span className="sold-unknown">—</span>
          ) : (
            <>
              {money(r.profit, c)}
              {r.margin !== null && <small> · {percent(r.margin)}</small>}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
