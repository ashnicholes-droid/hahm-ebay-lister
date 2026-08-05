import { NextRequest, NextResponse } from "next/server";
import { getClient, AnthropicAuthError } from "@/lib/anthropic";
import {
  BODY_LIMIT_PHOTOS,
  enforceBodyLimit,
  guardApiRequest,
  safeErrorResponse,
} from "@/lib/api-guard";
import { checkMergePair } from "@/lib/sortPipeline";
import { isAllowedModel } from "@/lib/models";
import type { WireImage } from "@/lib/images";

// Merge check across sort-chunk boundaries: big batches are sorted 100 photos
// per request, so an item photographed across a boundary is split into two
// groups. The client sends the first photo of each candidate pair here.

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;
  const oversized = enforceBodyLimit(req, BODY_LIMIT_PHOTOS);
  if (oversized) return oversized;

  let body: { a?: WireImage; b?: WireImage; countA?: number; countB?: number; sortModel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (!body.a?.data || !body.b?.data) {
    return NextResponse.json({ ok: false, error: "Missing photos." }, { status: 400 });
  }

  const requested = typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const model = isAllowedModel(requested) ? requested : undefined;

  try {
    const merge = await checkMergePair(
      getClient(),
      body.a,
      body.b,
      Math.max(1, Number(body.countA) || 1),
      Math.max(1, Number(body.countB) || 1),
      model
    );
    return NextResponse.json({ ok: true, merge });
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return safeErrorResponse("merge-check", e, "Merge check failed.");
  }
}
