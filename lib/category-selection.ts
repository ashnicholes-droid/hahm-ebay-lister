import type { ListingResult } from "./types";
import type { CategorySuggestion } from "./ebay/taxonomy";
export function expectedDepartment(l: ListingResult): string {
  if (l.category?.startsWith("womens_")) return "Women";
  if (l.category?.startsWith("mens_")) return "Men";
  return l.item_specifics?.Department || "";
}
export function categoryMatches(
  c: CategorySuggestion,
  l: ListingResult,
): boolean {
  const department = expectedDepartment(l);
  const path = c.path.toLowerCase();
  if (department === "Women")
    return /\bwomen\b/.test(path) && !/\bmen\b/.test(path);
  if (department === "Men")
    return /\bmen\b/.test(path) && !/\bwomen\b/.test(path);
  return true;
}
