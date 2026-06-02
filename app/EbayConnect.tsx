"use client";

import { useCallback, useEffect, useState } from "react";

interface Status {
  configured: boolean;
  connected: boolean;
}

export function EbayConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

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
      await fetch("/api/ebay/disconnect", { method: "POST" });
      await refresh();
      setNotice({ ok: true, msg: "Disconnected from eBay." });
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
            Connect your eBay account to post listings
          </span>
          <a className="btn-ghost" href="/api/ebay/auth">
            Connect eBay
          </a>
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
