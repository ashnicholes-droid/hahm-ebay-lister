import Link from "next/link";
import { ListingsManager } from "./ListingsManager";
import { Logo } from "../Logo";

export const metadata = {
  title: "Your eBay listings",
  description: "See and edit the prices of your live eBay listings.",
};

// Gated by middleware like every other non-public path — nothing extra needed
// here beyond the page itself.
export const dynamic = "force-dynamic";

export default function ListingsPage() {
  return (
    <main className="wrap">
      <header className="masthead">
        <Logo className="logo-mark" size={44} title="" />
        <div>
          <h1>Flipwright</h1>
          <p>Seller view — live listings and prices</p>
        </div>
        <Link className="btn-ghost nav-link" href="/sold">
          💵 What sold
        </Link>
        <Link className="btn-ghost nav-link" href="/">
          ← Back to posting
        </Link>
      </header>

      <ListingsManager />
    </main>
  );
}
