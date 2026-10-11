import { EBAY_INV_BASE, EBAY_MARKETPLACE_ID, EBAY_TRADING } from "@/lib/ebay/config";
import {
  activeListingsRequestXml,
  CLOTHING_SHIPPING_POLICY_NAME,
  classifyShippingPolicy,
  getItemRequestXml,
  isActiveListingStatus,
  isFixedPriceListing,
  isInventoryManagedReviseError,
  MEDIA_MAIL_BOOK_POLICY_NAME,
  offerBodyWithFulfillmentPolicy,
  parseActiveListPage,
  reviseFixedPriceShippingXml,
  SHIPPING_POLICY_APPLY_BATCH,
  SHIPPING_POLICY_MAX_PAGES,
  SHIPPING_POLICY_PAGE_SIZE,
  type ActiveListingPolicy,
  type ShippingPolicyApplyResultRow,
  type ShippingPolicyListingView,
  type ShippingPolicyPreviewResult,
} from "@/lib/ebay/clothing-shipping-policy";
import { resolveShippingReviewTargets } from "@/lib/ebay/publish";

const TRADING_COMPATIBILITY = "1423";
const PAGE_DELAY_MS = 250;
const APPLY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tradingCall(accessToken: string, callName: string, body: string): Promise<string> {
  const run = () =>
    fetch(EBAY_TRADING, {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": accessToken,
        "Content-Type": "text/xml",
        "X-EBAY-API-CALL-NAME": callName,
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_COMPATIBILITY,
      },
      body,
    });
  let resp = await run();
  if (resp.status === 429) {
    await sleep(2000);
    resp = await run();
  }
  const text = await resp.text();
  if (!resp.ok || !/<Ack>(Success|Warning)<\/Ack>/i.test(text)) {
    const message =
      text.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/i)?.[1] ||
      text.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/i)?.[1] ||
      `eBay ${callName} failed (${resp.status})`;
    const error = new Error(message.replace(/<[^>]+>/g, "").trim().slice(0, 300));
    (error as Error & { xml?: string }).xml = text;
    throw error;
  }
  return text;
}

async function ebayJson(
  accessToken: string,
  method: string,
  url: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const run = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en-US",
        ...(body !== undefined ? { "Content-Language": "en-US" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let resp = await run();
  if (resp.status === 429) {
    await sleep(2000);
    resp = await run();
  }
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

async function requireReviewTargets(
  accessToken: string
): Promise<{ clothingPolicyId: string; mediaMailPolicyIds: string[] }> {
  const selected = await resolveShippingReviewTargets(accessToken);
  if ("error" in selected) throw new Error(selected.error);
  return selected;
}

function offerFulfillmentPolicyId(offer: Record<string, unknown>): string {
  const policies = offer.listingPolicies as { fulfillmentPolicyId?: string } | undefined;
  return String(policies?.fulfillmentPolicyId || "").trim();
}

export async function previewClothingShippingPolicies(
  accessToken: string
): Promise<ShippingPolicyPreviewResult> {
  const selected = await requireReviewTargets(accessToken);
  const listings: ShippingPolicyListingView[] = [];
  let pages = 1;
  let totalEntries = 0;
  let truncated = false;
  let alreadyUsing = 0;
  let mediaMailExcluded = 0;
  let otherPolicy = 0;
  let unreadable = 0;

  for (let page = 1; page <= pages; page += 1) {
    if (page > SHIPPING_POLICY_MAX_PAGES) {
      truncated = true;
      break;
    }
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const xml = await tradingCall(accessToken, "GetMyeBaySelling", activeListingsRequestXml(page));
    const parsed = parseActiveListPage(xml);
    pages = Math.max(pages, parsed.totalPages, 1);
    if (parsed.totalEntries > totalEntries) totalEntries = parsed.totalEntries;
    if (
      parsed.listings.length >= SHIPPING_POLICY_PAGE_SIZE &&
      page >= pages &&
      page < SHIPPING_POLICY_MAX_PAGES
    ) {
      pages = page + 1;
    }
    if (pages > SHIPPING_POLICY_MAX_PAGES) truncated = true;
    for (const listing of parsed.listings) {
      if (!isActiveListingStatus(listing.listingStatus)) continue;
      const action = classifyShippingPolicy(
        listing,
        selected.clothingPolicyId,
        CLOTHING_SHIPPING_POLICY_NAME,
        selected.mediaMailPolicyIds
      );
      if (action === "keep") {
        alreadyUsing += 1;
        continue;
      }
      if (action === "exclude_media_mail") mediaMailExcluded += 1;
      else if (action === "would_update") otherPolicy += 1;
      else unreadable += 1;
      listings.push({
        itemId: listing.itemId,
        sku: listing.sku,
        title: listing.title,
        offerId: "",
        shippingPolicyId: listing.shippingPolicyId,
        shippingPolicyName: listing.shippingPolicyName,
        action,
      });
    }
  }

  const totalReviewed = alreadyUsing + mediaMailExcluded + otherPolicy + unreadable;
  const incomplete = !truncated && totalEntries > 0 && totalReviewed !== totalEntries;
  console.log(
    `[ebay/shipping-policy] preview dryRun total=${totalReviewed} already=${alreadyUsing} mediaMail=${mediaMailExcluded} other=${otherPolicy} unreadable=${unreadable} truncated=${truncated}`
  );
  return {
    ok: true,
    dryRun: true,
    policyName: CLOTHING_SHIPPING_POLICY_NAME,
    policyId: selected.clothingPolicyId,
    totalReviewed,
    alreadyUsing,
    mediaMailExcluded,
    otherPolicy,
    unreadable,
    truncated,
    incomplete,
    totalEntries,
    listings,
  };
}

async function readListing(accessToken: string, itemId: string): Promise<ActiveListingPolicy | null> {
  const xml = await tradingCall(accessToken, "GetItem", getItemRequestXml(itemId));
  const item = xml.match(/<Item\b[^>]*>[\s\S]*?<\/Item>/i)?.[0] ?? "";
  if (!item) return null;
  const wrapped = `<ActiveList><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>${item}</ActiveList>`;
  return parseActiveListPage(wrapped).listings[0] ?? null;
}

async function publishedOfferForItem(
  accessToken: string,
  sku: string,
  itemId: string
): Promise<{ kind: "none" } | { kind: "many" } | { kind: "one"; offer: Record<string, unknown> }> {
  if (!sku.trim()) return { kind: "none" };
  const response = await ebayJson(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE_ID}`
  );
  if (!response.ok) return { kind: "none" };
  const matches = ((response.json?.offers ?? []) as Record<string, unknown>[]).filter((offer) => {
    const status = String(offer.status || "").toUpperCase();
    const listingId = String((offer.listing as { listingId?: string } | undefined)?.listingId || "");
    return status === "PUBLISHED" && listingId === itemId;
  });
  if (matches.length > 1) return { kind: "many" };
  if (matches.length === 1) return { kind: "one", offer: matches[0] };
  return { kind: "none" };
}

async function updatePublishedOffer(
  accessToken: string,
  offer: Record<string, unknown>,
  fulfillmentPolicyId: string
): Promise<{ offerId: string } | { error: string }> {
  const offerId = String(offer.offerId || "");
  if (!offerId) return { error: "La oferta publicada no tiene offerId. No se modificó el listing." };
  const prepared = offerBodyWithFulfillmentPolicy(offer, fulfillmentPolicyId);
  if ("error" in prepared) return prepared;
  const response = await ebayJson(
    accessToken,
    "PUT",
    `${EBAY_INV_BASE}/offer/${encodeURIComponent(offerId)}`,
    prepared.body
  );
  if (!response.ok) {
    return {
      error: String(response.json?.errors?.[0]?.message || response.text || response.status).slice(0, 300),
    };
  }
  return { offerId };
}

async function reviseTradingShipping(
  accessToken: string,
  listing: ActiveListingPolicy,
  fulfillmentPolicyId: string
): Promise<{ error?: string; inventoryManaged?: boolean }> {
  if (!listing.paymentPolicyId || !listing.returnPolicyId) {
    return {
      error: "El listing no trae payment policy o return policy. No se envió un cambio incompleto.",
    };
  }
  try {
    await tradingCall(
      accessToken,
      "ReviseFixedPriceItem",
      reviseFixedPriceShippingXml({
        itemId: listing.itemId,
        shippingPolicyId: fulfillmentPolicyId,
        paymentPolicyId: listing.paymentPolicyId,
        returnPolicyId: listing.returnPolicyId,
      })
    );
    return {};
  } catch (error) {
    const xml = (error as { xml?: string }).xml || "";
    if (isInventoryManagedReviseError(xml)) return { inventoryManaged: true };
    return { error: error instanceof Error ? error.message : "ReviseFixedPriceItem failed." };
  }
}

export async function applyClothingShippingPolicy(
  accessToken: string,
  itemIds: string[]
): Promise<{ ok: true; dryRun: false; policyId: string; results: ShippingPolicyApplyResultRow[] }> {
  const unique = [...new Set(itemIds.map((id) => id.replace(/[^\d]/g, "")).filter(Boolean))];
  if (!unique.length) throw new Error("No hay listings para actualizar.");
  if (unique.length > SHIPPING_POLICY_APPLY_BATCH) {
    throw new Error(`Envía como máximo ${SHIPPING_POLICY_APPLY_BATCH} listings por lote.`);
  }
  const selected = await requireReviewTargets(accessToken);
  const results: ShippingPolicyApplyResultRow[] = [];

  for (let index = 0; index < unique.length; index += 1) {
    if (index > 0) await sleep(APPLY_DELAY_MS);
    const itemId = unique[index];
    try {
      const listing = await readListing(accessToken, itemId);
      if (!listing) {
        results.push(blank(itemId, "eBay no devolvió el listing. No se modificó."));
        continue;
      }
      if (!isActiveListingStatus(listing.listingStatus)) {
        results.push(resultRow(listing, "skipped", "El listing ya no está activo. No se modificó."));
        continue;
      }
      const action = classifyShippingPolicy(
        listing,
        selected.clothingPolicyId,
        CLOTHING_SHIPPING_POLICY_NAME,
        selected.mediaMailPolicyIds
      );
      if (action === "exclude_media_mail") {
        results.push(resultRow(listing, "skipped", `Usa ${MEDIA_MAIL_BOOK_POLICY_NAME}. No se modificó.`));
        continue;
      }
      if (action === "keep") {
        results.push(resultRow(listing, "skipped", "Ya usa Ebay Shipping Clothing."));
        continue;
      }
      if (action === "unreadable") {
        results.push(
          resultRow(listing, "skipped", "No se pudo leer la Shipping Policy actual. No se modificó.")
        );
        continue;
      }
      if (!isFixedPriceListing(listing.listingType)) {
        results.push(resultRow(listing, "error", "No es un listing de precio fijo. No se modificó."));
        continue;
      }

      const found = await publishedOfferForItem(accessToken, listing.sku, listing.itemId);
      if (found.kind === "many") {
        results.push(
          resultRow(listing, "error", "Hay más de una oferta publicada para este item. No se modificó.")
        );
        continue;
      }
      if (found.kind === "one") {
        const offerPolicyId = offerFulfillmentPolicyId(found.offer);
        const offerAction = classifyShippingPolicy(
          { shippingPolicyId: offerPolicyId, shippingPolicyName: "" },
          selected.clothingPolicyId,
          CLOTHING_SHIPPING_POLICY_NAME,
          selected.mediaMailPolicyIds
        );
        if (offerAction === "exclude_media_mail") {
          results.push(resultRow(listing, "skipped", `Usa ${MEDIA_MAIL_BOOK_POLICY_NAME}. No se modificó.`));
          continue;
        }
        if (offerAction === "keep") {
          results.push(resultRow(listing, "skipped", "Ya usa Ebay Shipping Clothing."));
          continue;
        }
        if (offerAction === "unreadable") {
          results.push(
            resultRow(listing, "skipped", "No se pudo leer la Shipping Policy actual. No se modificó.")
          );
          continue;
        }
        const updated = await updatePublishedOffer(
          accessToken,
          found.offer,
          selected.clothingPolicyId
        );
        if ("error" in updated) {
          results.push(resultRow(listing, "error", updated.error));
          continue;
        }
        results.push({
          ...resultRow(
            listing,
            "updated",
            "Shipping Policy actualizada en la oferta publicada. No se republicó."
          ),
          offerId: updated.offerId,
        });
        console.log(`[ebay/shipping-policy] apply item=${itemId} status=updated via=inventory`);
        continue;
      }

      const revised = await reviseTradingShipping(
        accessToken,
        listing,
        selected.clothingPolicyId
      );
      if (revised.inventoryManaged) {
        results.push(
          resultRow(
            listing,
            "error",
            "El listing lo administra Inventory API y no se encontró una oferta publicada. No se creó ni se republicó nada."
          )
        );
        continue;
      }
      if (revised.error) {
        results.push(resultRow(listing, "error", revised.error));
        continue;
      }
      results.push(
        resultRow(listing, "updated", "Shipping Policy actualizada con ReviseFixedPriceItem. No se republicó.")
      );
      console.log(`[ebay/shipping-policy] apply item=${itemId} status=updated via=trading`);
    } catch (error) {
      results.push(
        blank(itemId, error instanceof Error ? error.message : "No se pudo actualizar este listing.")
      );
      console.log(`[ebay/shipping-policy] apply item=${itemId} status=error`);
    }
  }

  return { ok: true, dryRun: false, policyId: selected.clothingPolicyId, results };
}

function resultRow(
  listing: ActiveListingPolicy,
  status: ShippingPolicyApplyResultRow["status"],
  message: string
): ShippingPolicyApplyResultRow {
  return {
    itemId: listing.itemId,
    sku: listing.sku,
    title: listing.title,
    offerId: listing.offerId,
    shippingPolicyId: listing.shippingPolicyId,
    shippingPolicyName: listing.shippingPolicyName,
    status,
    message,
  };
}

function blank(itemId: string, message: string): ShippingPolicyApplyResultRow {
  return {
    itemId,
    sku: "",
    title: "",
    offerId: "",
    shippingPolicyId: "",
    shippingPolicyName: "",
    status: "error",
    message,
  };
}
