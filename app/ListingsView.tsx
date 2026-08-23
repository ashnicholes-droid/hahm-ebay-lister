"use client";

import { ListingCard } from "./ListingCard";
import {
  downloadFile,
  listingsToCsv,
  listingsToJson,
} from "@/lib/export";
import { reportStatus } from "@/lib/verification";
import type { ItemGroup, ListingResult, Photo } from "@/lib/types";

interface ListingsViewProps {
  groups: ItemGroup[];
  photoById: (id: string) => Photo | undefined;
  onResearch: (groupId: string) => void;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPostAll: () => void;
  onVerify: (groupId: string) => void;
  onVerifyAll: () => void;
  onBack: () => void;
}

export function ListingsView({
  groups,
  photoById,
  onResearch,
  ebayConnected,
  onEdit,
  onRenameSku,
  onRetry,
  onPost,
  onPostAll,
  onVerify,
  onVerifyAll,
  onBack,
}: ListingsViewProps) {
  const done = groups.filter((g) => g.status === "done").length;
  const writing = groups.filter((g) => g.status === "writing").length;
  const failed = groups.filter((g) => g.status === "error").length;
  const posted = groups.filter((g) => g.postStatus === "posted").length;
  const posting = groups.some((g) => g.postStatus === "posting");
  const verifying = groups.some((g) => g.verifying);
  const written = groups.filter((g) => g.status === "done");
  const unchecked = written.filter((g) => !g.verification?.photoChecked).length;
  const blocked = written.filter(
    (g) => g.postStatus !== "posted" && reportStatus(g.verification) === "fail"
  ).length;
  // "Post all" deliberately excludes items whose accuracy check failed. Posting
  // one bad listing knowingly is a judgement call the seller makes on its card;
  // sweeping forty of them live in one click is not.
  const readyToPost = written.filter(
    (g) => g.postStatus !== "posted" && reportStatus(g.verification) !== "fail"
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

      {written.length > 0 && (
        <div className="verify-all-bar">
          <span>
            {unchecked === 0
              ? `All ${written.length} listing${written.length === 1 ? "" : "s"} checked against their photos.`
              : `${unchecked} of ${written.length} listing${written.length === 1 ? "" : "s"} haven't been checked against their photos yet — that's the pass that catches an invented brand or an unmentioned flaw.`}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onVerifyAll}
            disabled={verifying || unchecked === 0}
          >
            {verifying ? (
              <>
                <span className="spinner" aria-hidden="true" /> Checking photos…
              </>
            ) : (
              `🔍 Check all ${unchecked || written.length} against photos`
            )}
          </button>
        </div>
      )}

      {ebayConnected && (readyToPost > 0 || blocked > 0) && (
        <div className="post-all-bar">
          <span>
            {posted > 0
              ? `${posted} posted · ${readyToPost} left`
              : "Connected to eBay — post a single item to test first, or post them all."}
            {blocked > 0 && (
              <>
                {" "}
                <strong>
                  {blocked} item{blocked === 1 ? "" : "s"} failed the accuracy check and{" "}
                  {blocked === 1 ? "is" : "are"} excluded — post {blocked === 1 ? "it" : "them"}{" "}
                  individually if you disagree.
                </strong>
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPostAll}
            disabled={posting || readyToPost === 0}
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
            onResearch={onResearch}
            ebayConnected={ebayConnected}
            onEdit={onEdit}
            onRenameSku={onRenameSku}
            onRetry={onRetry}
            onPost={onPost}
            onVerify={onVerify}
          />
        ))}
      </div>

      <div className="result-actions">
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
