import { listingQuantity, volumeDiscount } from "@/lib/quantity";
import { estimateShipping } from "@/lib/shipping/estimate";
import type { ItemGroup, ListingResult } from "@/lib/types";

function priceNumber(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : n.toFixed(2);
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  // Always quote and escape embedded quotes so commas/newlines stay safe.
  return `"${s.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS: { header: string; get: (l: ListingResult) => string }[] = [
  { header: "Title", get: (l) => l.title ?? "" },
  { header: "Suggested Price", get: (l) => priceNumber(l.suggested_price) },
  { header: "Quantity", get: (l) => String(listingQuantity(l)) },
  {
    header: "Multi-buy Discount",
    get: (l) => {
      const d = volumeDiscount(l);
      return d ? `${d.percentOff}% off at ${d.minQuantity}+` : "";
    },
  },
  { header: "Condition", get: (l) => (l.condition ?? "").replace(/_/g, " ") },
  {
    // What you'll actually put it in, so the packing list matches the listing.
    header: "Packaging",
    get: (l) => {
      const e = estimateShipping({
        itemOz: l.shipping_weight_oz,
        itemDims: {
          l: Number(l.shipping_length_in) || undefined,
          w: Number(l.shipping_width_in) || undefined,
          h: Number(l.shipping_height_in) || undefined,
        },
        category: l.category,
        selectedOptionId: l.shipping_option_id,
      });
      return e.chosen ? `${e.chosen.serviceName} — ${e.chosenPackage?.name ?? ""}`.trim() : "";
    },
  },
  { header: "Brand", get: (l) => l.brand ?? "" },
  { header: "Item Type", get: (l) => l.item_type ?? "" },
  {
    header: "Color",
    get: (l) => (Array.isArray(l.color) ? l.color.join(", ") : l.color ?? ""),
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
