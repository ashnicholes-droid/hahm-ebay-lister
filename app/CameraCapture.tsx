"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cropRect, type FramingMode } from "@/lib/cameraFraming";
import { captureQuality } from "@/lib/cameraQuality";
import { scanQrSku } from "@/lib/qrScan";
import { EBAY_DIM, EBAY_QUALITY, type ResizedImage } from "@/lib/resize";

// Rapid multi-shot capture.
//
// A plain <input type="file" capture> hands each photo to the OS camera app and
// makes you confirm it, so every single shot costs "choose camera → shoot → Use
// Photo → reopen". For a batch of forty items that is hundreds of taps, which is
// the difference between this tool being useful on a phone and not.
//
// Here the camera stays open and the shutter just fires: tap, tap, tap. The
// preview is live, so QR labels can be recognised AS YOU AIM — you see the code
// register before you shoot, instead of finding out at import time that a label
// didn't read.

// Three sizes per shot, for the three different jobs — see lib/resize.ts for
// why they can't be one file. In short: 1024px is what the model reads, 1600px
// is what earns eBay's buyer zoom, 360px is what the screen shows.
const FULL_DIM = 1024;
const FULL_QUALITY = 0.82;
const THUMB_DIM = 360;
const THUMB_QUALITY = 0.5;
// How often to look for a label in the live preview. Fast enough to feel
// instant when you raise a tag to the lens, slow enough to leave the main
// thread free for a smooth preview.
const LIVE_SCAN_MS = 700;

interface CameraCaptureProps {
  onCapture: (shots: ResizedImage[]) => void;
  onClose: () => void;
  /**
   * Switch to the phone's own camera app instead.
   *
   * Not a preference — an escape hatch. Safari caps this live stream at 720p on
   * an iPhone, which is below eBay's zoom threshold, and the Camera app has no
   * such cap. When the stream turns out to be capped, the sheet has to be able
   * to hand the seller a way out rather than just apologising.
   */
  onUseSystemCamera?: () => void;
}

function drawToJpeg(
  src: CanvasImageSource,
  crop: { sx: number; sy: number; sw: number; sh: number },
  maxDim: number,
  quality: number
): string {
  const ratio = Math.min(1, maxDim / Math.max(crop.sw, crop.sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.sw * ratio));
  canvas.height = Math.max(1, Math.round(crop.sh * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the photo.");
  // The source rectangle is what makes the capture match the viewfinder.
  ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export function CameraCapture({ onCapture, onClose, onUseSystemCamera }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shots, setShots] = useState<ResizedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [liveSku, setLiveSku] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  // Full frame by default: it keeps every pixel the sensor gave, and now that
  // the viewfinder shows the whole frame there is no longer a surprise in it.
  // Square is there because eBay's gallery and search results are square, and
  // some sellers would rather compose to that than crop later.
  const [framing, setFraming] = useState<FramingMode>("full");
  // The stream's shape, so the square guide can be drawn over the video as it
  // is actually displayed. Sizing it to the stage instead would promise a crop
  // that doesn't match the one taken — the mask has to sit on the letterboxed
  // video rectangle, not the black box around it.
  const [aspect, setAspect] = useState<number | null>(null);
  // The stream's ACTUAL pixel size. Measured rather than assumed: the sheet
  // asks for 1920x1080 and Safari hands back 1280x720 on an iPhone regardless,
  // so the request tells you nothing about what you'll get.
  const [streamSize, setStreamSize] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState<{ w: number; h: number } | null>(null);

  // The stage's pixel size, so the square guide can be placed on the video as
  // displayed. CSS can't express this: `aspect-ratio` loses to a definite
  // width AND height, and object-fit: contain needs both bounds honoured.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setStageBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The side of the square, in screen pixels — the same square cropRect takes.
  const guideSide =
    aspect === null || stageBox === null
      ? null
      : (() => {
          const dispW = Math.min(stageBox.w, stageBox.h * aspect);
          return Math.min(dispW, dispW / aspect);
        })();
  // shoot() is a stable callback; a ref keeps it reading the CURRENT mode
  // rather than the one captured when it was created.
  const framingRef = useRef<FramingMode>("full");
  useEffect(() => {
    framingRef.current = framing;
  }, [framing]);

  // ── Camera lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser can't open the camera directly.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, at a resolution that still resolves a QR label.
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (e) {
        const err = e as Error;
        setError(
          err.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser's site settings, or use “Choose photos” instead."
            : err.message || "Could not open the camera."
        );
      }
    })();
    return () => {
      cancelled = true;
      // Releasing every track is what turns the phone's camera light off. Miss
      // this and the camera stays live behind the closed sheet.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // ── Live label detection ──────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const video = videoRef.current;
      if (!stopped && video && video.videoWidth) {
        try {
          // The live label scan reads the WHOLE frame regardless of framing:
          // a QR label just outside a square crop should still be recognised,
          // since it identifies the item rather than appearing in the photo.
          const canvas = document.createElement("canvas");
          const ratio = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * ratio);
          canvas.height = Math.round(video.videoHeight * ratio);
          canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = new Image();
          img.src = canvas.toDataURL("image/jpeg", 0.7);
          await new Promise((r) => (img.onload = r));
          const sku = await scanQrSku(img);
          if (!stopped) setLiveSku(sku || null);
        } catch {
          /* a dropped frame is not worth reporting */
        }
      }
      if (!stopped) timer = setTimeout(tick, LIVE_SCAN_MS);
    };
    timer = setTimeout(tick, LIVE_SCAN_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ready]);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const crop = cropRect(video.videoWidth, video.videoHeight, framingRef.current);
    const full = drawToJpeg(video, crop, FULL_DIM, FULL_QUALITY);
    const thumb = drawToJpeg(video, crop, THUMB_DIM, THUMB_QUALITY);
    // The camera asks for 1920×1080, so a shot almost always has more pixels
    // than the 1024px analysis copy keeps. Encoding a second time at 1600 is
    // what gets those pixels to eBay — drawToJpeg never upscales, so when the
    // crop is smaller than 1600 this is simply the largest frame available.
    const ebay =
      Math.max(crop.sw, crop.sh) > FULL_DIM
        ? drawToJpeg(video, crop, EBAY_DIM, EBAY_QUALITY)
        : null;

    // Scan the captured frame rather than trusting the live preview: the live
    // pass runs on a throttled tick and may be a beat behind what you shot.
    let sku = "";
    try {
      const img = new Image();
      img.src = full;
      await new Promise((r) => (img.onload = r));
      sku = await scanQrSku(img);
    } catch {
      /* fall back to "ordinary photo" */
    }

    setShots((prev) => [
      ...prev,
      {
        mediaType: "image/jpeg",
        data: full.split(",")[1],
        previewUrl: thumb,
        ...(ebay ? { full: ebay.split(",")[1] } : {}),
        // Judged from the CROP, not the stream: a square crop of a 1280x720
        // feed is 720x720, which is further short than the stream suggests.
        zoomCapable: Math.max(crop.sw, crop.sh) >= EBAY_DIM,
        ...(sku ? { sku } : {}),
      },
    ]);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
  }, []);

  const done = () => {
    if (shots.length) onCapture(shots);
    onClose();
  };

  const labelCount = shots.filter((s) => s.sku).length;
  const quality = streamSize
    ? captureQuality(streamSize.w, streamSize.h, framing)
    : null;

  return (
    <div className="camera-backdrop" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="camera-sheet">
        <header className="camera-head">
          <span>
            <strong>{shots.length}</strong> photo{shots.length === 1 ? "" : "s"}
            {labelCount > 0 && <> · {labelCount} label{labelCount === 1 ? "" : "s"}</>}
          </span>
          <span className="camera-framing" role="group" aria-label="Framing">
            <button
              type="button"
              className={framing === "full" ? "active" : ""}
              onClick={() => setFraming("full")}
              title="Keep the whole frame the camera sees"
            >
              Full frame
            </button>
            <button
              type="button"
              className={framing === "square" ? "active" : ""}
              onClick={() => setFraming("square")}
              title="Crop to the square eBay uses in search results"
            >
              Square
            </button>
          </span>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </header>

        {error ? (
          <p className="note note-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="camera-stage" ref={stageRef}>
            {/* `contain`, not `cover`. Cover showed the middle of the stream
                while the capture kept the whole frame, so what you composed
                and what eBay received were different pictures. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="camera-video"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setAspect(v.videoWidth / v.videoHeight);
                  setStreamSize({ w: v.videoWidth, h: v.videoHeight });
                }
              }}
            />
            {framing === "square" && guideSide !== null && (
              <div className="camera-crop-mask" aria-hidden="true">
                {/* Sized to the video AS DISPLAYED, not to the stage. A guide
                    drawn on the black letterbox would promise a crop nobody is
                    going to get, which is the same class of lie this whole
                    change exists to remove. */}
                <div
                  className="camera-crop-window"
                  style={{ width: guideSide, height: guideSide }}
                />
              </div>
            )}
            {flash && <div className="camera-flash" aria-hidden="true" />}
            {liveSku && (
              <div className="camera-live-sku" role="status">
                🏷 {liveSku} in view
              </div>
            )}
            {!ready && (
              <div className="camera-loading">
                <span className="spinner" aria-hidden="true" /> Starting camera…
              </div>
            )}
          </div>
        )}

        {shots.length > 0 && (
          <div className="camera-strip" aria-label="Captured photos">
            {shots.map((s, i) => (
              <div className={`camera-thumb${s.sku ? " is-marker" : ""}`} key={i}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.previewUrl} alt="" />
                {s.sku && <span>{s.sku}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Said here, not in a settings page: this is the moment the shot is
            about to be taken, and on an iPhone the answer is "not sharp enough
            for zoom" no matter what the constraints asked for. */}
        {quality && !quality.zoomCapable && !error && (
          <div className="camera-quality" role="status">
            <span>
              <strong>{quality.longestSide}px</strong> — under the 1600px eBay needs for buyer
              zoom.
              {framing === "square" && " Full frame would give more."}
            </span>
            {onUseSystemCamera && (
              <button type="button" className="btn-ghost" onClick={onUseSystemCamera}>
                Use the camera app instead →
              </button>
            )}
          </div>
        )}

        <div className="camera-controls">
          <button
            type="button"
            className="camera-shutter"
            onClick={shoot}
            disabled={!ready || Boolean(error)}
            aria-label="Take photo"
          >
            <span />
          </button>
          <button type="button" className="btn btn-primary" onClick={done} disabled={!shots.length}>
            Use {shots.length || ""} photo{shots.length === 1 ? "" : "s"}
          </button>
        </div>

        <p className="camera-hint">
          Keep tapping the shutter — the camera stays open. Shoot each item, then
          its QR label; the label is recognised as you aim.
        </p>
      </div>
    </div>
  );
}
