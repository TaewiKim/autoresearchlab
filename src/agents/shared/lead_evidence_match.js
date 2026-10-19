"use strict";

// Lead-scoped runner-evidence binding.
//
// Problem this fixes (v61 budget-wall, 2026-07-16): the gate bound the *latest*
// runner result as the selected lead's primary validation evidence, regardless of
// which hypothesis/family that runner actually executed. After the LabDirector
// pivots the lead (which is how novelty climbs), the newest runner is usually a
// DIFFERENT / retired family, so the gatekeeper honestly reports "no current-family
// validation artifacts for the selected hypothesis" and reproducibility stays pinned
// low, even though a real runner for the selected lead may exist. This module lets
// the binding sites prefer the newest runner whose executed family/statement matches
// the selected lead and that has a real (non-deferred) blueprint execution.
//
// DEFENSIVE / no-regression contract: if the selected lead has no extractable
// identity, or a legacy cycle has no declared dataset path, its original fallback
// remains available. A declared dataset must match executed input provenance:
// unrelated and unbound results cannot stand in for missing current evidence.
//
// One exception, deliberate (2026-09-29): a run that FAILED TO EXECUTE is not a
// candidate at all (isFailedExecutionNotEvidence). When every candidate is one,
// there is no evidence to bind and the ranker returns null; both callers handle
// null. Returning the failed run instead is what let a runner that measured
// nothing supersede every gatekeeper review on cycle-a-20260919.

const fs = require("fs");
const path = require("path");
const { cycleStateReader } = require("./gated_state");
const { currentAnalysisContract } = require("../../policy/analysis_contract");

const STOP_TOKENS = new Set([
  "about", "after", "against", "analysis", "based", "claim", "composite", "current",
  "dataset", "effect", "estimate", "evidence", "experiment", "gate", "held", "hypothesis",
  "into", "method", "outcome", "over", "preregistered", "primary", "review", "score",
  "signal", "study", "their", "this", "that", "under", "using", "validation", "versus",
  "which", "with", "without",
]);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function distinctiveTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 5 && !STOP_TOKENS.has(token) && !/^gse\d+$/i.test(token)),
  );
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Match original and sealed copies by their declared bundle, across host paths.
function datasetKey(value) {
  const text = String(value || "").trim().replace(/\\/g, "/").toLowerCase();
  if (!text) return null;
  // GEO accession review scoping already has its own established contract.
  if (/^(?:gse|gds|gsm)\d+$/.test(text)) return null;
  const parts = text.replace(/\/+$/, "").split("/");
  const last = parts.at(-1);
  const bundle = /\.(csv|tsv|parquet|jsonl|xlsx?)$/.test(last) ? parts.at(-2) : last;
  return bundle?.replace(/^[a-f0-9]{16,64}-/, "") || null;
}

function datasetKeys(values) {
  return new Set(values.map(datasetKey).filter(Boolean));
}

function runnerDatasetKeys(result) {
  const handoff = result?.role_plan?.planner_metadata?.analysis_request?.analyst_handoff || {};
  return datasetKeys([
    result?.dataset_root,
    ...asArray(handoff.handoff_checks).flatMap((check) => [check.dataset_declared, check.dataset, check.dataset_root]),
  ]);
}

function reviewMatchesSelectedLead(review, leadIdentity) {
  if (!leadIdentity?.datasets?.size) return true; // legacy, unscoped cycles
  const identity = review?.current_hypothesis_identity;
  // Bound to a contract only when it names one: a review written before any
  // analysis ran under the lead's contract is judged by family and dataset
  // (see isBriefedOnSupersededLead, gate/build/progress.js).
  if (leadIdentity.contractId && identity?.analysis_contract_id
      && identity.analysis_contract_id !== leadIdentity.contractId) return false;
  if (!identity || identity.primary_family !== leadIdentity.family) return false;
  return asArray(identity.dataset_keys).some((key) => leadIdentity.datasets.has(key));
}

function selectedLeadReviewIdentity(root, cycleId, summary = {}) {
  const lead = selectedLeadIdentity(root, cycleId, summary);
  return { primary_family: lead.family, dataset_keys: [...lead.datasets], analysis_contract_id: lead.contractId || null };
}

// Selected-lead identity from the authoritative LabDirector hypothesis file, with a
// researcher-view summary fallback for focus_hypotheses.
function selectedLeadIdentity(root, cycleId, summary = {}) {
  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  // The lead under comparison is admitted for this cycle, not assumed.
  const hypothesis = cycleStateReader({ root, cycleId, task: "lead_evidence_match" })
    .path(hypothesisPath, "lab-director-hypothesis") || {};
  const selected = hypothesis.selected_hypothesis || hypothesis.lead_hypothesis || {};
  const family = String(
    selected.primary_family ||
      selected.family_root ||
      hypothesis.primary_family ||
      hypothesis.family_root ||
      "",
  ).trim().toLowerCase();
  const focusStatements = asArray(summary && (summary.focus_hypotheses || summary.hypotheses))
    .map((item) => item && (item.statement || item.hypothesis_statement))
    .filter(Boolean);
  const statementText = [
    selected.statement,
    selected.hypothesis_statement,
    hypothesis.statement,
    hypothesis.hypothesis_statement,
    ...(!selected.statement && !hypothesis.statement ? focusStatements : []),
  ]
    .filter(Boolean)
    .join(" ");
  const tokens = distinctiveTokens(statementText);
  const hasIdentity = Boolean(family) || tokens.size >= 4;
  const datasets = datasetKeys([
    selected.dataset_or_accession, selected.identification_strategy?.dataset_or_accession,
    selected.identification_strategy?.materialized_dataset?.path,
    hypothesis.dataset_or_accession, hypothesis.identification_strategy?.dataset_or_accession,
  ]);
  return { family, tokens, datasets, hasIdentity, contractId: currentAnalysisContract(root, cycleId)?.contract_id || null };
}

// Families/statements a runner result actually executed.
function runnerExecutedIdentity(result) {
  const families = new Set();
  const statements = [];
  for (const item of asArray(result && result.hypothesis_results)) {
    if (item && item.family) families.add(String(item.family).trim().toLowerCase());
    if (item && item.hypothesis_id) statements.push(String(item.hypothesis_id));
    if (item && item.statement) statements.push(String(item.statement));
  }
  for (const item of asArray(result && result.selected_hypotheses)) {
    if (item && item.statement) statements.push(String(item.statement));
    for (const claim of asArray(item && item.claims)) {
      if (claim && claim.statement) statements.push(String(claim.statement));
    }
  }
  for (const item of asArray(result && result.assigned_hypotheses)) {
    if (typeof item === "string") statements.push(item);
    else if (item && item.statement) statements.push(String(item.statement));
  }
  return { families, statementText: statements.join(" ") };
}

// True when the runner produced at least one real (non-deferred) blueprint execution.
function runnerHasRealExecution(result) {
  const executions = asArray(result && result.blueprint_executions);
  if (executions.length === 0) return false;
  return executions.some((execution) => {
    const blueprintId = String((execution && execution.blueprint_id) || "").toLowerCase();
    if (!blueprintId) return true;
    return !/deferred|no_matching_bundle|no_blueprint|no_code|no_bundle/.test(blueprintId);
  });
}

// null  -> runner is un-scopable (carries no executed family/statement identity);
//          caller should treat it as "no opinion" and fall back to latest.
// 2     -> executed family matches the selected lead's family.
// 1     -> statement-token overlap with the selected lead (>= 3 distinctive tokens).
// 0     -> scopable but does not match the selected lead.
function runnerLeadMatchScore(result, leadIdentity) {
  if (!leadIdentity || !leadIdentity.hasIdentity) return null;
  const datasets = runnerDatasetKeys(result);
  if (leadIdentity.datasets?.size && datasets.size
      && ![...datasets].some((key) => leadIdentity.datasets.has(key))) return 0;
  const datasetMatched = leadIdentity.datasets?.size && datasets.size;
  if (leadIdentity.contractId) {
    const binding = result?.analysis_contract_validation || result?.validation_summary?.analysis_contract_validation;
    if (!binding || binding.contract_id !== leadIdentity.contractId || binding.status !== "verified"
        || binding.evidence_role !== "primary" || !datasetMatched) return 0;
    return 3;
  }
  const executed = runnerExecutedIdentity(result);
  if (executed.families.size === 0 && !executed.statementText) return null;
  if (leadIdentity.family && executed.families.size > 0) {
    if (executed.families.has(leadIdentity.family)) return datasetMatched ? 3 : 2;
    // MEASURED ON cycle-a-20260919, 2026-10-07: runner-181 named
    // loss_refinement_support_factorial, but three shared robotics terms made
    // it look like the newly selected coverage_diversity_randomized_factorial.
    // Explicit, different family identities outrank incidental prose overlap.
    return 0;
  }
  if (leadIdentity.tokens && leadIdentity.tokens.size) {
    const runnerTokens = distinctiveTokens(executed.statementText);
    let overlap = 0;
    for (const token of leadIdentity.tokens) {
      if (runnerTokens.has(token)) overlap += 1;
    }
    if (overlap >= 3) return datasetMatched ? 3 : 1;
  }
  return 0;
}

function latestByMtime(candidates) {
  return (
    candidates
      .slice()
      .sort(
        (left, right) =>
          Number(left.mtime || 0) - Number(right.mtime || 0) ||
          String(left.filePath || left.result_path || "").localeCompare(
            String(right.filePath || right.result_path || ""),
          ),
      )
      .at(-1) || null
  );
}

// Did this runner actually validate anything? A runner whose validation summary
// reports passing checks (or a passed overall status) carries evidence; one that
// failed/degraded with 0 passing checks carries none.
function runnerHasValidatedEvidence(result) {
  const summary = (result && (result.validation_summary || result.validationSummary)) || null;
  if (!summary || typeof summary !== "object") return false;
  const status = String(summary.overall_status || "").trim().toLowerCase();
  const checks = summary.checks && typeof summary.checks === "object" ? summary.checks : {};
  const passed = Object.values(checks).filter((value) => value === true).length;
  if (passed > 0) return true;
  return status === "passed";
}

// Fallback when the lead cannot be matched (no family/statement on the lead, or
// no runner matches it). Latest-by-mtime alone is actively harmful here: on v70
// the selected lead had `primary_family: null`, so this path ran and bound
// followup-runner-98 — status "failed", 0/2 checks, primary_effect null — purely
// because it was newest, while followup-runner-01 sat there "passed" with 13/13
// checks and a full PSNR/SSIM table. The gate then read an evidence-free cycle.
// Prefer a runner that actually validated something; only then take the newest.
function bestFallback(list) {
  const validated = list.filter((item) => runnerHasValidatedEvidence(item.result));
  if (validated.length > 0) return latestByMtime(validated);
  const executed = list.filter((item) => runnerHasRealExecution(item.result));
  if (executed.length > 0) return latestByMtime(executed);
  return latestByMtime(list);
}

// Pick the runner candidate to bind as the selected lead's evidence.
// candidates: [{ filePath|result_path, result, mtime, ... }]
// Returns the same candidate object shape (so callers keep their extra fields).
// A run that failed to execute is not evidence, negative or otherwise.
//
// MEASURED ON cycle-a-20260919, 2026-09-29: followup-runner-66 failed
// before inference (status failed, overall degraded, 0 of 2 blueprints passed,
// both checks valid_falsification_result false), and it was picked here as the
// lead's newest evidence -- by the cycle summary's primary_evidence and by the
// gate's runner scan alike. As "newer validation" it superseded all 20
// gatekeeper reviews, and the gate projected 0 on every rubric while the
// gatekeepers had scored the lead 44-82.
//
// A genuine falsification still counts: a failed run with any passed blueprint,
// or any check resolved as a valid falsification, is evidence.
function isFailedExecutionNotEvidence(result) {
  if (String(result?.status || "").toLowerCase() !== "failed") return false;
  const summary = result?.validation_summary && typeof result.validation_summary === "object"
    ? result.validation_summary
    : {};
  if (Number(summary.blueprints_passed || 0) > 0) return false;
  const resolutions = Array.isArray(summary.handoff_check_resolutions) ? summary.handoff_check_resolutions : [];
  return !resolutions.some((item) => item?.valid_falsification_result === true);
}

function pickLeadScopedRunner(candidates, leadIdentity) {
  const list = asArray(candidates).filter((candidate) => !isFailedExecutionNotEvidence(candidate && candidate.result));
  if (list.length === 0) return null;
  if (!leadIdentity || !leadIdentity.hasIdentity) return bestFallback(list);

  const scored = list.map((candidate) => ({
    candidate,
    score: runnerLeadMatchScore(candidate.result, leadIdentity),
    real: runnerHasRealExecution(candidate.result),
    mtime: Number(candidate.mtime || 0),
    key: String(candidate.filePath || candidate.result_path || ""),
  }));

  // If nothing is scopable (e.g. bio/epi runners), preserve the old behavior.
  if (scored.every((item) => item.score === null)) return bestFallback(list);

  const matches = scored.filter((item) => item.score !== null && item.score >= 1);
  // No runner matches the selected lead -> defensive fallback (no worse than before).
  if (matches.length === 0) return leadIdentity.datasets?.size ? null : bestFallback(list);

  // A declared dataset must be executed, not merely named as a candidate family.
  const scopedMatches = leadIdentity.datasets?.size
    ? matches.filter((item) => [...runnerDatasetKeys(item.candidate.result)].some((key) => leadIdentity.datasets.has(key)))
    : matches;
  if (!scopedMatches.length) return null;

  scopedMatches.sort(
    (left, right) =>
      right.score - left.score ||
      (right.real ? 1 : 0) - (left.real ? 1 : 0) ||
      right.mtime - left.mtime ||
      right.key.localeCompare(left.key),
  );
  return scopedMatches[0].candidate;
}

module.exports = {
  datasetKeys,
  runnerDatasetKeys,
  reviewMatchesSelectedLead,
  selectedLeadReviewIdentity,
  isFailedExecutionNotEvidence,
  distinctiveTokens,
  selectedLeadIdentity,
  runnerExecutedIdentity,
  runnerHasRealExecution,
  runnerHasValidatedEvidence,
  runnerLeadMatchScore,
  pickLeadScopedRunner,
};
