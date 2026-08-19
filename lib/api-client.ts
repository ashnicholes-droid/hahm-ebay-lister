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
 * Is this 401 about OUR session, or about something else?
 *
 * Routes return 401 for two unrelated reasons: the app's session cookie has
 * expired (the guard, which tags its reply ACCESS_CODE_REQUIRED), and eBay
 * isn't connected. Only the first is fixed by re-entering an access code.
 * Without this check, hitting Post with eBay disconnected popped a password
 * prompt that could not possibly help.
 *
 * The response is cloned because reading the body consumes it, and the caller
 * still needs it.
 */
async function isSessionExpiry(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const data = (await res.clone().json()) as { code?: string };
    return data?.code === "ACCESS_CODE_REQUIRED";
  } catch {
    // A 401 with no readable body is more likely the guard than a route, and
    // prompting is recoverable where silently failing is not.
    return true;
  }
}

async function recoverSession(attempt: number): Promise<boolean> {
  const entered = window.prompt(
    attempt === 0
      ? "Your session expired. Re-enter your access code to keep going — your photos and listings are safe."
      : "That didn't match — try again:"
  );
  if (!entered || !entered.trim()) return false;
  return login(entered.trim());
}

/**
 * POST to an API route, recovering in place from an expired session.
 */
export async function apiPost(path: string, body: unknown): Promise<Response> {
  let res = await doFetch(path, body);

  // Up to two attempts: covers a plain expiry and one mistyped code.
  for (let attempt = 0; attempt < 2 && (await isSessionExpiry(res)); attempt++) {
    if (!(await recoverSession(attempt))) return res; // cancelled — surface the 401
    res = await doFetch(path, body);
  }
  return res;
}

/** GET from an API route, with the same in-place session recovery. */
export async function apiGet(path: string): Promise<Response> {
  const get = () => fetch(path, { credentials: "same-origin" });
  let res = await get();
  for (let attempt = 0; attempt < 2 && (await isSessionExpiry(res)); attempt++) {
    if (!(await recoverSession(attempt))) return res;
    res = await get();
  }
  return res;
}
