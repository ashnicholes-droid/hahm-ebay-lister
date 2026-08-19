import { describe, expect, it } from "vitest";
import { validateBestOffer, validatePrice, MAX_PRICE } from "@/lib/ebay/revise";

// A sample of the shape GetMyeBaySelling actually returns, trimmed to the
// fields this app reads. Parsing is exercised through the real module below.
const ITEM = `
  <Item>
    <ItemID>110586123456</ItemID>
    <Title><![CDATA[Lodge 12" Cast Iron Skillet <Pre-Seasoned> & Ready]]></Title>
    <SKU>K75-A</SKU>
    <Quantity>3</Quantity>
    <WatchCount>7</WatchCount>
    <BestOfferEnabled>true</BestOfferEnabled>
    <PictureDetails><GalleryURL>https://i.ebayimg.com/a.jpg</GalleryURL></PictureDetails>
    <SellingStatus>
      <CurrentPrice currencyID="USD">45.50</CurrentPrice>
      <QuantitySold>1</QuantitySold>
    </SellingStatus>
    <ListingDetails>
      <StartTime>2026-07-01T12:00:00.000Z</StartTime>
      <ViewItemURL>https://www.ebay.com/itm/110586123456</ViewItemURL>
      <ListingType>FixedPriceItem</ListingType>
    </ListingDetails>
  </Item>`;

const responseXml = (items: string, ack = "Success") => `<?xml version="1.0"?>
<GetMyeBaySellingResponse>
  <Ack>${ack}</Ack>
  <ActiveList>
    <ItemArray>${items}</ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>2</TotalNumberOfPages>
      <TotalNumberOfEntries>140</TotalNumberOfEntries>
    </PaginationResult>
  </ActiveList>
</GetMyeBaySellingResponse>`;

// The parser is module-private, so it's exercised the way the route does — by
// stubbing fetch and calling the exported function.
async function parseViaFetch(xml: string, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(xml, { status })) as typeof fetch;
  try {
    const { fetchActiveListings } = await import("@/lib/ebay/listings");
    return await fetchActiveListings("token", 1);
  } finally {
    globalThis.fetch = original;
  }
}

describe("reading the active list", () => {
  it("reads the fields the seller view shows", async () => {
    const page = await parseViaFetch(responseXml(ITEM));
    const l = page.listings[0];
    expect(l.itemId).toBe("110586123456");
    expect(l.title).toBe('Lodge 12" Cast Iron Skillet <Pre-Seasoned> & Ready');
    expect(l.sku).toBe("K75-A");
    expect(l.price).toBe(45.5);
    expect(l.currency).toBe("USD");
    expect(l.watchCount).toBe(7);
    expect(l.quantitySold).toBe(1);
    expect(l.bestOfferEnabled).toBe(true);
    expect(l.imageUrl).toBe("https://i.ebayimg.com/a.jpg");
  });

  it("reads pagination so the view knows there's more", async () => {
    const page = await parseViaFetch(responseXml(ITEM));
    expect(page.totalPages).toBe(2);
    expect(page.totalItems).toBe(140);
  });

  it("handles many items", async () => {
    const page = await parseViaFetch(responseXml(ITEM.repeat(3)));
    expect(page.listings).toHaveLength(3);
  });

  it("returns an empty list rather than throwing when there's nothing active", async () => {
    const page = await parseViaFetch(responseXml(""));
    expect(page.listings).toEqual([]);
  });

  it("treats Warning as success — eBay sends it constantly", async () => {
    const page = await parseViaFetch(responseXml(ITEM, "Warning"));
    expect(page.listings).toHaveLength(1);
  });

  it("throws eBay's own words on failure, with its code", async () => {
    const xml = `<r><Ack>Failure</Ack><Errors>
      <ErrorCode>931</ErrorCode>
      <LongMessage>Auth token is invalid.</LongMessage>
    </Errors></r>`;
    await expect(parseViaFetch(xml)).rejects.toThrow(/Auth token is invalid/);
  });

  it("does not report a watch count eBay never sent", async () => {
    // "eBay didn't say" must not render as "nobody is watching".
    const noWatch = ITEM.replace("<WatchCount>7</WatchCount>", "");
    const page = await parseViaFetch(responseXml(noWatch));
    expect(page.listings[0].watchCount).toBeNull();
  });
});

describe("price validation, before any call is spent", () => {
  it("accepts an ordinary price and rounds to the cent", () => {
    expect(validatePrice("45.499")).toEqual({ price: 45.5 });
    expect(validatePrice(19.99)).toEqual({ price: 19.99 });
  });

  it("rejects what eBay would reject", () => {
    expect(validatePrice("free")).toHaveProperty("error");
    expect(validatePrice(0)).toHaveProperty("error");
    expect(validatePrice(-5)).toHaveProperty("error");
    expect(validatePrice(MAX_PRICE + 1)).toHaveProperty("error");
  });

  it("catches the misplaced decimal that would list a $45 item at $4500", () => {
    const r = validatePrice(4_500_000);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/typo/i);
  });
});

describe("Best Offer terms", () => {
  it("allows the plain case", () => {
    expect(validateBestOffer({ enabled: true }, 50)).toEqual({ ok: true });
    expect(validateBestOffer({ enabled: false }, 50)).toEqual({ ok: true });
  });

  it("allows sensible thresholds", () => {
    expect(
      validateBestOffer({ enabled: true, autoAcceptPrice: 45, autoDeclinePrice: 30 }, 50)
    ).toEqual({ ok: true });
  });

  it("refuses an auto-accept above the asking price, which could never fire", () => {
    const r = validateBestOffer({ enabled: true, autoAcceptPrice: 60 }, 50);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/never trigger/i);
  });

  it("refuses a decline floor above the accept ceiling", () => {
    // This would auto-decline offers it would also auto-accept.
    const r = validateBestOffer({ enabled: true, autoAcceptPrice: 40, autoDeclinePrice: 45 }, 50);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/decline offers you.d have accepted/i);
  });

  it("refuses nonsense thresholds", () => {
    expect(validateBestOffer({ enabled: true, autoAcceptPrice: -1 }, 50)).toHaveProperty("error");
    expect(validateBestOffer({ enabled: true, autoDeclinePrice: 0 }, 50)).toHaveProperty("error");
  });

  it("ignores thresholds entirely when Best Offer is off", () => {
    expect(validateBestOffer({ enabled: false, autoAcceptPrice: 999 }, 50)).toEqual({ ok: true });
  });
});
