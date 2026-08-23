"use client";

import { useEffect, useRef, useState } from "react";
import type { Photo } from "@/lib/types";

// Seeing a photo as it actually is.
//
// Every image in this app was shown as a square thumbnail — 360px, cropped to
// a square with object-fit: cover. On a portrait phone photo that means the top
// and bottom are simply not visible ANYWHERE in the app, and the seller is
// approving a listing whose photos they have never fully seen. For a tool whose
// whole job is "check this before it goes to a buyer", that's the wrong
// default.
//
// This shows the real frame: uncropped, at the resolution that publishes, with
// the pixel dimensions stated so there is no guessing about what eBay receives.

const dataUrl = (p: Photo) =>
  p.data.startsWith("data:") ? p.data : `data:${p.mediaType};base64,${p.data}`;

export function PhotoViewer({
  photos,
  startIndex,
  onClose,
}: {
  photos: Photo[];
  startIndex: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(startIndex);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  // Arrow keys, because flicking through a dozen photos one click at a time is
  // how you stop looking properly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % photos.length);
      if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + photos.length) % photos.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photos.length]);

  // Dimensions belong to the photo, not to the viewer.
  useEffect(() => setDims(null), [index]);

  const photo = photos[index];
  if (!photo) return null;

  return (
    <dialog ref={ref} className="pv" onClose={onClose}>
      <div className="pv-bar">
        <span className="pv-count">
          {index + 1} of {photos.length}
          {/* Stated rather than implied: this is the size eBay receives, and
              eBay's zoom needs 1600px on the long side. */}
          {dims && (
            <small>
              {" "}
              · {dims.w}×{dims.h}px
              {Math.max(dims.w, dims.h) < 1600 && <> · below eBay&rsquo;s 1600px zoom threshold</>}
            </small>
          )}
        </span>
        <button type="button" className="btn-ghost" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </div>

      <div className="pv-stage">
        {photos.length > 1 && (
          <button
            type="button"
            className="pv-nav prev"
            aria-label="Previous photo"
            onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}
          >
            ‹
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="pv-img"
          src={dataUrl(photo)}
          alt={`Photo ${index + 1}`}
          onLoad={(e) =>
            setDims({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
        />
        {photos.length > 1 && (
          <button
            type="button"
            className="pv-nav next"
            aria-label="Next photo"
            onClick={() => setIndex((i) => (i + 1) % photos.length)}
          >
            ›
          </button>
        )}
      </div>

      {photos.length > 1 && (
        <div className="pv-strip">
          {photos.map((p, i) => (
            <button
              type="button"
              key={p.id}
              className={i === index ? "active" : ""}
              aria-label={`Photo ${i + 1}`}
              onClick={() => setIndex(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="" />
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}
