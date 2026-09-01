import { APP_VERSION, OWNER_NAME, OWNER_URL, OWNER_YEAR } from "@/lib/appInfo";

// The credit line and build number at the foot of the main page.
//
// The version earns its place: this deploys continuously, so "is the fix I
// asked for actually live?" is a question that comes up constantly, and the
// answer being on screen beats digging through Vercel.

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>
        © {OWNER_YEAR}{" "}
        <a href={OWNER_URL} target="_blank" rel="noopener noreferrer">
          {OWNER_NAME}
        </a>
      </span>
      <span className="site-footer-sep" aria-hidden="true">
        ·
      </span>
      <span className="site-footer-version">v{APP_VERSION}</span>
    </footer>
  );
}
