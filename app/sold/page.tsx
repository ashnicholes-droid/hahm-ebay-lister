import Link from "next/link";
import { SoldManager } from "./SoldManager";
import { Logo } from "../Logo";

export const metadata = {
  title: "What sold",
  description: "Completed eBay sales with real fees and realized profit.",
};

export const dynamic = "force-dynamic";

export default function SoldPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <Logo className="logo-mark" size={44} title="" />
        <div>
          <h1>Flipwright</h1>
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
