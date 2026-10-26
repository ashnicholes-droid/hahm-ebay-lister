import { afterEach, expect, it, vi } from "vitest";
import { uploadPhotos } from "@/lib/ebay/publish";

// eBay retired the Trading API's UploadSiteHostedPictures (2026-09-30);
// photos now go through the Media API's createImageFromFile.
const MEDIA = "https://apim.ebay.com/commerce/media/v1_beta/image";
const created = (n: number, withUrl = true) =>
  new Response(
    JSON.stringify(withUrl ? { imageUrl: `https://i.ebayimg.com/${n}.jpg` } : {}),
    { status: 201, headers: { Location: `${MEDIA}/img${n}` } },
  );
const rejected = (status: number, errorId: number, message: string) =>
  new Response(JSON.stringify({ errors: [{ errorId, message }] }), { status });
const img = { mediaType: "image/jpeg", data: "AAAA" };

afterEach(() => vi.unstubAllGlobals());

it("uploads to the Media API with a bearer token and multipart image field", async () => {
  const fetch = vi.fn(async () => created(1));
  vi.stubGlobal("fetch", fetch);
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r).toEqual({ urls: ["https://i.ebayimg.com/1.jpg"], errors: [] });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`${MEDIA}/create_image_from_file`);
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  expect((init.body as FormData).get("image")).toBeInstanceOf(Blob);
});

it("looks the URL up from the Location header when the body has none", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(created(2, false))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ imageUrl: "https://i.ebayimg.com/2.jpg" })),
    );
  vi.stubGlobal("fetch", fetch);
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r.urls).toEqual(["https://i.ebayimg.com/2.jpg"]);
  expect(fetch.mock.calls[1][0]).toBe(`${MEDIA}/img2`);
});

it("returns eBay's error id and message when a photo is rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      rejected(400, 190203, "The supplied image is in a format that is not supported."),
    ),
  );
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r.urls).toEqual([]);
  expect(r.errors).toEqual([
    "eBay error 190203: The supplied image is in a format that is not supported.",
  ]);
});

it("retries a failed photo once before giving up", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(rejected(500, 190000, "Internal error."))
    .mockResolvedValueOnce(created(3));
  vi.stubGlobal("fetch", fetch);
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r).toEqual({ urls: ["https://i.ebayimg.com/3.jpg"], errors: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps photo order and reports HTTP failures without an error body", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(created(1))
      .mockImplementation(async () => new Response("Bad gateway", { status: 502 })),
  );
  const r = await uploadPhotos("tok", [img, img], "SKU-1");
  expect(r.urls).toEqual(["https://i.ebayimg.com/1.jpg"]);
  expect(r.errors).toEqual(["eBay returned HTTP 502."]);
});
