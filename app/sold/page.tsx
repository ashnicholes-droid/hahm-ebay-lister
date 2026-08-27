import Link from "next/link";
import { SoldManager } from "./SoldManager";

export const metadata = {
  title: "What sold",
  description: "Completed eBay sales with real fees and realized profit.",
};

export const dynamic = "force-dynamic";

export default function SoldPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          💵
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>What sold — real fees, real profit</p>
        </div>
        <Link className="btn-ghost nav-link" href="/listings">
          🏷️ Live listings
        </Link>
        <Link className="btn-ghost nav-link" href="/">
          ← Back to posting
        </Link>
      </header>

      <SoldManager />
    </main>
  );
}
