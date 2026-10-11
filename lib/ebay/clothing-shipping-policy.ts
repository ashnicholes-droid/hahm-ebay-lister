// Exact eBay business-policy name for clothing. New publishes and the
// listing review both resolve this name to an id. They never take
// fulfillmentPolicies[0].

export const CLOTHING_SHIPPING_POLICY_NAME = "Ebay Shipping Clothing";
export const MEDIA_MAIL_BOOK_POLICY_NAME = "Media Mail Book";
export const SHIPPING_POLICY_APPLY_BATCH = 10;
export const SHIPPING_POLICY_PAGE_SIZE = 200;
export const SHIPPING_POLICY_MAX_PAGES = 200;

export interface FulfillmentPolicyRecord {
  name?: string;
  fulfillmentPolicyId?: string;
}

export interface SelectedFulfillmentPolicy {
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
}

export function missingClothingPolicyMessage(
  name = CLOTHING_SHIPPING_POLICY_NAME
): string {
  return `No se encontró la Shipping Policy "${name}". No se publicó con otra política.`;
}

export function ambiguousClothingPolicyMessage(
  name = CLOTHING_SHIPPING_POLICY_NAME
): string {
  return `Hay más de una fulfillment policy llamada "${name}". No se publicó.`;
}

export function fulfillmentPoliciesUnreadableMessage(): string {
  return "No se pudieron leer las fulfillment policies de eBay. No se publicó con otra política.";
}

export function selectFulfillmentPolicyByName(
  policies: FulfillmentPolicyRecord[],
  name = CLOTHING_SHIPPING_POLICY_NAME
): SelectedFulfillmentPolicy | { error: string } {
  const matches = policies.filter((policy) => {
    const policyName = String(policy?.name ?? "").trim();
    const id = String(policy?.fulfillmentPolicyId ?? "").trim();
    return policyName === name && id.length > 0;
  });
  if (matches.length === 1) {
    return {
      fulfillmentPolicyId: String(matches[0].fulfillmentPolicyId).trim(),
      fulfillmentPolicyName: name,
    };
  }
  if (matches.length === 0) return { error: missingClothingPolicyMessage(name) };
  return { error: ambiguousClothingPolicyMessage(name) };
}

export interface ActiveListingPolicy {
  itemId: string;
  sku: string;
  title: string;
  offerId: string;
  listingType: string;
  listingStatus: string;
  shippingPolicyId: string;
  shippingPolicyName: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

export type ShippingPolicyAction = "keep" | "exclude_media_mail" | "would_update" | "unreadable";

export interface ShippingPolicyListingView {
  itemId: string;
  sku: string;
  title: string;
  offerId: string;
  shippingPolicyId: string;
  shippingPolicyName: string;
  action: ShippingPolicyAction;
}

export interface ShippingPolicyPreviewResult {
  ok: true;
  dryRun: true;
  policyName: string;
  policyId: string;
  totalReviewed: number;
  alreadyUsing: number;
  mediaMailExcluded: number;
  otherPolicy: number;
  unreadable: number;
  truncated: boolean;
  incomplete: boolean;
  totalEntries: number;
  listings: ShippingPolicyListingView[];
}

export interface ShippingPolicyApplyResultRow {
  itemId: string;
  sku: string;
  title: string;
  offerId: string;
  shippingPolicyId: string;
  shippingPolicyName: string;
  status: "updated" | "skipped" | "error";
  message: string;
}

export function fulfillmentPolicyIdsByName(
  policies: FulfillmentPolicyRecord[],
  name: string
): string[] {
  const ids: string[] = [];
  for (const policy of policies) {
    const policyName = String(policy?.name ?? "").trim();
    const id = String(policy?.fulfillmentPolicyId ?? "").trim();
    if (policyName === name && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function classifyShippingPolicy(
  listing: Pick<ActiveListingPolicy, "shippingPolicyId" | "shippingPolicyName">,
  targetId: string,
  targetName = CLOTHING_SHIPPING_POLICY_NAME,
  mediaMailPolicyIds: readonly string[] = []
): ShippingPolicyAction {
  const id = listing.shippingPolicyId.trim();
  const name = listing.shippingPolicyName.trim();
  const mediaMailIds = mediaMailPolicyIds.map((value) => value.trim()).filter(Boolean);
  if (name === MEDIA_MAIL_BOOK_POLICY_NAME || (id && mediaMailIds.includes(id))) {
    return "exclude_media_mail";
  }
  if ((id && id === targetId.trim()) || name === targetName) return "keep";
  if (!id) return "unreadable";
  return "would_update";
}

export function toListingView(
  listing: ActiveListingPolicy,
  targetId: string,
  targetName = CLOTHING_SHIPPING_POLICY_NAME,
  mediaMailPolicyIds: readonly string[] = []
): ShippingPolicyListingView {
  return {
    itemId: listing.itemId,
    sku: listing.sku,
    title: listing.title,
    offerId: listing.offerId,
    shippingPolicyId: listing.shippingPolicyId,
    shippingPolicyName: listing.shippingPolicyName,
    action: classifyShippingPolicy(listing, targetId, targetName, mediaMailPolicyIds),
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : "";
}

function container(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ?? "";
}

export function parseActiveListPage(xml: string): {
  listings: ActiveListingPolicy[];
  totalPages: number;
  totalEntries: number;
} {
  const active = xml.match(/<ActiveList\b[^>]*>([\s\S]*?)<\/ActiveList>/i)?.[1] ?? "";
  const pages = Number(active.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/i)?.[1] ?? "1");
  const entries = Number(
    active.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/i)?.[1] ?? ""
  );
  const listings: ActiveListingPolicy[] = [];
  const pattern = /<Item\b[^>]*>([\s\S]*?)<\/Item>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(active))) {
    const block = match[1];
    const itemId = tag(block, "ItemID").replace(/[^\d]/g, "");
    if (!itemId) continue;
    const shipping = container(block, "SellerShippingProfile");
    const payment = container(block, "SellerPaymentProfile");
    const returns = container(block, "SellerReturnProfile");
    const selling = container(block, "SellingStatus");
    listings.push({
      itemId,
      sku: tag(block, "SKU"),
      title: tag(block, "Title"),
      offerId: "",
      listingType: tag(block, "ListingType"),
      listingStatus: tag(selling, "ListingStatus") || tag(block, "ListingStatus"),
      shippingPolicyId: tag(shipping, "ShippingProfileID"),
      shippingPolicyName: tag(shipping, "ShippingProfileName"),
      paymentPolicyId: tag(payment, "PaymentProfileID"),
      returnPolicyId: tag(returns, "ReturnProfileID"),
    });
  }
  return {
    listings,
    totalPages: Number.isFinite(pages) && pages > 0 ? pages : 1,
    totalEntries: Number.isFinite(entries) && entries > 0 ? entries : 0,
  };
}

export function activeListingsRequestXml(page: number, entriesPerPage = SHIPPING_POLICY_PAGE_SIZE): string {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.max(1, Math.min(200, Math.floor(entriesPerPage)));
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${safeSize}</EntriesPerPage>
      <PageNumber>${safePage}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;
}

export function getItemRequestXml(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId.replace(/[^\d]/g, "")}</ItemID>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function reviseFixedPriceShippingXml(input: {
  itemId: string;
  shippingPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(input.itemId.replace(/[^\d]/g, ""))}</ItemID>
    <SellerProfiles>
      <SellerShippingProfile>
        <ShippingProfileID>${escapeXml(input.shippingPolicyId)}</ShippingProfileID>
      </SellerShippingProfile>
      <SellerPaymentProfile>
        <PaymentProfileID>${escapeXml(input.paymentPolicyId)}</PaymentProfileID>
      </SellerPaymentProfile>
      <SellerReturnProfile>
        <ReturnProfileID>${escapeXml(input.returnPolicyId)}</ReturnProfileID>
      </SellerReturnProfile>
    </SellerProfiles>
  </Item>
</ReviseFixedPriceItemRequest>`;
}

export function isFixedPriceListing(listingType: string): boolean {
  const type = listingType.trim();
  if (!type) return true;
  return type === "FixedPriceItem" || type === "StoresFixedPrice";
}

export function isActiveListingStatus(status: string): boolean {
  const value = status.trim().toLowerCase();
  return value === "" || value === "active";
}

const OFFER_FIELDS_OMITTED_ON_UPDATE = new Set([
  "offerId",
  "status",
  "listing",
  "listingStatus",
  "warnings",
  "errors",
  "sku",
  "marketplaceId",
  "format",
]);

export function offerBodyWithFulfillmentPolicy(
  offer: Record<string, unknown>,
  fulfillmentPolicyId: string
): { body: Record<string, unknown> } | { error: string } {
  const policies =
    offer.listingPolicies && typeof offer.listingPolicies === "object"
      ? (JSON.parse(JSON.stringify(offer.listingPolicies)) as Record<string, unknown>)
      : null;
  if (!policies?.paymentPolicyId || !policies.returnPolicyId) {
    return {
      error:
        "La oferta no trae payment policy o return policy. No se modificó el listing.",
    };
  }
  const price = (offer.pricingSummary as { price?: { value?: string } } | undefined)?.price?.value;
  if (!price || !offer.categoryId || !offer.merchantLocationKey || typeof offer.listingDescription !== "string") {
    return {
      error:
        "La oferta no trae precio, categoría, ubicación o descripción. No se modificó el listing.",
    };
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(offer)) {
    if (OFFER_FIELDS_OMITTED_ON_UPDATE.has(key)) continue;
    body[key] = value;
  }
  policies.fulfillmentPolicyId = fulfillmentPolicyId;
  body.listingPolicies = policies;
  body.pricingSummary = JSON.parse(JSON.stringify(offer.pricingSummary));
  return { body };
}

export function isInventoryManagedReviseError(xml: string): boolean {
  return /<ErrorCode>\s*21919474\s*<\/ErrorCode>/i.test(xml) || /inventory api/i.test(xml);
}
