"use strict";

// Offline evaluation for the analyst's concept-to-entity resolution — the
// "Validation" layer from Anthropic's self-service data-analytics design,
// scoped to what this lab can measure deterministically.
//
// The blog's central finding is that the hard part of analytics is not code
// but mapping an ambiguous question to the single correct data-model entity,
// and that this is gated offline against pinned ground truth. Here:
//
//   * a CASE pins ground truth: for a prompt + data-graph snapshot, which
//     canonical entity each modeled concept should resolve to.
//   * a HANDOFF is what the analyst emitted (its canonical_variable_resolution
//     table — see concept_resolution_protocol.handoff_field).
//   * scoreHandoff compares them into two numbers the analyst contract already
//     speaks in: canonical_resolution_rate (share hitting the canonical tier)
//     and accuracy (share resolved to the *correct* entity).
//
// Ground truth is pinned to a snapshot_id, so reruns are stable — the same
// requirement the canonical_reference snapshotting satisfies.

const HANDOFF_FIELD = "canonical_variable_resolution";

const SEMANTIC_TIERS = new Set(["verified_semantic", "semantic_definition", "curated_reference"]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function resolutionRows(handoff) {
  const rows = handoff && handoff[HANDOFF_FIELD];
  return Array.isArray(rows) ? rows : [];
}

function findRow(rows, concept) {
  const key = norm(concept);
  return rows.find((row) => norm(row?.concept) === key) || null;
}

function entityMatches(row, expected) {
  if (!row) return false;
  const candidates = [row.resolved_accession, row.resolved_canonical_id].map(norm).filter(Boolean);
  const targets = [expected.expected_accession, expected.expected_canonical_id].map(norm).filter(Boolean);
  if (!targets.length) return false;
  return candidates.some((value) => targets.includes(value));
}

function hitsSemanticTier(row) {
  return Boolean(row) && SEMANTIC_TIERS.has(norm(row.source_tier));
}

// Score a single emitted handoff against a case's pinned ground truth.
function scoreHandoff({ handoff, groundTruth }) {
  const expected = Array.isArray(groundTruth?.expected_resolutions)
    ? groundTruth.expected_resolutions
    : [];
  const rows = resolutionRows(handoff);
  const total = expected.length;

  let correct = 0;
  let semanticHits = 0;
  const mismatches = [];
  const unresolved = [];

  for (const item of expected) {
    const row = findRow(rows, item.concept);
    const isCorrect = entityMatches(row, item);
    const isSemantic = hitsSemanticTier(row);
    if (isCorrect) correct += 1;
    if (isSemantic) semanticHits += 1;
    if (!row) {
      unresolved.push(item.concept);
    } else if (!isCorrect) {
      mismatches.push({
        concept: item.concept,
        expected: item.expected_accession || item.expected_canonical_id || null,
        got: row.resolved_accession || row.resolved_canonical_id || null,
        source_tier: row.source_tier || null,
      });
    }
  }

  const rate = (n) => (total === 0 ? 1 : n / total);
  return {
    total,
    correct,
    canonical_resolution_rate: rate(semanticHits),
    accuracy: rate(correct),
    unresolved_concepts: unresolved,
    mismatches,
  };
}

// Per-domain launch gate: the blog gates each domain until evals clear a
// threshold and targets ~100% canonical-tier resolution.
function gateResult(score, { accuracy_threshold = 0.9, resolution_rate_target = 1.0 } = {}) {
  const reasons = [];
  if (score.accuracy < accuracy_threshold) {
    reasons.push(`accuracy ${score.accuracy.toFixed(3)} < threshold ${accuracy_threshold}`);
  }
  if (score.canonical_resolution_rate < resolution_rate_target) {
    reasons.push(
      `canonical_resolution_rate ${score.canonical_resolution_rate.toFixed(3)} < target ${resolution_rate_target}`,
    );
  }
  return { passed: reasons.length === 0, reasons, accuracy_threshold, resolution_rate_target };
}

// Telemetry row — stored like the blog stores eval results so "did that change
// help?" is a query. Caller injects ts + git_sha (no clock read in here).
function telemetryRecord({ caseId, domain, snapshotId, gitSha, ts, score, gate }) {
  return {
    ts: ts || null,
    git_sha: gitSha || null,
    case_id: caseId || null,
    domain: domain || null,
    snapshot_id: snapshotId || null,
    accuracy: score.accuracy,
    canonical_resolution_rate: score.canonical_resolution_rate,
    correct: score.correct,
    total: score.total,
    passed: gate ? gate.passed : null,
  };
}

function evaluateCase({ evalCase, handoff, thresholds }) {
  const score = scoreHandoff({ handoff, groundTruth: evalCase.ground_truth });
  const gate = gateResult(score, thresholds || evalCase.thresholds || {});
  return { case_id: evalCase.case_id, domain: evalCase.domain || null, score, gate };
}

module.exports = {
  HANDOFF_FIELD,
  SEMANTIC_TIERS,
  scoreHandoff,
  gateResult,
  telemetryRecord,
  evaluateCase,
};
