import type { ItemGroup, ListingResult } from "@/lib/types";

function priceNumber(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : n.toFixed(2);
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const s = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw;
  // Always quote and escape embedded quotes so commas/newlines stay safe.
  return `"${s.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS: { header: string; get: (l: ListingResult) => string }[] = [
  { header: "Title", get: (l) => l.title ?? "" },
  { header: "Suggested Price", get: (l) => priceNumber(l.suggested_price) },
  { header: "Condition", get: (l) => (l.condition ?? "").replace(/_/g, " ") },
  { header: "Brand", get: (l) => l.brand ?? "" },
  { header: "Item Type", get: (l) => l.item_type ?? "" },
  {
    header: "Color",
    get: (l) => (Array.isArray(l.color) ? l.color.join(", ") : (l.color ?? "")),
  },
  { header: "Size", get: (l) => l.size ?? "" },
  { header: "Material", get: (l) => l.material ?? "" },
  { header: "Category Hint", get: (l) => l.category_hint ?? "" },
  { header: "Description", get: (l) => l.description ?? "" },
  {
    header: "Keywords",
    get: (l) => (l.seo_keywords ?? []).join(", "),
  },
];

// A general-purpose spreadsheet of all finished listings. Not eBay File
// Exchange format (that's category-specific) — a clean starting point you can
// open in Numbers/Excel or adapt.
export function listingsToCsv(groups: ItemGroup[]): string {
  const done = groups.filter((g) => g.listing);
  const headerRow = ["SKU", "Item Name", ...CSV_COLUMNS.map((c) => c.header)]
    .map(csvCell)
    .join(",");
  const rows = done.map((g) => {
    const l = g.listing as ListingResult;
    return [
      csvCell(g.sku),
      csvCell(g.name),
      ...CSV_COLUMNS.map((c) => csvCell(c.get(l))),
    ].join(",");
  });
  return [headerRow, ...rows].join("\r\n");
}

export function listingsToJson(groups: ItemGroup[]): string {
  const payload = groups
    .filter((g) => g.listing)
    .map((g) => ({ sku: g.sku, folder: g.name, ...g.listing }));
  return JSON.stringify(payload, null, 2);
}

export function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
