import crypto from "crypto";
import { ensureInventoryTables, getSql } from "@/lib/db";
import type { VintedPrepared } from "@/lib/vinted/prepare";
import type { VintedStatus } from "@/lib/types";

export interface PlatformListing {
  id: string;
  workspaceKey: string;
  sku: string;
  ebayItemId: string | null;
  ebayTitle: string | null;
  vintedTitle: string | null;
  vintedListingUrl: string | null;
  vintedListingId: string | null;
  publishedOnEbay: boolean;
  publishedOnVinted: boolean;
  vintedStatus: VintedStatus;
  prepared: VintedPrepared | null;
  createdAt: string;
  updatedAt: string;
}

export type ListingLookup =
  | { kind: "one"; row: PlatformListing }
  | { kind: "none" }
  | { kind: "ambiguous" };

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function asStatus(value: unknown): VintedStatus {
  if (value === "ready" || value === "published" || value === "not_prepared") return value;
  return "not_prepared";
}

function asPrepared(value: unknown): VintedPrepared | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as VintedPrepared;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as VintedPrepared;
  return null;
}

function mapListing(row: Record<string, unknown>): PlatformListing {
  return {
    id: String(row.id ?? ""),
    workspaceKey: String(row.workspace_key ?? ""),
    sku: String(row.sku ?? ""),
    ebayItemId: row.ebay_item_id ? String(row.ebay_item_id) : null,
    ebayTitle: row.ebay_title ? String(row.ebay_title) : null,
    vintedTitle: row.vinted_title ? String(row.vinted_title) : null,
    vintedListingUrl: row.vinted_listing_url ? String(row.vinted_listing_url) : null,
    vintedListingId: row.vinted_listing_id ? String(row.vinted_listing_id) : null,
    publishedOnEbay: asBool(row.published_on_ebay),
    publishedOnVinted: asBool(row.published_on_vinted),
    vintedStatus: asStatus(row.vinted_status),
    prepared: asPrepared(row.prepared),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export async function setVintedCurrentSku(workspaceKey: string, sku: string): Promise<void> {
  const sql = getSql();
  await ensureInventoryTables();
  await sql`
    INSERT INTO vinted_current_item (workspace_key, sku, updated_at)
    VALUES (${workspaceKey}, ${sku}, NOW())
    ON CONFLICT (workspace_key) DO UPDATE SET
      sku = EXCLUDED.sku,
      updated_at = NOW()
  `;
}

export async function getVintedCurrentSku(workspaceKey: string): Promise<string | null> {
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT sku
    FROM vinted_current_item
    WHERE workspace_key = ${workspaceKey}
  `;
  const sku = String((rows[0] as { sku?: string } | undefined)?.sku || "").trim();
  return sku || null;
}

export async function getLatestVintedCurrent(): Promise<{ workspaceKey: string; sku: string } | null> {
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT workspace_key, sku
    FROM vinted_current_item
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const row = rows[0] as { workspace_key?: string; sku?: string } | undefined;
  const workspaceKey = String(row?.workspace_key || "").trim();
  const sku = String(row?.sku || "").trim();
  if (!workspaceKey || !sku) return null;
  return { workspaceKey, sku };
}

export async function listListings(workspace: string): Promise<PlatformListing[]> {
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT *
    FROM platform_listings
    WHERE workspace_key = ${workspace}
    ORDER BY updated_at DESC
  `;
  return rows.map((row) => mapListing(row as Record<string, unknown>));
}

export async function listSaleTitleCandidates(): Promise<
  Array<{ sku: string; vintedTitle: string | null; ebayTitle: string | null }>
> {
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT sku, vinted_title, ebay_title
    FROM platform_listings
    WHERE sku IS NOT NULL AND btrim(sku) <> ''
  `;
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      sku: String(record.sku ?? "").trim(),
      vintedTitle: record.vinted_title == null ? null : String(record.vinted_title),
      ebayTitle: record.ebay_title == null ? null : String(record.ebay_title),
    };
  });
}

export async function listPublishedVinted(): Promise<PlatformListing[]> {
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT *
    FROM platform_listings
    WHERE published_on_vinted = TRUE
      AND vinted_status = 'published'
  `;
  return rows.map((row) => mapListing(row as Record<string, unknown>));
}

export async function upsertVintedReady(input: {
  workspaceKey: string;
  prepared: VintedPrepared;
  ebayItemId?: string | null;
  ebayTitle?: string | null;
  publishedOnEbay?: boolean;
}): Promise<void> {
  const sql = getSql();
  await ensureInventoryTables();
  const id = crypto.randomUUID();
  const preparedJson = JSON.stringify(input.prepared);
  await sql`
    INSERT INTO platform_listings (
      id, workspace_key, sku,
      ebay_item_id, ebay_title, published_on_ebay,
      vinted_title, vinted_status, published_on_vinted,
      prepared, status, created_at, updated_at
    )
    VALUES (
      ${id},
      ${input.workspaceKey},
      ${input.prepared.sku},
      ${input.ebayItemId || null},
      ${input.ebayTitle || input.prepared.title || null},
      ${Boolean(input.publishedOnEbay)},
      ${input.prepared.title},
      'ready',
      FALSE,
      ${preparedJson}::jsonb,
      'active',
      NOW(),
      NOW()
    )
    ON CONFLICT (workspace_key, sku) DO UPDATE SET
      ebay_item_id = COALESCE(EXCLUDED.ebay_item_id, platform_listings.ebay_item_id),
      ebay_title = COALESCE(EXCLUDED.ebay_title, platform_listings.ebay_title),
      published_on_ebay = platform_listings.published_on_ebay OR EXCLUDED.published_on_ebay,
      vinted_title = CASE
        WHEN platform_listings.vinted_status = 'published' THEN platform_listings.vinted_title
        ELSE EXCLUDED.vinted_title
      END,
      vinted_status = CASE
        WHEN platform_listings.vinted_status = 'published' THEN platform_listings.vinted_status
        ELSE 'ready'
      END,
      prepared = CASE
        WHEN platform_listings.vinted_status = 'published' THEN platform_listings.prepared
        ELSE EXCLUDED.prepared
      END,
      updated_at = NOW()
  `;
}

export async function recordEbayPublished(input: {
  workspaceKey: string;
  sku: string;
  ebayItemId: string;
  ebayTitle: string;
}): Promise<void> {
  const sql = getSql();
  await ensureInventoryTables();
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO platform_listings (
      id, workspace_key, sku,
      ebay_item_id, ebay_title, published_on_ebay,
      vinted_status, published_on_vinted,
      status, created_at, updated_at
    )
    VALUES (
      ${id},
      ${input.workspaceKey},
      ${input.sku},
      ${input.ebayItemId},
      ${input.ebayTitle},
      TRUE,
      'not_prepared',
      FALSE,
      'active',
      NOW(),
      NOW()
    )
    ON CONFLICT (workspace_key, sku) DO UPDATE SET
      ebay_item_id = EXCLUDED.ebay_item_id,
      ebay_title = COALESCE(EXCLUDED.ebay_title, platform_listings.ebay_title),
      published_on_ebay = TRUE,
      updated_at = NOW()
  `;
}

export async function markVintedPublished(input: {
  workspaceKey: string;
  sku: string;
  vintedTitle?: string | null;
  vintedListingUrl?: string | null;
  vintedListingId?: string | null;
  prepared?: VintedPrepared | null;
}): Promise<boolean> {
  const sql = getSql();
  await ensureInventoryTables();
  const preparedJson = input.prepared ? JSON.stringify(input.prepared) : null;
  const rows = preparedJson
    ? await sql`
        UPDATE platform_listings
        SET
          vinted_status = 'published',
          published_on_vinted = TRUE,
          vinted_title = COALESCE(${input.vintedTitle || null}, vinted_title),
          vinted_listing_url = COALESCE(${input.vintedListingUrl || null}, vinted_listing_url),
          vinted_listing_id = COALESCE(${input.vintedListingId || null}, vinted_listing_id),
          prepared = ${preparedJson}::jsonb,
          updated_at = NOW()
        WHERE workspace_key = ${input.workspaceKey}
          AND sku = ${input.sku}
        RETURNING id
      `
    : await sql`
        UPDATE platform_listings
        SET
          vinted_status = 'published',
          published_on_vinted = TRUE,
          vinted_title = COALESCE(${input.vintedTitle || null}, vinted_title),
          vinted_listing_url = COALESCE(${input.vintedListingUrl || null}, vinted_listing_url),
          vinted_listing_id = COALESCE(${input.vintedListingId || null}, vinted_listing_id),
          updated_at = NOW()
        WHERE workspace_key = ${input.workspaceKey}
          AND sku = ${input.sku}
        RETURNING id
      `;
  return rows.length > 0;
}

export async function saveVintedDraft(input: {
  workspaceKey: string;
  sku: string;
  prepared: VintedPrepared;
}): Promise<boolean> {
  const sql = getSql();
  await ensureInventoryTables();
  const preparedJson = JSON.stringify(input.prepared);
  const rows = await sql`
    UPDATE platform_listings
    SET
      vinted_title = ${input.prepared.title},
      prepared = ${preparedJson}::jsonb,
      updated_at = NOW()
    WHERE workspace_key = ${input.workspaceKey}
      AND sku = ${input.sku}
      AND vinted_status <> 'published'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function findListingForEbaySale(
  workspaceKey: string,
  sku: string,
  ebayItemId: string
): Promise<ListingLookup> {
  const sql = getSql();
  await ensureInventoryTables();
  const cleanSku = sku.trim();
  const cleanItemId = ebayItemId.trim();

  if (cleanSku) {
    const rows = await sql`
      SELECT *
      FROM platform_listings
      WHERE workspace_key = ${workspaceKey}
        AND sku = ${cleanSku}
      LIMIT 1
    `;
    if (rows.length > 0) return { kind: "one", row: mapListing(rows[0] as Record<string, unknown>) };
  }

  if (cleanItemId) {
    const rows = await sql`
      SELECT *
      FROM platform_listings
      WHERE workspace_key = ${workspaceKey}
        AND ebay_item_id = ${cleanItemId}
    `;
    if (rows.length === 1) return { kind: "one", row: mapListing(rows[0] as Record<string, unknown>) };
    if (rows.length > 1) return { kind: "ambiguous" };
  }

  if (cleanSku) {
    const rows = await sql`
      SELECT *
      FROM platform_listings
      WHERE sku = ${cleanSku}
    `;
    if (rows.length === 1) return { kind: "one", row: mapListing(rows[0] as Record<string, unknown>) };
    if (rows.length > 1) return { kind: "ambiguous" };
  }

  return { kind: "none" };
}
