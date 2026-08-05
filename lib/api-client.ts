"use client";

/**
 * Client-side fetch wrapper for the API routes.
 *
 * Reaching the app at all now requires a session cookie (see middleware.ts), so
 * in the normal case every request here is already authenticated and this is a
 * thin wrapper over fetch.
 *
 * The interesting case is a session that expires MID-BATCH. Redirecting to the
 * login page there would be correct and awful: the photos live in React state,
 * so navigating away destroys an in-progress batch the seller may have spent
 * twenty minutes on. Instead we re-authenticate in place — prompt, exchange the
 * code for a fresh cookie, replay the original request — and the batch survives.
 */

async function doFetch(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Same-origin cookies ride along by default, but be explicit: this is the
    // credential the request depends on.
    credentials: "same-origin",
  });
}

/** Exchange an access code for a session cookie. Returns true on success. */
async function login(code: string): Promise<boolean> {
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && Boolean(data.ok);
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    window.location.href = "/login";
  }
}

/**
 * POST to an API route, recovering in place from an expired session.
 */
export async function apiPost(path: string, body: unknown): Promise<Response> {
  let res = await doFetch(path, body);

  // Up to two attempts: covers a plain expiry and one mistyped code.
  for (let attempt = 0; attempt < 2 && res.status === 401; attempt++) {
    const entered = window.prompt(
      attempt === 0
        ? "Your session expired. Re-enter your access code to keep going — your photos and listings are safe."
        : "That didn't match — try again:"
    );
    if (!entered || !entered.trim()) return res; // cancelled — surface the 401
    if (!(await login(entered.trim()))) continue;
    res = await doFetch(path, body);
  }
  return res;
}
