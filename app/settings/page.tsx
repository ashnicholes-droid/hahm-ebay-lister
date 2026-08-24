import Link from "next/link";
import { PricingSettings } from "./PricingSettings";
import { ShipFromSettings } from "./ShipFromSettings";

export const metadata = {
  title: "Settings",
  description: "Where you ship from, and how suggested prices are derived.",
};

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🏷️
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>Settings</p>
        </div>
        <Link className="btn-ghost nav-link" href="/">
          ← Back to posting
        </Link>
      </header>

      <ShipFromSettings />
      <PricingSettings />
    </main>
  );
}
