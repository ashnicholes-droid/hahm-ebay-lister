import { createHmac, timingSafeEqual } from "node:crypto";
// Receipt binds the metadata to the draft's category, not its editable values.
// Facts are still validated against fresh metadata immediately before publishing.
export function signReview(categoryId: string, expiresAt: number): string {
  const secret = process.env.APP_SECRET;
  if (!secret)
    throw new Error("APP_SECRET is required to prepare a publishable draft.");
  return createHmac("sha256", secret)
    .update(`${categoryId}:${expiresAt}`)
    .digest("hex");
}
export function verifyReview(
  categoryId: string,
  expiresAt: number,
  signature: string,
): boolean {
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt < Date.now() ||
    expiresAt > Date.now() + 86400_000
  )
    return false;
  const expected = signReview(categoryId, expiresAt);
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
