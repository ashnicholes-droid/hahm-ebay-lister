// Sales created before this moment were already announced, or are old orders
// from the 7-day eBay lookup. They are recorded and not sent again.
export const TELEGRAM_SALE_CUTOFF_ISO = "2026-10-10T19:39:00.000Z";

export function isNewTelegramSale(createdAt: string): boolean {
  const cutoff = Date.parse(process.env.TELEGRAM_NOTIFY_AFTER || TELEGRAM_SALE_CUTOFF_ISO);
  const created = Date.parse(createdAt);
  if (!Number.isFinite(cutoff) || !Number.isFinite(created)) return false;
  return created >= cutoff;
}

export function isConfirmedEbaySale(line: { cancelled: boolean; paymentStatus: string }): boolean {
  if (line.cancelled) return false;
  const status = line.paymentStatus.trim().toUpperCase();
  if (!status || status === "PAID" || status === "PARTIALLY_REFUNDED") return true;
  return false;
}

export interface EbayNoticeLine {
  cancelled: boolean;
  paymentStatus: string;
  sku: string;
  title: string;
}

export type EbayNoticeLookup =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "one"; row: { sku: string; ebayTitle: string | null; vintedTitle: string | null } };

// Prefer the inventory SKU and the eBay listing title. Fall back to the
// order line when this sale was never linked in Neon.
export function ebaySaleNotice(
  line: EbayNoticeLine,
  lookup: EbayNoticeLookup
): { sku: string; title: string } | null {
  if (!isConfirmedEbaySale(line)) return null;
  if (lookup.kind === "ambiguous") {
    const title = line.title.trim();
    if (!title) return null;
    return { sku: "", title };
  }

  if (lookup.kind === "one") {
    const sku = lookup.row.sku.trim() || line.sku.trim();
    const title = (lookup.row.ebayTitle || lookup.row.vintedTitle || line.title).trim();
    if (!title) return null;
    return { sku, title };
  }

  const title = line.title.trim();
  if (!title) return null;
  return { sku: line.sku.trim(), title };
}
