"use client";

import { reportStatus, type VerdictStatus, type VerificationReport } from "@/lib/verification";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  price: "Price",
  condition: "Condition",
  description: "Description",
  size: "Size",
  brand: "Brand",
  specifics: "Item specifics",
};

const ICONS: Record<VerdictStatus, string> = { ok: "✅", warn: "⚠️", fail: "⛔" };

const HEADLINE: Record<VerdictStatus | "unchecked", string> = {
  unchecked: "Not checked yet",
  ok: "Nothing to flag",
  warn: "Worth a look before posting",
  fail: "Fix before posting",
};

interface AccuracyPanelProps {
  report?: VerificationReport;
  verifying?: boolean;
  onCheckPhotos: () => void;
}

export function AccuracyPanel({ report, verifying, onCheckPhotos }: AccuracyPanelProps) {
  const status = reportStatus(report);
  const verdicts = report?.verdicts ?? [];
  // Failures first, then warnings — the order a seller should work through them.
  const order: Record<VerdictStatus, number> = { fail: 0, warn: 1, ok: 2 };
  const sorted = [...verdicts].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <section className={`accuracy accuracy-${status}`} aria-labelledby="accuracy-heading">
      <header className="accuracy-head">
        <span className="accuracy-badge" aria-hidden="true">
          {status === "unchecked" ? "○" : ICONS[status as VerdictStatus]}
        </span>
        <div>
          <strong id="accuracy-heading">Accuracy check — {HEADLINE[status]}</strong>
          <span className="accuracy-sub">
            {report?.photoChecked
              ? "Checked against the listing's own fields and re-read from the photos."
              : "Checked against the listing's own fields only. The photo check is what catches an invented brand or a missed flaw."}
          </span>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={onCheckPhotos}
          disabled={verifying}
          title="Re-reads the photos and grades each claim in this listing as supported, not visible, or contradicted."
        >
          {verifying ? (
            <>
              <span className="spinner small" aria-hidden="true" /> Checking photos…
            </>
          ) : report?.photoChecked ? (
            "↻ Re-check photos"
          ) : (
            "🔍 Check against photos"
          )}
        </button>
      </header>

      {sorted.length === 0 ? (
        <p className="accuracy-empty">
          {status === "unchecked"
            ? "Run the check to see which claims the photos actually support."
            : "No contradictions found in the listing's own fields."}
        </p>
      ) : (
        <ul className="accuracy-list">
          {sorted.map((v, i) => (
            <li key={`${v.field}-${v.source}-${i}`} className={`accuracy-item is-${v.status}`}>
              <span className="accuracy-icon" aria-hidden="true">
                {ICONS[v.status]}
              </span>
              <span className="accuracy-text">
                <span className="accuracy-field">{FIELD_LABELS[v.field] ?? v.field}</span>
                {v.message}
              </span>
              <span
                className="accuracy-source"
                title={
                  v.source === "photo"
                    ? "From the model re-reading the photos"
                    : "From a deterministic rule — it can only spot contradictions inside the listing, not verify it"
                }
              >
                {v.source === "photo" ? "photo" : "rule"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
