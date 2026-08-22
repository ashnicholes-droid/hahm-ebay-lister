// Limits that both the browser and the server need to agree on.
//
// Split out for the same reason lib/ebay/scopes.ts is: lib/ebay/content.ts
// reaches process.env through ./config, so a client component importing it
// would break the build. The character counter next to the title field and the
// server-side validation must use the same number, and this is the only way
// they can share it.

/** eBay's hard cap on a listing title. Longer is rejected at publish. */
export const TITLE_MAX = 80;
