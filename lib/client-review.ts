import type { ItemGroup } from "./types";
import { shippingSchema, skuSchema } from "./validation";
import { validateAspects } from "./ebay/draft";
export function draftIssues(g: ItemGroup): string[] {
  const l = g.listing;
  if (!l) return ["Generate a draft first."];
  const issues: string[] = [];
  if (!skuSchema.safeParse(g.sku).success) issues.push("Enter a valid SKU.");
  if (!l.title.trim() || l.title.length > 80)
    issues.push("Title must be 1–80 characters.");
  if (!l.description.trim()) issues.push("Enter a description.");
  if (
    !Number.isFinite(Number(l.suggested_price)) ||
    Number(l.suggested_price) <= 0
  )
    issues.push("Enter a positive price.");
  if (
    !g.preparation ||
    g.preparation.categoryId !== l.category_id ||
    g.preparation.expiresAt < Date.now()
  )
    issues.push("Prepare this category before publishing.");
  else {
    if (!g.preparation.conditions.some((c) => c.value === l.ebay_condition))
      issues.push("Choose an eBay condition.");
    issues.push(
      ...validateAspects(
        Object.fromEntries(
          Object.entries(l.item_specifics ?? {})
            .filter(([, v]) => v.trim())
            .map(([k, v]) => [k, v.split(" | ").map((x) => x.trim())]),
        ),
        g.preparation.aspects,
      ),
    );
  }
  if (!shippingSchema.safeParse(g.shipping).success)
    issues.push(
      "Choose policies and shipping origin, and enter packed weight and dimensions.",
    );
  if (!g.photoIds.length || g.photoIds.length > 24)
    issues.push("Select 1–24 photos for this item.");
  return issues;
}
