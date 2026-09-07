// Remove internal review labels without dropping the visible flaws that follow.
// Applied to generated prose only, before the seller edits it.
export function cleanGeneratedDescription(description: string): string {
  return description
    .replace(
      /\bpreliminary\s+(?:used\s+)?cosmetic\s+(?:condition|grade|assessment)\s*(?:with\s+)?/gi,
      "",
    )
    .replace(
      /\bbuyer\s+to\s+verify\s+measurements\s*\.?/gi,
      "See photos for measurements.",
    )
    .replace(/\bseller\s+to\s+verify\s*\.?/gi, "")
    .replace(/(^|[.!?])\s*[;:,]+\s*/g, "$1 ")
    .replace(/\s+([.;,])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /(^|[.!?]\s+)([a-z])/g,
      (_, start, letter) => start + letter.toUpperCase(),
    );
}
