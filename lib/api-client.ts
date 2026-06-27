"use client";

/**
 * Client-side fetch wrapper for the AI API routes.
 *
 * When the deployment has APP_SECRET set, the server answers 401 with
 * code ACCESS_CODE_REQUIRED until the request carries the matching
 * `x-app-secret` header. We ask the user once, remember the code in
 * localStorage, and retry — so each device prompts a single time.
 */

const STORAGE_KEY = "listing-writer:access-code";

function storedCode(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveCode(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* private browsing — code just won't persist */
  }
}

export function clearAccessCode(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

async function doFetch(path: string, body: unknown, code: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (code) headers["x-app-secret"] = code;
  return fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * POST to an API route, handling the access-code handshake. Prompts the user
 * for the code when the server requires one (or when a saved code went stale).
 */
export async function apiPost(path: string, body: unknown): Promise<Response> {
  let code = storedCode();
  let res = await doFetch(path, body, code);

  // Up to two prompt attempts: covers both "no code yet" and "wrong code".
  for (let attempt = 0; attempt < 2 && res.status === 401; attempt++) {
    const entered = window.prompt(
      attempt === 0
        ? "Enter your access code. This is the APP_SECRET you set in your environment variables — not your Anthropic API key."
        : "That didn't match the APP_SECRET in your environment variables — try again:"
    );
    if (!entered || !entered.trim()) return res; // user cancelled — surface the 401
    code = entered.trim();
    res = await doFetch(path, body, code);
    if (res.status !== 401) saveCode(code);
  }
  return res;
}
