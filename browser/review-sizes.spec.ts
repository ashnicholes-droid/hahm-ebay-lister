import { test, expect, type Page } from "@playwright/test";

// Review table fit, shoe-size syncing, and missing-specifics highlighting.
const photo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const SHOE_SIZES = Array.from({ length: 23 }, (_, i) => String(4 + i / 2));
const SHOTS = process.env.REVIEW_SHOTS_DIR;

async function seedShoes(page: Page) {
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/ebay/options", (r) =>
    r.fulfill({
      json: {
        ok: true,
        options: {
          fulfillment: [
            { id: "usual", name: "USPS Ground Advantage ($7.95), 2 day handling" },
          ],
          payment: [{ id: "pay", name: "Managed Payments" }],
          returns: [{ id: "ret", name: "Returns Accepted,Seller,30 Days" }],
          locations: [{ id: "home", name: "HQ · 84095 · US" }],
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page.evaluate(
    async ({ photo, sizes }) => {
      const sel = (name: string, required: boolean, values: string[]) => ({
        name,
        required,
        usage: required ? "REQUIRED" : "RECOMMENDED",
        mode: "SELECTION_ONLY",
        cardinality: "SINGLE",
        values,
      });
      const items = [
        ["Nike x Undercover Moc Flow DV5593-001 Chaos Balance Slip-On Shoes Men's US 9", "US 9"],
        ["Allen Edmonds Men's Black Leather Bicycle Toe Oxford Dress Shoes 9 D", "9 D"],
        ["Vans x Peanuts Sk8-Hi Black Leather Snoopy Woodstock Sneakers Men 4.5 Women 6", "US Men 4.5 / Women 6"],
      ];
      const photos = items.map((_, i) => ({
        id: `p${i}`,
        mediaType: "image/png",
        previewUrl: photo,
        data: photo.split(",")[1],
      }));
      const groups = items.map(([title, size], i) => ({
        id: `g${i}`,
        sku: `SHOE-${i}`,
        name: title,
        photoIds: [`p${i}`],
        status: "done",
        listing: {
          title,
          description: "Seller description",
          size,
          category: "mens_shoes",
          category_id: "93427",
          ebay_condition: "PRE_OWNED_EXCELLENT",
          suggested_price: 84,
          item_specifics: { Department: "Men", "US Shoe Size": "9" },
        },
        preparation: {
          categoryId: "93427",
          categoryName: "Men's Shoes",
          aspects: [
            sel("Brand", true, ["Nike", "Vans", "Allen Edmonds"]),
            sel("Department", true, ["Men", "Women"]),
            sel("US Shoe Size", true, sizes),
            sel("Shoe Width", false, ["Narrow", "Medium", "Wide", "Extra Wide"]),
            sel("Color", false, ["Black", "White", "Gray"]),
          ],
          conditions: [{ value: "PRE_OWNED_EXCELLENT", label: "Pre-owned Excellent" }],
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
              binPrefix: "SHOE",
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
    { photo, sizes: SHOE_SIZES },
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your listings" })).toBeVisible();
}

for (const width of [1440, 1024])
  test(`batch table shows photo through status without side-scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seedShoes(page);
    const scroll = page.locator(".batch-table-scroll");
    const overflow = await scroll.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("columnheader", { name: "Status / details" })).toBeInViewport();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-${width}.png`, fullPage: true });
  });

test("editing the size updates US Shoe Size, converting EU to US", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedShoes(page);
  await page.getByLabel("Size SHOE-0", { exact: true }).fill("EU 44");
  await page.getByRole("button", { name: "Review details" }).first().click();
  await expect(page.getByLabel("US Shoe Size", { exact: true })).toHaveValue("10");
  await page.getByLabel("Size SHOE-0", { exact: true }).fill("US 9.5 D");
  await expect(page.getByLabel("US Shoe Size", { exact: true })).toHaveValue("9.5");
  await expect(page.getByLabel("Shoe Width", { exact: true })).toHaveValue("Medium");
});

test("empty required and recommended specifics are highlighted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedShoes(page);
  await page.getByRole("button", { name: "Review details" }).first().click();
  const summary = page.locator(".specifics-missing-summary");
  await expect(summary).toContainText("Required, still empty: Brand.");
  await expect(summary).toContainText("Recommended, still empty: Shoe Width, Color.");
  await expect(page.locator(".specific-missing-required")).toHaveCount(1);
  await expect(page.locator(".specific-missing-required")).toContainText("Brand");
  const color = await page
    .locator(".specific-missing-required .specific-name")
    .evaluate((el) => getComputedStyle(el).fontWeight);
  expect(Number(color)).toBeGreaterThanOrEqual(700);
  if (SHOTS)
    await page.locator(".specifics-missing-summary").locator("..").screenshot({
      path: `${SHOTS}/specifics.png`,
    });
  await page.getByLabel("Brand", { exact: true }).selectOption("Nike");
  await expect(summary).not.toContainText("Required");
});
