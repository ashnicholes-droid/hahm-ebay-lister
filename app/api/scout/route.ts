import { NextRequest, NextResponse } from "next/server";
import { getClient, parseModelJson, anthropicAuthError } from "@/lib/anthropic";
import {
  BODY_LIMIT_PHOTOS,
  enforceBodyLimit,
  guardApiRequest,
  safeErrorResponse,
} from "@/lib/api-guard";
import { SCOUT_PROMPT } from "@/lib/prompts";
import { toImageBlock, type ImageBlock } from "@/lib/images";
import { isEbayConfigured } from "@/lib/ebay/config";
import { appToken } from "@/lib/ebay/taxonomy";
import { searchComps } from "@/lib/ebay/comps";
import { estimateShipping } from "@/lib/shipping/estimate";
import type { ListingResult } from "@/lib/types";

// One call: identify, comp, and cost the postage.
//
// Deliberately a separate route from /api/analyze rather than a flag on it.
// Analyze writes a whole listing with Opus and budgets 250 seconds; this has to
// answer while someone stands in a shop holding the item, so it uses a fast
// model, a narrow prompt, and at most three photos.
//
// It is also ONE round trip on purpose. Identify → comps → shipping as three
// calls would be three chances for shop wifi to stall, and the intermediate
// results are useless on their own.

export const maxDuration = 60;

// Fast, and plenty for "what is this thing". The identification here feeds a
// comp search, not a listing — precision matters more than prose.
const SCOUT_MODEL = "claude-sonnet-4-6";
// Three photos is the most that helps: the item, a mark or label, and a flaw.
const MAX_SCOUT_IMAGES = 3;
const SCOUT_TIMEOUT_MS = 35_000;

interface ScoutIdentification {
  title: string;
  brand: string;
  item_type: string;
  category: string;
  condition: string;
  condition_notes: string;
  weight_oz: number;
  dims_in: { l: number; w: number; h: number };
  identified: boolean;
  note: string;
}

/** eBay's condition vocabulary, from the model's simpler one. */
const CONDITION_MAP: Record<string, string> = {
  new: "New",
  like_new: "New other (see details)",
  good: "Used",
  fair: "Used",
  poor: "For parts or not working",
};

function normalize(raw: Partial<ScoutIdentification>): ScoutIdentification {
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const dims = (raw.dims_in ?? {}) as Partial<{ l: number; w: number; h: number }>;
  return {
    title: String(raw.title ?? "").slice(0, 80),
    brand: String(raw.brand ?? ""),
    item_type: String(raw.item_type ?? ""),
    category: String(raw.category ?? "other"),
    condition: String(raw.condition ?? "good"),
    condition_notes: String(raw.condition_notes ?? ""),
    weight_oz: num(raw.weight_oz, 16),
    dims_in: { l: num(dims.l, 10), w: num(dims.w, 8), h: num(dims.h, 4) },
    // An identification with no title is not an identification, whatever the
    // model claimed — the comp search would have nothing to search on.
    identified: Boolean(raw.identified) && Boolean(String(raw.title ?? "").trim()),
    note: String(raw.note ?? ""),
  };
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_PHOTOS);
  if (oversized) return oversized;

  let body: {
    images?: { mediaType: string; data: string }[];
    /** A title typed by the person holding the item, which beats any guess. */
    hint?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const hint = String(body.hint ?? "").trim().slice(0, 120);
  const blocks: ImageBlock[] = [];
  for (const img of (body.images ?? []).slice(0, MAX_SCOUT_IMAGES)) {
    const block = toImageBlock(img);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0 && !hint) {
    return NextResponse.json(
      { ok: false, error: "Take a photo, or type what it is." },
      { status: 400 }
    );
  }

  // ── 1. What is it? ───────────────────────────────────────────────────────
  let ident: ScoutIdentification;
  if (blocks.length === 0) {
    // Typed-only: skip the model entirely. Someone who can name the item
    // doesn't need it identified, and this makes the no-photo path instant.
    ident = normalize({ title: hint, item_type: hint, identified: true, condition: "good" });
  } else {
    try {
      const client = getClient();
      const message = await client.messages.create(
        {
          model: SCOUT_MODEL,
          max_tokens: 700,
          messages: [
            {
              role: "user",
              content: [
                ...blocks,
                {
                  type: "text",
                  text: hint
                    ? `${SCOUT_PROMPT}\n\nThe person holding the item says it is: "${hint}". Treat that as fact and identify around it.`
                    : SCOUT_PROMPT,
                },
              ],
            },
          ],
        },
        { timeout: SCOUT_TIMEOUT_MS, maxRetries: 0 }
      );
      const text = message.content.find((c) => c.type === "text");
      ident = normalize(parseModelJson<Partial<ScoutIdentification>>(text?.type === "text" ? text.text : ""));
      if (hint) ident.title = hint;
    } catch (e) {
      const auth = anthropicAuthError(e);
      if (auth) return NextResponse.json({ ok: false, error: auth.message }, { status: 401 });
      return safeErrorResponse(
        "scout",
        e,
        "Couldn't identify that. Try another photo, or type what it is."
      );
    }
  }

  // ── 2. Postage ───────────────────────────────────────────────────────────
  // Costed before comps so an unidentified item still gets a shipping figure —
  // and because a bulky cheap item is a skip regardless of what it's worth.
  const shippingEstimate = estimateShipping({
    itemOz: ident.weight_oz,
    itemDims: ident.dims_in,
    category: ident.category,
  });
  const shipping = shippingEstimate.chosen?.usd ?? shippingEstimate.recommended?.usd ?? null;

  // ── 3. What does it go for? ──────────────────────────────────────────────
  let comps = null;
  let compsError: string | null = null;
  if (!ident.identified) {
    compsError = ident.note || "Couldn't identify it well enough to search the market.";
  } else if (!isEbayConfigured()) {
    compsError = "eBay isn't configured, so there's no market data.";
  } else {
    try {
      const token = await appToken();
      const listing = {
        title: ident.title,
        brand: ident.brand,
        item_type: ident.item_type,
        condition: CONDITION_MAP[ident.condition] ?? "Used",
      } as ListingResult;
      comps = await searchComps(token, listing);
    } catch (e) {
      // Advisory, like everywhere else comps are used — but named, because
      // "no comps" and "the lookup broke" lead to different decisions.
      console.warn(`[scout] comps failed: ${(e as Error).message}`);
      compsError = "Market lookup unavailable — check the price on eBay yourself.";
    }
  }

  return NextResponse.json({
    ok: true,
    identification: ident,
    comps,
    compsError,
    shipping,
    shippingLabel:
      shippingEstimate.chosen?.serviceName ?? shippingEstimate.recommended?.serviceName ?? null,
    shippingBox: shippingEstimate.chosen?.boxName ?? shippingEstimate.recommended?.boxName ?? null,
    packedOz: shippingEstimate.packedOz,
  });
}
