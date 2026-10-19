"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { datasetKeys, runnerLeadMatchScore, pickLeadScopedRunner } = require("../src/agents/shared/lead_evidence_match");
const { gateProgressSignals, filterSupersededGatekeeperReviews } = require("../src/reporting/reviews/gate/build/progress");
const { collectPreviousReviewContext } = require("../src/reporting/reviews/gate/review_context");
const { collectParsedGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");
const { buildGateFollowupActions } = require("../src/reporting/reviews/gate/actions");

const FAMILY = "loss_family_by_refinement_by_support_distance_factorial";
const DATASET = "/work/researchlab/.research-lab/datasets/cycle/simulations/loss_iteration_support_v1/episodes.csv";
const lead = { family: FAMILY, datasets: datasetKeys([DATASET]), hasIdentity: true, tokens: new Set(["support", "distance", "mujoco", "diffusion"]) };
const runner = (dataset, family = FAMILY) => ({
  status: "completed", dataset_root: dataset,
  hypothesis_results: [{ family, statement: "support distance mujoco diffusion" }],
  blueprint_executions: [{ blueprint_id: "interaction", status: "completed", produced_evidence: true }],
  validation_summary: { overall_status: "passed", checks: { dataset_sha256_verified: true } },
});

test("review dispatch carries the selected validation into native planner metadata", () => {
  const summary = { current_lead_key: "hyp:new", latest_validation_lane_id: "runner-new",
    latest_validation_summary: { overall_status: "degraded", checks: { dataset_sha256_verified: true } },
    derivable_hypothesis_candidates: [{ statement: "current factorial", primary_family: FAMILY }],
  };
  const [action] = buildGateFollowupActions(summary, [], ["novelty"]);
  assert.equal(action.latest_validation_lane_id, "runner-new");
  assert.equal(action.latest_validation_summary, summary.latest_validation_summary);
  assert.equal(action.gate_review_lead_key, "hyp:new");
});

test("a candidate-family mention in an unrelated executed dataset cannot bind evidence", () => {
  const wrong = runner("/sealed/2974c434610c5624-five_policy_support_crossover_v1");
  assert.equal(runnerLeadMatchScore(wrong, lead), 0);
  assert.equal(pickLeadScopedRunner([{ result: wrong, mtime: 100 }], lead), null);
  const current = { result: runner("/sealed/d958a74b0599a1d9-loss_iteration_support_v1"), mtime: 50 };
  assert.equal(pickLeadScopedRunner([{ result: wrong, mtime: 100 }, current], lead), current);
});

test("failed execution of the new dataset never falls back to the retired dataset", () => {
  const failed = { ...runner(DATASET), status: "failed", validation_summary: { blueprints_passed: 0 } };
  assert.equal(pickLeadScopedRunner([{ result: runner("/old/episodes.csv") }, { result: failed }], lead), null);
});

test("newer restatements keep same-family reviews but reject shared-vocabulary old families", () => {
  const current = { primary_family: FAMILY, dataset_keys: [...lead.datasets], lead_key: "hyp:current", source_mtime: 5000, primary_text: "support distance mujoco diffusion policy shared state" };
  const base = { verdict: "reject", source_mtime: 1000, rubric: [{ name: "novelty", score: 35 }], major_objections: [current.primary_text] };
  const split = filterSupersededGatekeeperReviews([
    { ...base, lane_id: "old", briefed_primary_family: "resource_matched_support_removal_dose_response" },
    { ...base, lane_id: "current", briefed_primary_family: FAMILY },
    { ...base, lane_id: "unbound" },
  ], {}, current);
  assert.deepEqual(split.activeReviews.map(x => x.lane_id), ["current"]);
  assert.deepEqual(split.supersededReviews.map(x => x.lane_id), ["old", "unbound"]);
});

test("collector binds the review to its author-stated lead, not alternative candidates", () => {
  const collection = collectParsedGatekeeperReviews([{ laneId: "gk", mtime: 100,
    rolePlan: { planner_metadata: { current_lead_under_review: { primary_family: FAMILY } } },
    result: { extracted_json: { verdict: "reject", reviewer_focus_rubric: "novelty", rubric: [{ name: "novelty", score: 35 }] } },
  }]);
  assert.equal(collection.parsedReviews[0].briefed_primary_family, FAMILY);
});

test("a same-family review of a retired validation cannot score the new result", () => {
  const identity = { primary_family: FAMILY, dataset_keys: [...lead.datasets], lead_key: "hyp:new" };
  const base = { verdict: "approve", briefed_primary_family: FAMILY, source_mtime: 100,
    rubric: [{ name: "technical_quality", score: 90 }] };
  const split = filterSupersededGatekeeperReviews([
    { ...base, lane_id: "old-review", briefed_validation_lane_id: "runner-old" },
    { ...base, lane_id: "new-review", briefed_validation_lane_id: "runner-new" },
  ], { latestValidationLaneId: "runner-new", latestValidationLeadMatchScore: 3 }, identity);
  assert.deepEqual(split.activeReviews.map(x => x.lane_id), ["new-review"]);
  assert.deepEqual(split.supersededReviews.map(x => x.lane_id), ["old-review"]);
});

test("unscoped old gate and conclusion comments stay out of the new review memory", () => {
  const context = collectPreviousReviewContext({ root: os.tmpdir(), cycleId: "scope-test",
    currentHypothesisIdentity: { primary_family: FAMILY, dataset_keys: [...lead.datasets] },
    previousGateReview: { blockers: ["old allocation was falsified"] },
    conclusion: { conclusion_blockers: ["bounded by the old novelty score"] }, approval: {},
  });
  assert.deepEqual(context.review_comments, []);
  assert.equal(context.superseded_review_sources.length, 3);
});

test("stale primary evidence cannot override the latest matching runner scan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "current-review-scope-"));
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  try {
    write(path.join(root, "state/cycle-lab-director-hypothesis.json"), { cycle_id: "cycle", primary_family: FAMILY,
      selected_hypothesis: { primary_family: FAMILY, statement: "support distance mujoco diffusion", dataset_or_accession: DATASET } });
    const oldPath = path.join(root, "artifacts/stats/cycle/followup-runner-232/result.json");
    write(oldPath, runner("/sealed/2974c434610c5624-five_policy_support_crossover_v1"));
    const newPath = path.join(root, "artifacts/stats/cycle/followup-runner-273/result.json");
    write(newPath, runner("/sealed/d958a74b0599a1d9-loss_iteration_support_v1"));
    const signals = gateProgressSignals({ primary_evidence: { source_result_path: oldPath, lane_id: "followup-runner-232" } }, { root, cycleId: "cycle" });
    assert.equal(signals.latestValidationLaneId, "followup-runner-273");
    assert.equal(signals.latestValidationLeadMatchScore, 3);
    fs.unlinkSync(newPath);
    assert.equal(gateProgressSignals({ primary_evidence: { source_result_path: oldPath } }, { root, cycleId: "cycle" }).latestValidationLaneId, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
