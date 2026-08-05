import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient, parseModelJson, AnthropicAuthError, anthropicAuthError } from "@/lib/anthropic";
import {
  BODY_LIMIT_PHOTOS,
  enforceBodyLimit,
  guardApiRequest,
  safeErrorResponse,
} from "@/lib/api-guard";
import { VERIFY_SYSTEM_PROMPT, buildVerifyUserPrompt } from "@/lib/prompts";
import { toImageBlock, type ImageBlock } from "@/lib/images";
import { resolveModel } from "@/lib/models";
import type { PhotoClaim } from "@/lib/verification";
import type { ListingResult } from "@/lib/types";

// One model call over photos we've already resized. Comfortably inside the
// platform cap, but budgeted anyway so a slow API returns an error we control.
export const maxDuration = 120;

// The audit is a judgement call about evidence, so it gets the same tier as the
// analysis that wrote the listing — a cheaper model here would just agree with
// whatever text it was shown, which is the exact failure this pass exists to
// catch.
const VERIFY_MODEL = "claude-opus-4-8";
const MAX_IMAGES = 12;
const MAX_CLAIMS = 12;
const CALL_TIMEOUT_MS = 90_000;

const VALID_FIELDS = new Set([
  "title",
  "price",
  "condition",
  "description",
  "size",
  "brand",
  "specifics",
]);
const VALID_STATUSES = new Set(["supported", "not_visible", "contradicted"]);

interface VerifyBody {
  images?: { mediaType: string; data: string }[];
  listing?: ListingResult;
  verifyModel?: string;
}

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

/**
 * Keep only well-formed claims. Model output lands directly in the seller's UI,
 * so field/status must be values we recognise and free text must be bounded —
 * an unbounded "note" is a model that decided to write an essay, not a finding.
 */
function sanitizeClaims(raw: unknown): PhotoClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: PhotoClaim[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const field = String(c.field ?? "").trim();
    const status = String(c.status ?? "").trim();
    const claim = String(c.claim ?? "").trim().slice(0, 200);
    if (!VALID_FIELDS.has(field) || !VALID_STATUSES.has(status) || !claim) continue;
    // The model is told not to grade price; enforce it rather than trusting.
    if (field === "price") continue;
    const note = String(c.note ?? "").trim().slice(0, 200);
    out.push({
      field: field as PhotoClaim["field"],
      status: status as PhotoClaim["status"],
      claim,
      ...(note ? { note } : {}),
    });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_PHOTOS);
  if (oversized) return oversized;

  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!body.listing || typeof body.listing !== "object") {
    return NextResponse.json({ ok: false, error: "Missing listing." }, { status: 400 });
  }

  const imageBlocks: ImageBlock[] = [];
  for (const img of (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)) {
    const block = toImageBlock(img);
    if (block) imageBlocks.push(block);
  }
  if (imageBlocks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No readable photos to check against." },
      { status: 400 }
    );
  }

  const model = resolveModel(body.verifyModel, VERIFY_MODEL);

  let client: Anthropic;
  try {
    client = getClient();
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }

  try {
    const resp = await client.messages.create(
      {
        model,
        max_tokens: 2000,
        // The auditor prompt is long, fixed, and identical for every item in a
        // batch — cache it so a 40-item run pays for it once.
        system: [
          {
            type: "text",
            text: VERIFY_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              { type: "text", text: buildVerifyUserPrompt(body.listing) },
            ],
          },
        ],
      },
      { timeout: CALL_TIMEOUT_MS, maxRetries: 1 }
    );

    const parsed = parseModelJson<{ claims?: unknown }>(firstText(resp));
    return NextResponse.json({ ok: true, claims: sanitizeClaims(parsed?.claims) });
  } catch (e) {
    const fatal = anthropicAuthError(e);
    if (fatal instanceof AnthropicAuthError) {
      console.error("[verify] auth/billing failure:", fatal.message);
      return NextResponse.json({ ok: false, error: fatal.message }, { status: fatal.status });
    }
    return safeErrorResponse(
      "verify",
      e,
      "Couldn't run the photo accuracy check — please try again."
    );
  }
}
