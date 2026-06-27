import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your environment variables (Coolify → Environment, or .env.local for local dev)."
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

// Mirrors _load_model_json() in the Python script: strip code fences, then fall
// back to grabbing the outermost {...} block.
export function parseModelJson<T = unknown>(raw: string): T {
  let text = (raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/gm, "").replace(/\s*```$/gm, "");
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

// ── Account-level Anthropic failures ─────────────────────────────────────────
// A bad/missing key, missing model access, or exhausted credits makes EVERY
// call fail, so retrying or degrading is pointless — it just surfaces a vague
// error. Detect these and throw a typed error so routes can show the real cause.
export class AnthropicAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AnthropicAuthError";
    this.status = status;
  }
}

export function anthropicAuthError(e: unknown): AnthropicAuthError | null {
  const status =
    e && typeof e === "object" && "status" in e
      ? Number((e as { status?: number }).status)
      : undefined;
  const message =
    e && typeof e === "object" && "message" in e
      ? String((e as { message?: unknown }).message ?? "")
      : "";
  if (status === 401)
    return new AnthropicAuthError(
      "Anthropic rejected your API key (401). Check that ANTHROPIC_API_KEY is set correctly in your environment variables.",
      401
    );
  if (status === 403)
    return new AnthropicAuthError(
      "Your Anthropic API key isn't permitted to use this model (403). Check the key's access in the Anthropic Console.",
      403
    );
  if (status === 402 || /credit balance|too low|billing|payment|insufficient|quota/i.test(message))
    return new AnthropicAuthError(
      "Your Anthropic account can't cover this request — add credits/billing in the Anthropic Console, then try again.",
      402
    );
  return null;
}
