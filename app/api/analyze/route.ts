import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";

import {
  PROFILE_ROUTER_PROMPT,
  buildProfiledAnalysisPrompt,
  normalizeItemProfile,
} from "@/lib/prompts";

import { toImageBlock, type ImageBlock } from "@/lib/images";

import { optimizeTitle } from "@/lib/titleOptimizer";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";

import type { AnalyzeRequestBody, ListingResult } from "@/lib/types";

export const maxDuration = 300;

const ANALYSIS_MODEL = "gpt-5.4";
const ROUTER_MODEL = "gpt-5.4-mini";

const MAX_IMAGES = 12;

const ANALYZE_TIME_BUDGET_MS = 250_000;
const ROUTER_TIMEOUT_MS = 20_000;
const ANALYSIS_CALL_TIMEOUT_MS = 120_000;
const MIN_CALL_MS = 5_000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it in Vercel → Settings → Environment Variables."
    );
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
    });
  }

  return client;
}

function parseModelJson<T = unknown>(raw: string): T {
  let text = (raw || "").trim();

  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]) as T;
    }

    throw new Error("Model did not return valid JSON.");
  }
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const status = (error as { status?: unknown }).status;

  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return String(error ?? "");
}

function isFatalOpenAIError(error: unknown): boolean {
  const status = getErrorStatus(error);

  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status === 402
  );
}

function openAIErrorMessage(error: unknown): string {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error);

  if (status === 401) {
    return "OpenAI rejected the API key (401). Check OPENAI_API_KEY in Vercel Environment Variables.";
  }

  if (status === 403) {
    return "OpenAI rejected this request (403). Check your OpenAI API key permissions and model access.";
  }

  if (status === 429) {
    return "OpenAI rate limit or quota reached (429). Check your OpenAI billing and usage, then try again.";
  }

  if (status === 402) {
    return "OpenAI billing is unavailable for this request. Check your OpenAI billing and account status.";
  }

  return message || "OpenAI request failed.";
}

function resolveOpenAIModel(
  requested: unknown,
  fallback: string
): string {
  const model = typeof requested === "string" ? requested.trim() : "";

  const allowed = new Set([
    "gpt-5.4",
    "gpt-5.4-mini",
  ]);

  return allowed.has(model) ? model : fallback;
}

function toImageBlocks(
  images: AnalyzeRequestBody["images"]
): ImageBlock[] {
  const blocks: ImageBlock[] = [];

  for (const img of images.slice(0, MAX_IMAGES)) {
    const block = toImageBlock(img);

    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
}

async function routeProfile(
  client: OpenAI,
  imageBlocks: ImageBlock[],
  requested: string,
  routerModel: string,
  deadline: number
): Promise<string> {
  const forced = normalizeItemProfile(requested);

  if (forced !== "auto") {
    return forced;
  }

  const remaining = deadline - Date.now();

  if (remaining < MIN_CALL_MS) {
    return "hard_goods";
  }

  try {
    const response = await client.responses.create(
      {
        model: routerModel,
        input: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              {
                type: "input_text",
                text: PROFILE_ROUTER_PROMPT,
              },
            ],
          },
        ],
      },
      {
        timeout: Math.min(ROUTER_TIMEOUT_MS, remaining),
        maxRetries: 0,
      }
    );

    const text = response.output_text?.trim() ?? "";

    const data = parseModelJson<{ profile?: string }>(text);

    const routed = normalizeItemProfile(data?.profile ?? "auto");

    return routed !== "auto" ? routed : "hard_goods";
  } catch (error) {
    if (isFatalOpenAIError(error)) {
      throw new Error(openAIErrorMessage(error));
    }

    return "hard_goods";
  }
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);

  if (denied) {
    return denied;
  }

  let body: AnalyzeRequestBody;

  try {
    body = (await req.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid request body.",
      },
      {
        status: 400,
      }
    );
  }

  if (!Array.isArray(body.images) || body.images.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "Please add at least one photo.",
      },
      {
        status: 400,
      }
    );
  }

  const analysisModel = resolveOpenAIModel(
    body.analysisModel,
    ANALYSIS_MODEL
  );

  const routerModel = resolveOpenAIModel(
    body.routerModel,
    ROUTER_MODEL
  );

  const imageBlocks = toImageBlocks(body.images);

  if (imageBlocks.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "No readable photos found. Use JPG, PNG, or WebP.",
      },
      {
        status: 400,
      }
    );
  }

  let openai: OpenAI;

  try {
    openai = getClient();
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  try {
    const deadline = Date.now() + ANALYZE_TIME_BUDGET_MS;

    const profile = await routeProfile(
      openai,
      imageBlocks,
      body.profile,
      routerModel,
      deadline
    );

    const systemPrompt = buildProfiledAnalysisPrompt(profile);

    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();

      if (remaining < MIN_CALL_MS) {
        lastError =
          lastError ??
          new Error(
            "Analysis ran out of time — the API is slow right now."
          );

        break;
      }

      try {
        const response = await openai.responses.create(
          {
            model: analysisModel,

            input: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: [
                  ...imageBlocks,
                  {
                    type: "input_text",
                    text: "Analyze these photos and return the listing JSON now.",
                  },
                ],
              },
            ],

            text: {
              format: {
                type: "json_object",
              },
            },
          },
          {
            timeout: Math.min(
              ANALYSIS_CALL_TIMEOUT_MS,
              remaining
            ),
            maxRetries: 0,
          }
        );

        const text = response.output_text?.trim() ?? "";

        if (!text) {
          throw new Error(
            "OpenAI returned an empty response."
          );
        }

        const listing =
          parseModelJson<ListingResult>(text);

        listing.item_profile = profile;

        listing.title = optimizeTitle(listing);

        listing.suggested_price = applyPriceMarkup(
          listing.suggested_price,
          priceMarkupPercent()
        );

        return NextResponse.json({
          ok: true,
          listing,
        });
      } catch (error) {
        if (isFatalOpenAIError(error)) {
          throw new Error(openAIErrorMessage(error));
        }

        lastError = error;

        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1500 * (attempt + 1))
          );
        }
      }
    }

    throw lastError ?? new Error("Analysis failed.");
  } catch (error) {
    console.error("[analyze]", error);

    return safeErrorResponse(
      "analyze",
      error,
      "Something went wrong analyzing photos — please try again."
    );
  }
}
