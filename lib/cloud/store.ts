import { createClient } from "@supabase/supabase-js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
export const OWNER_COOKIE = "lister_cloud_owner";
export function cloudEnabled() {
  return (
    process.env.CLOUD_BATCH_ENABLED === "true" &&
    Boolean(
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SECRET_KEY &&
      process.env.INNGEST_EVENT_KEY &&
      process.env.INNGEST_SIGNING_KEY &&
      process.env.SESSION_SECRET,
    )
  );
}
export function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)
    throw new Error("Cloud storage is not configured.");
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export const environment = () =>
  process.env.VERCEL_ENV === "production" ? "production" : "preview";
export const bucket = () => `lister-photos-${environment()}`;
function sign(id: string) {
  if (!process.env.SESSION_SECRET)
    throw new Error("Cloud session is not configured.");
  return createHmac("sha256", process.env.SESSION_SECRET)
    .update(`cloud:${environment()}:${id}`)
    .digest("hex");
}
export function ownerFromCookie(value?: string) {
  if (!value) return null;
  const [id, mac] = value.split(".");
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(mac ?? ""))
    return null;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(sign(id))) ? id : null;
}
export function owner(req: NextRequest) {
  return ownerFromCookie(req.cookies.get(OWNER_COOKIE)?.value);
}
export function newOwner() {
  const id = randomUUID();
  return { id, cookie: `${id}.${sign(id)}` };
}
export async function ownedBatch(id: string, workspace: string) {
  const { data, error } = await db()
    .from("lister_batches")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspace)
    .eq("environment", environment())
    .gt("expires_at", new Date().toISOString())
    .single();
  if (error || !data) throw new Error("Batch not found or expired.");
  return data;
}
export function checked<T>({
  data,
  error,
}: {
  data: T;
  error: any;
}): NonNullable<T> {
  if (error) throw new Error("Cloud storage request failed.");
  return data as NonNullable<T>;
}
