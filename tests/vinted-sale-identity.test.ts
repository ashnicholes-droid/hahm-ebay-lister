import { describe, expect, test } from "vitest";
import { resolveSaleIdentity } from "@/lib/vinted/sale-identity";

const jeans = {
  sku: "2830",
  vintedTitle: "Levi's 550 Jeans Mens 34x29 Blue Relaxed Fit",
  ebayTitle: "Levi's 550 Jeans",
};

describe("vinted sale identity", () => {
  test("uses one SKU line from the listing description", () => {
    expect(
      resolveSaleIdentity("Navy wool coat", "Navy wool coat\nSKU: 2443\n", [jeans])
    ).toEqual({ sku: "2443", title: "Navy wool coat" });
  });

  test("uses the inventory title when the email has a SKU and no item title", () => {
    expect(resolveSaleIdentity("", "You sold an item on Vinted\nSKU: 2830\n", [jeans])).toEqual({
      sku: "2830",
      title: jeans.vintedTitle,
    });
  });

  test("matches a title when the email has no SKU line", () => {
    expect(resolveSaleIdentity(jeans.vintedTitle, jeans.vintedTitle, [jeans])).toEqual({
      sku: "2830",
      title: jeans.vintedTitle,
    });
  });

  test("leaves the SKU empty when the email and the title point at different items", () => {
    expect(resolveSaleIdentity(jeans.vintedTitle, `${jeans.vintedTitle}\nSKU: 9999`, [jeans])).toEqual({
      sku: "",
      title: jeans.vintedTitle,
    });
  });

  test("leaves the SKU empty when the email contains two different SKU lines", () => {
    expect(resolveSaleIdentity("", "SKU: 2443\nSKU: 2830\n", [jeans])).toEqual({
      sku: "",
      title: "No identificado",
    });
  });

  test("still names the sale when nothing identifies the item", () => {
    expect(resolveSaleIdentity("", "You sold an item on Vinted", [])).toEqual({
      sku: "",
      title: "No identificado",
    });
  });
});
