"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { getAnalysisModel, getSortModel } from "@/lib/model-preferences";
import { resizeImage } from "@/lib/resize";
import { buildSku } from "@/lib/sku";
import { groupByQrDelimiters, type GroupingWarning } from "@/lib/qrGrouping";
import { chunkImagesForUpload } from "@/lib/uploadBatches";
import {
  buildReport,
  reportStatus,
  runRuleChecks,
  verdictsFromClaims,
  type PhotoClaim,
} from "@/lib/verification";
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
// How photos get split into items.
//   "qr" — deterministic: the batch is cut at QR labels, and each label's
//          inventory number becomes that item's SKU. No model call, no guessing.
//   "ai" — the original behaviour: a model groups the photos, and you check it
//          on the review board.
type IntakeMode = "qr" | "ai";
const VERIFY_CONCURRENCY = 3;
// Big batches are sorted in chunks of SORT_CHUNK photos per request — each
// chunk's thumbnail payload stays under Vercel's 4.5 MB body limit — then
// stitched back together with a merge check at every chunk boundary.
const MAX_PHOTOS = 300;
const SORT_CHUNK = 100;
const WRITE_CONCURRENCY = 3;
// eBay accepts at most 12 photos per listing. They ship to eBay in small
// batches (lib/uploadBatches.ts) before publish, so no single request ever
// nears Vercel's 4.5 MB body limit.
const MAX_PUBLISH_PHOTOS = 12;
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
  tooLargeHint = "Try again with fewer or smaller photos."
): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      throw new Error(
        `That was too much photo data to send at once. ${tooLargeHint}`
      );
    }
    throw new Error(
      text.trim().slice(0, 140) || `Request failed (${res.status}).`
    );
  }
}

// Which accuracy verdict an edit to a given listing field invalidates. Editing
// the price says nothing about whether the photos show the brand, so a single
// edit shouldn't throw away a whole photo-grounding pass (and make the seller pay
// for another one) — only the verdicts it actually touches.
const FIELD_FOR_PATCH_KEY: Record<string, string> = {
  title: "title",
  suggested_price: "price",
  condition: "condition",
  condition_notes: "condition",
  description: "description",
  size: "size",
  brand: "brand",
  item_specifics: "specifics",
  material: "specifics",
  color: "specifics",
};

// Rebuild a group's report from the listing as it currently stands. Rule
// verdicts are always recomputed from scratch; photo verdicts are carried
// forward except where `invalidatedFields` says they've gone stale.
function reviseReport(group: ItemGroup, invalidatedFields: string[] = []): ItemGroup {
  if (!group.listing) return group;
  const stale = new Set(invalidatedFields);
  const photoVerdicts = (group.verification?.verdicts ?? []).filter(
    (v) => v.source === "photo" && !stale.has(v.field)
  );
  return {
    ...group,
    verification: buildReport(
      runRuleChecks(group.listing, group.comps),
      photoVerdicts,
      group.verification?.photoChecked ?? false
    ),
  };
}

// Run async workers over items with a fixed concurrency limit.
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
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
  // Server-reported reason the deployment can't work at all (missing env var).
  const [setupError, setSetupError] = useState<string | null>(null);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("qr");
  const [importing, setImporting] = useState<string | null>(null);
  const [qrWarnings, setQrWarnings] = useState<GroupingWarning[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // How many of the loaded photos carry a QR inventory label.
  const labelCount = useMemo(() => photos.filter((p) => p.sku).length, [photos]);

  const photoMap = useMemo(() => {
    const m = new Map<string, Photo>();
    photos.forEach((p) => m.set(p.id, p));
    return m;
  }, [photos]);
  const photoById = useCallback((id: string) => photoMap.get(id), [photoMap]);

  // Latest groups, readable inside async workers without stale closures.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Keep eBay connection status in sync (also after the connect bar updates).
  // This probe doubles as the deployment health check: it's the first call the
  // app makes, so if the deployment is misconfigured this is where we find out.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/ebay/status", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = (await res.json().catch(() => ({}))) as {
          connected?: boolean;
          setupError?: string;
          error?: string;
        };
        if (!res.ok) {
          setSetupError(data.error ?? null);
          setEbayConnected(false);
          return;
        }
        // The probe answers 200 even on a broken deployment — it has to, since
        // it is the thing that reports the breakage. The reason rides in the
        // body, not the status code.
        setSetupError(data.setupError ?? null);
        setEbayConnected(Boolean(data.connected));
      } catch {
        setEbayConnected(false);
      }
    };
    void check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
      return;
    }
    try {
      // Resize and QR-scan in sequence rather than all at once: a 200-photo drop
      // resized in parallel pins the main thread and the tab stops responding.
      // Sequential work with a progress line is slower on paper and much better
      // to sit through — and the QR scan is why this is worth showing at all.
      const resized: Awaited<ReturnType<typeof resizeImage>>[] = [];
      for (const [i, file] of files.entries()) {
        setImporting(`Reading photo ${i + 1} of ${files.length}…`);
        resized.push(await resizeImage(file));
      }
      setPhotos((prev) =>
        [...prev, ...resized.map((r) => ({ id: newId(), ...r }))].slice(
          0,
          MAX_PHOTOS
        )
      );
      // A batch that carries labels should default to the deterministic path;
      // one that doesn't shouldn't sit on a mode that can't work.
      if (resized.some((r) => r.sku)) setIntakeMode("qr");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(null);
    }
  }, []);

  const removePhoto = (id: string) =>
    setPhotos((prev) => prev.filter((p) => p.id !== id));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // ── Organise into items ─────────────────────────────────

  // Deterministic path: cut the batch at its QR labels. No network, no model,
  // no ambiguity — and every item arrives already carrying its inventory number,
  // so the SKU is the one physically on the item rather than a generated letter.
  const groupByLabels = () => {
    setError(null);
    const { items, orphanIds: leftovers, warnings } = groupByQrDelimiters(
      photos.map((p) => ({ id: p.id, sku: p.sku }))
    );
    setQrWarnings(warnings);
    if (items.length === 0) {
      setError(
        "No QR labels were found in these photos. Add a label photo after each item, or switch to AI sorting."
      );
      return;
    }
    setSkuStart(0);
    setGroups(
      items.map((item, i) => ({
        id: newId(),
        // An item whose label was never photographed still needs a reference —
        // fall back to the bin lettering so it can be posted after review.
        sku: item.sku || buildSku(binPrefix, i),
        name: item.sku || `item-${i + 1}`,
        photoIds: item.photoIds,
        status: "idle" as const,
        ...(item.markerPhotoId ? { markerPhotoId: item.markerPhotoId } : {}),
      }))
    );
    setOrphanIds(leftovers);
    setStep("review");
  };

  const sort = async () => {
    if (photos.length === 0) return;
    if (intakeMode === "qr") {
      groupByLabels();
      return;
    }
    setSorting(true);
    setError(null);
    setQrWarnings([]);
    try {
      // Continue bin lettering after any SKUs already on eBay for this bin.
      let skuOffset = 0;
      if (binPrefix.trim()) {
        try {
          const r = await apiPost("/api/ebay/next-sku", { prefix: binPrefix.trim() });
          const d = (await readJson(r)) as { ok?: boolean; nextIndex?: number };
          if (d.ok && Number.isInteger(d.nextIndex) && (d.nextIndex as number) > 0) {
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
            `Sorting photos ${off + 1}–${off + chunk.length} of ${photos.length}…`
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
        const data = (await readJson(res, "Try sorting fewer photos per batch.")) as SortResponse;
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
            .filter((g) => g.photoIds.length > 0)
        );
        orphanIdsAll.push(
          ...((data.orphanIndices ?? []).map(idxToId).filter(Boolean) as string[])
        );
      }

      // Stitch chunks back together: an item photographed across a chunk
      // boundary lands split in two — ask the model whether the group holding
      // the boundary's last photo and the one holding the next chunk's first
      // photo are actually the same item.
      const merged: RawGroup[] = [...(chunkResults[0] ?? [])];
      for (let c = 1; c < chunkResults.length; c++) {
        const rest = [...chunkResults[c]];
        const lastId = photos[c * SORT_CHUNK - 1]?.id;
        const firstId = photos[c * SORT_CHUNK]?.id;
        const prevGroup = merged.find((g) => lastId && g.photoIds.includes(lastId));
        const nextGroup = rest.find((g) => firstId && g.photoIds.includes(firstId));
        if (prevGroup && nextGroup) {
          setSortProgress("Checking for items split across batches…");
          try {
            const a = photoMap.get(prevGroup.photoIds[0]);
            const b = photoMap.get(nextGroup.photoIds[0]);
            if (a && b) {
              const res = await apiPost("/api/merge-check", {
                a: { mediaType: a.mediaType, data: a.previewUrl.split(",")[1] },
                b: { mediaType: b.mediaType, data: b.previewUrl.split(",")[1] },
                countA: prevGroup.photoIds.length,
                countB: nextGroup.photoIds.length,
                sortModel: getSortModel() ?? undefined,
              });
              const d = (await readJson(res)) as { ok?: boolean; merge?: boolean };
              if (d.ok && d.merge) {
                prevGroup.photoIds = [...prevGroup.photoIds, ...nextGroup.photoIds];
                rest.splice(rest.indexOf(nextGroup), 1);
              }
            }
          } catch {
            /* boundary check is best-effort — worst case the item stays split */
          }
        }
        merged.push(...rest);
      }

      const assigned = new Set<string>();
      merged.forEach((g) => g.photoIds.forEach((id) => assigned.add(id)));
      orphanIdsAll.forEach((id) => assigned.add(id));
      // Any photo the sorter never placed shouldn't vanish — surface it.
      const leftover = photos.filter((p) => !assigned.has(p.id)).map((p) => p.id);

      const nextGroups: ItemGroup[] = merged.map((g, i) => ({
        id: newId(),
        sku: buildSku(binPrefix, skuOffset + i),
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
      prev.map((g) => (g.id === groupId ? { ...g, name } : g))
    );

  const renameSku = (groupId: string, sku: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, sku } : g))
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
          ...(changed && g.status === "done" ? { status: "idle" as const } : {}),
        };
      })
    );
    setOrphanIds((prev) => {
      const without = prev.filter((id) => id !== photoId);
      return toGroupId === "orphans" ? [...without, photoId] : without;
    });
  };

  // Reorder photos within a group. The array order is the eBay photo order
  // (index 0 = cover/gallery image), so this is all that's needed — `writeGroup`
  // and `postGroup` re-derive their image order from `photoIds` at call time.
  const reorderPhoto = (groupId: string, fromIndex: number, toIndex: number) => {
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
        return { ...g, photoIds: next };
      })
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
        sku: buildSku(binPrefix, skuStart + prev.length),
        name: `new-item-${prev.length + 1}`,
        photoIds: [],
        status: "idle",
      },
    ]);

  // ── Accuracy checking ───────────────────────────────────

  const verifyGroup = useCallback(
    async (groupId: string) => {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group?.listing) return;
      const images = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }))
        .slice(0, MAX_PUBLISH_PHOTOS);
      if (images.length === 0) return;

      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, verifying: true } : g))
      );
      try {
        const res = await apiPost("/api/verify", {
          images,
          listing: group.listing,
          verifyModel: getAnalysisModel() ?? undefined,
        });
        const data = (await readJson(res)) as {
          ok?: boolean;
          claims?: PhotoClaim[];
          error?: string;
        };
        if (!data.ok) throw new Error(data.error || "Could not check this listing.");
        const photoVerdicts = verdictsFromClaims(data.claims ?? []);
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  verifying: false,
                  verification: buildReport(
                    runRuleChecks(g.listing, g.comps),
                    photoVerdicts,
                    true
                  ),
                }
              : g
          )
        );
      } catch (e) {
        // A failed check must never read as a pass. Leave the report as it was
        // and surface the error, rather than quietly marking the item checked.
        setGroups((prev) =>
          prev.map((g) => (g.id === groupId ? { ...g, verifying: false } : g))
        );
        setError(`Accuracy check failed: ${(e as Error).message}`);
      }
    },
    [photoMap]
  );

  const verifyAll = async () => {
    const pending = groupsRef.current
      .filter((g) => g.status === "done" && !g.verification?.photoChecked)
      .map((g) => g.id);
    if (pending.length === 0) return;
    await runPool(pending, VERIFY_CONCURRENCY, verifyGroup);
  };

  // ── Write listings ──────────────────────────────────────
  const writeGroup = useCallback(
    async (groupId: string) => {
      // Snapshot this group's photos from the latest state (no stale closure).
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group) return;
      const imgs = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, status: "writing", error: undefined } : g
        )
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
              ? // Rule checks run the moment a listing exists, so the card opens
                // with its contradictions already visible. The photo pass is a
                // paid model call, so it stays an explicit choice.
                reviseReport({ ...g, status: "done", listing: data.listing })
              : g
          )
        );
        // Market price check — advisory and best-effort, so it runs in the
        // background and silently stays hidden if it can't answer.
        void (async () => {
          try {
            const res = await apiPost("/api/ebay/comps", { listing: data.listing });
            const d = (await readJson(res)) as { ok?: boolean; comps?: CompsSummary };
            if (d.ok && d.comps?.ok) {
              // Comps are what turn the price rule from "no market data" into a
              // real verdict, so recompute once they land.
              setGroups((prev) =>
                prev.map((g) => (g.id === groupId ? reviseReport({ ...g, comps: d.comps }) : g))
              );
            }
          } catch {
            /* comps unavailable — price stays purely the AI estimate */
          }
        })();
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, status: "error", error: (e as Error).message }
              : g
          )
        );
      }
    },
    [photoMap]
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
    await runPool(usable, WRITE_CONCURRENCY, writeGroup);
  };

  const editListing = (groupId: string, patch: Partial<ListingResult>) => {
    const invalidated = Object.keys(patch)
      .map((k) => FIELD_FOR_PATCH_KEY[k])
      .filter(Boolean);
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId && g.listing
          ? reviseReport({ ...g, listing: { ...g.listing, ...patch } }, invalidated)
          : g
      )
    );
  };

  const postGroup = useCallback(
    async (groupId: string) => {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group || !group.listing) return;
      const images = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }))
        .slice(0, MAX_PUBLISH_PHOTOS);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, postStatus: "posting", postError: undefined } : g
        )
      );
      try {
        // 1. Ship the photos to eBay first, in batches small enough that no
        // single request can hit Vercel's 4.5 MB body limit — the old
        // all-in-one publish request 413-failed on photo-heavy listings.
        const imageUrls: string[] = [];
        let uploadedCount = 0;
        for (const batch of chunkImagesForUpload(images)) {
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
            const d = (await readJson(res)) as { ok?: boolean; error?: string; urls?: string[] };
            if (!d.ok) throw new Error(d.error || "Could not upload photos to eBay.");
            imageUrls.push(...(Array.isArray(d.urls) ? d.urls : []));
            break;
          }
          uploadedCount += batch.length;
        }
        if (imageUrls.length === 0) {
          throw new Error("Could not upload any photos to eBay.");
        }
        // Partial upload failures don't block the listing, but they're loud —
        // a listing quietly missing photos sells worse and looks like a bug.
        const uploadWarnings =
          imageUrls.length < images.length
            ? [
                `${images.length - imageUrls.length} photo(s) failed to upload to eBay — the listing was posted with ${imageUrls.length}.`,
              ]
            : [];

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
        if (data && !data.success && data.alreadyListed && hadTransientRetry && data.listingId) {
          data = { success: true, listingId: data.listingId };
        }
        if (!data?.success) throw new Error(data?.error || "eBay rejected the listing.");
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
              : g
          )
        );
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, postStatus: "error", postError: (e as Error).message }
              : g
          )
        );
      }
    },
    [photoMap]
  );

  const postAll = async () => {
    // Items whose accuracy check failed are excluded here on purpose. They stay
    // postable one at a time from their own card, where the button says so.
    const ready = groups
      .filter(
        (g) =>
          g.status === "done" &&
          g.postStatus !== "posted" &&
          reportStatus(g.verification) !== "fail"
      )
      .map((g) => g.id);
    // Sequential — keeps eBay calls gentle and errors easy to read.
    for (const id of ready) {
      await postGroup(id);
    }
  };

  const usableGroups = useMemo(
    () => groups.filter((g) => g.photoIds.length > 0),
    [groups]
  );

  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🪄
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>Upload a pile of photos · auto-sort into items · write every listing.</p>
        </div>
      </header>

      {setupError && (
        <p className="note note-error setup-error" role="alert">
          <strong>This deployment isn&rsquo;t configured yet.</strong> {setupError}
        </p>
      )}

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

            <fieldset className="intake-mode">
              <legend>How should these photos be split into items?</legend>
              <label className={intakeMode === "qr" ? "active" : ""}>
                <input
                  type="radio"
                  name="intake"
                  checked={intakeMode === "qr"}
                  onChange={() => setIntakeMode("qr")}
                />
                <span>
                  <strong>QR labels (exact)</strong>
                  Shoot each item, then a QR label holding its inventory number.
                  The batch is cut at the labels and each item posts under the
                  number physically on it. No AI guessing, no review pass, no
                  sorting cost.
                  {photos.length > 0 && (
                    <em>
                      {labelCount > 0
                        ? ` ${labelCount} label${labelCount === 1 ? "" : "s"} found → ${labelCount} item${labelCount === 1 ? "" : "s"}.`
                        : " No labels found in these photos yet."}
                    </em>
                  )}
                </span>
              </label>
              <label className={intakeMode === "ai" ? "active" : ""}>
                <input
                  type="radio"
                  name="intake"
                  checked={intakeMode === "ai"}
                  onChange={() => setIntakeMode("ai")}
                />
                <span>
                  <strong>AI sorting</strong>
                  No labels needed — a model groups the photos by item, and you
                  fix its mistakes on the review board. Use this for photos you
                  already took.
                </span>
              </label>
            </fieldset>

            <div className="field bin-field">
              <label htmlFor="bin">
                Bin / SKU code{" "}
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
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
                Each item gets {binPrefix ? `${binPrefix.trim()}-A, ${binPrefix.trim()}-B` : "A, B, C"}
                … in order, so you can find it in the bin later. If this bin
                already has listings on eBay, lettering continues where it left
                off. You can edit any SKU after sorting.
              </span>
            </div>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
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

            {importing && (
              <div className="loading-card">
                <span className="spinner" aria-hidden="true" />
                <span>{importing} Scanning each one for a QR inventory label.</span>
              </div>
            )}

            {photos.length > 0 && (
              <div className="thumbs" aria-label="Selected photos">
                {photos.map((p) => (
                  <div className={`thumb${p.sku ? " is-marker" : ""}`} key={p.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" />
                    {p.sku && (
                      <span className="thumb-sku" title={`QR label: ${p.sku}`}>
                        {p.sku}
                      </span>
                    )}
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

            <div className="result-actions" style={{ borderTop: "none", paddingTop: 0 }}>
              <ModelSelector />
              <button
                type="button"
                className="btn btn-primary"
                onClick={sort}
                disabled={photos.length === 0 || sorting || Boolean(importing)}
              >
                {sorting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sorting{" "}
                    {photos.length} photos…
                  </>
                ) : intakeMode === "qr" ? (
                  <>🏷 Split into {labelCount || ""} item{labelCount === 1 ? "" : "s"} by label</>
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

            {qrWarnings.length > 0 && (
              <ul className="qr-warnings" role="status">
                {qrWarnings.map((w, i) => (
                  <li key={`${w.code}-${i}`}>⚠️ {w.message}</li>
                ))}
              </ul>
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
          onRenameSku={renameSku}
          onRetry={writeGroup}
          onPost={postGroup}
          onPostAll={postAll}
          onVerify={verifyGroup}
          onVerifyAll={verifyAll}
          onBack={() => setStep("review")}
        />
      )}

      <p className="footnote">
        Your photos are sent securely to sort and write listings, and are not
        stored. One-click posting to eBay is coming in the next phase.
      </p>
    </main>
  );
}
