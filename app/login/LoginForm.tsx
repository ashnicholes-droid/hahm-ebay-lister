"use client";

import { useState } from "react";

// Only ever navigate to a path on this site. `next` arrives from the query
// string, so treating it as a URL would let a crafted link bounce someone off
// this login screen to an attacker's page that looks just like it.
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function LoginForm({ next }: { next?: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "That code didn't match.");
      }
      // Full navigation rather than a client-side route change: the session
      // cookie has to be attached to a fresh document request for middleware to
      // see it.
      window.location.href = safeNext(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="code">Access code</label>
      <input
        id="code"
        type="password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
        autoComplete="current-password"
        placeholder="The APP_SECRET you set in Vercel"
        disabled={busy}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Checking…
          </>
        ) : (
          "Unlock"
        )}
      </button>
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
