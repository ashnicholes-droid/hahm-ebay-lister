export type SalePlatform = "ebay" | "vinted" | "poshmark" | "depop";

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";
const SANS_BOLD_ZERO = 0x1d7ec;

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function displayTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

// Mathematical sans-serif bold digits read larger on phone fonts.
// Characters that are not digits stay unchanged.
export function enlargeSkuDigits(sku: string): string {
  return Array.from(sku)
    .map((char) => {
      const digit = char.charCodeAt(0) - 48;
      if (char.length === 1 && digit >= 0 && digit <= 9) {
        return String.fromCodePoint(SANS_BOLD_ZERO + digit);
      }
      return char;
    })
    .join("");
}

export function endedListingMessage(sku: string, title: string): string {
  const item = escapeTelegramHtml(displayTitle(title));
  return [
    "🛑 <b>ARTÍCULO RETIRADO DE EBAY</b>",
    "",
    SEPARATOR,
    "",
    "🏷️ <b>ARTÍCULO</b>",
    item,
    "",
    SEPARATOR,
    "",
    "📦 <b>NÚMERO DE SKU</b>",
    skuBlock(sku),
    "",
    SEPARATOR,
  ].join("\n");
}

export function connectionTestMessage(): string {
  return [
    "✅ CONEXIÓN EXITOSA",
    "🔔 My eBay Vinted Sales",
    "📦 SKU: 2830",
    "🛍️ Plataforma: eBay",
    "🟢 Notificaciones de ventas funcionando correctamente.",
  ].join("\n");
}

export function platformLabel(platform: SalePlatform): string {
  if (platform === "vinted") return "VINTED";
  if (platform === "poshmark") return "POSHMARK";
  if (platform === "depop") return "DEPOP";
  return "EBAY";
}

function skuBlock(sku: string): string {
  const exact = sku.trim();
  if (!exact) return "<b>No encontrado</b>";
  return `<b>${escapeTelegramHtml(enlargeSkuDigits(exact))}</b>`;
}

function vintedSaleMessage(sku: string, title: string): string {
  const item = escapeTelegramHtml(displayTitle(title));
  const exact = sku.trim();
  if (!exact) {
    return [
      "🟢 📦 <b>¡ARTÍCULO VENDIDO!</b>",
      "🛍️ Plataforma: <b>VINTED</b>",
      `👕 Artículo: ${item}`,
      "🔢 SKU: <b>NO ENCONTRADO</b>",
      "⚠️ <b>REVISAR VINTED MANUALMENTE</b>",
    ].join("\n");
  }
  return [
    "🟢 📦 <b>¡ARTÍCULO VENDIDO!</b>",
    "🛍️ Plataforma: <b>VINTED</b>",
    `👕 Artículo: ${item}`,
    `🔢 SKU: <b>${escapeTelegramHtml(enlargeSkuDigits(exact))}</b>`,
    "⚠️ <b>REVISAR VINTED</b>",
    "🔍 Si sigue publicado en otra plataforma, retirarlo manualmente.",
  ].join("\n");
}

export function saleTelegramMessage(platform: SalePlatform, sku: string, title: string): string {
  if (platform === "vinted") return vintedSaleMessage(sku, title);
  const item = escapeTelegramHtml(displayTitle(title));
  return [
    "🟢 📦 <b>¡ARTÍCULO VENDIDO!</b>",
    `🛍️ Plataforma: <b>${platformLabel(platform)}</b>`,
    `👕 Artículo: ${item}`,
    `🔢 SKU: ${skuBlock(sku)}`,
    "⚠️ <b>REVISAR VINTED</b>",
    "🔍 Si sigue publicado, retirarlo manualmente.",
  ].join("\n");
}
