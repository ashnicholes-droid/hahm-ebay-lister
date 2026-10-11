import { matchSoldTitle, type TitleCandidate } from "@/lib/vinted/match";

export const UNIDENTIFIED_ITEM_TITLE = "No identificado";

const SKU_TOKEN = /SKU:[ \t]*([A-Za-z0-9][A-Za-z0-9-]{2,40})\b/gi;

/** SKU lines written into Vinted descriptions: `SKU: 2830`. Several different values are not a match. */
export function extractDescriptionSkus(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SKU_TOKEN)) {
    const sku = match[1]?.trim() ?? "";
    if (sku && !found.includes(sku)) found.push(sku);
  }
  return found;
}

function titleOf(candidate: TitleCandidate | undefined): string {
  return (candidate?.vintedTitle || candidate?.ebayTitle || "").trim();
}

/**
 * Prefer one `SKU:` token from the email. Otherwise use one exact title match.
 * If those two disagree, leave the SKU empty instead of choosing one.
 */
export function resolveSaleIdentity(
  emailTitle: string,
  body: string,
  candidates: TitleCandidate[]
): { sku: string; title: string } {
  const listed = extractDescriptionSkus(body);
  const emailSku = listed.length === 1 ? listed[0] : "";
  const matched = emailTitle.trim() ? matchSoldTitle(emailTitle, candidates) : { kind: "none" as const };
  const titleSku = matched.kind === "unique" ? matched.sku : "";
  const storedTitle = matched.kind === "unique" ? matched.title : "";
  let title = (storedTitle || emailTitle.trim() || UNIDENTIFIED_ITEM_TITLE).slice(0, 180);
  if (emailSku && titleSku && emailSku !== titleSku) return { sku: "", title };
  const sku = emailSku || titleSku;
  if (sku && title === UNIDENTIFIED_ITEM_TITLE) {
    const known = titleOf(candidates.find((candidate) => candidate.sku === sku));
    if (known) title = known.slice(0, 180);
  }
  return { sku, title };
}
