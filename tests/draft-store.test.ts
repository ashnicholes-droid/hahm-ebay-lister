import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { saveDraft, loadDraft } from "@/lib/draft-store";
it("restores drafts, photo blobs and interrupted publishing safely", async () => {
  const blob = new Blob(["original photo"]);
  await saveDraft({
    version: 1,
    photos: [
      {
        id: "p",
        data: "aGVsbG8=",
        previewUrl: "data:image/jpeg;base64,aGVsbG8=",
        mediaType: "image/jpeg",
        original: blob,
      },
    ],
    groups: [
      {
        id: "g",
        sku: "unique",
        name: "item",
        photoIds: ["p"],
        status: "done",
        listing: { title: "Saved", description: "Edited" },
        postStatus: "posting",
      },
    ],
    orphanIds: [],
    binPrefix: "B",
    skuStart: 0,
    step: "listings",
    updatedAt: 1,
  });
  const d = await loadDraft();
  expect(d?.groups[0].listing?.description).toBe("Edited");
  expect(d?.groups[0].postStatus).toBe("error");
  expect(await d?.photos[0].original?.text()).toBe("original photo");
});
