// eBay publish pipeline, ported from ebay_lister_v2_robust.py.
// Sequence: upload photos → create inventory item → create offer → publish,
// with recovery for missing item specifics, rejected conditions, and non-leaf
// categories.

import {
  EBAY_ACC_BASE,
  EBAY_CURRENCY,
  EBAY_INV_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_TRADING,
} from "./config";
import {
  suggestLeafCategories,
  categoryAspects,
  acceptedConditionIds,
  type AspectMeta,
} from "./taxonomy";
import {
  clipAspectValue,
  cleanAspectValue,
  splitAspectValues,
  matchAllowed,
  canonicalizeAspectKeys,
  enforceCardinality,
  sanitizeNumericAspects,
} from "./aspects";
import { fillRecommendedAspects } from "./aspectFill";
import { extractProductIdentifiers, hasCatalogIdentifier, realBrand } from "./identifiers";
import { parseMeasurements } from "@/lib/measurements";
import { ebayPackageFromEstimate, estimateShipping } from "@/lib/shipping/estimate";
import { APPAREL_CATEGORIES, PANTS_CATEGORIES } from "@/lib/categories";
import type { ListingResult } from "@/lib/types";

// ── Constants (from the Python script) ───────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  womens_top: "15724", womens_dress: "63861", womens_skirt: "11554",
  womens_pants: "57988", womens_coat: "57990", womens_sweater: "63864",
  womens_jeans: "11554", womens_clothing: "15724", womens_shoes: "3034",
  mens_top: "57991", mens_pants: "57989", mens_coat: "57988",
  mens_sweater: "11484", mens_jeans: "11483", mens_clothing: "1059",
  mens_shoes: "93427", handbag: "169291", wallet: "2996", jewelry: "281",
  scarf: "45238", belt: "2996", sunglasses: "79720", hat: "52382",
  accessory: "4250", doll: "22733", collectible: "1463", collector_plate: "1467",
  toy: "2550", home_decor: "10033", book: "267", knife: "7313",
  sporting_goods: "159044", electronics: "293", camera: "625", audio: "293",
  video_game: "139973", media: "11232", vinyl_record: "176985", cd: "176984",
  dvd_bluray: "617", musical_instrument: "619", kitchenware: "20625",
  glassware: "50693", pottery_ceramics: "24", art: "550", craft: "14339",
  tool: "631", automotive: "6028", office: "25298", health_beauty: "26395",
  small_appliance: "20667", lighting: "20697", linens: "20444", holiday: "16086",
  board_game: "233", puzzle: "2613", plush: "2624", action_figure: "246",
  trading_card: "183050", sports_memorabilia: "64482", coin: "11116",
  stamp: "260", ephemera: "165800", other: "99",
};

// NOTE: category fallbacks used to be a static list of unrelated collectible
// leaves (dolls, plush, puzzles…) tried blindly whenever eBay rejected the
// chosen category. Publishing a dress into "Puzzles" technically succeeds and
// commercially fails — so fallbacks now come from eBay's own runner-up
// category suggestions for THIS item, and when none work the publish stops
// with an actionable error instead of landing in a wrong category.

const CONDITION_ALIASES: Record<string, string> = {
  NEW: "NEW_WITH_TAGS",
  NWT: "NEW_WITH_TAGS",
  NEW_WITH_TAGS: "NEW_WITH_TAGS",
  NEW_WITH_BOX: "NEW_WITH_TAGS",
  NEW_WITHOUT_TAGS: "NEW_NO_TAGS",
  NEW_WITHOUT_BOX: "NEW_NO_TAGS",
  NEW_NO_TAGS: "NEW_NO_TAGS",
  NEW_OTHER: "NEW_NO_TAGS",
  OPEN_BOX: "NEW_NO_TAGS",
  LIKE_NEW: "EXCELLENT",
  PREOWNED_EXCELLENT: "EXCELLENT",
  PRE_OWNED_EXCELLENT: "EXCELLENT",
  USED_EXCELLENT: "EXCELLENT",
  EXCELLENT: "EXCELLENT",
  VERY_GOOD: "VERY_GOOD",
  PREOWNED_VERY_GOOD: "VERY_GOOD",
  PRE_OWNED_VERY_GOOD: "VERY_GOOD",
  USED_VERY_GOOD: "VERY_GOOD",
  USED: "GOOD",
  PREOWNED: "GOOD",
  PRE_OWNED: "GOOD",
  USED_GOOD: "GOOD",
  PREOWNED_GOOD: "GOOD",
  PRE_OWNED_GOOD: "GOOD",
  GOOD: "GOOD",
  ACCEPTABLE: "FAIR",
  USED_ACCEPTABLE: "FAIR",
  FAIR: "FAIR",
  PREOWNED_FAIR: "FAIR",
  PRE_OWNED_FAIR: "FAIR",
  USED_FAIR: "FAIR",
};

const CONDITION_ID_ENUM: Record<number, string> = {
  1000: "NEW",
  1500: "NEW_OTHER",
  1750: "NEW_WITH_DEFECTS",
  2750: "LIKE_NEW",
  2990: "PRE_OWNED_EXCELLENT",
  3000: "USED_EXCELLENT",
  3010: "PRE_OWNED_FAIR",
  4000: "USED_VERY_GOOD",
  5000: "USED_GOOD",
  6000: "USED_ACCEPTABLE",
  7000: "FOR_PARTS_OR_NOT_WORKING",
};

const GENERAL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [3000, 2750, 4000, 5000],
  VERY_GOOD: [4000, 3000, 5000, 2750],
  GOOD: [5000, 4000, 3000, 6000],
  FAIR: [6000, 5000, 4000, 3000],
};

const APPAREL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [2990, 3000, 3010],
  // eBay has no apparel "Very Good" tier. Use Good before overgrading as Excellent.
  VERY_GOOD: [3000, 2990, 3010],
  GOOD: [3000, 3010, 2990],
  FAIR: [3010, 3000, 2990],
};

const GENERAL_SAFE_CONDITION_IDS = [3000, 4000, 5000, 6000, 2750, 1500, 1000, 1750, 7000];
const APPAREL_SAFE_CONDITION_IDS = [3000, 2990, 3010, 1500, 1000, 1750];

const ASPECT_DEFAULTS: Record<string, string> = {
  "Skirt Length": "Knee-Length", "Dress Length": "Knee-Length", Rise: "Mid Rise",
  "Leg Style": "Straight", Closure: "Pull-On", "Shoe Width": "Medium",
  "Heel Height": "Flat", "Toe Shape": "Round", Adjustable: "Yes",
  "Exterior Pockets": "Yes", Lining: "Lined", Hood: "No Hood", "Bag Closure": "Zip",
  "Strap Type": "Adjustable", "Hat Style": "Baseball Cap", "Brim Style": "Curved Bill",
  "Size Type": "Regular", Style: "Casual", Department: "Unisex Adult",
  Type: "Item", Brand: "Unbranded", Color: "Multicolor", Material: "Mixed Materials",
};

// eBay's size standardization (enforced July 2026) blocks or holds listings
// whose Size is a placeholder or non-standard value, so size aspects are only
// ever filled from real listing data — never from defaults or guesses.
// "Size Type" (Regular/Plus/Petite/…) is exempt: it's a fit class, not a size.
function isSizeAspect(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("size") && !n.includes("size type");
}

const PLACEHOLDER_SIZE_RE =
  /^(see\s|refer\s|check\s|unknown\b|n\/?a\b|none\b|not\s|no\s(size|tag)|[-?]+$|tbd\b)/i;

function cleanSize(raw: unknown): string {
  const s = String(raw || "").trim();
  return PLACEHOLDER_SIZE_RE.test(s) ? "" : s;
}

// ── eBay REST client (token-authed) ──────────────────────────────────────────

interface EbayResp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function ebayRequest(
  accessToken: string,
  method: string,
  url: string,
  opts: { body?: unknown; extraHeaders?: Record<string, string> } = {}
): Promise<EbayResp> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Node's fetch defaults Accept-Language to "*", which eBay rejects
      // (error 25709). Pin it to a valid locale.
      "Accept-Language": "en-US",
      ...(opts.extraHeaders || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. empty 204) */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The price the seller reviewed and approved is the price that publishes.
// (This used to silently apply an 18% markup and quietly default a missing
// price to $29.99 → $35.39 — hiding unidentified items behind a made-up
// number instead of stopping for review.) Returns null when there is no
// usable price, which blocks the publish with an actionable error.
export function validListingPrice(raw: number | string | undefined): number | null {
  const base = typeof raw === "string" ? parseFloat(raw) : raw;
  if (base === undefined || Number.isNaN(base) || base <= 0) return null;
  return Math.round(base * 100) / 100;
}

// eBay's CALCULATED-shipping business policies REQUIRE package weight (and
// dimensions) on the inventory item, or publish fails with error 25020 ("package
// weight is not valid or is missing"). Flat-rate policies don't need it.
//
// One 16 oz / 12×9×3 default for everything undercharged shipping badly for
// coats, boots, appliances, and framed art, so defaults are now profiled by
// item class. The seller can still refine weight/size on the listing afterward.
// Explicitly-set EBAY_DEFAULT_PACKAGE_* env vars override every profile.
// Weight is in ounces (16 oz = 1 lb); dimensions in inches.
//
// packageType is ALWAYS "PACKAGE_THICK_ENVELOPE" — eBay US's generic
// "Package (or thick envelope)" type used for ordinary boxes too. Other enum
// values from the Inventory API schema (e.g. MAILING_BOX) are rejected by the
// US marketplace with error 25101 "Invalid <ShippingPackage>", and only
// weight + dimensions actually drive calculated-shipping cost.
export const SAFE_PACKAGE_TYPE = "PACKAGE_THICK_ENVELOPE";

interface PackageProfile {
  oz: number;
  l: number;
  w: number;
  h: number;
}

const DEFAULT_PACKAGE: PackageProfile = { oz: 16, l: 12, w: 9, h: 3 };

const PACKAGE_PROFILES: Record<string, PackageProfile> = (() => {
  const size = (oz: number, l: number, w: number, h: number): PackageProfile => ({
    oz, l, w, h,
  });
  const profiles: Record<string, PackageProfile> = {};
  const assign = (keys: string[], p: PackageProfile) =>
    keys.forEach((k) => (profiles[k] = p));
  assign(["womens_coat", "mens_coat"], size(40, 16, 12, 5));
  assign(["womens_shoes", "mens_shoes"], size(48, 14, 10, 6));
  assign(["handbag"], size(24, 14, 11, 4));
  assign(
    ["small_appliance", "electronics", "camera", "audio", "musical_instrument", "tool", "automotive", "kitchenware", "sporting_goods"],
    size(48, 14, 11, 6)
  );
  assign(["art", "collector_plate"], size(48, 20, 16, 4));
  assign(["glassware", "pottery_ceramics", "doll", "collectible", "holiday", "home_decor", "lighting"], size(32, 12, 10, 8));
  assign(["book", "media", "cd", "dvd_bluray", "video_game"], size(12, 12, 9, 2));
  assign(["vinyl_record"], size(16, 14, 14, 2));
  assign(["linens", "plush"], size(20, 14, 11, 4));
  return profiles;
})();

/**
 * Package weight/size for the inventory item.
 *
 * Order of preference, best first:
 *   1. The per-item shipping estimate derived from the photos and the chosen
 *      box (lib/shipping). This is what makes calculated shipping quote buyers
 *      correctly — a class default sends a cast-iron pan as a 1 lb envelope and
 *      the seller eats the difference on every sale.
 *   2. An explicit EBAY_DEFAULT_PACKAGE_* env override.
 *   3. The per-item-class profile, which is a guess and always was.
 */
export function defaultPackageWeightAndSize(
  catKey: string,
  listing?: ListingResult
): Record<string, unknown> {
  const profile = PACKAGE_PROFILES[catKey] ?? DEFAULT_PACKAGE;
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  let derived: { weightOz: number; l: number; w: number; h: number } | null = null;
  if (listing) {
    const estimate = estimateShipping({
      itemOz: listing.shipping_weight_oz,
      itemDims: {
        l: Number(listing.shipping_length_in) || undefined,
        w: Number(listing.shipping_width_in) || undefined,
        h: Number(listing.shipping_height_in) || undefined,
      },
      category: catKey,
    });
    // Use the estimate as soon as ANYTHING was actually supplied — by the model
    // or, more importantly, typed in by the seller.
    //
    // This used to require estimate.basis === "photos", which demands a weight
    // AND all three dimensions. The model is instructed to return 0 rather than
    // invent a dimension, so it usually does; a seller who corrected just the
    // weight therefore failed that test and had their figure thrown away in
    // favour of the class profile. An edit that silently does nothing is worse
    // than no edit box at all.
    const p = estimate.provided;
    if (p.weight || p.l || p.w || p.h) {
      derived = ebayPackageFromEstimate(estimate);
    }
  }

  // Precedence, most specific first: what this item says, then a deployment-wide
  // override, then the class profile. The env override used to sit at the top
  // and outrank a per-item edit, which is backwards — a global default is the
  // crudest source here, not the finest.
  const pick = (own: number | undefined, env: string | undefined, fallbackValue: number) =>
    own !== undefined && Number.isFinite(own) && own > 0 ? own : num(env, fallbackValue);

  return {
    weight: {
      value: pick(derived?.weightOz, process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ, profile.oz),
      unit: "OUNCE",
    },
    dimensions: {
      length: pick(derived?.l, process.env.EBAY_DEFAULT_PACKAGE_LENGTH_IN, profile.l),
      width: pick(derived?.w, process.env.EBAY_DEFAULT_PACKAGE_WIDTH_IN, profile.w),
      height: pick(derived?.h, process.env.EBAY_DEFAULT_PACKAGE_HEIGHT_IN, profile.h),
      unit: "INCH",
    },
    packageType: SAFE_PACKAGE_TYPE,
  };
}

export function normalizeConditionInput(value: string | undefined): string {
  const cleaned = (value || "GOOD")
    .trim()
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CONDITION_ALIASES[cleaned] || "GOOD";
}

function isApparelConditionPolicy(acceptedIds: Set<number>): boolean {
  return acceptedIds.has(2990) || acceptedIds.has(3010);
}

function conditionIdsForGrade(
  grade: string,
  acceptedIds: Set<number>,
  catKey: string
): number[] {
  // When eBay's condition metadata is unavailable, fall back to the category
  // key so apparel still prefers 2990 (Pre-owned – Excellent). Without this,
  // a silent metadata failure sent every clothing item as id 3000 — which eBay
  // displays as "Pre-owned – Good" in fashion categories, whatever the grade.
  const apparel =
    isApparelConditionPolicy(acceptedIds) ||
    (!acceptedIds.size && APPAREL_CATEGORIES.has(catKey));
  const preferences = apparel ? APPAREL_CONDITION_ID_PREFERENCES : GENERAL_CONDITION_ID_PREFERENCES;
  const safeIds = apparel ? APPAREL_SAFE_CONDITION_IDS : GENERAL_SAFE_CONDITION_IDS;
  const preferred = preferences[grade] || preferences.GOOD;

  if (!acceptedIds.size) return preferred;

  const out: number[] = [];
  const add = (id: number) => {
    if (acceptedIds.has(id) && CONDITION_ID_ENUM[id] && !out.includes(id)) out.push(id);
  };
  for (const id of preferred) add(id);
  for (const id of safeIds) add(id);
  for (const id of acceptedIds) add(id);
  return out.length ? out : preferred;
}

// Ordered eBay Inventory condition enums to try for an internal grade. The grade
// comes from photo analysis; the allowed IDs come from the chosen leaf category's
// Metadata policy, so apparel/books/electronics/etc. can each resolve differently.
export function conditionCandidates(
  grade: string | undefined,
  acceptedIds: Set<number>,
  catKey: string
): string[] {
  const desired = normalizeConditionInput(grade);
  const out: string[] = [];
  for (const id of conditionIdsForGrade(desired, acceptedIds, catKey)) {
    const en = CONDITION_ID_ENUM[id];
    if (en && !out.includes(en)) out.push(en);
  }
  return out.length ? out : ["USED_GOOD"];
}

// Offline/static category resolution — used only when eBay's Taxonomy
// suggestions are unavailable.
export function staticCategory(listing: ListingResult): string {
  const explicit = (listing.category_id || "").toString().trim();
  const catKey = (listing.category || "other").toString();
  return explicit || CATEGORY_MAP[catKey] || CATEGORY_MAP.other;
}

// First clean value of a possibly-compound field ("Cotton / Poly" → "Cotton").
// Placeholder phrases ("See tag in photos") come back as "".
function singleValue(v: unknown): string {
  return splitAspectValues(v)[0] || "";
}

function departmentForCategory(catKey: string): string {
  if (catKey.startsWith("womens_")) return "Women";
  if (catKey.startsWith("mens_")) return "Men";
  return "Unisex Adult";
}

// Build the item-specifics (aspects) map from the listing. Values are kept as
// full arrays here ("Cotton / Polyester" → both parts survive); once eBay's
// aspect metadata arrives, enforceCardinality() trims single-value aspects.
// Placeholder phrases ("See tag in photos") never become aspect values —
// cleanAspectValue/splitAspectValues drop them at the door.
export function buildAspects(listing: ListingResult, catKey: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const putOne = (k: string, v: string) => {
    const val = cleanAspectValue(v);
    if (val) aspects[k] = [val];
  };
  const putMany = (k: string, v: unknown) => {
    const vals = splitAspectValues(v);
    if (vals.length) aspects[k] = vals;
  };

  putOne("Brand", String(listing.brand || "").trim());
  putOne("Size", cleanSize(listing.size));
  putMany("Color", listing.color);
  putMany("Material", listing.material);
  putOne("Type", String(listing.item_type || "").trim());

  const feats = Array.isArray(listing.key_features) ? listing.key_features : [];
  const cleanFeats = feats.map((f) => cleanAspectValue(String(f))).filter(Boolean).slice(0, 5);
  if (cleanFeats.length) aspects.Features = cleanFeats;

  if (APPAREL_CATEGORIES.has(catKey) || catKey === "accessory") {
    aspects.Department = [departmentForCategory(catKey)];
  }

  // Measurements go to eBay aspects only when explicitly labeled — never the
  // whole free-text blob (which once produced Inseam = "Waist 32 in, rise 11…").
  if (PANTS_CATEGORIES.has(catKey)) {
    const parsed = parseMeasurements(listing.measurements);
    if (parsed.inseam) aspects.Inseam = [parsed.inseam];
    if (parsed.waist && !aspects["Waist Size"]) aspects["Waist Size"] = [parsed.waist];
    if (parsed.rise && !aspects.Rise) aspects.Rise = [parsed.rise];
  }

  // Merge in the model-provided item specifics (skip blanks + section labels).
  for (const [k, v] of Object.entries(listing.item_specifics || {})) {
    if (!k || k.startsWith("---")) continue;
    const vals = splitAspectValues(v);
    if (vals.length && !aspects[k]) aspects[k] = vals;
  }
  return aspects;
}

// ── Required-aspect reconciliation (driven by eBay's Taxonomy data) ──────────
//
// The static defaults above can't know what each leaf category requires, nor
// which values its SELECTION_ONLY aspects accept. We ask eBay for both and make
// every required aspect valid before publishing — eliminating the 25002 errors.

// Choose a valid Department from the category's own allowed values, biased by
// the item's gender cues. Kids categories only allow Boys/Girls/Unisex Kids, so
// a blind "Unisex Adults" default would still fail — we match against the list.
function pickDepartment(allowed: string[], listing: ListingResult, catKey: string): string {
  const text = `${catKey} ${listing.title || ""} ${listing.item_type || ""} ${
    listing.item_specifics?.Department || ""
  }`.toLowerCase();
  const women = catKey.startsWith("womens_") || /\b(women|woman|ladies|female|girl)\b/.test(text);
  const men = catKey.startsWith("mens_") || /\b(men|man|male|boy)\b/.test(text);
  const pref = women
    ? ["Women", "Women's", "Girls", "Unisex Adults", "Unisex Kids", "Unisex"]
    : men
      ? ["Men", "Men's", "Boys", "Unisex Adults", "Unisex Kids", "Unisex"]
      : ["Unisex Adults", "Unisex Kids", "Unisex", "Women", "Men"];
  for (const p of pref) {
    const m = matchAllowed(p, allowed);
    if (m) return m;
  }
  return allowed[0] || "";
}

// Best free-text fill for a required aspect we don't already have, drawn from
// the listing itself. eBay accepts any string for FREE_TEXT aspects.
// "Unbranded"/"Multicolor" are eBay's own canonical values for genuinely
// unbranded/multicolored items; placeholder phrases are filtered out so
// "See tag in photos" can never become a searchable specific.
function freeTextDefault(name: string, listing: ListingResult): string {
  const n = name.toLowerCase();
  const clean = (v: unknown) => cleanAspectValue(String(v ?? "").trim());
  if (n.includes("brand")) return clean(listing.brand) || "Unbranded";
  if (n.includes("color")) return singleValue(listing.color) || "Multicolor";
  if (n.includes("shoe size") || n === "size") return cleanSize(listing.size);
  if (n.includes("material")) return singleValue(listing.material);
  if (n.includes("style")) return clean(listing.item_specifics?.Style || listing.item_type);
  if (n.includes("type")) return clean(listing.item_type);
  return "";
}

// Make every REQUIRED aspect present and valid. Mutates `aspects` in place.
export function reconcileAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  listing: ListingResult,
  catKey: string
): void {
  for (const a of meta) {
    if (!a.required || !a.name) continue;
    const current = aspects[a.name] ?? [];

    if (a.mode === "SELECTION_ONLY") {
      // Must be one of eBay's allowed values, or the publish 25002-fails.
      // Keep every valid value the listing already has (MULTI aspects may
      // legitimately carry several).
      const valid: string[] = [];
      for (const v of current) {
        const m = matchAllowed(v, a.values);
        if (m && !valid.includes(m)) valid.push(m);
      }
      if (valid.length) {
        aspects[a.name] = valid;
        continue;
      }
      // Size aspects never fall back to a guessed value — a wrong size
      // mislabels the item and trips eBay's standardization enforcement.
      const canonical = isSizeAspect(a.name)
        ? ""
        : matchAllowed(ASPECT_DEFAULTS[a.name] || "", a.values) ||
          (a.name === "Department" ? pickDepartment(a.values, listing, catKey) : "") ||
          a.values[0] ||
          "";
      if (canonical) aspects[a.name] = [canonical];
      else if (isSizeAspect(a.name)) delete aspects[a.name];
    } else if (!current.length) {
      // FREE_TEXT and unset — fill from the listing or a sensible default.
      const fromListing = freeTextDefault(a.name, listing);
      const v =
        fromListing ||
        (isSizeAspect(a.name) ? "" : ASPECT_DEFAULTS[a.name] || a.values[0] || "");
      const clipped = clipAspectValue(v, a.maxLength);
      if (clipped) aspects[a.name] = [clipped];
    }
  }
}

// ── eBay error parsing (from the script) ─────────────────────────────────────

function errorIds(r: EbayResp): number[] {
  try {
    return (r.json?.errors || []).map((e: any) => Number(e.errorId || 0));
  } catch {
    return [];
  }
}

// eBay's Inventory API intermittently fails with 25001 ("A system error has
// occurred. Core Inventory Service internal error") or a bare 5xx. These are
// eBay-side blips that normally succeed on retry (issue #16), so every write
// call gets a short backoff-and-retry before we surface the failure.
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 1500;

function isTransientEbayError(r: EbayResp): boolean {
  return r.status >= 500 || errorIds(r).includes(25001);
}

async function withTransientRetry(
  call: () => Promise<EbayResp>,
  label: string,
  sku: string
): Promise<EbayResp> {
  let r = await call();
  for (let attempt = 1; attempt <= TRANSIENT_RETRIES && isTransientEbayError(r); attempt++) {
    console.warn(
      `[ebay/publish] sku=${sku} ${label} hit transient eBay error ` +
        `(status=${r.status} ids=${errorIds(r).join(",") || "none"}) — retry ${attempt}/${TRANSIENT_RETRIES}`
    );
    await new Promise((res) => setTimeout(res, TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1)));
    r = await call();
  }
  return r;
}

// Extra guidance for eBay errors that a seller can act on directly. Keyed by
// errorId; appended to the raw eBay message when surfaced in the UI.
const EBAY_ERROR_HINTS: Record<number, string> = {
  25001:
    "This is a temporary glitch on eBay's side (we already retried automatically). Wait a minute and hit Post again — the listing data itself is fine.",
  25019:
    "eBay rejected the listing's content — usually a restricted or trademarked word in the title/description, or the item is already listed. Edit the title/description and try again.",
};

// Pull eBay's primary error (id + human message) from a failed response, so we
// can log it and show it cleanly instead of dumping raw JSON at the user.
function primaryEbayError(r: EbayResp): { errorId: number; message: string } {
  const err = r.json?.errors?.[0];
  if (err) {
    return {
      errorId: Number(err.errorId || 0),
      message: String(err.longMessage || err.message || "").trim(),
    };
  }
  return { errorId: 0, message: (r.text || "").slice(0, 300) };
}

// One structured log line per publish failure, so Vercel Function Logs actually
// show what eBay rejected. Without this the whole path logged nothing, which is
// why failed requests showed "No logs found for this request".
function logPublishFailure(stage: string, sku: string, r: EbayResp): void {
  const { errorId, message } = primaryEbayError(r);
  console.error(
    `[ebay/publish] ${stage} failed sku=${sku} http=${r.status} errorId=${errorId || "?"} ${message}`
  );
}

// User-facing one-liner: eBay's own reason, tagged with its errorId, plus an
// actionable hint when we have one.
function publishErrorMessage(stage: string, r: EbayResp): string {
  const { errorId, message } = primaryEbayError(r);
  const detail = message || `HTTP ${r.status}`;
  const head = errorId ? `${stage} (eBay error ${errorId}): ${detail}` : `${stage} (${r.status}): ${detail}`;
  const hint = errorId ? EBAY_ERROR_HINTS[errorId] : undefined;
  return hint ? `${head} ${hint}` : head;
}

function extractExistingOfferId(r: EbayResp): string | null {
  for (const err of r.json?.errors || []) {
    if (err.errorId === 25002) {
      for (const p of err.parameters || []) {
        if (p.name === "offerId") return String(p.value);
      }
    }
  }
  return null;
}

function extractMissingAspects(r: EbayResp): string[] {
  const missing: string[] = [];
  for (const err of r.json?.errors || []) {
    const pieces = [err.message, err.longMessage].concat(
      (err.parameters || []).map((p: any) => String(p.value || ""))
    );
    const hay = pieces.join(" | ");
    const re = /item specific ([^|.,;]+?) is missing/gi;
    let m;
    while ((m = re.exec(hay))) {
      const name = m[1].trim();
      if (name) missing.push(name);
    }
  }
  return missing;
}

function addMissingAspects(
  aspects: Record<string, string[]>,
  missing: string[],
  listing: ListingResult
): string[] {
  const added: string[] = [];
  for (const field of missing) {
    // Never stamp a default into a size aspect — let eBay's "missing item
    // specific" error surface so the seller supplies the real size.
    if (isSizeAspect(field)) continue;
    // Real listing data or a known safe default only. Stamping "Unbranded"
    // into arbitrary fields (the old fallback) produced junk like
    // Type = "Unbranded"; if nothing sensible exists, let eBay's error
    // surface and tell the seller exactly which specific is missing.
    const def = ASPECT_DEFAULTS[field] || freeTextDefault(field, listing);
    if (!def) continue;
    aspects[field] = [def];
    added.push(`${field}=${def}`);
  }
  return added;
}

// eBay rejected the VALUE of a specific aspect we sent (25002 "A user error
// has occurred. Fabric weight must be greater than 0. Enter up to 1 number
// after the decimal."). Find which sent aspect the error message names so the
// recovery can drop it and retry — the aspect name must appear as a whole
// word/phrase alongside validation-ish language. "Missing" errors are
// deliberately excluded (extractMissingAspects owns those), and word
// boundaries keep "Brand" from matching eBay's "<BrandMPN>" tag errors.
const ASPECT_VALUE_ERROR_RE =
  /must be|invalid|format|greater than|less than|number|decimal|numeric/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findInvalidValueAspects(
  r: EbayResp,
  aspects: Record<string, string[]>
): string[] {
  const hits: string[] = [];
  for (const err of r.json?.errors || []) {
    for (const piece of [err.message, err.longMessage]) {
      const msg = String(piece || "");
      if (!msg || !ASPECT_VALUE_ERROR_RE.test(msg) || /is missing/i.test(msg)) continue;
      for (const name of Object.keys(aspects)) {
        if (name.length < 3) continue;
        const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
        if (re.test(msg) && !hits.includes(name)) hits.push(name);
      }
    }
  }
  return hits;
}

// Recovery: drop the named aspects and retry once. Losing one searchable
// specific beats failing the whole publish; if the aspect was REQUIRED, eBay's
// next error says exactly which specific is missing, which the seller can act
// on directly.
export function applyInvalidAspectFallback(
  inventoryItem: { product: { aspects?: Record<string, string[]> } },
  aspects: Record<string, string[]>,
  names: string[],
  sku: string
): void {
  for (const n of names) {
    console.warn(
      `[ebay/publish] sku=${sku} eBay rejected the value of aspect "${n}" (${JSON.stringify(
        aspects[n] ?? []
      )}) — retrying without it`
    );
    delete aspects[n];
  }
  inventoryItem.product.aspects = aspects;
}

// eBay's Brand/MPN pair validation (25002, tag <BrandMPN>): fires when an MPN
// arrives without a brand, when the pair doesn't match a catalog product, or
// when a category requires the Brand/MPN aspects and one is absent.
export function isBrandMpnError(r: EbayResp): boolean {
  return /BrandMPN/i.test(r.text || "");
}

// Recovery for a rejected Brand/MPN pair: drop the product-level pair and fall
// back to eBay's own aspect conventions — a Brand (or "Unbranded") plus MPN
// "Does Not Apply". Both are canonical eBay values, not placeholders.
export function applyBrandMpnFallback(
  inventoryItem: { product: { aspects?: Record<string, string[]>; brand?: string; mpn?: string } },
  aspects: Record<string, string[]>,
  listing: ListingResult,
  sku: string
): void {
  console.warn(
    `[ebay/publish] sku=${sku} eBay rejected the Brand/MPN pair (<BrandMPN>) — retrying with aspect-level fallbacks`
  );
  delete inventoryItem.product.brand;
  delete inventoryItem.product.mpn;
  if (!aspects.Brand?.length) {
    aspects.Brand = [cleanAspectValue(String(listing.brand || "").trim()) || "Unbranded"];
  }
  if (!aspects.MPN?.length) aspects.MPN = ["Does Not Apply"];
  inventoryItem.product.aspects = aspects;
}

// eBay rejected the package type for this marketplace (error 25101
// "Invalid <ShippingPackage>") — e.g. an enum value that exists in the
// Inventory API schema but isn't accepted by eBay US.
export function isShippingPackageError(r: EbayResp): boolean {
  return errorIds(r).includes(25101) || /Invalid\s*<?ShippingPackage/i.test(r.text || "");
}

// Recovery for a rejected package: first snap the type to the one value eBay
// US always accepts; if it already was that value, drop the package block
// entirely — flat-rate policies publish fine without it, and calculated ones
// then surface eBay's clearer "package weight is missing" (25020) instead.
export function applyShippingPackageFallback(
  inventoryItem: { packageWeightAndSize?: { packageType?: string } },
  sku: string
): void {
  const pkg = inventoryItem.packageWeightAndSize;
  if (pkg && pkg.packageType !== SAFE_PACKAGE_TYPE) {
    console.warn(
      `[ebay/publish] sku=${sku} eBay rejected packageType ${pkg.packageType} — retrying as ${SAFE_PACKAGE_TYPE}`
    );
    pkg.packageType = SAFE_PACKAGE_TYPE;
  } else {
    console.warn(
      `[ebay/publish] sku=${sku} eBay rejected the shipping package — retrying without packageWeightAndSize`
    );
    delete inventoryItem.packageWeightAndSize;
  }
}

function updateOfferBody(offer: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set(["sku", "marketplaceId", "format"]);
  return Object.fromEntries(Object.entries(offer).filter(([k]) => !skip.has(k)));
}

// ── Photo upload to eBay Picture Services (Trading API, XML) ──────────────────

async function uploadPhoto(
  accessToken: string,
  base64: string,
  mediaType: string,
  name: string
): Promise<string | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${name.slice(0, 50)}</PictureName>
  <PictureUploadPolicy>ClearAndNew</PictureUploadPolicy>
</UploadSiteHostedPicturesRequest>`;

  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  const bytes = Buffer.from(data, "base64");
  const form = new FormData();
  form.append("XML Payload", new Blob([xml], { type: "text/xml;charset=utf-8" }), "payload.xml");
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);

  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body: form,
  });
  const text = await resp.text();
  const m = text.match(/<FullURL>([^<]+)<\/FullURL>/);
  return m ? m[1] : null;
}

// ── Policies & location ──────────────────────────────────────────────────────

export interface FulfillmentPolicySummary {
  id: string;
  name: string;
  /** True when the buyer pays nothing for domestic shipping. */
  free: boolean;
}

export interface AccountSetup {
  /** Default policy (the account's first) — used when nothing better matches. */
  fulfillmentPolicyId: string;
  /** Every domestic fulfillment policy, classified, so a listing can pick. */
  fulfillmentPolicies: FulfillmentPolicySummary[];
  paymentPolicyId: string;
  returnPolicyId: string;
  locationKey: string;
}

function pickFirstPolicy(r: EbayResp, listKey: string, idField: string): string {
  if (!r.ok) return "";
  const list = r.json?.[listKey] || [];
  return list.length ? String(list[0][idField] || "") : "";
}

/**
 * Is this fulfillment policy free-to-the-buyer for domestic shipping?
 *
 * eBay expresses "free" two ways, and a policy is only free if EVERY domestic
 * service is: a policy whose first service is free but which offers a paid
 * expedited upgrade still charges some buyers, so treating it as free would
 * quietly mis-select it. Requiring all of them is the conservative read.
 */
export function isFreeShippingPolicy(policy: Record<string, any>): boolean {
  const domestic = (policy?.shippingOptions ?? []).filter(
    (o: any) => String(o?.optionType ?? "DOMESTIC").toUpperCase() === "DOMESTIC"
  );
  const services = domestic.flatMap((o: any) => o?.shippingServices ?? []);
  if (services.length === 0) return false;
  return services.every((s: any) => {
    if (s?.freeShipping === true) return true;
    const cost = Number(s?.shippingCost?.value);
    return Number.isFinite(cost) && cost === 0;
  });
}

function summarizePolicies(r: EbayResp): FulfillmentPolicySummary[] {
  if (!r.ok) return [];
  return (r.json?.fulfillmentPolicies ?? [])
    .map((p: any) => ({
      id: String(p?.fulfillmentPolicyId ?? ""),
      name: String(p?.name ?? "Unnamed policy"),
      free: isFreeShippingPolicy(p),
    }))
    .filter((p: FulfillmentPolicySummary) => p.id);
}

/**
 * Choose the fulfillment policy matching what this listing asked for.
 *
 * Returns the fallback plus a warning when the account has no policy of the
 * requested kind — publishing under the wrong one silently is how a seller
 * discovers they've been eating postage on forty listings.
 */
export function selectFulfillmentPolicy(
  setup: AccountSetup,
  wantFree: boolean | undefined
): { policyId: string; warning?: string } {
  const policies = setup.fulfillmentPolicies ?? [];
  // Undefined means "no preference" — keep the long-standing behaviour.
  if (wantFree === undefined || policies.length === 0) {
    return { policyId: setup.fulfillmentPolicyId };
  }
  const match = policies.find((p) => p.free === wantFree);
  if (match) return { policyId: match.id };

  const wanted = wantFree ? "free shipping" : "buyer-paid shipping";
  const have = policies.find((p) => p.id === setup.fulfillmentPolicyId);
  return {
    policyId: setup.fulfillmentPolicyId,
    warning:
      `You asked for ${wanted}, but your eBay account has no business policy that does that. ` +
      `Listed under "${have?.name ?? "your default policy"}" (${have?.free ? "free shipping" : "buyer pays"}) instead. ` +
      `Add a matching policy in eBay → Account → Business policies.`,
  };
}

// Policies and location change rarely; refetching them for every item of a
// batch adds four eBay calls per publish. Cache per access token for 10 min.
const setupCache = new Map<string, { setup: AccountSetup; expiresAt: number }>();
const SETUP_TTL_MS = 10 * 60_000;

export async function fetchAccountSetup(accessToken: string): Promise<AccountSetup> {
  const cached = setupCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) return cached.setup;
  const setup = await fetchAccountSetupUncached(accessToken);
  // Only cache complete setups — a transient miss shouldn't stick for 10 min.
  if (setup.fulfillmentPolicyId && setup.paymentPolicyId && setup.returnPolicyId) {
    if (setupCache.size > 50) setupCache.clear();
    setupCache.set(accessToken, { setup, expiresAt: Date.now() + SETUP_TTL_MS });
  }
  return setup;
}

async function fetchAccountSetupUncached(accessToken: string): Promise<AccountSetup> {
  const mp = `marketplace_id=${EBAY_MARKETPLACE_ID}`;
  const [ful, pay, ret] = await Promise.all([
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/fulfillment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/payment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/return_policy?${mp}`),
  ]);
  return {
    fulfillmentPolicyId: pickFirstPolicy(ful, "fulfillmentPolicies", "fulfillmentPolicyId"),
    fulfillmentPolicies: summarizePolicies(ful),
    paymentPolicyId: pickFirstPolicy(pay, "paymentPolicies", "paymentPolicyId"),
    returnPolicyId: pickFirstPolicy(ret, "returnPolicies", "returnPolicyId"),
    locationKey: await fetchOrCreateLocation(accessToken),
  };
}

async function fetchOrCreateLocation(accessToken: string): Promise<string> {
  const list = await ebayRequest(accessToken, "GET", `${EBAY_INV_BASE}/location`);
  if (list.ok) {
    for (const loc of list.json?.locations || []) {
      if (loc.merchantLocationStatus === "ENABLED" && loc.merchantLocationKey) {
        return loc.merchantLocationKey;
      }
    }
  }
  const key = "HOME_OFFICE";
  const payload = {
    name: "Home Office",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: {
      address: {
        // Set EBAY_LOCATION_POSTAL_CODE to your own ZIP. Only used the first
        // time, to create an inventory location if you don't already have one.
        postalCode: process.env.EBAY_LOCATION_POSTAL_CODE || "10001",
        country: "US",
      },
    },
  };
  await ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/location/${key}`, {
    body: payload,
    extraHeaders: { "Content-Language": "en-US" },
  });
  return key;
}

// ── The full publish flow for one item ───────────────────────────────────────

export interface PublishInput {
  sku: string;
  listing: ListingResult;
  // Base64 photos to upload to eBay in this request (legacy single-request
  // flow — the whole payload counts against Vercel's 4.5 MB body limit).
  images?: { mediaType: string; data: string }[];
  // eBay-hosted photo URLs from /api/ebay/upload-photos. The preferred flow:
  // photos ship in small batches beforehand, so the publish body stays tiny.
  imageUrls?: string[];
}

// Only accept photo URLs that eBay Picture Services itself minted — anything
// else in `imageUrls` is a malformed or tampered request, not our upload flow.
export function sanitizeEbayImageUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      const isEps = host === "ebayimg.com" || host.endsWith(".ebayimg.com");
      if (u.protocol === "https:" && isEps && !out.includes(raw)) out.push(raw);
    } catch {
      /* not a URL — skip */
    }
  }
  return out.slice(0, 12);
}

export interface PublishResult {
  success: boolean;
  sku: string;
  listingId?: string;
  offerId?: string;
  error?: string;
  // The SKU already has a LIVE eBay listing — a duplicate bin batch, not a
  // transient failure. The client uses this to avoid clobbering the earlier item.
  alreadyListed?: boolean;
  // Non-fatal quality problems (e.g. eBay's aspect schema couldn't be
  // retrieved, so the listing published with generic specifics). Surfaced in
  // the UI so degraded listings stop failing silently.
  warnings?: string[];
}

// EBAY_STRICT_QUALITY=1 turns quality warnings into publish failures: better a
// stopped listing than one that quietly published without searchable specifics.
function strictQualityMode(): boolean {
  return process.env.EBAY_STRICT_QUALITY === "1" || /^true$/i.test(process.env.EBAY_STRICT_QUALITY || "");
}

const CL = { "Content-Language": "en-US" };

// A published offer already exists for this SKU (e.g. the same bin code was
// reused for a second batch). Publishing again would silently overwrite the
// LIVE listing's photos/title with the new item's — so we refuse instead.
async function findPublishedOffer(
  accessToken: string,
  sku: string
): Promise<{ offerId: string; listingId: string } | null> {
  const r = await ebayRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE_ID}`
  );
  if (!r.ok) return null; // 404 = no offers for this SKU — normal
  for (const o of r.json?.offers ?? []) {
    if (String(o?.status || "").toUpperCase() === "PUBLISHED") {
      return {
        offerId: String(o.offerId || ""),
        listingId: String(o?.listing?.listingId || ""),
      };
    }
  }
  return null;
}

// Upload photos with limited concurrency, preserving order. Sequential uploads
// were the slowest part of a publish (12 photos ≈ up to a minute on their own)
// and pushed long batches into Vercel's function timeout.
// Exported for /api/ebay/upload-photos, which runs this over small client-side
// batches so the publish request itself carries URLs instead of photo bytes.
export async function uploadPhotos(
  accessToken: string,
  images: { mediaType: string; data: string }[],
  sku: string,
  // Photo numbering offset, so batched uploads name photos K72-O-1 … K72-O-12
  // across batches instead of restarting at 1 in each.
  nameOffset = 0
): Promise<string[]> {
  const results: (string | null)[] = new Array(images.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, images.length) }, async () => {
    while (cursor < images.length) {
      const i = cursor++;
      results[i] = await uploadPhoto(
        accessToken,
        images[i].data,
        images[i].mediaType,
        `${sku}-${nameOffset + i + 1}.jpg`
      );
    }
  });
  await Promise.all(workers);
  return results.filter((u): u is string => Boolean(u));
}

export async function publishListing(
  accessToken: string,
  setup: AccountSetup,
  input: PublishInput
): Promise<PublishResult> {
  const { sku, listing } = input;
  const catKey = String(listing.category || "other");
  const warnings: string[] = [];

  // The seller-reviewed price publishes as-is — no hidden markup, no invented
  // default. A listing with no usable price stops here for review.
  const price = validListingPrice(listing.suggested_price);
  if (price === null) {
    return {
      success: false,
      sku,
      error:
        "This listing has no price. Set a price on the listing card before posting — the analysis couldn't estimate one, and posting with a made-up default would misprice the item.",
    };
  }

  // Ask eBay for the real LEAF category from the title + hint; the runners-up
  // become *relevant* fallbacks if eBay rejects the first pick. Fall back to
  // the static map only if Taxonomy is unavailable. (Fixes 25005 non-leaf errors.)
  const suggestions = await suggestLeafCategories(
    `${listing.category_hint || ""} ${listing.title || ""}`,
    3
  );
  let catId = suggestions[0]?.id || staticCategory(listing);
  const fallbacks = suggestions.slice(1).map((s) => s.id);
  if (!suggestions.length) {
    warnings.push(
      "eBay's category suggestions were unavailable — used the offline category map, which may be less precise."
    );
  }

  if (!setup.fulfillmentPolicyId || !setup.paymentPolicyId || !setup.returnPolicyId) {
    return {
      success: false,
      sku,
      error:
        "Your eBay account is missing a business policy (payment, shipping, or returns). Set these up in eBay → Account → Business policies, then try again.",
    };
  }

  // 0. Refuse to clobber a live listing that already uses this SKU (a second
  // batch from the same bin, or a re-post after a page reload).
  const existing = await findPublishedOffer(accessToken, sku);
  if (existing) {
    return {
      success: false,
      sku,
      alreadyListed: true,
      offerId: existing.offerId,
      listingId: existing.listingId,
      error: `SKU ${sku} already has a live eBay listing. If this is a new item from the same bin, give it the next letter (or re-sort — lettering now continues automatically).`,
    };
  }

  // 1. Photo URLs — pre-uploaded by the client in small batches (preferred),
  // or uploaded here from base64 (legacy single-request flow).
  const providedUrls = sanitizeEbayImageUrls(input.imageUrls);
  const legacyImages = Array.isArray(input.images) ? input.images.slice(0, 12) : [];
  const photoUrls = providedUrls.length
    ? providedUrls
    : await uploadPhotos(accessToken, legacyImages, sku);
  if (photoUrls.length === 0) {
    return { success: false, sku, error: "Could not upload any photos to eBay." };
  }

  // 2. Inventory item.
  const aspects = buildAspects(listing, catKey);
  // Ask eBay (in parallel) for the leaf category's specifics and its accepted
  // condition ids, then make both valid before creating the item.
  // Non-fatal by default: the recovery loops below remain as a backup if eBay
  // is slow — but the degradation is now VISIBLE (warning or, in strict
  // quality mode, a hard stop) instead of silently publishing generic data.
  let acceptedConds = new Set<number>();
  let aspectMeta: AspectMeta[] = [];
  try {
    const [meta, conds] = await Promise.all([
      categoryAspects(catId), // required aspects + valid values  → fixes 25002
      // Seller token: the app token can be rejected by the Metadata API, and a
      // silent miss here is what mis-graded conditions (see conditionIdsForGrade).
      acceptedConditionIds(catId, accessToken), // accepted ids   → fixes 25021
    ]);
    aspectMeta = meta;
    if (meta.length) {
      canonicalizeAspectKeys(aspects, meta); // model keys → eBay's exact names
      reconcileAspects(aspects, meta, listing, catKey);
    }
    acceptedConds = conds;
  } catch {
    /* taxonomy/metadata unavailable — handled just below */
  }
  if (!aspectMeta.length) {
    const msg =
      "eBay's item-specifics schema for this category couldn't be retrieved, so searchable specifics may be incomplete.";
    if (strictQualityMode()) {
      return {
        success: false,
        sku,
        error: `${msg} Strict quality mode is on (EBAY_STRICT_QUALITY) — try again in a minute.`,
      };
    }
    console.warn(`[ebay/publish] sku=${sku} category=${catId}: ${msg}`);
    warnings.push(msg);
    // Without eBay's schema we can't prove any aspect accepts multiple values —
    // collapse to one (the long-standing safe behavior). Features is the known
    // exception: eBay accepts several everywhere it exists.
    for (const k of Object.keys(aspects)) {
      if (k !== "Features" && aspects[k].length > 1) aspects[k] = aspects[k].slice(0, 1);
    }
  } else {
    // Category-aware pass with the ORIGINAL PHOTOS + eBay's exact aspect
    // schema — recovers details (model numbers, fabric contents, necklines…)
    // that the first, schema-blind analysis missed. Photos arrive as base64
    // (legacy flow) or as the eBay-hosted URLs (batched-upload flow).
    await fillRecommendedAspects(listing, aspects, aspectMeta, sku, legacyImages, photoUrls);
    // Trim every aspect to a legal value count now that cardinality is known.
    enforceCardinality(aspects, aspectMeta);
    // NUMBER-typed aspects must carry a bare positive number or eBay rejects
    // the publish (25002 "Fabric weight must be greater than 0") — run LAST so
    // model-filled and reconciled values are covered too.
    const droppedNumeric = sanitizeNumericAspects(aspects, aspectMeta);
    if (droppedNumeric.length) {
      console.warn(
        `[ebay/publish] sku=${sku} dropped non-numeric value(s) for numeric aspect(s): ${droppedNumeric.join(", ")}`
      );
    }
  }
  const condCandidates = conditionCandidates(listing.condition, acceptedConds, catKey);
  const condition = condCandidates[0] || "USED_EXCELLENT";
  console.log(
    `[ebay/publish] sku=${sku} category=${catId} grade=${listing.condition} → condition=${condition}` +
      (acceptedConds.size ? "" : " (no condition metadata — category-key fallback)")
  );
  // Real product identifiers (validated UPC/EAN/ISBN/MPN) ride along so eBay
  // can catalog-match commodity items; one-off vintage pieces have none.
  const identifiers = extractProductIdentifiers(listing);
  const brand = realBrand(listing);
  const inventoryItem: any = {
    product: {
      title: String(listing.title || "Untitled").slice(0, 80),
      description: listing.description || "",
      aspects,
      imageUrls: photoUrls.slice(0, 12),
      ...(identifiers.upc ? { upc: [identifiers.upc] } : {}),
      ...(identifiers.ean ? { ean: [identifiers.ean] } : {}),
      ...(identifiers.isbn ? { isbn: [identifiers.isbn] } : {}),
      // eBay validates brand and MPN as a PAIR — an MPN without a brand fails
      // publish with 25002 "Input data for tag <BrandMPN> is invalid or
      // missing". Ship both or neither.
      ...(identifiers.mpn && brand ? { brand, mpn: identifiers.mpn } : {}),
    },
    condition,
    conditionDescription: listing.condition_notes || "",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    // Class-profiled weight/size so CALCULATED-shipping policies publish
    // (eBay 25020) without a coat shipping as a 1-lb envelope.
    packageWeightAndSize: defaultPackageWeightAndSize(catKey, listing),
  };

  const putInventory = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
          body: inventoryItem,
          extraHeaders: CL,
        }),
      "inventory item",
      sku
    );

  let r = await putInventory();
  if (![200, 201, 204].includes(r.status)) {
    const missing = extractMissingAspects(r);
    if (missing.length && addMissingAspects(aspects, missing, listing).length) {
      inventoryItem.product.aspects = aspects;
      r = await putInventory();
    }
    // Recovery: rejected Brand/MPN pair (25002 <BrandMPN>).
    if (![200, 201, 204].includes(r.status) && isBrandMpnError(r)) {
      applyBrandMpnFallback(inventoryItem, aspects, listing, sku);
      r = await putInventory();
    }
    // Recovery: rejected package type (25101 Invalid <ShippingPackage>).
    if (![200, 201, 204].includes(r.status) && isShippingPackageError(r)) {
      applyShippingPackageFallback(inventoryItem, sku);
      r = await putInventory();
    }
    // Recovery: an aspect VALUE eBay's validators rejected (25002 "Fabric
    // weight must be greater than 0") → drop the named aspect(s), retry once.
    if (![200, 201, 204].includes(r.status)) {
      const badAspects = findInvalidValueAspects(r, aspects);
      if (badAspects.length) {
        applyInvalidAspectFallback(inventoryItem, aspects, badAspects, sku);
        r = await putInventory();
      }
    }
    // Recovery: condition invalid for this category (25021/25059) → step down
    // to a grade the category accepts.
    if (
      ![200, 201, 204].includes(r.status) &&
      (errorIds(r).includes(25021) || errorIds(r).includes(25059))
    ) {
      for (const alt of condCandidates) {
        if (alt === inventoryItem.condition) continue;
        // Loud on purpose: a silent step-down is how "Excellent" items ended
        // up displaying as "Pre-owned – Good" with no trace in the logs.
        console.warn(
          `[ebay/publish] sku=${sku} condition ${inventoryItem.condition} rejected by category ${catId} — trying ${alt}`
        );
        inventoryItem.condition = alt;
        r = await putInventory();
        if ([200, 201, 204].includes(r.status)) break;
        if (!errorIds(r).includes(25021) && !errorIds(r).includes(25059)) break;
      }
    }
    if (![200, 201, 204].includes(r.status)) {
      logPublishFailure("inventory item", sku, r);
      return { success: false, sku, error: publishErrorMessage("Inventory item failed", r) };
    }
  }

  // 3. Offer.
  const chosenFulfillment = selectFulfillmentPolicy(setup, listing.shipping_free);
  if (chosenFulfillment.warning) {
    console.warn(`[ebay/publish] sku=${sku} ${chosenFulfillment.warning}`);
    warnings.push(chosenFulfillment.warning);
  }
  const offerBody: any = {
    sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDescription: listing.description || "",
    pricingSummary: { price: { value: String(price), currency: EBAY_CURRENCY } },
    quantityLimitPerBuyer: 1,
    categoryId: catId,
    merchantLocationKey: setup.locationKey,
    listingPolicies: {
      // Free vs buyer-paid is a per-listing choice, so pick the policy that
      // matches it rather than whichever happens to be first on the account.
      fulfillmentPolicyId: chosenFulfillment.policyId,
      paymentPolicyId: setup.paymentPolicyId,
      returnPolicyId: setup.returnPolicyId,
    },
    // Catalog matching helps commodity items (books, media, boxed products)
    // inherit eBay's established product data — but only when a strong,
    // validated identifier ties this item to one catalog product AND the item
    // class is commodity-like. A checksum-valid barcode on a collectible's
    // repro box shouldn't overwrite the listing with the wrong catalog entry.
    includeCatalogProductDetails:
      hasCatalogIdentifier(identifiers) &&
      ["media", "hard_goods"].includes(String(listing.item_profile || "")),
  };

  const postOffer = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer`, {
          body: offerBody,
          extraHeaders: CL,
        }),
      "offer creation",
      sku
    );

  r = await postOffer();

  // Recovery: missing aspects during offer create.
  if (![200, 201].includes(r.status) && extractMissingAspects(r).length) {
    if (addMissingAspects(aspects, extractMissingAspects(r), listing).length) {
      inventoryItem.product.aspects = aspects;
      await putInventory();
      r = await postOffer();
    }
  }
  // Recovery: category rejected (25005) → try eBay's OWN runner-up suggestions
  // for this item. Never unrelated generic categories: a wrong-category
  // publication is worse than a stopped listing.
  if (![200, 201].includes(r.status) && errorIds(r).includes(25005)) {
    // The initial suggestion call may have failed (offline static map used,
    // possibly non-leaf). Taxonomy might be back by now — ask once more.
    if (!fallbacks.length) {
      const retry = await suggestLeafCategories(
        `${listing.category_hint || ""} ${listing.title || ""}`,
        3
      );
      fallbacks.push(...retry.map((s) => s.id).filter((id) => id !== catId));
    }
    for (const fb of fallbacks) {
      offerBody.categoryId = fb;
      const fbResp = await postOffer();
      if ([200, 201].includes(fbResp.status) || extractExistingOfferId(fbResp)) {
        r = fbResp;
        catId = fb;
        break;
      }
    }
    if (![200, 201].includes(r.status) && !extractExistingOfferId(r)) {
      logPublishFailure("offer creation", sku, r);
      return {
        success: false,
        sku,
        error:
          `eBay rejected the category for this item (tried ${[catId, ...fallbacks].join(", ")}). ` +
          "Rather than publishing it in an unrelated category, this listing was stopped — adjust the title or re-analyze so the category suggestion improves, or post it manually.",
      };
    }
  }

  let offerId: string;
  if (r.status === 400) {
    const existing = extractExistingOfferId(r);
    if (!existing) {
      logPublishFailure("offer creation", sku, r);
      return { success: false, sku, error: publishErrorMessage("Offer creation failed", r) };
    }
    // Update the pre-existing offer instead.
    const upd = await withTransientRetry(
      () =>
        ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${existing}`, {
          body: updateOfferBody(offerBody),
          extraHeaders: CL,
        }),
      "offer update",
      sku
    );
    if (![200, 201, 204].includes(upd.status)) {
      logPublishFailure("offer update", sku, upd);
      return { success: false, sku, error: publishErrorMessage("Offer update failed", upd) };
    }
    offerId = existing;
  } else if (![200, 201].includes(r.status)) {
    logPublishFailure("offer creation", sku, r);
    return { success: false, sku, error: publishErrorMessage("Offer creation failed", r) };
  } else {
    offerId = r.json?.offerId || "";
  }

  // 4. Publish, with recovery.
  return publishOfferWithRecovery(accessToken, {
    sku,
    offerId,
    catId,
    catKey,
    listing,
    aspects,
    inventoryItem,
    offerBody,
    fallbacks,
    condCandidates,
    warnings,
  });
}

async function publishOfferWithRecovery(
  accessToken: string,
  ctx: {
    sku: string;
    offerId: string;
    catId: string;
    catKey: string;
    listing: ListingResult;
    aspects: Record<string, string[]>;
    inventoryItem: any;
    offerBody: any;
    fallbacks: string[];
    condCandidates: string[];
    warnings: string[];
  }
): Promise<PublishResult> {
  const { sku, offerId } = ctx;
  const warnings = ctx.warnings.length ? ctx.warnings : undefined;
  const doPublish = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/publish`, {
          extraHeaders: CL,
        }),
      "publish",
      sku
    );
  const putInventory = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
          body: ctx.inventoryItem,
          extraHeaders: CL,
        }),
      "inventory item",
      sku
    );

  let r = await doPublish();
  if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };

  // The offer already went live (e.g. an earlier attempt timed out after the
  // publish landed). That's success — recover the listing id and report it.
  if (/already\s*published/i.test(r.text || "")) {
    const off = await ebayRequest(accessToken, "GET", `${EBAY_INV_BASE}/offer/${offerId}`);
    return {
      success: true,
      sku,
      offerId,
      listingId: String(off.json?.listing?.listingId || ""),
      warnings,
    };
  }

  let eids = errorIds(r);

  // Recovery: missing item specifics.
  const missing = extractMissingAspects(r);
  if (missing.length && addMissingAspects(ctx.aspects, missing, ctx.listing).length) {
    ctx.inventoryItem.product.aspects = ctx.aspects;
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
    eids = errorIds(r);
  }

  // Recovery: rejected Brand/MPN pair (25002 <BrandMPN>) — eBay validates the
  // pair at publish time even when the inventory PUT succeeded.
  if (isBrandMpnError(r)) {
    applyBrandMpnFallback(ctx.inventoryItem, ctx.aspects, ctx.listing, sku);
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
    eids = errorIds(r);
  }

  // Recovery: rejected package type (25101 Invalid <ShippingPackage>) — like
  // Brand/MPN, eBay validates this at publish time.
  if (isShippingPackageError(r)) {
    applyShippingPackageFallback(ctx.inventoryItem, sku);
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
    eids = errorIds(r);
  }

  // Recovery: an aspect VALUE eBay's validators rejected (25002 "Fabric weight
  // must be greater than 0") — like Brand/MPN, this fires at publish time even
  // when the inventory PUT succeeded. Drop the named aspect(s) and retry once.
  const badAspects = findInvalidValueAspects(r, ctx.aspects);
  if (badAspects.length) {
    applyInvalidAspectFallback(ctx.inventoryItem, ctx.aspects, badAspects, sku);
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
    eids = errorIds(r);
  }

  // Recovery: invalid condition (25059/25021) → step through the remaining
  // candidate grades until one publishes.
  if (eids.includes(25059) || eids.includes(25021)) {
    for (const alt of ctx.condCandidates) {
      if (alt === ctx.inventoryItem.condition) continue;
      console.warn(
        `[ebay/publish] sku=${sku} condition ${ctx.inventoryItem.condition} rejected at publish (category ${ctx.catId}) — trying ${alt}`
      );
      ctx.inventoryItem.condition = alt;
      await putInventory();
      r = await doPublish();
      if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
      eids = errorIds(r);
      if (!eids.includes(25021) && !eids.includes(25059)) break;
    }
  }

  // Recovery: non-leaf category (25005) → try fallbacks via offer update.
  if (eids.includes(25005)) {
    for (const fb of ctx.fallbacks) {
      const upd = await ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${offerId}`, {
        body: { ...updateOfferBody(ctx.offerBody), categoryId: fb },
        extraHeaders: CL,
      });
      if ([200, 201, 204].includes(upd.status)) {
        r = await doPublish();
        if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "", warnings };
      }
    }
  }

  logPublishFailure("publish", sku, r);
  return {
    success: false,
    sku,
    offerId,
    error: publishErrorMessage("Publish failed", r),
  };
}
