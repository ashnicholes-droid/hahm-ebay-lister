import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);

test("queued drafts can be retried after delivery failure and reload without uploading again", async ({
  page,
  context,
}) => {
  let groups: any[] = [];
  let status: string | undefined;
  const actions: string[] = [];
  let uploads = 0;
  await context.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: false } }),
  );
  await context.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await context.route("**/api/ebay/options", (r) =>
    r.fulfill({ json: { ok: false, error: "Connect eBay" } }),
  );
  await context.route("**/api/cloud", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { enabled: true } });
    const body = r.request().postDataJSON();
    actions.push(body.action);
    if (body.action === "create") groups = body.groups;
    if (body.action === "upload-links")
      return r.fulfill({
        json: {
          ok: true,
          links: body.photoIds.map((id: string) => ({
            id,
            analysis: "http://127.0.0.1:3190/mock-upload",
            upload: "http://127.0.0.1:3190/mock-upload",
          })),
        },
      });
    if (body.action === "start") {
      status = "queued";
      return r.fulfill({
        status: 503,
        json: {
          ok: false,
          code: "BACKGROUND_DISPATCH_FAILED",
          error:
            "Your photos are saved, but background processing is unavailable.",
        },
      });
    }
    if (body.action === "retry") status = "running";
    if (body.action === "status")
      return r.fulfill({
        json: {
          ok: true,
          status: status ? "running" : "draft",
          items: groups.map((g) => ({
            clientId: g.id,
            draft: g,
            job: status ? { status } : undefined,
          })),
        },
      });
    return r.fulfill({ json: { ok: true } });
  });
  await context.route("**/mock-upload", (r) => {
    uploads++;
    return r.fulfill({ status: 200, body: "{}" });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "shirt.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page
    .getByRole("button", {
      name: "Write unfinished drafts in background",
      exact: true,
    })
    .click();
  const panel = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Background drafts",
        exact: true,
      }),
    });
  await expect(panel.getByRole("alert")).toContainText("Your photos are saved");
  await expect(
    panel.getByText("0/1 cloud drafts finished · 1 queued"),
  ).toBeVisible({ timeout: 10000 });
  await expect(panel).not.toContainText("Processing");
  await expect(
    panel.getByRole("button", { name: "Retry 1 unfinished item", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("Saved on this device");

  await page.reload();
  await panel
    .getByRole("button", { name: "Retry 1 unfinished item", exact: true })
    .click();
  await expect(panel).toContainText(
    "Retry submitted; saved photos and completed analysis will be reused.",
  );
  await expect(
    panel.getByText("0/1 cloud drafts finished · Processing"),
  ).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(actions.filter((action) => action === "create")).toHaveLength(1);
  expect(actions.filter((action) => action === "upload-links")).toHaveLength(1);
  expect(actions.filter((action) => action === "start")).toHaveLength(1);
  expect(actions.filter((action) => action === "retry")).toHaveLength(1);
  expect(uploads).toBe(2);
});

test("cloud drafts finish after closing the tab and preserve subsequent edits", async ({
  page,
  context,
}) => {
  let groups: any[] = [];
  let started = false,
    finished = false;
  await context.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: false } }),
  );
  await context.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await context.route("**/api/ebay/options", (r) =>
    r.fulfill({ json: { ok: false, error: "Connect eBay" } }),
  );
  await context.route("**/api/cloud", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { enabled: true } });
    const b = r.request().postDataJSON();
    if (b.action === "create") {
      groups = b.groups;
      return r.fulfill({ json: { ok: true, batchId: b.batchId } });
    }
    if (b.action === "upload-links")
      return r.fulfill({
        json: {
          ok: true,
          links: b.photoIds.map((id: string) => ({
            id,
            analysis: "http://127.0.0.1:3190/mock-upload",
            upload: "http://127.0.0.1:3190/mock-upload",
          })),
        },
      });
    if (b.action === "start") started = true;
    if (b.action === "status")
      return r.fulfill({
        json: {
          ok: true,
          status: started ? "running" : "draft",
          items: groups.map((g) => ({
            clientId: g.id,
            draft: g,
            job: started
              ? {
                  status: finished ? "succeeded" : "running",
                  result: {
                    analysis: { usage: [] },
                    prepared: {
                      listing: {
                        title: "Cloud shirt",
                        description: "Visible shirt",
                        suggested_price: 30,
                        item_specifics: {},
                        category_id: "123",
                      },
                      preparation: {
                        categoryId: "123",
                        categoryName: "Shirts",
                        aspects: [],
                        conditions: [],
                        expiresAt: Date.now() + 3600000,
                        signature: "test",
                        issues: [],
                      },
                      usage: [],
                    },
                  },
                }
              : undefined,
          })),
        },
      });
    return r.fulfill({ json: { ok: true } });
  });
  await context.route("**/mock-upload", (r) =>
    r.fulfill({ status: 200, body: "{}" }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "shirt.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page
    .getByRole("button", {
      name: "Write unfinished drafts in background",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Batch submitted. You can close this tab; return here to see the drafts.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.close();
  finished = true;
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.locator(".title-input")).toHaveValue("Cloud shirt");
  await reopened.locator(".title-input").fill("My reviewed shirt");
  await reopened.waitForTimeout(5500);
  await expect(reopened.locator(".title-input")).toHaveValue(
    "My reviewed shirt",
  );
  await expect(reopened.getByRole("status")).toContainText(
    "Saved on this device",
  );
  await reopened.reload();
  await expect(reopened.locator(".title-input")).toHaveValue(
    "My reviewed shirt",
  );
});

test("resumes an interrupted photo batch after reload without uploading confirmed chunks again", async ({
  page,
  context,
}) => {
  let groups: any[] = [];
  let creates = 0;
  let failUpload = true;
  const uploaded = new Set<string>();
  const puts: string[] = [];
  const confirmations: string[][] = [];
  await context.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: false } }),
  );
  await context.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await context.route("**/api/ebay/options", (r) =>
    r.fulfill({ json: { ok: false, error: "Connect eBay" } }),
  );
  await context.route("**/api/cloud", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { enabled: true } });
    const b = r.request().postDataJSON();
    if (b.action === "create") {
      creates++;
      groups = b.groups;
    }
    if (b.action === "upload-links")
      return r.fulfill({
        json: {
          ok: true,
          uploadedIds: b.photoIds.filter((id: string) => uploaded.has(id)),
          links: b.photoIds
            .filter((id: string) => !uploaded.has(id))
            .map((id: string) => ({
              id,
              analysis: `http://127.0.0.1:3190/mock-upload/${id}/analysis`,
              upload: `http://127.0.0.1:3190/mock-upload/${id}/upload`,
            })),
        },
      });
    if (b.action === "confirm-uploads") {
      confirmations.push(b.photoIds);
      b.photoIds.forEach((id: string) => uploaded.add(id));
    }
    if (b.action === "status")
      return r.fulfill({
        json: {
          ok: true,
          status: "draft",
          items: groups.map((g) => ({ clientId: g.id, draft: g })),
        },
      });
    return r.fulfill({ json: { ok: true } });
  });
  await context.route("**/mock-upload/**", (r) => {
    puts.push(r.request().url());
    // The first 20-photo chunk is confirmed before the last photo fails.
    return r.fulfill({
      status: uploaded.size === 20 && failUpload ? 503 : 200,
      body: "{}",
    });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page.locator("input[type=file]").setInputFiles(
    Array.from({ length: 21 }, (_, i) => ({
      name: `shirt-${i}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page
    .getByRole("button", {
      name: "Write unfinished drafts in background",
      exact: true,
    })
    .click();
  const cloudPanel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Background drafts", exact: true }),
  });
  await expect(cloudPanel.getByRole("alert")).toContainText(
    "Photo upload failed",
  );
  expect(uploaded.size).toBe(20);
  const confirmed = new Set(uploaded);
  await expect(page.getByRole("status")).toContainText("Saved on this device");

  failUpload = false;
  await page.reload();
  await expect(page.getByText("0/1 cloud drafts finished")).toBeVisible();
  await page
    .getByRole("button", {
      name: "Write unfinished drafts in background",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Batch submitted. You can close this tab; return here to see the drafts.",
    ),
  ).toBeVisible();
  expect(creates).toBe(1);
  expect(uploaded.size).toBe(21);
  expect(confirmations.map((ids) => ids.length)).toEqual([20, 1]);
  for (const id of confirmed) {
    expect(puts.filter((url) => url.includes(`/${id}/`))).toHaveLength(2);
  }
  await expect(cloudPanel.getByRole("alert")).toHaveCount(0);
});
