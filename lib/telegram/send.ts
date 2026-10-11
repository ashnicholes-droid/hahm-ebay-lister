import { saleTelegramMessage, type SalePlatform } from "@/lib/telegram/message";

interface TelegramConfig {
  token: string;
  chatId: string;
}

function configFromEnv(): TelegramConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (!token || !chatId) {
    throw new Error("Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
  }
  return { token, chatId };
}

function safeTelegramError(error: unknown, chatId = ""): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" && error ? error : "request failed";
  let safe = message.replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[redacted]");
  if (chatId) safe = safe.split(chatId).join("[redacted]");
  return safe.slice(0, 300);
}

async function postTelegramMessage(
  text: string,
  parseMode?: "HTML"
): Promise<{ messageId: number }> {
  const cfg = configFromEnv();
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      }),
    });
  } catch (error) {
    throw new Error(`Telegram request failed: ${safeTelegramError(error, cfg.chatId)}`);
  }

  const data = (await resp.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  } | null;
  if (!resp.ok || !data?.ok) {
    const description = typeof data?.description === "string" ? data.description : "";
    throw new Error(
      `Telegram request failed (${resp.status}): ${safeTelegramError(description, cfg.chatId)}`
    );
  }
  return { messageId: Number(data.result?.message_id ?? 0) };
}

export function sendTelegramHtml(text: string): Promise<{ messageId: number }> {
  return postTelegramMessage(text, "HTML");
}

export function sendTelegramPlain(text: string): Promise<{ messageId: number }> {
  return postTelegramMessage(text);
}

export async function sendTelegramSale(
  platform: SalePlatform,
  sku: string,
  title: string
): Promise<{ messageId: number }> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Telegram alert is missing the title.");
  }
  return sendTelegramHtml(saleTelegramMessage(platform, sku.trim(), cleanTitle));
}
