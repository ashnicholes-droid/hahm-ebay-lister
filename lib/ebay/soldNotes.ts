// Getting the cost basis back after an item sells.
//
// The purchase price is written into eBay's per-listing private note at listing
// time (lib/costBasis.ts) — a `[cost 12.50]` token in a seller-only field. That
// works well while the listing is live, because GetMyeBaySelling's ActiveList
// returns notes and lib/ebay/listings.ts already reads them.
//
// A SOLD item is no longer in ActiveList, and the Fulfillment API knows nothing
// about private notes — orders carry money and SKUs, never seller annotations.
// So without this module, the moment an item sells its cost basis becomes
// unreachable and realized profit is unknowable for exactly the items that have
// any.
//
// SoldList takes the same IncludeNotes flag, which closes the gap. The join is
// by ItemID first and SKU second: ItemID is exact, but a relisted item gets a
// NEW ItemID (see lib/ebay/relist.ts) while keeping its SKU, so SKU is what
// carries the cost across a relist.
//
// ⚠️ Written from eBay's docs, not yet run against a live seller account. It is
// read-only and every failure degrades to "cost not recorded" rather than a
// wrong number — see costFor() below for why that distinction is load-bearing.

import { EBAY_TRADING } from "./config";
import { parseNote } from "@/lib/costBasis";
import { TradingApiError } from "./listings";
import { tradingAck, xmlBlocks, xmlText } from "./xml";

/**
 * How far back SoldList looks.
 *
 * eBay caps this — the sold list is a rolling window, not an archive — so a sale
 * older than the window has no recoverable cost here. That is a real limit of
 * the "no database" design and is reported rather than hidden.
 */
export const SOLD_WINDOW_DAYS = 60;

export interface SoldCost {
  itemId: string;
  sku: string;
  /** Null means nobody recorded one — NOT a cost of zero. */
  cost: number | null;
}

export interface SoldCostIndex {
  byItemId: Map<string, number>;
  bySku: Map<string, number>;
  /** How many sold listings were read, so an empty index can be explained. */
  scanned: number;
  windowDays: number;
}

function requestXml(days: number, page: number, pageSize: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <SoldList>
    <Include>true</Include>
    <!-- The whole reason this call exists. -->
    <IncludeNotes>true</IncludeNotes>
    <DurationInDays>${days}</DurationInDays>
    <Pagination>
      <EntriesPerPage>${pageSize}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </SoldList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;
}

/** An empty index — what every failure degrades to. */
export function emptyCostIndex(windowDays = SOLD_WINDOW_DAYS): SoldCostIndex {
  return { byItemId: new Map(), bySku: new Map(), scanned: 0, windowDays };
}

/**
 * Cost basis for everything sold in the window, keyed both ways.
 *
 * Throws only on an outright API failure; an account with no sales returns an
 * empty index, which is a different thing and reads differently on screen.
 */
export async function fetchSoldCosts(
  accessToken: string,
  days = SOLD_WINDOW_DAYS,
  maxPages = 5
): Promise<SoldCostIndex> {
  const index = emptyCostIndex(days);

  for (let page = 1; page <= maxPages; page++) {
    const resp = await fetch(EBAY_TRADING, {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-IAF-TOKEN": accessToken,
        "Content-Type": "text/xml",
      },
      body: requestXml(days, page, 100),
    });

    const xml = await resp.text();
    const ack = tradingAck(xml);
    if (!ack.ok) {
      const first = ack.errors[0];
      throw new TradingApiError(
        first?.message || `eBay returned ${ack.ack} (HTTP ${resp.status}).`,
        first?.code || String(resp.status)
      );
    }

    const sold = xmlBlocks(xml, "SoldList")[0] ?? "";
    // Sold entries are Transactions wrapping an Item; older responses put Item
    // at the top level. Reading both keeps this working across either shape.
    const blocks = [...xmlBlocks(sold, "Transaction"), ...xmlBlocks(sold, "Item")];

    let found = 0;
    for (const block of blocks) {
      const itemId = xmlText(block, "ItemID");
      const sku = xmlText(block, "SKU");
      if (!itemId && !sku) continue;
      found++;
      const { cost } = parseNote(xmlText(block, "PrivateNotes"));
      if (cost === null) continue;
      if (itemId && !index.byItemId.has(itemId)) index.byItemId.set(itemId, cost);
      // First writer wins: if the same SKU sold twice at different recorded
      // costs, the most recent listing is the one that reflects what was paid.
      if (sku && !index.bySku.has(sku)) index.bySku.set(sku, cost);
    }
    index.scanned += found;

    const pagination = xmlBlocks(sold, "PaginationResult")[0] ?? "";
    const totalPages = Number(xmlText(pagination, "TotalNumberOfPages")) || 1;
    if (page >= totalPages || found === 0) break;
  }

  return index;
}

/**
 * The recorded cost for one sold line, or null.
 *
 * Null is the honest answer and the important one. Treating an unrecorded cost
 * as zero would report the entire sale price as profit, which is both wrong and
 * flattering — the kind of error nobody goes looking for. Every caller has to
 * decide what to do with null, and lib/realizedProfit.ts excludes those orders
 * from the profit total and counts them separately.
 */
export function costFor(
  index: SoldCostIndex,
  line: { legacyItemId?: string; sku?: string }
): number | null {
  if (line.legacyItemId) {
    const byId = index.byItemId.get(line.legacyItemId);
    if (byId !== undefined) return byId;
  }
  if (line.sku) {
    const bySku = index.bySku.get(line.sku);
    if (bySku !== undefined) return bySku;
  }
  return null;
}
