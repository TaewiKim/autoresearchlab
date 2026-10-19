"use strict";

// Bridge between the runtime and the offline eval harness.
//
// run_analyst_evals.js scores an analyst handoff's canonical_variable_resolution
// table. The real analyst is an LLM agent driven by the Rust runtime; its
// handoff is persisted in a completed lane's result.json. This module extracts
// that handoff into the eval-handoff shape so production output can be scored —
// the agent already ran, we are just capturing what it produced.
//
// Handoffs emitted before the concept_resolution_protocol contract do not carry
// an explicit canonical_variable_resolution. For those we project a best-effort
// table from the fields that DO exist (dataset_root / handoff_checks), tagged
// source_tier "raw_table" and _projected:true. That is deliberately
// conservative: it scores the entity but not the canonical tier, so the eval
// correctly flags that the resolution was never declared at the semantic tier.

const { FIELD } = require("../agents/shared/artifact_contracts");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function str(value) {
  return String(value || "").trim();
}

// Locate the analyst handoff regardless of where the runtime parked it.
function findAnalystHandoff(result) {
  if (!result || typeof result !== "object") return null;
  const rp = result.role_plan || {};
  const pm = rp.planner_metadata || {};
  return (
    result.analyst_handoff ||
    pm.analyst_handoff ||
    (pm.analysis_request && pm.analysis_request.analyst_handoff) ||
    null
  );
}

// "/…/datasets/<cycle>/gse318067" -> "GSE318067"
function accessionFromDatasetRoot(datasetRoot) {
  const tail = str(datasetRoot).split(/[\\/]/).filter(Boolean).pop();
  return tail ? tail.toUpperCase() : null;
}

function projectResolutionFromHandoff(handoff) {
  const accession =
    accessionFromDatasetRoot(handoff.dataset_root) ||
    accessionFromDatasetRoot((asArray(handoff.handoff_checks)[0] || {}).dataset) ||
    null;
  if (!accession) return [];
  const primaryCheck = asArray(handoff.handoff_checks)[0] || {};
  const exposures = asArray(primaryCheck.exposures).filter((x) => str(x));
  const concepts = [];
  if (exposures.length) concepts.push(["primary_exposure", exposures[0]]);
  else concepts.push(["primary_exposure", null]);
  if (str(primaryCheck.outcome)) concepts.push(["outcome", primaryCheck.outcome]);
  else concepts.push(["outcome", null]);

  return concepts.map(([concept]) => ({
    concept,
    resolved_canonical_id: null,
    resolved_accession: accession,
    // Unknown tier in a pre-contract handoff — assume raw_table so the
    // canonical_resolution_rate honestly reflects the missing declaration.
    source_tier: "raw_table",
    freshness: null,
    _projected: true,
  }));
}

// Build the eval-handoff object from a lane result.json payload.
function extractEvalHandoff(result, { caseId = null, laneRef = null } = {}) {
  const handoff = findAnalystHandoff(result);
  if (!handoff) {
    return { ok: false, reason: "no analyst_handoff found in result" };
  }
  const explicit = asArray(handoff[FIELD.CANONICAL_VARIABLE_RESOLUTION]);
  const resolution = explicit.length ? explicit : projectResolutionFromHandoff(handoff);
  return {
    ok: true,
    projected: explicit.length === 0,
    handoff: {
      _captured_from: laneRef || null,
      _case_id: caseId || null,
      _projected_resolution: explicit.length === 0,
      primary_hypothesis_id: handoff.primary_hypothesis_id || null,
      [FIELD.CANONICAL_VARIABLE_RESOLUTION]: resolution,
    },
  };
}

module.exports = {
  extractEvalHandoff,
  findAnalystHandoff,
  projectResolutionFromHandoff,
  accessionFromDatasetRoot,
};
