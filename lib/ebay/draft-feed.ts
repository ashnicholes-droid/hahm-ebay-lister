import { gunzipSync } from "zlib";
const EBAY_FEED_BASE =
  process.env.EBAY_FEED_BASE ||
  "https://api.ebay.com/sell/feed/v1";

const MARKETPLACE_ID = "EBAY_US";

const CSV_INFO_LINES = [
  "#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,",
  "#INFO Action and Category ID are required fields. 1) Set Action to Draft 2) Please find the category ID for your listings here: https://pages.ebay.com/sellerinformation/news/categorychanges.html,,,,,,,,,,",
  '"#INFO After you\'ve successfully uploaded your draft from the Seller Hub Reports tab, complete your drafts to active listings here: https://www.ebay.com/sh/lst/drafts",,,,,,,,,,',
  "#INFO,,,,,,,,,,",
];

export interface SellerHubDraftInput {
  sku: string;
  categoryId: string;
  title: string;
  upc?: string;
  price: number;
  quantity?: number;
  imageUrls: string[];
  conditionId: number;
  description: string;
}

export interface SellerHubDraftResult {
  success: boolean;
  taskId?: string;
  status?: string;
  error?: string;
  resultFile?: string;
}

interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
  json: any;
  headers: Headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function cleanHtmlDescription(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) return "";

  // Preserve existing HTML descriptions.
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed;
  }

  return trimmed
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        `<p>${line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</p>`
    )
    .join("");
}

function validateInput(input: SellerHubDraftInput): void {
  if (!input.sku.trim()) {
    throw new Error("A SKU is required.");
  }

  if (!input.categoryId.trim()) {
    throw new Error("An eBay category ID is required.");
  }

  if (!input.title.trim()) {
    throw new Error("A title is required.");
  }

  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new Error(`Invalid price: ${input.price}`);
  }

  if (!input.imageUrls.some(Boolean)) {
    throw new Error("At least one eBay-hosted photo URL is required.");
  }

  if (!Number.isInteger(input.conditionId) || input.conditionId <= 0) {
    throw new Error(`Invalid condition ID: ${input.conditionId}`);
  }
}

function buildDraftCsv(input: SellerHubDraftInput): string {
  validateInput(input);

  /*
   * These first 11 columns exactly match the template you downloaded.
   * Location and PostalCode are appended to force the draft's item location.
   */
  const headers = [
    "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)",
    "Custom label (SKU)",
    "Category ID",
    "Title",
    "UPC",
    "Price",
    "Quantity",
    "Item photo URL",
    "Condition ID",
    "Description",
    "Format",
  ];

  const imageUrls = input.imageUrls
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 12);

  const row = [
    "Draft",
    input.sku.trim(),
    input.categoryId.trim(),
    input.title.trim().slice(0, 80),
    input.upc?.trim() || "",
    input.price.toFixed(2),
    String(input.quantity ?? 1),

    // eBay File Exchange/Seller Hub feeds accept multiple URLs separated by |.
    imageUrls.join("|"),

    String(input.conditionId),
    cleanHtmlDescription(input.description),
    "FixedPrice",
  ];

  return (
    "\uFEFF" +
    [...CSV_INFO_LINES, headers.map(csvCell).join(","), row.map(csvCell).join(","), ""].join(
      "\r\n"
    )
  );
}

async function request(
  accessToken: string,
  method: string,
  url: string,
  options: {
    body?: BodyInit;
    contentType?: string;
  } = {}
): Promise<HttpResult> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      ...(options.contentType
        ? { "Content-Type": options.contentType }
        : {}),
    },
    body: options.body,
    cache: "no-store",
  });

  const text = await response.text();

  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Some Feed API responses have no JSON body.
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
    headers: response.headers,
  };
}

function ebayError(response: HttpResult): string {
  const error = response.json?.errors?.[0];

  if (error) {
    return String(
      error.longMessage ||
        error.message ||
        `eBay HTTP ${response.status}`
    );
  }

  return (
    response.text.slice(0, 600) ||
    `eBay returned HTTP ${response.status}.`
  );
}

async function createTask(accessToken: string): Promise<string> {
  const response = await request(
    accessToken,
    "POST",
    `${EBAY_FEED_BASE}/task`,
    {
      contentType: "application/json",
      body: JSON.stringify({
        feedType: "FX_LISTING",
        schemaVersion: "1.0",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Could not create eBay draft task: ${ebayError(response)}`
    );
  }

  /*
   * createTask has no JSON response body. eBay returns a URL such as:
   * https://api.ebay.com/sell/feed/v1/task/task-123456789
   * in the Location response header.
   */
  const location = response.headers.get("location") || "";
  const taskId = location.split("/").filter(Boolean).pop() || "";

  if (!taskId) {
    throw new Error(
      "eBay accepted the task request but did not return a task ID."
    );
  }

  return taskId;
}

async function uploadCsv(
  accessToken: string,
  taskId: string,
  csv: string
): Promise<void> {
  const form = new FormData();

  form.append(
    "file",
    new Blob([csv], {
      type: "text/csv;charset=utf-8",
    }),
    `seller-hub-draft-${Date.now()}.csv`
  );

  /*
   * Do not manually set multipart/form-data here.
   * fetch adds the required boundary to the Content-Type header.
   */
  const response = await fetch(
    `${EBAY_FEED_BASE}/task/${encodeURIComponent(
      taskId
    )}/upload_file`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      },
      body: form,
      cache: "no-store",
    }
  );

  const text = await response.text();

  if (!response.ok) {
    let message = text;

    try {
      const json = JSON.parse(text);
      message =
        json?.errors?.[0]?.longMessage ||
        json?.errors?.[0]?.message ||
        text;
    } catch {
      // Keep raw response.
    }

    throw new Error(
      `Could not upload the eBay draft CSV (${response.status}): ${
        message || "No response body"
      }`
    );
  }
}

async function getTask(
  accessToken: string,
  taskId: string
): Promise<any> {
  const response = await request(
    accessToken,
    "GET",
    `${EBAY_FEED_BASE}/task/${encodeURIComponent(taskId)}`
  );

  if (!response.ok) {
    throw new Error(
      `Could not check eBay draft task: ${ebayError(response)}`
    );
  }

  return response.json;
}

async function downloadResult(
  accessToken: string,
  taskId: string
): Promise<string> {
  const response = await fetch(
    `${EBAY_FEED_BASE}/task/${encodeURIComponent(
      taskId
    )}/download_result_file`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      },
      cache: "no-store",
    }
  );

  if (!response.ok) return "";

  const bytes = Buffer.from(await response.arrayBuffer());

  // eBay's Feed API always returns this file gzip-compressed, regardless of
  // what the Content-Type header claims. Detect it by the gzip magic bytes
  // (1f 8b) rather than trusting the header, and decompress before reading.
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  try {
    const text = isGzip ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
    return text.slice(0, 10_000);
  } catch (e) {
    return `Could not read eBay's result file (${bytes.length} bytes, gzip=${isGzip}): ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
}

async function waitForCompletion(
  accessToken: string,
  taskId: string
): Promise<{
  status: string;
  task: any;
}> {
  const deadline = Date.now() + 150_000;

  while (Date.now() < deadline) {
    const task = await getTask(accessToken, taskId);
    const status = String(task?.status || "").toUpperCase();

    if (
      status === "COMPLETED" ||
      status === "COMPLETED_WITH_ERROR" ||
      status === "PARTIALLY_PROCESSED" ||
      status === "FAILED"
    ) {
      return { status, task };
    }

    await sleep(3_000);
  }

  throw new Error(
    `eBay accepted draft task ${taskId}, but processing did not finish within 150 seconds.`
  );
}

export async function createSellerHubDraft(
  accessToken: string,
  input: SellerHubDraftInput
): Promise<SellerHubDraftResult> {
  try {
    const csv = buildDraftCsv(input);
    const taskId = await createTask(accessToken);

    console.log("[ebay/draft] task created", {
      taskId,
      sku: input.sku,
    });

    await uploadCsv(accessToken, taskId, csv);

    console.log("[ebay/draft] CSV uploaded", {
      taskId,
      sku: input.sku,
    });

    const completed = await waitForCompletion(
      accessToken,
      taskId
    );

    const resultFile = await downloadResult(
      accessToken,
      taskId
    );

    if (completed.status !== "COMPLETED") {
      console.error("[ebay/draft] feed failed", {
        taskId,
        sku: input.sku,
        status: completed.status,
        task: completed.task,
        resultFile,
      });

      return {
        success: false,
        taskId,
        status: completed.status,
        resultFile,
        error:
          resultFile ||
          `eBay completed the draft task with status ${completed.status}.`,
      };
    }

    console.log("[ebay/draft] Seller Hub draft created", {
      taskId,
      sku: input.sku,
      location: "Marshall, IL 62441",
    });

    return {
      success: true,
      taskId,
      status: completed.status,
      resultFile,
    };
  } catch (error) {
    console.error("[ebay/draft] unhandled error", error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown eBay draft error.",
    };
  }
}