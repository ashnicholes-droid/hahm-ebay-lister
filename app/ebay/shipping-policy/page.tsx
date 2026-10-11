"use client";

import { useEffect, useMemo, useState } from "react";
import { apiPost } from "@/lib/api-client";
import {
  SHIPPING_POLICY_APPLY_BATCH,
  type ShippingPolicyApplyResultRow,
  type ShippingPolicyPreviewResult,
} from "@/lib/ebay/clothing-shipping-policy";

const PAGE_ROWS = 40;

type ConnectionBody = { workMode: "store" | "client"; clientId: string | null };

export default function ShippingPolicyPage() {
  const [connection, setConnection] = useState<ConnectionBody>({ workMode: "store", clientId: null });
  const [preview, setPreview] = useState<ShippingPolicyPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyRows, setApplyRows] = useState<ShippingPolicyApplyResultRow[]>([]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const workMode = window.localStorage.getItem("workMode") === "client" ? "client" : "store";
    const clientId = window.localStorage.getItem("selectedClientId");
    setConnection({ workMode, clientId: workMode === "client" ? clientId : null });
  }, []);

  const rows = preview?.listings ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const visible = useMemo(
    () => rows.slice(page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS),
    [rows, page]
  );
  const wouldUpdate = rows.filter((row) => row.action === "would_update");

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setApplyRows([]);
    setConfirmed(false);
    setPage(0);
    try {
      const response = await apiPost("/api/ebay/shipping-policy/preview", connection);
      const data = (await response.json()) as ShippingPolicyPreviewResult & { error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo hacer la vista previa.");
      setPreview(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo hacer la vista previa.");
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!preview || !confirmed || applying || wouldUpdate.length === 0) return;
    setApplying(true);
    setError(null);
    const collected: ShippingPolicyApplyResultRow[] = [];
    try {
      for (let index = 0; index < wouldUpdate.length; index += SHIPPING_POLICY_APPLY_BATCH) {
        const itemIds = wouldUpdate.slice(index, index + SHIPPING_POLICY_APPLY_BATCH).map((row) => row.itemId);
        const response = await apiPost("/api/ebay/shipping-policy/apply", { ...connection, itemIds });
        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
          results?: ShippingPolicyApplyResultRow[];
        };
        if (!response.ok || !data.ok || !data.results) {
          throw new Error(data.error || "El lote se detuvo antes de terminar.");
        }
        collected.push(...data.results);
        setApplyRows([...collected]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo actualizar.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          📦
        </span>
        <div>
          <h1>Shipping Policy</h1>
          <p>Vista previa de los listings activos. No cambia nada hasta que uses la acción de abajo.</p>
        </div>
      </header>

      <section className="panel">
        <p>
          Política buscada: <strong>Ebay Shipping Clothing</strong>. Cuenta:{" "}
          {connection.workMode === "client" ? "Client Job" : "My Store"}.
        </p>
        <button type="button" className="btn btn-primary" onClick={runPreview} disabled={previewing || applying}>
          {previewing ? "Revisando listings…" : "Vista previa"}
        </button>
        {error && <p className="ebay-notice err">{error}</p>}
      </section>

      {preview && (
        <section className="panel">
          <h2>Vista previa</h2>
          <p>dryRun: true. No se modificó ningún listing, precio, título, foto ni política en eBay.</p>
          <div className="policy-counts">
            <div className="policy-count">
              <strong>{preview.totalReviewed}</strong>
              Revisados
            </div>
            <div className="policy-count">
              <strong>{preview.alreadyUsing}</strong>
              Ya usan Ebay Shipping Clothing
            </div>
            <div className="policy-count">
              <strong>{preview.otherPolicy}</strong>
              Usan otra Shipping Policy
            </div>
            <div className="policy-count">
              <strong>{preview.unreadable}</strong>
              Policy no leída
            </div>
          </div>
          <p>
            Policy ID resuelto: <code>{preview.policyId}</code>
          </p>
          {preview.truncated && (
            <p>La lectura se detuvo al llegar al máximo de páginas. Este resultado no cubre toda la cuenta.</p>
          )}
          {preview.incomplete && (
            <p>
              eBay reportó {preview.totalEntries} listings activos y esta lectura clasificó {preview.totalReviewed}.
              No se actualizó nada.
            </p>
          )}

          <div className="policy-table-wrap">
            <table className="policy-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Título</th>
                  <th>Item ID</th>
                  <th>Offer ID</th>
                  <th>Shipping Policy actual</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.itemId}>
                    <td>{row.sku || "—"}</td>
                    <td>{row.title || "—"}</td>
                    <td>{row.itemId}</td>
                    <td>{row.offerId || "—"}</td>
                    <td>
                      {row.shippingPolicyName || "Sin nombre"}
                      {row.shippingPolicyId ? ` (${row.shippingPolicyId})` : ""}
                    </td>
                    <td>{row.action === "would_update" ? "Se actualizaría" : "No se tocaría"}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={6}>Ningún listing activo usa otra Shipping Policy.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <p>
              <button type="button" className="btn btn-ghost" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
                Anterior
              </button>{" "}
              Página {page + 1} de {pageCount}{" "}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((n) => n + 1)}
              >
                Siguiente
              </button>
            </p>
          )}

          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={applying || wouldUpdate.length === 0}
            />{" "}
            Ya revisé la vista previa y quiero actualizar solo los listings que usan otra Shipping Policy.
          </label>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!confirmed || applying || wouldUpdate.length === 0 || preview.truncated || preview.incomplete}
              onClick={runApply}
            >
              {applying ? "Actualizando…" : "Apply Ebay Shipping Clothing to Listings"}
            </button>
          </p>
          <p>
            Esa acción no corre sola. Omite los que ya usan esta política. No cambia precios, títulos,
            descripciones, fotos, SKU, cantidades, categorías, condition, return policy ni payment policy.
          </p>
        </section>
      )}

      {applyRows.length > 0 && (
        <section className="panel">
          <h2>Resultado de la actualización</h2>
          <p>
            Actualizados: {applyRows.filter((row) => row.status === "updated").length}. Omitidos:{" "}
            {applyRows.filter((row) => row.status === "skipped").length}. Errores:{" "}
            {applyRows.filter((row) => row.status === "error").length}.
          </p>
          <div className="policy-table-wrap">
            <table className="policy-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Título</th>
                  <th>Item ID</th>
                  <th>Offer ID</th>
                  <th>Estado</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {applyRows.map((row) => (
                  <tr key={`${row.itemId}-${row.status}`}>
                    <td>{row.sku || "—"}</td>
                    <td>{row.title || "—"}</td>
                    <td>{row.itemId}</td>
                    <td>{row.offerId || "—"}</td>
                    <td>{row.status}</td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p>
        <a href="/">Volver</a>
      </p>
    </main>
  );
}
