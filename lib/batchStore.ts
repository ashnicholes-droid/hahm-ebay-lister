"use client";

// Keeping an in-progress batch alive across a closed tab.
//
// Everything about a batch — the photos, the written listings, every edit and
// accuracy verdict — lived only in React state. Reload, close the tab, or let a
// phone reclaim the page and an hour of photographing and editing was gone with
// no warning and no way back. For a lister meant to work forty items at a time
// that isn't a missing feature, it's data loss.
//
// IndexedDB rather than localStorage because the photos are the bulk of it:
// three hundred resized JPEGs is tens of megabytes and localStorage caps out
// around five.
//
// Two stores, and the split matters. Photo bytes are written once at import and
// never touched again; the session (groups, step, counters) is small and
// rewritten on every keystroke. Putting them together would mean rewriting
// sixty megabytes because someone edited a title.

import type { ItemGroup, Photo } from "./types";

const DB_NAME = "listing-writer";
const DB_VERSION = 1;
const PHOTO_STORE = "photos";
const SESSION_STORE = "session";
const SESSION_KEY = "current";

/** Bump when the saved shape changes incompatibly; older saves are discarded. */
const SCHEMA = 1;

export interface SavedSession {
  schema: number;
  savedAt: number;
  step: string;
  groups: ItemGroup[];
  orphanIds: string[];
  binPrefix: string;
  skuStart: number;
  intakeMode: string;
  photoIds: string[];
}

export interface RestoredBatch {
  session: SavedSession;
  photos: Photo[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no IndexedDB, so batches can't be saved."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open local storage."));
  });
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Local storage write failed."));
  });
}

/**
 * A photo without its preview URL.
 *
 * `previewUrl` is an object URL — a pointer into this page's memory. Persisting
 * one would store a string that is already dead on the next load, and restoring
 * it would render broken images. It is rebuilt from the bytes on restore.
 */
type StoredPhoto = Omit<Photo, "previewUrl">;

export interface SavePhotosResult {
  /**
   * True when the 1600px eBay copies had to be dropped to fit.
   *
   * The batch is still fully recoverable; photos restored from it publish at
   * the 1024px analysis size instead, which costs eBay's buyer zoom. Worth
   * saying out loud rather than silently downgrading someone's listings.
   */
  degraded: boolean;
}

/**
 * Persist photo bytes.
 *
 * Photos now carry TWO encodings — 1024px for the model, 1600px for eBay — so a
 * batch takes roughly three times the space it used to. That is a real risk of
 * filling a phone's quota mid-batch, and the old behaviour there was to lose the
 * whole save. So a quota failure retries WITHOUT the big copies: half a loaf,
 * reported, beats an hour of photographing gone.
 */
export async function savePhotos(photos: Photo[]): Promise<SavePhotosResult> {
  if (photos.length === 0) return { degraded: false };
  const db = await openDb();
  const write = (dropFull: boolean) =>
    new Promise<void>((resolve, reject) => {
      const t = db.transaction(PHOTO_STORE, "readwrite");
      const store = t.objectStore(PHOTO_STORE);
      for (const p of photos) {
        const { previewUrl: _drop, full, ...rest } = p;
        const record = dropFull || !full ? rest : { ...rest, full };
        store.put(record as StoredPhoto, p.id);
      }
      t.oncomplete = () => resolve();
      // put() can throw QuotaExceededError synchronously as well as aborting
      // the transaction, so both paths have to land in the same rejection.
      t.onabort = () => reject(t.error ?? new Error("Couldn't save photos."));
      t.onerror = () => reject(t.error ?? new Error("Couldn't save photos."));
    });

  try {
    await write(false);
    db.close();
    return { degraded: false };
  } catch (e) {
    if (!isQuotaError(e) || !photos.some((p) => p.full)) {
      db.close();
      throw e;
    }
    try {
      await write(true);
      return { degraded: true };
    } finally {
      db.close();
    }
  }
}

export async function saveSession(session: Omit<SavedSession, "schema" | "savedAt">): Promise<void> {
  const db = await openDb();
  await tx(db, SESSION_STORE, "readwrite", (s) =>
    s.put({ ...session, schema: SCHEMA, savedAt: Date.now() }, SESSION_KEY)
  );
  db.close();
}

/** Metadata only — enough to offer a restore without reading every photo. */
export async function peekSession(): Promise<SavedSession | null> {
  try {
    const db = await openDb();
    const saved = await tx<SavedSession | undefined>(db, SESSION_STORE, "readonly", (s) =>
      s.get(SESSION_KEY)
    );
    db.close();
    if (!saved || saved.schema !== SCHEMA) return null;
    // An empty batch is not worth offering to restore.
    if (!saved.photoIds?.length && !saved.groups?.length) return null;
    return saved;
  } catch {
    return null;
  }
}

/**
 * Read the whole batch back.
 *
 * Statuses are repaired on the way out: anything caught mid-flight when the tab
 * died ("writing", "posting") can't still be running, and leaving it that way
 * would show a spinner that never resolves and a Post button that never
 * re-enables.
 */
export async function restoreBatch(): Promise<RestoredBatch | null> {
  const session = await peekSession();
  if (!session) return null;

  const db = await openDb();
  const stored = await Promise.all(
    session.photoIds.map((id) =>
      tx<StoredPhoto | undefined>(db, PHOTO_STORE, "readonly", (s) => s.get(id))
    )
  );
  db.close();

  const photos: Photo[] = stored
    .filter((p): p is StoredPhoto => Boolean(p?.data))
    .map((p) => ({ ...p, previewUrl: dataUrl(p) }));

  const groups = session.groups.map((g) => ({
    ...g,
    status: g.status === "writing" ? ("idle" as const) : g.status,
    verifying: false,
    postStatus: g.postStatus === "posting" ? ("idle" as const) : g.postStatus,
  }));

  return { session: { ...session, groups }, photos };
}

/** Rebuild a displayable URL from the stored bytes. */
function dataUrl(p: StoredPhoto): string {
  return p.data.startsWith("data:") ? p.data : `data:${p.mediaType};base64,${p.data}`;
}

export async function clearBatch(): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, SESSION_STORE, "readwrite", (s) => s.clear());
    await tx(db, PHOTO_STORE, "readwrite", (s) => s.clear());
    db.close();
  } catch {
    /* nothing saved, or storage unavailable — either way there's nothing to do */
  }
}

/** Drop photo records no longer referenced by the session. */
export async function prunePhotos(keepIds: string[]): Promise<void> {
  try {
    const keep = new Set(keepIds);
    const db = await openDb();
    const ids = await tx<IDBValidKey[]>(db, PHOTO_STORE, "readonly", (s) => s.getAllKeys());
    await new Promise<void>((resolve) => {
      const t = db.transaction(PHOTO_STORE, "readwrite");
      const store = t.objectStore(PHOTO_STORE);
      for (const id of ids) if (!keep.has(String(id))) store.delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* best effort */
  }
}

/** How long ago a save happened, in words. */
export function savedAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * Is this failure the storage being full?
 *
 * Worth separating: a quota error means the batch is too big to save but the
 * app is otherwise fine, and the seller should be told to post and clear rather
 * than shown a generic failure they can't act on.
 */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  return name === "QuotaExceededError" || /quota/i.test(String((e as Error)?.message ?? ""));
}
