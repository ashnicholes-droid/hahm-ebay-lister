// Who made this and which build you're looking at.
//
// The version is read from package.json rather than typed here, so bumping the
// package is the single act that changes it — a hand-maintained constant beside
// a package version is two sources of truth, and the one on screen is the one
// that goes stale.
//
// Next.js inlines this at build time (it resolves the JSON import during the
// bundle), so it costs nothing at runtime and works in a client component.

import pkg from "../package.json";

export const APP_NAME = "Flipwright";
export const APP_TAGLINE = "Photos in, listings out, profit counted.";

export const APP_VERSION = String(pkg.version ?? "0.0.0");

export const OWNER_NAME = "FoundryLab LLC";
export const OWNER_URL = "https://www.foundrylabllc.com/";

/**
 * The year in the copyright line.
 *
 * Fixed rather than `new Date().getFullYear()`: a value computed in the browser
 * differs from the one rendered on the server for anyone whose clock has rolled
 * over, and React calls that a hydration mismatch. It is one edit a year.
 */
export const OWNER_YEAR = 2026;
