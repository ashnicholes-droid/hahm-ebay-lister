"use client";

import { ListingCard } from "./ListingCard";
import { ModelSelector } from "./ModelSelector";
import {
  downloadFile,
  listingsToCsv,
  listingsToJson,
} from "@/lib/export";
import type { ItemGroup, ListingResult, Photo } from "@/lib/types";

interface ListingsViewProps {
  groups: ItemGroup[];
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPostAll: () => void;
  onBack: () => void;
}

export function ListingsView({
  groups,
  photoById,
  ebayConnected,
  onEdit,
  onRenameSku,
  onRetry,
  onPost,
  onPostAll,
  onBack,
}: ListingsViewProps) {
  const done = groups.filter((g) => g.status === "done").length;
  const writing = groups.filter((g) => g.status === "writing").length;
  const failed = groups.filter((g) => g.status === "error").length;
  const posted = groups.filter((g) => g.postStatus === "posted").length;
  const posting = groups.some((g) => g.postStatus === "posting");
  const readyToPost = groups.filter(
    (g) => g.status === "done" && g.postStatus !== "posted"
  ).length;
  const allDone = writing === 0 && done > 0;

  return (
    <section className="panel" aria-labelledby="listings-heading">
      <div className="result-head">
        <h3 id="listings-heading">Your listings</h3>
        <span className="badge">
          {done}/{groups.length} ready
          {writing > 0 ? ` · ${writing} writing` : ""}
          {failed > 0 ? ` · ${failed} failed` : ""}
          {posted > 0 ? ` · ${posted} posted` : ""}
        </span>
      </div>

      {ebayConnected && readyToPost > 0 && (
        <div className="post-all-bar">
          <span>
            {posted > 0
              ? `${posted} posted · ${readyToPost} left`
              : "Connected to eBay — post a single item to test first, or post them all."}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPostAll}
            disabled={posting}
          >
            {posting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Posting…
              </>
            ) : (
              `🚀 Post all ${readyToPost} to eBay`
            )}
          </button>
        </div>
      )}

      <div className="listing-list">
        {groups.map((group) => (
          <ListingCard
            key={group.id}
            group={group}
            photoById={photoById}
            ebayConnected={ebayConnected}
            onEdit={onEdit}
            onRenameSku={onRenameSku}
            onRetry={onRetry}
            onPost={onPost}
          />
        ))}
      </div>

      <div className="result-actions">
        <ModelSelector />
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back to items
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={done === 0}
          onClick={() =>
            downloadFile(
              "ebay-listings.csv",
              listingsToCsv(groups),
              "text/csv"
            )
          }
        >
          ⬇️ Download spreadsheet (CSV)
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={done === 0}
          onClick={() =>
            downloadFile(
              "ebay-listings.json",
              listingsToJson(groups),
              "application/json"
            )
          }
        >
          ⬇️ Download all ({done})
        </button>
      </div>

      {allDone && (
        <p className="footnote" style={{ marginTop: "1.5rem" }}>
          Next phase: post all of these straight to eBay with one click.
        </p>
      )}
    </section>
  );
}
