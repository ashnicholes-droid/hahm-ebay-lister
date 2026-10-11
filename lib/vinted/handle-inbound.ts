import type { InboundEmail } from "@/lib/vinted/email";
import { classifyVintedEmail } from "@/lib/vinted/email";
import { listPublishedVinted } from "@/lib/inventory/links";
import { claimSaleEvent, finishSaleEvent } from "@/lib/inventory/sale-events";
import { matchSoldTitle, type TitleMatch } from "@/lib/vinted/match";
import { isNewTelegramSale } from "@/lib/telegram/ebay-sale";
import { deliverConfirmedSale, type TelegramDelivery } from "@/lib/telegram/notices";
import { sendPlatformSaleAlert } from "@/lib/whatsapp/send";

function reviewDetail(title: string, match: TitleMatch): string {
  if (!title) return "Sale email had no item title";
  if (match.kind === "ambiguous") return `Ambiguous SKUs: ${match.skus.join(", ")}`;
  return "No published Vinted listing matched this title";
}

export async function handleVintedSaleEmail(
  email: InboundEmail,
  options?: { dryRun?: boolean }
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const dryRun = options?.dryRun === true;
  const classification = classifyVintedEmail(email);
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

  const published = await listPublishedVinted();
  const match = classification.title
    ? matchSoldTitle(
        classification.title,
        published.map((row) => ({
          sku: row.sku,
          vintedTitle: row.vintedTitle ?? "",
          ebayTitle: row.ebayTitle ?? "",
        }))
      )
    : ({ kind: "none" } as const);

  if (!classification.title || match.kind !== "unique") {
    const detail = reviewDetail(classification.title, match);
    if (dryRun) {
      return { httpStatus: 200, body: { ok: true, dryRun: true, status: "needs_review", detail } };
    }
    await claimSaleEvent({
      platform: "vinted",
      externalEventId: email.messageId,
      sku: null,
      title: classification.title || null,
      workspaceKey: null,
      detail,
      initialStatus: "needs_review",
    });
    return {
      httpStatus: 200,
      body: { ok: true, status: "needs_review" },
    };
  }

  if (dryRun) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        dryRun: true,
        status: "would_send",
        sku: match.sku,
        title: match.title,
        telegram: "not_sent",
      },
    };
  }

  const claim = await claimSaleEvent({
    platform: "vinted",
    externalEventId: email.messageId,
    sku: match.sku,
    title: match.title,
    workspaceKey: null,
    detail: null,
    initialStatus: "pending",
  });

  let telegram: TelegramDelivery = "missing";
  try {
    telegram = await deliverConfirmedSale({
      platform: "vinted",
      externalEventId: email.messageId,
      sku: match.sku,
      title: match.title,
    });
  } catch (error) {
    console.error("[vinted/inbound] Telegram failed", email.messageId, error);
    telegram = "failed";
  }

  if (claim.action === "done") {
    if (telegram === "failed") {
      return { httpStatus: 500, body: { ok: false, error: "Telegram send failed", duplicate: true } };
    }
    return { httpStatus: 200, body: { ok: true, duplicate: true, telegram } };
  }

  let whatsapp: "sent" | "failed" = "sent";
  try {
    await sendPlatformSaleAlert("vinted", match.sku, match.title);
    await finishSaleEvent(claim.id, {
      status: "sent",
      whatsappSent: true,
      sku: match.sku,
      title: match.title,
    });
  } catch (error) {
    whatsapp = "failed";
    console.error("[vinted/inbound] WhatsApp failed", email.messageId, error);
    const telegramOk = telegram === "sent" || telegram === "duplicate";
    await finishSaleEvent(claim.id, {
      status: telegramOk ? "sent" : "failed",
      whatsappSent: false,
      detail: "WhatsApp send failed",
      sku: match.sku,
      title: match.title,
    });
    if (!telegramOk) {
      return { httpStatus: 500, body: { ok: false, error: "WhatsApp send failed" } };
    }
  }

  if (telegram === "failed") {
    return { httpStatus: 500, body: { ok: false, error: "Telegram send failed", sku: match.sku } };
  }
  return {
    httpStatus: 200,
    body: { ok: true, status: "sent", sku: match.sku, telegram, ...(whatsapp === "failed" ? { whatsapp: "failed" } : {}) },
  };
}
