"use client";

import { useEffect, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { publishDataUrl } from "@/lib/photoSizes";
import type { ListingPreview as PreviewData } from "@/lib/ebay/preview";
import type { ItemGroup, Photo } from "@/lib/types";
import { PhotoViewer } from "./PhotoViewer";

// An eBay-shaped rendering of the payload the publish route will actually send.
// The layout is a deliberate approximation of eBay's item page — enough to read
// the listing the way a buyer will — while every VALUE in it comes from the
// server-side preview builder, which shares its code path with publish.ts.

interface ListingPreviewProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  onClose: () => void;
}

/** The image that actually publishes — the 1600px copy, not the 1024px one the
 * model reads, and certainly not the 360px sorting thumbnail this once used. */
const fullUrl = publishDataUrl;

function formatPrice(value: number | null, currency: string): string {
  if (value === null) return "—";
  const symbol = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return symbol ? `${symbol}${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

export function ListingPreview({ group, photoById, onClose }: ListingPreviewProps) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);

  // The seller's own photos, in the order they'll be sent — index 0 is the
  // gallery/cover image on the live listing.
  const photos = group.photoIds
    .map(photoById)
    .filter((p): p is Photo => Boolean(p))
    .slice(0, 12);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    (async () => {
      try {
        const res = await apiPost("/api/ebay/preview", {
          sku: group.sku,
          listing: group.listing,
          photoCount: group.photoIds.length,
        });
        const data = (await res.json()) as { ok?: boolean; preview?: PreviewData; error?: string };
        if (cancelled) return;
        if (!data.ok || !data.preview) throw new Error(data.error || "Could not build the preview.");
        setPreview(data.preview);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [group.sku, group.listing, group.photoIds.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hero = photos[heroIndex] ?? photos[0];

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="eBay listing preview" onClick={onClose}>
      <div className="preview-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="preview-head">
          <div>
            <strong>eBay preview</strong>
            <span className="preview-sub">
              Built from the exact payload this listing will publish with.
            </span>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close preview">
            ✕ Close
          </button>
        </header>

        {error && (
          <p className="note note-error" role="alert">
            {error}
          </p>
        )}

        {!preview && !error && (
          <div className="loading-card">
            <span className="spinner" aria-hidden="true" />
            <span>Asking eBay which category and item specifics this lands in…</span>
          </div>
        )}

        {preview && (
          <>
            {!preview.fromLiveTaxonomy && (
              <p className="note note-warn">
                eBay&rsquo;s live category data wasn&rsquo;t available, so this is an offline
                approximation. The published listing may differ.
              </p>
            )}

            <div className="ebay-item">
              <div className="ebay-gallery">
                {hero ? (
                  <>
                    {/* The image that PUBLISHES, not the 360px sorting thumb.
                        A preview claiming to show "as it will appear on eBay"
                        while rendering a different, much smaller file is the
                        one thing this screen must not do. Clicking opens it
                        full size. */}
                    <button
                      type="button"
                      className="ebay-hero-open"
                      aria-label="View this photo full size"
                      title="View full size"
                      onClick={() => setViewerOpen(true)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className="ebay-hero" src={fullUrl(hero)} alt="" />
                    </button>
                    {photos.length > 1 && (
                      <div className="ebay-thumbs">
                        {photos.map((p, i) => (
                          <button
                            key={p.id}
                            type="button"
                            className={`ebay-thumb${i === heroIndex ? " active" : ""}`}
                            onClick={() => setHeroIndex(i)}
                            aria-label={`Photo ${i + 1}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.previewUrl} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="ebay-photo-count">
                      {preview.photoCount} photo{preview.photoCount === 1 ? "" : "s"} · the first is
                      the gallery image buyers see in search
                    </p>
                  </>
                ) : (
                  <div className="ebay-hero placeholder">No photos</div>
                )}
              </div>

              <div className="ebay-detail">
                <p className="ebay-breadcrumb">
                  {preview.categoryName || "Category"}{" "}
                  <span className="ebay-catid">#{preview.categoryId}</span>
                </p>
                <h3 className="ebay-title">{preview.title}</h3>
                {preview.titleClipped && (
                  <p className="ebay-clip-note">
                    ⚠️ Your title was longer than 80 characters — this is where eBay cuts it.
                  </p>
                )}
                <p className="ebay-condition">
                  <span className="k">Condition:</span> {preview.conditionLabel}
                  {preview.conditionNotes && (
                    <span className="ebay-cond-notes"> — {preview.conditionNotes}</span>
                  )}
                </p>
                {preview.allowedConditions.length > 0 && (
                  <details className="ebay-cond-allowed">
                    <summary>
                      {preview.allowedConditions.length} condition
                      {preview.allowedConditions.length === 1 ? "" : "s"} this category accepts
                    </summary>
                    <ul>
                      {preview.allowedConditions.map((c) => (
                        <li
                          key={c.id}
                          className={c.enumValue === preview.conditionEnum ? "current" : ""}
                        >
                          {c.label}
                          {c.approvalOnly && (
                            <span className="ebay-cond-gated"> needs eBay approval</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="ebay-price">{formatPrice(preview.price, preview.currency)}</p>
                {preview.volumeDiscount && (
                  <p className="ebay-multibuy">
                    <span className="ebay-multibuy-tag">Save on multi-buy</span> Buy{" "}
                    {preview.volumeDiscount.minQuantity} or more,{" "}
                    {preview.volumeDiscount.unitPrice !== null ? (
                      <>
                        pay{" "}
                        <strong>
                          {formatPrice(preview.volumeDiscount.unitPrice, preview.currency)}
                        </strong>{" "}
                        each
                      </>
                    ) : (
                      <>save {preview.volumeDiscount.percentOff}% each</>
                    )}
                  </p>
                )}
                {preview.quantity > 1 && (
                  <p className="ebay-quantity">
                    <span className="k">Quantity:</span> {preview.quantity} available
                  </p>
                )}
                <p className="ebay-sku">
                  <span className="k">Inventory (SKU):</span> {preview.sku || "—"}
                </p>
                <div className="ebay-buybox">
                  <span className="ebay-btn buy">Buy It Now</span>
                  <span className="ebay-btn cart">Add to cart</span>
                </div>
              </div>
            </div>

            <section className="ebay-section">
              <h4>Item specifics</h4>
              {preview.specifics.length === 0 ? (
                <p className="ebay-empty">No item specifics — this listing will be hard to find in filtered search.</p>
              ) : (
                <div className="ebay-specifics">
                  {preview.specifics.map((s) => (
                    <div className="row" key={s.name}>
                      <span className="k">
                        {s.name}
                        {s.required && (
                          <span className="req" title="eBay requires this specific">
                            {" "}
                            *
                          </span>
                        )}
                      </span>
                      <span>{s.values.join(", ")}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.missingRequired.length > 0 && (
                <p className="note note-warn">
                  eBay requires these specifics for this category and the listing has no value for
                  them: <strong>{preview.missingRequired.join(", ")}</strong>. Publishing fills what
                  it can, but adding them yourself is more accurate.
                </p>
              )}
            </section>

            <section className="ebay-section">
              <h4>Description</h4>
              <div className="ebay-description">{preview.description || "—"}</div>
            </section>

            {preview.warnings.length > 0 && (
              <section className="ebay-section">
                <h4>Before you post</h4>
                <ul className="preview-warnings">
                  {preview.warnings.map((w) => (
                    <li key={w}>⚠️ {w}</li>
                  ))}
                </ul>
              </section>
            )}

            <p className="preview-footnote">
              Two things this preview can&rsquo;t know: whether the SKU is already live on your
              account, and whether eBay&rsquo;s validators will reject a specific value. Both are
              only answered at publish time — the posting flow recovers from them automatically.
            </p>
          </>
        )}
        {viewerOpen && photos.length > 0 && (
          <PhotoViewer
            photos={photos}
            startIndex={heroIndex}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
