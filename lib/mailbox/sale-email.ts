import { classifyVintedEmail, extractSoldTitle, htmlToText, type InboundEmail } from "@/lib/vinted/email";

export type MailboxPlatform = "vinted" | "poshmark" | "depop";

export type MailboxClassification =
  | { kind: "sale"; platform: MailboxPlatform; title: string }
  | { kind: "ignore"; reason: string };

const POSHMARK_SALE = [
  /you (?:just )?made a sale/i,
  /your item (?:just )?sold/i,
  /ka-ching/i,
  /congrats,? you sold/i,
];

const DEPOP_SALE = [
  /you(?:'ve| have) sold/i,
  /your item (?:just )?sold/i,
  /sold! time to ship/i,
];

const NOT_A_SALE = /offer|liked your|price drop|bundle|shipping label|has shipped|refund|question|favorit|mensaje|message from/i;

function haystackOf(email: InboundEmail): string {
  const text = email.text.trim() || htmlToText(email.html || "");
  return `${email.from}\n${email.subject}\n${text}`;
}

function detectPlatform(email: InboundEmail): MailboxPlatform | null {
  const from = email.from || "";
  const haystack = haystackOf(email);
  if (/poshmark\.com/i.test(from)) return "poshmark";
  if (/depop\.com/i.test(from)) return "depop";
  if (/vinted\./i.test(from) || /vinted/i.test(haystack)) return "vinted";
  if (/poshmark/i.test(haystack)) return "poshmark";
  if (/depop/i.test(haystack)) return "depop";
  return null;
}

function classifyNamedSale(
  email: InboundEmail,
  platform: "poshmark" | "depop",
  patterns: RegExp[]
): MailboxClassification {
  const text = email.text.trim() || htmlToText(email.html || "");
  const haystack = `${email.subject}\n${text}`;
  const subjectIsNoise = NOT_A_SALE.test(email.subject) && !patterns.some((pattern) => pattern.test(email.subject));
  if (subjectIsNoise || !patterns.some((pattern) => pattern.test(haystack))) {
    return { kind: "ignore", reason: "not a sale" };
  }
  return { kind: "sale", platform, title: extractSoldTitle(email.subject, text, patterns) };
}

export function classifyMailboxEmail(email: InboundEmail): MailboxClassification {
  const platform = detectPlatform(email);
  if (!platform) return { kind: "ignore", reason: "not a supported marketplace email" };
  if (platform === "vinted") {
    const result = classifyVintedEmail(email);
    if (result.kind === "ignore") return result;
    return { kind: "sale", platform: "vinted", title: result.title };
  }
  if (platform === "poshmark") return classifyNamedSale(email, "poshmark", POSHMARK_SALE);
  return classifyNamedSale(email, "depop", DEPOP_SALE);
}
