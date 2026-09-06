// Exact model IDs prevent browser requests from selecting arbitrary billed models.
// Deployment owners can override this list with ANTHROPIC_ALLOWED_MODELS.
const DEFAULT_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];
const allowedModels = () =>
  new Set(
    (process.env.ANTHROPIC_ALLOWED_MODELS || DEFAULT_MODELS.join(","))
      .split(",")
      .map((s) => s.trim()),
  );
const MAX_MODEL_ID_LEN = 64;

/** True when `model` is a non-empty string this deployment is allowed to call. */
export function isAllowedModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.length > 0 &&
    model.length <= MAX_MODEL_ID_LEN &&
    allowedModels().has(model)
  );
}

/**
 * Return the requested model only when it passes the allowlist; otherwise the
 * trusted fallback. Trims surrounding whitespace before checking. Use this in any
 * route that accepts a client-supplied model id.
 */
export function resolveModel(requested: unknown, fallback: string): string {
  const m = typeof requested === "string" ? requested.trim() : "";
  return isAllowedModel(m) ? m : fallback;
}
