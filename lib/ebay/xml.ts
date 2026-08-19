// A deliberately small XML reader for eBay's Trading API responses.
//
// Not a general XML parser, and shouldn't grow into one. The Trading responses
// this app reads are shallow, machine-generated, and have known tag names, so a
// focused extractor is easier to reason about than a dependency — and it can be
// exhaustively tested against the shapes we actually receive.
//
// What it does handle, because eBay really sends all of it:
//   • <Tag>value</Tag> and <Tag/> (empty)
//   • <![CDATA[...]]> around titles, which routinely contain & and <
//   • attributes on the opening tag
//   • repeated sibling blocks (<Item>…</Item> × 200)
//   • the five XML entities
//
// What it deliberately does NOT do: namespaces, nesting-aware queries, or
// anything requiring a real tree. If a future response needs those, reach for a
// parser rather than extending this.

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Escape a value for safe interpolation into a request body. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const tagPattern = (tag: string) =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`, "g");

/** First occurrence of a tag's text content, or "" when absent. */
export function xmlText(xml: string, tag: string): string {
  const re = tagPattern(tag);
  const m = re.exec(xml);
  if (!m) return "";
  return decodeXmlText(m[1] ?? "").trim();
}

/** Every occurrence of a tag's inner content, undecoded — for repeated blocks. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = tagPattern(tag);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? "");
  return out;
}

/** Every occurrence of a tag's text content, decoded. */
export function xmlTextAll(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag).map((b) => decodeXmlText(b).trim());
}

/**
 * A number, or null when the tag is missing or isn't one.
 *
 * Null rather than 0 on purpose: "eBay didn't tell us the watch count" and
 * "nobody is watching" are different facts, and showing the second when you mean
 * the first is how a seller concludes an item is dead.
 */
export function xmlNumber(xml: string, tag: string): number | null {
  const raw = xmlText(xml, tag);
  if (!raw) return null;
  // Strip only the decoration eBay actually adds — currency symbols, thousands
  // separators, whitespace — then require what's left to BE a number. Stripping
  // every non-digit instead turns "lots" into "" and Number("") into 0, which
  // would report a watch count of zero for a value we failed to read.
  const cleaned = raw.replace(/[$£€,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** eBay's Ack plus any error messages, for turning a failure into a sentence. */
export function tradingAck(xml: string): {
  ok: boolean;
  ack: string;
  errors: { code: string; message: string; severity: string }[];
} {
  const ack = xmlText(xml, "Ack") || "Unknown";
  const errors = xmlBlocks(xml, "Errors").map((block) => ({
    code: xmlText(block, "ErrorCode"),
    message:
      xmlText(block, "LongMessage") || xmlText(block, "ShortMessage") || "Unknown error",
    severity: xmlText(block, "SeverityCode") || "Error",
  }));
  // "Warning" is a success with commentary — eBay returns it constantly for
  // things like deprecated fields, and treating it as failure would break the
  // whole view over a notice.
  return { ok: ack === "Success" || ack === "Warning", ack, errors };
}
