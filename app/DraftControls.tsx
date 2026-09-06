"use client";
import { useState, useRef, useEffect } from "react";
import type { ItemGroup, Photo } from "@/lib/types";
import type { AccountOptions } from "@/lib/ebay/publish";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import { requestText } from "@/lib/text-dialog";
import { apiPost } from "@/lib/api-client";
import { draftIssues } from "@/lib/client-review";
interface Props {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
}
export function DraftControls({ group: g, photoById, onGroupEdit }: Props) {
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<AccountOptions>();
  const [error, setError] = useState("");
  const latest = useRef(g);
  latest.current = g;
  const defaultsRequested = useRef(false);
  useEffect(() => {
    if (g.listing && !defaultsRequested.current) {
      defaultsRequested.current = true;
      void loadOptions();
    }
  }, [Boolean(g.listing)]);
  if (!g.listing) return null;
  const l = g.listing;
  const edit = (patch: Partial<typeof l>) => {
    const next = { ...l, ...patch };
    if (patch.item_specifics) {
      for (const [key, field] of [
        ["Brand", "brand"],
        ["Size", "size"],
        ["Material", "material"],
        ["Type", "item_type"],
      ] as const)
        if (key in patch.item_specifics)
          next[field] = patch.item_specifics[key];
      next.evidence = {};
    }
    onGroupEdit(g.id, {
      listing: next,
      compsStatus: "stale",
      comps: undefined,
    });
  };
  const specifics = l.item_specifics ?? {};
  const names = [
    ...new Set([
      ...(g.preparation?.aspects ?? [])
        .filter((a) => a.required || a.usage === "RECOMMENDED")
        .map((a) => a.name),
      ...Object.keys(specifics),
    ]),
  ];
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const images = (g.analysisPhotoIds ?? g.photoIds)
        .map(photoById)
        .filter((p): p is Photo => Boolean(p) && p!.analysisSelected !== false)
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      const r = await apiPost("/api/ebay/prepare", {
        listing: l,
        images,
        enrich: !g.preparation,
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      if (latest.current.listing !== l)
        throw new Error(
          "The draft changed while preparing. Prepare it again to keep your edits.",
        );
      onGroupEdit(g.id, {
        listing: d.listing,
        preparation: d.preparation,
        preparationError: undefined,
        usage: [...(g.usage ?? []), ...(d.usage ?? [])],
        comps: undefined,
        compsStatus: "stale",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadOptions() {
    setBusy(true);
    setError("");
    try {
      const r = await apiPost("/api/ebay/options", {});
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      setOptions(d.options);
      const current = latest.current;
      const shipping = applyShippingDefaults(current.shipping ?? {}, d.options);
      if (JSON.stringify(shipping) !== JSON.stringify(current.shipping ?? {}))
        onGroupEdit(g.id, { shipping });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function research() {
    setBusy(true);
    setError("");
    onGroupEdit(g.id, { compsStatus: "loading", comps: undefined });
    try {
      const r = await apiPost("/api/ebay/comps", { listing: l });
      const d = await r.json();
      if (latest.current.listing !== l) return;
      onGroupEdit(g.id, {
        comps: d.comps,
        compsStatus: d.comps?.ok ? "ready" : "unavailable",
      });
      if (!d.ok) throw new Error(d.error);
    } catch (e) {
      setError((e as Error).message);
      onGroupEdit(g.id, { compsStatus: "unavailable" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset
      disabled={busy || g.postStatus === "posted" || g.postStatus === "posting"}
      className="draft-controls"
    >
      <legend>Review eBay details</legend>
      <label>
        Clothing department
        <select
          aria-label="Clothing department"
          value={
            l.category?.startsWith("womens_")
              ? "Women"
              : l.category?.startsWith("mens_")
                ? "Men"
                : ""
          }
          onChange={(e) => {
            const family = (l.category || "clothing").replace(
              /^(womens|mens)_/,
              "",
            );
            edit({
              category: e.target.value
                ? (e.target.value === "Women" ? "womens_" : "mens_") + family
                : "accessory",
              category_id: "",
              ebay_condition: "",
              item_specifics: { ...specifics, Department: e.target.value },
            });
          }}
        >
          <option value="">Not established / other</option>
          <option>Women</option>
          <option>Men</option>
        </select>
      </label>
      {!!g.preparation?.suggestions?.length && (
        <label>
          Suggested category
          <select
            value={l.category_id || ""}
            onChange={(e) =>
              edit({ category_id: e.target.value, ebay_condition: "" })
            }
          >
            {g.preparation.suggestions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Category ID{" "}
        <input
          aria-label="Category ID"
          value={l.category_id ?? ""}
          onChange={(e) =>
            edit({ category_id: e.target.value, ebay_condition: "" })
          }
        />
      </label>
      <button type="button" onClick={prepare}>
        {busy ? "Working…" : "Prepare category and specifics"}
      </button>
      {g.preparation && <p>{g.preparation.categoryName}</p>}
      {(error || g.preparationError) && (
        <p role="alert">{error || g.preparationError}</p>
      )}
      {g.preparation && (
        <label>
          eBay condition{" "}
          <select
            aria-label="eBay condition"
            value={l.ebay_condition ?? ""}
            onChange={(e) =>
              edit({
                ebay_condition: e.target.value,
                condition: e.target.value.startsWith("NEW")
                  ? "NEW_WITH_TAGS"
                  : e.target.value === "FOR_PARTS_OR_NOT_WORKING"
                    ? "FOR_PARTS_OR_NOT_WORKING"
                    : "GOOD",
              })
            }
          >
            <option value="">Choose condition</option>
            {g.preparation.conditions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Condition / testing notes
        <textarea
          value={l.condition_notes ?? ""}
          onChange={(e) => edit({ condition_notes: e.target.value })}
        />
      </label>
      <details open>
        <summary>
          Editable item specifics — fill only what you can verify
        </summary>
        {names.map((name) => {
          const meta = g.preparation?.aspects.find((a) => a.name === name);
          return (
            <label key={name} className="specific-edit">
              {name}
              {l.evidence?.[name]?.length
                ? ` (AI cites photo ${l.evidence[name]
                    .map((n) => {
                      const id = g.evidencePhotoIds?.[n - 1];
                      return id ? g.photoIds.indexOf(id) + 1 : n;
                    })
                    .join(", ")}; verify)`
                : ""}
              {meta?.required ? " *" : ""}
              {meta?.mode === "SELECTION_ONLY" &&
              meta.cardinality !== "MULTI" ? (
                <select
                  aria-label={name}
                  value={specifics[name] ?? ""}
                  onChange={(e) =>
                    edit({
                      item_specifics: { ...specifics, [name]: e.target.value },
                    })
                  }
                >
                  <option value="">Unknown — leave empty</option>
                  {meta.values.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={name}
                  value={specifics[name] ?? ""}
                  placeholder={
                    meta?.cardinality === "MULTI"
                      ? "Separate multiple values with |"
                      : "Unknown — leave empty"
                  }
                  onChange={(e) =>
                    edit({
                      item_specifics: { ...specifics, [name]: e.target.value },
                    })
                  }
                />
              )}
            </label>
          );
        })}
        <button
          type="button"
          onClick={async () => {
            const name = await requestText("Specific name, such as Model");
            if (name?.trim())
              edit({ item_specifics: { ...specifics, [name.trim()]: "" } });
          }}
        >
          Add a specific
        </button>
      </details>
      <details>
        <summary>Photos and analysis evidence ({g.photoIds.length})</summary>
        <p>
          All item photos publish. Choose which photos the AI reads; include
          labels and defects. Originals are saved on this device.
        </p>
        {g.photoIds.map((id, i) => {
          const p = photoById(id);
          return p ? (
            <div key={id}>
              <label>
                <input
                  type="checkbox"
                  checked={(g.analysisPhotoIds ?? g.photoIds).includes(id)}
                  onChange={(e) =>
                    onGroupEdit(g.id, {
                      analysisPhotoIds: e.target.checked
                        ? [...(g.analysisPhotoIds ?? g.photoIds), id]
                        : (g.analysisPhotoIds ?? g.photoIds).filter(
                            (x) => x !== id,
                          ),
                    })
                  }
                />
                Use photo {i + 1} for analysis
              </label>
              <img src={p.previewUrl} width={80} alt={`Item photo ${i + 1}`} />
              {p.original && (
                <button
                  type="button"
                  onClick={() => {
                    const u = URL.createObjectURL(p.original!);
                    const a = document.createElement("a");
                    a.href = u;
                    a.download = `${g.sku}-${i + 1}-original`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(u), 1000);
                  }}
                >
                  Save original
                </button>
              )}
            </div>
          ) : null;
        })}
      </details>
      <details open>
        <summary>Shipping and returns</summary>
        <p className="note">
          USPS Ground Advantage · flat buyer charge · 2 business days handling.
          Usually $7.95 for tees, shirts, blouses, lightweight pants, sandals
          and light shoes without boxes; $9.95 for heavier shoes, sweaters,
          jackets and jeans. Select the existing eBay policy you want for this
          item.
        </p>
        <p className="note">
          Your usual $7.95 shipping, Managed Payments, returns-accepted policy
          and shipping origin are selected automatically when available. Change
          any selection for this item.
        </p>
        {options && options.returns.length === 0 && (
          <p className="note-error">
            No returns-accepted policy was found. Check your eBay return policy,
            then reload policies here.
          </p>
        )}
        <button type="button" onClick={loadOptions}>
          Load my eBay policies and locations
        </button>
        {(
          [
            ["fulfillment", "fulfillmentPolicyId", "Shipping policy"],
            ["payment", "paymentPolicyId", "Payment policy"],
            ["returns", "returnPolicyId", "Return policy"],
            ["locations", "locationKey", "Shipping origin"],
          ] as const
        ).map(([kind, key, label]) => (
          <label key={key}>
            {label}
            <select
              aria-label={label}
              value={g.shipping?.[key] ?? ""}
              onChange={(e) =>
                onGroupEdit(g.id, {
                  shipping: { ...g.shipping, [key]: e.target.value },
                })
              }
            >
              <option value="">Select…</option>
              {!options && g.shipping?.[key] && (
                <option value={g.shipping[key]}>
                  {g.shipping[key]} (saved)
                </option>
              )}
              {options?.[kind].map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <details>
          <summary>Package weight and dimensions (optional)</summary>
          <p className="note">
            Leave blank for your flat-fee shipping. No package measurements will
            be sent unless you enter them.
          </p>
          {(
            [
              ["weightOz", "Packed weight (oz)"],
              ["lengthIn", "Length (in)"],
              ["widthIn", "Width (in)"],
              ["heightIn", "Height (in)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type="number"
                min="0.01"
                step="0.01"
                value={g.shipping?.[key] ?? ""}
                onChange={(e) =>
                  onGroupEdit(g.id, {
                    shipping: {
                      ...g.shipping,
                      [key]:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </details>
        {!options?.locations.length && options && (
          <p>
            Create an inventory location with your real address in eBay before
            publishing.
          </p>
        )}
      </details>
      <button type="button" onClick={research}>
        Refresh comparable asking prices
      </button>
      {g.compsStatus && g.compsStatus !== "ready" && (
        <p>
          Market research: {g.compsStatus}. The AI price is an unverified
          estimate.
        </p>
      )}
      {g.comps?.sources && (
        <details>
          <summary>Inspect comparable sources · {g.comps.matchBasis}</summary>
          <p>
            Checked {g.comps.checkedAt}. Asking prices are not sold prices.
            Verify identity, condition and accessories.
          </p>
          {g.comps.sources.map((s) => (
            <p key={s.id}>
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>{" "}
              — ${s.price.toFixed(2)} +{" "}
              {s.shipping === undefined
                ? "unknown shipping"
                : `$${s.shipping.toFixed(2)} shipping`}
            </p>
          ))}
        </details>
      )}
      {!!g.usage?.length && (
        <p>
          AI usage so far:{" "}
          {g.usage
            .reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
            .toLocaleString()}{" "}
          input tokens ·{" "}
          {g.usage.reduce((n, u) => n + u.output, 0).toLocaleString()} output ·
          estimated $
          {g.usage.reduce((n, u) => n + (u.estimatedUsd ?? 0), 0).toFixed(4)}{" "}
          (recorded calls; bulk sorting separate).
        </p>
      )}
      {draftIssues(g).length > 0 && (
        <ul aria-label="Review issues">
          {draftIssues(g).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
