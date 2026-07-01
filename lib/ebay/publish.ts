// eBay publish pipeline, ported from ebay_lister_v2_robust.py.
// Sequence: upload photos → create inventory item → create offer → publish,
// with recovery for missing item specifics, rejected conditions, and non-leaf
// categories.

import {
  EBAY_ACC_BASE,
  EBAY_INV_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_TRADING,
} from "./config";
import {
  suggestLeafCategory,
  categoryAspects,
  acceptedConditionIds,
  type AspectMeta,
} from "./taxonomy";
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

const LEAF_FALLBACKS = ["1463", "22733", "2550", "48108", "316", "171485", "2624", "2613"];

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

const APPAREL_CATEGORIES = new Set([
  "womens_top", "womens_dress", "womens_skirt", "womens_pants", "womens_coat",
  "womens_sweater", "womens_jeans", "womens_clothing", "womens_shoes", "mens_top",
  "mens_pants", "mens_coat", "mens_sweater", "mens_jeans", "mens_clothing",
  "mens_shoes", "scarf", "belt", "hat",
]);
const PANTS_CATEGORIES = new Set([
  "womens_pants", "womens_jeans", "womens_skirt", "mens_pants", "mens_jeans",
]);

const ASPECT_DEFAULTS: Record<string, string> = {
  "Skirt Length": "Knee-Length", "Dress Length": "Knee-Length", Rise: "Mid Rise",
  "Leg Style": "Straight", Closure: "Pull-On", "Shoe Width": "Medium",
  "Heel Height": "Flat", "Toe Shape": "Round", Adjustable: "Yes",
  "Exterior Pockets": "Yes", Lining: "Lined", Hood: "No Hood", "Bag Closure": "Zip",
  "Strap Type": "Adjustable", "Hat Style": "Baseball Cap", "Brim Style": "Curved Bill",
  "Size Type": "Regular", Size: "Regular", Style: "Casual", Department: "Unisex Adult",
  Type: "Item", Brand: "Unbranded", Color: "Multicolor", Material: "Mixed Materials",
};

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

function computeBufferedPrice(raw: number | string | undefined): number {
  let base = typeof raw === "string" ? parseFloat(raw) : raw ?? 0;
  if (!base || Number.isNaN(base) || base <= 0) base = 29.99;
  const buffered = Math.max(base * 1.18, base + 5);
  return Math.round(buffered * 100) / 100;
}

// eBay's CALCULATED-shipping business policies REQUIRE package weight (and
// dimensions) on the inventory item, or publish fails with error 25020 ("package
// weight is not valid or is missing"). Flat-rate policies don't need it. We always
// send a sensible default so calculated policies publish out of the box; the
// seller can refine weight/size on the listing afterward, or tune the defaults
// via EBAY_DEFAULT_PACKAGE_* env vars. Weight is in ounces (16 oz = 1 lb).
function defaultPackageWeightAndSize(): Record<string, unknown> {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    weight: {
      value: num(process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ, 16),
      unit: "OUNCE",
    },
    dimensions: {
      length: num(process.env.EBAY_DEFAULT_PACKAGE_LENGTH_IN, 12),
      width: num(process.env.EBAY_DEFAULT_PACKAGE_WIDTH_IN, 9),
      height: num(process.env.EBAY_DEFAULT_PACKAGE_HEIGHT_IN, 3),
      unit: "INCH",
    },
    packageType: "PACKAGE_THICK_ENVELOPE",
  };
}

function normalizeConditionInput(value: string | undefined): string {
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

function conditionIdsForGrade(grade: string, acceptedIds: Set<number>): number[] {
  const apparel = isApparelConditionPolicy(acceptedIds);
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
function conditionCandidates(grade: string | undefined, acceptedIds: Set<number>): string[] {
  const desired = normalizeConditionInput(grade);
  const out: string[] = [];
  for (const id of conditionIdsForGrade(desired, acceptedIds)) {
    const en = CONDITION_ID_ENUM[id];
    if (en && !out.includes(en)) out.push(en);
  }
  return out.length ? out : ["USED_GOOD"];
}

function resolveCategory(listing: ListingResult): {
  categoryId: string;
  fallbacks: string[];
} {
  const explicit = (listing.category_id || "").toString().trim();
  const catKey = (listing.category || "other").toString();
  const mapped = CATEGORY_MAP[catKey] || CATEGORY_MAP.other;
  const categoryId = explicit || mapped;
  const fallbacks = LEAF_FALLBACKS.filter((c) => c && c !== categoryId);
  return { categoryId, fallbacks };
}

// eBay rejects any item-specific (aspect) value longer than this (error 25002).
const MAX_ASPECT_VALUE_LEN = 65;

// Clip an aspect value to eBay's limit, breaking at a word boundary when the
// truncation point lands far enough in to leave a readable phrase.
function clipAspectValue(s: string): string {
  const t = (s || "").trim();
  if (t.length <= MAX_ASPECT_VALUE_LEN) return t;
  const cut = t.slice(0, MAX_ASPECT_VALUE_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_ASPECT_VALUE_LEN * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

function singleValue(v: unknown): string {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = singleValue(x);
      if (s) return s;
    }
    return "";
  }
  let s = String(v ?? "").trim();
  if (!s) return "";
  for (const sep of ["/", ",", "|", "&", " and "]) {
    if (s.includes(sep)) {
      s = s.split(sep)[0].trim();
      break;
    }
  }
  return s.replace(/\s+/g, " ");
}

function departmentForCategory(catKey: string): string {
  if (catKey.startsWith("womens_")) return "Women";
  if (catKey.startsWith("mens_")) return "Men";
  return "Unisex Adult";
}

// Build the item-specifics (aspects) map from the listing.
function buildAspects(listing: ListingResult, catKey: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const put = (k: string, v: string) => {
    const val = clipAspectValue(v);
    if (val) aspects[k] = [val];
  };

  put("Brand", String(listing.brand || "").trim());
  put("Size", String(listing.size || "").trim());
  put("Color", singleValue(listing.color));
  put("Material", singleValue(listing.material));
  put("Type", String(listing.item_type || "").trim());

  const feats = Array.isArray(listing.key_features) ? listing.key_features : [];
  const cleanFeats = feats.map((f) => clipAspectValue(String(f))).filter(Boolean).slice(0, 5);
  if (cleanFeats.length) aspects.Features = cleanFeats;

  if (APPAREL_CATEGORIES.has(catKey) || catKey === "accessory") {
    aspects.Department = [departmentForCategory(catKey)];
  }

  if (PANTS_CATEGORIES.has(catKey)) {
    const m = String(listing.measurements || "").trim();
    if (m && m.toLowerCase() !== "see listing photos for measurements") {
      aspects.Inseam = [m.slice(0, 30)];
    }
  }

  // Merge in the model-provided item specifics (skip blanks + section labels).
  for (const [k, v] of Object.entries(listing.item_specifics || {})) {
    if (!k || k.startsWith("---")) continue;
    const val = clipAspectValue(singleValue(v));
    if (val && !aspects[k]) aspects[k] = [val];
  }
  return aspects;
}

// ── Required-aspect reconciliation (driven by eBay's Taxonomy data) ──────────
//
// The static defaults above can't know what each leaf category requires, nor
// which values its SELECTION_ONLY aspects accept. We ask eBay for both and make
// every required aspect valid before publishing — eliminating the 25002 errors.

// Match a value against eBay's allowed list, case-insensitively and tolerating
// singular/plural (so "Unisex Adult" resolves to the valid "Unisex Adults").
// Returns the canonical allowed value, or null if there's no match.
function matchAllowed(value: string, allowed: string[]): string | null {
  const ls = (value || "").trim().toLowerCase();
  if (!ls) return null;
  for (const v of allowed) {
    const lv = v.toLowerCase();
    if (lv === ls || lv === `${ls}s` || `${lv}s` === ls) return v;
  }
  return null;
}

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
function freeTextDefault(name: string, listing: ListingResult): string {
  const n = name.toLowerCase();
  if (n.includes("brand")) return String(listing.brand || "").trim() || "Unbranded";
  if (n.includes("color")) return singleValue(listing.color) || "Multicolor";
  if (n.includes("shoe size") || n === "size") return String(listing.size || "").trim();
  if (n.includes("material")) return singleValue(listing.material) || "Man Made";
  if (n.includes("style")) return String(listing.item_specifics?.Style || listing.item_type || "").trim();
  if (n.includes("type")) return String(listing.item_type || "").trim();
  return "";
}

// Make every REQUIRED aspect present and valid. Mutates `aspects` in place.
function reconcileAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  listing: ListingResult,
  catKey: string
): void {
  for (const a of meta) {
    if (!a.required || !a.name) continue;
    const current = aspects[a.name]?.[0];

    if (a.mode === "SELECTION_ONLY") {
      // Must be one of eBay's allowed values, or the publish 25002-fails.
      const canonical =
        matchAllowed(current || "", a.values) ||
        matchAllowed(ASPECT_DEFAULTS[a.name] || "", a.values) ||
        (a.name === "Department" ? pickDepartment(a.values, listing, catKey) : "") ||
        a.values[0] ||
        "";
      if (canonical) aspects[a.name] = [canonical];
    } else if (!current) {
      // FREE_TEXT and unset — fill from the listing or a sensible default.
      const v = freeTextDefault(a.name, listing) || ASPECT_DEFAULTS[a.name] || a.values[0] || "";
      const clipped = clipAspectValue(v);
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

// Extra guidance for eBay errors that a seller can act on directly. Keyed by
// errorId; appended to the raw eBay message when surfaced in the UI.
const EBAY_ERROR_HINTS: Record<number, string> = {
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
  missing: string[]
): string[] {
  const added: string[] = [];
  for (const field of missing) {
    const def = ASPECT_DEFAULTS[field] || "Unbranded";
    aspects[field] = [def];
    added.push(`${field}=${def}`);
  }
  return added;
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

export interface AccountSetup {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  locationKey: string;
}

function pickFirstPolicy(r: EbayResp, listKey: string, idField: string): string {
  if (!r.ok) return "";
  const list = r.json?.[listKey] || [];
  return list.length ? String(list[0][idField] || "") : "";
}

export async function fetchAccountSetup(accessToken: string): Promise<AccountSetup> {
  const mp = `marketplace_id=${EBAY_MARKETPLACE_ID}`;
  const [ful, pay, ret] = await Promise.all([
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/fulfillment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/payment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/return_policy?${mp}`),
  ]);
  return {
    fulfillmentPolicyId: pickFirstPolicy(ful, "fulfillmentPolicies", "fulfillmentPolicyId"),
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
  images: { mediaType: string; data: string }[];
}

export interface PublishResult {
  success: boolean;
  sku: string;
  listingId?: string;
  offerId?: string;
  error?: string;
}

const CL = { "Content-Language": "en-US" };

export async function publishListing(
  accessToken: string,
  setup: AccountSetup,
  input: PublishInput
): Promise<PublishResult> {
  const { sku, listing } = input;
  const catKey = String(listing.category || "other");
  const { categoryId: staticCat, fallbacks } = resolveCategory(listing);
  // Ask eBay for the real LEAF category from the title + hint; fall back to the
  // static map only if Taxonomy is unavailable. (Fixes 25005 non-leaf errors.)
  const leaf = await suggestLeafCategory(`${listing.category_hint || ""} ${listing.title || ""}`);
  let catId = leaf || staticCat;

  if (!setup.fulfillmentPolicyId || !setup.paymentPolicyId || !setup.returnPolicyId) {
    return {
      success: false,
      sku,
      error:
        "Your eBay account is missing a business policy (payment, shipping, or returns). Set these up in eBay → Account → Business policies, then try again.",
    };
  }

  // 1. Upload photos → EPS URLs.
  const photoUrls: string[] = [];
  for (const img of input.images.slice(0, 12)) {
    const url = await uploadPhoto(accessToken, img.data, img.mediaType, `${sku}.jpg`);
    if (url) photoUrls.push(url);
  }
  if (photoUrls.length === 0) {
    return { success: false, sku, error: "Could not upload any photos to eBay." };
  }

  // 2. Inventory item.
  const aspects = buildAspects(listing, catKey);
  // Ask eBay (in parallel) for the leaf category's REQUIRED specifics and its
  // accepted condition ids, then make both valid before creating the item.
  // Non-fatal: the recovery loops below remain as a backup if eBay is slow.
  let acceptedConds = new Set<number>();
  try {
    const [meta, conds] = await Promise.all([
      categoryAspects(catId), // required aspects + valid values  → fixes 25002
      acceptedConditionIds(catId), // accepted condition ids       → fixes 25021
    ]);
    if (meta.length) reconcileAspects(aspects, meta, listing, catKey);
    acceptedConds = conds;
  } catch {
    /* taxonomy/metadata unavailable — proceed with best-effort values */
  }
  const condCandidates = conditionCandidates(listing.condition, acceptedConds);
  const condition = condCandidates[0] || "USED_EXCELLENT";
  const inventoryItem: any = {
    product: {
      title: String(listing.title || "Untitled").slice(0, 80),
      description: listing.description || "",
      aspects,
      imageUrls: photoUrls.slice(0, 12),
    },
    condition,
    conditionDescription: listing.condition_notes || "",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    // Default weight/size so CALCULATED-shipping policies publish (eBay 25020).
    packageWeightAndSize: defaultPackageWeightAndSize(),
  };

  const putInventory = () =>
    ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
      body: inventoryItem,
      extraHeaders: CL,
    });

  let r = await putInventory();
  if (![200, 201, 204].includes(r.status)) {
    const missing = extractMissingAspects(r);
    if (missing.length && addMissingAspects(aspects, missing).length) {
      inventoryItem.product.aspects = aspects;
      r = await putInventory();
    }
    // Recovery: condition invalid for this category (25021/25059) → step down
    // to a grade the category accepts.
    if (
      ![200, 201, 204].includes(r.status) &&
      (errorIds(r).includes(25021) || errorIds(r).includes(25059))
    ) {
      for (const alt of condCandidates) {
        if (alt === inventoryItem.condition) continue;
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
  const price = computeBufferedPrice(listing.suggested_price);
  const offerBody: any = {
    sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDescription: listing.description || "",
    pricingSummary: { price: { value: String(price), currency: "USD" } },
    quantityLimitPerBuyer: 1,
    categoryId: catId,
    merchantLocationKey: setup.locationKey,
    listingPolicies: {
      fulfillmentPolicyId: setup.fulfillmentPolicyId,
      paymentPolicyId: setup.paymentPolicyId,
      returnPolicyId: setup.returnPolicyId,
    },
    includeCatalogProductDetails: false,
  };

  const postOffer = () =>
    ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer`, { body: offerBody, extraHeaders: CL });

  r = await postOffer();

  // Recovery: missing aspects during offer create.
  if (![200, 201].includes(r.status) && extractMissingAspects(r).length) {
    if (addMissingAspects(aspects, extractMissingAspects(r)).length) {
      inventoryItem.product.aspects = aspects;
      await putInventory();
      r = await postOffer();
    }
  }
  // Recovery: non-leaf category (25005).
  if (![200, 201].includes(r.status) && errorIds(r).includes(25005)) {
    for (const fb of fallbacks) {
      offerBody.categoryId = fb;
      const fbResp = await postOffer();
      if ([200, 201].includes(fbResp.status) || extractExistingOfferId(fbResp)) {
        r = fbResp;
        catId = fb;
        break;
      }
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
    const upd = await ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${existing}`, {
      body: updateOfferBody(offerBody),
      extraHeaders: CL,
    });
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
    aspects,
    inventoryItem,
    offerBody,
    fallbacks,
    condCandidates,
  });
}

async function publishOfferWithRecovery(
  accessToken: string,
  ctx: {
    sku: string;
    offerId: string;
    catId: string;
    catKey: string;
    aspects: Record<string, string[]>;
    inventoryItem: any;
    offerBody: any;
    fallbacks: string[];
    condCandidates: string[];
  }
): Promise<PublishResult> {
  const { sku, offerId } = ctx;
  const doPublish = () =>
    ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/publish`, {
      extraHeaders: CL,
    });
  const putInventory = () =>
    ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
      body: ctx.inventoryItem,
      extraHeaders: CL,
    });

  let r = await doPublish();
  if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };

  let eids = errorIds(r);

  // Recovery: missing item specifics.
  const missing = extractMissingAspects(r);
  if (missing.length && addMissingAspects(ctx.aspects, missing).length) {
    ctx.inventoryItem.product.aspects = ctx.aspects;
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
    eids = errorIds(r);
  }

  // Recovery: invalid condition (25059/25021) → step through the remaining
  // candidate grades until one publishes.
  if (eids.includes(25059) || eids.includes(25021)) {
    for (const alt of ctx.condCandidates) {
      if (alt === ctx.inventoryItem.condition) continue;
      ctx.inventoryItem.condition = alt;
      await putInventory();
      r = await doPublish();
      if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
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
        if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
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
