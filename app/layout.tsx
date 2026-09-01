import type { Metadata, Viewport } from "next";
import { APP_NAME, APP_TAGLINE } from "@/lib/appInfo";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // The tab is narrow, so the name comes first and the tagline is what gets
  // truncated. `title` also seeds the iOS home-screen label.
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description:
    "Upload your item photos and get a ready-to-post eBay listing in seconds.",
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The mark's teal, so the phone's chrome matches the tab icon.
  themeColor: "#0A6154",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
