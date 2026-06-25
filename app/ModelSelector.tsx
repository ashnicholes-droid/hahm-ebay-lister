"use client";

import { useEffect, useState } from "react";
import {
  getAnalysisModel,
  getSortModel,
  saveAnalysisModel,
  saveSortModel,
} from "@/lib/model-preferences";
import type { ModelOption } from "@/app/api/models/route";

interface ModelsPayload {
  sortModels: ModelOption[];
  analysisModels: ModelOption[];
}

export function ModelSelector() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sortModel, setSortModel] = useState("");
  const [analysisModel, setAnalysisModel] = useState("");

  useEffect(() => {
    const savedSort = getSortModel();
    const savedAnalysis = getAnalysisModel();

    fetch("/api/models")
      .then((r) => r.json())
      .then((data: ModelsPayload) => {
        setModels(data);

        const defaultSort =
          data.sortModels.find((m) => m.isDefault)?.id ?? data.sortModels[0]?.id ?? "";
        setSortModel(
          savedSort && data.sortModels.some((m) => m.id === savedSort)
            ? savedSort
            : defaultSort
        );

        const defaultAnalysis =
          data.analysisModels.find((m) => m.isDefault)?.id ??
          data.analysisModels[0]?.id ??
          "";
        setAnalysisModel(
          savedAnalysis && data.analysisModels.some((m) => m.id === savedAnalysis)
            ? savedAnalysis
            : defaultAnalysis
        );
      })
      .catch(() => {
        setLoadError(true);
        setSortModel(savedSort ?? "");
        setAnalysisModel(savedAnalysis ?? "");
      });
  }, []);

  const handleSortChange = (id: string) => {
    setSortModel(id);
    saveSortModel(id);
  };

  const handleAnalysisChange = (id: string) => {
    setAnalysisModel(id);
    saveAnalysisModel(id);
  };

  const sortDesc = models?.sortModels.find((m) => m.id === sortModel)?.description;
  const analysisDesc = models?.analysisModels.find((m) => m.id === analysisModel)?.description;

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost model-settings-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="model-settings-body"
      >
        ⚙ Model Settings{" "}
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div id="model-settings-body" className="model-settings-body">
          {loadError && (
            <p className="note note-error" style={{ margin: 0, gridColumn: "1 / -1" }}>
              Couldn&rsquo;t load the model list — the app will use its defaults.
            </p>
          )}

          <div className="field">
            <label htmlFor="sort-model">Photo Sorting Model</label>
            {models ? (
              <select
                id="sort-model"
                value={sortModel}
                onChange={(e) => handleSortChange(e.target.value)}
                className="model-select"
              >
                {models.sortModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <select disabled className="model-select">
                <option>Loading…</option>
              </select>
            )}
            {sortDesc && <span className="field-hint model-hint">{sortDesc}</span>}
          </div>

          <div className="field">
            <label htmlFor="analysis-model">Listing Generation Model</label>
            {models ? (
              <select
                id="analysis-model"
                value={analysisModel}
                onChange={(e) => handleAnalysisChange(e.target.value)}
                className="model-select"
              >
                {models.analysisModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <select disabled className="model-select">
                <option>Loading…</option>
              </select>
            )}
            {analysisDesc && <span className="field-hint model-hint">{analysisDesc}</span>}
          </div>
        </div>
      )}
    </>
  );
}
