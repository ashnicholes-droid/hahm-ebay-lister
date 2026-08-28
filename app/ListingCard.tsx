"use client";

import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import { reportStatus } from "@/lib/verification";
import { AccuracyPanel } from "./AccuracyPanel";
import { CompsDialog } from "./CompsDialog";
import { ListingPreview } from "./ListingPreview";
import { QuantityPanel } from "./QuantityPanel";
import { ShippingPanel } from "./ShippingPanel";
import type { ItemGroup, ListingResult, Photo, PublishDebug } from "@/lib/types";
import { DEFAULT_RULES, recommendedPrice, type PricingRules } from "@/lib/pricingRules";
import { RULES_CHANGED, loadRules } from "@/lib/pricingSettings";

const TITLE_LIMIT = 80;

/**
 * The grades a seller can choose, grouped the way eBay groups them.
 *
 * This list used to hold six pre-owned tiers and nothing else, which meant an
 * open-box item and a refurbished one had no honest home — both had to be filed
 * as "new without tags" or as used, and the distinction that makes them worth
 * more was lost. `note` says what a grade actually implies, because "Seller
 * Refurbished" is a claim about work performed, not a synonym for tidy.
 */
const CONDITION_GROUPS: {
  label: string;
  options: { value: string; label: string; note?: string }[];
}[] = [
  {
    label: "New",
    options: [
      { value: "NEW_WITH_TAGS", label: "New with tags / sealed" },
      { value: "NEW_NO_TAGS", label: "New without tags" },
      {
        value: "OPEN_BOX",
        label: "Open box",
        note: "Never used, but the packaging was opened. Worth more than used — eBay lists it separately.",
      },
    ],
  },
  {
    label: "Refurbished",
    options: [
      {
        value: "SELLER_REFURBISHED",
        label: "Seller refurbished",
        note: "You (or a third party) restored it to working order. Only claim this if work was actually done.",
      },
      {
        value: "CERTIFIED_REFURBISHED",
        label: "Certified refurbished",
        note: "Manufacturer-backed with a warranty. eBay must approve your account for this — otherwise the listing is rejected.",
      },
    ],
  },
  {
    label: "Pre-owned",
    options: [
      { value: "EXCELLENT", label: "Excellent" },
      { value: "VERY_GOOD", label: "Very good" },
      { value: "GOOD", label: "Good" },
      { value: "FAIR", label: "Fair" },
    ],
  },
  {
    label: "Not working",
    options: [
      {
        value: "FOR_PARTS",
        label: "For parts or not working",
        note: "Buyers cannot open a not-as-described case for faults you list here.",
      },
    ],
  },
];

const CONDITION_NOTES: Record<string, string> = Object.fromEntries(
  CONDITION_GROUPS.flatMap((g) => g.options.filter((o) => o.note).map((o) => [o.value, o.note!]))
);

const ALL_CONDITIONS = CONDITION_GROUPS.flatMap((g) => g.options);

function formatPrice(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : String(n);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

/**
 * Everything eBay said about a rejection.
 *
 * The one-line message above is eBay's first sentence, and on its own it is
 * often unactionable — the part that names the actual problem lives in
 * `longMessage` and in `parameters` (which aspect is missing, which condition
 * ids the category will accept). All of it is here, collapsed by default, with
 * a copy button so it can be pasted into a search or a support ticket.
 */
function EbayErrorDetail({ debug }: { debug: PublishDebug }) {
  const text = useMemo(() => JSON.stringify(debug, null, 2), [debug]);
  return (
    <details className="ebay-debug">
      <summary>
        Show eBay&rsquo;s full response
        <small>
          {" "}
          — {debug.stage}, HTTP {debug.httpStatus}
          {debug.errors.length > 1 ? `, ${debug.errors.length} errors` : ""}
        </small>
      </summary>

      <dl className="ebay-debug-meta">
        {debug.categoryId && (
          <div>
            <dt>Category</dt>
            <dd>{debug.categoryId}</dd>
          </div>
        )}
        {debug.conditionSent && (
          <div>
            <dt>Condition sent</dt>
            <dd>{debug.conditionSent}</dd>
          </div>
        )}
      </dl>

      {debug.errors.map((e, i) => (
        <div className="ebay-debug-err" key={`${e.errorId}-${i}`}>
          <p className="ebay-debug-id">
            eBay error {e.errorId}
            {e.category ? ` · ${e.category}` : ""}
            {e.domain ? ` · ${e.domain}` : ""}
          </p>
          {e.longMessage && <p>{e.longMessage}</p>}
          {e.message && e.message !== e.longMessage && <p>{e.message}</p>}
          {e.parameters && e.parameters.length > 0 && (
            <ul className="ebay-debug-params">
              {e.parameters.map((p, j) => (
                <li key={`${p.name}-${j}`}>
                  <span className="k">{p.name || "value"}</span>
                  <span>{p.value}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {debug.raw && <pre className="ebay-debug-raw">{debug.raw}</pre>}

      <div className="copy-row">
        <CopyButton text={text} label="details" />
      </div>
    </details>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  /** Re-run analysis using the current title as the seller's correction. */
  onResearch: (groupId: string) => void;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onVerify: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  onResearch,
  ebayConnected,
  onEdit,
  onRenameSku,
  onRetry,
  onPost,
  onVerify,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [compsOpen, setCompsOpen] = useState(false);
  const researching = group.status === "writing";

  // Pricing rules live in the browser, so a card has to read them on mount and
  // follow them afterwards — changing a setting in another tab should reprice
  // every open card without a reload.
  const [rules, setRules] = useState<PricingRules>(DEFAULT_RULES);
  useEffect(() => {
    const sync = () => setRules(loadRules());
    sync();
    window.addEventListener(RULES_CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(RULES_CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const recommendation = useMemo(
    () => recommendedPrice(group.comps, rules, group.comps?.markupPercent ?? 0),
    [group.comps, rules]
  );
  const [newSpecKey, setNewSpecKey] = useState("");
  const [newSpecValue, setNewSpecValue] = useState("");
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);
  const accuracy = reportStatus(group.verification);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(([k, v]) => v && v.trim() !== "" && !k.startsWith("---"));
  }, [listing?.item_specifics]);

  // Item specifics are edited in place. An emptied value is removed outright
  // rather than sent to eBay as a blank, which publishes as a visible empty row.
  const setSpecific = (key: string, value: string) => {
    const next = { ...(listing?.item_specifics ?? {}) };
    if (value.trim() === "") delete next[key];
    else next[key] = value;
    onEdit(group.id, { item_specifics: next });
  };

  const addSpecific = () => {
    const key = newSpecKey.trim();
    const value = newSpecValue.trim();
    if (!key || !value) return;
    onEdit(group.id, { item_specifics: { ...(listing?.item_specifics ?? {}), [key]: value } });
    setNewSpecKey("");
    setNewSpecValue("");
  };

  const titleLen = listing?.title?.length ?? 0;

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  // Publishing refuses a missing/zero price (no more invented defaults), so
  // flag it here the same way size is flagged — before the seller hits Post.
  const priceNum =
    typeof listing?.suggested_price === "string"
      ? parseFloat(listing.suggested_price)
      : listing?.suggested_price;
  const priceMissing =
    group.status === "done" &&
    (priceNum === undefined || Number.isNaN(priceNum) || priceNum <= 0);

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" &&
              (priceMissing ? (
                <span style={{ color: "var(--color-danger)" }}>⚠️ needs a price</span>
              ) : accuracy === "fail" ? (
                <span style={{ color: "var(--color-danger)" }}>
                  ⛔ {formatPrice(listing?.suggested_price)} · accuracy check failed
                </span>
              ) : accuracy === "warn" ? (
                <>⚠️ {formatPrice(listing?.suggested_price)} · check before posting</>
              ) : (
                <>✅ {formatPrice(listing?.suggested_price)} · ready</>
              ))}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.error || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <div className="listing-card-body">
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
              {/* The escape hatch for a wrong identification. The model reads
                  items out of photographs and on anything obscure it will be
                  confidently wrong; the seller is holding the thing. */}
              <button
                type="button"
                className="btn-ghost research-btn"
                disabled={researching || !listing.title.trim()}
                onClick={() => onResearch(group.id)}
                title="Correct the title above, then rebuild the description, specifics and price around it"
              >
                {researching ? "Researching…" : "🔎 Research this item"}
              </button>
            </div>
            <p className="research-hint">
              Wrong item? Fix the title, then <strong>Research this item</strong> — the description,
              specifics and price are rebuilt from what you typed. Your title, SKU, quantity and
              shipping choice are kept.
            </p>
          </div>

          <div className="meta-row">
            {/* SKU stays editable up until the item is posted, so a SKU fix
                never requires going back and re-writing listings (issue #30). */}
            <div className="stat editable">
              <label className="k" htmlFor={`sku-${group.id}`}>
                SKU
              </label>
              <input
                id={`sku-${group.id}`}
                type="text"
                className="size-input"
                value={group.sku}
                disabled={group.postStatus === "posted"}
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
            </div>
            <div className={`stat editable${priceMissing ? " needs-attention" : ""}`}>
              <label className="k" htmlFor={`price-${group.id}`}>
                Price
              </label>
              <div className="price-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    onEdit(group.id, {
                      suggested_price:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
              </div>
              {group.comps?.ok && group.comps.median !== undefined && (
                <span className="comps-line" title={group.comps.basis}>
                  Market: {group.comps.pricedCount ?? group.comps.count} active asks, $
                  {group.comps.low?.toFixed(0)}–${group.comps.high?.toFixed(0)} delivered
                  {recommendation && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="comps-use"
                        title={recommendation.explanation}
                        onClick={() =>
                          onEdit(group.id, { suggested_price: recommendation.price })
                        }
                      >
                        use ${recommendation.price.toFixed(2)}
                      </button>
                    </>
                  )}
                  {" · "}
                  <button
                    type="button"
                    className="comps-use"
                    onClick={() => setCompsOpen(true)}
                  >
                    see {group.comps.count} comps
                  </button>
                </span>
              )}
            </div>
            <div className="stat editable stat-condition">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={listing.condition ?? "GOOD"}
                onChange={(e) => onEdit(group.id, { condition: e.target.value })}
              >
                {/* Keep an unexpected model value selectable rather than losing it. */}
                {listing.condition &&
                  !ALL_CONDITIONS.some((c) => c.value === listing.condition) && (
                    <option value={listing.condition}>
                      {listing.condition.replace(/_/g, " ")}
                    </option>
                  )}
                {CONDITION_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {CONDITION_NOTES[listing.condition ?? ""] && (
                <span className="cond-note">{CONDITION_NOTES[listing.condition!]}</span>
              )}
            </div>
            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div className={`stat editable${sizeMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          {priceMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No price yet — the analysis couldn&rsquo;t estimate one for
              this item. Set a price above before posting
              {group.comps?.ok ? " (see the market check under Price)" : ""}.
            </p>
          )}

          <QuantityPanel listing={listing} groupId={group.id} onEdit={onEdit} />

          <div className="result-field">
            <label htmlFor={`cnotes-${group.id}`}>
              Condition notes
              <small>
                {" "}
                — eBay shows this under the condition. Flaws named here are much harder to
                dispute later.
              </small>
            </label>
            <textarea
              id={`cnotes-${group.id}`}
              className="cond-notes"
              rows={3}
              value={listing.condition_notes ?? ""}
              placeholder="e.g. Light scuff on the base, pictured. No chips or cracks."
              onChange={(e) => onEdit(group.id, { condition_notes: e.target.value })}
            />
          </div>

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) => onEdit(group.id, { description: e.target.value })}
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
            </div>
          </div>

          <details className="specifics-details">
            <summary>
              {specifics.length} item specific{specifics.length === 1 ? "" : "s"} — editable
            </summary>
            <p className="specifics-hint">
              These are what buyers filter search by, so a wrong or missing one costs views.
              Clear a value to drop it from the listing.
            </p>
            <div className="specifics">
              {specifics.map(([k, v]) => (
                <label className="row" key={k}>
                  <span className="k">{k}</span>
                  <input
                    type="text"
                    value={v}
                    onChange={(e) => setSpecific(k, e.target.value)}
                    aria-label={k}
                  />
                  <button
                    type="button"
                    className="spec-remove"
                    title={`Remove ${k}`}
                    onClick={() => setSpecific(k, "")}
                  >
                    ×
                  </button>
                </label>
              ))}
            </div>
            <div className="spec-add">
              <input
                type="text"
                placeholder="Add a specific (e.g. Model)"
                value={newSpecKey}
                onChange={(e) => setNewSpecKey(e.target.value)}
              />
              <input
                type="text"
                placeholder="Value"
                value={newSpecValue}
                onChange={(e) => setNewSpecValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSpecific();
                  }
                }}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={!newSpecKey.trim() || !newSpecValue.trim()}
                onClick={addSpecific}
              >
                + Add
              </button>
            </div>
          </details>

          <ShippingPanel listing={listing} groupId={group.id} onEdit={onEdit} />

          <AccuracyPanel
            report={group.verification}
            verifying={group.verifying}
            onCheckPhotos={() => onVerify(group.id)}
          />

          <div className="preview-row">
            <button type="button" className="btn-ghost" onClick={() => setPreviewOpen(true)}>
              👁 Preview as it will appear on eBay
            </button>
          </div>

          {previewOpen && (
            <ListingPreview
              group={group}
              photoById={photoById}
              onClose={() => setPreviewOpen(false)}
            />
          )}

          {compsOpen && group.comps?.ok && (
            <CompsDialog
              comps={group.comps}
              recommendation={recommendation}
              currentPrice={
                typeof listing.suggested_price === "number" ? listing.suggested_price : null
              }
              onUse={(price) => onEdit(group.id, { suggested_price: price })}
              onClose={() => setCompsOpen(false)}
            />
          )}

          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <>
              <p className="post-result ok">
                ✅ Posted to eBay
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/itm/${group.listingId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View listing ↗
                    </a>
                  </>
                ) : null}
              </p>
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
            </>
          ) : ebayConnected ? (
            <div className="post-row">
              {/* A failing accuracy check doesn't lock the button — it's the
                  seller's item and their call. It does change what the button
                  says, so the choice is a deliberate one. "Post all" skips
                  these entirely; mass-posting known-bad listings is different
                  from knowingly posting one. */}
              <button
                type="button"
                className={`btn ${accuracy === "fail" ? "btn-danger" : "btn-primary"}`}
                onClick={() => onPost(group.id)}
                disabled={group.postStatus === "posting"}
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Posting to eBay…
                  </>
                ) : accuracy === "fail" ? (
                  "⛔ Post anyway — accuracy check failed"
                ) : (
                  "🚀 Post this to eBay"
                )}
              </button>
              {group.postStatus === "error" && group.postError && (
                <>
                  <p className="post-result err">⚠️ {group.postError}</p>
                  {group.postDebug && <EbayErrorDetail debug={group.postDebug} />}
                </>
              )}
            </div>
          ) : (
            <p className="post-hint">Connect eBay (top of page) to post this listing.</p>
          )}
        </div>
      )}
    </article>
  );
}
