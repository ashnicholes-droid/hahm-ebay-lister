import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { sortPhotos, SortUnavailableError } from "@/lib/sortPipeline";
import type { WireImage } from "@/lib/images";

// A tiny valid-looking base64 payload; content is never decoded in the pipeline.
const IMG: WireImage = { mediaType: "image/jpeg", data: "aGVsbG8=" };

function groupResponse(json: unknown): Anthropic.Message {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
  } as unknown as Anthropic.Message;
}

function mockClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("sortPhotos time budgeting", () => {
  it("caps each Anthropic call's timeout and disables SDK-internal retries", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        groupResponse({
          groups: [{ folder_name: "shirt", photo_indices: [1, 2] }],
        }),
      );

    await sortPhotos(mockClient(create), [IMG, IMG]);

    expect(create).toHaveBeenCalled();
    for (const call of create.mock.calls) {
      const options = call[1] as { timeout?: number; maxRetries?: number };
      expect(options.maxRetries).toBe(0);
      expect(options.timeout).toBeDefined();
      expect(options.timeout!).toBeLessThanOrEqual(60_000);
      expect(options.timeout!).toBeGreaterThan(0);
    }
  });

  it("skips calls entirely once the budget is exhausted", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        groupResponse({
          groups: [{ folder_name: "shirt", photo_indices: [1] }],
        }),
      );

    // Zero budget: every grouping batch is skipped → total-failure error.
    await expect(
      sortPhotos(mockClient(create), [IMG, IMG], undefined, 0),
    ).rejects.toThrow(SortUnavailableError);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns grouped results even when verify/merge budget runs out mid-run", async () => {
    let calls = 0;
    const create = vi.fn().mockImplementation(async () => {
      calls++;
      // First call: grouping succeeds. Later calls (verify/merge) stall past
      // their per-call timeout budget — simulate by rejecting like a timeout.
      if (calls === 1) {
        return groupResponse({
          groups: [
            { folder_name: "shirt", photo_indices: [1, 2] },
            { folder_name: "mug", photo_indices: [3] },
          ],
        });
      }
      const err = new Error("Request timed out.") as Error & {
        status?: number;
      };
      throw err; // status undefined → retryable, but budget-bounded
    });

    // Small budget: grouping fits, but verify/merge retries are cut off by the
    // deadline instead of looping through the full backoff schedule.
    const result = await sortPhotos(
      mockClient(create),
      [IMG, IMG, IMG],
      undefined,
      6_000,
    );

    expect(result.groups.map((g) => g.name)).toEqual(["shirt", "mug"]);
    expect(result.groups[0].photoIndices).toEqual([0, 1]);
    expect(result.orphanIndices).toEqual([]);
  });
});

for (const recover of [true, false]) {
  it(`keeps detail recovery evidence-gated (${recover})`, async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        groupResponse({
          groups: [{ folder_name: "knit", photo_indices: [1, 2, 3] }],
        }),
      )
      .mockResolvedValueOnce(
        groupResponse({ valid: false, keep_indices: [1, 2] }),
      )
      .mockResolvedValueOnce(
        groupResponse(
          recover
            ? {
                group: 1,
                detailPhoto: true,
                evidence: "Same ribbed seam and contrasting cuff construction",
              }
            : { group: 0, detailPhoto: false, evidence: "" },
        ),
      );
    const result = await sortPhotos(mockClient(create), [IMG, IMG, IMG]);
    expect(result.groups[0].photoIndices).toEqual(recover ? [0, 1, 2] : [0, 1]);
    expect(result.orphanIndices).toEqual(recover ? [] : [2]);
    expect(create).toHaveBeenCalledTimes(3);
  });
}
