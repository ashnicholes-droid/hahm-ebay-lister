import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
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
