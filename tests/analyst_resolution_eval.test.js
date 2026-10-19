"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scoreHandoff,
  gateResult,
  telemetryRecord,
  evaluateCase,
  HANDOFF_FIELD,
} = require("../src/evals/analyst_resolution_eval");

const groundTruth = {
  expected_resolutions: [
    { concept: "primary_exposure", expected_accession: "GSE318067", expected_tier: "verified_semantic" },
    { concept: "outcome", expected_canonical_id: "dataset:somalogic:geo:gse318067" },
  ],
};

function handoff(rows) {
  return { [HANDOFF_FIELD]: rows };
}

test("perfect resolution scores 100% accuracy and canonical rate", () => {
  const score = scoreHandoff({
    handoff: handoff([
      { concept: "primary_exposure", resolved_accession: "GSE318067", source_tier: "verified_semantic" },
      { concept: "outcome", resolved_canonical_id: "dataset:somalogic:geo:gse318067", source_tier: "verified_semantic" },
    ]),
    groundTruth,
  });
  assert.equal(score.accuracy, 1);
  assert.equal(score.canonical_resolution_rate, 1);
  assert.equal(score.mismatches.length, 0);
  assert.ok(gateResult(score).passed);
});

test("a raw-table resolution counts as correct but lowers the canonical rate", () => {
  const score = scoreHandoff({
    handoff: handoff([
      { concept: "primary_exposure", resolved_accession: "GSE318067", source_tier: "raw_table" },
      { concept: "outcome", resolved_canonical_id: "dataset:somalogic:geo:gse318067", source_tier: "verified_semantic" },
    ]),
    groundTruth,
  });
  assert.equal(score.accuracy, 1); // entity is right
  assert.equal(score.canonical_resolution_rate, 0.5); // but one did not hit the semantic tier
  const gate = gateResult(score, { resolution_rate_target: 1.0 });
  assert.equal(gate.passed, false);
  assert.match(gate.reasons.join(" "), /canonical_resolution_rate/);
});

test("wrong entity is a mismatch and fails accuracy", () => {
  const score = scoreHandoff({
    handoff: handoff([
      { concept: "primary_exposure", resolved_accession: "GSE282742", source_tier: "verified_semantic" },
      { concept: "outcome", resolved_canonical_id: "dataset:somalogic:geo:gse318067", source_tier: "verified_semantic" },
    ]),
    groundTruth,
  });
  assert.equal(score.accuracy, 0.5);
  assert.equal(score.mismatches[0].concept, "primary_exposure");
  assert.equal(score.mismatches[0].got, "GSE282742");
  assert.equal(gateResult(score).passed, false);
});

test("a missing concept is reported as unresolved", () => {
  const score = scoreHandoff({
    handoff: handoff([
      { concept: "primary_exposure", resolved_accession: "GSE318067", source_tier: "verified_semantic" },
    ]),
    groundTruth,
  });
  assert.deepEqual(score.unresolved_concepts, ["outcome"]);
  assert.equal(score.accuracy, 0.5);
});

test("telemetry record carries injected ts/sha and the key metrics", () => {
  const score = scoreHandoff({ handoff: handoff([]), groundTruth });
  const rec = telemetryRecord({
    caseId: "c1",
    domain: "omics",
    snapshotId: "snap",
    gitSha: "abc123",
    ts: "2026-06-07T00:00:00Z",
    score,
    gate: gateResult(score),
  });
  assert.equal(rec.git_sha, "abc123");
  assert.equal(rec.ts, "2026-06-07T00:00:00Z");
  assert.equal(rec.case_id, "c1");
  assert.equal(rec.passed, false);
});

test("evaluateCase wires case thresholds through", () => {
  const evalCase = {
    case_id: "c1",
    domain: "omics",
    ground_truth: groundTruth,
    thresholds: { accuracy_threshold: 0.5, resolution_rate_target: 0.5 },
  };
  const result = evaluateCase({
    evalCase,
    handoff: handoff([
      { concept: "primary_exposure", resolved_accession: "GSE318067", source_tier: "raw_table" },
      { concept: "outcome", resolved_canonical_id: "dataset:somalogic:geo:gse318067", source_tier: "verified_semantic" },
    ]),
  });
  // accuracy 1.0 >= 0.5 and rate 0.5 >= 0.5 -> passes under the relaxed case thresholds
  assert.equal(result.gate.passed, true);
});
