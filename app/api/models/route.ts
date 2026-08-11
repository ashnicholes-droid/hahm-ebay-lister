import { NextResponse } from "next/server";
import OpenAI from "openai";
import { isAllowedModel } from "@/lib/models";

const SORT_DEFAULT = "gpt-5.4-mini";
const ANALYSIS_DEFAULT = "gpt-5.4";

export interface ModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

interface ModelsPayload {
  sortModels: ModelOption[];
  analysisModels: ModelOption[];
}

// Keep this list intentionally small and stable.
// These are the OpenAI models this app will offer in its selector.
const MODELS: ModelOption[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "High-quality model for detailed item analysis and listing generation.",
    isDefault: false,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Fast, lower-cost model for photo sorting and routine listing work.",
    isDefault: true,
  },
];

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let cache: ModelsPayload | null = null;
let cacheAt = 0;

function buildPayload(): ModelsPayload {
  const allowed = MODELS.filter((m) => isAllowedModel(m.id));

  const sortModels = allowed.map((m) => ({
    ...m,
    isDefault: m.id === SORT_DEFAULT,
  }));

  const analysisModels = allowed.map((m) => ({
    ...m,
    isDefault: m.id === ANALYSIS_DEFAULT,
  }));

  return { sortModels, analysisModels };
}

export async function GET() {
  const now = Date.now();

  if (cache && now - cacheAt < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    // Confirm the OpenAI API key exists without exposing it.
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(buildPayload());
    }

    // Initialize the OpenAI client so deployment/runtime configuration
    // is validated without making an unnecessary API request.
    new OpenAI({ apiKey });

    cache = buildPayload();
    cacheAt = now;

    return NextResponse.json(cache);
  } catch {
    return NextResponse.json(buildPayload());
  }
}
