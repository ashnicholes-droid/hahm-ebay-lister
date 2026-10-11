import { describe, expect, test } from "vitest";
import {
  classifyShippingPolicy,
  missingClothingPolicyMessage,
  offerBodyWithFulfillmentPolicy,
  parseActiveListPage,
  reviseFixedPriceShippingXml,
  selectFulfillmentPolicyByName,
} from "@/lib/ebay/clothing-shipping-policy";

describe("selectFulfillmentPolicyByName", () => {
  test("uses the policy named Ebay Shipping Clothing, not the first policy", () => {
    const selected = selectFulfillmentPolicyByName([
      { name: "USPS First", fulfillmentPolicyId: "111" },
      { name: "Ebay Shipping Clothing", fulfillmentPolicyId: "222" },
      { name: "Flat rate", fulfillmentPolicyId: "333" },
    ]);
    expect(selected).toEqual({
      fulfillmentPolicyId: "222",
      fulfillmentPolicyName: "Ebay Shipping Clothing",
    });
  });

  test("does not publish through a different policy when the name is missing", () => {
    const selected = selectFulfillmentPolicyByName([
      { name: "USPS First", fulfillmentPolicyId: "111" },
    ]);
    expect(selected).toEqual({ error: missingClothingPolicyMessage() });
  });

  test("rejects two policies with the same exact name", () => {
    const selected = selectFulfillmentPolicyByName([
      { name: "Ebay Shipping Clothing", fulfillmentPolicyId: "222" },
      { name: "Ebay Shipping Clothing", fulfillmentPolicyId: "444" },
    ]);
    expect("error" in selected).toBe(true);
  });
});

describe("parseActiveListPage", () => {
  test("reads shipping profiles from the active list only", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingResponse>
  <ActiveList>
    <PaginationResult>
      <TotalNumberOfPages>2</TotalNumberOfPages>
      <TotalNumberOfEntries>2</TotalNumberOfEntries>
    </PaginationResult>
    <ItemArray>
      <Item>
        <ItemID>1001</ItemID>
        <Title>Red coat</Title>
        <SKU>2830</SKU>
        <ListingType>FixedPriceItem</ListingType>
        <SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus>
        <SellerProfiles>
          <SellerShippingProfile>
            <ShippingProfileID>222</ShippingProfileID>
            <ShippingProfileName>Ebay Shipping Clothing</ShippingProfileName>
          </SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>10</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>20</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
      </Item>
      <Item>
        <ItemID>1002</ItemID>
        <Title>Blue jacket</Title>
        <SKU>2831</SKU>
        <ListingType>FixedPriceItem</ListingType>
        <SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus>
        <SellerProfiles>
          <SellerShippingProfile>
            <ShippingProfileID>111</ShippingProfileID>
            <ShippingProfileName>USPS First</ShippingProfileName>
          </SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>10</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>20</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
      </Item>
    </ItemArray>
  </ActiveList>
  <SoldList>
    <ItemArray>
      <Item><ItemID>9999</ItemID><Title>Sold item</Title></Item>
    </ItemArray>
  </SoldList>
</GetMyeBaySellingResponse>`;
    const parsed = parseActiveListPage(xml);
    expect(parsed.totalPages).toBe(2);
    expect(parsed.listings.map((listing) => listing.itemId)).toEqual(["1001", "1002"]);
    expect(classifyShippingPolicy(parsed.listings[0], "222")).toBe("keep");
    expect(classifyShippingPolicy(parsed.listings[1], "222")).toBe("would_update");
  });
});

describe("reviseFixedPriceShippingXml", () => {
  test("changes only the shipping profile and keeps payment and return ids", () => {
    const xml = reviseFixedPriceShippingXml({
      itemId: "1002",
      shippingPolicyId: "222",
      paymentPolicyId: "10",
      returnPolicyId: "20",
    });
    expect(xml).toContain("<ShippingProfileID>222</ShippingProfileID>");
    expect(xml).toContain("<PaymentProfileID>10</PaymentProfileID>");
    expect(xml).toContain("<ReturnProfileID>20</ReturnProfileID>");
    expect(xml).not.toContain("StartPrice");
    expect(xml).not.toContain("<Title>");
    expect(xml).not.toContain("<Quantity>");
    expect(xml).not.toContain("Description");
    expect(xml).not.toContain("PictureDetails");
    expect(xml).not.toContain("EndItem");
    expect(xml).not.toContain("Relist");
  });
});

describe("offerBodyWithFulfillmentPolicy", () => {
  test("replaces only the fulfillment policy on a published offer", () => {
    const offer = {
      offerId: "offer-1",
      sku: "2831",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      status: "PUBLISHED",
      listingDescription: "Blue jacket",
      categoryId: "57988",
      merchantLocationKey: "HOME_OFFICE",
      pricingSummary: { price: { value: "40.00", currency: "USD" } },
      listingPolicies: {
        fulfillmentPolicyId: "111",
        paymentPolicyId: "10",
        returnPolicyId: "20",
        bestOfferTerms: { bestOfferEnabled: true },
      },
      listing: { listingId: "1002", listingStatus: "ACTIVE" },
      includeCatalogProductDetails: false,
    };
    const prepared = offerBodyWithFulfillmentPolicy(offer, "222");
    expect("body" in prepared).toBe(true);
    if (!("body" in prepared)) return;
    const policies = prepared.body.listingPolicies as {
      fulfillmentPolicyId: string;
      paymentPolicyId: string;
      returnPolicyId: string;
      bestOfferTerms: { bestOfferEnabled: boolean };
    };
    expect(policies.fulfillmentPolicyId).toBe("222");
    expect(policies.paymentPolicyId).toBe("10");
    expect(policies.returnPolicyId).toBe("20");
    expect(policies.bestOfferTerms.bestOfferEnabled).toBe(true);
    expect(prepared.body.listingDescription).toBe("Blue jacket");
    expect((prepared.body.pricingSummary as { price: { value: string } }).price.value).toBe("40.00");
    expect(prepared.body.categoryId).toBe("57988");
    expect(prepared.body.includeCatalogProductDetails).toBe(false);
    expect(prepared.body.offerId).toBeUndefined();
    expect(prepared.body.status).toBeUndefined();
    expect(prepared.body.listing).toBeUndefined();
    expect(offer.listingPolicies.fulfillmentPolicyId).toBe("111");
  });
});
