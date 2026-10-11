import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/inventory/links", () => ({
  listPublishedVinted: vi.fn(),
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
import { listPublishedVinted } from "@/lib/inventory/links";
import { claimSaleEvent, finishSaleEvent } from "@/lib/inventory/sale-events";
import { deliverConfirmedSale } from "@/lib/telegram/notices";
import { handleVintedSaleEmail } from "@/lib/vinted/handle-inbound";
import { sendPlatformSaleAlert } from "@/lib/whatsapp/send";

const listPublished = vi.mocked(listPublishedVinted);
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
    ] as Awaited<ReturnType<typeof listPublishedVinted>>);
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
      sku: "2830",
      title: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
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
