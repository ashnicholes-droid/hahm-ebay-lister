import { matchAllowed } from "./aspects";
import type { AspectMeta } from "./taxonomy";

// The analysis stores the printed size once ("7.5 M", "W US 6.5",
// "M US 5 / W US 6.5"). Shoe categories want it split into eBay's
// "US Shoe Size" (bare number) and "Shoe Width". Only printed US sizes are
// mapped — EU/UK/CM are never converted — and seller values always win.

type Dept = "women" | "men" | "";
const WIDTHS: Record<Exclude<Dept, "">, Record<string, string>> = {
  women: { AA: "Narrow", "2A": "Narrow", A: "Narrow", N: "Narrow", B: "Medium", M: "Medium", C: "Wide", D: "Wide", W: "Wide", E: "Extra Wide", EE: "Extra Wide", WW: "Extra Wide" },
  men: { B: "Narrow", C: "Narrow", N: "Narrow", D: "Medium", M: "Medium", E: "Wide", EE: "Wide", "2E": "Wide", W: "Wide", EEE: "Extra Wide", "3E": "Extra Wide", "4E": "Extra Wide", XW: "Extra Wide", WW: "Extra Wide" },
};
const SEGMENT =
  /^\s*(?:(women'?s|womens|w|men'?s|mens|m)\s+)?(?:(us)\s*)?(\d{1,2}(?:\.5)?)\s*([a-z0-9]{1,3})?\s*$/i;

function departmentOf(aspects: Record<string, string[]>, catKey: string): Dept {
  const d = `${aspects.Department?.[0] ?? ""} ${catKey}`.toLowerCase();
  if (/wom[ae]n|girl/.test(d)) return "women";
  if (/\bmen|mens_|boy/.test(d)) return "men";
  return "";
}

export function parseUsShoeSize(raw: string, dept: Dept) {
  if (/\b(eu|uk|cm|jp|mondo)\b/i.test(raw) && !/\bus\b/i.test(raw)) return null;
  const parsed = raw
    .split(/[\/|,]/)
    .filter((s) => !/\b(eu|uk|cm|jp)\b/i.test(s))
    .map((s) => SEGMENT.exec(s))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({
      dept: (m[1] ? (/^w/i.test(m[1]) ? "women" : "men") : "") as Dept,
      size: m[3],
      width: (m[4] ?? "").toUpperCase(),
    }));
  if (!parsed.length) return null;
  const pick =
    parsed.find((p) => dept && p.dept === dept) ??
    (parsed.length === 1 || parsed.every((p) => !p.dept) ? parsed[0] : null);
  if (!pick) return null;
  const table = WIDTHS[pick.dept || dept || "women"];
  return { size: pick.size, width: table[pick.width] ?? "" };
}

const allowedStarting = (word: string, allowed: string[]) =>
  matchAllowed(word, allowed) ??
  allowed.find((v) => v.toLowerCase().startsWith(`${word.toLowerCase()} (`)) ??
  null;

export function applyShoeSize(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  printedSize: string,
  catKey: string,
): void {
  const sizeMeta = meta.find((a) => /^us shoe size/i.test(a.name));
  if (!sizeMeta || !printedSize.trim()) return;
  const parsed = parseUsShoeSize(printedSize, departmentOf(aspects, catKey));
  if (!parsed) return;
  if (!aspects[sizeMeta.name]?.length) {
    const size =
      sizeMeta.mode === "SELECTION_ONLY"
        ? matchAllowed(parsed.size, sizeMeta.values)
        : parsed.size;
    if (size) aspects[sizeMeta.name] = [size];
  }
  const widthMeta = meta.find((a) => /^shoe width$/i.test(a.name));
  if (widthMeta && parsed.width && !aspects[widthMeta.name]?.length) {
    const width =
      widthMeta.mode === "SELECTION_ONLY"
        ? allowedStarting(parsed.width, widthMeta.values)
        : parsed.width;
    if (width) aspects[widthMeta.name] = [width];
  }
}
