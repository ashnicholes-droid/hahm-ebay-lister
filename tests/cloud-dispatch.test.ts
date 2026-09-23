import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cloud = vi.hoisted(() => ({ db: vi.fn(), ownedBatch: vi.fn() }));
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloud/store")>()),
  ...cloud,
}));
vi.mock("@/lib/cloud/inngest", () => ({ inngest: { send } }));
import { POST } from "@/app/api/cloud/route";
import { newOwner } from "@/lib/cloud/store";

const batchId = "12345678-1234-4123-8123-123456789012";
let tables: Record<string, any[]>;
let updates: Array<{ table: string; patch: any }>;

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "test-cloud-secret");
  vi.stubEnv("CLOUD_BATCH_ENABLED", "true");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  vi.stubEnv("INNGEST_EVENT_KEY", "test");
  vi.stubEnv("INNGEST_SIGNING_KEY", "test");
  vi.stubEnv("SESSION_SECRET", "x".repeat(64));
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  tables = {
    lister_batches: [{ id: batchId, status: "draft" }],
    lister_items: [{ id: "item-1", batch_id: batchId, revision: 1 }],
    lister_photos: [{ batch_id: batchId, state: "uploaded" }],
    lister_jobs: [
      {
        id: "job-1",
        item_id: "item-1",
        revision: 1,
        stage: "analyze",
        status: "queued",
        attempts: 0,
        result: null,
        error: null,
      },
    ],
  };
  updates = [];
  cloud.ownedBatch.mockImplementation(async () => ({
    ...tables.lister_batches[0],
  }));
  cloud.db.mockReturnValue({
    from(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let patch: any;
      return {
        select() {
          return this;
        },
        eq(key: string, value: unknown) {
          filters.push((row) => row[key] === value);
          return this;
        },
        neq(key: string, value: unknown) {
          filters.push((row) => row[key] !== value);
          return this;
        },
        in(key: string, values: unknown[]) {
          filters.push((row) => values.includes(row[key]));
          return this;
        },
        // These tests start with the existing job. The route's upsert preserves it.
        upsert() {
          return this;
        },
        update(value: any) {
          patch = value;
          return this;
        },
        then(resolve: (result: any) => unknown) {
          const rows = tables[table].filter((row) =>
            filters.every((f) => f(row)),
          );
          if (patch) {
            updates.push({ table, patch });
            rows.forEach((row) => Object.assign(row, patch));
          }
          return Promise.resolve({
            data: structuredClone(rows),
            error: null,
          }).then(resolve);
        },
      };
    },
  });
  send.mockResolvedValue({ ids: ["event-1"] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(action: "start" | "retry") {
  return new NextRequest("https://test.example/api/cloud", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-secret": "test-cloud-secret",
      "x-forwarded-for": crypto.randomUUID(),
      cookie: `lister_cloud_owner=${newOwner().cookie}`,
    },
    body: JSON.stringify({ action, batchId }),
  });
}

it("keeps a rejected delivery queued and retries the same event without touching photos", async () => {
  send.mockRejectedValueOnce(
    new Error(
      "Inngest API Error: 401 Cannot send events to an archived environment",
    ),
  );
  const failed = await POST(request("start"));
  expect(failed.status).toBe(503);
  const body = await failed.json();
  expect(body.code).toBe("BACKGROUND_DISPATCH_FAILED");
  expect(body.error).toContain("Your photos are saved");
  expect(body.error).not.toContain("401");
  expect(tables.lister_jobs[0]).toMatchObject({
    status: "queued",
    attempts: 0,
  });

  expect((await POST(request("retry"))).status).toBe(200);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[1][0]).toEqual([
    { id: "job-1-0", name: "lister/draft.requested", data: { jobId: "job-1" } },
  ]);
  expect(updates.some((u) => u.table === "lister_photos")).toBe(false);
});

it("does not requeue running or completed work when retrying waiting jobs", async () => {
  tables.lister_items.push(
    { id: "item-2", batch_id: batchId, revision: 1 },
    { id: "item-3", batch_id: batchId, revision: 1 },
  );
  tables.lister_jobs.push(
    {
      id: "job-running",
      item_id: "item-2",
      stage: "analyze",
      status: "running",
      attempts: 0,
    },
    {
      id: "job-done",
      item_id: "item-3",
      stage: "analyze",
      status: "succeeded",
      attempts: 0,
    },
  );
  expect((await POST(request("retry"))).status).toBe(200);
  expect(send.mock.calls[0][0].map((event: any) => event.data.jobId)).toEqual([
    "job-1",
  ]);
  expect(tables.lister_jobs.map((j) => j.status)).toEqual([
    "queued",
    "running",
    "succeeded",
  ]);
});

it("preserves completed analysis when retrying a failed job", async () => {
  Object.assign(tables.lister_jobs[0], {
    status: "failed",
    attempts: 2,
    error: "Preparation failed",
    result: { analysis: { listing: { title: "Saved analysis" } } },
  });
  expect((await POST(request("retry"))).status).toBe(200);
  expect(tables.lister_jobs[0]).toMatchObject({
    status: "queued",
    attempts: 3,
    error: null,
    result: { analysis: { listing: { title: "Saved analysis" } } },
  });
  expect(send.mock.calls[0][0][0].id).toBe("job-1-3");
});
