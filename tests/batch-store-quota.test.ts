import { describe, expect, it, beforeEach, afterEach } from "vitest";

// Photos now carry two encodings — ~1024px for the model and ~1600px for eBay
// — so a saved batch takes roughly three times the space it did. On a phone
// that is a real chance of filling the storage quota partway through a big
// batch, and the old behaviour there was to lose the entire save: an hour of
// photographing gone because the last few photos wouldn't fit.
//
// So a quota failure now retries WITHOUT the big copies. The batch survives;
// photos restored from it publish at the smaller size, which costs eBay's zoom
// and is reported to the seller rather than done quietly.
//
// IndexedDB isn't in the Node test environment, so this drives batchStore
// against a small fake that models the one thing under test: a byte ceiling
// that aborts a transaction the way a real quota does.

interface Rec {
  value: unknown;
  key: string;
}

class FakeStore {
  constructor(private tx: FakeTx) {}
  put(value: unknown, key: string) {
    this.tx.pending.push({ value, key });
    return {};
  }
}

class FakeTx {
  pending: Rec[] = [];
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private db: FakeDb) {
    // Settle after the caller has attached its handlers, like a real one.
    setTimeout(() => this.settle(), 0);
  }
  objectStore() {
    return new FakeStore(this);
  }
  private settle() {
    const next = new Map(this.db.data);
    for (const r of this.pending) next.set(r.key, r.value);
    const size = [...next.values()].reduce<number>((n, v) => n + JSON.stringify(v).length, 0);
    if (size > this.db.quota) {
      const e = new Error("The quota has been exceeded.");
      e.name = "QuotaExceededError";
      this.error = e;
      this.db.aborts++;
      this.onabort?.();
      return;
    }
    this.db.data = next;
    this.oncomplete?.();
  }
}

class FakeDb {
  data = new Map<string, unknown>();
  quota = Infinity;
  aborts = 0;
  objectStoreNames = { contains: () => true };
  createObjectStore() {}
  transaction() {
    return new FakeTx(this);
  }
  close() {}
}

let db: FakeDb;

beforeEach(async () => {
  db = new FakeDb();
  (globalThis as any).indexedDB = {
    open() {
      const req: any = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
});

afterEach(() => {
  delete (globalThis as any).indexedDB;
});

const load = async () => (await import("@/lib/batchStore")).savePhotos;

const photo = (id: string, dataKb: number, fullKb: number | null) => ({
  id,
  previewUrl: "blob:never-persisted",
  mediaType: "image/jpeg",
  data: "d".repeat(dataKb * 1024),
  ...(fullKb === null ? {} : { full: "f".repeat(fullKb * 1024) }),
});

describe("saving photos with room to spare", () => {
  it("keeps the big copy, so a restored batch still publishes at full size", async () => {
    const saved = await (await load())([photo("a", 200, 600)] as any);
    expect(saved.degraded).toBe(false);
    expect((db.data.get("a") as any).full).toBeTruthy();
  });

  it("never persists the preview URL, which is dead on the next load", async () => {
    await (await load())([photo("a", 10, 20)] as any);
    expect(db.data.get("a")).not.toHaveProperty("previewUrl");
  });

  it("omits the big copy entirely when the photo never had one", async () => {
    await (await load())([photo("a", 10, null)] as any);
    expect(db.data.get("a")).not.toHaveProperty("full");
  });
});

describe("saving photos into storage that is nearly full", () => {
  it("drops the big copies rather than losing the batch", async () => {
    // Room for the small copies but not the large ones.
    db.quota = 900 * 1024;
    const saved = await (await load())([
      photo("a", 100, 600),
      photo("b", 100, 600),
    ] as any);
    expect(saved.degraded).toBe(true);
    expect(db.aborts).toBe(1);
    // The batch is still there — that is the whole point.
    expect([...db.data.keys()].sort()).toEqual(["a", "b"]);
    expect(db.data.get("a")).not.toHaveProperty("full");
    expect((db.data.get("a") as any).data).toHaveLength(100 * 1024);
  });

  it("still fails loudly when even the small copies don't fit", async () => {
    // Degrading is a fallback, not a way to pretend a save happened.
    db.quota = 10;
    await expect((await load())([photo("a", 100, 600)] as any)).rejects.toThrow(/quota/i);
  });

  it("does not retry pointlessly when there were no big copies to shed", async () => {
    db.quota = 10;
    await expect((await load())([photo("a", 100, null)] as any)).rejects.toThrow(/quota/i);
    expect(db.aborts).toBe(1);
  });
});
