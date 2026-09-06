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

The 175 unit/integration checks cover publication payload fidelity, missing required facts/photos, condition preservation, conflicting/live SKUs, unknown remote state, lost publish responses, intake, persistence and comparable filtering. Browser checks use mocked external services and verify reloads, edits, upload failure/retry, concurrent tabs, late responses and phone layout. They do not prove current Anthropic model access or eBay account compatibility.

## Live release gate

1. Completed photo intake: six seller-supplied garments, 31 original photos. Originals and raw evaluation files remain outside the repository. Seller confirmed all six are Regular sizing, then corrected Chubbies to new; the other five are pre-owned. Final eBay condition grades remain for review.
2. Completed live Anthropic analysis, eBay category/specifics preparation and asking-price research for all six items. See the live photo results below. This does not complete seller-account or publication validation.
3. Verify the seller's category metadata, policies and shipping origin with live authenticated eBay reads. Candidate URLs need an eBay-approved callback configuration; the current production callback does not automatically authenticate a different deployment hostname.
4. Review one complete intended listing and its photos/shipping before a controlled real publication. Confirm the resulting listing, then verify retry/reload does not duplicate or modify it.
5. Merge and promote only after those results are acceptable. Preserve the previous Vercel deployment for rollback.

## Remaining limits and follow-on work

- IndexedDB is device/browser storage, not a cloud backup. Clearing site data removes drafts and original photos. Export important drafts/originals. Cross-device sync, archives and durable server jobs require a storage design.
- Randomized SKUs and reconciliation reduce collision risk; they are not transactional distributed reservations. Manual SKU reuse across devices still needs a database reservation system for a multi-user product.
- Rate limits remain per server instance, with a shared access code. There is no organization-wide spend ceiling or durable billing ledger. Logged failed attempts may not appear in saved draft cost totals; provider billing is authoritative. Sorting costs are separate from item draft totals.
- Asking-price matching is conservative and heuristic, not verified sold-price valuation. Six items are a smoke test, not a statistically reliable Anthropic/GPT accuracy comparison.
- Photo evidence references require seller verification. Aspect enrichment is not proof of a fact. The app cannot establish functionality, authenticity or hidden defects from photos alone.
- Better category-aware title identifier prioritization, representative-photo routing, broader nonadjacent grouping and calibrated cost/quality benchmarks remain follow-on enhancements. Current titles are validated before publication and not silently truncated at that stage.
- The GPT 5.6 comparison app is deliberately not started until this original reaches the release gate. It should share validation rules and use the same evaluation photos, while preventing accidental duplicate listings.

Cost estimates use standard global rates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked September 5, 2026. Discounts, special service tiers and incomplete locally recorded attempts can change the billed total.

## Live photo repair results — September 5, 2026

Six original item sets: Faherty M, Abercrombie/Trevor Project XL, Hello Kitty S, Sailor Moon L, Chubbies XXL, Tahari Pure Luxe cashmere XS. The model received only neutral image payloads, not the seller references or target prices.

- Main item identity and tagged size were correct in all six in the latest full run. This is a small smoke test, not an accuracy percentage suitable for a provider comparison.
- Hello Kitty now resolves to the women's T-Shirts leaf (53159), using full category ancestry and department validation rather than the ambiguous leaf name alone. Sellers can correct department and choose a suggested leaf.
- Main analysis measurements are schema-constrained to blank. Tagged inseam remains permitted with label evidence; tape measurements require seller entry. The six rerun drafts contained no generated tape measurements.
- Main specifics and enrichment require quoted label evidence or an allowed visible construction attribute. None of the six rerun prepared drafts included guessed Fit, Size Type, Vintage, Handmade or Personalize values. Required unknown Size Type fields are shown for seller confirmation, including category dependencies. The seller subsequently confirmed all six are Regular sizing.
- Sale condition is never preselected by preparation. The final analysis schema also disallows NEW grades after a live Chubbies result demonstrated that the prompt alone was insufficient. Attached tags do not prove unworn condition.
- Sorting returned the correct six groups with every one of the 31 photos assigned once. Shared photos reconnect overlapping batch windows; unassigned detail recovery requires an explicit visual match and leaves uncertainty unassigned. The measured run took 87.3 seconds, including one 60-second optional comparison timeout. Successful recorded sorting calls cost about $0.099; a timed-out call may have unreported provider charges. This was more accurate but slower than the original 16.2-second seven-group result.
- Full-run analysis plus category-specific enrichment cost $0.72659 total, about 11.3–13.3 cents per item, excluding sorting. Each item used 22,830–26,954 uncached input tokens, 1,126–1,617 output tokens, plus cache tokens. Analysis took 18.7–22.3 seconds; analysis plus preparation took 28.8–32.4 seconds. Research added about 1.8–2.4 seconds. These are measured examples, not guaranteed latency or billing.
- Price searches preserve labeled materials/collaborations and use GTIN retrieval when available. Final query cleanup removes duplicated brand prefixes and preserves graphic identity. Conservative matching can return no comparable price; results remain active asking prices, never sold valuations. AI estimates are separate, unverified values.
- Preview protection redirects anonymous visitors to Vercel login. An authenticated Vercel request without the app access code was denied with ACCESS_CODE_REQUIRED. No sample photos or secret values are committed.

The final condition/query patch passed targeted live reruns for Sailor Moon and Chubbies. Chubbies returned EXCELLENT as a preliminary cosmetic grade, not NEW. With the seller-confirmed Regular sizing, all six preparation calls returned zero aspect issues; eBay sale-condition choices remain blank. Before the seller corrected Chubbies to new, pre-owned asking-price research returned Faherty 5 results ($29.25 median), Abercrombie/Trevor Project 3 ($30.94), and Tahari cashmere 12 ($43.10), including known shipping. Hello Kitty, Sailor Moon and Chubbies returned no matching results. These are heuristic research matches, not independently verified identical sold items.

Residual draft-language errors remain: the targeted Sailor Moon description used “sweatsuit” once despite the correct sweatshirt title/type, and Chubbies condition notes inferred storage/handling as a wrinkle cause. These require seller editing; prompt restrictions are not proof against hallucination. Do not treat the six successful requests as approval to publish unreviewed prose. Automated external-service mocks do not establish live seller OAuth, shipping policy compatibility, or successful real publication. Those release checks remain outstanding; no production release or seller listing has been performed by this repair work.


Seller correction: Chubbies is new, with attached tags visible; the other five items are pre-owned. A new-condition query found the named XXL/30-inch product at $47.24 plus $7.95 shipping. The search also returned Large/XL sources, prompting an additional size filter: known apparel sizes require matching title evidence, with longer size phrases distinguished from plain Large/Small and possessives excluded. This is a heuristic filter and deliberately excludes ambiguous multi-size titles. The final source-filter run is recorded in the local evaluation report.


Final price-filter correction: source inspection showed that collaboration-only matches still admitted crochet tops for the rainbow camp shirt. Keyword comparisons now require all retained identifying phrases (word order may differ), in addition to apparel size. This intentionally favors no result over a different style. Earlier prices in this document describe intermediate runs; the final run is reported separately in the local evaluation report. No asking-price median is a confirmed resale value.


The final construction filter additionally requires the clothing item type and its supplied Style phrase, preventing a cashmere pullover from entering cardigan research. Numeric MPNs are excluded from redundant keyword phrases when the named style is available; identifiers remain available for identifier/GTIN retrieval. Strict title matching may miss valid sellers who omit these details; absence of results is not evidence that the item has no resale value.
