import type { ItemGroup, Photo } from "./types";
export interface WorkspaceDraft {
  version: 1;
  photos: Photo[];
  groups: ItemGroup[];
  orphanIds: string[];
  binPrefix: string;
  skuStart: number;
  step: "upload" | "review" | "listings";
  updatedAt: number;
}
const DB = "listing-writer-drafts";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 3);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("workspace"))
        r.result.createObjectStore("workspace");
      if (!r.result.objectStoreNames.contains("photos"))
        r.result.createObjectStore("photos");
      if (!r.result.objectStoreNames.contains("assets"))
        r.result.createObjectStore("assets");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(
        new Error(
          "Close other lister tabs, then reload to update photo storage.",
        ),
      );
  });
}
export function lightPhoto(p: Photo): Photo {
  const { original, uploadData, ...rest } = p;
  return rest;
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export async function loadPhoto(
  id: string,
  lightweight = false,
): Promise<Photo | undefined> {
  const photo = await get<Photo>("photos", id);
  if (!photo) return undefined;
  return lightweight
    ? lightPhoto(photo)
    : { ...photo, ...(await get<Partial<Photo>>("assets", id)) };
}
export async function savePhoto(photo: Photo) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["photos", "assets"], "readwrite");
      tx.objectStore("photos").put(lightPhoto(photo), photo.id);
      if (photo.original || photo.uploadData)
        tx.objectStore("assets").put(
          { original: photo.original, uploadData: photo.uploadData },
          photo.id,
        );
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function loadDraft(
  lightweight = false,
): Promise<WorkspaceDraft | null> {
  const d = await get<WorkspaceDraft>("workspace", "current");
  if (!d) return null;
  if (d.version !== 1 || !Array.isArray(d.photos) || !Array.isArray(d.groups))
    throw new Error("Saved draft version cannot be restored.");
  // Migrate existing production drafts before dropping any large assets from memory.
  const photos: Photo[] = [];
  for (const p of d.photos) {
    if (p.data) await savePhoto(p);
    const stored = await loadPhoto(p.id, lightweight);
    if (!stored)
      throw new Error(
        "A saved photo is missing. Keep this tab open and restore the original photo.",
      );
    photos.push({ ...stored, analysisSelected: p.analysisSelected });
  }
  d.photos = photos;
  d.groups = d.groups.map((g: ItemGroup) => ({
    ...g,
    status: g.status === "writing" ? "idle" : g.status,
    postStatus: g.postStatus === "posting" ? "error" : g.postStatus,
    postError:
      g.postStatus === "posting"
        ? "Publication was interrupted. Retry to check eBay before posting again."
        : g.postError,
  }));
  return d;
}
let queue: Promise<void> = Promise.resolve();
const saved = new WeakSet<Photo>();
export function saveDraft(draft: WorkspaceDraft): Promise<void> {
  queue = queue
    .catch(() => {})
    .then(async () => {
      const db = await openDb();
      const assets = draft.photos.filter((p) => !saved.has(p));
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            ["workspace", "photos", "assets"],
            "readwrite",
          );
          for (const p of assets) {
            tx.objectStore("photos").put(lightPhoto(p), p.id);
            if (p.original || p.uploadData)
              tx.objectStore("assets").put(
                { original: p.original, uploadData: p.uploadData },
                p.id,
              );
          }
          const previous = tx.objectStore("workspace").get("current");
          const ids = new Set(draft.photos.map((p) => p.id));
          previous.onsuccess = () => {
            for (const p of previous.result?.photos ?? [])
              if (!ids.has(p.id)) {
                tx.objectStore("photos").delete(p.id);
                tx.objectStore("assets").delete(p.id);
              }
          };
          tx.objectStore("workspace").put(
            {
              ...draft,
              photos: draft.photos.map((p) => ({
                id: p.id,
                analysisSelected: p.analysisSelected,
              })),
            },
            "current",
          );
          tx.oncomplete = () => {
            assets.forEach((p) => saved.add(p));
            resolve();
          };
          tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    });
  return queue;
}
