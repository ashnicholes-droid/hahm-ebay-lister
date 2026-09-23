import type { ListingResult } from "@/lib/types";

export const isApparel = (l: ListingResult) =>
  /^(mens|womens)_/.test(l.category || "");
export function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
const brandName = (s: string) => s.replace(/\s+by\s+.+$/i, "");
const ignored = new Set([
  "the",
  "a",
  "an",
  "and",
  "for",
  "by",
  "with",
  "brand",
  "n",
]);
const meaningful = (s: string) => words(s).filter((w) => !ignored.has(w));
const contains = (title: string, phrase: string) =>
  meaningful(phrase).every((w) => words(title).includes(w));

// Construction aliases let sellers describe the same garment in different ways.
// Distinctive graphics, premium fibers and named product lines remain constraints.
const features: [string, RegExp][] = [
  ["burger", /\b(?:burger|hamburger|cheeseburger)\b/i],
  ["scouts", /\b(?:scouts|guardians)\b/i],
  ["rainbow", /\brainbow\b/i],
  ["wave", /\b(?:wave|waves|wavy)\b/i],
  ["pocket", /\bpockets?\b/i],
  ["striped", /\b(?:stripe|striped|stripes)\b/i],
  ["colorblock", /\bcolor[ -]?block(?:ed)?\b/i],
  ["draped", /\b(?:drape|draped|waterfall|cascade)\b/i],
  ["camp", /\b(?:camp|cuban)\b/i],
  ["cable", /\bcable\b/i],
  ["floral", /\bfloral\b/i],
  ["plaid", /\b(?:plaid|tartan)\b/i],
];
function family(l: ListingResult): [string, RegExp] | undefined {
  const s = `${l.item_type || ""} ${l.item_specifics?.Type || ""} ${l.item_specifics?.Style || ""}`;
  const families: [string, RegExp][] = [
    ["cardigan", /\bcardigan\b/i],
    ["hoodie", /\bhood(?:ie|ed)\b/i],
    ["sweatshirt", /\b(?:sweatshirt|sweater)\b/i],
    ["t-shirt", /\b(?:t[ -]?shirts?|tees?)\b/i],
    ["shorts", /\bshorts\b/i],
    ["jeans", /\bjeans\b/i],
    ["pants", /\b(?:pants?|trousers?|chinos?|slacks)\b/i],
    ["dress", /\bdress(?:es)?\b/i],
    ["skirt", /\bskirts?\b/i],
    ["shirt", /\b(?:shirts?|button[ -]?(?:up|down)|blouse)\b/i],
    ["jacket", /\b(?:jackets?|coats?)\b/i],
  ];
  return families.find(([, pattern]) => pattern.test(s));
}
function anchors(l: ListingResult): string[] {
  const s = l.item_specifics || {};
  const material = l.material || s.Material || "";
  const premium =
    material.match(/\b(cashmere|silk|linen|leather|wool)\b/gi) || [];
  return [s.Collaboration, s["Product Line"], s.Model, ...premium].filter(
    (v): v is string => Boolean(v?.trim()),
  );
}
function wantedFeatures(l: ListingResult) {
  const text = [
    l.title,
    l.item_specifics?.Style,
    ...(l.search_terms || []),
  ].join(" ");
  return features.filter(([, re]) => re.test(text));
}
export function apparelQuery(l: ListingResult, broad = false): string {
  const brand = /^(unknown|unbranded|no\s?brand)$/i.test(l.brand || "")
    ? ""
    : brandName(l.brand || "");
  const tokens = [
    brand,
    ...anchors(l),
    family(l)?.[0] || l.item_type || "",
    ...(broad
      ? []
      : wantedFeatures(l)
          .slice(0, 2)
          .map(([name]) => name)),
    l.size || "",
  ];
  // Deduplicate whole words, and never cut the query in the middle of a word.
  const seen = new Set<string>();
  return tokens
    .flatMap(words)
    .filter((w) => !ignored.has(w) && !seen.has(w) && Boolean(seen.add(w)))
    .join(" ")
    .split(" ")
    .reduce(
      (q, w) => (q.length + w.length + 1 <= 100 ? `${q} ${w}`.trim() : q),
      "",
    );
}
export function apparelMatchScore(title: string, l: ListingResult): number {
  if (!l.brand || /^(unknown|unbranded|no\s?brand)$/i.test(l.brand)) return 0;
  if (!contains(title, brandName(l.brand))) return 0;
  const candidate = words(title).join(" ");
  if (/\b(?:kids?|youth|boys?|girls?|toddler)\b/.test(candidate)) return 0;
  if (
    l.category?.startsWith("mens_") &&
    /\b(?:women|womens|ladies)\b/.test(candidate)
  )
    return 0;
  if (
    l.category?.startsWith("womens_") &&
    /\b(?:men|mens)\b/.test(candidate) &&
    !/\bunisex\b/.test(candidate)
  )
    return 0;
  if (
    l.item_specifics?.["Size Type"] === "Regular" &&
    /\b(?:petites?|maternity|plus)\b/.test(candidate)
  )
    return 0;
  const type = family(l);
  if (type && !type[1].test(title)) return 0;
  // A button-up must not match a tee; long pants must not match shorts.
  if (type?.[0] === "shirt" && /\b(?:t[ -]?shirt|tee|polo)\b/i.test(title))
    return 0;
  if (type?.[0] === "pants" && /\bshorts\b/i.test(title)) return 0;
  const neckline = l.item_specifics?.Neckline || "";
  if (
    /crew/i.test(neckline) &&
    /\b(?:hoodie|hooded|hood|zip|v[ -]?neck|turtleneck)\b/i.test(title)
  )
    return 0;
  if (
    /graphic/i.test(l.item_specifics?.Pattern || "") &&
    /\b(?:embroidered|embroidery|symbols)\b/i.test(title)
  )
    return 0;
  // Ignore missing colors, but reject explicit conflicting colorways.
  const colors = (value: string) =>
    words(
      value.replace(/grey/gi, "gray").replace(/navy|indigo/gi, "blue"),
    ).filter((w) =>
      [
        "black",
        "white",
        "blue",
        "red",
        "green",
        "yellow",
        "pink",
        "purple",
        "orange",
        "gray",
        "brown",
        "beige",
        "cream",
      ].includes(w),
    );
  const targetColors = colors(
    l.item_specifics?.Color ||
      (Array.isArray(l.color) ? l.color.join(" ") : l.color || ""),
  );
  const candidateColors = colors(title);
  if (
    targetColors.length &&
    candidateColors.length &&
    !targetColors.some((c) => candidateColors.includes(c))
  )
    return 0;
  if (!anchors(l).every((a) => contains(title, a))) return 0;
  const wanted = wantedFeatures(l);
  const matched = wanted.filter(([, re]) => re.test(title)).length;
  // Strong graphic identities cannot be replaced by generic brand matches.
  if (
    wanted.some(
      ([name, re]) =>
        ["burger", "rainbow", "scouts"].includes(name) && !re.test(title),
    )
  )
    return 0;
  const fraction = wanted.length ? matched / wanted.length : 1;
  if (fraction < 0.6) return 0;
  return 0.6 + fraction * 0.4;
}
