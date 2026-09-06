"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runBatch, type QueueProgress } from "@/lib/batch-queue";
import {
  loadDraft,
  saveDraft,
  savePhoto,
  loadPhoto,
  lightPhoto,
} from "@/lib/draft-store";
import { processFiles } from "@/lib/intake";
import { draftIssues } from "@/lib/client-review";
import { apiPost } from "@/lib/api-client";
import { getAnalysisModel, getSortModel } from "@/lib/model-preferences";
import { resizeImage } from "@/lib/resize";
import { buildSku } from "@/lib/sku";
import { chunkImagesForUpload } from "@/lib/uploadBatches";
import { EbayConnect } from "./EbayConnect";
import { ModelSelector } from "./ModelSelector";
import { ReviewBoard } from "./ReviewBoard";
import { ListingsView } from "./ListingsView";
import type {
  AnalyzeResponse,
  CompsSummary,
  ItemGroup,
  ListingResult,
  Photo,
  SortResponse,
} from "@/lib/types";

type Step = "upload" | "review" | "listings";
// Big batches are sorted in chunks of SORT_CHUNK photos per request — each
// chunk's thumbnail payload stays under Vercel's 4.5 MB body limit — then
// reviewed together; items crossing a chunk boundary may need manual merging.
const MAX_PHOTOS = 1000;
const SORT_CHUNK = 100;
const WRITE_CONCURRENCY = 3;
// eBay accepts at most 24 photos per listing. They ship to eBay in small
// batches (lib/uploadBatches.ts) before publish, so no single request ever
// nears Vercel's 4.5 MB body limit.
const MAX_PUBLISH_PHOTOS = 24;
// HTTP statuses worth waiting out and retrying: rate limits and transient
// platform errors.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(performance.now() * 1000)}-${Math.random()}`;
}

// Parse a fetch response as JSON, but turn non-JSON error bodies (e.g. a 413
// "Request Entity Too Large" plain-text page) into a friendly message instead
// of a cryptic "Unexpected token" error. Callers pass a hint that fits their
// step — "sort fewer photos" advice on a posting error sent sellers down the
// wrong path.
async function readJson(
  res: Response,
  tooLargeHint = "Try again with fewer or smaller photos.",
): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      throw new Error(
        `That was too much photo data to send at once. ${tooLargeHint}`,
      );
    }
    throw new Error(
      text.trim().slice(0, 140) || `Request failed (${res.status}).`,
    );
  }
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [binPrefix, setBinPrefix] = useState("");
  const [step, setStep] = useState<Step>("upload");
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [sortProgress, setSortProgress] = useState<string | null>(null);
  // Where bin lettering starts — continues after SKUs already on eBay, so a
  // second batch from bin K31 gets K31-N… instead of colliding with K31-A.
  const [skuStart, setSkuStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [restored, setRestored] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Loading saved work…");
  const [readOnly, setReadOnly] = useState(false);
  const inFlight = useRef(new Set<string>());
  const queueBusy = useRef(false);
  const queuePause = useRef(false);
  const queueIds = useRef<string[]>([]);
  const [queue, setQueue] = useState<
    | (QueueProgress & {
        kind: "write" | "post";
        running: boolean;
        paused: boolean;
      })
    | null
  >(null);
  async function startQueue(
    ids: string[],
    kind: "write" | "post",
    worker: (id: string) => Promise<void>,
  ) {
    if (queueBusy.current || !ids.length) return;
    queueBusy.current = true;
    queueIds.current = ids;
    queuePause.current = false;
    try {
      await runBatch(ids, kind === "write" ? WRITE_CONCURRENCY : 2, worker, {
        paused: () => queuePause.current,
        progress: (p) =>
          setQueue({ ...p, kind, running: true, paused: queuePause.current }),
      });
    } finally {
      queueBusy.current = false;
      setQueue(
        (q) => q && { ...q, running: false, paused: queuePause.current },
      );
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const [importProgress, setImportProgress] = useState("");

  const photoMap = useMemo(() => {
    const m = new Map<string, Photo>();
    photos.forEach((p) => m.set(p.id, p));
    return m;
  }, [photos]);
  const photoById = useCallback((id: string) => photoMap.get(id), [photoMap]);

  useEffect(() => {
    let active = true;
    let release: () => void = () => {};
    const restore = async () => {
      try {
        const d = await loadDraft(true);
        if (d && active) {
          setPhotos(d.photos);
          setGroups(d.groups);
          setOrphanIds(d.orphanIds);
          setBinPrefix(d.binPrefix);
          setSkuStart(d.skuStart);
          setStep(d.step);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setSaveStatus(
            "Autosave unavailable — keep this tab open and export drafts.",
          );
        }
      } finally {
        if (active) setRestored(true);
      }
    };
    if (navigator.locks)
      void navigator.locks.request(
        "listing-writer-workspace",
        { ifAvailable: true },
        async (lock) => {
          if (!active) return;
          if (!lock) {
            setReadOnly(true);
            setRestored(true);
            return;
          }
          await restore();
          await new Promise<void>((resolve) => {
            release = resolve;
            if (!active) resolve();
          });
        },
      );
    else void restore();
    return () => {
      active = false;
      release();
    };
  }, []);
  // Mark changed work unsaved before paint; older save completions cannot clear it.
  useLayoutEffect(() => {
    if (!restored || readOnly) return;
    let current = true;
    setSaveStatus("Saving…");
    const timer = setTimeout(() => {
      void saveDraft({
        version: 1,
        photos,
        groups,
        orphanIds,
        binPrefix,
        skuStart,
        step,
        updatedAt: Date.now(),
      })
        .then(() => {
          if (current) setSaveStatus("Saved on this device");
        })
        .catch(() => {
          if (current)
            setSaveStatus(
              "Could not save — device storage may be full. Keep this tab open and export drafts.",
            );
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    restored,
    readOnly,
    photos,
    groups,
    orphanIds,
    binPrefix,
    skuStart,
    step,
  ]);

  // Latest groups, readable inside async workers without stale closures.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Keep eBay connection status in sync (also after the connect bar updates).
  useEffect(() => {
    const check = () =>
      fetch("/api/ebay/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setEbayConnected(Boolean(d.connected)))
        .catch(() => setEbayConnected(false));
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    window.addEventListener("ebay-connection-changed", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("ebay-connection-changed", onFocus);
    };
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const addFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0 || importing.current) return;
      setError(null);
      const files = Array.from(fileList).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) {
        setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
        return;
      }
      importing.current = true;
      let processed = 0;
      setImportProgress(
        `Preparing 0 of ${Math.min(files.length, MAX_PHOTOS - photos.length)} photos…`,
      );
      try {
        const result = await processFiles(
          files,
          MAX_PHOTOS - photos.length,
          async (file) => {
            const p = { id: newId(), ...(await resizeImage(file)) };
            await savePhoto(p);
            processed++;
            setImportProgress(`Prepared ${processed} photos…`);
            return lightPhoto(p);
          },
        );
        const resized = result.values;
        if (result.errors.length) setError(result.errors.join("; "));
        setPhotos((prev) => [...prev, ...resized].slice(0, MAX_PHOTOS));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        importing.current = false;
        setImportProgress("");
      }
    },
    [photos.length],
  );

  const removePhoto = (id: string) =>
    setPhotos((prev) => prev.filter((p) => p.id !== id));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // ── Sort ────────────────────────────────────────────────
  const sort = async () => {
    if (photos.length === 0) return;
    setSorting(true);
    setError(null);
    try {
      // Continue bin lettering after any SKUs already on eBay for this bin.
      let skuOffset = 0;
      if (binPrefix.trim()) {
        try {
          const r = await apiPost("/api/ebay/next-sku", {
            prefix: binPrefix.trim(),
          });
          const d = (await readJson(r)) as { ok?: boolean; nextIndex?: number };
          if (
            d.ok &&
            Number.isInteger(d.nextIndex) &&
            (d.nextIndex as number) > 0
          ) {
            skuOffset = d.nextIndex as number;
          }
        } catch {
          /* not connected or lookup failed — start at A like before */
        }
      }

      // Sort in chunks so each request's thumbnail payload stays small.
      type RawGroup = { name: string; photoIds: string[] };
      const chunkResults: RawGroup[][] = [];
      const orphanIdsAll: string[] = [];
      for (let off = 0; off < photos.length; off += SORT_CHUNK) {
        const chunk = photos.slice(off, off + SORT_CHUNK);
        if (photos.length > SORT_CHUNK) {
          setSortProgress(
            `Sorting photos ${off + 1}–${off + chunk.length} of ${photos.length}…`,
          );
        }
        const res = await apiPost("/api/sort", {
          // Use the small thumbnail for sorting to keep the payload small.
          images: chunk.map((p) => ({
            mediaType: p.mediaType,
            data: p.previewUrl.split(",")[1],
          })),
          sortModel: getSortModel() ?? undefined,
        });
        const data = (await readJson(
          res,
          "Try sorting fewer photos per batch.",
        )) as SortResponse;
        if (!data.ok || !data.groups) {
          throw new Error(data.error || "Could not sort the photos.");
        }
        const idxToId = (i: number) => chunk[i]?.id;
        chunkResults.push(
          data.groups
            .map((g) => ({
              name: g.name,
              photoIds: g.photoIndices.map(idxToId).filter(Boolean) as string[],
            }))
            .filter((g) => g.photoIds.length > 0),
        );
        orphanIdsAll.push(
          ...((data.orphanIndices ?? [])
            .map(idxToId)
            .filter(Boolean) as string[]),
        );
      }

      // Cross-chunk identity requires review; never join physical items from one thumbnail.
      const merged: RawGroup[] = chunkResults.flat();
      const assigned = new Set<string>();
      merged.forEach((g) => g.photoIds.forEach((id) => assigned.add(id)));
      orphanIdsAll.forEach((id) => assigned.add(id));
      // Any photo the sorter never placed shouldn't vanish — surface it.
      const leftover = photos
        .filter((p) => !assigned.has(p.id))
        .map((p) => p.id);

      const nextGroups: ItemGroup[] = merged.map((g, i) => ({
        id: newId(),
        sku: `${buildSku(binPrefix, skuOffset + i).slice(0, 37)}-${newId().replace(/-/g, "").slice(0, 12)}`,
        name: g.name,
        photoIds: g.photoIds,
        status: "idle",
      }));
      setSkuStart(skuOffset);
      setGroups(nextGroups);
      setOrphanIds([...orphanIdsAll, ...leftover]);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSorting(false);
      setSortProgress(null);
    }
  };

  // ── Review edits ────────────────────────────────────────
  const rename = (groupId: string, name: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name } : g)),
    );

  const renameSku = (groupId: string, sku: string) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId &&
        !inFlight.current.has(g.id) &&
        !g.publicationAttemptSku &&
        g.postStatus !== "posted"
          ? { ...g, sku }
          : g,
      ),
    );

  const movePhoto = (photoId: string, toGroupId: string | "orphans") => {
    setGroups((prev) =>
      prev.map((g) => {
        const nextIds =
          g.id === toGroupId
            ? g.photoIds.includes(photoId)
              ? g.photoIds
              : [...g.photoIds, photoId]
            : g.photoIds.filter((id) => id !== photoId);
        // A gained/lost photo invalidates an already-written listing — reset
        // it so "Write all listings" knows to redo this one (and only this one).
        const changed = nextIds.length !== g.photoIds.length;
        return {
          ...g,
          photoIds: nextIds,
          ...(changed
            ? {
                status: "idle" as const,
                listing: undefined,
                analysisPhotoIds: undefined,
                preparation: undefined,
                comps: undefined,
                imageUrls: undefined,
                uploadedPhotoIds: undefined,
              }
            : {}),
        };
      }),
    );
    setOrphanIds((prev) => {
      const without = prev.filter((id) => id !== photoId);
      return toGroupId === "orphans" ? [...without, photoId] : without;
    });
  };

  // Reorder photos within a group. The array order is the eBay photo order
  // (index 0 = cover/gallery image), so this is all that's needed — `writeGroup`
  // and `postGroup` re-derive their image order from `photoIds` at call time.
  const reorderPhoto = (
    groupId: string,
    fromIndex: number,
    toIndex: number,
  ) => {
    if (fromIndex === toIndex) return;
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= g.photoIds.length ||
          toIndex >= g.photoIds.length
        ) {
          return g;
        }
        const next = [...g.photoIds];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return {
          ...g,
          photoIds: next,
          imageUrls: undefined,
          uploadedPhotoIds: undefined,
        };
      }),
    );
  };

  const deleteGroup = (groupId: string) =>
    setGroups((prev) => {
      const target = prev.find((g) => g.id === groupId);
      if (target && target.photoIds.length > 0) {
        setOrphanIds((o) => [...o, ...target.photoIds]);
      }
      return prev.filter((g) => g.id !== groupId);
    });

  const addGroup = () =>
    setGroups((prev) => [
      ...prev,
      {
        id: newId(),
        sku: `${buildSku(binPrefix, skuStart + prev.length).slice(0, 37)}-${newId().replace(/-/g, "").slice(0, 12)}`,
        name: `new-item-${prev.length + 1}`,
        photoIds: [],
        status: "idle",
      },
    ]);

  // ── Write listings ──────────────────────────────────────
  const writeGroup = useCallback(
    async (groupId: string) => {
      // Snapshot this group's photos from the latest state (no stale closure).
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group || inFlight.current.has(groupId)) return;
      inFlight.current.add(groupId);
      const imgs = (group.analysisPhotoIds ?? group.photoIds)
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p) && p!.analysisSelected !== false)
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, status: "writing", error: undefined } : g,
        ),
      );
      try {
        const res = await apiPost("/api/analyze", {
          profile: "auto",
          images: imgs,
          analysisModel: getAnalysisModel() ?? undefined,
          routerModel: getSortModel() ?? undefined,
        });
        const data = (await readJson(res)) as AnalyzeResponse;
        if (!data.ok || !data.listing) {
          throw new Error(data.error || "Could not write this listing.");
        }
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  status: "writing",
                  listing: data.listing,
                  evidencePhotoIds: [
                    ...(group.analysisPhotoIds ?? group.photoIds),
                  ],
                  usage: (data as any).usage ?? [],
                  preparation: undefined,
                  comps: undefined,
                  compsStatus: "loading",
                }
              : g,
          ),
        );
        // Resolve final category/schema before review, never during publication.
        let researchListing = data.listing;
        try {
          const pr = await apiPost("/api/ebay/prepare", {
            listing: data.listing,
            images: imgs,
            enrich: true,
          });
          const pd = await readJson(pr);
          if (pd.ok) researchListing = pd.listing;
          setGroups((prev) =>
            prev.map((g) =>
              g.id === groupId
                ? pd.ok
                  ? {
                      ...g,
                      status: "done",
                      listing: pd.listing,
                      preparation: pd.preparation,
                      usage: [...(g.usage ?? []), ...(pd.usage ?? [])],
                    }
                  : { ...g, status: "done", preparationError: pd.error }
                : g,
            ),
          );
        } catch (e) {
          setGroups((prev) =>
            prev.map((g) =>
              g.id === groupId
                ? {
                    ...g,
                    status: "done",
                    preparationError: (e as Error).message,
                  }
                : g,
            ),
          );
        }
        // Market price check — advisory and best-effort, so it runs in the
        // background and silently stays hidden if it can't answer.
        void (async () => {
          try {
            const res = await apiPost("/api/ebay/comps", {
              listing: researchListing,
            });
            const d = (await readJson(res)) as {
              ok?: boolean;
              comps?: CompsSummary;
            };
            if (d.ok && d.comps?.ok) {
              setGroups((prev) =>
                prev.map((g) =>
                  g.id === groupId && g.listing === researchListing
                    ? { ...g, comps: d.comps, compsStatus: "ready" }
                    : g,
                ),
              );
            } else {
              setGroups((prev) =>
                prev.map((g) =>
                  g.id === groupId && g.listing === researchListing
                    ? { ...g, compsStatus: "unavailable" }
                    : g,
                ),
              );
            }
          } catch {
            setGroups((prev) =>
              prev.map((g) =>
                g.id === groupId && g.listing === researchListing
                  ? { ...g, compsStatus: "unavailable" }
                  : g,
              ),
            );
          }
        })();
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, status: "error", error: (e as Error).message }
              : g,
          ),
        );
      } finally {
        inFlight.current.delete(groupId);
      }
    },
    [photoMap],
  );

  const writeAll = async () => {
    // Only write listings that don't exist yet. Re-running everything after a
    // trip back to the review step re-billed the AI for unchanged listings
    // (issue #30) — groups whose photos changed are reset to "idle" by
    // movePhoto, so they (and only they) get rewritten here.
    const usable = groups
      .filter((g) => g.photoIds.length > 0 && g.status !== "done")
      .map((g) => g.id);
    setStep("listings");
    if (usable.length === 0) return;
    await startQueue(usable, "write", writeGroup);
  };

  const editGroup = (id: string, patch: Partial<ItemGroup>) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );
  const editListing = (groupId: string, patch: Partial<ListingResult>) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId &&
        g.listing &&
        g.status !== "writing" &&
        g.postStatus !== "posted" &&
        g.postStatus !== "posting"
          ? {
              ...g,
              listing: {
                ...g.listing,
                ...patch,
                ...(patch.size !== undefined
                  ? {
                      item_specifics: {
                        ...g.listing.item_specifics,
                        Size: patch.size,
                      },
                      evidence: {},
                    }
                  : {}),
              },
              comps: undefined,
              compsStatus: "stale",
            }
          : g,
      ),
    );

  const postGroup = useCallback(
    async (groupId: string) => {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (
        !group ||
        !group.listing ||
        group.postStatus === "posted" ||
        inFlight.current.has(groupId)
      )
        return;
      const issues = draftIssues(group);
      if (
        groupsRef.current.some((g) => g.id !== groupId && g.sku === group.sku)
      )
        issues.push("Another item in this batch has the same SKU.");
      if (issues.length) {
        editGroup(groupId, {
          postStatus: "error",
          postError: issues.join("; "),
        });
        return;
      }
      inFlight.current.add(groupId);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? { ...g, postStatus: "posting", postError: undefined }
            : g,
        ),
      );
      try {
        const images = await Promise.all(
          group.photoIds.map(async (id) => {
            const p = (await loadPhoto(id)) ?? photoMap.get(id);
            if (!p)
              throw new Error(
                "A selected photo is missing from device storage. Add it again before posting.",
              );
            return { mediaType: p.mediaType, data: p.uploadData ?? p.data };
          }),
        );
        // 1. Ship the photos to eBay first, in batches small enough that no
        // single request can hit Vercel's 4.5 MB body limit — the old
        // all-in-one publish request 413-failed on photo-heavy listings.
        const alreadyUploaded =
          group.uploadedPhotoIds?.join(",") === group.photoIds.join(",")
            ? group.imageUrls
            : undefined;
        const imageUrls: string[] = alreadyUploaded ? [...alreadyUploaded] : [];
        let uploadedCount = 0;
        for (const batch of chunkImagesForUpload(
          alreadyUploaded ? [] : images,
        )) {
          for (let attempt = 0; ; attempt++) {
            const res = await apiPost("/api/ebay/upload-photos", {
              sku: group.sku,
              images: batch,
              startIndex: uploadedCount,
            });
            if (attempt < 2 && TRANSIENT_STATUSES.has(res.status)) {
              await sleep(res.status === 429 ? 65_000 : 8_000);
              continue;
            }
            const d = (await readJson(res)) as {
              ok?: boolean;
              error?: string;
              urls?: string[];
            };
            if (!d.ok)
              throw new Error(d.error || "Could not upload photos to eBay.");
            if (!Array.isArray(d.urls) || d.urls.length !== batch.length)
              throw new Error(
                "Some selected photos failed to upload. Nothing was published. Retry the upload.",
              );
            imageUrls.push(...d.urls);
            break;
          }
          uploadedCount += batch.length;
        }
        if (imageUrls.length === 0) {
          throw new Error("Could not upload any photos to eBay.");
        }
        if (imageUrls.length !== images.length)
          throw new Error("All selected photos must upload before posting.");
        const uploadWarnings: string[] = [];
        const uploaded = {
          ...group,
          imageUrls,
          uploadedPhotoIds: [...group.photoIds],
          postStatus: "posting" as const,
          publicationAttemptSku: group.sku,
        };
        editGroup(groupId, uploaded);
        await saveDraft({
          version: 1,
          photos: [...photoMap.values()],
          groups: groupsRef.current.map((g) =>
            g.id === groupId ? uploaded : g,
          ),
          orphanIds,
          binPrefix,
          skuStart,
          step: "listings",
          updatedAt: Date.now(),
        });
        // 2. Publish with the eBay-hosted URLs (a few KB instead of megabytes).
        let data: {
          success: boolean;
          listingId?: string;
          error?: string;
          alreadyListed?: boolean;
          warnings?: string[];
        } | null = null;
        let hadTransientRetry = false;
        for (let attempt = 0; ; attempt++) {
          const res = await apiPost("/api/ebay/publish", {
            sku: group.sku,
            listing: group.listing,
            imageUrls,
            shipping: group.shipping,
            review: group.preparation,
            expectedPhotoCount: group.photoIds.length,
          });
          // Wait out rate limits / transient platform errors instead of dying
          // mid-batch with "try again later".
          if (attempt < 2 && TRANSIENT_STATUSES.has(res.status)) {
            hadTransientRetry = true;
            await sleep(res.status === 429 ? 65_000 : 8_000);
            continue;
          }
          data = await readJson(res);
          break;
        }
        // A retried publish that finds the SKU already live means the earlier
        // attempt actually landed before the timeout — that's a success.
        if (
          data &&
          !data.success &&
          data.alreadyListed &&
          (hadTransientRetry || group.publicationAttemptSku === group.sku) &&
          data.listingId
        ) {
          data = { success: true, listingId: data.listingId };
        }
        if (!data?.success)
          throw new Error(data?.error || "eBay rejected the listing.");
        const allWarnings = [...uploadWarnings, ...(data.warnings ?? [])];
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  postStatus: "posted",
                  listingId: data!.listingId,
                  postWarnings: allWarnings.length ? allWarnings : undefined,
                }
              : g,
          ),
        );
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, postStatus: "error", postError: (e as Error).message }
              : g,
          ),
        );
      } finally {
        inFlight.current.delete(groupId);
      }
    },
    [photoMap, orphanIds, binPrefix, skuStart],
  );

  const postAll = async (selected?: string[]) => {
    const ready = groupsRef.current
      .filter(
        (g) =>
          (!selected || selected.includes(g.id)) &&
          g.status === "done" &&
          g.postStatus !== "posted" &&
          !draftIssues(g).length,
      )
      .map((g) => g.id);
    await startQueue(ready, "post", postGroup);
  };

  const usableGroups = useMemo(
    () => groups.filter((g) => g.photoIds.length > 0),
    [groups],
  );

  if (!restored) return <main className="wrap">Restoring saved work…</main>;
  if (readOnly)
    return (
      <main className="wrap">
        This workspace is already open in another tab. Close that tab and reload
        here to avoid conflicting edits.
      </main>
    );
  return (
    <main className="wrap">
      <p role="status">{saveStatus}</p>
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🪄
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>
            Upload a pile of photos · auto-sort into items · write every
            listing.
          </p>
        </div>
      </header>

      <EbayConnect />

      {step === "upload" && (
        <>
          <section className="hero">
            <h2>
              Dump every photo. <em>We&rsquo;ll sort it out.</em>
            </h2>
            <p>
              Add all your photos for the whole batch at once. The app groups
              them into separate items, then writes a polished eBay listing for
              each one.
            </p>
          </section>

          <section className="panel" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="section-label">
              1 · Add all your photos
            </h2>

            <div className="field bin-field">
              <label htmlFor="bin">
                Bin / SKU code{" "}
                <span
                  style={{
                    fontWeight: 400,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  (where these items are stored)
                </span>
              </label>
              <input
                id="bin"
                type="text"
                placeholder="e.g. K75"
                value={binPrefix}
                onChange={(e) => setBinPrefix(e.target.value)}
                autoCapitalize="characters"
              />
              <span className="field-hint">
                Each item gets{" "}
                {binPrefix
                  ? `${binPrefix.trim()}-A, ${binPrefix.trim()}-B`
                  : "A, B, C"}
                … with a unique suffix to prevent collisions across devices. If
                this bin already has listings on eBay, lettering continues where
                it left off. You can edit any SKU after sorting.
              </span>
            </div>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <span className="icon" aria-hidden="true">
                📸
              </span>
              <strong>Tap to choose photos, or drag them all here</strong>
              <span>
                Every item in the batch · up to {MAX_PHOTOS} photos · JPG, PNG,
                WebP
              </span>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
            </div>

            {importProgress && <p aria-live="polite">{importProgress}</p>}
            {photos.length > 0 && (
              <div className="thumbs" aria-label="Selected photos">
                {photos.map((p) => (
                  <div className="thumb" key={p.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" />
                    <button
                      type="button"
                      aria-label="Remove photo"
                      onClick={() => removePhoto(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className="result-actions"
              style={{ borderTop: "none", paddingTop: 0 }}
            >
              <ModelSelector />
              <button
                type="button"
                className="btn btn-ghost"
                disabled={
                  !photos.length ||
                  photos.length > 24 ||
                  sorting ||
                  Boolean(importProgress)
                }
                onClick={() => {
                  const id = newId();
                  setGroups([
                    {
                      id,
                      sku: `${buildSku(binPrefix, 0).slice(0, 37)}-${id.replace(/-/g, "").slice(0, 12)}`,
                      name: "Single item",
                      photoIds: photos.map((p) => p.id),
                      status: "idle",
                    },
                  ]);
                  setOrphanIds([]);
                  setStep("review");
                }}
              >
                These photos are one item
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sort}
                disabled={
                  photos.length === 0 || sorting || Boolean(importProgress)
                }
              >
                {sorting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sorting{" "}
                    {photos.length} photos…
                  </>
                ) : (
                  <>🔀 Sort {photos.length || ""} photos into items</>
                )}
              </button>
            </div>

            {error && (
              <p className="note note-error" role="alert">
                {error}
              </p>
            )}
          </section>

          {sorting && (
            <section className="panel">
              <div className="loading-card">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {sortProgress ??
                    "Grouping photos by item, then double-checking for mixed-up or split items. This takes a little while for big batches."}
                </span>
              </div>
            </section>
          )}
        </>
      )}

      {step === "review" && (
        <ReviewBoard
          groups={groups}
          orphanIds={orphanIds}
          photoById={photoById}
          onRename={rename}
          onRenameSku={renameSku}
          onMovePhoto={movePhoto}
          onReorderPhoto={reorderPhoto}
          onDeleteGroup={deleteGroup}
          onAddGroup={addGroup}
          onWriteAll={writeAll}
          onBack={() => setStep("upload")}
        />
      )}

      {step === "listings" && (
        <ListingsView
          groups={usableGroups}
          photoById={photoById}
          ebayConnected={ebayConnected}
          onEdit={editListing}
          onGroupEdit={(id, patch) => {
            const current = groupsRef.current.find((g) => g.id === id);
            if (
              current &&
              !inFlight.current.has(id) &&
              current.postStatus !== "posted"
            )
              editGroup(id, patch);
          }}
          onRenameSku={renameSku}
          onRetry={writeGroup}
          onPost={postGroup}
          onPostAll={postAll}
          onWriteAll={writeAll}
          onResume={() =>
            queue?.kind === "post"
              ? void postAll(queueIds.current)
              : void writeAll()
          }
          queue={queue}
          onPause={() => {
            queuePause.current = true;
            setQueue((q) => q && { ...q, paused: true });
          }}
          onBack={() => setStep("review")}
        />
      )}

      <p className="footnote">
        Drafts and photos are saved on this device. Keep this tab open while a
        batch is processing.
      </p>
    </main>
  );
}
