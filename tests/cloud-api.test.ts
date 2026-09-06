import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cloud/route";
beforeEach(() => {
  vi.stubEnv("APP_SECRET", "test-cloud-secret");
  vi.stubEnv("CLOUD_BATCH_ENABLED", "true");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  vi.stubEnv("INNGEST_EVENT_KEY", "test");
  vi.stubEnv("INNGEST_SIGNING_KEY", "test");
  vi.stubEnv("SESSION_SECRET", "x".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
function request(body: unknown, secret = true, cookie = "") {
  return new NextRequest("https://test.example/api/cloud", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
      ...(secret ? { "x-app-secret": "test-cloud-secret" } : {}),
      cookie,
    },
    body: JSON.stringify(body),
  });
}
it("rejects unauthenticated cloud access before touching storage", async () => {
  const r = await POST(request({ action: "status" }, false));
  expect(r.status).toBe(401);
});
it("rejects a forged cloud owner even with the shared app access code", async () => {
  const r = await POST(
    request(
      { action: "status", batchId: crypto.randomUUID() },
      true,
      "lister_cloud_owner=forged",
    ),
  );
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("browser");
});
it("rejects oversized batches before creating any database rows", async () => {
  const groups = Array.from({ length: 101 }, (_, i) => ({
    id: `g${i}`,
    name: "Item",
    sku: `S${i}`,
    photoIds: [`p${i}`],
  }));
  const r = await POST(
    request({ action: "create", batchId: crypto.randomUUID(), groups }),
  );
  expect(r.status).toBe(400);
});
it("rejects duplicate item IDs and mismatched analysis photos before creating a batch", async () => {
  const g = { id: "g1", name: "Item", sku: "S1", photoIds: ["p1"] };
  expect(
    (await POST(request({ action: "create", groups: [g, g] }))).status,
  ).toBe(400);
  expect(
    (
      await POST(
        request({
          action: "create",
          groups: [{ ...g, analysisPhotoIds: ["someone-elses-photo"] }],
        }),
      )
    ).status,
  ).toBe(400);
});
it("keeps cloud endpoints off until explicitly enabled", async () => {
  vi.stubEnv("CLOUD_BATCH_ENABLED", "false");
  expect((await POST(request({ action: "create" }))).status).toBe(503);
});
