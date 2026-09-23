import { inngest } from "./inngest";
import { db, checked, environment } from "./store";
import { analyzePhotos } from "@/lib/services/analyze";
import { prepareListing } from "@/lib/services/prepare";
import { researchListing } from "@/lib/services/research";
import { NonRetriableError } from "inngest";

async function context(jobId: string) {
  const job = checked(
    await db().from("lister_jobs").select("*").eq("id", jobId).single(),
  );
  const item = checked(
    await db().from("lister_items").select("*").eq("id", job.item_id).single(),
  );
  const batch = checked(
    await db()
      .from("lister_batches")
      .select("*")
      .eq("id", item.batch_id)
      .single(),
  );
  if (
    job.stage !== "analyze" ||
    job.revision !== item.revision ||
    batch.environment !== environment() ||
    Date.parse(batch.expires_at) < Date.now() ||
    job.status === "cancelled"
  )
    throw new NonRetriableError("Batch expired or unavailable.");
  return { job, item, batch };
}
async function images(batchId: string, ids: string[]) {
  const rows = checked(
    await db()
      .from("lister_photos")
      .select("*")
      .eq("batch_id", batchId)
      .in("client_id", ids),
  );
  return Promise.all(
    ids.map(async (id) => {
      const row = rows.find((r: any) => r.client_id === id);
      if (!row || row.state !== "uploaded")
        throw new NonRetriableError("A photo upload is incomplete.");
      const blob = checked(
        await db()
          .storage.from(row.bucket_id)
          .download(row.object_path + "/analysis.jpg"),
      );
      return {
        mediaType: "image/jpeg",
        data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
      };
    }),
  );
}
async function runStage(jobId: string, stage: "analysis" | "prepared") {
  const { job, item, batch } = await context(jobId);
  if (job.result?.[stage]) return;
  checked(
    await db()
      .from("lister_jobs")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", jobId),
  );
  const photos = await images(
    batch.id,
    item.draft.analysisPhotoIds ?? item.draft.photoIds,
  );
  const response =
    stage === "analysis"
      ? await analyzePhotos({
          images: photos,
          profile: "auto",
          ...batch.settings,
        })
      : await prepareListing(
          {
            listing: job.result.analysis.listing,
            images: photos,
            enrich: true,
          },
          batch.sealed_connection ?? undefined,
        );
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(
      stage === "analysis"
        ? "Analysis failed. Retry this item."
        : "Category preparation failed. Reconnect eBay if needed, then retry.",
    );
  // Persist before completing the Inngest step; a redelivery reuses this output.
  checked(
    await db()
      .from("lister_jobs")
      .update({
        result: { ...job.result, [stage]: result },
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId),
  );
}
export const generateDraft = inngest.createFunction(
  {
    id: "generate-cloud-draft",
    triggers: { event: "lister/draft.requested" },
    retries: 2,
    concurrency: [{ limit: 3 }, { limit: 1, key: "event.data.jobId" }],
    onFailure: async ({ event }) => {
      const id = event.data.event.data.jobId;
      if (typeof id === "string")
        checked(
          await db()
            .from("lister_jobs")
            .update({
              status: "failed",
              error:
                "Background draft failed. Retry to resume completed stages.",
            })
            .eq("id", id)
            .neq("status", "succeeded"),
        );
    },
  },
  async ({ event, step }) => {
    const id = event.data.jobId;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      throw new NonRetriableError("Invalid job.");
    await step.run("analyze-and-save", () => runStage(id, "analysis"));
    await step.run("prepare-and-save", () => runStage(id, "prepared"));
    await step.run("research-and-save", async () => {
      const { job } = await context(id);
      if (job.result?.research) return;
      const response = await researchListing({
        listing: job.result.prepared.listing,
      });
      const research = await response.json();
      checked(
        await db()
          .from("lister_jobs")
          .update({ result: { ...job.result, research } })
          .eq("id", id),
      );
    });
    await step.run("complete", async () => {
      const { job } = await context(id);
      if (!job.result?.prepared) throw new Error("Prepared draft is missing.");
      checked(
        await db()
          .from("lister_jobs")
          .update({
            status: "succeeded",
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id),
      );
    });
    return { jobId: id };
  },
);
// Deletes expired private photo objects before removing their database references.
export const expireBatches = inngest.createFunction(
  {
    id: "expire-cloud-batches",
    triggers: { cron: "0 8 * * *" },
    concurrency: 1,
  },
  async ({ step }) => {
    await step.run("delete-expired", async () => {
      const batches = checked(
        await db()
          .from("lister_batches")
          .select("id")
          .eq("environment", environment())
          .lt("expires_at", new Date().toISOString())
          .limit(50),
      );
      for (const batch of batches) {
        const photos = checked(
          await db()
            .from("lister_photos")
            .select("bucket_id,object_path")
            .eq("batch_id", batch.id),
        );
        for (let i = 0; i < photos.length; i += 50) {
          const chunk = photos.slice(i, i + 50);
          if (chunk.length)
            checked(
              await db()
                .storage.from(chunk[0].bucket_id)
                .remove(
                  chunk.flatMap((p) => [
                    p.object_path + "/analysis.jpg",
                    p.object_path + "/upload.jpg",
                  ]),
                ),
            );
        }
        checked(await db().from("lister_batches").delete().eq("id", batch.id));
      }
    });
  },
);

// Recover the database-to-event handoff if a request dies after saving queued jobs.
export const dispatchQueued = inngest.createFunction(
  {
    id: "dispatch-queued-drafts",
    triggers: { cron: "*/5 * * * *" },
    concurrency: 1,
  },
  async ({ step }) => {
    await step.run("dispatch", async () => {
      const jobs = checked(
        await db()
          .from("lister_jobs")
          .select(
            "id,attempts,lister_items!inner(lister_batches!inner(environment,status,expires_at))",
          )
          .eq("status", "queued")
          .eq("lister_items.lister_batches.environment", environment())
          .eq("lister_items.lister_batches.status", "running")
          .gt(
            "lister_items.lister_batches.expires_at",
            new Date().toISOString(),
          )
          .limit(100),
      );
      if (jobs.length)
        await inngest.send(
          jobs.map((j) => ({
            id: `${j.id}-${j.attempts}`,
            name: "lister/draft.requested",
            data: { jobId: j.id },
          })),
        );
    });
  },
);
