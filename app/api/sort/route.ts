import { NextRequest, NextResponse } from "next/server";
import { getClient, AnthropicAuthError } from "@/lib/anthropic";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { sortPhotos, SortUnavailableError } from "@/lib/sortPipeline";
import { isAllowedModel } from "@/lib/models";
import type { WireImage } from "@/lib/images";

// Sorting makes several model calls across grouping/verify/merge stages.
export const maxDuration = 120;

const MAX_PHOTOS = 120;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { images?: WireImage[]; sortModel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS) : [];
  // Validate the client-supplied model against the server allowlist — an
  // unchecked value would let anyone past the access gate bill an arbitrary or
  // premium model to the owner's key. Unknown → undefined (pipeline default).
  const requestedSort = typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const sortModel = isAllowedModel(requestedSort) ? requestedSort : undefined;
  if (images.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Please add some photos first." },
      { status: 400 }
    );
  }

  let client;
  try {
    client = getClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }

  try {
    const result = await sortPhotos(client, images, sortModel);
    if (result.groups.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "The AI couldn't pick out any separate items in these photos. Make sure each item is clearly shown, then try again.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      console.error("[sort] auth/billing failure:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    if (e instanceof SortUnavailableError) {
      console.error("[sort] every grouping batch failed:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return safeErrorResponse("sort", e, "Sorting failed — please try again.");
  }
}
