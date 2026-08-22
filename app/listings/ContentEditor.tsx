"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { TITLE_MAX } from "@/lib/ebay/contentLimits";

// Editing what a live listing actually says.
//
// This closes a loop the app had left open: triage tells a seller "barely
// showing in search — fix the title keywords", and there was nowhere to do it.
//
// Editing in place rather than ending and relisting is the important default.
// A revision keeps the watchers and whatever search standing the listing has
// built up; a relist throws both away. Those are different tools for different
// problems, and the panel says so rather than leaving the seller to guess.

export interface Content {
  title: string;
  description: string;
}

/**
 * The shared title + description fields.
 *
 * Extracted because the relist panel needs exactly the same pair, and two
 * copies of an 80-character counter is two places for it to be wrong.
 */
export function ContentFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: Content;
  onChange: (next: Content) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const len = value.title.trim().length;
  const over = len > TITLE_MAX;

  return (
    <>
      <label className="ce-field">
        <span className="ce-label">
          Title
          {/* eBay rejects an over-long title at publish, so the count is shown
              always rather than only once it's a problem. */}
          <small className={over ? "ce-over" : len > TITLE_MAX - 10 ? "ce-near" : ""}>
            {len}/{TITLE_MAX}
          </small>
        </span>
        <input
          id={`${idPrefix}-title`}
          type="text"
          value={value.title}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>

      <label className="ce-field">
        <span className="ce-label">Description</span>
        <textarea
          id={`${idPrefix}-desc`}
          rows={6}
          value={value.description}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
        <small className="ce-hint">
          Plain text or simple HTML. This is what buyers read on the listing page.
        </small>
      </label>
    </>
  );
}

/**
 * Load a listing's current wording on demand.
 *
 * Not fetched with the listing list: it is two extra eBay calls per row, and on
 * a page of two hundred listings that would be four hundred requests to fill
 * fields nobody opened.
 */
export function useContent(sku: string, enabled: boolean) {
  const [content, setContent] = useState<Content | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the `loading` state, guards against a second fetch.
  //
  // Putting `loading` in the dependency array is the bug that looks correct:
  // setLoading(true) changes a dep, React tears down the effect, the cleanup
  // marks the in-flight request cancelled, and the response that arrives a
  // moment later is thrown away — leaving the spinner up forever. A ref doesn't
  // re-render, so the effect stays mounted for the life of the request.
  const started = useRef("");

  useEffect(() => {
    if (!enabled || !sku || started.current === sku) return;
    started.current = sku;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await apiGet(`/api/ebay/content?sku=${encodeURIComponent(sku)}`);
        const data = (await res.json()) as {
          ok: boolean;
          content?: Content;
          error?: string;
        };
        if (cancelled) return;
        if (!data.ok || !data.content) throw new Error(data.error || "Couldn't read this listing.");
        setContent(data.content);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          // Let a retry happen — a failed read shouldn't be permanent.
          started.current = "";
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sku, enabled]);

  return { content, setContent, loading, error };
}

export function ContentEditor({
  sku,
  onSaved,
}: {
  sku: string;
  onSaved: (content: Content) => void;
}) {
  const [open, setOpen] = useState(false);
  const { content, setContent, loading, error: loadError } = useContent(sku, open);
  const [draft, setDraft] = useState<Content | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Seed the draft once the real content arrives, without clobbering an edit
  // already in progress.
  useEffect(() => {
    if (content && draft === null) setDraft(content);
  }, [content, draft]);

  const changed =
    draft !== null &&
    content !== null &&
    (draft.title !== content.title || draft.description !== content.description);

  const save = async () => {
    if (!draft || !changed) return;
    setState("saving");
    setError(null);
    try {
      const res = await apiPost("/api/ebay/content", {
        sku,
        title: draft.title,
        description: draft.description,
      });
      const data = (await res.json()) as {
        ok: boolean;
        content?: Content;
        error?: string;
        partial?: boolean;
      };
      if (!data.ok) throw new Error(data.error || "eBay refused the change.");
      // Trust the read-back over what was typed.
      const saved = data.content ?? draft;
      setContent(saved);
      setDraft(saved);
      onSaved(saved);
      setState("saved");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <details className="ce" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>✏️ Edit title &amp; description</summary>
      <div className="ce-body">
        {loading && !content && (
          <p className="ce-hint">
            <span className="spinner" aria-hidden="true" /> Reading what this listing says…
          </p>
        )}
        {loadError && (
          <p className="lm-err" role="alert">
            {loadError}
          </p>
        )}

        {draft && (
          <>
            {/* Said here rather than assumed: the seller has a relist control
                three inches below this one, and needs to know which to reach
                for. */}
            <p className="ce-note">
              Saves to the <strong>live listing</strong> — same item number, watchers kept, search
              standing kept. Use <strong>End or relist</strong> below only when you also want to
              reset the listing&rsquo;s age.
            </p>

            <ContentFields
              value={draft}
              onChange={(next) => {
                setDraft(next);
                setState("idle");
                setError(null);
              }}
              disabled={state === "saving"}
              idPrefix={`ce-${sku}`}
            />

            {error && (
              <p className="lm-err" role="alert">
                {error}
              </p>
            )}
            {state === "saved" && <p className="lm-ok">✓ Live on eBay</p>}

            <div className="ce-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!changed || state === "saving" || draft.title.trim().length > TITLE_MAX}
                onClick={save}
              >
                {state === "saving" ? "Saving…" : "Save to eBay"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={!changed || state === "saving"}
                onClick={() => {
                  setDraft(content);
                  setState("idle");
                  setError(null);
                }}
              >
                Revert
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
