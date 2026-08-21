import Link from "next/link";
import { PricingSettings } from "./PricingSettings";

export const metadata = {
  title: "Pricing settings",
  description: "How suggested prices are derived from the market.",
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
          <p>Pricing settings</p>
        </div>
        <Link className="btn-ghost nav-link" href="/">
          ← Back to posting
        </Link>
      </header>

      <PricingSettings />
    </main>
  );
}
