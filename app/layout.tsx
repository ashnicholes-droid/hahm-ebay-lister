import type { Metadata, Viewport } from "next";
import "./globals.css";
import { EbayEnvBanner } from "./EbayEnvBanner";
import { EBAY_ENV } from "@/lib/ebay/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Listing Writer — turn photos into eBay listings",
  description:
    "Upload your item photos and get a ready-to-post eBay listing in seconds.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d6b5f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Stamped on <html> so client components can read the environment without a
    // round trip — see app/useEbayEnv.ts. One server-rendered value, so nothing
    // in the browser can hold a different opinion about which eBay this is.
    <html lang="en" data-ebay-env={EBAY_ENV}>
      <body>
        <EbayEnvBanner />
        {children}
      </body>
    </html>
  );
}
