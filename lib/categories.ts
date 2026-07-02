// Category groupings shared by the publish pipeline (server) and the review
// UI (client). Keys match the `category` values the analysis prompt returns.

export const APPAREL_CATEGORIES = new Set([
  "womens_top", "womens_dress", "womens_skirt", "womens_pants", "womens_coat",
  "womens_sweater", "womens_jeans", "womens_clothing", "womens_shoes", "mens_top",
  "mens_pants", "mens_coat", "mens_sweater", "mens_jeans", "mens_clothing",
  "mens_shoes", "scarf", "belt", "hat",
]);

export const PANTS_CATEGORIES = new Set([
  "womens_pants", "womens_jeans", "womens_skirt", "mens_pants", "mens_jeans",
]);

// Categories where eBay's size-standardization enforcement (July 2026) blocks
// or holds listings with missing or non-standard Size values.
export const SIZE_REQUIRED_CATEGORIES = new Set(
  [...APPAREL_CATEGORIES].filter((c) => !["scarf", "belt"].includes(c))
);
