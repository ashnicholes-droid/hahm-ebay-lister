"use client";

import { useState } from "react";
import type { ItemGroup, Photo } from "@/lib/types";

interface ReviewBoardProps {
  groups: ItemGroup[];
  orphanIds: string[];
  photoById: (id: string) => Photo | undefined;
  onRename: (groupId: string, name: string) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onMovePhoto: (photoId: string, toGroupId: string | "orphans") => void;
  onReorderPhoto: (groupId: string, fromIndex: number, toIndex: number) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddGroup: () => void;
  onWriteAll: () => void;
  onBack: () => void;
}

function MoveSelect({
  photoId,
  currentGroupId,
  groups,
  onMovePhoto,
}: {
  photoId: string;
  currentGroupId: string | "orphans";
  groups: ItemGroup[];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
}) {
  return (
    <select
      className="move-select"
      value={currentGroupId}
      aria-label="Move photo to a different item"
      onChange={(e) => onMovePhoto(photoId, e.target.value as string)}
      onClick={(e) => e.stopPropagation()}
    >
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
      <option value="orphans">Needs review</option>
    </select>
  );
}

interface DragState {
  draggable?: boolean;
  isCover?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnter?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}

function Thumb({
  photoId,
  groupId,
  groups,
  photoById,
  onMovePhoto,
  drag,
}: {
  photoId: string;
  groupId: string | "orphans";
  groups: ItemGroup[];
  photoById: ReviewBoardProps["photoById"];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
  drag?: DragState;
}) {
  const photo = photoById(photoId);
  if (!photo) return null;
  const cls = ["board-thumb"];
  if (drag?.draggable) cls.push("draggable");
  if (drag?.dragging) cls.push("dragging");
  if (drag?.dropTarget) cls.push("drop-target");
  return (
    <figure
      className={cls.join(" ")}
      draggable={drag?.draggable || undefined}
      onDragStart={drag?.onDragStart}
      onDragEnter={drag?.onDragEnter}
      onDragOver={drag?.draggable ? (e) => e.preventDefault() : undefined}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      <div className="board-thumb-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.previewUrl} alt="Item photo" />
        {drag?.isCover && <span className="thumb-cover-badge">Cover</span>}
      </div>
      <MoveSelect
        photoId={photoId}
        currentGroupId={groupId}
        groups={groups}
        onMovePhoto={onMovePhoto}
      />
    </figure>
  );
}

// A group's ordered photo strip with drag-to-reorder. Order is the eBay photo
// order (first = cover), so reordering here flows straight through to publish.
function PhotoGrid({
  group,
  groups,
  photoById,
  onMovePhoto,
  onReorderPhoto,
}: {
  group: ItemGroup;
  groups: ItemGroup[];
  photoById: ReviewBoardProps["photoById"];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
  onReorderPhoto: ReviewBoardProps["onReorderPhoto"];
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const reset = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="board-thumbs">
      {group.photoIds.map((pid, i) => (
        <Thumb
          key={pid}
          photoId={pid}
          groupId={group.id}
          groups={groups}
          photoById={photoById}
          onMovePhoto={onMovePhoto}
          drag={{
            draggable: group.photoIds.length > 1,
            isCover: i === 0,
            dragging: dragIndex === i,
            dropTarget: overIndex === i && dragIndex !== null && dragIndex !== i,
            onDragStart: (e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = "move";
              // Firefox won't start a drag unless some data is set.
              e.dataTransfer.setData("text/plain", pid);
            },
            onDragEnter: () => setOverIndex(i),
            onDragEnd: reset,
            onDrop: () => {
              if (dragIndex !== null && dragIndex !== i) {
                onReorderPhoto(group.id, dragIndex, i);
              }
              reset();
            },
          }}
        />
      ))}
    </div>
  );
}

// The QR photo that produced this item's inventory number. It isn't a listing
// photo — buyers don't want a picture of a bin tag — but it isn't unsorted
// either, so it's shown here, attached to the item it created, rather than in
// the needs-review tray. One tap promotes it to a real photo for sellers who do
// want the tag visible.
function LabelChip({
  group,
  photoById,
  onMovePhoto,
}: {
  group: ItemGroup;
  photoById: ReviewBoardProps["photoById"];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
}) {
  const markerId = group.markerPhotoId;
  if (!markerId) return null;
  // Once promoted it appears in the strip above; don't show it twice.
  if (group.photoIds.includes(markerId)) return null;
  const photo = photoById(markerId);
  if (!photo) return null;

  return (
    <div className="label-chip">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.previewUrl} alt="" />
      <div className="label-chip-text">
        <strong>🏷 {group.sku || "label"}</strong>
        <span>Read from this photo. Not posted to eBay.</span>
      </div>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => onMovePhoto(markerId, group.id)}
        title="Include the label photo in the listing"
      >
        Add to photos
      </button>
    </div>
  );
}

export function ReviewBoard({
  groups,
  orphanIds,
  photoById,
  onRename,
  onRenameSku,
  onMovePhoto,
  onReorderPhoto,
  onDeleteGroup,
  onAddGroup,
  onWriteAll,
  onBack,
}: ReviewBoardProps) {
  // Count label photos too — they're part of the batch the seller handed over,
  // and a total that silently omits them looks like photos went missing.
  const labelPhotos = groups.filter(
    (g) => g.markerPhotoId && !g.photoIds.includes(g.markerPhotoId)
  ).length;
  const totalPhotos =
    groups.reduce((n, g) => n + g.photoIds.length, 0) + labelPhotos + orphanIds.length;
  const usableGroups = groups.filter((g) => g.photoIds.length > 0);

  return (
    <section className="panel" aria-labelledby="review-heading">
      <div className="result-head">
        <h3 id="review-heading">
          {groups.length} item{groups.length === 1 ? "" : "s"} found
        </h3>
        <span className="badge">{totalPhotos} photos sorted</span>
      </div>
      <p style={{ marginTop: 0, color: "var(--color-ink-soft)" }}>
        Check the groupings below. Rename an item, drag photos to reorder them
        (the first photo is the eBay cover), or use the menu under any photo to
        move it to another item. Then write all the listings at once.
      </p>

      <div className="board">
        {groups.map((group) => (
          <article className="board-item" key={group.id}>
            <header className="board-item-head">
              <input
                type="text"
                className="board-sku"
                value={group.sku}
                aria-label="Item SKU / bin code"
                placeholder="SKU"
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
              <input
                type="text"
                className="board-name"
                value={group.name}
                aria-label="Item name"
                onChange={(e) => onRename(group.id, e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost danger"
                aria-label={`Delete ${group.name}`}
                onClick={() => onDeleteGroup(group.id)}
              >
                Delete
              </button>
            </header>
            {group.photoIds.length === 0 ? (
              <p className="board-empty">
                Empty — move photos here using the menu under a photo.
              </p>
            ) : (
              <PhotoGrid
                group={group}
                groups={groups}
                photoById={photoById}
                onMovePhoto={onMovePhoto}
                onReorderPhoto={onReorderPhoto}
              />
            )}
            <LabelChip group={group} photoById={photoById} onMovePhoto={onMovePhoto} />
          </article>
        ))}
      </div>

      {orphanIds.length > 0 && (
        <article className="board-item needs-review">
          <header className="board-item-head">
            <strong>⚠️ Needs review ({orphanIds.length})</strong>
            <span style={{ fontSize: "0.82rem", color: "var(--color-ink-faint)" }}>
              These didn&rsquo;t clearly belong to one item — assign each below.
            </span>
          </header>
          <div className="board-thumbs">
            {orphanIds.map((pid) => (
              <Thumb
                key={pid}
                photoId={pid}
                groupId="orphans"
                groups={groups}
                photoById={photoById}
                onMovePhoto={onMovePhoto}
              />
            ))}
          </div>
        </article>
      )}

      <div className="result-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back to photos
        </button>
        <button type="button" className="btn btn-ghost" onClick={onAddGroup}>
          ＋ New item
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onWriteAll}
          disabled={usableGroups.length === 0}
        >
          ✍️ Write {usableGroups.length} listing
          {usableGroups.length === 1 ? "" : "s"}
        </button>
      </div>
    </section>
  );
}
