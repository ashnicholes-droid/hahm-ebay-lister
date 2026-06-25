"use client";

const SORT_KEY     = "listing-writer:sort-model";
const ANALYSIS_KEY = "listing-writer:analysis-model";

export function getSortModel(): string | null {
  try {
    return window.localStorage.getItem(SORT_KEY);
  } catch {
    return null;
  }
}

export function saveSortModel(model: string): void {
  try {
    window.localStorage.setItem(SORT_KEY, model);
  } catch {
    /* private browsing — pref won't persist */
  }
}

export function getAnalysisModel(): string | null {
  try {
    return window.localStorage.getItem(ANALYSIS_KEY);
  } catch {
    return null;
  }
}

export function saveAnalysisModel(model: string): void {
  try {
    window.localStorage.setItem(ANALYSIS_KEY, model);
  } catch {
    /* private browsing — pref won't persist */
  }
}
