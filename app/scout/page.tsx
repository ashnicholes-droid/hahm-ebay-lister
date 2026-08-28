import Link from "next/link";
import { ScoutManager } from "./ScoutManager";

export const metadata = {
  title: "Scout — should you buy it?",
  description: "Check an item's resale value and your maximum buy price before you buy it.",
};

export const dynamic = "force-dynamic";

export default function ScoutPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🔦
        </span>
        <div>
          <h1>Scout</h1>
          <p>Should you buy it?</p>
        </div>
        <Link className="btn-ghost nav-link" href="/">
          ← Back to posting
        </Link>
      </header>

      <ScoutManager />
    </main>
  );
}
