# Anthropic repair candidate

This branch repairs the existing app. It does not switch AI providers. It is a release candidate awaiting live item and seller-account validation, not a measured accuracy improvement claim.

## Implemented

- Removed fabricated required-specific defaults and condition/category recovery that changed facts while publishing. Resolve category, allowed conditions and specifics before seller review; revalidate current eBay requirements before writes. Publication preserves the reviewed title, description, price, condition, specifics and shipping selections.
- Added explicit seller policy/location selection and actual packed weight/dimensions. No invented shipping origin or default parcel in the publication path.
- Added runtime listing/image/shipping validation, structured main analysis output, bounded network requests and request deadlines. Main AI instructions prohibit guessing obscured facts and unsupported functionality/authenticity claims.
- Saved drafts, originals, upload receipts and interrupted publication state in IndexedDB. A browser tab lock prevents simultaneous workspace edits. Reload recovery requires reconciliation; it does not automatically publish.
- Preserved originals locally and generates higher-resolution listing upload derivatives. Allows 24 listing photos, separately selected analysis evidence, bounded intake concurrency and partial decode recovery. Partial uploads block publication.
- Added one-item intake without sorting calls. Tightened sorting batch indices, duplicate handling and merged-group verification; removed weak cross-chunk automatic merging.
- Added random SKU suffixes, incomplete-scan errors, same-batch duplicate checks and checks for live/conflicting inventory before writes. Reconciles uncertain publication outcomes instead of changing facts and retrying blindly.
- Comparable results retain source links, timestamps and shipping amounts. Matching uses category and available identifiers; uncertain matches can return no price. The UI labels results as asking prices and AI prices as unverified estimates.
- Records per-call model, token counts, cache usage, duration and estimated cost in server logs; draft usage is saved locally. Reduced broad analysis instructions and added an exact model allowlist.
- Fixed access-code prompts triggered by unrelated authorization errors, bounded category cache lifetime, preserved aspect dependencies, and neutralized spreadsheet formulas in CSV exports.
- Updated dependencies; npm audit reported zero known vulnerabilities during validation. Added CI and browser regression coverage.

## Validation

Run `npm ci`, `npm test`, `npm run build`, `npm run typecheck`, `npx playwright install chromium`, and `npm run test:browser`.

The 159 unit/integration checks cover publication payload fidelity, missing required facts/photos, condition preservation, conflicting/live SKUs, unknown remote state, lost publish responses, intake, persistence and comparable filtering. Browser checks use mocked external services and verify reloads, edits, upload failure/retry, concurrent tabs, late responses and phone layout. They do not prove current Anthropic model access or eBay account compatibility.

## Live release gate

1. Supply photos of five representative items (overview, label/model/size, defects and accessories) with privately recorded ground truth, testing status and desired sale condition. Do not put private photos in GitHub.
2. Run the candidate with the real Anthropic deployment configuration. Record each call's usage, elapsed time and errors. Review identification, title, specifics, description and comparable source quality against the actual items.
3. Verify the seller's category metadata, policies and shipping origin with live authenticated eBay reads. Candidate URLs need an eBay-approved callback configuration; the current production callback does not automatically authenticate a different deployment hostname.
4. Review one complete intended listing and its photos/shipping before a controlled real publication. Confirm the resulting listing, then verify retry/reload does not duplicate or modify it.
5. Merge and promote only after those results are acceptable. Preserve the previous Vercel deployment for rollback.

## Remaining limits and follow-on work

- IndexedDB is device/browser storage, not a cloud backup. Clearing site data removes drafts and original photos. Export important drafts/originals. Cross-device sync, archives and durable server jobs require a storage design.
- Randomized SKUs and reconciliation reduce collision risk; they are not transactional distributed reservations. Manual SKU reuse across devices still needs a database reservation system for a multi-user product.
- Rate limits remain per server instance, with a shared access code. There is no organization-wide spend ceiling or durable billing ledger. Logged failed attempts may not appear in saved draft cost totals; provider billing is authoritative. Sorting costs are separate from item draft totals.
- Asking-price matching is conservative and heuristic, not verified sold-price valuation. Five items are a smoke test, not a statistically reliable Anthropic/GPT accuracy comparison.
- Photo evidence references require seller verification. Aspect enrichment is not proof of a fact. The app cannot establish functionality, authenticity or hidden defects from photos alone.
- Better category-aware title identifier prioritization, representative-photo routing, broader nonadjacent grouping and calibrated cost/quality benchmarks remain follow-on enhancements. Current titles are validated before publication and not silently truncated at that stage.
- The GPT 5.6 comparison app is deliberately not started until this original reaches the release gate. It should share validation rules and use the same evaluation photos, while preventing accidental duplicate listings.
