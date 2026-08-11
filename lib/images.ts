import OpenAI from "openai";

export type WireImage = {
  mediaType: string;
  data: string;
};

export type ImageBlock = OpenAI.Responses.ResponseInputContent;

type MediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function rawBase64(data: string): string {
  return data.includes(",") ? data.split(",")[1] : data;
}

export function toImageBlock(
  img: WireImage | undefined
): ImageBlock | null {
  if (!img?.data || !ALLOWED_MEDIA.has(img.mediaType)) {
    return null;
  }

  const data = rawBase64(img.data);

  if (data.length * 0.75 > MAX_IMAGE_BYTES) {
    return null;
  }

  return {
    type: "input_image",
    image_url: `data:${img.mediaType as MediaType};base64,${data}`,
    detail: "auto",
  };
}

export function urlImageBlock(
  url: string
): ImageBlock | null {
  if (!/^https:\/\//i.test(url)) {
    return null;
  }

  return {
    type: "input_image",
    image_url: url,
    detail: "auto",
  };
}

export function labeledContent(
  images: WireImage[],
  labelStart = 1
): ImageBlock[] {
  const content: ImageBlock[] = [];

  images.forEach((img, i) => {
    const block = toImageBlock(img);

    if (!block) {
      return;
    }

    content.push({
      type: "input_text",
      text: `Photo ${labelStart + i}:`,
    } as ImageBlock);

    content.push(block);
  });

  return content;
}
