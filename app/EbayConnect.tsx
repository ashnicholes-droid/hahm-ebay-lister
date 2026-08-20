"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { EBAY_OPTIONAL_SCOPES, OPTIONAL_SCOPE_IDS } from "@/lib/ebay/scopes";

interface Status {
  configured: boolean;
  connected: boolean;
}

export function EbayConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  // Every optional permission is requested by default. They can be dropped
  // individually because eBay refuses the ENTIRE authorization if one of them
  // isn't available to your developer keyset — the whole request comes back
  // {"error_id":"invalid_scope"} and you can't connect at all.
  const [extras, setExtras] = useState<string[]>(OPTIONAL_SCOPE_IDS);
  const [showScopes, setShowScopes] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/ebay/status", { cache: "no-store" });
      setStatus((await r.json()) as Status);
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Surface the result of an OAuth round-trip (?ebay=connected|declined|error).
    const params = new URLSearchParams(window.location.search);
    const e = params.get("ebay");
    if (e === "connected") setNotice({ ok: true, msg: "eBay account connected!" });
    else if (e === "declined")
      setNotice({ ok: false, msg: "eBay connection was declined." });
    else if (e === "error")
      setNotice({ ok: false, msg: params.get("msg") || "eBay connection failed." });
    if (e) window.history.replaceState({}, "", window.location.pathname);
  }, [refresh]);

  const disconnect = async () => {
    setBusy(true);
    try {
      await apiPost("/api/ebay/disconnect", {});
      await refresh();
      setNotice({ ok: true, msg: "Disconnected from eBay." });
    } finally {
      setBusy(false);
    }
  };

  const startConnect = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await apiPost("/api/ebay/auth", { optionalScopes: extras });
      const data = (await r.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) throw new Error(data.error || "Couldn't start eBay authorization.");
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const finishConnect = async () => {
    if (!pasteValue.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await apiPost("/api/ebay/connect", { url: pasteValue.trim() });
      const data = (await r.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || "Couldn't connect.");
      setPasteValue("");
      await refresh();
      setNotice({ ok: true, msg: "eBay account connected!" });
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // If eBay isn't configured on the server, show nothing (the writing flow
  // still works fine without it).
  if (!status?.configured) return null;

  return (
    <div className={`ebay-bar${status.connected ? " connected" : ""}`}>
      <span className="ebay-dot" aria-hidden="true" />
      {status.connected ? (
        <>
          <span className="ebay-label">eBay account connected</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={disconnect}
            disabled={busy}
          >
            Disconnect
          </button>
        </>
      ) : (
        <>
          <span className="ebay-label">
            <strong>Step 1:</strong> authorize on eBay
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={startConnect}
            disabled={busy}
          >
            Open eBay ↗
          </button>

          <details
            className="ebay-scopes"
            open={showScopes}
            onToggle={(e) => setShowScopes((e.target as HTMLDetailsElement).open)}
          >
            <summary>
              {/* Counts the boxes below and nothing else. Folding the
                  always-on listing scopes into the total made two extras read
                  as "3 of 3", which is a count of something the list doesn't
                  show. */}
              Extra permissions ({extras.length} of {OPTIONAL_SCOPE_IDS.length})
              <small> — open this if eBay says invalid_scope</small>
            </summary>
            <p className="ebay-scopes-note">
              Listing always works. The extras below are separate eBay permissions, and{" "}
              <strong>
                eBay refuses the whole authorization if your developer keyset doesn&rsquo;t have one
                of them
              </strong>{" "}
              — that&rsquo;s what <code>invalid_scope</code> means. Untick them one at a time to
              find the culprit; everything else keeps working without it.
            </p>
            {EBAY_OPTIONAL_SCOPES.map((o) => (
              <label className="ebay-scope" key={o.id}>
                <input
                  type="checkbox"
                  checked={extras.includes(o.id)}
                  onChange={(e) =>
                    setExtras((prev) =>
                      e.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)
                    )
                  }
                />
                <span>
                  <strong>{o.label}</strong> — {o.enables}
                </span>
              </label>
            ))}
            <button
              type="button"
              className="btn-ghost ebay-scope-min"
              onClick={() => setExtras([])}
              disabled={extras.length === 0}
            >
              Just listing, no extras
            </button>
          </details>
          <div className="ebay-paste">
            <label htmlFor="ebay-paste">
              <strong>Step 2:</strong> after you click <em>Agree</em>, copy the
              URL from eBay&rsquo;s page and paste it here:
            </label>
            <div className="ebay-paste-row">
              <input
                id="ebay-paste"
                type="text"
                placeholder="https://auth2.ebay.com/oauth2/…?code=…"
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={finishConnect}
                disabled={busy || !pasteValue.trim()}
              >
                {busy ? "Connecting…" : "Finish connecting"}
              </button>
            </div>
          </div>
        </>
      )}
      {notice && (
        <span className={`ebay-notice${notice.ok ? "" : " err"}`}>
          {notice.msg}
        </span>
      )}
    </div>
  );
}
