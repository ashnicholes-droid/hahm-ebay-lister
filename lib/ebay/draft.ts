import type { AspectMeta } from "./taxonomy";
import { isPlaceholderValue } from "./aspects";
// Validation never alters the reviewed values. Formatting/enrichment happens earlier.
export function validateAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
): string[] {
  const issues: string[] = [];
  const byName = new Map(meta.map((a) => [a.name, a]));
  for (const a of meta) {
    const vals = (aspects[a.name] ?? []).filter((v) => !isPlaceholderValue(v));
    if (a.required && !vals.length) issues.push(`Enter ${a.name}`);
  }
  for (const [key, vals] of Object.entries(aspects)) {
    const a = byName.get(key);
    if (vals.some((v) => isPlaceholderValue(v)))
      issues.push(`Remove unknown placeholder in ${key}`);
    if (vals.some((v) => v.length > (a?.maxLength ?? 65)))
      issues.push(`${key} is too long`);
    if (a?.cardinality === "SINGLE" && vals.length > 1)
      issues.push(`Choose one ${key}`);
    if (a?.mode === "SELECTION_ONLY" && vals.some((v) => !a.values.includes(v)))
      issues.push(`Choose an allowed value for ${key}`);
    if (
      a?.dataType === "NUMBER" &&
      vals.some(
        (v) =>
          !/^\d+(\.\d+)?$/.test(v) ||
          !Number.isFinite(Number(v)) ||
          (a.format === "int32" && !Number.isInteger(Number(v))),
      )
    )
      issues.push(`Enter a number for ${key}`);
    if (
      a?.dataType === "DATE" &&
      vals.some((v) => !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(v))
    )
      issues.push(`Enter a date for ${key}`);
    for (const value of vals)
      for (const dep of a?.constraints?.[value] ?? []) {
        if (!(aspects[dep.name] ?? []).some((v) => dep.values.includes(v)))
          issues.push(
            `${key}: ${value} requires ${dep.name}: ${dep.values.join(" / ")}`,
          );
      }
  }
  return [...new Set(issues)];
}
