import crypto from "crypto";
import { ensureInventoryTables, getSql } from "@/lib/db";
import type { SalePlatform } from "@/lib/telegram/message";
import { sendTelegramSale } from "@/lib/telegram/send";

export type TelegramDelivery = "sent" | "duplicate" | "failed" | "missing";

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "Telegram send failed";
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[redacted]").slice(0, 300);
}

async function claimTelegramNotice(input: {
  platform: SalePlatform;
  externalEventId: string;
  sku: string;
  title: string;
}): Promise<{ action: "owned" | "done"; id: string }> {
  const sql = getSql();
  await ensureInventoryTables();
  const id = crypto.randomUUID();
  const inserted = await sql`
    INSERT INTO telegram_sale_notices (
      id, platform, external_event_id, sku, title, status, created_at, updated_at
    )
    VALUES (
      ${id},
      ${input.platform},
      ${input.externalEventId},
      ${input.sku},
      ${input.title},
      'pending',
      NOW(),
      NOW()
    )
    ON CONFLICT (platform, external_event_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length > 0) {
    return { action: "owned", id: String(inserted[0].id) };
  }

  const claimed = await sql`
    UPDATE telegram_sale_notices
    SET
      status = 'pending',
      updated_at = NOW(),
      sku = ${input.sku},
      title = ${input.title}
    WHERE platform = ${input.platform}
      AND external_event_id = ${input.externalEventId}
      AND sent_at IS NULL
      AND (
        status = 'failed'
        OR (status = 'pending' AND updated_at < NOW() - INTERVAL '3 minutes')
      )
    RETURNING id
  `;
  if (claimed.length > 0) {
    return { action: "owned", id: String(claimed[0].id) };
  }
  return { action: "done", id: "" };
}

async function finishTelegramNotice(
  id: string,
  input: { status: "sent" | "failed"; detail?: string | null }
): Promise<void> {
  const sql = getSql();
  await ensureInventoryTables();
  if (input.status === "sent") {
    await sql`
      UPDATE telegram_sale_notices
      SET status = 'sent', detail = ${input.detail ?? null}, sent_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
    return;
  }
  await sql`
    UPDATE telegram_sale_notices
    SET status = 'failed', detail = ${input.detail ?? null}, updated_at = NOW()
    WHERE id = ${id}
      AND sent_at IS NULL
  `;
}

async function skuAlreadyAnnounced(sku: string): Promise<boolean> {
  if (!sku) return false;
  const sql = getSql();
  await ensureInventoryTables();
  const rows = await sql`
    SELECT id
    FROM telegram_sale_notices
    WHERE sku = ${sku}
      AND sent_at IS NOT NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

// Remember an old or repeated sale so later cron runs do not send it.
export async function suppressTelegramSale(input: {
  platform: SalePlatform;
  externalEventId: string;
  sku: string;
  title: string;
}): Promise<void> {
  const sku = input.sku.trim();
  const title = input.title.trim();
  const externalEventId = input.externalEventId.trim();
  if (!sku || !title || !externalEventId) return;
  const sql = getSql();
  await ensureInventoryTables();
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO telegram_sale_notices (
      id, platform, external_event_id, sku, title, status, detail, sent_at, created_at, updated_at
    )
    VALUES (
      ${id},
      ${input.platform},
      ${externalEventId},
      ${sku},
      ${title},
      'suppressed',
      'Older than the Telegram notification cutoff',
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (platform, external_event_id) DO UPDATE
    SET
      status = CASE
        WHEN telegram_sale_notices.status = 'sent' THEN telegram_sale_notices.status
        ELSE 'suppressed'
      END,
      sent_at = COALESCE(telegram_sale_notices.sent_at, NOW()),
      updated_at = NOW()
  `;
}

export async function deliverConfirmedSale(input: {
  platform: SalePlatform;
  externalEventId: string;
  sku: string;
  title: string;
}): Promise<TelegramDelivery> {
  const sku = input.sku.trim();
  const title = input.title.trim();
  const externalEventId = input.externalEventId.trim();
  if (!title || !externalEventId) return "missing";
  if (await skuAlreadyAnnounced(sku)) {
    await suppressTelegramSale({ platform: input.platform, externalEventId, sku, title });
    return "duplicate";
  }

  const claim = await claimTelegramNotice({
    platform: input.platform,
    externalEventId,
    sku,
    title,
  });
  if (claim.action === "done") return "duplicate";

  try {
    await sendTelegramSale(input.platform, sku, title);
    await finishTelegramNotice(claim.id, { status: "sent" });
    return "sent";
  } catch (error) {
    await finishTelegramNotice(claim.id, { status: "failed", detail: safeDetail(error) });
    return "failed";
  }
}
