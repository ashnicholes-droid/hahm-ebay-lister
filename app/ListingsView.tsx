"use client";

import { ListingCard } from "./ListingCard";
import {
  downloadFile,
  listingsToCsv,
  listingsToJson,
} from "@/lib/export";
import type {
  ItemGroup,
  ListingResult,
  Photo,
} from "@/lib/types";

interface ListingsViewProps {
  groups: ItemGroup[];
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPublishAndPromote: (groupId: string) => void;
  onPostAll: () => void;
  onBack: () => void;
}

export function ListingsView({
  groups,
  photoById,
  ebayConnected,
  onEdit,
  onRetry,
  onPost,
  onPublishAndPromote,
  onPostAll,
  onBack,
}: ListingsViewProps) {
  const completedGroups = groups.filter(
    (group) => group.status === "done" && Boolean(group.listing)
  );

  const doneCount = completedGroups.length;
  const writingCount = groups.filter(
    (group) => group.status === "writing"
  ).length;
  const failedCount = groups.filter(
    (group) => group.status === "error"
  ).length;
  const savedDraftCount = groups.filter(
    (group) => group.postStatus === "draft-saved"
  ).length;
  const isSavingDraft = groups.some(
    (group) => group.postStatus === "saving"
  );

  const readyToSaveCount = groups.filter(
    (group) =>
      group.status === "done" &&
      Boolean(group.listing) &&
      group.postStatus !== "draft-saved" &&
      group.postStatus !== "saving"
  ).length;

  const allFinished =
    groups.length > 0 &&
    doneCount === groups.length &&
    writingCount === 0 &&
    failedCount === 0;

  const draftStatusText =
    savedDraftCount === 1
      ? "1 draft saved"
      : `${savedDraftCount} drafts saved`;

  const saveProgressText =
    savedDraftCount > 0
      ? `${draftStatusText} · ${readyToSaveCount} left`
      : "Connected to eBay — save one item as a draft first, or save them all.";

  const handleCsvDownload = () => {
    downloadFile(
      "ebay-listings.csv",
      listingsToCsv(completedGroups),
      "text/csv;charset=utf-8"
    );
  };

  const handleJsonDownload = () => {
    downloadFile(
      "ebay-listings.json",
      listingsToJson(completedGroups),
      "application/json;charset=utf-8"
    );
  };

  return (
    <section className="panel" aria-labelledby="listings-heading">
      <div className="result-head">
        <h3 id="listings-heading">Your listings</h3>

        <span className="badge" aria-live="polite">
          {doneCount}/{groups.length} ready
          {writingCount > 0 && ` · ${writingCount} writing`}
          {failedCount > 0 && ` · ${failedCount} failed`}
          {savedDraftCount > 0 && ` · ${draftStatusText}`}
        </span>
      </div>

      {ebayConnected && readyToSaveCount > 0 && (
        <div className="post-all-bar">
          <span>{saveProgressText}</span>

          <button
            type="button"
            className="btn btn-primary"
            onClick={onPostAll}
            disabled={isSavingDraft}
          >
            {isSavingDraft ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Saving drafts…
              </>
            ) : (
              <>Save all {readyToSaveCount} as eBay drafts</>
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
  onRetry={onRetry}
  onPost={onPost}
  onPublishAndPromote={onPublishAndPromote}
/>
        ))}
      </div>

      <div className="result-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onBack}
        >
          ← Back to items
        </button>

        <button
          type="button"
          className="btn btn-ghost"
          disabled={doneCount === 0}
          onClick={handleCsvDownload}
        >
          ⬇️ Download spreadsheet (CSV)
        </button>

        <button
          type="button"
          className="btn btn-primary"
          disabled={doneCount === 0}
          onClick={handleJsonDownload}
        >
          ⬇️ Download all ({doneCount})
        </button>
      </div>

      {allFinished && (
        <p className="footnote" style={{ marginTop: "1.5rem" }}>
          Completed listings can be saved to eBay as drafts.
        </p>
      )}
    </section>
  );
}