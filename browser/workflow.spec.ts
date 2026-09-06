import { test, expect, Page } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
async function setup(page: Page) {
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Canon R5 Camera",
          description: "Visible scuff. Untested.",
          brand: "Canon",
          item_type: "Camera",
          condition: "GOOD",
          suggested_price: 200,
          item_specifics: { Brand: "Canon", Model: "R5" },
        },
        usage: [],
      },
    }),
  );
  await page.route("**/api/ebay/prepare", (r) => {
    const l = r.request().postDataJSON().listing;
    return r.fulfill({
      json: {
        ok: true,
        listing: { ...l, category_id: "625", ebay_condition: "" },
        preparation: {
          categoryId: "625",
          categoryName: "Cameras",
          aspects: [
            {
              name: "Brand",
              required: true,
              usage: "REQUIRED",
              mode: "FREE_TEXT",
              cardinality: "SINGLE",
              values: [],
            },
          ],
          conditions: [{ value: "USED_EXCELLENT", label: "Used" }],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      },
    });
  });
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false, error: "Research unavailable" } }),
  );
  await page.route("**/api/ebay/options", (r) =>
    r.fulfill({
      json: {
        ok: true,
        options: {
          fulfillment: [{ id: "ship", name: "My shipping" }],
          payment: [{ id: "pay", name: "My payment" }],
          returns: [{ id: "ret", name: "My returns" }],
          locations: [{ id: "home", name: "My real origin" }],
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
}
async function draft(page: Page) {
  await page.locator("input[type=file]").setInputFiles([
    { name: "front.png", mimeType: "image/png", buffer: png },
    { name: "label.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(2);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(page.getByText("Cameras", { exact: true })).toBeVisible();
}
async function shipping(page: Page) {
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
  await page
    .getByLabel("eBay condition", { exact: true })
    .selectOption("USED_EXCELLENT");
  await page
    .getByRole("button", { name: "Load my eBay policies and locations" })
    .click();
  await page
    .getByLabel("Shipping policy", { exact: true })
    .selectOption("ship");
  await page.getByLabel("Payment policy", { exact: true }).selectOption("pay");
  await page.getByLabel("Return policy", { exact: true }).selectOption("ret");
  await page
    .getByLabel("Shipping origin", { exact: true })
    .selectOption("home");
  for (const [label, value] of [
    ["Packed weight (oz)", "24"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "6"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
}
test("retains good photos when one cannot decode; preserves original blobs across reload", async ({
  page,
}) => {
  await setup(page);
  await page.locator("input[type=file]").setInputFiles([
    { name: "valid.png", mimeType: "image/png", buffer: png },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("bad") },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(1);
  await expect(page.locator(".note-error")).toContainText("broken.png");
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(page.locator(".thumb")).toHaveCount(1);
});
test("restores edited drafts and blocks publication with missing facts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await draft(page);
  await page.locator(".title-input").fill("Seller reviewed camera");
  await page.getByLabel("Brand", { exact: true }).fill("");
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(page.locator(".title-input")).toHaveValue(
    "Seller reviewed camera",
  );
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});
test("partial image upload stops publication; retry preserves reviewed fields", async ({
  page,
}) => {
  let calls = 0;
  let fail = true;
  await setup(page);
  await page.route("**/api/ebay/upload-photos", (r) =>
    r.fulfill({
      json: {
        ok: true,
        urls: fail
          ? ["https://i.ebayimg.com/1.jpg"]
          : ["https://i.ebayimg.com/1.jpg", "https://i.ebayimg.com/2.jpg"],
      },
    }),
  );
  await page.route("**/api/ebay/publish", (r) => {
    calls++;
    const b = r.request().postDataJSON();
    expect(b.listing.title).toBe("Canon R5 Camera");
    expect(b.shipping.weightOz).toBe(24);
    expect(b.expectedPhotoCount).toBe(2);
    return r.fulfill({ json: { success: true, listingId: "12345" } });
  });
  await draft(page);
  await shipping(page);
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(
    page.getByText(/Some selected photos failed to upload/),
  ).toBeVisible();
  expect(calls).toBe(0);
  fail = false;
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(
    page.getByText("Posted to eBay", { exact: false }),
  ).toBeVisible();
  expect(calls).toBe(1);
});
test("second tab cannot overwrite the active workspace", async ({
  page,
  context,
}) => {
  await setup(page);
  await expect(page.getByText("Saved on this device")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByText(/already open in another tab/)).toBeVisible();
  await other.close();
});

test("late preparation never overwrites a seller edit", async ({ page }) => {
  await setup(page);
  await draft(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/ebay/prepare", async (r) => {
    started();
    await pending;
    await r.fulfill({
      json: {
        ok: true,
        listing: {
          ...r.request().postDataJSON().listing,
          title: "Stale AI response",
        },
        preparation: {},
      },
    });
  });
  await page
    .getByRole("button", { name: "Prepare category and specifics" })
    .click();
  await called;
  await page.locator(".title-input").fill("My newer correction");
  finish();
  await expect(
    page.getByText(
      "The draft changed while preparing. Prepare it again to keep your edits.",
    ),
  ).toBeVisible();
  await expect(page.locator(".title-input")).toHaveValue("My newer correction");
});
test("phone review fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await draft(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/phone-review.png",
    fullPage: true,
  });
});
