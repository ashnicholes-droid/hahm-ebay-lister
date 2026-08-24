"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";

// Where your parcels ship from.
//
// eBay quotes calculated shipping from the postal code on your inventory
// location, so a wrong one quotes every buyer from the wrong place — and the
// gap is real money in whichever direction it falls.
//
// This panel exists because the setting used to be an environment variable that
// was only read when the app had to CREATE a location. Any account that already
// had one ignored it entirely, so changing it did nothing and there was nowhere
// to see what was actually being used. Both halves are fixed here: the value is
// stored like the eBay connection, and the panel shows what eBay really has.

interface ShipFrom {
  ok: boolean;
  zip: string | null;
  envZip: string | null;
  effective: string | null;
  activeZip: string | null;
  currentZip: string | null;
  known: { key: string; zip: string | null }[];
  warning?: string;
}

export function ShipFromSettings() {
  const [data, setData] = useState<ShipFrom | null>(null);
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await apiGet("/api/settings/ship-from");
      const json = (await res.json()) as ShipFrom;
      setData(json);
      setValue(json.zip ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const res = await apiPost("/api/settings/ship-from", { zip: value.trim() });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error || "Couldn't save that.");
      setState("saved");
      // Re-read so the diagnostic below reflects the new choice rather than
      // the one it was showing a moment ago.
      await load();
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  if (!data) return null;

  const changed = value.trim() !== (data.zip ?? "");
  // The case worth shouting about: a ZIP is set, but no eBay location matches
  // it yet, so today's listings are still going out from somewhere else.
  const pending = data.effective !== null && data.activeZip === null;

  return (
    <section className="panel">
      <div className="result-head">
        <h3>Ship-from ZIP</h3>
      </div>

      <p className="lm-intro">
        eBay quotes <strong>calculated shipping</strong> from this postal code. Get it wrong and
        every buyer is quoted from the wrong place — you either overcharge them or absorb the
        difference. Free and flat-rate listings aren&rsquo;t affected.
      </p>

      <div className="sf-row">
        <label className="sf-field">
          <span className="ps-label">Your ZIP</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder={data.envZip ?? "19446"}
            value={value}
            maxLength={10}
            onChange={(e) => {
              setValue(e.target.value);
              setState("idle");
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!changed || state === "saving"}
          onClick={save}
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
      </div>

      {error && (
        <p className="lm-err" role="alert">
          {error}
        </p>
      )}
      {state === "saved" && !error && <p className="lm-ok">✓ Saved</p>}

      <p className="ce-hint">
        Stored the same way as your eBay connection — set once and it sticks on this browser.
        {data.envZip && !data.zip && (
          <>
            {" "}
            Currently falling back to <code>EBAY_LOCATION_POSTAL_CODE</code> ({data.envZip}).
          </>
        )}
      </p>

      {/* The diagnostic. Without it a seller has no way to tell whether the
          setting took, which is exactly how a wrong ZIP survives for months. */}
      <div className={`sf-status${pending ? " warn" : ""}`}>
        {pending ? (
          <>
            <p>
              ⚠️ New listings will ship from <strong>{data.effective}</strong>, but nothing on your
              eBay account uses that ZIP yet
              {data.currentZip && (
                <>
                  {" "}
                  — right now it ships from <strong>{data.currentZip}</strong>
                </>
              )}
              . The next publish creates the location and starts using it.
            </p>
            {/* The part people get caught by. eBay won't let a live listing's
                location be edited, so this fixes the future, not the past. */}
            <p className="ce-hint">
              Listings that are <strong>already live keep the ZIP they were published with</strong>
              . eBay doesn&rsquo;t allow an existing listing&rsquo;s location to be changed, so to
              move an old one you have to end and relist it from the seller view.
            </p>
          </>
        ) : data.activeZip ? (
          <p>
            ✓ Listings ship from <strong>{data.activeZip}</strong>.
          </p>
        ) : (
          <p>
            No eBay ship-from location yet. The next listing creates one for{" "}
            <strong>{data.effective ?? "your account's address"}</strong>.
          </p>
        )}

        {data.known.length > 0 && (
          <p className="ce-hint">
            eBay locations on your account:{" "}
            {data.known.map((k) => `${k.zip ?? "no ZIP"} (${k.key})`).join(", ")}
          </p>
        )}
        {data.warning && <p className="ce-hint">Couldn&rsquo;t read from eBay: {data.warning}</p>}
      </div>
    </section>
  );
}
