import { EBAY_ENV } from "@/lib/ebay/config";

// "Which account am I about to change?"
//
// This app ends listings, relists them, sends offers to real buyers, and marks
// real orders shipped. Once there is a second deployment, the single most
// expensive mistake available is doing one of those on the wrong one — and
// nothing about a dev deployment looks different from production, because it is
// the same code on a similar URL.
//
// So the sandbox says so, permanently, on every page, in a colour used nowhere
// else in the app. Deliberately not dismissible: a banner you can close is a
// banner that is closed on the day it matters.
//
// A SERVER component on purpose. Fetching this from the browser would leave a
// window — however short — where a sandbox deployment renders looking exactly
// like production, and would fail open if the probe failed. Read straight from
// the same config the API calls use, there is no window and nothing to disagree
// with.
//
// Nothing renders in production: a safety marker that appears everywhere stops
// being read.

export function EbayEnvBanner() {
  if (EBAY_ENV !== "sandbox") return null;

  return (
    <div className="env-banner" role="status">
      <strong>SANDBOX</strong>
      <span>
        This deployment talks to eBay&rsquo;s test environment. Listings, orders and money here are
        not real — and nothing you do can touch your live account.
      </span>
    </div>
  );
}
