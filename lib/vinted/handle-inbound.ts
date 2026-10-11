import { textForSale, type InboundEmail } from "@/lib/vinted/email";
import { listSaleTitleCandidates } from "@/lib/inventory/links";
import { claimSaleEvent, finishSaleEvent } from "@/lib/inventory/sale-events";
import { classifyMailboxEmail } from "@/lib/mailbox/sale-email";
import { resolveSaleIdentity } from "@/lib/vinted/sale-identity";
import { isNewTelegramSale } from "@/lib/telegram/ebay-sale";
import { saleTelegramMessage } from "@/lib/telegram/message";
import { deliverConfirmedSale, type TelegramDelivery } from "@/lib/telegram/notices";
import { sendPlatformSaleAlert } from "@/lib/whatsapp/send";

export async function handleVintedSaleEmail(
  email: InboundEmail,
  options?: { dryRun?: boolean }
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const dryRun = options?.dryRun === true;
  const text = textForSale(email);
  const classification = classifyMailboxEmail({ ...email, text, html: "" });
  if (classification.kind === "ignore") {
    return {
      httpStatus: 200,
      body: { ok: true, ignored: true, reason: classification.reason, ...(dryRun ? { dryRun: true } : {}) },
    };
  }
  if (!email.messageId.trim()) {
    return { httpStatus: 400, body: { ok: false, error: "Missing MessageID" } };
  }
  if (!isNewTelegramSale(email.date ?? "")) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        suppressed: true,
        reason: "before activation",
        ...(dryRun ? { dryRun: true } : {}),
      },
    };
  }

  const published = await listSaleTitleCandidates();
  const identity = resolveSaleIdentity(
    classification.title,
    text,
    published.map((row) => ({
      sku: row.sku,
      vintedTitle: row.vintedTitle ?? "",
      ebayTitle: row.ebayTitle ?? "",
    }))
  );
  const sku = identity.sku;
  const title = identity.title;

  if (dryRun) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        dryRun: true,
        status: "would_send",
        platform: classification.platform,
        sku: sku || null,
        title,
        message: saleTelegramMessage(classification.platform, sku, title),
        telegram: "not_sent",
      },
    };
  }

  if (classification.platform !== "vinted" || !sku) {
    const telegram = await notifySale(email.messageId, classification.platform, sku, title);
    if (telegram === "failed") {
      return { httpStatus: 500, body: { ok: false, error: "Telegram send failed", platform: classification.platform } };
    }
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: telegram === "duplicate" ? undefined : "sent",
        duplicate: telegram === "duplicate" ? true : undefined,
        platform: classification.platform,
        sku: sku || null,
        title,
        telegram,
      },
    };
  }

  const claim = await claimSaleEvent({
    platform: "vinted",
    externalEventId: email.messageId,
    sku,
    title,
    workspaceKey: null,
    detail: null,
    initialStatus: "pending",
  });

  const telegram = await notifySale(email.messageId, "vinted", sku, title);
  if (claim.action === "done") {
    if (telegram === "failed") {
      return { httpStatus: 500, body: { ok: false, error: "Telegram send failed", duplicate: true } };
    }
    return { httpStatus: 200, body: { ok: true, duplicate: true, telegram } };
  }

  let whatsapp: "sent" | "failed" = "sent";
  try {
    await sendPlatformSaleAlert("vinted", sku, title);
    await finishSaleEvent(claim.id, {
      status: "sent",
      whatsappSent: true,
      sku,
      title,
    });
  } catch (error) {
    whatsapp = "failed";
    console.error("[vinted/inbound] WhatsApp failed", email.messageId, error);
    const telegramOk = telegram === "sent" || telegram === "duplicate";
    await finishSaleEvent(claim.id, {
      status: telegramOk ? "sent" : "failed",
      whatsappSent: false,
      detail: "WhatsApp send failed",
      sku,
      title,
    });
    if (!telegramOk) {
      return { httpStatus: 500, body: { ok: false, error: "WhatsApp send failed" } };
    }
  }

  if (telegram === "failed") {
    return { httpStatus: 500, body: { ok: false, error: "Telegram send failed", sku } };
  }
  return {
    httpStatus: 200,
    body: { ok: true, status: "sent", sku, telegram, ...(whatsapp === "failed" ? { whatsapp: "failed" } : {}) },
  };
}

async function notifySale(
  messageId: string,
  platform: "ebay" | "vinted" | "poshmark" | "depop",
  sku: string,
  title: string
): Promise<TelegramDelivery> {
  try {
    return await deliverConfirmedSale({
      platform,
      externalEventId: messageId,
      sku,
      title,
    });
  } catch (error) {
    console.error("[mailbox/inbound] Telegram failed", messageId, error);
    return "failed";
  }
}
