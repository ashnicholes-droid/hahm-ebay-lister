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

it("stores a 500-photo batch separately from frequent listing edits and preserves upload detail", async () => {
  const photos = Array.from({ length: 500 }, (_, i) => ({
    id: `large-${i}`,
    data: "analysis",
    previewUrl: "thumb",
    mediaType: "image/jpeg",
    uploadData: "high-detail",
  }));
  const draft = {
    version: 1 as const,
    photos,
    groups: [],
    orphanIds: [],
    binPrefix: "B",
    skuStart: 0,
    step: "listings" as const,
    updatedAt: 1,
  };
  await saveDraft(draft);
  const light = await loadDraft(true);
  expect(light?.photos).toHaveLength(500);
  expect(light?.photos[0].uploadData).toBeUndefined();
  expect(light?.photos[0].data).toBe("analysis");
  await saveDraft({ ...draft, photos: light!.photos, updatedAt: 2 });
  const full = await loadDraft();
  expect(full?.photos[499].uploadData).toBe("high-detail");
  const manifest = await new Promise<any>((resolve) => {
    const r = indexedDB.open("listing-writer-drafts");
    r.onsuccess = () => {
      const db = r.result;
      const get = db
        .transaction("workspace")
        .objectStore("workspace")
        .get("current");
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
    };
  });
  expect(manifest.photos[0]).toEqual({
    id: "large-0",
    analysisSelected: undefined,
  });
  expect(JSON.stringify(manifest).length).toBeLessThan(15000);
});
