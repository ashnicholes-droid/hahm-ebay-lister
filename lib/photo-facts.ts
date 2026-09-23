// Label facts must match their quoted text. Visual judgments and educated
// guesses are accepted at >= MIN_ESTIMATE_CONFIDENCE so the seller only fills
// genuinely unknown aspects. An eBay allowed-value list is never evidence.
export const MIN_ESTIMATE_CONFIDENCE = 60;
// Seller preference: always take the best guess for these, at any confidence.
export const ALWAYS_ESTIMATE = ["Upper Material"];
const alwaysEstimate = new Set(ALWAYS_ESTIMATE.map((n) => n.toLowerCase()));
// A wrong guess here misrepresents the item or breaks catalog matching:
// these must come from a readable label or stay empty.
const labelOnly =
  /\b(upc|ean|isbn|gtin|mpn)\b|manufactur|vintage|handmade|personaliz|inseam|\brise\b|chest|waist size|measurement|length \(in|pit to pit/i;
// Legacy visible_feature facts without a confidence score.
const visible = new Set([
  "color",
  "pattern",
  "sleeve length",
  "neckline",
  "closure",
  "collar",
  "collar style",
  "style",
  "type",
  "accents",
  "features",
  "pocket type",
]);
export interface PhotoFact {
  name: string;
  value: string;
  photoIndices: number[];
  basis: "label" | "visible_feature" | "estimate";
  quote: string;
  confidence?: number;
}
export function acceptedPhotoFact(
  raw: unknown,
  count: number,
): raw is PhotoFact {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as PhotoFact;
  if (
    typeof s.name !== "string" ||
    typeof s.value !== "string" ||
    !s.value.trim() ||
    s.value.length > 500 ||
    !Array.isArray(s.photoIndices) ||
    !s.photoIndices.length ||
    !s.photoIndices.every((i) => Number.isInteger(i) && i > 0 && i <= count)
  )
    return false;
  if (s.basis === "label") {
    if (typeof s.quote !== "string" || !s.quote.trim()) return false;
    const normalize = (v: string) =>
      " " +
      v
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim() +
      " ";
    // A size tag M does not establish Men, Regular fit or a manufacturing year.
    if (
      /year.*manufact|manufact.*year/i.test(s.name) &&
      !/manufactured|made in \d{4}/i.test(s.quote)
    )
      return false;
    return s.value
      .split(" | ")
      .every((v) => normalize(s.quote).includes(normalize(v)));
  }
  if (s.basis !== "visible_feature" && s.basis !== "estimate") return false;
  if (labelOnly.test(s.name)) return false;
  if (typeof s.confidence === "number")
    return (
      Number.isFinite(s.confidence) &&
      (s.confidence >= MIN_ESTIMATE_CONFIDENCE ||
        alwaysEstimate.has(s.name.toLowerCase()))
    );
  return s.basis === "visible_feature" && visible.has(s.name.toLowerCase());
}
export const isEstimate = (f: PhotoFact) => f.basis !== "label";
export const PHOTO_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    value: { type: "string" },
    photoIndices: { type: "array", items: { type: "integer" } },
    basis: { type: "string", enum: ["label", "visible_feature", "estimate"] },
    quote: { type: "string" },
    confidence: { type: "integer" },
  },
  required: ["name", "value", "photoIndices", "basis", "quote", "confidence"],
};
