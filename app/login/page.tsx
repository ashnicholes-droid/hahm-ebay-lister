import { LoginForm } from "./LoginForm";

// Deliberately says nothing about what is behind it — no app name in the copy,
// no hint about the eBay account, no indication of whether this deployment is
// even configured. Someone who finds the URL learns only that a code exists.
export const metadata = {
  title: "Sign in",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const configured = Boolean(process.env.APP_SECRET);

  return (
    <main className="wrap login-wrap">
      <section className="panel login-panel">
        <span className="logo-mark" aria-hidden="true">
          🔒
        </span>
        <h1>Enter your access code</h1>
        {configured ? (
          <>
            <p className="login-sub">
              This app is private. Your code is remembered on this device for 30 days.
            </p>
            <LoginForm next={next} />
          </>
        ) : (
          <p className="note note-error">
            This deployment has no <code>APP_SECRET</code> configured, so there is no
            code to enter. Set it in Vercel → Settings → Environment Variables, then
            redeploy.
          </p>
        )}
      </section>
    </main>
  );
}
