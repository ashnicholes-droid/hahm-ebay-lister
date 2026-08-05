// Reading an inventory number out of a QR code payload.
//
// The bulk-intake flow lets you photograph a QR label after each item as a
// delimiter (see lib/qrGrouping.ts). Whatever you encode into that label ends up
// as the item's eBay SKU, so this module's job is to pull a usable identifier
// out of the several shapes a label generator might produce, and to refuse
// anything that isn't one.
//
// The payload is UNTRUSTED input: a QR code can carry ~4 KB of arbitrary bytes,
// and a scanned one can come from a label nobody in this workflow printed. Every
// path here bounds the input first, then runs it through sanitizeSku(), which
// restricts the result to [A-Za-z0-9._-] and 50 characters.

import { sanitizeSku } from "@/lib/sku";

// Longer than any sane inventory label; anything past this is not an SKU and we
// don't want to spend regex time on it.
const MAX_PAYLOAD_LEN = 512;

// Query-string keys a label generator plausibly uses for the item identifier.
const SKU_KEYS = ["sku", "inventory", "inventory_number", "item", "itemid", "id"];

function fromObject(obj: Record<string, unknown>): string {
  for (const key of SKU_KEYS) {
    const direct = obj[key] ?? obj[key.toUpperCase()];
    if (typeof direct === "string" || typeof direct === "number") {
      const s = String(direct).trim();
      if (s) return s;
    }
  }
  return "";
}

function fromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  for (const key of SKU_KEYS) {
    const v = url.searchParams.get(key) ?? url.searchParams.get(key.toUpperCase());
    if (v?.trim()) return v.trim();
  }
  // No query parameter — fall back to the last non-empty path segment, which is
  // how most "print a QR that points at my inventory app" schemes look.
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length ? decodeURIComponent(segments[segments.length - 1]) : "";
}

/**
 * Pull an inventory number / SKU out of a decoded QR payload.
 *
 * Accepts a bare code ("K75-A"), a URL ("https://bins.example/i/K75-A" or
 * "...?sku=K75-A"), or a small JSON object ({"sku":"K75-A"}). Returns "" when
 * nothing usable survives sanitising — callers treat that as "this photo is not
 * a delimiter" rather than inventing an identifier.
 */
export function extractSku(payload: string | null | undefined): string {
  const raw = String(payload ?? "").trim();
  if (!raw || raw.length > MAX_PAYLOAD_LEN) return "";

  let candidate = "";
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidate = fromObject(parsed as Record<string, unknown>);
      }
    } catch {
      /* not JSON after all — fall through to the plain-text path */
    }
  }
  if (!candidate && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    candidate = fromUrl(raw);
  }
  if (!candidate) candidate = raw;

  const sku = sanitizeSku(candidate);
  // A sanitised code that lost everything meaningful (e.g. the payload was all
  // punctuation) is not an inventory number.
  return /[A-Za-z0-9]/.test(sku) ? sku : "";
}

/** True when this decoded payload looks like an item delimiter we can use. */
export function isDelimiterPayload(payload: string | null | undefined): boolean {
  return extractSku(payload).length > 0;
}
