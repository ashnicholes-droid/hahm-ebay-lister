// Server-side allowlist for the user-selectable Claude models.
//
// The per-step model selector lets the browser send a model id to the AI routes.
// That value is untrusted: without validation, anyone past the access gate could
// bill an arbitrary or premium model to the deployment owner's Anthropic key. We
// accept only the known Claude families this app supports and intentionally
// EXCLUDE the premium "fable" tier — a typical deployment key can't use it, and it
// would let a holder of the access code steer spend to the most expensive model.
// To offer a different set (e.g. a key that does have fable access), edit this
// pattern.
const ALLOWED_MODEL_PATTERN = /^claude-(opus|sonnet|haiku)-/;
const MAX_MODEL_ID_LEN = 64;

/** True when `model` is a non-empty string this deployment is allowed to call. */
export function isAllowedModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.length > 0 &&
    model.length <= MAX_MODEL_ID_LEN &&
    ALLOWED_MODEL_PATTERN.test(model)
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
