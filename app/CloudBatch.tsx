"use client";
import { useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { loadPhoto } from "@/lib/draft-store";
import { runBatch } from "@/lib/batch-queue";
import type { ItemGroup, Photo } from "@/lib/types";
const KEY = "lister-cloud-batch";
async function call(body: unknown) {
  const r = await apiPost("/api/cloud", body);
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.error || "Cloud request failed.");
  return d;
}
function jpeg(data: string) {
  const raw = atob(data);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/jpeg" });
}
export function CloudBatch({
  groups,
  photos,
  onResult,
  onOpen,
}: {
  groups: ItemGroup[];
  photos: Photo[];
  onResult: (id: string, patch: Partial<ItemGroup>) => void;
  onOpen: () => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [batchId, setBatchId] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [cloudItems, setCloudItems] = useState<any[]>([]);
  const latest = useRef({ groups, onResult });
  latest.current = { groups, onResult };
  useEffect(() => {
    setBatchId(localStorage.getItem(KEY) ?? "");
    void fetch("/api/cloud")
      .then((r) => r.json())
      .then((d) => setEnabled(d.enabled))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled || !batchId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 5000;
      try {
        const data = await call({
          action: "status",
          batchId,
          knownIds: latest.current.groups
            .filter((g) => g.status === "done" || g.postStatus === "posted")
            .map((g) => g.id),
        });
        if (!active) return;
        setCloudItems(data.items);
        if (data.moreResults) delay = 500;
        for (const row of data.items) {
          const g = latest.current.groups.find((g) => g.id === row.clientId);
          if (
            !g ||
            g.photoIds.join(",") !== row.draft.photoIds.join(",") ||
            g.sku !== row.draft.sku ||
            g.status === "done" ||
            g.postStatus === "posted"
          )
            continue;
          if (row.job?.status === "succeeded" && row.job.result?.prepared) {
            const { prepared, analysis, research } = row.job.result;
            latest.current.onResult(g.id, {
              status: "done",
              listing: prepared.listing,
              preparation: prepared.preparation,
              usage: [...(analysis.usage ?? []), ...(prepared.usage ?? [])],
              error: undefined,
              comps: research?.comps,
              compsStatus: research?.comps?.ok ? "ready" : "unavailable",
              evidencePhotoIds: [...g.photoIds],
            });
          } else if (
            ["queued", "running"].includes(row.job?.status) &&
            (g.status !== "writing" || g.cloudBatchId !== batchId)
          ) {
            latest.current.onResult(g.id, {
              status: "writing",
              cloudBatchId: batchId,
            });
          } else if (row.job?.status === "failed")
            latest.current.onResult(g.id, {
              status: "error",
              error: row.job.error,
            });
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, batchId]);
  async function uploadAndStart() {
    setBusy(true);
    setError("");
    try {
      const pending = groups.filter(
        (g) =>
          g.status !== "done" && g.postStatus !== "posted" && g.photoIds.length,
      );
      if (!pending.length) throw new Error("All drafts are already written.");
      if (pending.length > 100)
        throw new Error("Select a batch of at most 100 items.");
      // A saved cloud batch can resume uploads. Start a new batch when item identities change.
      const same =
        cloudItems.length &&
        pending.every((g) => cloudItems.some((r) => r.clientId === g.id));
      const id = same ? batchId : crypto.randomUUID();
      if (!same)
        await call({
          action: "create",
          batchId: id,
          groups: pending.map((g) => ({
            id: g.id,
            sku: g.sku,
            name: g.name,
            photoIds: g.photoIds,
            analysisPhotoIds: g.analysisPhotoIds,
          })),
        });
      localStorage.setItem(KEY, id);
      setBatchId(id);
      const ids = [...new Set(pending.flatMap((g) => g.photoIds))];
      let count = 0;
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        setMessage(
          `Uploading ${count}/${ids.length} photos. Keep this tab open until uploads finish.`,
        );
        const { links } = await call({
          action: "upload-links",
          batchId: id,
          photoIds: chunk,
        });
        const result = await runBatch<any>(links, 3, async (link) => {
          const p =
            (await loadPhoto(link.id)) ?? photos.find((p) => p.id === link.id);
          if (!p) throw new Error("A photo is missing from this device.");
          for (const [url, data] of [
            [link.analysis, p.data],
            [link.upload, p.uploadData ?? p.data],
          ]) {
            const r = await fetch(url, {
              method: "PUT",
              headers: { "Content-Type": "image/jpeg" },
              body: jpeg(data),
            });
            if (!r.ok) throw new Error("Photo upload failed. Retry to resume.");
          }
          count++;
          setMessage(`Uploaded ${count}/${ids.length} photos.`);
        });
        if (result.errors.length) throw result.errors[0];
        await call({ action: "confirm-uploads", batchId: id, photoIds: chunk });
      }
      await call({ action: "start", batchId: id });
      pending.forEach((g) =>
        onResult(g.id, {
          status: "writing",
          cloudBatchId: id,
          error: undefined,
        }),
      );
      setMessage(
        "Batch submitted. You can close this tab; return here to see the drafts.",
      );
      onOpen();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const finished = cloudItems.filter(
    (i) => i.job?.status === "succeeded",
  ).length;
  const failed = cloudItems.filter((i) => i.job?.status === "failed").length;
  const running = cloudItems.some(
    (i) => i.job && ["queued", "running"].includes(i.job.status),
  );
  if (!enabled) return null;
  return (
    <section className="panel">
      <h3>Background drafts</h3>
      <p>
        Upload once, then draft generation continues after you close the
        browser. Nothing is published automatically. Cloud photos expire after
        30 days.
      </p>
      <div className="batch-toolbar">
        <button
          type="button"
          disabled={busy || running || !groups.length}
          onClick={() => void uploadAndStart()}
        >
          {busy ? "Uploading…" : "Write unfinished drafts in background"}
        </button>
        {failed > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await call({ action: "retry", batchId });
                setError("");
                setMessage(
                  "Retry submitted; completed analysis will be reused.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry {failed} failed items
          </button>
        )}
      </div>
      {cloudItems.length > 0 && (
        <p aria-live="polite">
          {finished}/{cloudItems.length} cloud drafts finished
          {failed ? ` · ${failed} failed` : ""}
          {running ? " · Processing" : ""}
        </p>
      )}
      {message && <p aria-live="polite">{message}</p>}
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
