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

export function toImageBlock(img: WireImage | undefined): ImageBlock | null {
  if (
    !img ||
    typeof img.data !== "string" ||
    !img.data ||
    !ALLOWED_MEDIA.has(img.mediaType)
  )
    return null;
  const data = rawBase64(img.data);
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return null;
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
  labelStart = 1,
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
