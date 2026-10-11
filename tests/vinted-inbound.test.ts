import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/inventory/links", () => ({
  listSaleTitleCandidates: vi.fn(),
}));
vi.mock("@/lib/inventory/sale-events", () => ({
  claimSaleEvent: vi.fn(),
  finishSaleEvent: vi.fn(),
}));
vi.mock("@/lib/telegram/notices", () => ({
  deliverConfirmedSale: vi.fn(),
}));
vi.mock("@/lib/whatsapp/send", () => ({
  sendPlatformSaleAlert: vi.fn(),
}));

import { POST } from "@/app/api/vinted/inbound/route";
import { listSaleTitleCandidates } from "@/lib/inventory/links";
import { claimSaleEvent, finishSaleEvent } from "@/lib/inventory/sale-events";
import { deliverConfirmedSale } from "@/lib/telegram/notices";
import { handleVintedSaleEmail } from "@/lib/vinted/handle-inbound";
import { saleTelegramMessage } from "@/lib/telegram/message";
import { sendPlatformSaleAlert } from "@/lib/whatsapp/send";

const listPublished = vi.mocked(listSaleTitleCandidates);
const claim = vi.mocked(claimSaleEvent);
const finish = vi.mocked(finishSaleEvent);
const deliver = vi.mocked(deliverConfirmedSale);
const whatsapp = vi.mocked(sendPlatformSaleAlert);

const SALE = {
  from: "me@gmail.com",
  subject: "You sold an item on Vinted",
  text: "You sold an item on Vinted\n\nLevi's 550 Jeans Mens 34x29 Blue Relaxed Fit\n",
  html: "",
  messageId: "gmail-msg-1",
  date: "2026-10-11T15:00:00.000Z",
};

function request(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://hahm-ebay-lister-tau-one.vercel.app/api/vinted/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("vinted inbound", () => {
  const previousSecret = process.env.VINTED_INBOUND_SECRET;
  const previousCutoff = process.env.TELEGRAM_NOTIFY_AFTER;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VINTED_INBOUND_SECRET = "test-inbound-secret";
    delete process.env.TELEGRAM_NOTIFY_AFTER;
    listPublished.mockResolvedValue([
      {
        sku: "2830",
        vintedTitle: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
        ebayTitle: "Levi's 550 Jeans",
      },
    ] as Awaited<ReturnType<typeof listSaleTitleCandidates>>);
    claim.mockResolvedValue({ action: "owned", id: "sale-1" });
    finish.mockResolvedValue();
    deliver.mockResolvedValue("sent");
    whatsapp.mockResolvedValue();
  });

  test("rejects a request when the inbound secret is missing or wrong", async () => {
    delete process.env.VINTED_INBOUND_SECRET;
    const missing = await POST(request({ dryRun: true }) as never);
    expect(missing.status).toBe(503);

    process.env.VINTED_INBOUND_SECRET = "test-inbound-secret";
    const wrong = await POST(request({ dryRun: true }, { authorization: "Bearer wrong-secret" }) as never);
    expect(wrong.status).toBe(401);
    const basic = await POST(request({ dryRun: true }, { authorization: "Basic dXNlcjpwYXNz" }) as never);
    expect(basic.status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  test("dry run reports the matching SKU without sending or recording the sale", async () => {
    const response = await POST(
      request({ ...SALE, dryRun: true }, { "x-cron-secret": "test-inbound-secret" }) as never
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      dryRun: true,
      status: "would_send",
      platform: "vinted",
      sku: "2830",
      title: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
      message: saleTelegramMessage("vinted", "2830", "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit"),
      telegram: "not_sent",
    });
    expect(listPublished).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(whatsapp).not.toHaveBeenCalled();
  });

  test("ignores mail from before activation without reading listings or recording a sale", async () => {
    const result = await handleVintedSaleEmail({ ...SALE, date: "2026-10-09T12:00:00.000Z" });
    expect(result).toEqual({
      httpStatus: 200,
      body: { ok: true, suppressed: true, reason: "before activation" },
    });
    expect(listPublished).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  test("ignores shipping mail and does not record it", async () => {
    const result = await handleVintedSaleEmail({
      ...SALE,
      subject: "Your item has been shipped",
      text: "Track your parcel on Vinted.",
    });
    expect(result.httpStatus).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  test("keeps a successful Telegram notice when WhatsApp fails", async () => {
    whatsapp.mockRejectedValue(new Error("WhatsApp is not configured."));
    const result = await handleVintedSaleEmail(SALE);
    expect(result).toEqual({
      httpStatus: 200,
      body: { ok: true, status: "sent", sku: "2830", telegram: "sent", whatsapp: "failed" },
    });
    expect(deliver).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith("sale-1", {
      status: "sent",
      whatsappSent: false,
      detail: "WhatsApp send failed",
      sku: "2830",
      title: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
    });
  });

  test("dry run of a Poshmark sale does not invent a SKU or record the sale", async () => {
    listPublished.mockResolvedValue([]);
    const result = await handleVintedSaleEmail(
      {
        from: "support@poshmark.com",
        subject: "You made a sale!",
        text: "You made a sale!\n\nNavy Wool Coat\n",
        html: "",
        messageId: "posh-1",
        date: "2026-10-11T15:00:00.000Z",
      },
      { dryRun: true }
    );
    expect(result.body).toEqual({
      ok: true,
      dryRun: true,
      status: "would_send",
      platform: "poshmark",
      sku: null,
      title: "Navy Wool Coat",
      message: saleTelegramMessage("poshmark", "", "Navy Wool Coat"),
      telegram: "not_sent",
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(whatsapp).not.toHaveBeenCalled();
  });

  test("a Vinted sale without a title or SKU still previews a manual notice", async () => {
    const result = await handleVintedSaleEmail(
      {
        ...SALE,
        text: "You sold an item on Vinted",
        messageId: "gmail-no-title",
      },
      { dryRun: true }
    );
    expect(result.body).toEqual({
      ok: true,
      dryRun: true,
      status: "would_send",
      platform: "vinted",
      sku: null,
      title: "No identificado",
      message: saleTelegramMessage("vinted", "", "No identificado"),
      telegram: "not_sent",
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  test("reads SKU: from the email when the title is not in inventory", async () => {
    const result = await handleVintedSaleEmail(
      {
        ...SALE,
        text: "You sold an item on Vinted\n\nNavy wool coat\n\nSKU: 2443\n",
        messageId: "gmail-sku-line",
      },
      { dryRun: true }
    );
    expect(result.body).toEqual({
      ok: true,
      dryRun: true,
      status: "would_send",
      platform: "vinted",
      sku: "2443",
      title: "Navy wool coat",
      message: saleTelegramMessage("vinted", "2443", "Navy wool coat"),
      telegram: "not_sent",
    });
    expect(String(result.body.message)).not.toContain("NO ENCONTRADO");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("reads a SKU that exists only in the html part", async () => {
    const result = await handleVintedSaleEmail(
      {
        ...SALE,
        text: "",
        html: "<p>You sold an item on Vinted</p><p>Navy wool coat</p><p>SKU: 2503</p>",
        messageId: "gmail-html-sku",
      },
      { dryRun: true }
    );
    expect(result.body).toMatchObject({
      status: "would_send",
      sku: "2503",
      title: "Navy wool coat",
      telegram: "not_sent",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("sends the manual Vinted notice when the sale has no SKU", async () => {
    const result = await handleVintedSaleEmail({
      ...SALE,
      text: "You sold an item on Vinted",
      messageId: "gmail-no-sku-live",
    });
    expect(result).toEqual({
      httpStatus: 200,
      body: {
        ok: true,
        status: "sent",
        platform: "vinted",
        sku: null,
        title: "No identificado",
        telegram: "sent",
      },
    });
    expect(deliver).toHaveBeenCalledWith({
      platform: "vinted",
      externalEventId: "gmail-no-sku-live",
      sku: "",
      title: "No identificado",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(whatsapp).not.toHaveBeenCalled();
  });

  test("does not guess when the email SKU and the title match different items", async () => {
    const result = await handleVintedSaleEmail(
      {
        ...SALE,
        text: `${SALE.text}\nSKU: 9999\n`,
        messageId: "gmail-conflict",
      },
      { dryRun: true }
    );
    expect(result.body).toMatchObject({
      sku: null,
      title: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
    });
    expect(String(result.body.message)).toContain("NO ENCONTRADO");
    expect(String(result.body.message)).not.toContain("9999");
    expect(String(result.body.message)).not.toContain("2830");
  });

  test("does not send Telegram again for a sale that was already claimed", async () => {
    claim.mockResolvedValue({ action: "done", id: "" });
    deliver.mockResolvedValue("duplicate");
    const result = await handleVintedSaleEmail(SALE);
    expect(result.httpStatus).toBe(200);
    expect(result.body.duplicate).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(whatsapp).not.toHaveBeenCalled();
  });

  afterAll(() => {
    process.env.VINTED_INBOUND_SECRET = previousSecret;
    if (previousCutoff === undefined) delete process.env.TELEGRAM_NOTIFY_AFTER;
    else process.env.TELEGRAM_NOTIFY_AFTER = previousCutoff;
  });
});
