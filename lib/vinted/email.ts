export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  /** When the mailbox received the message. Missing or old dates are not announced. */
  date?: string;
}

export type EmailClassification =
  | { kind: "sale"; title: string }
  | { kind: "ignore"; reason: string };

const SALE_PATTERNS = [
  /you sold an item/i,
  /you sold your item/i,
  /your item has been sold/i,
  /your item was sold/i,
  /has vendido un art[ií]culo/i,
  /vendiste un art[ií]culo/i,
  /tu art[ií]culo se ha vendido/i,
];

const SKIP_LINE =
  /^(you sold|you made a sale|your item(?: just)? sold|ka-ching|you(?:'ve| have) sold|sold!|has vendido|vendiste|tu art[ií]culo se ha vendido|good news|buenas noticias|congratulations|enhorabuena|hi\b|hello\b|hola\b|hey\b|please ship|por favor|the buyer|el comprador|view\b|ver\b|http|www\.|dear\b)/i;

/** Plain text plus the HTML alternative, so a SKU line in either part can be read. */
export function textForSale(email: InboundEmail): string {
  const plain = email.text.trim();
  const fromHtml = email.html.trim() ? htmlToText(email.html) : "";
  if (!plain) return fromHtml;
  if (!fromHtml || plain.includes(fromHtml) || fromHtml.includes(plain)) {
    return plain.length >= fromHtml.length ? plain : fromHtml;
  }
  return `${plain}\n${fromHtml}`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractSoldTitle(subject: string, text: string, patterns: RegExp[] = SALE_PATTERNS): string {
  const quoted =
    text.match(/sold\s+[“"]([^”"]{4,180})[”"]/i) ||
    text.match(/vendido\s+[“"]([^”"]{4,180})[”"]/i) ||
    subject.match(/[“"]([^”"]{4,180})[”"]/);
  if (quoted?.[1]) return cleanLine(quoted[1]).slice(0, 180);

  const lines = text
    .split(/\r?\n/)
    .map((line) => cleanLine(line))
    .filter(Boolean);
  const saleIdx = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
  const start = saleIdx >= 0 ? saleIdx + 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (SKIP_LINE.test(line)) continue;
    if (/^SKU:\s*\S+\s*$/i.test(line)) continue;
    if (line.length < 6) continue;
    if (/^[^0-9\p{L}]+$/u.test(line)) continue;
    return line.slice(0, 180);
  }
  return "";
}

// A forwarded Gmail copy often has the seller's address as From. Sale vs
// everything else is decided from subject + body, and the message must
// actually mention Vinted.
export function classifyVintedEmail(email: InboundEmail): EmailClassification {
  const text = email.text.trim() || htmlToText(email.html || "");
  const haystack = `${email.subject}\n${text}`;
  if (!/vinted/i.test(haystack)) {
    return { kind: "ignore", reason: "not a Vinted email" };
  }
  if (!SALE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "ignore", reason: "not a sale" };
  }
  return { kind: "sale", title: extractSoldTitle(email.subject, text) };
}
