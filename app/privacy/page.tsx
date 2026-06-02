import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Listing Writer",
  description: "How Listing Writer handles your data.",
};

export default function PrivacyPage() {
  return (
    <main className="wrap">
      <article className="panel" style={{ lineHeight: 1.7 }}>
        <h1 style={{ fontFamily: "var(--font-display)" }}>Privacy Policy</h1>
        <p style={{ color: "var(--color-ink-soft)" }}>
          Listing Writer is a personal tool for creating eBay listings from item
          photos. This policy explains what it does and does not do with your
          data.
        </p>

        <h2 className="section-label">What we collect</h2>
        <ul>
          <li>
            <strong>Photos you upload.</strong> They are resized in your browser
            and sent to our server only to generate listing text. They are{" "}
            <strong>not stored</strong> after the listing is written.
          </li>
          <li>
            <strong>Your eBay connection.</strong> If you connect eBay, we store
            an encrypted token in a cookie in your browser so the app can post
            listings on your behalf. We never see your eBay password.
          </li>
        </ul>

        <h2 className="section-label">What we share</h2>
        <ul>
          <li>
            Photos and listing text are sent to <strong>Anthropic</strong> (the
            AI that writes the listing) and, when you choose to post, to{" "}
            <strong>eBay</strong> to create your listing.
          </li>
          <li>
            We do not sell your data or share it with anyone else.
          </li>
        </ul>

        <h2 className="section-label">Your control</h2>
        <ul>
          <li>
            You can disconnect eBay at any time, which deletes the stored token.
          </li>
          <li>
            Clearing your browser cookies removes your saved eBay connection.
          </li>
        </ul>

        <h2 className="section-label">Contact</h2>
        <p>
          Questions about this policy can be directed to the account owner who
          operates this tool.
        </p>
      </article>
    </main>
  );
}
