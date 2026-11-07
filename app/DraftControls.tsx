"use client";
import { useState, useRef, useEffect } from "react";
import type { ItemGroup, Photo } from "@/lib/types";
import type { AccountOptions } from "@/lib/ebay/publish";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import { requestText } from "@/lib/text-dialog";
import { loadAccountOptions } from "@/lib/account-options-client";
import { apiPost } from "@/lib/api-client";
import { draftIssues } from "@/lib/client-review";
import { isStandardSizeAspect } from "@/lib/ebay/aspects";

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

  // Hardcoded environment variable defaults for policies and package specs
  const ENV_SHIPPING_POLICY = process.env.NEXT_PUBLIC_SHIPPING_POLICY_ID ?? "";
  const ENV_PAYMENT_POLICY = process.env.NEXT_PUBLIC_PAYMENT_POLICY_ID ?? "";
  const ENV_RETURN_POLICY = process.env.NEXT_PUBLIC_RETURN_POLICY_ID ?? "";
  const ENV_SHIPPING_ORIGIN = process.env.NEXT_PUBLIC_SHIPPING_ORIGIN ?? "";

  const ENV_WEIGHT_OZ = process.env.NEXT_PUBLIC_DEFAULT_WEIGHT_OZ ? Number(process.env.NEXT_PUBLIC_DEFAULT_WEIGHT_OZ) : undefined;
  const ENV_LENGTH_IN = process.env.NEXT_PUBLIC_DEFAULT_LENGTH_IN ? Number(process.env.NEXT_PUBLIC_DEFAULT_LENGTH_IN) : undefined;
  const ENV_WIDTH_IN = process.env.NEXT_PUBLIC_DEFAULT_WIDTH_IN ? Number(process.env.NEXT_PUBLIC_DEFAULT_WIDTH_IN) : undefined;
  const ENV_HEIGHT_IN = process.env.NEXT_PUBLIC_DEFAULT_HEIGHT_IN ? Number(process.env.NEXT_PUBLIC_DEFAULT_HEIGHT_IN) : undefined;

  useEffect(() => {
    if (g.listing && !defaultsRequested.current) {
      defaultsRequested.current = true;
      void loadOptions();
    }
  }, [Boolean(g.listing)]);

  // Automatically apply env variable defaults if not already set on the group shipping state
  useEffect(() => {
    if (!g.listing) return;
    const currentShipping = g.shipping ?? {};
    const needsUpdate =
      !currentShipping.fulfillmentPolicyId ||
      !currentShipping.paymentPolicyId ||
      !currentShipping.returnPolicyId ||
      !currentShipping.locationKey ||
      currentShipping.weightOz === undefined ||
      currentShipping.lengthIn === undefined ||
      currentShipping.widthIn === undefined ||
      currentShipping.heightIn === undefined;

    if (needsUpdate) {
      onGroupEdit(g.id, {
        shipping: {
          ...currentShipping,
          fulfillmentPolicyId: currentShipping.fulfillmentPolicyId || ENV_SHIPPING_POLICY,
          paymentPolicyId: currentShipping.paymentPolicyId || ENV_PAYMENT_POLICY,
          returnPolicyId: currentShipping.returnPolicyId || ENV_RETURN_POLICY,
          locationKey: currentShipping.locationKey || ENV_SHIPPING_ORIGIN,
          weightOz: currentShipping.weightOz ?? ENV_WEIGHT_OZ,
          lengthIn: currentShipping.lengthIn ?? ENV_LENGTH_IN,
          widthIn: currentShipping.widthIn ?? ENV_WIDTH_IN,
          heightIn: currentShipping.heightIn ?? ENV_HEIGHT_IN,
        },
      });
    }
  }, [
    g.id,
    g.listing,
    g.shipping,
    ENV_SHIPPING_POLICY,
    ENV_PAYMENT_POLICY,
    ENV_RETURN_POLICY,
    ENV_SHIPPING_ORIGIN,
    ENV_WEIGHT_OZ,
    ENV_LENGTH_IN,
    ENV_WIDTH_IN,
    ENV_HEIGHT_IN,
  ]);

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
      next.estimates = Object.fromEntries(
        Object.entries(l.estimates ?? {}).filter(
          ([k]) =>
            !(k in patch.item_specifics!) ||
            patch.item_specifics![k] === l.item_specifics?.[k],
        ),
      );
    }
    onGroupEdit(g.id, {
      listing: next,
      compsStatus: "stale",
      comps: undefined,
    });
  };

  const specifics = l.item_specifics ?? {};
  const missingLevel = (name: string): "required" | "recommended" | "" => {
    if ((specifics[name] ?? "").trim()) return "";
    const meta = g.preparation?.aspects.find((a) => a.name === name);
    if (meta?.required) return "required";
    return meta?.usage === "RECOMMENDED" ? "recommended" : "";
  };
  const rank = { required: 0, recommended: 1, "": 2 };
  const names = [
    ...new Set([
      ...(g.preparation?.aspects ?? [])
        .filter((a) => a.required || a.usage === "RECOMMENDED")
        .map((a) => a.name),
      ...Object.keys(specifics),
    ]),
  ].sort((a, b) => rank[missingLevel(a)] - rank[missingLevel(b)]);
  const missingRequired = names.filter((n) => missingLevel(n) === "required");
  const missingRecommended = names.filter(
    (n) => missingLevel(n) === "recommended",
  );

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

  async function loadOptions(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const options = await loadAccountOptions(refresh);
      setOptions(options);
      const current = latest.current;
      const shipping = applyShippingDefaults(current.shipping ?? {}, options);
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
                condition:
                  e.target.value === "NEW_WITH_DEFECTS"
                    ? "NEW_WITH_DEFECTS"
                    : e.target.value.startsWith("NEW")
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
          Editable item specifics — AI estimates are marked; check them before posting
        </summary>
        {(missingRequired.length > 0 || missingRecommended.length > 0) && (
          <p className="specifics-missing-summary">
            {missingRequired.length > 0 && (
              <span className="missing-required">
                Required, still empty: {missingRequired.join(", ")}.
              </span>
            )}{" "}
            {missingRecommended.length > 0 && (
              <span className="missing-recommended">
                Recommended, still empty: {missingRecommended.join(", ")}.
              </span>
            )}
          </p>
        )}
        {names.map((name) => {
          const meta = g.preparation?.aspects.find((a) => a.name === name);
          const missing = missingLevel(name);
          return (
            <label
              key={name}
              className={`specific-edit${missing ? ` specific-missing-${missing}` : ""}`}
            >
              <span className="specific-head">
                <span className="specific-name">
                  {name}
                  {meta?.required ? " *" : ""}
                </span>
                {missing && (
                  <span className="missing-tag">
                    {missing === "required"
                      ? " · Required — missing"
                      : " · Recommended — missing"}
                  </span>
                )}
                {l.evidence?.[name]?.length
                  ? ` (AI cites photo ${l.evidence[name]
                      .map((n) => {
                        const id = g.evidencePhotoIds?.[n - 1];
                        return id ? g.photoIds.indexOf(id) + 1 : n;
                      })
                      .join(", ")}; verify)`
                  : ""}
                {l.estimates?.[name] ? (
                  <span className="estimate-tag">
                    {" "}
                    AI estimate · {l.estimates[name]}% sure
                  </span>
                ) : null}
              </span>
              {meta &&
              (meta.mode === "SELECTION_ONLY" || isStandardSizeAspect(meta)) &&
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
          Policies (shipping, payment, returns, and origin) are configured via environment defaults.
        </p>
        <details open>
          <summary>Package weight and dimensions</summary>
          <p className="note">
            Default measurements are preloaded from environment configuration and can be edited below.
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
