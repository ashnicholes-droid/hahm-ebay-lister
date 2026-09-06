"use client";

import { useEffect, useRef, useState, Fragment } from "react";
import { draftIssues } from "@/lib/client-review";
import { ListingCard } from "./ListingCard";
import { downloadFile, listingsToCsv, listingsToJson } from "@/lib/export";
import {
  loadAccountOptions,
  clearAccountOptions,
} from "@/lib/account-options-client";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import type { AccountOptions } from "@/lib/ebay/publish";
import type { QueueProgress } from "@/lib/batch-queue";
import type { ItemGroup, ListingResult, Photo } from "@/lib/types";

interface ListingsViewProps {
  groups: ItemGroup[];
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPostAll: (ids?: string[]) => void;
  onWriteAll: () => void;
  onResume: () => void;
  queue:
    | (QueueProgress & {
        kind: "write" | "post";
        running: boolean;
        paused: boolean;
      })
    | null;
  onPause: () => void;
  onBack: () => void;
}
const editable = (g: ItemGroup) =>
  g.status === "done" &&
  g.postStatus !== "posted" &&
  g.postStatus !== "posting";
export function ListingsView(props: ListingsViewProps) {
  const {
    groups,
    photoById,
    ebayConnected,
    onEdit,
    onGroupEdit,
    onRenameSku,
    onRetry,
    onPost,
    onPostAll,
    onBack,
    queue,
  } = props;
  const [table, setTable] = useState(groups.length > 1);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [options, setOptions] = useState<AccountOptions>();
  const [optionsError, setOptionsError] = useState("");
  const [bulkShipping, setBulkShipping] = useState("");
  const [bulkCondition, setBulkCondition] = useState("");
  const [bulkNotice, setBulkNotice] = useState("");
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let active = true;
    const load = async () => {
      setOptions(undefined);
      try {
        const value = await loadAccountOptions();
        if (active) {
          setOptions(value);
          setOptionsError("");
        }
      } catch (e) {
        if (active) setOptionsError((e as Error).message);
      }
    };
    if (ebayConnected) void load();
    else setOptions(undefined);
    const changed = () => {
      clearAccountOptions();
      void load();
    };
    window.addEventListener("ebay-connection-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("ebay-connection-changed", changed);
    };
  }, [ebayConnected]);
  useEffect(() => {
    if (!options) return;
    for (const g of groups) {
      if (!editable(g)) continue;
      const shipping = applyShippingDefaults(g.shipping ?? {}, options);
      if (JSON.stringify(shipping) !== JSON.stringify(g.shipping ?? {}))
        latest.current.onGroupEdit(g.id, { shipping });
    }
  }, [groups, options]);
  const issues = (g: ItemGroup) => {
    const result = draftIssues(g);
    if (groups.some((other) => other.id !== g.id && other.sku === g.sku))
      result.push("Another item has this SKU.");
    return result;
  };
  const ready = groups.filter((g) => editable(g) && !issues(g).length);
  const done = groups.filter((g) => g.status === "done").length;
  const posted = groups.filter((g) => g.postStatus === "posted").length;
  const active =
    Boolean(queue?.running) || groups.some((g) => g.postStatus === "posting");
  const remaining = groups.filter(
    (g) => g.status === "idle" || g.status === "error",
  ).length;
  const visible = groups.filter(
    (g) =>
      filter === "all" ||
      (filter === "ready"
        ? ready.includes(g)
        : filter === "posted"
          ? g.postStatus === "posted"
          : g.postStatus !== "posted" &&
            (g.status === "error" ||
              g.postStatus === "error" ||
              (g.status === "done" && issues(g).length > 0))),
  );
  const lastPage = Math.max(0, Math.ceil(visible.length / 25) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = visible.slice(currentPage * 25, currentPage * 25 + 25);
  const chosen = groups.filter((g) => selected.has(g.id) && editable(g));
  const conditions = [
    ...new Map(
      groups
        .flatMap((g) => g.preparation?.conditions ?? [])
        .map((c) => [c.value, c]),
    ).values(),
  ];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const card = (group: ItemGroup) => (
    <ListingCard
      key={group.id}
      group={group}
      photoById={photoById}
      ebayConnected={ebayConnected}
      onEdit={onEdit}
      onGroupEdit={onGroupEdit}
      onRenameSku={onRenameSku}
      onRetry={onRetry}
      onPost={onPost}
    />
  );
  return (
    <section className="panel" aria-labelledby="listings-heading">
      <div className="result-head">
        <h3 id="listings-heading">Your listings</h3>
        <span className="badge">
          {done}/{groups.length} drafts written · {ready.length} ready ·{" "}
          {posted} posted
        </span>
      </div>
      <div className="batch-toolbar">
        <button type="button" onClick={() => setTable(!table)}>
          {table ? "Detailed cards" : "Batch table"}
        </button>
        <label>
          Show{" "}
          <select
            aria-label="Show"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All items</option>
            <option value="attention">Needs attention</option>
            <option value="ready">Ready to post</option>
            <option value="posted">Posted</option>
          </select>
        </label>
        {remaining > 0 && (
          <button type="button" disabled={active} onClick={props.onWriteAll}>
            Write / retry {remaining} remaining
          </button>
        )}
      </div>
      {queue && (
        <div className="batch-progress" aria-live="polite">
          <span>
            {queue.kind === "write" ? "Writing" : "Publishing"}:{" "}
            {queue.completed}/{queue.total} attempts finished ·{" "}
            {(queue.elapsedMs / 60000).toFixed(1)} min
            {queue.paused
              ? queue.running
                ? " · Pausing after active items finish"
                : " · Paused"
              : queue.running
                ? " · Running"
                : " · Finished"}
          </span>
          <progress
            value={queue.completed}
            max={queue.total}
            aria-label="Batch progress"
          />
          {queue.running ? (
            <button
              type="button"
              disabled={queue.paused}
              onClick={props.onPause}
            >
              Pause batch
            </button>
          ) : (
            queue.paused && (
              <button type="button" onClick={props.onResume}>
                Resume batch
              </button>
            )
          )}
          <small>
            Keep this tab open while processing. Saved unfinished drafts can be
            resumed after reopening.
          </small>
        </div>
      )}
      {optionsError && (
        <p className="note note-error">
          Policies: {optionsError}{" "}
          <button
            type="button"
            onClick={() =>
              void loadAccountOptions(true)
                .then((o) => {
                  setOptions(o);
                  setOptionsError("");
                })
                .catch((e) => setOptionsError(e.message))
            }
          >
            Retry policies
          </button>
        </p>
      )}
      {table && (
        <div className="batch-toolbar">
          <button
            type="button"
            onClick={() =>
              setSelected(new Set(visible.filter(editable).map((g) => g.id)))
            }
          >
            Select all {visible.filter(editable).length} shown by filter
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <span>{chosen.length} selected</span>
          <label>
            Shipping for selected{" "}
            <select
              aria-label="Shipping for selected"
              value={bulkShipping}
              onChange={(e) => setBulkShipping(e.target.value)}
            >
              <option value="">Choose policy</option>
              {options?.fulfillment.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!chosen.length || !bulkShipping || active}
            onClick={() => {
              for (const g of chosen)
                onGroupEdit(g.id, {
                  shipping: {
                    ...g.shipping,
                    fulfillmentPolicyId: bulkShipping,
                  },
                });
              setBulkNotice(`Shipping updated for ${chosen.length} items.`);
            }}
          >
            Apply shipping
          </button>
          <label>
            Condition for selected{" "}
            <select
              aria-label="Condition for selected"
              value={bulkCondition}
              onChange={(e) => setBulkCondition(e.target.value)}
            >
              <option value="">Choose condition</option>
              {conditions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!chosen.length || !bulkCondition || active}
            onClick={() => {
              let count = 0;
              for (const g of chosen)
                if (
                  g.preparation?.conditions.some(
                    (c) => c.value === bulkCondition,
                  )
                ) {
                  onEdit(g.id, { ebay_condition: bulkCondition });
                  count++;
                }
              setBulkNotice(
                `Condition updated for ${count} items. ${chosen.length - count} skipped because the category does not support it. Review descriptions for consistency.`,
              );
            }}
          >
            Apply condition
          </button>
        </div>
      )}
      {bulkNotice && <p aria-live="polite">{bulkNotice}</p>}
      {ebayConnected && ready.length > 0 && (
        <div className="post-all-bar">
          <span>Review your drafts, then publish the ready items.</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={active}
            onClick={() => onPostAll()}
          >
            🚀 Post all {ready.length} to eBay
          </button>
          {chosen.length > 0 && (
            <button
              type="button"
              disabled={active || !ready.some((g) => selected.has(g.id))}
              onClick={() => onPostAll([...selected])}
            >
              Post selected ready (
              {ready.filter((g) => selected.has(g.id)).length})
            </button>
          )}
        </div>
      )}
      {table ? (
        <div className="batch-table-scroll">
          <table className="batch-table">
            <thead>
              <tr>
                <th>Select / photo</th>
                <th>Title / SKU</th>
                <th>Size</th>
                <th>Condition</th>
                <th>Price</th>
                <th>Shipping</th>
                <th>Status / details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const l = g.listing,
                  locked = !editable(g),
                  problems = issues(g),
                  cover = photoById(g.photoIds[0]);
                return (
                  <Fragment key={g.id}>
                    <tr>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${g.sku}`}
                          checked={selected.has(g.id)}
                          disabled={locked}
                          onChange={() => toggle(g.id)}
                        />
                        {cover && (
                          <img
                            loading="lazy"
                            src={cover.previewUrl}
                            alt={g.name}
                            width="64"
                            height="64"
                          />
                        )}
                      </td>
                      <td>
                        {l ? (
                          <textarea
                            aria-label={`Title ${g.sku}`}
                            value={l.title}
                            disabled={locked}
                            onChange={(e) =>
                              onEdit(g.id, { title: e.target.value })
                            }
                          />
                        ) : (
                          g.name
                        )}
                        <small>
                          {g.sku}
                          {l ? ` · ${l.title.length}/80` : ""}
                        </small>
                      </td>
                      <td>
                        <input
                          aria-label={`Size ${g.sku}`}
                          value={l?.size ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            onEdit(g.id, { size: e.target.value })
                          }
                        />
                        <small>{l?.item_specifics?.["Size Type"]}</small>
                      </td>
                      <td>
                        <select
                          aria-label={`Condition ${g.sku}`}
                          value={l?.ebay_condition ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            onEdit(g.id, { ebay_condition: e.target.value })
                          }
                        >
                          <option value="">Choose</option>
                          {g.preparation?.conditions.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`Price ${g.sku}`}
                          inputMode="decimal"
                          value={l?.suggested_price ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            onEdit(g.id, { suggested_price: e.target.value })
                          }
                        />
                        <small>
                          {g.comps?.count
                            ? `${g.comps.count} asking-price matches`
                            : "Unverified estimate"}
                        </small>
                      </td>
                      <td>
                        <select
                          aria-label={`Shipping ${g.sku}`}
                          value={g.shipping?.fulfillmentPolicyId ?? ""}
                          disabled={locked || !options}
                          onChange={(e) =>
                            onGroupEdit(g.id, {
                              shipping: {
                                ...g.shipping,
                                fulfillmentPolicyId: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">Choose</option>
                          {options?.fulfillment.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <strong>
                          {g.postStatus === "posted"
                            ? "Posted to eBay"
                            : g.postStatus === "posting"
                              ? "Posting…"
                              : g.status === "writing"
                                ? "Writing…"
                                : g.status === "idle"
                                  ? "Waiting"
                                  : g.status === "error" ||
                                      g.postStatus === "error"
                                    ? "Failed — retry"
                                    : problems.length
                                      ? `${problems.length} to fix`
                                      : "Ready"}
                        </strong>
                        {g.error && <small>{g.error}</small>}
                        {g.postError && <small>{g.postError}</small>}
                        {g.status === "done" &&
                          g.postStatus !== "posted" &&
                          problems.length > 0 && <small>{problems[0]}</small>}
                        <button
                          type="button"
                          aria-expanded={expanded === g.id}
                          onClick={() =>
                            setExpanded(expanded === g.id ? null : g.id)
                          }
                        >
                          {expanded === g.id
                            ? "Close details"
                            : "Review details"}
                        </button>
                      </td>
                    </tr>
                    {expanded === g.id && (
                      <tr>
                        <td colSpan={7}>{card(g)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="listing-list">{rows.map(card)}</div>
      )}
      <div className="batch-toolbar">
        <button
          type="button"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous 25
        </button>
        <span>
          {visible.length ? currentPage * 25 + 1 : 0}–
          {Math.min(visible.length, (currentPage + 1) * 25)} of {visible.length}
        </span>
        <button
          type="button"
          disabled={currentPage >= lastPage}
          onClick={() => setPage(currentPage + 1)}
        >
          Next 25
        </button>
      </div>
      <div className="result-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={active}
          onClick={onBack}
        >
          ← Back to items
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!done}
          onClick={() =>
            downloadFile("ebay-listings.csv", listingsToCsv(groups), "text/csv")
          }
        >
          ⬇️ Download spreadsheet (CSV)
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!done}
          onClick={() =>
            downloadFile(
              "ebay-listings.json",
              listingsToJson(groups),
              "application/json",
            )
          }
        >
          ⬇️ Download all ({done})
        </button>
      </div>
      <p className="footnote">
        Ready means required fields are filled. Review accuracy before posting.
        Your usual defaults are applied automatically; change them for
        exceptions.
      </p>
    </section>
  );
}
