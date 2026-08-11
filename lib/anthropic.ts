import OpenAI from "openai";

let client: OpenAI | null = null;

export function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it in Vercel → Settings → Environment Variables."
    );
  }

  if (!client) {
    client = new OpenAI({ apiKey });
  }

  return client;
}

// Parse JSON returned by the model, even if it is wrapped in markdown fences.
export function parseModelJson<T = unknown>(raw: string): T {
  let text = (raw || "").trim();

  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);

    if (match) {
      return JSON.parse(match[0]) as T;
    }

    throw new Error("Model did not return valid JSON.");
  }
}

// Kept for compatibility with existing route error handling.
export class AnthropicAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AnthropicAuthError";
    this.status = status;
  }
}

export function anthropicAuthError(error: unknown): AnthropicAuthError | null {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;

  const message =
    error &&
    typeof error === "object" &&
    "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";

  if (status === 401) {
    return new AnthropicAuthError(
      "OpenAI rejected the API key (401). Check OPENAI_API_KEY in your environment variables.",
      401
    );
  }

  if (status === 403) {
    return new AnthropicAuthError(
      "OpenAI API access was denied (403). Check the API key and project permissions.",
      403
    );
  }

  if (status === 429) {
    return new AnthropicAuthError(
      "OpenAI rate limit or quota reached (429). Check billing/usage and try again.",
      429
    );
  }

  if (message.toLowerCase().includes("openai")) {
    return new AnthropicAuthError(message, status ?? 500);
  }

  return null;
}
