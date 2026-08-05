import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient, parseModelJson, AnthropicAuthError, anthropicAuthError } from "@/lib/anthropic";
import {
  BODY_LIMIT_PHOTOS,
  enforceBodyLimit,
  guardApiRequest,
  safeErrorResponse,
} from "@/lib/api-guard";
import {
  PROFILE_ROUTER_PROMPT,
  buildProfiledAnalysisPrompt,
  normalizeItemProfile,
} from "@/lib/prompts";
import { toImageBlock, type ImageBlock } from "@/lib/images";
import { optimizeTitle } from "@/lib/titleOptimizer";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";
import { resolveModel } from "@/lib/models";
import type { AnalyzeRequestBody, ListingResult } from "@/lib/types";

// Analysis takes 20-40s for a multi-photo item on a good day — and far longer
// when the API is slow. Run under the platform's 300s cap with our own budget
// (below) so a slow run fails with an error we control and a working Retry,
// not a platform kill (FUNCTION_INVOCATION_TIMEOUT).
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-4-8";
const ROUTER_MODEL = "claude-sonnet-4-6";
const MAX_IMAGES = 12;

// Stop starting work once the budget is spent — headroom under maxDuration.
const ANALYZE_TIME_BUDGET_MS = 250_000;
// Per-call caps: the SDK's default timeout is 10 MINUTES, so without these one
// stalled call would eat the whole function budget. SDK-internal retries stay
// off — the loops below are the single retry layer.
const ROUTER_TIMEOUT_MS = 20_000;
const ANALYSIS_CALL_TIMEOUT_MS = 120_000;
// Don't bother starting a call with less budget than this left.
const MIN_CALL_MS = 5_000;

function toImageBlocks(images: AnalyzeRequestBody["images"]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const block = toImageBlock(img);
    if (block) blocks.push(block);
  }
  return blocks;
}

// Mirrors route_item_profile(): honor a forced profile, else ask the model.
// Falls back to hard_goods when the router can't run (error or budget spent) —
// same fallback the catch below has always used.
async function routeProfile(
  client: Anthropic,
  imageBlocks: ImageBlock[],
  requested: string,
  routerModel: string,
  deadline: number
): Promise<string> {
  const forced = normalizeItemProfile(requested);
  if (forced !== "auto") return forced;

  const remaining = deadline - Date.now();
  if (remaining < MIN_CALL_MS) return "hard_goods";

  try {
    const resp = await client.messages.create(
      {
        model: routerModel,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              { type: "text", text: PROFILE_ROUTER_PROMPT },
            ],
          },
        ],
      },
      { timeout: Math.min(ROUTER_TIMEOUT_MS, remaining), maxRetries: 0 }
    );
    const text = firstText(resp);
    const data = parseModelJson<{ profile?: string }>(text);
    const routed = normalizeItemProfile(data?.profile ?? "auto");
    return routed !== "auto" ? routed : "hard_goods";
  } catch (e) {
    // Auth/billing failures must surface, not silently fall back to a profile.
    const fatal = anthropicAuthError(e);
    if (fatal) throw fatal;
    return "hard_goods";
  }
}

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_PHOTOS);
  if (oversized) return oversized;

  let body: AnalyzeRequestBody;
  try {
    body = (await req.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  // Validate client-supplied models against the server allowlist; fall back to
  // the trusted default on anything unknown (prevents billing an arbitrary or
  // premium model to the owner's key).
  const analysisModel = resolveModel(body.analysisModel, ANALYSIS_MODEL);
  const routerModel = resolveModel(body.routerModel, ROUTER_MODEL);

  if (!Array.isArray(body.images) || body.images.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Please add at least one photo." },
      { status: 400 }
    );
  }

  const imageBlocks = toImageBlocks(body.images);
  if (imageBlocks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No readable photos found. Use JPG, PNG, or WebP." },
      { status: 400 }
    );
  }

  let client: Anthropic;
  try {
    client = getClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }

  try {
    const deadline = Date.now() + ANALYZE_TIME_BUDGET_MS;
    const profile = await routeProfile(client, imageBlocks, body.profile, routerModel, deadline);
    const systemPrompt = buildProfiledAnalysisPrompt(profile);

    // Retry up to 3 times, mirroring the Python analyze_photos() loop — but
    // never start an attempt the time budget can't cover.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_CALL_MS) {
        lastErr = lastErr ?? new Error("Analysis ran out of time — the API is slow right now.");
        break;
      }
      try {
        const resp = await client.messages.create(
          {
            model: analysisModel,
            max_tokens: 3000,
            // System prompt is large and identical across requests for the same
            // profile — cache it to cut cost and latency.
            system: [
              {
                type: "text",
                text: systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              {
                role: "user",
                content: [
                  ...imageBlocks,
                  {
                    type: "text",
                    text: "Analyze these photos and return the listing JSON now.",
                  },
                ],
              },
            ],
          },
          { timeout: Math.min(ANALYSIS_CALL_TIMEOUT_MS, remaining), maxRetries: 0 }
        );
        const listing = parseModelJson<ListingResult>(firstText(resp));
        listing.item_profile = profile;
        // Deterministic title cleanup happens HERE, before the seller reviews —
        // the title on the card is exactly the title that publishes.
        listing.title = optimizeTitle(listing);
        // Same principle for the optional storewide markup: applied pre-review,
        // so the price on the card is exactly the price that publishes.
        listing.suggested_price = applyPriceMarkup(
          listing.suggested_price,
          priceMarkupPercent()
        );
        return NextResponse.json({ ok: true, listing });
      } catch (err) {
        const fatal = anthropicAuthError(err);
        if (fatal) throw fatal; // auth/billing won't fix itself on retry
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      console.error("[analyze] auth/billing failure:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return safeErrorResponse("analyze", e, "Something went wrong analyzing photos — please try again.");
  }
}
