import { describe, expect, it, afterEach, vi } from "vitest";
import {
  EBAY_MEDIA_BASE,
  TRADING_UPLOAD_SUNSET,
  imageUrlFromMediaResponse,
  uploadImageViaMedia,
  uploadMode,
} from "@/lib/ebay/media";

// eBay retires UploadSiteHostedPictures on 30 September 2026, and every photo
// of every listing goes through it. The Media API replaces it. The new path is
// written from docs and unproven against a live account, so the thing that
// actually protects posting is the FALLBACK — these tests are mostly about
// making sure a wrong guess degrades instead of breaking.

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.resetModules();
  delete process.env.EBAY_PHOTO_UPLOAD;
});

const PNG = Buffer.from("fake-image-bytes").toString("base64");

describe("uploadMode", () => {
  it("defaults to auto — try the new path, keep the old one as a net", () => {
    expect(uploadMode(undefined)).toBe("auto");
    expect(uploadMode("")).toBe("auto");
    expect(uploadMode("nonsense")).toBe("auto");
  });

  it("can be pinned either way once the new path is proven or suspect", () => {
    expect(uploadMode("media")).toBe("media");
    expect(uploadMode("MEDIA")).toBe("media");
    expect(uploadMode("trading")).toBe("trading");
  });
});

describe("imageUrlFromMediaResponse", () => {
  // The response shape is the detail I could not confirm from eBay's docs, so
  // this accepts the plausible ones rather than betting on one.
  it("reads a URL from the documented field", () => {
    expect(
      imageUrlFromMediaResponse({ imageUrl: "https://i.ebayimg.com/00/s/x.jpg" }).imageUrl
    ).toBe("https://i.ebayimg.com/00/s/x.jpg");
  });

  it("reads it from the shapes eBay might plausibly use instead", () => {
    for (const shape of [
      { image: { imageUrl: "https://i.ebayimg.com/a.jpg" } },
      { imageUrls: ["https://i.ebayimg.com/a.jpg"] },
      { url: "https://i.ebayimg.com/a.jpg" },
    ]) {
      expect(imageUrlFromMediaResponse(shape).imageUrl).toBe("https://i.ebayimg.com/a.jpg");
    }
  });

  it("never mistakes a non-URL for one", () => {
    expect(imageUrlFromMediaResponse({ imageUrl: "not-a-url" }).imageUrl).toBeNull();
    expect(imageUrlFromMediaResponse({}).imageUrl).toBeNull();
    expect(imageUrlFromMediaResponse(null).imageUrl).toBeNull();
  });

  it("takes the image id from the Location header", () => {
    const r = imageUrlFromMediaResponse(
      {},
      "https://apim.ebay.com/commerce/media/v1_beta/image/ABC123"
    );
    expect(r.imageId).toBe("ABC123");
    // The Location URI points at the Media resource, NOT at a picture, so it
    // must never be handed to a listing as an image URL.
    expect(r.imageUrl).toBeNull();
  });

  it("tolerates a trailing slash and an id-less header", () => {
    expect(
      imageUrlFromMediaResponse({}, "https://apim.ebay.com/commerce/media/v1_beta/image/XY/")
        .imageId
    ).toBe("XY");
    expect(
      imageUrlFromMediaResponse({}, "https://apim.ebay.com/commerce/media/v1_beta/image").imageId
    ).toBeNull();
  });
});

describe("uploadImageViaMedia", () => {
  const stub = (
    handler: (url: string, init: RequestInit) => Response
  ): { url: string; method: string }[] => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      return handler(String(url), init);
    }) as typeof fetch;
    return calls;
  };

  const json = (body: unknown, status = 201, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  it("posts multipart to the Media endpoint and returns the URL", async () => {
    const calls = stub(() => json({ imageUrl: "https://i.ebayimg.com/00/s/ok.jpg" }));
    const r = await uploadImageViaMedia("token", PNG, "image/jpeg", "K75-A-1.jpg");
    expect(r.url).toBe("https://i.ebayimg.com/00/s/ok.jpg");
    expect(calls[0].url).toBe(`${EBAY_MEDIA_BASE}/image/create_image_from_file`);
    expect(calls[0].method).toBe("POST");
  });

  it("resolves an id-only 201 with a follow-up read", async () => {
    const calls = stub((url) =>
      url.endsWith("create_image_from_file")
        ? json({}, 201, { location: `${EBAY_MEDIA_BASE}/image/IMG-9` })
        : json({ imageUrl: "https://i.ebayimg.com/00/s/resolved.jpg" }, 200)
    );
    const r = await uploadImageViaMedia("token", PNG, "image/jpeg", "n.jpg");
    expect(r.url).toBe("https://i.ebayimg.com/00/s/resolved.jpg");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${EBAY_MEDIA_BASE}/image/IMG-9`);
  });

  it("returns null and eBay's own words on a rejection, rather than throwing", async () => {
    // Null is the signal the caller uses to fall back, so a failure here must
    // never become an exception that takes the publish down with it.
    stub(() => json({ errors: [{ errorId: 1001, message: "Invalid scope." }] }, 403));
    const r = await uploadImageViaMedia("token", PNG, "image/jpeg", "n.jpg");
    expect(r.url).toBeNull();
    expect(r.debug?.httpStatus).toBe(403);
    expect(r.debug?.body).toMatch(/Invalid scope/);
  });

  it("reports a 201 that carried nothing usable", async () => {
    // The case that would happen if I guessed the response shape wrong: eBay
    // accepted the upload but the app can't find a URL in the reply.
    stub(() => new Response("", { status: 201 }));
    const r = await uploadImageViaMedia("token", PNG, "image/jpeg", "n.jpg");
    expect(r.url).toBeNull();
    expect(r.debug?.httpStatus).toBe(201);
  });

  it("strips a data-url prefix, like the old path did", async () => {
    let sentBytes = -1;
    globalThis.fetch = (async (_u: any, init: any) => {
      const form = init.body as FormData;
      const blob = form.get("image") as Blob;
      sentBytes = blob.size;
      return json({ imageUrl: "https://i.ebayimg.com/a.jpg" });
    }) as typeof fetch;
    await uploadImageViaMedia("token", `data:image/jpeg;base64,${PNG}`, "image/jpeg", "n.jpg");
    expect(sentBytes).toBe(Buffer.from(PNG, "base64").length);
  });
});

describe("the sunset date is stated, not folded away", () => {
  it("names the day the old call stops working", () => {
    expect(TRADING_UPLOAD_SUNSET).toBe("2026-09-30");
  });
});
