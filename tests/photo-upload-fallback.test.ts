import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";

// The behaviour that keeps posting working while the Media API is unproven.
//
// uploadPhotos is what the publish flow calls. Its contract has not changed —
// base64 in, EPS URLs out, failures dropped — and these tests hold it there
// across the switch, because getting this wrong means listings publish with no
// photos and eBay rejects them.

const PNG = Buffer.from("bytes").toString("base64");
const MEDIA = /create_image_from_file/;
const TRADING = /ws\/api\.dll/;

const original = globalThis.fetch;
let warns: string[] = [];
let logs: string[] = [];

beforeEach(() => {
  warns = [];
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => warns.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.EBAY_PHOTO_UPLOAD;
});

/** Routes by URL so each test says only what it cares about. */
function route(handlers: { media?: () => Response; trading?: () => Response }) {
  const hits: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (MEDIA.test(u)) {
      hits.push("media");
      return handlers.media?.() ?? new Response("", { status: 500 });
    }
    if (TRADING.test(u)) {
      hits.push("trading");
      return handlers.trading?.() ?? new Response("", { status: 500 });
    }
    hits.push(`other:${u}`);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return hits;
}

const mediaOk = () =>
  new Response(JSON.stringify({ imageUrl: "https://i.ebayimg.com/00/s/new.jpg" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

const tradingOk = () =>
  new Response(
    `<?xml version="1.0"?><UploadSiteHostedPicturesResponse><Ack>Success</Ack>` +
      `<SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/00/s/old.jpg</FullURL>` +
      `</SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>`,
    { status: 200, headers: { "Content-Type": "text/xml" } }
  );

const load = async () => (await import("@/lib/ebay/publish")).uploadPhotos;

const oneImage = [{ mediaType: "image/jpeg", data: PNG }];

describe("default (auto)", () => {
  it("uses the Media API when it works, and never calls the retired one", async () => {
    const hits = route({ media: mediaOk, trading: tradingOk });
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual(["https://i.ebayimg.com/00/s/new.jpg"]);
    expect(hits).toEqual(["media"]);
  });

  it("falls back to the old call when the Media API rejects the upload", async () => {
    // The whole point of the migration shipping early: a wrong guess about the
    // endpoint costs one wasted request, not a broken publish.
    const hits = route({
      media: () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 404 }),
      trading: tradingOk,
    });
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual(["https://i.ebayimg.com/00/s/old.jpg"]);
    expect(hits).toEqual(["media", "trading"]);
  });

  it("falls back when the Media API accepts but returns nothing usable", async () => {
    const hits = route({
      media: () => new Response("", { status: 201 }),
      trading: tradingOk,
    });
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual(["https://i.ebayimg.com/00/s/old.jpg"]);
    expect(hits).toEqual(["media", "trading"]);
  });

  it("falls back when the Media API throws, rather than losing the photo", async () => {
    globalThis.fetch = (async (url: any) => {
      if (MEDIA.test(String(url))) throw new Error("network down");
      return tradingOk();
    }) as typeof fetch;
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual(["https://i.ebayimg.com/00/s/old.jpg"]);
  });

  it("says which path it took, once, not once per photo", async () => {
    route({ media: mediaOk });
    const images = Array.from({ length: 5 }, () => ({ mediaType: "image/jpeg", data: PNG }));
    await (await load())("token", images, "K75-A");
    expect(logs.filter((l) => l.includes("Media API OK"))).toHaveLength(1);
  });

  it("names the retirement date when it falls back", async () => {
    route({ media: () => new Response("", { status: 500 }), trading: tradingOk });
    await (await load())("token", oneImage, "K75-A");
    expect(warns.join(" ")).toMatch(/2026-09-30/);
  });
});

describe("pinned modes", () => {
  it("EBAY_PHOTO_UPLOAD=trading skips the new path entirely", async () => {
    process.env.EBAY_PHOTO_UPLOAD = "trading";
    const hits = route({ media: mediaOk, trading: tradingOk });
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual(["https://i.ebayimg.com/00/s/old.jpg"]);
    expect(hits).toEqual(["trading"]);
  });

  it("EBAY_PHOTO_UPLOAD=media never silently uses the retired call", async () => {
    // Once the new path is proven, a failure should be visible, not papered
    // over by a call that is about to stop existing.
    process.env.EBAY_PHOTO_UPLOAD = "media";
    const hits = route({ media: () => new Response("", { status: 500 }), trading: tradingOk });
    const urls = await (await load())("token", oneImage, "K75-A");
    expect(urls).toEqual([]);
    expect(hits).toEqual(["media"]);
  });
});

describe("the contract downstream code depends on", () => {
  it("keeps photo order, which decides the eBay gallery image", async () => {
    let n = 0;
    globalThis.fetch = (async (url: any) => {
      if (!MEDIA.test(String(url))) return new Response("", { status: 500 });
      const i = n++;
      // Answer out of order to prove results are placed, not appended.
      await new Promise((r) => setTimeout(r, i === 0 ? 20 : 0));
      return new Response(JSON.stringify({ imageUrl: `https://i.ebayimg.com/${i}.jpg` }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const images = Array.from({ length: 3 }, () => ({ mediaType: "image/jpeg", data: PNG }));
    const urls = await (await load())("token", images, "K75-A");
    expect(urls).toEqual([
      "https://i.ebayimg.com/0.jpg",
      "https://i.ebayimg.com/1.jpg",
      "https://i.ebayimg.com/2.jpg",
    ]);
  });

  it("drops photos that failed everywhere instead of returning holes", async () => {
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    const images = Array.from({ length: 3 }, () => ({ mediaType: "image/jpeg", data: PNG }));
    expect(await (await load())("token", images, "K75-A")).toEqual([]);
  });
});
