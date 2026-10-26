import { matchAllowed } from "./aspects";
import type { AspectMeta } from "./taxonomy";

// The analysis stores the printed size once ("7.5 M", "W US 6.5",
// "US Men 4.5 / Women 6", "UK 9 / EU 44"). Shoe categories want it split into
// eBay's "US Shoe Size" (bare number) and "Shoe Width". A printed US size always
// wins; when only EU or UK is printed, it is converted with a standard chart
// for the item's department (brands can differ by half a size). CM/JP are never
// converted.

type Dept = "women" | "men" | "";
const WIDTHS: Record<Exclude<Dept, "">, Record<string, string>> = {
  women: { AA: "Narrow", "2A": "Narrow", A: "Narrow", N: "Narrow", B: "Medium", M: "Medium", C: "Wide", D: "Wide", W: "Wide", E: "Extra Wide", EE: "Extra Wide", WW: "Extra Wide" },
  men: { B: "Narrow", C: "Narrow", N: "Narrow", D: "Medium", M: "Medium", E: "Wide", EE: "Wide", "2E": "Wide", W: "Wide", EEE: "Extra Wide", "3E": "Extra Wide", "4E": "Extra Wide", XW: "Extra Wide", WW: "Extra Wide" },
};
// Standard EU → US charts (Nike/major-brand sizing).
const EU_TO_US: Record<Exclude<Dept, "">, Record<string, string>> = {
  men: { "38": "5.5", "38.5": "6", "39": "6.5", "40": "7", "40.5": "7.5", "41": "8", "42": "8.5", "42.5": "9", "43": "9.5", "44": "10", "44.5": "10.5", "45": "11", "45.5": "11.5", "46": "12", "47": "12.5", "47.5": "13", "48": "13.5", "48.5": "14", "49.5": "15" },
  women: { "35": "4.5", "35.5": "5", "36": "5.5", "36.5": "6", "37": "6.5", "37.5": "6.5", "38": "7", "38.5": "7.5", "39": "8", "40": "8.5", "40.5": "9", "41": "9.5", "42": "10", "42.5": "10.5", "43": "11", "44": "12" },
};
// US = UK + 1 for men, UK + 2 for women.
const UK_OFFSET: Record<Exclude<Dept, "">, number> = { men: 1, women: 2 };

// Words before the number: size system and/or department, in any order
// ("US Men 4.5", "Men's US 10", "W US 6.5"). Letters after it are a width.
const SEGMENT = /^\s*((?:[a-z']+\.?\s*)*?)\s*(\d{1,2}(?:\.5)?)\s*([a-z0-9]{1,3})?\s*$/i;
const SYSTEM_WORDS: Record<string, "us" | "eu" | "uk" | "skip"> = {
  us: "us", usa: "us", eu: "eu", eur: "eu", uk: "uk", cm: "skip", jp: "skip", mondo: "skip",
};
const DEPT_WORDS: Record<string, Exclude<Dept, "">> = {
  m: "men", men: "men", "men's": "men", mens: "men",
  w: "women", wmns: "women", women: "women", "women's": "women", womens: "women",
};

interface Segment {
  system: "us" | "eu" | "uk";
  dept: Dept;
  size: string;
  width: string;
}

function parseSegment(raw: string): Segment | null {
  const m = SEGMENT.exec(raw);
  if (!m) return null;
  let system: Segment["system"] = "us";
  let dept: Dept = "";
  for (const word of m[1].toLowerCase().replace(/\./g, "").split(/\s+/).filter(Boolean)) {
    if (word === "size") continue;
    const sys = SYSTEM_WORDS[word];
    if (sys === "skip") return null;
    if (sys) system = sys;
    else if (DEPT_WORDS[word]) dept = DEPT_WORDS[word];
    else return null;
  }
  return { system, dept, size: m[2], width: (m[3] ?? "").toUpperCase() };
}

function departmentOf(aspects: Record<string, string[]>, catKey: string): Dept {
  const d = `${aspects.Department?.[0] ?? ""} ${catKey}`.toLowerCase();
  if (/wom[ae]n|girl/.test(d)) return "women";
  if (/\bmen|mens_|boy/.test(d)) return "men";
  return "";
}

function toUs(seg: Segment, dept: Dept): string | null {
  const d = seg.dept || dept;
  if (!d) return null;
  if (seg.system === "eu") return EU_TO_US[d][String(Number(seg.size))] ?? null;
  const us = Number(seg.size) + UK_OFFSET[d];
  return Number.isFinite(us) ? String(us) : null;
}

export function parseUsShoeSize(raw: string, dept: Dept) {
  const parsed = raw
    .split(/[\/|,;]/)
    .map(parseSegment)
    .filter((s): s is Segment => Boolean(s));
  const us = parsed.filter((p) => p.system === "us");
  if (us.length) {
    const pick =
      us.find((p) => dept && p.dept === dept) ??
      (us.length === 1 || us.every((p) => !p.dept) ? us[0] : null);
    if (!pick) return null;
    const table = WIDTHS[pick.dept || dept || "women"];
    return { size: pick.size, width: table[pick.width] ?? "" };
  }
  // No printed US size: convert EU first, then UK.
  for (const system of ["eu", "uk"] as const) {
    const seg = parsed.find((p) => p.system === system && (!dept || !p.dept || p.dept === dept));
    const size = seg && toUs(seg, dept);
    if (size) return { size, width: "" };
  }
  return null;
}

const allowedStarting = (word: string, allowed: string[]) =>
  matchAllowed(word, allowed) ??
  allowed.find((v) => v.toLowerCase().startsWith(`${word.toLowerCase()} (`)) ??
  null;

/**
 * Fill US Shoe Size / Shoe Width from the printed size. Existing values are
 * kept unless `overwrite` is set (used when the seller edits the size).
 */
export function applyShoeSize(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  printedSize: string,
  catKey: string,
  overwrite = false,
): void {
  const sizeMeta = meta.find((a) => /^us shoe size/i.test(a.name));
  if (!sizeMeta || !printedSize.trim()) return;
  const parsed = parseUsShoeSize(printedSize, departmentOf(aspects, catKey));
  if (!parsed) return;
  if (overwrite || !aspects[sizeMeta.name]?.length) {
    const size =
      sizeMeta.mode === "SELECTION_ONLY"
        ? matchAllowed(parsed.size, sizeMeta.values)
        : parsed.size;
    if (size) aspects[sizeMeta.name] = [size];
  }
  const widthMeta = meta.find((a) => /^shoe width$/i.test(a.name));
  if (widthMeta && parsed.width && (overwrite || !aspects[widthMeta.name]?.length)) {
    const width =
      widthMeta.mode === "SELECTION_ONLY"
        ? allowedStarting(parsed.width, widthMeta.values)
        : parsed.width;
    if (width) aspects[widthMeta.name] = [width];
  }
}

/**
 * Item specifics after the seller edits the Size field: US Shoe Size / Shoe
 * Width follow the new size. Returns the same object when nothing changes.
 */
export function syncShoeSizeSpecifics(
  listing: { size?: string; category?: string; item_specifics?: Record<string, string> },
  meta: AspectMeta[],
): Record<string, string> {
  const specifics = listing.item_specifics ?? {};
  const aspects = Object.fromEntries(
    Object.entries(specifics)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => [k, v.split(" | ").map((x) => x.trim())]),
  );
  applyShoeSize(aspects, meta, listing.size ?? "", listing.category ?? "", true);
  const next = { ...specifics };
  let changed = false;
  for (const a of meta.filter((m) => /^(us shoe size|shoe width)/i.test(m.name))) {
    const value = (aspects[a.name] ?? []).join(" | ");
    if (value && value !== specifics[a.name]) {
      next[a.name] = value;
      changed = true;
    }
  }
  return changed ? next : specifics;
}
