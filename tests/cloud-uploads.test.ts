import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cloud = vi.hoisted(() => ({ db: vi.fn(), ownedBatch: vi.fn() }));
vi.mock("@/lib/cloud/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloud/store")>()),
  ...cloud,
}));
import { POST } from "@/app/api/cloud/route";
import { newOwner } from "@/lib/cloud/store";

const batchId = "12345678-1234-4123-8123-123456789012";
const signUpload = vi.fn();
const selectPhotos = vi.fn();

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "test-cloud-secret");
  vi.stubEnv("CLOUD_BATCH_ENABLED", "true");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  vi.stubEnv("INNGEST_EVENT_KEY", "test");
  vi.stubEnv("INNGEST_SIGNING_KEY", "test");
  vi.stubEnv("SESSION_SECRET", "x".repeat(64));
  vi.clearAllMocks();
  cloud.ownedBatch.mockResolvedValue({ id: batchId, status: "draft" });
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: selectPhotos,
  };
  cloud.db.mockReturnValue({
    from: vi.fn(() => query),
    storage: { from: vi.fn(() => ({ createSignedUploadUrl: signUpload })) },
  });
  signUpload.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://example.supabase.co/${path}` },
    error: null,
  }));
});
afterEach(() => vi.unstubAllEnvs());

function photo(client_id: string, state: string) {
  return {
    client_id,
    state,
    bucket_id: "lister-photos-preview",
    object_path: `owner/${batchId}/${client_id}`,
  };
}
function request(photoIds: string[]) {
  return new NextRequest("https://test.example/api/cloud", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-secret": "test-cloud-secret",
      "x-forwarded-for": crypto.randomUUID(),
      cookie: `lister_cloud_owner=${newOwner().cookie}`,
    },
    body: JSON.stringify({ action: "upload-links", batchId, photoIds }),
  });
}

it("resumes a mixed chunk without granting overwrites for confirmed photos", async () => {
  selectPhotos.mockResolvedValue({
    data: [photo("saved", "uploaded"), photo("unfinished", "pending")],
    error: null,
  });
  const response = await POST(request(["saved", "unfinished"]));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.uploadedIds).toEqual(["saved"]);
  expect(result.links.map((link: { id: string }) => link.id)).toEqual([
    "unfinished",
  ]);
  expect(signUpload).toHaveBeenCalledTimes(2);
  expect(
    signUpload.mock.calls.every(([path]) => path.includes("/unfinished/")),
  ).toBe(true);
});

it("resumes a fully confirmed chunk without requesting any upload grants", async () => {
  selectPhotos.mockResolvedValue({
    data: [photo("saved", "uploaded")],
    error: null,
  });
  const response = await POST(request(["saved"]));
  expect(await response.json()).toEqual({
    ok: true,
    links: [],
    uploadedIds: ["saved"],
  });
  expect(signUpload).not.toHaveBeenCalled();
});

it("still rejects a photo outside the owned batch, even beside a confirmed photo", async () => {
  selectPhotos.mockResolvedValue({
    data: [photo("saved", "uploaded")],
    error: null,
  });
  const response = await POST(request(["saved", "other-batch-photo"]));
  expect(response.status).toBe(400);
  expect(signUpload).not.toHaveBeenCalled();
});

it("still refuses upload grants once draft generation has started", async () => {
  cloud.ownedBatch.mockResolvedValue({ id: batchId, status: "running" });
  const response = await POST(request(["unfinished"]));
  expect(response.status).toBe(400);
  expect(selectPhotos).not.toHaveBeenCalled();
  expect(signUpload).not.toHaveBeenCalled();
});
