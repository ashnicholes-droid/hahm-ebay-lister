import { NextRequest, NextResponse } from "next/server";

// Evaluated once per cold start — env vars do not change at runtime.
const isProd = process.env.NODE_ENV === "production";

export function middleware(request: NextRequest) {
  // Fresh nonce for every HTML response. Buffer is polyfilled by Next.js for
  // the Edge runtime; crypto.randomUUID() is part of the Web Crypto API.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = [
    "default-src 'self'",
    // 'nonce-...' replaces 'unsafe-inline' for scripts — only the inline chunks
    // Next.js stamps with this nonce will execute. 'strict-dynamic' lets those
    // nonce-tagged scripts load further chunks without widening the policy.
    // 'unsafe-eval' is only added in non-production for webpack HMR / source maps.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${!isProd ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // blob:/data: for in-browser photo resizing previews
    "img-src 'self' data: blob: https://i.ebayimg.com",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");

  // Stamp the nonce on the request so Next.js 15 can apply it automatically to
  // the inline <script> tags it generates during SSR (hydration, RSC payload).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  matcher: [
    {
      // Run on all routes except Next.js internals and static assets.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      // Skip prefetch requests — they don't render HTML and don't need a nonce.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
