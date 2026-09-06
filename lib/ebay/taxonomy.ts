import { boundedFetch } from "@/lib/network";
// eBay Taxonomy API: resolve the correct LEAF category and its REQUIRED item
// specifics (aspects) with valid values — instead of guessing from a static map.
//
// This fixes the two publish failure modes:
//   • 25005 "not a leaf category" — the static map held parent categories
//     (e.g. womens_shoes → 3034 "Women's Shoes"); eBay only accepts leaves.
//   • 25002 "<aspect> is missing" — required specifics vary per leaf category
//     and SELECTION_ONLY aspects only accept values from eBay's own list
//     (e.g. Department must be "Unisex Adults", never "Unisex Adult").
//
// These endpoints are read-only, app-level data. We authenticate with a
// client-credentials app token (minted + cached here), independent of the
// seller's user token — so this never needs a re-auth or a new user scope.

import {
  EBAY_TAX_BASE,
  EBAY_META_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_CATEGORY_TREE_ID,
  EBAY_TOKEN_URL,
  basicAuthHeader,
  getEbayCreds,
} from "./config";

export type AspectMode = "FREE_TEXT" | "SELECTION_ONLY";
export type AspectUsage = "REQUIRED" | "RECOMMENDED" | "OPTIONAL";
export type AspectCardinality = "SINGLE" | "MULTI";

export interface AspectMeta {
  name: string;
  required: boolean;
  usage: AspectUsage;
  mode: AspectMode;
  // eBay allows one value or several for this aspect. Flattening a MULTI aspect
  // ("Cotton/Polyester") to its first value loses searchable data.
  cardinality: AspectCardinality;
  maxLength?: number;
  // eBay validates value FORMAT at publish time for typed aspects — a prose
  // value in a NUMBER aspect ("Fabric Weight" = "Heavyweight") hard-fails the
  // publish with 25002 ("Fabric weight must be greater than 0").
  dataType?: string; // e.g. "STRING" | "NUMBER" | "DATE"
  format?: string; // e.g. "int32" | "double"
  constraints?: Record<string, { name: string; values: string[] }[]>;
  values: string[]; // eBay's allowed/suggested values (full list for SELECTION_ONLY)
}

export interface CategorySuggestion {
  id: string;
  name: string;
}

// ── App token (client-credentials), cached in the warm lambda ────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

// Exported for other read-only eBay APIs that accept the same client-credentials
// scope (e.g. Browse-API comp searches).
export async function appToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000)
    return cachedToken.token;
  const creds = getEbayCreds();
  const resp = await boundedFetch(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(creds),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  if (!resp.ok) throw new Error(`eBay app token failed (${resp.status})`);
  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}

async function taxGet(path: string): Promise<any | null> {
  const token = await appToken();
  const resp = await boundedFetch(
    `${EBAY_TAX_BASE}/category_tree/${EBAY_CATEGORY_TREE_ID}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    },
  );
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Resolve the best LEAF categories for a free-text query (title + hint), best
// match first. eBay only suggests leaf categories, so every hit is publish-safe.
// The runners-up double as *relevant* fallbacks if eBay rejects the first pick —
// far better than the old static list of unrelated collectible categories.
export async function suggestLeafCategories(
  query: string,
  limit = 3,
): Promise<CategorySuggestion[]> {
  const q = (query || "").trim().slice(0, 350);
  if (!q) return [];
  try {
    const data = await taxGet(
      `get_category_suggestions?q=${encodeURIComponent(q)}`,
    );
    const out: CategorySuggestion[] = [];
    for (const s of data?.categorySuggestions ?? []) {
      const id = s?.category?.categoryId;
      if (!id) continue;
      out.push({
        id: String(id),
        name: String(s?.category?.categoryName ?? ""),
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function suggestLeafCategory(
  query: string,
): Promise<string | null> {
  const suggestions = await suggestLeafCategories(query, 1);
  return suggestions[0]?.id ?? null;
}

const aspectCache = new Map<string, { value: AspectMeta[]; expires: number }>();

// Required + optional aspects for a leaf category, with eBay's allowed values.
export async function categoryAspects(
  categoryId: string,
): Promise<AspectMeta[]> {
  if (!categoryId) return [];
  const cached = aspectCache.get(categoryId);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const data = await taxGet(
      `get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    );
    const out: AspectMeta[] = [];
    for (const a of data?.aspects ?? []) {
      const con = a?.aspectConstraint ?? {};
      const name = String(a?.localizedAspectName ?? "").trim();
      if (!name) continue;
      const required = Boolean(con?.aspectRequired);
      const maxLen = Number(con?.aspectMaxLength);
      out.push({
        name,
        required,
        usage: required
          ? "REQUIRED"
          : con?.aspectUsage === "RECOMMENDED"
            ? "RECOMMENDED"
            : "OPTIONAL",
        mode:
          con?.aspectMode === "SELECTION_ONLY" ? "SELECTION_ONLY" : "FREE_TEXT",
        cardinality:
          con?.itemToAspectCardinality === "MULTI" ? "MULTI" : "SINGLE",
        maxLength: Number.isFinite(maxLen) && maxLen > 0 ? maxLen : undefined,
        dataType: con?.aspectDataType ? String(con.aspectDataType) : undefined,
        format: con?.aspectFormat ? String(con.aspectFormat) : undefined,
        constraints: Object.fromEntries(
          (a?.aspectValues ?? [])
            .filter((v: any) => v.valueConstraints?.length)
            .map((v: any) => [
              v.localizedValue,
              v.valueConstraints.map((d: any) => ({
                name: d.applicableForLocalizedAspectName,
                values: d.applicableForLocalizedAspectValues ?? [],
              })),
            ]),
        ),
        values: (a?.aspectValues ?? [])
          .map((v: any) => String(v?.localizedValue ?? "").trim())
          .filter(Boolean),
      });
    }
    if (out.length) {
      if (aspectCache.size > 500) aspectCache.clear();
      aspectCache.set(categoryId, {
        value: out,
        expires: Date.now() + 3600_000,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const condCache = new Map<string, { value: Set<number>; expires: number }>();

// Numeric condition IDs eBay accepts for a leaf category (Sell Metadata API).
// Lets us pick a condition the category actually allows — fashion leaves reject
// the classic USED_VERY_GOOD/GOOD/ACCEPTABLE ids (4000/5000/6000), accepting
// only New variants plus 2990/3000/3010, which is the source of error 25021.
//
// Prefer the seller's user token when the caller has one: the client-credentials
// app token can be rejected by the Metadata API (scope), and a silent failure
// here is what made every apparel item publish as generic id 3000 — which eBay
// displays as "Pre-owned – Good" in clothing categories regardless of the item's
// real grade.
export async function acceptedConditionIds(
  categoryId: string,
  userToken?: string,
): Promise<Set<number>> {
  if (!categoryId) return new Set();
  const cached = condCache.get(categoryId);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const token = userToken || (await appToken());
    const url =
      `${EBAY_META_BASE}/marketplace/${EBAY_MARKETPLACE_ID}` +
      `/get_item_condition_policies?filter=categoryIds:%7B${encodeURIComponent(categoryId)}%7D`;
    const resp = await boundedFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    });
    if (!resp.ok) {
      // Don't fail silently — this is exactly the path that mis-grades items.
      console.warn(
        `[ebay/taxonomy] condition policies unavailable for category ${categoryId} (HTTP ${resp.status})`,
      );
      return new Set();
    }
    const data = await resp.json().catch(() => null);
    const ids = new Set<number>();
    for (const p of data?.itemConditionPolicies ?? [])
      for (const c of p?.itemConditions ?? []) {
        const n = Number(c?.conditionId);
        if (n) ids.add(n);
      }
    if (ids.size) {
      if (condCache.size > 500) condCache.clear();
      condCache.set(categoryId, { value: ids, expires: Date.now() + 3600_000 });
    }
    return ids;
  } catch (e) {
    console.warn(
      `[ebay/taxonomy] condition policies failed for category ${categoryId}: ${(e as Error).message}`,
    );
    return new Set();
  }
}
