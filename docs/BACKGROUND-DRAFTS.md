# Optional: background drafts

**Off by default. You do not need this to use Listing Writer.**

Normally the app writes listings in your browser tab, so drafting pauses if you
close the tab or your phone locks. Background drafts move that work to the
cloud: photos upload once, and drafts keep writing after you close the browser.
When you come back in the same browser, finished drafts load in for review.

Posting to eBay is never automatic. You still review and post every listing
yourself.

## Is it worth it for you?

Worth it if you routinely draft big batches (dozens to hundreds of items) and
want to walk away while they write. Skip it if you draft a handful at a time;
the regular in-tab flow is simpler and has no extra services.

## What it costs

On top of your normal Anthropic and Vercel costs:

| Service | What it does | Cost |
|---|---|---|
| [Supabase](https://supabase.com/pricing) | Private photo storage + job records | Free tier to start; Pro is $25/month when you outgrow it |
| [Inngest](https://www.inngest.com/pricing) | Runs the background drafting jobs | Free up to 50,000 runs/month (roughly 10 runs per item) |

Prices as of September 2026; check the linked pages.

## Setup

You need the regular setup (Anthropic key, `APP_SECRET`, and `SESSION_SECRET`)
working first.

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run each file in [`supabase/migrations/`](../supabase/migrations)
   in filename order. They create four private tables and two private photo
   buckets (`lister-photos-preview`, `lister-photos-production`). Browsers get
   no access to either; only your server does.
3. From **Project Settings → API**, copy the project URL and a **secret** key
   (not the publishable/anon key).

### 2. Inngest

1. Create a free account at [inngest.com](https://www.inngest.com) and install
   its [Vercel integration](https://www.inngest.com/docs/deploy/vercel) for
   this project, with the path `/api/inngest`.
2. If your Vercel project uses **Deployment Protection** (on by default for
   previews), create a *Protection Bypass for Automation* secret in Vercel
   (Settings → Deployment Protection) and paste it into the Inngest
   integration's **Deployment protection key** field. Use a random secret.
3. The integration adds `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` to Vercel.
   If you add them by hand, use keys from the matching Inngest environment
   (Production keys for Production, Branch keys for Preview).

### 3. Vercel environment variables

| Variable | Value |
|---|---|
| `CLOUD_BATCH_ENABLED` | `true` (anything else keeps the feature off) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Your Supabase secret key |
| `INNGEST_EVENT_KEY` | From Inngest (usually added by the integration) |
| `INNGEST_SIGNING_KEY` | From Inngest (usually added by the integration) |

All five must be set, plus `SESSION_SECRET`, or the feature stays off. Tip: set
them for **Preview** first, test with a couple of items, then add them to
**Production**.

### 4. Redeploy and check

Redeploy, then open the Inngest dashboard → your environment → **Apps**. You
should see `hahm-ebay-lister` synced with its functions. Upload one or two
items with background drafting on and watch **Runs** for `generate-cloud-draft`.

## Troubleshooting

- **Items stay "queued":** the app isn't synced to Inngest, or the keys belong
  to a different or archived Inngest environment. Re-check step 2 and resync.
- **"Cannot send events to an archived environment":** an Inngest branch
  environment was auto-archived. Unarchive it (Environments → Archived filter)
  or redeploy the branch so it re-syncs.
- **Sync fails with "could not reach your URL":** Vercel Deployment Protection
  is blocking Inngest; add the bypass key (step 2.2).

## Privacy and retention

- Only resized JPEG copies upload; your originals stay on your device.
- Batches expire, and a daily cleanup deletes their photos, then their records.
- No credentials or photo data are placed in Inngest events or logs.
