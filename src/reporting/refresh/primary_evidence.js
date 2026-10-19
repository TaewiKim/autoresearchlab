"use strict";

const path = require("path");
const { writeFileAtomic } = require("../../shared/json");
const { collectPrimaryEvidenceDetails } = require("../visualizer/artifact_collectors");
const { readJsonIfExists } = require("./state");

// The stored researcher view's primary_evidence is recomputed on every refresh,
// including the ones that do not rebuild the view.
//
// MEASURED ON cycle-a-20260919, 2026-09-29: while any core analysis
// lane is running -- which in a live cycle is nearly always -- refresh takes the
// pending shortcut and never rebuilds the researcher view. The gate then read
// primary_evidence from a view written hours earlier by code that still bound
// followup-runner-66 (a run that failed before inference); the fresh
// computation binds followup-runner-39. The director reads the same file.
//
// Only primary_evidence is recomputed: it costs ~5 ms against ~1.6 s for the
// whole view, and it is the field the gate's "latest validation" reads. The
// file is rewritten only when the value changed, and only that field (plus
// when it was recomputed) -- never the pending-refresh flags added in memory.
function refreshStoredPrimaryEvidence({ root, cycleId }) {
  const viewPath = path.join(root, "researcher-views", `${cycleId}-researcher-view.json`);
  const view = readJsonIfExists(viewPath);
  if (!view || typeof view !== "object") return { viewPath, view: null, changed: false };
  let fresh;
  try {
    const report = readJsonIfExists(view.source_paths?.report || "") || {};
    fresh = collectPrimaryEvidenceDetails({ root, cycleId, report });
  } catch (error) {
    // A failed recomputation keeps the stored value; it never blanks it.
    return { viewPath, view, changed: false, error: error?.message || String(error) };
  }
  if (JSON.stringify(fresh) === JSON.stringify(view.primary_evidence ?? null)) {
    return { viewPath, view, changed: false };
  }
  view.primary_evidence = fresh;
  view.primary_evidence_refreshed_at = new Date().toISOString();
  writeFileAtomic(viewPath, `${JSON.stringify(view, null, 2)}\n`);
  return { viewPath, view, changed: true };
}

module.exports = {
  refreshStoredPrimaryEvidence,
};
