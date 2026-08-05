import type Anthropic from "@anthropic-ai/sdk";

export type WireImage = { mediaType: string; data: string };
export type ImageBlock = Anthropic.ImageBlockParam;
type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Anthropic rejects any single image over 5 MB. Browser resizing keeps photos
// far under this, but guard anyway so a stray large image is skipped cleanly.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);

// Strip an optional data-url prefix to get raw base64.
function rawBase64(data: string): string {
  return data.includes(",") ? data.split(",")[1] : data;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Magic bytes for the formats we accept. The `mediaType` field is just a string
// the browser sent us, so it proves nothing — sniff the actual bytes and require
// them to agree. A mismatch means either a broken upload or someone poking at
// the endpoint; either way it's a wasted Anthropic call we can skip for free.
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  // "RIFF" ....(size).... "WEBP"
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

/** True when `data` really is base64 for an image of the claimed `mediaType`. */
export function isWellFormedImage(data: string, mediaType: string): boolean {
  const check = SIGNATURES[mediaType];
  if (!check) return false;
  // 16 base64 chars decode to the 12 bytes every signature above needs.
  const head = data.slice(0, 16);
  if (head.length < 16 || !BASE64_RE.test(head)) return false;
  try {
    return check(new Uint8Array(Buffer.from(head, "base64")));
  } catch {
    return false;
  }
}

export function toImageBlock(img: WireImage | undefined): ImageBlock | null {
  if (!img?.data || !ALLOWED_MEDIA.has(img.mediaType)) return null;
  const data = rawBase64(img.data);
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return null;
  if (!isWellFormedImage(data, img.mediaType)) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: img.mediaType as MediaType, data },
  };
}

// Image block for an already-hosted photo (e.g. eBay Picture Services after
// the batched upload step) — Anthropic fetches the URL itself, so the photo
// never has to ride through our serverless functions again.
export function urlImageBlock(url: string): ImageBlock | null {
  if (!/^https:\/\//i.test(url)) return null;
  return { type: "image", source: { type: "url", url } };
}

// Build "Photo N:" text + image content blocks for a set of images, matching
// _images_to_content() in the Python script.
export function labeledContent(
  images: WireImage[],
  labelStart = 1
): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    const block = toImageBlock(img);
    if (!block) return;
    content.push({ type: "text", text: `Photo ${labelStart + i}:` });
    content.push(block);
  });
  return content;
}
