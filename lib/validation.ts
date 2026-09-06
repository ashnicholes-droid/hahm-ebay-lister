import { z } from "zod";
import type { ListingResult } from "./types";

const text = z.string().max(500);
const scalar = z
  .union([z.string().max(500), z.number().finite()])
  .transform(String);
export const CONDITIONS = [
  "NEW_WITH_TAGS",
  "NEW_NO_TAGS",
  "EXCELLENT",
  "VERY_GOOD",
  "GOOD",
  "FAIR",
  "FOR_PARTS_OR_NOT_WORKING",
] as const;
export const listingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(15000),
  category: text.optional(),
  category_hint: text.optional(),
  category_id: z.string().regex(/^\d*$/).max(20).optional(),
  ebay_condition: text.optional(),
  evidence: z
    .record(
      z.string().max(100),
      z.array(z.number().int().min(1).max(24)).max(24),
    )
    .optional(),
  brand: scalar.optional(),
  item_type: scalar.optional(),
  color: z.union([scalar, z.array(scalar).max(10)]).optional(),
  size: scalar.optional(),
  material: scalar.optional(),
  condition: z.enum(CONDITIONS).optional(),
  condition_notes: z.string().max(3000).optional(),
  measurements: text.optional(),
  suggested_price: z
    .union([
      z.number().finite().min(0).max(1_000_000),
      z
        .string()
        .regex(/^(?:\d+(?:\.\d{1,2})?)?$/)
        .max(12),
    ])
    .optional(),
  search_terms: z.array(text).max(4).optional(),
  seo_keywords: z.array(text).max(10).optional(),
  key_features: z.array(text).max(10).optional(),
  item_specifics: z
    .record(
      z.string().min(1).max(100),
      z.union([
        scalar,
        z
          .array(scalar)
          .max(5)
          .transform((v) => v.join(" | ")),
      ]),
    )
    .refine((v) => Object.keys(v).length <= 100, "Too many specifics")
    .optional(),
  item_profile: text.optional(),
});
export const imageSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string().min(1).max(2_800_000),
});
export const imagesSchema = z
  .array(imageSchema)
  .min(1)
  .max(24)
  .refine(
    (xs) => xs.reduce((n, x) => n + x.data.length, 0) < 3_800_000,
    "Photo data is too large. Select fewer analysis photos.",
  );
export const skuSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/,
    "SKU must be 1–50 letters, numbers, dots, underscores or hyphens.",
  );
export const shippingSchema = z
  .object({
    fulfillmentPolicyId: z.string().min(1).max(100),
    paymentPolicyId: z.string().min(1).max(100),
    returnPolicyId: z.string().min(1).max(100),
    locationKey: z.string().min(1).max(100),
    weightOz: z.number().finite().positive().max(2400).optional(),
    lengthIn: z.number().finite().positive().max(200).optional(),
    widthIn: z.number().finite().positive().max(200).optional(),
    heightIn: z.number().finite().positive().max(200).optional(),
  })
  .refine((s) => {
    const count = [s.lengthIn, s.widthIn, s.heightIn].filter(
      (x) => x !== undefined,
    ).length;
    return count === 0 || count === 3;
  }, "Enter all three dimensions or leave them all blank.");
export type ShippingSelection = z.infer<typeof shippingSchema>;
export function parseListing(raw: unknown): ListingResult {
  return listingSchema.parse(raw);
}
export function validationMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "Request"}: ${i.message}`)
      .join("; ");
  return error instanceof Error ? error.message : "Invalid data.";
}
