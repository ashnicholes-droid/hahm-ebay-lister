import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardApiRequest } from "@/lib/api-guard";
import {
  db,
  checked,
  owner,
  newOwner,
  OWNER_COOKIE,
  ownedBatch,
  bucket,
  environment,
  cloudEnabled,
} from "@/lib/cloud/store";
import { inngest } from "@/lib/cloud/inngest";
import { EBAY_COOKIE } from "@/lib/ebay/session";
export const maxDuration = 300;
const id = z.string().uuid();
const clientId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const groupSchema = z.object({
  id: clientId,
  sku: z.string().min(1).max(50),
  name: z.string().max(200),
  photoIds: z.array(clientId).min(1).max(24),
  analysisPhotoIds: z.array(clientId).min(1).max(24).optional(),
});
export async function GET() {
  return NextResponse.json({ enabled: cloudEnabled() });
}
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  if (!cloudEnabled())
    return NextResponse.json(
      {
        ok: false,
        error: "Background processing is not enabled on this deployment.",
      },
      { status: 503 },
    );
  try {
    const body = await req.json();
    let workspace = owner(req);
    if (body.action === "create") {
      const groups = z.array(groupSchema).min(1).max(100).parse(body.groups);
      if (
        new Set(groups.map((g) => g.id)).size !== groups.length ||
        new Set(groups.map((g) => g.sku)).size !== groups.length
      )
        throw new Error("Every item needs a unique ID and SKU.");
      for (const g of groups)
        if (g.analysisPhotoIds?.some((p) => !g.photoIds.includes(p)))
          throw new Error("Analysis photos must belong to their item.");
      const fresh = workspace ? null : newOwner();
      workspace = workspace ?? fresh!.id;
      const batchId = id.parse(body.batchId);
      const existing = checked(
        await db()
          .from("lister_batches")
          .select("id,workspace_id")
          .eq("id", batchId)
          .maybeSingle(),
      );
      if (existing) {
        if (existing.workspace_id !== workspace)
          throw new Error("Batch not found.");
        return NextResponse.json({ ok: true, batchId });
      }
      if (new Set(groups.flatMap((g) => g.photoIds)).size > 1000)
        throw new Error("This batch exceeds 1,000 photos.");
      checked(
        await db().rpc("lister_create_batch", {
          p_id: batchId,
          p_workspace: workspace,
          p_environment: environment(),
          p_groups: groups,
          p_connection: req.cookies.get(EBAY_COOKIE)?.value ?? null,
        }),
      );
      const res = NextResponse.json({ ok: true, batchId });
      if (fresh)
        res.cookies.set(OWNER_COOKIE, fresh.cookie, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
        });
      return res;
    }
    if (!workspace)
      throw new Error("Open this batch in the browser where you created it.");
    const batch = await ownedBatch(id.parse(body.batchId), workspace);
    if (body.action === "upload-links") {
      if (batch.status !== "draft")
        throw new Error("This batch is already queued.");
      const ids = z.array(clientId).min(1).max(20).parse(body.photoIds);
      const rows = checked(
        await db()
          .from("lister_photos")
          .select("*")
          .eq("batch_id", batch.id)
          .in("client_id", ids),
      );
      if (rows.length !== new Set(ids).size)
        throw new Error("Photo not in this batch.");
      const links = await Promise.all(
        rows.map(async (p) => ({
          id: p.client_id,
          analysis: checked(
            await db()
              .storage.from(p.bucket_id)
              .createSignedUploadUrl(p.object_path + "/analysis.jpg", {
                upsert: true,
              }),
          ).signedUrl,
          upload: checked(
            await db()
              .storage.from(p.bucket_id)
              .createSignedUploadUrl(p.object_path + "/upload.jpg", {
                upsert: true,
              }),
          ).signedUrl,
        })),
      );
      return NextResponse.json({ ok: true, links });
    }
    if (body.action === "confirm-uploads") {
      const ids = z.array(clientId).min(1).max(20).parse(body.photoIds);
      const photos = checked(
        await db()
          .from("lister_photos")
          .select("*")
          .eq("batch_id", batch.id)
          .in("client_id", ids),
      );
      if (photos.length !== new Set(ids).size)
        throw new Error("Photo not in batch.");
      await Promise.all(
        photos.map(async (p) => {
          for (const name of ["analysis.jpg", "upload.jpg"]) {
            const info = await db()
              .storage.from(p.bucket_id)
              .info(p.object_path + "/" + name);
            if (info.error) throw new Error("Photo upload incomplete.");
          }
        }),
      );
      checked(
        await db()
          .from("lister_photos")
          .update({ state: "uploaded" })
          .eq("batch_id", batch.id)
          .in("client_id", ids),
      );
      return NextResponse.json({ ok: true });
    }
    if (body.action === "start" || body.action === "retry") {
      const items = checked(
        await db().from("lister_items").select("*").eq("batch_id", batch.id),
      );
      const pending = checked(
        await db()
          .from("lister_photos")
          .select("id")
          .eq("batch_id", batch.id)
          .neq("state", "uploaded"),
      );
      if (pending.length)
        throw new Error(
          "Some photos have not finished uploading. Resume the upload.",
        );
      checked(
        await db()
          .from("lister_batches")
          .update({
            status: "running",
            sealed_connection:
              req.cookies.get(EBAY_COOKIE)?.value ?? batch.sealed_connection,
          })
          .eq("id", batch.id),
      );
      checked(
        await db()
          .from("lister_jobs")
          .upsert(
            items.map((item) => ({
              item_id: item.id,
              revision: 1,
              stage: "analyze",
            })),
            { onConflict: "item_id,revision,stage", ignoreDuplicates: true },
          ),
      );
      const jobs = checked(
        await db()
          .from("lister_jobs")
          .select("*")
          .in(
            "item_id",
            items.map((i) => i.id),
          )
          .eq("stage", "analyze"),
      );
      for (const job of jobs.filter((j) => j.status === "failed"))
        checked(
          await db()
            .from("lister_jobs")
            .update({
              status: "queued",
              attempts: job.attempts + 1,
              error: null,
            })
            .eq("id", job.id)
            .eq("status", "failed"),
        );
      const queued = checked(
        await db()
          .from("lister_jobs")
          .select("id,attempts")
          .in(
            "item_id",
            items.map((i) => i.id),
          )
          .eq("status", "queued"),
      );
      if (queued.length)
        await inngest.send(
          queued.map((job) => ({
            id: `${job.id}-${job.attempts}`,
            name: "lister/draft.requested",
            data: { jobId: job.id },
          })),
        );
      return NextResponse.json({ ok: true });
    }
    if (body.action === "status") {
      const items = checked(
        await db()
          .from("lister_items")
          .select("id,client_id,draft")
          .eq("batch_id", batch.id),
      );
      const jobs = checked(
        await db()
          .from("lister_jobs")
          .select("id,item_id,status,error")
          .in(
            "item_id",
            items.map((i) => i.id),
          ),
      );
      const known = new Set(
        z
          .array(clientId)
          .max(1000)
          .parse(body.knownIds ?? []),
      );
      const pendingResults = jobs.filter(
        (j) =>
          j.status === "succeeded" &&
          !known.has(items.find((i) => i.id === j.item_id)!.client_id),
      );
      const results = pendingResults.length
        ? checked(
            await db()
              .from("lister_jobs")
              .select("id,result")
              .in(
                "id",
                pendingResults.slice(0, 5).map((j) => j.id),
              ),
          )
        : [];
      return NextResponse.json({
        ok: true,
        status: batch.status,
        moreResults: pendingResults.length > 5,
        items: items.map((i) => ({
          clientId: i.client_id,
          draft: i.draft,
          job: (() => {
            const job = jobs.find((j) => j.item_id === i.id);
            const result = results.find((r) => r.id === job?.id)?.result;
            return job
              ? {
                  ...job,
                  result: result
                    ? {
                        prepared: result.prepared,
                        analysis: { usage: result.analysis?.usage ?? [] },
                        research: result.research,
                      }
                    : undefined,
                }
              : undefined;
          })(),
        })),
      });
    }
    throw new Error("Unknown batch action.");
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error:
          e instanceof z.ZodError
            ? "Invalid batch input."
            : (e as Error).message,
      },
      { status: 400 },
    );
  }
}
