import { describe, expect, test } from "vitest";
import { classifyMailboxEmail } from "@/lib/mailbox/sale-email";

const NEW_DATE = "2026-10-11T15:00:00.000Z";

describe("marketplace sale emails", () => {
  test("recognizes a Poshmark sale and ignores an offer", () => {
    expect(
      classifyMailboxEmail({
        from: "support@poshmark.com",
        subject: "You made a sale!",
        text: "You made a sale!\n\nNavy Wool Coat\n",
        html: "",
        messageId: "p1",
        date: NEW_DATE,
      })
    ).toEqual({ kind: "sale", platform: "poshmark", title: "Navy Wool Coat" });

    expect(
      classifyMailboxEmail({
        from: "support@poshmark.com",
        subject: "You received an offer",
        text: "Someone made an offer on your listing.",
        html: "",
        messageId: "p2",
        date: NEW_DATE,
      }).kind
    ).toBe("ignore");
  });

  test("recognizes a Depop sale and ignores a like", () => {
    expect(
      classifyMailboxEmail({
        from: "no-reply@depop.com",
        subject: "You've sold an item",
        text: "You've sold an item\n\nBlue Denim Jacket\n",
        html: "",
        messageId: "d1",
        date: NEW_DATE,
      })
    ).toEqual({ kind: "sale", platform: "depop", title: "Blue Denim Jacket" });

    expect(
      classifyMailboxEmail({
        from: "no-reply@depop.com",
        subject: "Someone liked your item",
        text: "Your listing is getting attention on Depop.",
        html: "",
        messageId: "d2",
        date: NEW_DATE,
      }).kind
    ).toBe("ignore");
  });

  test("does not treat a Vinted shipping email as a sale", () => {
    expect(
      classifyMailboxEmail({
        from: "no-reply@vinted.com",
        subject: "Your item has been shipped",
        text: "Track your parcel on Vinted.",
        html: "",
        messageId: "v1",
        date: NEW_DATE,
      }).kind
    ).toBe("ignore");
  });
});
