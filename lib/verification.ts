// Accuracy checking for a drafted listing.
//
// The analysis pass writes a listing from photos; this module asks the separate
// question "is what it wrote actually true of this item?". That matters more
// than it sounds: an invented brand is a VeRO takedown, an overstated condition
// is a return and a defect, a hallucinated size is a return, and a price with no
// relationship to the market is either a loss or a listing that never sells.
//
// Two independent layers, deliberately kept apart:
//
//   • Rules (this file, pure + tested). Cheap, deterministic, and run on every
//     keystroke's worth of edits. They catch internal contradictions — claims
//     the listing makes that the listing's own fields don't support.
//   • Grounding (app/api/verify/route.ts). A second model pass that re-reads the
//     PHOTOS and grades each claim as supported / not visible / contradicted.
//     It's the only layer that can catch a confident, self-consistent invention.
//
// Rules can never say "this is true" — only "nothing here contradicts it". The
// UI is careful to reflect that.

import type { CompsSummary, ListingResult } from "@/lib/types";
import { EBAY_TITLE_LIMIT } from "@/lib/titleOptimizer";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";

export type VerdictStatus = "ok" | "warn" | "fail";

export interface Verdict {
  /** Which part of the listing this is about — used to anchor the UI. */
  field: "title" | "price" | "condition" | "description" | "size" | "brand" | "specifics";
  status: VerdictStatus;
  message: string;
  /** "rule" = deterministic check here; "photo" = the model re-reading the photos. */
  source: "rule" | "photo";
}

export interface VerificationReport {
  verdicts: Verdict[];
  /** True when something must be resolved before this listing should go live. */
  blocking: boolean;
  /** Set once the photo-grounding pass has run; rules alone leave it false. */
  photoChecked: boolean;
  checkedAt: number;
}

/** One claim the grounding pass graded against the photos. */
export interface PhotoClaim {
  field: Verdict["field"];
  claim: string;
  status: "supported" | "not_visible" | "contradicted";
  note?: string;
}

const NEW_CONDITIONS = new Set(["NEW_WITH_TAGS", "NEW_NO_TAGS"]);

// Words that describe damage. If they appear in the listing's own prose while
// the condition says "new", one of the two is wrong.
const FLAW_RE =
  /\b(stain|stained|tear|torn|rip|ripped|hole|holes|crack|cracked|chip|chipped|scratch|scratched|scuff|scuffed|fray|frayed|pilling|discolou?r|fade|faded|missing|broken|worn|wear)\b/i;

// Claims that invite a dispute or a VeRO report when they aren't provable from
// the photos. Not banned — flagged, so a seller decides knowingly.
const RISKY_CLAIM_RE =
  /\b(authentic|genuine|guaranteed|certified|rare|deadstock|mint condition|100%\s*\w+|never\s+worn|brand\s?new)\b/i;

const PLACEHOLDER_DESC_RE =
  /^\s*(see (the )?(photos?|pictures?|images?)( for details)?[.!]?|as (shown|pictured)[.!]?|no description[.!]?)\s*$/i;

function priceOf(listing: ListingResult): number | null {
  const raw = listing.suggested_price;
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  return n === undefined || n === null || Number.isNaN(n) || n <= 0 ? null : n;
}

function text(listing: ListingResult): string {
  return `${listing.title ?? ""} ${listing.description ?? ""}`;
}

/** Whole-word containment, so "L" doesn't match inside "Leather". */
function mentions(haystack: string, needle: string): boolean {
  const t = needle.trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`, "i").test(haystack);
}

function checkTitle(listing: ListingResult, out: Verdict[]): void {
  const title = String(listing.title ?? "").trim();
  if (!title) {
    out.push({ field: "title", status: "fail", message: "No title.", source: "rule" });
    return;
  }
  if (title.length > EBAY_TITLE_LIMIT) {
    out.push({
      field: "title",
      status: "fail",
      message: `Title is ${title.length} characters — eBay cuts it off at ${EBAY_TITLE_LIMIT}.`,
      source: "rule",
    });
  } else if (title.length < 25) {
    out.push({
      field: "title",
      status: "warn",
      message: `Title is only ${title.length} characters. Unused title space is unused search reach.`,
      source: "rule",
    });
  }
  // A brand in the title that appears nowhere else in the listing is usually the
  // model guessing from a shape it recognised rather than reading a label.
  const brand = String(listing.brand ?? "").trim();
  if (brand && !/^(no\s?brand|unbranded|unknown)$/i.test(brand) && !mentions(title, brand)) {
    out.push({
      field: "title",
      status: "warn",
      message: `Brand "${brand}" is set but missing from the title — buyers search by brand first.`,
      source: "rule",
    });
  }
  const risky = title.match(RISKY_CLAIM_RE);
  if (risky) {
    out.push({
      field: "title",
      status: "warn",
      message: `Title claims "${risky[0]}". Only keep it if the photos actually prove it — unprovable authenticity claims draw VeRO reports.`,
      source: "rule",
    });
  }
}

function checkPrice(listing: ListingResult, comps: CompsSummary | undefined, out: Verdict[]): void {
  const price = priceOf(listing);
  if (price === null) {
    out.push({
      field: "price",
      status: "fail",
      message: "No price. eBay will reject the listing until one is set.",
      source: "rule",
    });
    return;
  }
  if (!comps?.ok || comps.median === undefined || comps.count < 3) {
    out.push({
      field: "price",
      status: "warn",
      message:
        "No market comparison available, so this price is the model's estimate alone. Spot-check it against a sold search.",
      source: "rule",
    });
    return;
  }
  const ratio = price / comps.median;
  if (ratio > 2.5) {
    out.push({
      field: "price",
      status: "warn",
      message: `$${price.toFixed(2)} is ${ratio.toFixed(1)}× the median of ${comps.count} active comps ($${comps.median.toFixed(2)}). It will likely sit unsold.`,
      source: "rule",
    });
  } else if (ratio < 0.4) {
    out.push({
      field: "price",
      status: "warn",
      message: `$${price.toFixed(2)} is well under the median of ${comps.count} active comps ($${comps.median.toFixed(2)}). Check you're not underselling.`,
      source: "rule",
    });
  } else {
    out.push({
      field: "price",
      status: "ok",
      message: `$${price.toFixed(2)} sits inside the range of ${comps.count} active comps ($${comps.low?.toFixed(0)}–$${comps.high?.toFixed(0)}).`,
      source: "rule",
    });
  }
}

function checkCondition(listing: ListingResult, out: Verdict[]): void {
  const condition = String(listing.condition ?? "").toUpperCase();
  const notes = String(listing.condition_notes ?? "");
  const body = `${notes} ${listing.description ?? ""}`;
  if (NEW_CONDITIONS.has(condition) && FLAW_RE.test(body)) {
    const flaw = body.match(FLAW_RE)?.[0];
    out.push({
      field: "condition",
      status: "fail",
      message: `Condition says "${condition.replace(/_/g, " ").toLowerCase()}" but the description mentions "${flaw}". One of the two is wrong — a mis-graded item is a return and a defect.`,
      source: "rule",
    });
  }
  if (!NEW_CONDITIONS.has(condition) && !notes.trim()) {
    out.push({
      field: "condition",
      status: "warn",
      message:
        "Pre-owned item with no condition notes. Unstated flaws are the top cause of not-as-described cases.",
      source: "rule",
    });
  }
}

function checkDescription(listing: ListingResult, out: Verdict[]): void {
  const description = String(listing.description ?? "").trim();
  if (!description || PLACEHOLDER_DESC_RE.test(description)) {
    out.push({
      field: "description",
      status: "warn",
      message: "Description is empty or just points at the photos.",
      source: "rule",
    });
    return;
  }
  const risky = description.match(RISKY_CLAIM_RE);
  if (risky) {
    out.push({
      field: "description",
      status: "warn",
      message: `Description claims "${risky[0]}" — keep it only if the photos back it up.`,
      source: "rule",
    });
  }
}

function checkSize(listing: ListingResult, out: Verdict[]): void {
  const required = SIZE_REQUIRED_CATEGORIES.has(String(listing.category ?? ""));
  const size = String(listing.size ?? "").trim();
  if (required && !size) {
    out.push({
      field: "size",
      status: "fail",
      message:
        "No size on an apparel item. eBay's size standardisation blocks the listing, and guessing causes returns.",
      source: "rule",
    });
  } else if (size && !mentions(text(listing), size)) {
    out.push({
      field: "size",
      status: "warn",
      message: `Size "${size}" doesn't appear in the title or description — confirm it came off the tag, not from the garment's look.`,
      source: "rule",
    });
  }
}

function checkSpecifics(listing: ListingResult, out: Verdict[]): void {
  const entries = Object.entries(listing.item_specifics ?? {}).filter(
    ([k, v]) => k && !k.startsWith("---") && String(v ?? "").trim()
  );
  if (entries.length === 0) return;
  const body = text(listing);
  // Specifics that show up nowhere else are inferences. A few are fine and even
  // desirable (they're what eBay filters on); a listing that is mostly
  // inferences is one the model built from priors rather than from the photos.
  const unsupported = entries.filter(([, v]) => !mentions(body, String(v)));
  if (unsupported.length >= Math.max(4, Math.ceil(entries.length * 0.7))) {
    out.push({
      field: "specifics",
      status: "warn",
      message: `${unsupported.length} of ${entries.length} item specifics aren't mentioned anywhere else in the listing. Run the photo check before posting.`,
      source: "rule",
    });
  }
}

/**
 * Run every deterministic check against the listing as it currently stands
 * (including the seller's own edits).
 */
export function runRuleChecks(
  listing: ListingResult | undefined,
  comps?: CompsSummary
): Verdict[] {
  if (!listing) return [];
  const out: Verdict[] = [];
  checkTitle(listing, out);
  checkPrice(listing, comps, out);
  checkCondition(listing, out);
  checkDescription(listing, out);
  checkSize(listing, out);
  checkSpecifics(listing, out);
  return out;
}

/** Turn the grounding pass's graded claims into verdicts. */
export function verdictsFromClaims(claims: PhotoClaim[]): Verdict[] {
  const out: Verdict[] = [];
  for (const claim of claims) {
    if (claim.status === "supported") continue;
    out.push({
      field: claim.field,
      status: claim.status === "contradicted" ? "fail" : "warn",
      message:
        claim.status === "contradicted"
          ? `The photos contradict "${claim.claim}"${claim.note ? ` — ${claim.note}` : ""}.`
          : `"${claim.claim}" isn't visible in any photo${claim.note ? ` — ${claim.note}` : ""}.`,
      source: "photo",
    });
  }
  return out;
}

export function buildReport(
  ruleVerdicts: Verdict[],
  photoVerdicts: Verdict[] = [],
  photoChecked = false
): VerificationReport {
  const verdicts = [...ruleVerdicts, ...photoVerdicts];
  return {
    verdicts,
    blocking: verdicts.some((v) => v.status === "fail"),
    photoChecked,
    checkedAt: Date.now(),
  };
}

/** Worst status present, for the one-glance badge on a listing card. */
export function reportStatus(report: VerificationReport | undefined): VerdictStatus | "unchecked" {
  if (!report) return "unchecked";
  if (report.verdicts.some((v) => v.status === "fail")) return "fail";
  if (report.verdicts.some((v) => v.status === "warn")) return "warn";
  return "ok";
}
