import { test, expect, type Page } from "@playwright/test";
const photo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
async function seed(page: Page, count: number, unfinished = false) {
  let optionsCalls = 0;
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/ebay/options", (r) => {
    optionsCalls++;
    return r.fulfill({
      json: {
        ok: true,
        options: {
          fulfillment: [
            {
              id: "usual",
              name: "USPS Ground Advantage ($7.95), 2 day handling",
            },
            { id: "heavy", name: "$9.95" },
          ],
          payment: [{ id: "pay", name: "Managed Payments" }],
          returns: [
            { id: "ret", name: "Returns Accepted,Seller,30 Days,Money Back#1" },
          ],
          locations: [
            { id: "home", name: "Hustle at Home Mom HQ · 84095 · US" },
          ],
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.evaluate(
    async ({ count, photo, unfinished }) => {
      const photos = Array.from({ length: count * 5 }, (_, i) => ({
        id: `p${i}`,
        mediaType: "image/png",
        previewUrl: photo,
        data: photo.split(",")[1],
        uploadData: photo.split(",")[1],
      }));
      const groups = Array.from({ length: count }, (_, i) => ({
        id: `g${i}`,
        sku: `BATCH-${i}`,
        name: `Item ${i}`,
        photoIds: photos.slice(i * 5, i * 5 + 5).map((p) => p.id),
        status: unfinished ? "idle" : "done",
        listing: {
          title: `Item ${i}`,
          description: "Seller description",
          size: "M",
          category_id: "123",
          ebay_condition: "PRE_OWNED_EXCELLENT",
          suggested_price: 30,
          item_specifics: { "Size Type": "Regular" },
        },
        preparation: {
          categoryId: "123",
          categoryName: "Shirts",
          aspects: [],
          conditions: [
            { value: "PRE_OWNED_EXCELLENT", label: "Pre-owned Excellent" },
          ],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      }));
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("listing-writer-drafts");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("workspace", "readwrite");
          tx.objectStore("workspace").put(
            {
              version: 1,
              photos,
              groups,
              orphanIds: [],
              binPrefix: "BATCH",
              skuStart: 0,
              step: "listings",
              updatedAt: Date.now(),
            },
            "current",
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { count, photo, unfinished },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();
  return () => optionsCalls;
}
for (const count of [10, 25, 100])
  test(`${count} items: one policy load, edits persist, bounded publication with no duplicates`, async ({
    page,
  }, testInfo) => {
    const started = Date.now();
    const optionsCalls = await seed(page, count);
    await expect(
      page.getByRole("button", {
        name: `🚀 Post all ${count} to eBay`,
        exact: true,
      }),
    ).toBeEnabled();
    expect(optionsCalls()).toBe(1);
    await expect(page.locator(".batch-table tbody > tr")).toHaveCount(
      Math.min(count, 25),
    );
    await page
      .getByLabel("Title BATCH-0", { exact: true })
      .fill("Reviewed first item");
    await page.getByLabel("Select BATCH-0", { exact: true }).check();
    await page
      .getByLabel("Shipping for selected", { exact: true })
      .selectOption("heavy");
    await page
      .getByRole("button", { name: "Apply shipping", exact: true })
      .click();
    await expect(
      page.getByLabel("Shipping BATCH-0", { exact: true }),
    ).toHaveValue("heavy");
    await expect(page.getByRole("status")).toContainText(
      "Saved on this device",
    );
    await page.reload();
    await expect(page.getByLabel("Title BATCH-0", { exact: true })).toHaveValue(
      "Reviewed first item",
    );
    await expect(
      page.getByLabel("Shipping BATCH-0", { exact: true }),
    ).toHaveValue("heavy");
    const skus: string[] = [];
    let active = 0,
      maximum = 0;
    await page.route("**/api/ebay/upload-photos", async (r) => {
      const { images } = r.request().postDataJSON();
      return r.fulfill({
        json: {
          ok: true,
          urls: images.map(
            (_: unknown, i: number) => `https://i.ebayimg.com/${i}.jpg`,
          ),
        },
      });
    });
    await page.route("**/api/ebay/publish", async (r) => {
      const body = r.request().postDataJSON();
      active++;
      maximum = Math.max(maximum, active);
      skus.push(body.sku);
      if (body.sku === "BATCH-0") {
        expect(body.listing.title).toBe("Reviewed first item");
        expect(body.shipping.fulfillmentPolicyId).toBe("heavy");
      }
      expect(body.expectedPhotoCount).toBe(5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return r.fulfill({
        json: { success: true, listingId: `listing-${body.sku}` },
      });
    });
    await page
      .getByRole("button", {
        name: `🚀 Post all ${count} to eBay`,
        exact: true,
      })
      .click();
    await expect(page.locator(".result-head .badge")).toContainText(
      `${count} posted`,
      { timeout: 30000 },
    );
    expect(skus).toHaveLength(count);
    expect(new Set(skus).size).toBe(count);
    expect(maximum).toBe(2);
    await testInfo.attach("simulated-batch-metrics", {
      body: JSON.stringify({
        items: count,
        photos: count * 5,
        policyRequestsPerLoad: optionsCalls() / 2,
        maxConcurrentPublish: maximum,
        published: skus.length,
        totalTestMs: Date.now() - started,
        externalAPIs: "mocked; not real AI/eBay throughput",
      }),
      contentType: "application/json",
    });
  });
test("paused publication resumes only the selected items", async ({ page }) => {
  await seed(page, 10);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const skus: string[] = [];
  await page.route("**/api/ebay/upload-photos", async (r) => {
    await hold;
    return r.fulfill({
      json: {
        ok: true,
        urls: Array.from(
          { length: r.request().postDataJSON().images.length },
          (_, i) => `https://i.ebayimg.com/${i}.jpg`,
        ),
      },
    });
  });
  await page.route("**/api/ebay/publish", (r) => {
    const sku = r.request().postDataJSON().sku;
    skus.push(sku);
    return r.fulfill({ json: { success: true, listingId: sku } });
  });
  for (const i of [0, 1, 2])
    await page.getByLabel(`Select BATCH-${i}`, { exact: true }).check();
  await page
    .getByRole("button", { name: "Post selected ready (3)", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause batch", exact: true }).click();
  release();
  await expect(
    page.getByRole("button", { name: "Resume batch", exact: true }),
  ).toBeVisible();
  expect(skus).toHaveLength(2);
  await page.getByRole("button", { name: "Resume batch", exact: true }).click();
  await expect(page.locator(".result-head .badge")).toContainText("3 posted");
  expect(skus.sort()).toEqual(["BATCH-0", "BATCH-1", "BATCH-2"]);
});
test("batch table fits a phone and exposes missing fields through attention filter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 100);
  await page.getByLabel("Price BATCH-0", { exact: true }).fill("");
  await page.getByLabel("Show", { exact: true }).selectOption("attention");
  await expect(page.locator(".batch-table tbody > tr")).toHaveCount(1);
  await expect(
    page.getByText("Enter a positive price.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/batch-phone.png",
    fullPage: true,
  });
});

test("100 draft writes use three workers; failed items retry without rewriting successes", async ({
  page,
}) => {
  await seed(page, 100, true);
  let analyzeCalls = 0,
    active = 0,
    maximum = 0,
    failOnce = true;
  await page.route("**/api/analyze", async (r) => {
    analyzeCalls++;
    active++;
    maximum = Math.max(maximum, active);
    const fail = analyzeCalls === 7 && failOnce;
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    if (fail) {
      failOnce = false;
      return r.fulfill({
        status: 422,
        json: { ok: false, error: "Simulated analysis failure" },
      });
    }
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Generated shirt",
          description: "Reviewed description",
          suggested_price: 30,
          size: "M",
          item_specifics: {},
        },
      },
    });
  });
  await page.route("**/api/ebay/prepare", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          ...r.request().postDataJSON().listing,
          category_id: "123",
          ebay_condition: "PRE_OWNED_EXCELLENT",
        },
        preparation: {
          categoryId: "123",
          categoryName: "Shirts",
          aspects: [],
          conditions: [
            { value: "PRE_OWNED_EXCELLENT", label: "Pre-owned Excellent" },
          ],
          signature: "test",
          expiresAt: Date.now() + 3600000,
          issues: [],
        },
      },
    }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false } }),
  );
  await page
    .getByRole("button", { name: "Write / retry 100 remaining", exact: true })
    .click();
  await expect(page.locator(".result-head .badge")).toContainText(
    "99/100 drafts written",
    { timeout: 30000 },
  );
  await expect(
    page.getByRole("button", {
      name: "Write / retry 1 remaining",
      exact: true,
    }),
  ).toBeEnabled();
  expect(analyzeCalls).toBe(100);
  expect(maximum).toBe(3);
  await page
    .getByRole("button", { name: "Write / retry 1 remaining", exact: true })
    .click();
  await expect(page.locator(".result-head .badge")).toContainText(
    "100/100 drafts written",
  );
  expect(analyzeCalls).toBe(101);
});
