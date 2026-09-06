# Batch throughput: first implementation and cloud follow-up

The objective is lower seller handling time for batches of 100 items. This change keeps Anthropic and the seller's existing condition, Regular sizing, policy and optional parcel defaults.

## Implemented

- Compact review table by default for multiple items, 25 rows per page. Single-item workflows retain detailed cards. Expand one row for full review.
- Inline title, size, eBay condition, price and shipping; selection across pages; bulk shipping and category-supported condition changes; post selected ready items or all ready items.
- Attention/ready/posted filters. Required-field readiness is not an AI accuracy endorsement. Changing condition may require corresponding description edits.
- One shared, in-memory, five-minute policy cache with in-flight request coalescing, failure retry and sign-in invalidation. Defaults also apply to drafts whose detail cards never mount.
- Three writing workers, two publication workers, pause after active work completes, resume selected publication scope, and retry unfinished drafts without rewriting successful ones.
- Progress reports elapsed time and completed attempts, including failures. It does not claim an unmeasured ETA.
- 1,000-photo intake ceiling, with two resize workers and preparation progress. This is a capacity ceiling, not a verified high-resolution 1,000-photo performance claim.
- IndexedDB migration preserves legacy drafts and originals. Photo metadata and large assets live outside the frequently updated workspace manifest. Full upload derivatives are loaded per active publication, not retained for the whole batch in React state. Removed workspace photos are deleted from storage on save.
- API access controls, prepared category validation, upload completeness, SKU checks and publication reconciliation remain in place.

## Validation

189 unit/integration checks passed, including 500-photo storage restoration, compact manifests, coalescing 100 policy requests into one, failed-request invalidation, bounded queue concurrency and pausing.

Browser scenarios use mocked external APIs; they make no real listings and incur no AI charges:

- 10, 25 and 100 items (50, 125 and 500 tiny fixture photos): edit/reload preservation, one policy request per page load, two concurrent publish requests, every SKU published exactly once.
- Selected publication pause/resume does not publish unselected items.
- 100 draft writes, one injected failure: 100 initial analysis requests and one retry, maximum three active requests.
- Mobile viewport and missing-price filtering.
- Existing nine workflow regression checks, including partial photo upload, late preparation, seller defaults and unsupported native prompt recovery.

These are orchestration checks, not real-photo speed/accuracy benchmarks. Previous six-item live measurements remain the only live AI sample: approximately 29–32 seconds for analysis plus preparation per item, and 11.3–13.3 cents/item excluding sorting and retries. No 100-item hands-on time claim is supported yet.

## Still required for unattended background batches

The current queue stops when the browser closes. This is stated in the UI. Do not market it as a durable cloud queue.

Proposed infrastructure, subject to account setup and cost confirmation:

- One Supabase Pro project for private object storage and batch/job records. Base $25/month with first project included; usage allowances/overages apply.
- Inngest Hobby initially: $0, 50,000 executions/month, five concurrent steps. Each function run and step counts toward executions. The free plan pauses at quota; Pro begins at $99/month and must not be enabled automatically.
- Example planning budget: 3,000 items/month at ten executions/item = 30,000 executions before sorting, retries and housekeeping. Instrument actual usage before relying on this assumption. Existing Vercel and AI costs are additional.
- Sources checked September 6, 2026: https://supabase.com/pricing and https://www.inngest.com/pricing

### Cloud implementation contract

1. Upload photos directly to a private bucket with short-lived, narrowly scoped upload permissions, before scheduling work. Jobs carry IDs, never base64 images or seller credentials in event/log payloads. Keep only necessary derivatives remotely; define retention and a deletion action.
2. Store batches, item revisions, jobs, attempts and events in Postgres. Use atomic job claims, unique batch/item/stage/revision keys, explicit leases and bounded retries. Preserve outputs of completed stages.
3. Extract reusable analysis, preparation and publication services from HTTP handlers. Background workers authenticate through server-held, encrypted seller credentials, replacing reliance on a browser cookie for unattended work. Separate Preview and Production credentials/data.
4. Run analysis/preparation/research as independently persisted steps with bounded account-wide concurrency. Shared category caches must retain category/marketplace validity. Retry only failed stages; do not rerun paid analysis after a later stage fails.
5. Require a seller-approved item revision before scheduling publication. Snapshot that revision; reject stale edits. Reconcile uncertain eBay outcomes using the SKU before retrying publication. Closing a browser must not imply permission to publish unreviewed drafts.
6. Resume from cloud state on reconnect, stream/poll progress and show per-item failures. Device drafts migrate only after successful uploads and cloud confirmation.
7. Validate browser close/reopen, worker timeout after a successful eBay response, duplicate events, account disconnection, quota exhaustion, stale edits and photo retention. Then test real-photo batches of 10, 25 and 100 and record seller handling time, wall time, cost, corrections and failures.

No cloud accounts, subscriptions or background infrastructure have been created by this change.
