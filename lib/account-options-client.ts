"use client";
import type { AccountOptions } from "./ebay/publish";
import { apiPost } from "./api-client";

let cached: { value: AccountOptions; expires: number } | undefined;
let pending: Promise<AccountOptions> | undefined;
let generation = 0;
export function clearAccountOptions() {
  generation++;
  cached = undefined;
  pending = undefined;
}
// Memory only: never persist one seller's policies across sign-in changes.
export function loadAccountOptions(refresh = false): Promise<AccountOptions> {
  if (pending) return pending;
  if (!refresh && cached && cached.expires > Date.now())
    return Promise.resolve(cached.value);
  const epoch = generation;
  const request = (async () => {
    const response = await apiPost("/api/ebay/options", {});
    const data = await response.json();
    if (!response.ok || !data.ok || !data.options)
      throw new Error(data.error || "Could not load eBay policies.");
    if (epoch !== generation)
      throw new Error("eBay connection changed. Reload policies.");
    cached = { value: data.options, expires: Date.now() + 5 * 60_000 };
    return data.options as AccountOptions;
  })();
  pending = request;
  void request
    .finally(() => {
      if (pending === request) pending = undefined;
    })
    .catch(() => {});
  return request;
}
