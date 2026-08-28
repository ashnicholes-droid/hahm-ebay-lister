// Reading your live eBay listings.
//
// ⚠️ Like lib/ebay/promotions.ts, this module is written from eBay's docs and
// has NOT been exercised against a live seller account from here. It is
// read-only, so the cost of being wrong is a view that doesn't load rather than
// a listing that breaks — but treat the first real run as the test.
//
// Why the Trading API and not the Sell APIs: there is no Sell endpoint that
// lists every offer. `GET /sell/inventory/v1/offer` requires a SKU, so building
// the view that way is one call per item — 200 calls to draw one screen.
// Trading's GetMyeBaySelling returns the whole active list, with watch counts,
// in a single paged call. Offer ids are then resolved lazily, only for the item
// actually being edited (see revise.ts).

import { EBAY_TRADING, EBAY_ITEM_PREFIX } from "./config";
import type { ShippingArrangement } from "@/lib/fees";
import { parseNote } from "@/lib/costBasis";
import { tradingAck, xmlBlocks, xmlNumber, xmlText } from "./xml";

/** eBay caps this at 200; anything larger is silently reduced by them. */
export const LISTINGS_PAGE_SIZE = 100;

export interface SellerListing {
  itemId: string;
  title: string;
  sku: string;
  price: number | null;
  currency: string;
  quantity: number | null;
  quantitySold: number | null;
  /** People watching, or null when eBay didn't say — not the same as zero. */
  watchCount: number | null;
  /** Page views over the reporting window. Needs the analytics scope. */
  views?: number | null;
  /** Search impressions over the same window. */
  impressions?: number | null;
  imageUrl: string;
  viewUrl: string;
  startTime: string;
  bestOfferEnabled: boolean;
  format: string;
  /**
   * Who pays postage, and how much. This is the difference between a price
   * change that nets you more and one that quietly costs you money, so it sits
   * next to the price field rather than being left for the seller to remember.
   */
  shipping: ShippingArrangement;
  /** What the buyer is charged, when it's a fixed amount. */
  shippingCost: number | null;
  /** The first domestic service on the listing, for context. */
  shippingService: string;
  /**
   * What the item cost you, read out of eBay's private note. Null means nobody
   * has recorded one — distinct from a genuine zero, which a freebie would be.
   */
  cost: number | null;
  /** Whatever else is written in that note, so editing cost doesn't eat it. */
  note: string;
}

export interface SellerListingsPage {
  listings: SellerListing[];
  page: number;
  totalPages: number;
  totalItems: number;
  /** Non-fatal notes from eBay (Ack=Warning), surfaced rather than swallowed. */
  warnings: string[];
}

function requestXml(page: number, pageSize: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ActiveList>
    <Include>true</Include>
    <!-- Private notes carry the cost basis (lib/costBasis.ts). Seller-only. -->
    <IncludeNotes>true</IncludeNotes>
    <Pagination>
      <EntriesPerPage>${pageSize}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
    <Sort>TimeLeft</Sort>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;
}

/**
 * How postage is arranged on a live listing.
 *
 * eBay expresses this three ways at once and they can disagree, so they are
 * checked in order of how explicit they are: an outright FreeShipping flag, then
 * the ShippingType, then the cost itself. A listing whose ShippingDetails eBay
 * didn't return comes back "unknown" rather than being guessed at — telling a
 * seller their buyer pays postage when they actually eat it is worse than
 * saying nothing.
 */
function parseShipping(block: string): {
  shipping: ShippingArrangement;
  shippingCost: number | null;
  shippingService: string;
} {
  const details = xmlBlocks(block, "ShippingDetails")[0] ?? "";
  if (!details) return { shipping: "unknown", shippingCost: null, shippingService: "" };

  const option = xmlBlocks(details, "ShippingServiceOptions")[0] ?? "";
  const service = xmlText(option, "ShippingService");
  const cost = xmlNumber(option, "ShippingServiceCost");
  const type = xmlText(details, "ShippingType");
  const flaggedFree = xmlText(option, "FreeShipping").toLowerCase() === "true";

  if (flaggedFree) return { shipping: "free", shippingCost: 0, shippingService: service };
  // "Calculated" and "FlatDomesticCalculatedInternational" both mean the
  // domestic buyer is quoted from weight and size at checkout.
  if (/calculated/i.test(type) && !/^FlatDomestic/i.test(type)) {
    return { shipping: "calculated", shippingCost: null, shippingService: service };
  }
  if (cost === 0) return { shipping: "free", shippingCost: 0, shippingService: service };
  if (cost !== null && cost > 0) {
    return { shipping: "flat", shippingCost: cost, shippingService: service };
  }
  return { shipping: "unknown", shippingCost: null, shippingService: service };
}

function parseListing(block: string): SellerListing | null {
  const itemId = xmlText(block, "ItemID");
  if (!itemId) return null;

  const selling = xmlBlocks(block, "SellingStatus")[0] ?? "";
  const details = xmlBlocks(block, "ListingDetails")[0] ?? "";
  // Current price lives under SellingStatus; fall back to the start price for
  // anything that hasn't been bid on or repriced.
  const price =
    xmlNumber(selling, "CurrentPrice") ??
    xmlNumber(block, "BuyItNowPrice") ??
    xmlNumber(details, "StartPrice") ??
    xmlNumber(block, "StartPrice");

  const currencyMatch =
    /<CurrentPrice[^>]*currencyID="([A-Z]{3})"/.exec(selling) ||
    /<StartPrice[^>]*currencyID="([A-Z]{3})"/.exec(block);

  // PrivateNotes is only ever returned to the seller who wrote it, which is why
  // it's a safe place to keep a purchase price.
  const { cost, text: note } = parseNote(xmlText(block, "PrivateNotes"));

  return {
    itemId,
    ...parseShipping(block),
    cost,
    note,
    title: xmlText(block, "Title"),
    sku: xmlText(block, "SKU"),
    price,
    currency: currencyMatch?.[1] || "USD",
    quantity: xmlNumber(block, "Quantity"),
    quantitySold: xmlNumber(selling, "QuantitySold"),
    watchCount: xmlNumber(block, "WatchCount"),
    imageUrl: xmlText(block, "GalleryURL") || xmlText(block, "PictureURL"),
    viewUrl: xmlText(details, "ViewItemURL") || `${EBAY_ITEM_PREFIX}${itemId}`,
    startTime: xmlText(details, "StartTime"),
    bestOfferEnabled: xmlText(block, "BestOfferEnabled").toLowerCase() === "true",
    format: xmlText(details, "ListingType") || "FixedPriceItem",
  };
}

export class TradingApiError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

/**
 * One page of active listings.
 *
 * Throws TradingApiError with eBay's own wording when the call fails, so the
 * route can pass a real reason to the UI instead of "something went wrong".
 */
export async function fetchActiveListings(
  accessToken: string,
  page = 1,
  pageSize = LISTINGS_PAGE_SIZE
): Promise<SellerListingsPage> {
  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "Content-Type": "text/xml",
    },
    body: requestXml(Math.max(1, page), Math.min(200, Math.max(1, pageSize))),
  });

  const xml = await resp.text();
  const ack = tradingAck(xml);
  if (!ack.ok) {
    const first = ack.errors[0];
    // 931/932 are the token errors. Naming them lets the UI say "reconnect"
    // instead of showing a raw eBay sentence about an IAF token.
    throw new TradingApiError(
      first?.message || `eBay returned ${ack.ack} (HTTP ${resp.status}).`,
      first?.code || String(resp.status)
    );
  }

  const active = xmlBlocks(xml, "ActiveList")[0] ?? "";
  const listings = xmlBlocks(active, "Item")
    .map(parseListing)
    .filter((l): l is SellerListing => l !== null);

  const pagination = xmlBlocks(active, "PaginationResult")[0] ?? "";
  return {
    listings,
    page,
    totalPages: xmlNumber(pagination, "TotalNumberOfPages") ?? 1,
    totalItems: xmlNumber(pagination, "TotalNumberOfEntries") ?? listings.length,
    warnings: ack.ack === "Warning" ? ack.errors.map((e) => e.message) : [],
  };
}
