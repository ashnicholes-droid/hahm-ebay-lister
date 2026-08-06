import { describe, expect, it } from "vitest";
import { extractSku, isDelimiterPayload } from "@/lib/qr";
import { groupByQrDelimiters, type ScannedPhoto } from "@/lib/qrGrouping";

describe("extractSku", () => {
  it("reads a bare inventory code", () => {
    expect(extractSku("K75-A")).toBe("K75-A");
    expect(extractSku("  K75-A  ")).toBe("K75-A");
  });

  it("reads a code out of a URL query parameter", () => {
    expect(extractSku("https://bins.example/scan?sku=K75-A")).toBe("K75-A");
    expect(extractSku("https://bins.example/scan?inventory=K75-B&x=1")).toBe("K75-B");
  });

  it("falls back to a URL's last path segment", () => {
    expect(extractSku("https://bins.example/item/K75-C")).toBe("K75-C");
  });

  it("reads a code out of a small JSON payload", () => {
    expect(extractSku('{"sku":"K75-D","bin":"K75"}')).toBe("K75-D");
    expect(extractSku('{"id":42}')).toBe("42");
  });

  it("sanitises hostile payloads down to a safe SKU", () => {
    // Characters eBay rejects, and anything that could be read as markup, are
    // stripped by sanitizeSku rather than reaching the listing.
    expect(extractSku("<script>alert(1)</script>")).toBe("script-alert-1-script");
    // Dots survive (they're legal in an eBay SKU) but the separators that make
    // a traversal are gone, so the result is inert text.
    expect(extractSku("K75/../../etc/passwd")).toBe("K75-..-..-etc-passwd");
    expect(extractSku("K75 A B")).toBe("K75-A-B");
  });

  it("rejects payloads with nothing usable in them", () => {
    expect(extractSku("")).toBe("");
    expect(extractSku(null)).toBe("");
    expect(extractSku("###")).toBe("");
    // 4 KB of junk is a QR code, but it is not an inventory number.
    expect(extractSku("A".repeat(4000))).toBe("");
  });

  it("caps the SKU at eBay's length limit", () => {
    expect(extractSku("K".repeat(200)).length).toBe(50);
  });

  it("isDelimiterPayload agrees with extractSku", () => {
    expect(isDelimiterPayload("K75-A")).toBe(true);
    expect(isDelimiterPayload("###")).toBe(false);
  });
});

// Helpers to write photo streams compactly: "a" = photo, "#K75-A" = QR label.
const stream = (...spec: string[]): ScannedPhoto[] =>
  spec.map((s, i) =>
    s.startsWith("#") ? { id: `p${i}`, sku: s.slice(1) } : { id: `p${i}` }
  );

describe("groupByQrDelimiters", () => {
  it("splits the stream at labels, attaching each label's SKU to the photos before it", () => {
    const { items, warnings } = groupByQrDelimiters(
      stream("a", "b", "c", "#K75-A", "d", "e", "#K75-B")
    );
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sku: "K75-A", photoIds: ["p0", "p1", "p2"] });
    expect(items[1]).toMatchObject({ sku: "K75-B", photoIds: ["p4", "p5"] });
  });

  it("keeps capture order — photoIds[0] is the eBay cover image", () => {
    const { items } = groupByQrDelimiters(stream("a", "b", "c", "#K1"));
    expect(items[0].photoIds).toEqual(["p0", "p1", "p2"]);
  });

  it("leaves the label photo out of the listing but keeps it attached to its item", () => {
    const { items, orphanIds } = groupByQrDelimiters(stream("a", "#K1"));
    expect(items[0].photoIds).toEqual(["p0"]);
    expect(items[0].markerPhotoId).toBe("p1");
    // Emphatically NOT an orphan: this photo decided the grouping, so filing it
    // under "didn't clearly belong to one item" is exactly wrong.
    expect(orphanIds).toEqual([]);
  });

  it("never orphans a label photo, however many items there are", () => {
    const { items, orphanIds } = groupByQrDelimiters(
      stream("a", "b", "#K1", "c", "#K2", "d", "e", "#K3")
    );
    expect(items.map((i) => i.markerPhotoId)).toEqual(["p2", "p4", "p7"]);
    expect(orphanIds).toEqual([]);
  });

  it("can include the label photo when the seller wants the tag visible", () => {
    const { items, orphanIds } = groupByQrDelimiters(stream("a", "#K1"), {
      includeMarkerPhoto: true,
    });
    expect(items[0].photoIds).toEqual(["p0", "p1"]);
    expect(orphanIds).toEqual([]);
  });

  it("supports labelling before the item instead of after", () => {
    const { items, warnings } = groupByQrDelimiters(
      stream("#K75-A", "a", "b", "#K75-B", "c"),
      { markerPosition: "before" }
    );
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sku: "K75-A", photoIds: ["p1", "p2"] });
    expect(items[1]).toMatchObject({ sku: "K75-B", photoIds: ["p4"] });
  });

  it("warns instead of silently dropping photos shot after the last label", () => {
    const { items, warnings } = groupByQrDelimiters(stream("a", "#K1", "b", "c"));
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ sku: "", photoIds: ["p2", "p3"] });
    expect(warnings.map((w) => w.code)).toEqual(["unlabelled-tail"]);
    expect(warnings[0].photoIds).toEqual(["p2", "p3"]);
  });

  it("warns about a label with no photos before it rather than making an empty listing", () => {
    const { items, warnings, orphanIds } = groupByQrDelimiters(
      stream("a", "#K1", "#K2", "b", "#K3")
    );
    expect(items.map((i) => i.sku)).toEqual(["K1", "K3"]);
    expect(warnings.map((w) => w.code)).toEqual(["empty-marker"]);
    expect(orphanIds).toContain("p2");
  });

  it("renumbers a duplicate inventory number so eBay does not reject the second listing", () => {
    const { items, warnings } = groupByQrDelimiters(stream("a", "#K1", "b", "#K1"));
    expect(items.map((i) => i.sku)).toEqual(["K1", "K1-2"]);
    expect(warnings.map((w) => w.code)).toEqual(["duplicate-sku"]);
  });

  it("treats duplicates case-insensitively, the way eBay does", () => {
    const { items } = groupByQrDelimiters(stream("a", "#k1", "b", "#K1"));
    expect(items.map((i) => i.sku)).toEqual(["k1", "K1-2"]);
  });

  it("reports a batch with no labels at all instead of inventing one big item", () => {
    const { items, orphanIds, warnings } = groupByQrDelimiters(stream("a", "b", "c"));
    expect(items).toEqual([]);
    expect(orphanIds).toEqual(["p0", "p1", "p2"]);
    expect(warnings.map((w) => w.code)).toEqual(["no-markers"]);
  });

  it("handles an empty batch", () => {
    const { items, orphanIds } = groupByQrDelimiters([]);
    expect(items).toEqual([]);
    expect(orphanIds).toEqual([]);
  });

  it("never loses a photo: every input id is a listing photo, a label, or an orphan", () => {
    const photos = stream("a", "#K1", "b", "c", "#K2", "#K3", "d");
    const { items, orphanIds } = groupByQrDelimiters(photos);
    const accounted = new Set([
      ...items.flatMap((i) => i.photoIds),
      ...items.map((i) => i.markerPhotoId).filter(Boolean),
      ...orphanIds,
    ]);
    expect(accounted.size).toBe(photos.length);
  });

  it("still orphans a label that had nothing to label — there is no item to attach it to", () => {
    const { orphanIds, warnings } = groupByQrDelimiters(stream("#K1", "a", "#K2"));
    expect(orphanIds).toEqual(["p0"]);
    expect(warnings.map((w) => w.code)).toEqual(["empty-marker"]);
  });
});
