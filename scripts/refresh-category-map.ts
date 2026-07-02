/**
 * Regenerate the static CATEGORY_MAP / LEAF_FALLBACKS in lib/ebay/publish.ts
 * for the eBay marketplace you are configured for — using eBay's Taxonomy API
 * as the source of truth.
 *
 * WHY THIS EXISTS
 * ---------------
 * eBay category IDs are per-marketplace: the US category tree is id 0, the UK
 * tree is id 3, Germany is 77, etc. Some IDs coincide across sites but many do
 * not, so a leaf id that is correct on eBay.com can be a wrong (or non-leaf)
 * category on eBay.co.uk. The live publish path already resolves the right leaf
 * for the active tree via suggestLeafCategory(); CATEGORY_MAP is only the
 * OFFLINE FALLBACK used when that Taxonomy call is unavailable. This script
 * regenerates that fallback so it matches whichever marketplace you list on.
 *
 * It does NOT edit publish.ts — it prints a ready-to-paste block so you can
 * review the resolved IDs before committing them. Diff the output against the
 * current map; eBay's top suggestion is always a valid leaf but not always the
 * best category, so keep any hand-picked value you prefer.
 *
 * USAGE
 * -----
 *   EBAY_CLIENT_ID=...      \
 *   EBAY_CLIENT_SECRET=...   \
 *   npx tsx scripts/refresh-category-map.ts
 *
 * Marketplace defaults to EBAY_US / tree 0. For another marketplace set the
 * env overrides from lib/ebay/config.ts, e.g.:
 *   EBAY_MARKETPLACE_ID=EBAY_GB EBAY_CATEGORY_TREE_ID=3 npx tsx scripts/refresh-category-map.ts
 *
 * Then paste the printed CATEGORY_MAP / LEAF_FALLBACKS into lib/ebay/publish.ts.
 */

import { suggestLeafCategory } from "../lib/ebay/taxonomy";
import {
  getEbayCreds,
  EBAY_CATEGORY_TREE_ID,
  EBAY_MARKETPLACE_ID,
} from "../lib/ebay/config";

// A short, leaf-pointing search phrase for every broad category key the model
// can emit (the keys must stay in sync with CATEGORY_MAP in publish.ts). The
// Taxonomy API only ever returns leaf categories, so the top hit is publish-safe.
const QUERIES: Record<string, string> = {
  womens_top: "women's top shirt blouse",
  womens_dress: "women's dress",
  womens_skirt: "women's skirt",
  womens_pants: "women's pants",
  womens_coat: "women's coat jacket",
  womens_sweater: "women's sweater",
  womens_jeans: "women's jeans",
  womens_clothing: "women's clothing",
  womens_shoes: "women's shoes",
  mens_top: "men's shirt top",
  mens_pants: "men's pants",
  mens_coat: "men's coat jacket",
  mens_sweater: "men's sweater",
  mens_jeans: "men's jeans",
  mens_clothing: "men's clothing",
  mens_shoes: "men's shoes",
  handbag: "women's handbag",
  wallet: "wallet purse",
  jewelry: "fashion jewelry",
  scarf: "scarf",
  belt: "belt",
  sunglasses: "sunglasses",
  hat: "hat cap",
  accessory: "fashion accessory",
  doll: "doll",
  collectible: "collectible figurine",
  collector_plate: "collector plate",
  toy: "toy",
  home_decor: "home decor ornament",
  book: "book",
  knife: "pocket knife",
  sporting_goods: "sporting goods",
  electronics: "consumer electronics",
  camera: "digital camera",
  audio: "home audio",
  video_game: "video game",
  media: "dvd film",
  vinyl_record: "vinyl record lp",
  cd: "music cd",
  dvd_bluray: "blu-ray film",
  musical_instrument: "musical instrument",
  kitchenware: "kitchenware",
  glassware: "glassware",
  pottery_ceramics: "pottery ceramics",
  art: "original art print",
  craft: "craft supplies",
  tool: "hand tool",
  automotive: "car part",
  office: "office supplies",
  health_beauty: "health and beauty",
  small_appliance: "small kitchen appliance",
  lighting: "home lighting lamp",
  linens: "bedding linen",
  holiday: "christmas decoration",
  board_game: "board game",
  puzzle: "jigsaw puzzle",
  plush: "plush soft toy",
  action_figure: "action figure",
  trading_card: "trading card",
  sports_memorabilia: "sports memorabilia",
  coin: "collectible coin",
  stamp: "postage stamp",
  ephemera: "paper ephemera",
  other: "everything else",
};

// Generic, high-traffic categories tried in order when a publish hits eBay's
// "not a leaf category" error (25005). Resolved the same way so they are valid
// leaves for the active tree.
const FALLBACK_QUERIES = [
  "collectible figurine",
  "action figure",
  "home decor ornament",
  "book",
  "music cd",
  "plush soft toy",
  "jigsaw puzzle",
  "fashion jewelry",
];

async function resolve(query: string): Promise<string | null> {
  // suggestLeafCategory swallows errors and returns null, so retry briefly to
  // ride out transient rate limits before giving up on a key.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = await suggestLeafCategory(query);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

async function main() {
  // Surface a clear, actionable error up front instead of silently resolving
  // every category to null when credentials are missing.
  getEbayCreds();

  console.error(
    `Resolving categories for ${EBAY_MARKETPLACE_ID} (category tree ${EBAY_CATEGORY_TREE_ID})…\n`,
  );

  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const [key, query] of Object.entries(QUERIES)) {
    const id = await resolve(query);
    if (id) {
      resolved[key] = id;
      console.error(`  ${key.padEnd(20)} ${id.padEnd(10)} ← "${query}"`);
    } else {
      unresolved.push(key);
      console.error(`  ${key.padEnd(20)} (unresolved)  ← "${query}"`);
    }
  }

  const fallbacks: string[] = [];
  for (const q of FALLBACK_QUERIES) {
    const id = await resolve(q);
    if (id && !fallbacks.includes(id)) fallbacks.push(id);
  }

  // ── Emit paste-ready source ────────────────────────────────────────────────
  const keys = Object.keys(QUERIES); // preserve a stable, readable order
  let map = "const CATEGORY_MAP: Record<string, string> = {\n";
  for (let i = 0; i < keys.length; i += 3) {
    const row = keys
      .slice(i, i + 3)
      .map((k) => (resolved[k] ? `${k}: "${resolved[k]}"` : `/* TODO ${k} */`))
      .join(", ");
    map += `  ${row},\n`;
  }
  map += "};\n";

  const leaf = `const LEAF_FALLBACKS = [${fallbacks
    .map((f) => `"${f}"`)
    .join(", ")}];\n`;

  console.log(
    `\n// Generated for ${EBAY_MARKETPLACE_ID}, tree ${EBAY_CATEGORY_TREE_ID}\n`,
  );
  console.log(map);
  console.log(leaf);

  if (unresolved.length) {
    console.error(
      `\n⚠️  ${unresolved.length} categor${unresolved.length === 1 ? "y" : "ies"} did not resolve ` +
        `(${unresolved.join(", ")}). Keep the existing values for those, or refine the query in this script.`,
    );
  }
}

main().catch((e) => {
  console.error("\nFailed:", (e as Error).message);
  process.exit(1);
});
