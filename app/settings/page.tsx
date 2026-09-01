import Link from "next/link";
import { PricingSettings } from "./PricingSettings";
import { ShipFromSettings } from "./ShipFromSettings";
import { Logo } from "../Logo";

export const metadata = {
  title: "Settings",
  description: "Where you ship from, and how suggested prices are derived.",
};

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <Logo className="logo-mark" size={44} title="" />
        <div>
          <h1>Flipwright</h1>
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
