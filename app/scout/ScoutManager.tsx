"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { resizeImage } from "@/lib/resize";
import { CameraCapture } from "../CameraCapture";
import { CompsDialog } from "../CompsDialog";
import {
  DEFAULT_SCOUT_SETTINGS,
  SCOUT_SETTINGS_KEY,
  chipLabel,
  chipTone,
  normalizeScoutSettings,
  scout,
  verdictLabel,
  type ScoutResult,
  type ScoutSettings,
} from "@/lib/scout";
import type { CompsSummary } from "@/lib/types";

// Should you buy this?
//
// Every other screen here starts once the item is already yours. This one runs
// earlier, in the aisle, one-handed, with someone waiting behind you — so the
// design constraints are different from the rest of the app:
//
//   • Two taps to an answer. Shoot, type the sticker price, decide.
//   • The verdict is a word and a colour before it is a table of numbers.
//   • It must be willing to say "I can't tell". A confident wrong answer here
//     is spent on an item that can't be returned.
//   • What you already checked stays on screen, because sourcing is comparative
//     — the question is rarely "is this good?" and usually "is this better than
//     the other thing I'm holding?"

interface Identification {
  title: string;
  brand: string;
  item_type: string;
  category: string;
  condition: string;
  condition_notes: string;
  weight_oz: number;
  identified: boolean;
  note: string;
}

interface ScoutResponse {
  ok: boolean;
  identification?: Identification;
  comps?: CompsSummary | null;
  compsError?: string | null;
  shipping?: number | null;
  shippingLabel?: string | null;
  shippingBox?: string | null;
  packedOz?: number;
  error?: string;
}

/** One item checked this trip. */
interface Checked {
  id: string;
  title: string;
  asking: number | null;
  verdict: ScoutResult["verdict"];
  profit: number | null;
  maxBuy: number | null;
  previewUrl?: string;
}

// A loss is "−$26.60", never "$-26.60". This screen shows negative numbers
// routinely — most things in a thrift store are not worth buying — so the sign
// has to read cleanly rather than colliding with the currency symbol.
const money = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const body = `$${Math.abs(v).toFixed(2)}`;
  return v < 0 ? `−${body}` : body;
};

const TRIP_KEY = "listing-writer:scout-trip";

export function ScoutManager() {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScoutResponse | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [asking, setAsking] = useState("");
  const [settings, setSettings] = useState<ScoutSettings>(DEFAULT_SCOUT_SETTINGS);
  const [trip, setTrip] = useState<Checked[]>([]);
  const [compsOpen, setCompsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  // Settings and the trip list are per-device and survive a reload — a phone
  // reclaiming the page mid-aisle shouldn't lose what you already checked.
  useEffect(() => {
    try {
      const s = localStorage.getItem(SCOUT_SETTINGS_KEY);
      if (s) setSettings(normalizeScoutSettings(JSON.parse(s)));
      const t = localStorage.getItem(TRIP_KEY);
      if (t) setTrip(JSON.parse(t));
    } catch {
      /* a corrupt or unavailable store just means defaults */
    }
  }, []);

  const saveSettings = (next: ScoutSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SCOUT_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* private mode — the setting still applies for this session */
    }
  };

  const saveTrip = (next: Checked[]) => {
    setTrip(next);
    try {
      localStorage.setItem(TRIP_KEY, JSON.stringify(next.slice(0, 40)));
    } catch {
      /* ditto */
    }
  };

  const check = useCallback(
    async (images: { mediaType: string; data: string }[], hint: string, thumb?: string) => {
      setBusy(images.length ? "Identifying…" : "Checking the market…");
      setError(null);
      setResult(null);
      setPreview(thumb ?? null);
      try {
        const res = await apiPost("/api/scout", { images, hint });
        const data = (await res.json().catch(() => ({}))) as ScoutResponse;
        if (!res.ok || !data.ok) {
          setError(data.error || "Couldn't check that item.");
          return;
        }
        setResult(data);
        setTitle(data.identification?.title ?? hint);
        // Jump straight to the price field: the photo is taken, the only thing
        // left is the number on the sticker.
        setTimeout(() => priceRef.current?.focus(), 50);
      } catch (e) {
        setError((e as Error).message || "Couldn't reach the server.");
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const onCapture = async (shots: { mediaType: string; data: string; previewUrl: string }[]) => {
    setCameraOpen(false);
    if (!shots.length) return;
    await check(
      shots.slice(0, 3).map((s) => ({ mediaType: s.mediaType, data: s.data })),
      "",
      shots[0].previewUrl
    );
  };

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy("Reading photo…");
    try {
      const resized = [];
      for (const f of Array.from(list).slice(0, 3)) resized.push(await resizeImage(f));
      await check(
        resized.map((r) => ({ mediaType: r.mediaType, data: r.data })),
        "",
        resized[0].previewUrl
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const askingNum = asking.trim() === "" ? null : parseFloat(asking);
  const band = useMemo(
    () => ({
      pricedCount: result?.comps?.pricedCount ?? 0,
      low: result?.comps?.low,
      median: result?.comps?.median,
      high: result?.comps?.high,
    }),
    [result]
  );
  const verdict = useMemo(
    () =>
      scout({
        band,
        shipping: result?.shipping ?? 0,
        asking: askingNum !== null && Number.isFinite(askingNum) ? askingNum : null,
        settings,
      }),
    [band, result?.shipping, askingNum, settings]
  );

  const keep = () => {
    if (!result) return;
    saveTrip([
      {
        id: `${Date.now()}`,
        title: title || result.identification?.title || "Item",
        asking: askingNum,
        verdict: verdict.verdict,
        profit: verdict.profit,
        maxBuy: verdict.maxBuy,
        previewUrl: preview ?? undefined,
      },
      ...trip,
    ]);
    reset();
  };

  const reset = () => {
    setResult(null);
    setPreview(null);
    setTitle("");
    setAsking("");
    setError(null);
  };

  return (
    <>
      <p className="lm-intro">
        Point it at something in a shop and find out what you can pay. Uses the same market data and
        fee maths as the rest of the app, run backwards.
      </p>

      {/* ── Capture ─────────────────────────────────────────────────────── */}
      {!result && !busy && (
        <section className="panel scout-start">
          <button
            type="button"
            className="btn btn-primary scout-shoot"
            onClick={() => setCameraOpen(true)}
          >
            📷 Scan an item
          </button>
          <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
            Choose a photo
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <form
            className="scout-typed"
            onSubmit={(e) => {
              e.preventDefault();
              const v = (new FormData(e.currentTarget).get("hint") as string) || "";
              if (v.trim()) void check([], v.trim());
            }}
          >
            <input
              name="hint"
              type="text"
              placeholder="…or type what it is"
              aria-label="Item name"
            />
            <button type="submit" className="btn-ghost">
              Check
            </button>
          </form>
        </section>
      )}

      {busy && (
        <p className="ebay-empty">
          <span className="spinner" aria-hidden="true" /> {busy}
        </p>
      )}

      {error && (
        <p className="note note-error" role="alert">
          {error}{" "}
          <button type="button" className="btn-ghost" onClick={reset}>
            Try again
          </button>
        </p>
      )}

      {/* ── The answer ──────────────────────────────────────────────────── */}
      {result && (
        <section className={`panel scout-result v-${chipTone(verdict)}`}>
          <div className="scout-head">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="scout-thumb" />
            )}
            <div className="scout-id">
              <input
                type="text"
                className="scout-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="What it is"
                placeholder="What is it?"
              />
              <span className="scout-meta">
                {result.identification?.condition_notes || result.identification?.condition}
                {result.shipping !== null && result.shipping !== undefined && (
                  <>
                    {" "}
                    · ships {money(result.shipping)}
                    {result.shippingBox ? ` (${result.shippingBox})` : ""}
                  </>
                )}
              </span>
              {title !== (result.identification?.title ?? "") && (
                <button
                  type="button"
                  className="btn-ghost scout-recheck"
                  onClick={() => void check([], title)}
                >
                  🔎 Re-check as &ldquo;{title.slice(0, 30)}
                  {title.length > 30 ? "…" : ""}&rdquo;
                </button>
              )}
            </div>
          </div>

          <div className="scout-verdict">
            <span className={`scout-chip v-${chipTone(verdict)}`}>{chipLabel(verdict)}</span>
            <p>{verdict.reason}</p>
          </div>

          {/* The number that matters in a shop, big enough to read at arm's
              length — and shown BEFORE the price field, since it's useful
              before you've even looked at the sticker. */}
          {verdict.maxBuy !== null && (
            <div className="scout-maxbuy">
              <span className="k">Pay up to</span>
              <strong>{money(verdict.maxBuy)}</strong>
            </div>
          )}

          <label className="scout-asking">
            <span>What do they want for it?</span>
            <div className="scout-asking-input">
              <span>$</span>
              <input
                ref={priceRef}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={asking}
                onChange={(e) => setAsking(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </label>

          {verdict.expectedSale !== null && (
            <div className="scout-maths">
              <span className="sold-fig">
                <em>Sells for</em>
                {money(verdict.expectedSale)}
              </span>
              <span className="sold-fig">
                <em>eBay fee</em>−{money(verdict.fee)}
              </span>
              <span className="sold-fig">
                <em>Postage</em>−{money(verdict.shipping)}
              </span>
              <span className="sold-fig">
                <em>You net</em>
                {money(verdict.net)}
              </span>
              {verdict.profit !== null && (
                <span className={`sold-fig profit${verdict.profit < 0 ? " loss" : ""}`}>
                  <em>Profit</em>
                  {money(verdict.profit)}
                  {verdict.roi !== null && <small> · {Math.round(verdict.roi * 100)}%</small>}
                </span>
              )}
            </div>
          )}

          {/* Where the estimate came from, and how much to trust it. */}
          <p className="scout-basis">
            {result.comps && result.comps.pricedCount ? (
              <>
                Based on{" "}
                <button type="button" className="btn-ghost" onClick={() => setCompsOpen(true)}>
                  {result.comps.pricedCount} live listings
                </button>{" "}
                ({money(result.comps.low)}–{money(result.comps.high)} delivered).{" "}
                {settings.basis === "low"
                  ? "Planned on the cheap end, since those are asking prices and the cheapest listings are the ones that actually sell."
                  : `Planned on the middle, cut by ${Math.round(settings.haircut * 100)}% because those are asking prices, not sale prices.`}
              </>
            ) : (
              result.compsError || "No market data for this one."
            )}
          </p>

          <div className="scout-actions">
            <button type="button" className="btn btn-primary" onClick={keep}>
              Save to trip
            </button>
            <button type="button" className="btn-ghost" onClick={reset}>
              Next item
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSettingsOpen((v) => !v)}
              aria-expanded={settingsOpen}
            >
              ⚙ Rules
            </button>
          </div>

          {settingsOpen && <RulesPanel settings={settings} onChange={saveSettings} />}
        </section>
      )}

      {/* ── This trip ───────────────────────────────────────────────────── */}
      {trip.length > 0 && (
        <section className="panel scout-trip">
          <h2>
            This trip · {trip.length} checked ·{" "}
            {trip.filter((t) => t.verdict === "buy").length} worth buying
          </h2>
          <div className="sold-rows">
            {trip.map((t) => (
              <div className={`scout-triprow v-${t.verdict}`} key={t.id}>
                {t.previewUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.previewUrl} alt="" />
                )}
                <div className="scout-row-what">
                  <strong>{t.title}</strong>
                  <span className="sold-meta">
                    {t.asking !== null ? `asking ${money(t.asking)}` : "no price"}
                    {t.maxBuy !== null && <> · pay up to {money(t.maxBuy)}</>}
                  </span>
                </div>
                <span className={`scout-chip small v-${t.verdict}`}>{verdictLabel(t.verdict)}</span>
                {/* A loss must not render in the profit green. Half this list is
                    negative by nature — most things in a shop aren't worth
                    buying — and colouring those as gains inverts the whole
                    point of skimming the list. */}
                <span
                  className={`sold-fig profit${t.profit !== null && t.profit < 0 ? " loss" : ""}`}
                >
                  {money(t.profit)}
                </span>
              </div>
            ))}
          </div>
          <button type="button" className="btn-ghost" onClick={() => saveTrip([])}>
            🗑 Clear trip
          </button>
        </section>
      )}

      {cameraOpen && (
        <CameraCapture onCapture={onCapture} onClose={() => setCameraOpen(false)} />
      )}
      {compsOpen && result?.comps && (
        // No recommendation and no "use this price" here: on this screen the
        // comps exist to be CHECKED, not to set a price. You're deciding
        // whether to buy, and the listing doesn't exist yet.
        <CompsDialog
          comps={result.comps}
          recommendation={null}
          currentPrice={verdict.expectedSale}
          onUse={() => {}}
          onClose={() => setCompsOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The thresholds a buy/skip verdict is measured against.
 *
 * Personal, and worth being explicit about rather than baking in: a full-time
 * reseller with storage and a shipping station takes deals a weekend seller
 * shouldn't touch.
 */
function RulesPanel({
  settings,
  onChange,
}: {
  settings: ScoutSettings;
  onChange: (s: ScoutSettings) => void;
}) {
  const set = (patch: Partial<ScoutSettings>) =>
    onChange(normalizeScoutSettings({ ...settings, ...patch }));

  return (
    <div className="scout-rules">
      <label>
        <span>Minimum profit</span>
        <input
          type="number"
          min="0"
          step="1"
          value={settings.minProfit}
          onChange={(e) => set({ minProfit: parseFloat(e.target.value) })}
        />
        <small>Below this, it isn&rsquo;t worth the listing time or the shelf space.</small>
      </label>
      <label>
        <span>Minimum return</span>
        <input
          type="number"
          min="0"
          step="10"
          value={Math.round(settings.minRoi * 100)}
          onChange={(e) => set({ minRoi: (parseFloat(e.target.value) || 0) / 100 })}
        />
        <small>Percent of what you pay. 100% means doubling your money.</small>
      </label>
      <label>
        <span>Plan on</span>
        <select
          value={settings.basis}
          onChange={(e) => set({ basis: e.target.value as ScoutSettings["basis"] })}
        >
          <option value="low">The low end (safer)</option>
          <option value="median">The middle of the market</option>
        </select>
        <small>
          Which end of the comp range to assume you&rsquo;ll actually get. The low end is already
          the conservative read.
        </small>
      </label>
      <label className={settings.basis === "low" ? "is-inactive" : undefined}>
        <span>Median discount</span>
        <input
          type="number"
          min="0"
          max="90"
          step="1"
          value={Math.round(settings.haircut * 100)}
          onChange={(e) => set({ haircut: (parseFloat(e.target.value) || 0) / 100 })}
        />
        <small>
          eBay only exposes ACTIVE listings — asking prices, since the ones priced right already
          sold and left.{" "}
          {settings.basis === "low"
            ? "Not in use: planning on the low end already corrects for that, and stacking both would double-count it."
            : "This discounts the median for that."}
        </small>
      </label>
    </div>
  );
}
