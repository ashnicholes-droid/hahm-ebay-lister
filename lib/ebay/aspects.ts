// Small helpers for eBay item-specifics (aspects), shared between the publish
// pipeline and the model-assisted aspect filler.

import type { AspectMeta } from "./taxonomy";

// eBay rejects any item-specific (aspect) value longer than this (error 25002).
export const MAX_ASPECT_VALUE_LEN = 65;

// Buyer-facing phrases the analysis model sometimes writes for unknown fields.
// These are not attribute values — "Material = See tag in photos" would become
// a searchable eBay filter value. They belong in the description, never in an
// aspect, so every aspect value passes through this check.
// Deliberately narrow: "see"/"check" only count with a photo/tag-ish object so
// real values like the brand "See by Chloé" or pattern "Check Print" survive.
const PLACEHOLDER_VALUE_RE =
  /^((see|check|refer\sto)\s+.*\b(photo|pic|image|tag|label|listing|description|measurement|above|below)|unknown\b|unclear\b|n\/?a\b|none\b|not\s(visible|shown|applicable|available|sure)|no\s(size|tag|label|brand\svisible)|unable\s|can'?t\s|tbd\b|maybe\b|possibly\b|[-?.]+$)/i;

export function isPlaceholderValue(s: string): boolean {
  const t = (s || "").trim();
  return !t || PLACEHOLDER_VALUE_RE.test(t);
}

// Clip an aspect value to eBay's limit, breaking at a word boundary when the
// truncation point lands far enough in to leave a readable phrase.
export function clipAspectValue(s: string, maxLen = MAX_ASPECT_VALUE_LEN): string {
  const t = (s || "").trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// Clean a single aspect value: placeholder phrases become "", real values get
// clipped to eBay's length limit.
export function cleanAspectValue(s: string, maxLen = MAX_ASPECT_VALUE_LEN): string {
  return isPlaceholderValue(s) ? "" : clipAspectValue(s, maxLen);
}

// Split a model-provided value into its parts ("Cotton / Polyester" →
// ["Cotton", "Polyester"]), cleaning each. Multi-value aspects keep every
// part; single-value aspects take the first (see enforceCardinality).
//
// A split only happens when EVERY resulting part is a real word (3+ chars):
// "Black & White" and "Cotton/Polyester" split, while names and sizes whose
// pieces are fragments — "AC/DC", "H&M", "Texas A&M", "9 1/2", "S/M" — stay
// whole instead of being shredded.
const VALUE_SEPARATOR_RE = /\s*(?:\/|,|\||&|\band\b)\s*/i;
const MIN_SPLIT_PART_LEN = 3;

export function splitAspectValues(v: unknown, maxLen = MAX_ASPECT_VALUE_LEN): string[] {
  const flat: string[] = [];
  const push = (raw: unknown) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    let parts = s.split(VALUE_SEPARATOR_RE).map((p) => p.trim());
    if (parts.length < 2 || parts.some((p) => p.length < MIN_SPLIT_PART_LEN)) {
      parts = [s];
    }
    for (const part of parts) {
      const cleaned = cleanAspectValue(part.replace(/\s+/g, " "), maxLen);
      if (cleaned && !flat.some((x) => x.toLowerCase() === cleaned.toLowerCase())) {
        flat.push(cleaned);
      }
    }
  };
  if (Array.isArray(v)) v.forEach(push);
  else push(v);
  return flat;
}

// Cap how many values a MULTI aspect carries — enough to keep real data
// ("Casual, Travel, Workwear") without letting a rambling model response
// turn one aspect into a paragraph.
export const MAX_MULTI_VALUES = 5;

// Make every aspect's value count legal for eBay. MULTI aspects keep up to
// MAX_MULTI_VALUES entries; SINGLE aspects (and aspects eBay doesn't know,
// where MULTI can't be proven safe) collapse to their first value. Features
// is the long-standing exception: eBay accepts several everywhere it exists,
// and the app always sent it as a list.
export function enforceCardinality(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): void {
  const byName = new Map(meta.map((a) => [a.name.toLowerCase(), a]));
  for (const key of Object.keys(aspects)) {
    const a = byName.get(key.toLowerCase());
    const vals = aspects[key] || [];
    if (vals.length <= 1) continue;
    const multi = a ? a.cardinality === "MULTI" : key === "Features";
    aspects[key] = multi ? vals.slice(0, MAX_MULTI_VALUES) : vals.slice(0, 1);
  }
}

// eBay hard-validates NUMBER-typed aspects at publish time ("Fabric weight
// must be greater than 0. Enter up to 1 number after the decimal.") — a prose
// value like "Heavyweight" fails the whole listing with 25002. Keep only a
// positive numeric token pulled from each value ("6.1 oz" → "6.1", int32
// aspects rounded to whole numbers) and drop the aspect entirely when none of
// its values contain one. Returns the names of dropped aspects for logging.
export function sanitizeNumericAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): string[] {
  const dropped: string[] = [];
  const byName = new Map(meta.map((a) => [a.name.toLowerCase(), a]));
  for (const key of Object.keys(aspects)) {
    const a = byName.get(key.toLowerCase());
    if (!a || a.dataType !== "NUMBER") continue;
    const kept: string[] = [];
    for (const v of aspects[key] || []) {
      const m = String(v).match(/-?\d+(?:\.\d+)?/);
      if (!m) continue;
      const num = a.format === "int32" ? String(Math.round(Number(m[0]))) : m[0];
      if (Number(num) > 0 && !kept.includes(num)) kept.push(num);
    }
    if (kept.length) {
      aspects[key] = kept;
    } else {
      delete aspects[key];
      dropped.push(key);
    }
  }
  return dropped;
}

// Match a value against eBay's allowed list, case-insensitively and tolerating
// singular/plural (so "Unisex Adult" resolves to the valid "Unisex Adults").
// Returns the canonical allowed value, or null if there's no match.
export function matchAllowed(value: string, allowed: string[]): string | null {
  const ls = (value || "").trim().toLowerCase();
  if (!ls) return null;
  for (const v of allowed) {
    const lv = v.toLowerCase();
    if (lv === ls || lv === `${ls}s` || `${lv}s` === ls) return v;
  }
  return null;
}

// Rename model-provided aspect keys to eBay's exact (canonical) aspect names,
// matching case-insensitively. The analysis model says "Country/region of
// manufacture" or "SLEEVE LENGTH"; eBay only counts the specific if the key
// matches its localized aspect name exactly — otherwise it stays "suggested"
// on the live listing.
export function canonicalizeAspectKeys(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): void {
  const canonical = new Map<string, string>();
  for (const a of meta) {
    if (a.name) canonical.set(a.name.toLowerCase(), a.name);
  }
  for (const key of Object.keys(aspects)) {
    const proper = canonical.get(key.toLowerCase());
    if (proper && proper !== key) {
      if (!aspects[proper]) aspects[proper] = aspects[key];
      delete aspects[key];
    }
  }
  // Snap SELECTION_ONLY values to eBay's canonical spelling where we can.
  for (const a of meta) {
    if (a.mode !== "SELECTION_ONLY" || !aspects[a.name]?.length) continue;
    const vals = aspects[a.name];
    const matched: string[] = [];
    for (const v of vals) {
      const m = matchAllowed(v, a.values);
      if (m && !matched.includes(m)) matched.push(m);
    }
    if (matched.length) {
      aspects[a.name] = matched;
      continue;
    }
    // The value may be a compound allowed value that value-splitting broke
    // apart ("Hook & Eye" → Hook, Eye) — try rejoining before giving up.
    if (vals.length > 1) {
      for (const sep of [" & ", " / ", ", ", " and "]) {
        const joined = matchAllowed(vals.join(sep), a.values);
        if (joined) {
          aspects[a.name] = [joined];
          break;
        }
      }
    }
  }
}

// eBay now restricts apparel/footwear size specifics to its own standard
// values (error 25129: "no longer support custom values for UK Shoe Size")
// even where the Taxonomy API still reports the aspect as FREE_TEXT. Size
// aspects that come with a value list are therefore treated as selection-only.
const STANDARD_SIZE_ASPECT_RE = /\bshoe size\b/i;

export function isStandardSizeAspect(a: AspectMeta): boolean {
  return STANDARD_SIZE_ASPECT_RE.test(a.name) && a.values.length > 0;
}

// "UK 7" → "7", "EU 40.0" → "40", "7 1/2" → "7.5", "Women's US 8" → "8".
function normalizeSizeToken(value: string): string {
  return value
    .trim()
    .replace(/^(?:(?:wo)?men'?s|w|m)\s+/i, "")
    .replace(/^(?:uk|eu|us)\s*/i, "")
    .replace(/^(\d+)\s+1\/2\b/, "$1.5")
    .replace(/^(\d+)\.0\b/, "$1")
    .trim();
}

export function snapStandardSize(value: string, allowed: string[]): string | null {
  const exact = matchAllowed(value, allowed);
  if (exact) return exact;
  const norm = normalizeSizeToken(value);
  return norm ? matchAllowed(norm, allowed) : null;
}

// Snap size specifics onto eBay's standard values; drop an OPTIONAL size we
// can't map (a missing UK size beats a rejected listing). Required sizes are
// left for validateAspects to flag so the seller picks a value. Returns the
// names of aspects that were dropped.
export function snapStandardSizes(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
): string[] {
  const dropped: string[] = [];
  for (const a of meta) {
    const vals = aspects[a.name];
    if (!vals?.length || !isStandardSizeAspect(a)) continue;
    const snapped = vals
      .map((v) => snapStandardSize(v, a.values))
      .filter((v): v is string => Boolean(v));
    if (snapped.length) aspects[a.name] = [...new Set(snapped)];
    else if (!a.required) {
      delete aspects[a.name];
      dropped.push(a.name);
    }
  }
  return dropped;
}
