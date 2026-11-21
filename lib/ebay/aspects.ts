// Small helpers for eBay item-specifics (aspects), shared between the publish
// pipeline and the model-assisted aspect filler.

import type { AspectMeta } from "./taxonomy";
import { parseUsShoeSize } from "./shoe-size";

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
// values (error 25129: "no longer support custom values for Size" / "…for UK
// Shoe Size") even where the Taxonomy API still reports the aspect as
// FREE_TEXT. Those aspects are treated as selection-only when eBay supplies a
// value list: every "* Shoe Size", and the plain "Size" of an apparel category.
//
// "Size" also exists outside fashion (rugs "5x8", bedding "Queen", art
// "16x20 in"), where eBay still takes custom text — so the lock applies only
// when the category looks like apparel: it has Department / Size Type / shoe
// sizes, or its Size list is made of clothing sizes. (The second test matters:
// apparel filed under Collectibles has no Department but is still enforced.)
const SHOE_SIZE_RE = /\bshoe size\b/i;
const PLAIN_SIZE_RE = /^size$/i;
const LETTER_SIZES = new Set(["xs", "s", "m", "l", "xl"]);

function looksLikeApparelSizes(values: string[]): boolean {
  let letters = 0;
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (LETTER_SIZES.has(k)) letters++;
    else if (/^\dt$/.test(k) || /^\d+-\d+ months$/.test(k)) return true;
  }
  return letters >= 3;
}

export function isStandardSizeAspect(
  a: AspectMeta,
  all: AspectMeta[] = [a],
): boolean {
  if (!a.values.length) return false;
  if (SHOE_SIZE_RE.test(a.name)) return true;
  if (!PLAIN_SIZE_RE.test(a.name.trim())) return false;
  return (
    all.some(
      (m) =>
        /^(size type|department)$/i.test(m.name.trim()) ||
        SHOE_SIZE_RE.test(m.name),
    ) || looksLikeApparelSizes(a.values)
  );
}

// "UK 7" → "7", "EU 40.0" → "40", "7 1/2" → "7.5", "Women's US 8" → "8",
// "Size 08" → "8", "Youth L" → "L".
function normalizeSizeToken(value: string): string {
  let s = value.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(/^(?:size|sz)\b[.:]?\s*/i, "")
      .replace(
        /^(?:(?:wo)?men'?s?|ladies'?|misses'?|juniors?'?|girls?'?|boys?'?|kids?'?|youth|unisex|adults?|[wm](?=\s+\d))\s+/i,
        "",
      )
      .replace(/^(?:uk|eu|us)\b\s*/i, "")
      .replace(/^(?:uk|eu|us)(?=\d)/i, "")
      .trim();
    if (s === before) break;
  }
  return s
    .replace(/^(\d+)\s+1\/2\b/, "$1.5")
    .replace(/^(\d+)\.0\b/, "$1")
    .replace(/^0(?=[1-9])/, "")
    .trim();
}

// Spellings of the same letter size; eBay's list uses one of them per category.
const LETTER_SIZE_ALIASES: string[][] = [
  ["XXS", "2XS", "XX-Small", "XX Small", "Extra Extra Small"],
  ["XS", "X-Small", "X Small", "Extra Small"],
  ["S", "Small", "SM"],
  ["M", "Medium", "Med", "MD"],
  ["L", "Large", "LG"],
  ["XL", "X-Large", "X Large", "Extra Large", "1X", "1XL"],
  ["XXL", "2XL", "2X", "XX-Large", "XX Large", "Extra Extra Large"],
  ["XXXL", "3XL", "3X", "XXX-Large"],
  ["XXXXL", "4XL", "4X"],
  ["One Size", "OS", "O/S", "OSFA", "OSFM", "One Size Fits All", "One Size Fits Most"],
  ["Newborn", "NB", "New Born"],
];

const FIT_WORD_RE = /\b(petite|tall|plus|short|long|regular|big)\b/gi;
const MIN_WAIST = 22;
const MIN_INSEAM = 24;

function matchSizeToken(
  value: string,
  allowed: string[],
  depth = 0,
): string | null {
  const exact = matchAllowed(value, allowed);
  if (exact) return exact;
  const norm = normalizeSizeToken(value);
  if (!norm) return null;
  const hit = matchAllowed(norm, allowed);
  if (hit) return hit;
  const key = norm.toLowerCase();
  const group = LETTER_SIZE_ALIASES.find((g) =>
    g.some((v) => v.toLowerCase() === key),
  );
  for (const alias of group ?? []) {
    const m = allowed.find((v) => v.toLowerCase() === alias.toLowerCase());
    if (m) return m;
  }
  if (depth > 1) return null;
  const again = (v: string) => matchSizeToken(v, allowed, depth + 1);

  // Baby sizes: "3-6M", "18 mo" → "3-6 Months", "18 Months".
  const months = /^(\d+)(?:\s*-\s*(\d+))?\s*(?:m|mo|mos|mths?|months?)\.?$/i.exec(norm);
  if (months) {
    const n = months[2] ? `${months[1]}-${months[2]}` : months[1];
    return matchAllowed(`${n} Months`, allowed);
  }
  // "M (8-10)" → the labelled size before the bracket.
  const paren = /^([^()]+?)\s*\(.*\)$/.exec(norm);
  if (paren) return again(paren[1]);
  // Waist × inseam ("32x30", "W32 L30", "32W 30L", "Waist 32") → the waist.
  const pants =
    /^(?:w(?:aist)?\s*)?(\d{2})\s*w?\s*(?:[x×*]|\s)\s*(?:l\s*)?(\d{2})\s*l?$/i.exec(norm) ??
    /^w(?:aist)?\s*(\d{2})()$/i.exec(norm);
  if (
    pants &&
    Number(pants[1]) >= MIN_WAIST &&
    (!pants[2] || Number(pants[2]) >= MIN_INSEAM)
  )
    return matchAllowed(pants[1], allowed);
  // Fit written out ("8 Petite", "Large Tall", "Plus 2X"): eBay may list the
  // combined size ("8P", "LT") or keep the fit in Size Type and list the base.
  if (FIT_WORD_RE.test(norm)) {
    FIT_WORD_RE.lastIndex = 0;
    const fit = norm.match(FIT_WORD_RE)![0].toLowerCase();
    const base = norm.replace(FIT_WORD_RE, "").replace(/\s+/g, " ").trim();
    if (!base) return null;
    const letter = { petite: "P", tall: "T", plus: "W" }[fit];
    const baseHit = again(base);
    if (letter) {
      const core = baseHit ?? base;
      const combined =
        matchAllowed(`${core}${letter}`, allowed) ??
        (letter === "P" ? matchAllowed(`P${core}`, allowed) : null);
      if (combined) return combined;
    }
    return baseHit;
  }
  // Fit as a letter ("LT", "XLT", "PM", "8P", "40R") when eBay lists only the base.
  const compact =
    /^((?:\dx|x{1,3})?[sml]|\dxl)[tp]$/i.exec(norm) ??
    /^p((?:x{1,3})?[sml])$/i.exec(norm) ??
    /^y((?:x)?[sml]|xl)$/i.exec(norm) ??
    /^(\d{1,2})[pwtrsl]$/i.exec(norm);
  if (compact) return again(compact[1]);
  return null;
}

// `region` is the size system the aspect wants ("US" for plain Size on eBay US,
// "UK" for UK Shoe Size…). A label printed in several systems
// ("US M / UK M / EU M", "US 8 / UK 12 / EU 40") is reduced to that system's
// part; a part with no system prefix is assumed to already be in it. Another
// system's part is only used for letter sizes — UK 12 is not US 12.
//
// Parts with no system are a bilingual tag ("L/G" → L), a waist/inseam pair
// ("32/30" → 32) or a real range ("S/M", "8/10"). A range is only snapped when
// eBay lists it ("10/12" → "10-12"); otherwise it's left for the seller.
export function snapStandardSize(
  value: string,
  allowed: string[],
  region = "US",
): string | null {
  const whole = matchSizeToken(value, allowed);
  if (whole) return whole;
  const parts = value
    .split(/\s*(?:\/|\||,|;)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const dashed = matchAllowed(parts.join("-"), allowed);
  if (dashed) return dashed;
  const system = (p: string) =>
    /^(?:(?:wo)?men'?s\s+)?(uk|eu|us)\b/i.exec(p)?.[1].toUpperCase() ?? "";
  for (const p of parts.filter((p) => system(p) === region)) {
    const m = matchSizeToken(p, allowed);
    if (m) return m;
  }
  const bare = parts.filter((p) => !system(p));
  const bareHits = [
    ...new Set(
      bare
        .map((p) => matchSizeToken(p, allowed))
        .filter((m): m is string => Boolean(m)),
    ),
  ];
  if (bareHits.length === 1) return bareHits[0];
  if (bareHits.length > 1) {
    const nums = bare.map((p) => Number(p));
    const waistInseam =
      bare.length === 2 &&
      bare.every((p) => /^\d{2}$/.test(p)) &&
      nums[0] >= MIN_WAIST &&
      nums[1] >= MIN_INSEAM;
    return waistInseam ? matchAllowed(bare[0], allowed) : null;
  }
  for (const p of parts.filter(
    (p) => system(p) && system(p) !== region && !/\d/.test(p),
  )) {
    const m = matchSizeToken(p, allowed);
    if (m) return m;
  }
  return null;
}

function sizeRegion(aspectName: string): string {
  return /^(uk|eu|us)\b/i.exec(aspectName.trim())?.[1].toUpperCase() ?? "US";
}

const SHOE_DEPT_RE = /\b(?:(?:wo)?men'?s?|wmns|ladies|w|m)\b/i;

// "8 M", "8.5W", "9.5 Wide", "US M 10 D / UK 9 / EU 44" → the bare US number.
function snapUsShoeSize(
  value: string,
  allowed: string[],
  aspects: Record<string, string[]>,
): string | null {
  const d = (aspects.Department?.[0] ?? "").toLowerCase();
  const dept = /wom[ae]n|girl/.test(d) ? "women" : /\bmen|boy/.test(d) ? "men" : "";
  const cleaned = value.replace(
    /\s*\b(?:extra\s+wide|x-?wide|wide|narrow|medium|regular)\s*$/i,
    "",
  );
  const parsed = parseUsShoeSize(cleaned, dept);
  return parsed ? matchAllowed(parsed.size, allowed) : null;
}

// Snap size specifics onto eBay's standard values. A regional shoe size we
// can't map is dropped when optional (a missing UK size beats a rejected
// listing). The main "Size" is never dropped silently — eBay can hide a
// fashion listing with no size — so it stays for validateAspects to flag and
// the seller picks the closest value. Required sizes are flagged the same way.
// Returns the names of aspects that were dropped.
export function snapStandardSizes(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
): string[] {
  const dropped: string[] = [];
  for (const a of meta) {
    const vals = aspects[a.name];
    if (!vals?.length || !isStandardSizeAspect(a, meta)) continue;
    const usShoe = /^us shoe size/i.test(a.name.trim());
    const generic = (v: string) =>
      snapStandardSize(v, a.values, sizeRegion(a.name));
    // A shoe label naming a department ("US Men 4.5 / Women 6") must be read
    // against the item's own department, never by stripping the words.
    const snapped = vals
      .map((v) => {
        if (!usShoe) return generic(v);
        const exact = matchAllowed(v, a.values);
        if (exact) return exact;
        return SHOE_DEPT_RE.test(v)
          ? snapUsShoeSize(v, a.values, aspects)
          : (generic(v) ?? snapUsShoeSize(v, a.values, aspects));
      })
      .filter((v): v is string => Boolean(v));
    if (snapped.length) aspects[a.name] = [...new Set(snapped)];
    else if (!a.required && !PLAIN_SIZE_RE.test(a.name.trim())) {
      delete aspects[a.name];
      dropped.push(a.name);
    }
  }
  // Shoe categories have no "Size" specific — the size lives in US/UK/EU Shoe
  // Size. The raw printed label ("US M 10 D / UK 9 / EU 44") would otherwise go
  // out as a custom "Size" specific, which is exactly what eBay now rejects.
  const hasSize = meta.some((a) => PLAIN_SIZE_RE.test(a.name.trim()));
  if (!hasSize && meta.some((a) => /^us shoe size/i.test(a.name.trim()))) {
    for (const key of Object.keys(aspects))
      if (PLAIN_SIZE_RE.test(key.trim())) {
        delete aspects[key];
        dropped.push(key);
      }
  }
  return dropped;
}
