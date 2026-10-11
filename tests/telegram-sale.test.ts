import { describe, expect, test } from "vitest";
import { ebaySaleNotice, isConfirmedEbaySale, isNewTelegramSale } from "@/lib/telegram/ebay-sale";
import { connectionTestMessage, enlargeSkuDigits, saleTelegramMessage } from "@/lib/telegram/message";

const SAMPLE_TITLE = "Levi’s 550 Men’s Relaxed Fit Jeans";

describe("telegram connection test", () => {
  test("uses the fixed connection text and does not include a sale claim", () => {
    const message = connectionTestMessage();
    expect(message).toBe(
      [
        "✅ CONEXIÓN EXITOSA",
        "🔔 My eBay Vinted Sales",
        "📦 SKU: 2830",
        "🛍️ Plataforma: eBay",
        "🟢 Notificaciones de ventas funcionando correctamente.",
      ].join("\n")
    );
    expect(message).not.toContain("VENTA CONFIRMADA");
  });
});

describe("telegram sale message", () => {
  test("renders the sale layout with the platform, one large bold SKU, and the Vinted reminder", () => {
    const message = saleTelegramMessage("ebay", "2830", SAMPLE_TITLE);
    expect(message).toContain("🟢 📦 <b>¡ARTÍCULO VENDIDO!</b>");
    expect(message).toContain("🛍️ Plataforma: <b>EBAY</b>");
    expect(message).toContain(`👕 Artículo: ${SAMPLE_TITLE}`);
    expect(message).toContain(`🔢 SKU: <b>${enlargeSkuDigits("2830")}</b>`);
    expect(message).not.toContain("\n2830");
    expect(message.match(/𝟮𝟴𝟯𝟬/g)).toHaveLength(1);
    expect(message).toContain("⚠️ <b>REVISAR VINTED</b>");
    expect(message).toContain("🔍 Si sigue publicado, retirarlo manualmente.");
    expect(message).not.toMatch(/\$|price|buyer|comprador/i);
  });

  test("names Vinted, Poshmark, and Depop, and does not invent a missing SKU", () => {
    expect(saleTelegramMessage("vinted", "2830", SAMPLE_TITLE)).toContain("🛍️ Plataforma: <b>VINTED</b>");
    expect(saleTelegramMessage("poshmark", "2830", SAMPLE_TITLE)).toContain("🛍️ Plataforma: <b>POSHMARK</b>");
    expect(saleTelegramMessage("depop", "", SAMPLE_TITLE)).toContain("🔢 SKU: <b>No encontrado</b>");
    expect(saleTelegramMessage("depop", "", SAMPLE_TITLE)).not.toContain("2830");
  });

  test("keeps the full title and escapes HTML", () => {
    const title = `Levi's & Co <550> "Relaxed" Fit Jeans Extra Long Name`;
    const message = saleTelegramMessage("ebay", "2830", title);
    expect(message).toContain("Levi's &amp; Co &lt;550&gt; \"Relaxed\" Fit Jeans Extra Long Name");
    expect(message).not.toContain("<550>");
  });

  test("shows a mixed SKU once, with large digits and the other characters", () => {
    expect(enlargeSkuDigits("2830")).toBe("𝟮𝟴𝟯𝟬");
    expect(enlargeSkuDigits("28-30")).toBe("𝟮𝟴-𝟯𝟬");
    const message = saleTelegramMessage("ebay", "28-30", SAMPLE_TITLE);
    expect(message).toContain("<b>𝟮𝟴-𝟯𝟬</b>");
    expect(message.match(/𝟮𝟴-𝟯𝟬/g)).toHaveLength(1);
    expect(message).not.toContain("28-30");
  });

  test("does not repeat a SKU that has no digits", () => {
    const message = saleTelegramMessage("ebay", "BIN-A", SAMPLE_TITLE);
    expect(message).toContain("<b>BIN-A</b>");
    expect(message.match(/BIN-A/g)).toHaveLength(1);
  });
});

describe("confirmed eBay sale selection", () => {
  const paid = {
    cancelled: false,
    paymentStatus: "PAID",
    sku: "2830",
    title: "Order title",
  };

  test("accepts paid and unknown payment status, and rejects cancelled or unpaid orders", () => {
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "PAID" })).toBe(true);
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "" })).toBe(true);
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "PARTIALLY_REFUNDED" })).toBe(true);
    expect(isConfirmedEbaySale({ cancelled: true, paymentStatus: "PAID" })).toBe(false);
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "PENDING" })).toBe(false);
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "FAILED" })).toBe(false);
    expect(isConfirmedEbaySale({ cancelled: false, paymentStatus: "FULLY_REFUNDED" })).toBe(false);
  });

  test("prefers the inventory SKU and eBay title", () => {
    expect(
      ebaySaleNotice(paid, {
        kind: "one",
        row: { sku: "2830", ebayTitle: SAMPLE_TITLE, vintedTitle: "Shorter Vinted title" },
      })
    ).toEqual({ sku: "2830", title: SAMPLE_TITLE });
  });

  test("uses the order line when the sale is not linked in inventory", () => {
    expect(ebaySaleNotice(paid, { kind: "none" })).toEqual({
      sku: "2830",
      title: "Order title",
    });
  });

  test("does not guess a SKU when several inventory rows match", () => {
    expect(ebaySaleNotice(paid, { kind: "ambiguous" })).toEqual({
      sku: "",
      title: "Order title",
    });
  });

  test("does not notify a sale created before the Telegram cutoff", () => {
    expect(isNewTelegramSale("2026-10-10T19:39:00.000Z")).toBe(true);
    expect(isNewTelegramSale("2026-10-11T15:00:00.000Z")).toBe(true);
    expect(isNewTelegramSale("2026-10-09T12:00:00.000Z")).toBe(false);
    expect(isNewTelegramSale("")).toBe(false);
  });

  test("does not notify a cancelled order", () => {
    expect(
      ebaySaleNotice({ ...paid, cancelled: true }, { kind: "none" })
    ).toBeNull();
  });
});
