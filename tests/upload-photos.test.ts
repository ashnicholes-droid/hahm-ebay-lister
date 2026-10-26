import { afterEach, expect, it, vi } from "vitest";
import { uploadPhotos } from "@/lib/ebay/publish";

const ok = (n: number) =>
  new Response(
    `<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/${n}.jpg</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>`,
  );
const fail = (code: string, msg: string) =>
  new Response(
    `<UploadSiteHostedPicturesResponse><Ack>Failure</Ack><Errors><ShortMessage>Short.</ShortMessage><LongMessage>${msg}</LongMessage><ErrorCode>${code}</ErrorCode></Errors></UploadSiteHostedPicturesResponse>`,
  );
const img = { mediaType: "image/jpeg", data: "AAAA" };

afterEach(() => vi.unstubAllGlobals());

it("returns eBay's error code and message when a photo is rejected", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => fail("931", "Auth token is invalid.")));
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r.urls).toEqual([]);
  expect(r.errors).toEqual(["eBay error 931: Auth token is invalid."]);
});

it("retries a failed photo once before giving up", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(fail("10007", "Internal error."))
    .mockResolvedValueOnce(ok(1));
  vi.stubGlobal("fetch", fetch);
  const r = await uploadPhotos("tok", [img], "SKU-1");
  expect(r.urls).toEqual(["https://i.ebayimg.com/1.jpg"]);
  expect(r.errors).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps photo order and reports HTTP failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(ok(1))
      .mockImplementation(async () => new Response("Bad gateway", { status: 502 })),
  );
  const r = await uploadPhotos("tok", [img, img], "SKU-1");
  expect(r.urls).toEqual(["https://i.ebayimg.com/1.jpg"]);
  expect(r.errors).toEqual(["eBay returned HTTP 502."]);
});
