"use client";

import { useEffect, useState } from "react";
import { normalizeEbayEnv, type EbayEnv } from "@/lib/ebay/environment";

// Which eBay the SERVER is talking to, readable from a client component.
//
// The value is stamped onto <html data-ebay-env> by the root layout, which
// reads it from the same config module the API routes use. So this is a DOM
// read, not a fetch: no round trip, no loading state, and nothing that can fail
// and leave the browser guessing.
//
// The obvious alternative — a NEXT_PUBLIC_EBAY_ENV variable — is rejected on
// purpose. Two variables can disagree, and the dangerous direction of that
// disagreement is silent: EBAY_ENV=sandbox with the public one forgotten gives
// a deployment that posts to the sandbox while looking exactly like production.
// One value, set in one place, by the code that makes the calls.

function readStamp(): EbayEnv {
  if (typeof document === "undefined") return "production";
  return normalizeEbayEnv(document.documentElement.dataset.ebayEnv);
}

/**
 * The deployment's eBay environment.
 *
 * Starts as "production" and settles after mount rather than reading the DOM
 * during render, which would disagree with the server pass and trip a
 * hydration mismatch. Production is also the right thing to assume while
 * unknown: claiming "sandbox" when we don't know would make someone
 * comfortable ending listings that turn out to be real.
 */
export function useEbayEnv(): EbayEnv {
  const [env, setEnv] = useState<EbayEnv>("production");
  useEffect(() => setEnv(readStamp()), []);
  return env;
}
