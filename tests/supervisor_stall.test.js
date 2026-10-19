"use strict";

// What the supervisor could not see.
//
// MEASURED ON cycle-a-20260919, 2026-09-20: the lead hypothesis was
// recorded at 15:02:55 local (lab-director-hypothesis.selected_at_epoch_ms =
// 1789884175267) and for the next 5h38m the pipeline did not move. Forty-seven
// lanes finished in that window -- lab_director_requery_followup thirty times,
// chronicle_evidence_request_followup fifteen, labdirector_comparator_
// validation_followup six -- almost all of them `completed`. There was no
// pause, no harness stop, no repeated identical failure and no exhausted
// recovery chain, so maintainer.js's four triggers all stayed silent while the
// cycle burned 13.0M counted tokens and 23 hours of wall-clock.
//
// These tests are that window, in fixtures.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  MILESTONE_IDS,
  DEFAULT_STALL_MINUTES,
  DEFAULT_LANE_CHURN,
  DEFAULT_NO_EVIDENCE_MINUTES,
  deriveProgress,
  recordProgress,
  progressPath,
  stallFindings,
  supervisorConfig,
} = require("../src/orchestrator/cycle_progress");

const {
  budgetLimits,
  budgetPath,
  readTurnsIncremental,
  updateBudget,
} = require("../src/orchestrator/cycle_budget");

const { maybeRunMaintainer, __private } = require("../src/orchestrator/maintainer");
const hypothesisProgress = require("../src/reporting/hypothesis_progress");
const { validationOfCurrentLead } = require("../src/reporting/reviews/gate/build/progress");
const { runnerLeadMatchScore } = require("../src/agents/shared/lead_evidence_match");

const CYCLE = "stall-cycle";
const LEAD_MS = Date.parse("2026-09-20T06:02:55.267Z");
const MINUTE = 60 * 1000;

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stateDir(cwd) {
  return path.join(cwd, ".research-lab", "state");
}

function writeState(cwd, kind, value) {
  writeJson(path.join(stateDir(cwd), `${CYCLE}-${kind}.json`), value);
}

function appendJsonl(cwd, kind, rows) {
  const filePath = path.join(stateDir(cwd), `${CYCLE}-${kind}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
}

// The stage artifacts of a cycle, in the order the harness publishes them, each
// one exactly as much of the real shape as its milestone predicate reads.
const STAGES = {
  field_landscape: (cwd) => writeState(cwd, "field-landscape", {
    cycle_id: CYCLE, projected_at: "2026-09-19T13:46:00Z", subfields: [{ subfield_id: "a", open_problems: [{ open_problem_id: "op-1" }] }],
  }),
  frontier_harvest_reviewed: (cwd) => writeState(cwd, "frontier-harvest", {
    cycle_id: CYCLE, reviewed_at: "2026-09-20T05:59:02Z",
    top_k: [{ paper_id: "doi:a", title: "A", review_status: "accepted" }, { paper_id: "doi:b", title: "B", review_status: "excluded" }],
  }),
  sota_cards: (cwd) => writeState(cwd, "sota-cards", { projected_at: "2026-09-19T22:59:47Z", cards: [{ paper_id: "doi:a" }] }),
  field_beliefs: (cwd) => writeState(cwd, "field-beliefs", { projected_at: "2026-09-19T23:06:12Z", beliefs: [{ belief_id: "b1" }] }),
  candidate_slate: (cwd) => writeState(cwd, "candidate-slate", { projected_at: "2026-09-19T23:12:32Z", candidates: [{ candidate_id: "c1" }] }),
  expert_panel: (cwd) => writeState(cwd, "expert-panel", { projected_at: "2026-09-19T23:20:41Z", ranking: [{ candidate_id: "c1" }] }),
  novelty_audit: (cwd) => writeState(cwd, "novelty-audit", { updated_at: "2026-09-19T20:34:42Z", audits: [{ candidate_id: "c1" }] }),
  candidate_feasibility: (cwd) => writeState(cwd, "candidate-feasibility", {
    updated_at: "2026-09-19T22:52:04Z",
    assessments: [{ candidate_id: "c1", verdict: "pass", reproduction_anchor: { paper_id: "doi:a", reported_value: "85%" } }],
  }),
  owner_checkpoint: (cwd) => writeState(cwd, "owner-candidates", {
    published_at: "2026-09-19T22:52:06Z", candidates: [{ candidate_id: "c1" }],
  }),
  owner_selection: (cwd) => writeState(cwd, "owner-selection", { candidate_id: "c1", note: "the owner's pick" }),
  lead_selected: (cwd) => writeState(cwd, "lab-director-hypothesis", {
    status: "selected",
    statement: "coverage, not the policy class, explains the gap",
    selected_at_epoch_ms: LEAD_MS,
    updated_at: "2026-09-20T06:02:55Z",
    validation_data_status: "materialized",
    generated_by: "followup-lab-director-38",
    lab_director_decision: { next_actions: [{ type: "gate_restart_followup", description: "adjudicate novelty" }] },
  }),
  reproduction_anchor: (cwd) => writeState(cwd, "simulation-orders", {
    updated_at: "2026-09-20T11:40:58Z", generated_by: "followup-lab-director-46", simulation_orders: [{ conditions: [] }],
  }),
  experiment_data: (cwd) => {
    const file = path.join(cwd, ".research-lab", "datasets", CYCLE, "simulations", "episodes.csv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "episode_id,success\n1,1\n", "utf8");
  },
  analysis: (cwd) => {
    writeState(cwd, "validation-results", { validation_results: [{ validation_id: "v1" }] });
    writeState(cwd, "evidence-packets", { evidence_packets: [{ evidence_packet_id: "e1" }] });
  },
  gate_review: (cwd) => appendJsonl(cwd, "gate-review-history", [{ ts: "2026-09-20T13:00:00Z", gate_passed: false }]),
  conclusion: (cwd) => writeState(cwd, "conclusion-review", { ts: "2026-09-20T14:00:00Z", conclusion_gate_passed: true }),
};

function buildCycle(upTo) {
  const cwd = tmpdir("rl-stall-");
  fs.mkdirSync(stateDir(cwd), { recursive: true });
  for (const id of MILESTONE_IDS) {
    STAGES[id](cwd);
    if (id === upTo) break;
  }
  return cwd;
}

function addFinishedLane(cwd, { laneId, actionType, status = "completed", finishedMs }) {
  const laneDir = path.join(cwd, ".research-lab", "lanes", CYCLE, laneId);
  writeJson(path.join(laneDir, "role-plan.json"), { lane_id: laneId, role: laneId.split("-").slice(-2, -1)[0], action_type: actionType });
  writeJson(path.join(laneDir, "final-status.json"), {
    lane_id: laneId,
    status,
    failure_category: status === "failed" ? "lane_failed" : null,
    completed_at: new Date(finishedMs).toISOString(),
  });
  return laneDir;
}

// ---------------------------------------------------------------------------
// milestone derivation

test("the milestone list is the pipeline the harness actually publishes", () => {
  assert.deepEqual(MILESTONE_IDS, [
    "field_landscape",
    "frontier_harvest_reviewed",
    "sota_cards",
    "field_beliefs",
    "candidate_slate",
    "expert_panel",
    "novelty_audit",
    "candidate_feasibility",
    "owner_checkpoint",
    "owner_selection",
    "lead_selected",
    "reproduction_anchor",
    "experiment_data",
    "analysis",
    "gate_review",
    "conclusion",
  ]);
  // Every milestone has a fixture, so a new row cannot be added without one.
  assert.deepEqual(Object.keys(STAGES).sort(), [...MILESTONE_IDS].sort());
});

test("each published stage moves the milestone by exactly one", () => {
  for (const id of MILESTONE_IDS) {
    const cwd = buildCycle(id);
    const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-20T15:00:00Z") });
    assert.equal(progress.current_milestone, id, `after publishing ${id}`);
    const index = MILESTONE_IDS.indexOf(id);
    assert.equal(progress.next_milestone, MILESTONE_IDS[index + 1] || null);
  }
});

test("a published blocking conclusion review advances out of gate_review", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: 187 lanes finished
  // while progress stayed at gate_review and claimed conclusion-review had not
  // been written. Publication enters conclusion; passing remains a separate
  // scientific gate and is not weakened here.
  const cwd = buildCycle("gate_review");
  writeState(cwd, "conclusion-review", {
    ts: "2026-09-20T14:00:00Z",
    conclusion_gate_passed: false,
    conclusion_blockers: [{ blocker: "matched execution evidence is still missing" }],
  });

  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-20T15:00:00Z") });
  assert.equal(progress.current_milestone, "conclusion");
  assert.equal(progress.next_milestone, null);
});

test("a falsification release reopens lead selection until a replacement is selected", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-07: progress stayed at
  // terminal conclusion while three novelty followups completed, even though
  // the typed lead-protection decision had retired the selected method.
  const cwd = buildCycle("conclusion");
  for (let index = 0; index < 3; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-analyst-${471 + index * 5}`,
      actionType: "novelty_followup",
      finishedMs: Date.parse(`2026-10-07T17:${20 + index}:00Z`),
    });
  }
  const stalled = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-07T18:05:00Z") });
  const trigger = stallFindings({
    progress: stalled,
    config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
    now: Date.parse("2026-10-07T18:05:00Z"),
  }).find((item) => item.kind === "lane_churn");
  assert.equal(trigger.signature, "lane_churn:conclusion:novelty_followup");

  writeState(cwd, "lead-protection", {
    ts: "2026-10-07T18:04:47.554Z",
    cycle_id: CYCLE,
    decision: "allow",
    reason: "lead_falsified_by_completed_run",
    lead: "hyp:retired",
  });

  const reopened = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-07T18:05:00Z") });
  assert.equal(reopened.current_milestone, "owner_selection");
  assert.equal(reopened.next_milestone, "lead_selected");
  assert.equal(reopened.lead.selected, false);
  assert.deepEqual(reopened.waiting_on, [
    "lead_falsified: the LabDirector must select a replacement method for the surviving research question",
  ]);
  assert.equal(
    stallFindings({
      progress: reopened,
      config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
      now: Date.parse("2026-10-07T18:05:00Z"),
    }).some((item) => item.signature === "lane_churn:conclusion:novelty_followup"),
    false,
  );

  writeState(cwd, "lab-director-hypothesis", {
    status: "selected",
    statement: "a replacement method for the surviving coverage question",
    selected_at_epoch_ms: Date.parse("2026-10-07T18:06:00Z"),
    updated_at: "2026-10-07T18:06:00Z",
    validation_data_status: "needs_materialization",
    generated_by: "followup-lab-director-505",
  });
  const replaced = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-07T18:07:00Z") });
  assert.equal(replaced.current_milestone, "reproduction_anchor");
  assert.equal(replaced.next_milestone, "experiment_data");
  assert.equal(replaced.lead.selected, true);
});

test("a fresh falsification replacement wait does not inherit the old owner-selection churn window", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-09: owner_selection was
  // reported as 10,249 minutes old with 191 gate_restart_followup completions,
  // although the current lead was first released only minutes earlier.
  const cwd = buildCycle("lead_selected");
  writeState(cwd, "owner-selection", {
    candidate_id: "c1",
    decided_at: "2026-10-01T22:47:00Z",
  });
  for (let index = 0; index < 4; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-lab-director-${613 + index}`,
      actionType: "gate_restart_followup",
      finishedMs: Date.parse(`2026-10-08T18:${42 + index}:00Z`),
    });
  }
  writeState(cwd, "lead-protection", {
    ts: "2026-10-09T01:36:56.031Z",
    decision: "allow",
    reason: "lead_falsified_by_completed_run",
    lead: "hyp:freshly-retired",
  });
  appendJsonl(cwd, "hypothesis-progress", [{
    event_type: "lead_supersession_decision",
    ts: "2026-10-09T01:29:59.753Z",
    decision: {
      decision: "allow",
      reason: "lead_falsified_by_completed_run",
      lead: "hyp:freshly-retired",
    },
  }]);
  writeJson(progressPath({ cwd, cycleId: CYCLE }), {
    current_milestone: "owner_selection",
    reached_at: "2026-10-01T22:47:03.537Z",
    history: [],
  });

  const reopened = recordProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-10-09T01:37:10Z"),
  }).progress;
  assert.equal(reopened.current_milestone, "owner_selection");
  assert.equal(reopened.reached_at, "2026-10-09T01:29:59.753Z");
  assert.equal(reopened.lanes_since_milestone.total, 0);
  assert.deepEqual(stallFindings({
    progress: reopened,
    config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
    now: Date.parse("2026-10-09T01:37:10Z"),
  }), []);

  writeState(cwd, "lab-director-hypothesis", {
    status: "selected",
    statement: "a replacement method for the surviving research question",
    selected_at_epoch_ms: Date.parse("2026-10-09T01:38:00Z"),
    updated_at: "2026-10-09T01:38:00Z",
    validation_data_status: "needs_materialization",
    generated_by: "followup-lab-director-623",
  });
  const advanced = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-09T01:38:01Z") });
  assert.equal(advanced.current_milestone, "lead_selected");
  assert.equal(advanced.next_milestone, "reproduction_anchor");
});

test("an off-family falsification finishing after replacement does not hold owner_selection open", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-07: 158 independent gate
  // reviews finished while owner_selection waited for a replacement that had
  // already been selected; a queued old-family run had falsely retired it.
  const cwd = buildCycle("lead_selected");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    primary_family: "coverage_diversity_randomized_factorial",
  });
  writeState(cwd, "owner-selection", {
    candidate_id: "c1",
    decided_at: "2026-09-20T06:00:00Z",
  });
  for (let index = 0; index < 3; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-gatekeeper-${319 + index}`,
      actionType: "independent_gate_review_followup",
      // Keep this test's churn after the (incorrect) off-family release; the
      // replacement-window regression above deliberately excludes older work.
      finishedMs: Date.parse(`2026-10-07T19:04:${45 + index * 5}Z`),
    });
  }
  writeState(cwd, "lead-protection", {
    ts: "2026-10-07T19:04:40.894Z",
    decision: "allow",
    reason: "lead_falsified_by_completed_run",
    lead: "hyp:replacement",
  });
  const stuck = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-07T19:05:00Z") });
  assert.equal(stuck.current_milestone, "owner_selection");
  assert.equal(
    stallFindings({
      progress: stuck,
      config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
      now: Date.parse("2026-10-07T19:05:00Z"),
    }).find((item) => item.kind === "lane_churn")?.signature,
    "lane_churn:owner_selection:independent_gate_review_followup",
  );

  const leadIdentity = {
    family: "coverage_diversity_randomized_factorial",
    tokens: new Set(["diffusion", "support", "distance"]),
    hasIdentity: true,
  };
  const staleRunner = {
    hypothesis_results: [{
      family: "loss_refinement_support_factorial",
      statement: "diffusion support distance slopes for the old method",
    }],
  };
  const matchScore = runnerLeadMatchScore(staleRunner, leadIdentity);
  const boundValidation = validationOfCurrentLead({
    root: path.join(cwd, ".research-lab"),
    cycleId: CYCLE,
    progressSignals: {
      latestValidationSummary: {
        handoff_check_resolutions: [{ resolution_status: "valid_falsification" }],
      },
      latestValidationMtime: Date.parse("2026-10-07T18:41:46Z"),
      latestValidationLeadMatchScore: matchScore,
    },
  });
  assert.equal(boundValidation, null, "the old method's result is not the replacement's falsification");

  const corrected = hypothesisProgress.evaluateLeadSupersession({
    records: [],
    cycleId: CYCLE,
    currentLeadKey: "hyp:replacement",
    strongValidationCommit: { active: true, leadKey: "hyp:replacement", kind: "novelty_refinement" },
    leadValidationSummary: boundValidation,
  });
  assert.notEqual(corrected.reason, "lead_falsified_by_completed_run");
  writeState(cwd, "lead-protection", {
    ts: "2026-10-07T19:06:00Z",
    decision: corrected.decision,
    reason: corrected.reason,
    lead: corrected.lead || "hyp:replacement",
  });

  const advanced = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-07T19:07:00Z") });
  assert.equal(advanced.current_milestone, "lead_selected");
  assert.equal(advanced.next_milestone, "reproduction_anchor");
  assert.equal(advanced.lead.selected, true);
});

test("an unmaterialized lead cannot inherit stale data through conclusion", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: progress reported
  // terminal conclusion with no next milestone while the selected lead said
  // needs_materialization and the files under datasets belonged to its pilot.
  const cwd = buildCycle("conclusion");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
  });
  writeState(cwd, "conclusion-review", {
    ts: "2026-09-20T14:00:00Z",
    conclusion_gate_passed: false,
    conclusion_blockers: [],
  });

  const blocked = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-20T15:00:00Z") }).progress;
  assert.equal(blocked.current_milestone, "reproduction_anchor");
  assert.equal(blocked.next_milestone, "experiment_data");
  assert.deepEqual(blocked.waiting_on, ["lead_validation_data_status=needs_materialization"]);

  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "materialized",
  });
  writeState(cwd, "conclusion-review", {
    ts: "2026-09-20T15:01:00Z",
    conclusion_gate_passed: true,
  });
  const advanced = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-20T15:01:00Z") }).progress;
  assert.equal(advanced.current_milestone, "conclusion");
  assert.equal(advanced.advanced, true);
});

test("a validated selected simulation output satisfies stale needs_materialization", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: the selected
  // coverage_decay_planar_push_v1 order wrote episodes.csv and manifest.json
  // with passing in-support validation, but progress remained at
  // reproduction_anchor because the earlier lead projection still recorded
  // needs_materialization. No executor owns rewriting that planning field.
  const cwd = buildCycle("reproduction_anchor");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
  });
  const outputPath = `.research-lab/datasets/${CYCLE}/simulations/coverage_decay_planar_push_v1/episodes.csv`;
  writeState(cwd, "simulation-orders", {
    updated_at: "2026-09-21T14:21:34Z",
    simulation_orders: [{
      request_id: "coverage_decay_planar_push_v1",
      output_path: outputPath,
      emitted_columns: [{ name: "success", unit: "binary", meaning: "task completion" }],
    }],
  });
  const outputDir = path.join(cwd, path.dirname(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: "coverage_decay_planar_push_v1",
    in_support_validation: {
      passed: false,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0 }],
    },
  });

  const rejected = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-21T15:00:00Z") }).progress;
  assert.equal(rejected.current_milestone, "reproduction_anchor", "the rejected pilot remains excluded");

  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: "coverage_decay_planar_push_v1",
    in_support_validation: {
      passed: true,
      arms: [
        { name: "diffusion_policy", in_support_success_rate: 0.7 },
        { name: "chunked_behavior_cloning", in_support_success_rate: 1 },
        { name: "nearest_neighbour_action_chunk_retrieval", in_support_success_rate: 1 },
      ],
    },
  });
  const advanced = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-21T15:01:00Z") }).progress;
  assert.equal(advanced.current_milestone, "experiment_data");
  assert.equal(advanced.next_milestone, "analysis");
  assert.equal(advanced.advanced, true);
});

test("a selected sealed simulation advances after its order record was erased", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-02: H-ARR selected the
  // sealed support_metric_discordance_v2 output, but simulation_orders was null
  // and three methods_followup lanes completed without moving lead_selected.
  const cwd = buildCycle("lead_selected");
  const requestId = "support_metric_discordance_v2";
  const sourceDir = path.join(cwd, ".research-lab", "datasets", CYCLE, "simulations", requestId);
  const sealedDir = path.join(cwd, ".research-lab", "sealed-datasets", CYCLE, `abc123-${requestId}`);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(sealedDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  fs.writeFileSync(path.join(sealedDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(sourceDir, "manifest.json"), {
    request_id: requestId,
    rows: 2,
    in_support_validation: {
      passed: true,
      arms: [{ name: "retrieval", in_support_success_rate: 0.5 }],
    },
  });
  writeJson(path.join(sealedDir, ".sealed.json"), {
    data_file: "episodes.csv",
    sha256: "abc123",
    source_bundle: sourceDir,
  });
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
    replacement_deferred: [{ deferred_at: "2026-10-02T10:18:01Z", rationale: "replace H-ARR" }],
    selected_hypothesis: {
      statement: "adaptive retrieval rescue on the materialized simulation",
      identification_strategy: {
        validation_data_status: "materialized",
        materialized_dataset: path.join(sealedDir, "episodes.csv"),
      },
    },
  });
  writeState(cwd, "simulation-orders", {
    updated_at: "2026-10-02T09:02:49Z",
    generated_by: "followup-lab-director-327",
    simulation_orders: null,
  });

  const progress = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-02T10:18:32Z") }).progress;
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(progress.advanced, true);
});

test("a selected validated source simulation advances despite a stale projected status", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-03: the selected hypothesis
  // named a validated 20,000-row procedural CSV as materialized, but its
  // projected top-level status stayed needs_materialization and simulation_orders
  // was null through four completed lab-director requery lanes.
  const cwd = buildCycle("lead_selected");
  const requestId = "coverage_prior_art_head_to_head_v1";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const sourceDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(sourceDir, "manifest.json"), {
    request_id: requestId,
    rows: 20000,
    in_support_validation: {
      passed: true,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0.6 }],
    },
  });
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
    selected_hypothesis: {
      statement: "shared-state policy comparison",
      validation_data_status: "materialized",
      identification_strategy: {
        validation_data_status: "materialized",
        materialized_dataset: relativeCsv,
      },
    },
  });
  writeState(cwd, "simulation-orders", { simulation_orders: null });

  const progress = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-03T00:41:39Z") }).progress;
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(progress.advanced, true);
});

test("a canonical materialized-dataset record advances past the reproduction anchor", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-03: the lead projection
  // recorded the analysed 20,000-row CSV as an object, simulation_orders was
  // null, and five gate-restart followups finished while lead_selected held.
  const cwd = buildCycle("lead_selected");
  const requestId = "coverage_prior_art_head_to_head_v1";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const sourceDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(sourceDir, "manifest.json"), {
    request_id: requestId,
    rows: 20000,
    in_support_validation: {
      passed: true,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0.6 }],
    },
  });
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "materialized",
    identification_strategy: {
      validation_data_status: "materialized",
      materialized_dataset: {
        path: relativeCsv,
        manifest: path.join(path.dirname(relativeCsv), "manifest.json"),
        rows: 20000,
        sha256: "82321d590311ca970abd486704b81f8d36cf0c9905c2b8364d5547ac41f71423",
      },
    },
    replacement_deferred: [{
      deferred_at: "2026-10-03T01:42:22Z",
      rationale: "Runner-112 already falsified the equivalence method",
    }],
  });
  writeState(cwd, "simulation-orders", { simulation_orders: null });

  const progress = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-03T01:42:36Z") }).progress;
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(progress.advanced, true);
});

test("pathless materialization metadata does not hide the selected dataset accession", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-10: simulation_orders was
  // null and materialized_dataset recorded only mode, rows, and sha256. Its
  // sibling dataset_or_accession named a validated 34,560-row CSV, yet five
  // adaptive_search_followup lanes finished while lead_selected stayed stuck.
  const cwd = buildCycle("lead_selected");
  const requestId = "state_support_randomized_intervention_v1";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const sourceDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(sourceDir, "manifest.json"), {
    request_id: requestId,
    rows: 34560,
    status: "complete",
    in_support_validation: {
      passed: true,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0.9 }],
    },
  });
  const bundleTime = new Date("2026-10-10T00:06:00Z");
  fs.utimesSync(path.join(sourceDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(sourceDir, "manifest.json"), bundleTime, bundleTime);

  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "materialized",
    selected_hypothesis: {
      statement: "randomized support-removal intervention",
      dataset_or_accession: relativeCsv,
      validation_data_status: "materialized",
      identification_strategy: {
        dataset_or_accession: relativeCsv,
        validation_data_status: "materialized",
        materialized_dataset: {
          mode: "procedural",
          rows: 34560,
          sha256: "4faf7da5c0245e79855881ca002cbeb31a81e92833c05f9ff2b4537ba80f8441",
        },
      },
    },
    replacement_deferred: [{
      deferred_at: "2026-10-09T20:56:39Z",
      rationale: "approved literature services throttled retrieval",
    }],
  });
  writeState(cwd, "simulation-orders", { simulation_orders: null });
  for (let index = 0; index < 5; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-scout-${342 + index}`,
      actionType: "adaptive_search_followup",
      finishedMs: Date.parse(`2026-10-10T01:${10 + index}:00Z`),
    });
  }

  const progress = deriveProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-10-10T01:33:03Z"),
  });
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(
    stallFindings({
      progress,
      config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
      now: Date.parse("2026-10-10T01:33:03Z"),
    }).some((item) => item.signature === "lane_churn:lead_selected:adaptive_search_followup"),
    false,
  );
});

test("a completed selected dataset path advances without a rewritten materialization flag", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-03: the selected lead kept
  // materialized_dataset=null and needs_materialization after its named
  // residual-guided bundle completed with row_count=4,000 and passed in-support
  // validation. Four execution-audit lanes finished while lead_selected held.
  const cwd = buildCycle("lead_selected");
  const requestId = "residual_guided_support_acquisition_v1";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const sourceDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(sourceDir, "manifest.json"), {
    request_id: requestId,
    row_count: 4000,
    status: "complete",
    in_support_validation: {
      passed: true,
      arms: [{ name: "chunked_bc", in_support_success_rate: 0.4 }],
    },
  });
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
    identification_strategy: {
      dataset_or_accession: relativeCsv,
      validation_data_status: "needs_materialization",
    },
    selected_hypothesis: {
      statement: "residual-guided acquisition transfers across policy classes",
      dataset_or_accession: relativeCsv,
      validation_data_status: "needs_materialization",
      identification_strategy: {
        dataset_or_accession: relativeCsv,
        materialized_dataset: null,
        validation_data_status: "needs_materialization",
      },
    },
  });
  writeState(cwd, "simulation-orders", { simulation_orders: null });

  const progress = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-03T13:35:19Z") }).progress;
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(progress.advanced, true);
});

test("a reissued simulation order does not inherit the rejected pilot through conclusion", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: a 09:39 stand-in
  // pilot passed its manifest checks, then LabDirector rejected it and reissued
  // the order at 15:28. Progress still reported terminal conclusion, with no
  // next milestone, instead of making the replacement data actionable.
  const cwd = buildCycle("conclusion");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
  });
  const outputPath = `.research-lab/datasets/${CYCLE}/simulations/coverage_decay_planar_push_v1/episodes.csv`;
  const outputDir = path.join(cwd, path.dirname(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: "coverage_decay_planar_push_v1",
    in_support_validation: {
      passed: true,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0.7 }],
    },
  });
  const pilotTime = new Date("2026-09-21T09:39:26Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), pilotTime, pilotTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), pilotTime, pilotTime);
  writeState(cwd, "simulation-orders", {
    updated_at: "2026-09-21T15:28:22Z",
    generated_by: "followup-lab-director-133",
    simulation_orders: [{
      request_id: "coverage_decay_planar_push_v1",
      output_path: outputPath,
      emitted_columns: [{ name: "success", unit: "binary", meaning: "task completion" }],
    }],
  });

  const blocked = recordProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-21T15:31:42Z") }).progress;
  assert.equal(blocked.current_milestone, "reproduction_anchor");
  assert.equal(blocked.next_milestone, "experiment_data");

  const replacementTime = new Date("2026-09-21T15:32:00Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), replacementTime, replacementTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), replacementTime, replacementTime);
  const advanced = recordProgress({ cwd, cycleId: CYCLE, now: replacementTime.getTime() }).progress;
  assert.equal(advanced.current_milestone, "experiment_data");
  assert.equal(advanced.next_milestone, "analysis");
  assert.equal(advanced.advanced, true);
});

test("a matching resumable bundle survives narrative requery drift", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: while the v2 order
  // retained the same request, factors, seeds, 2,842-episode cells and schema,
  // director prose drift reset updated_at after 10/90 complete cells and held
  // progress at reproduction_anchor with needs_materialization.
  const cwd = buildCycle("reproduction_anchor");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
  });
  const outputPath = `.research-lab/datasets/${CYCLE}/simulations/coverage_decay_planar_push_power_v2/episodes.csv`;
  const order = {
    request_id: "coverage_decay_planar_push_power_v2",
    simulator_backend: "mujoco",
    output_path: outputPath,
    conditions: [
      { factor: "policy_class", levels: ["diffusion_policy", "chunked_behavior_cloning"] },
      { factor: "normalized_support_distance", levels: ["0.00", "1.00"] },
    ],
    seeds: [0, 1, 2],
    episodes_per_condition: 2842,
    emitted_columns: [
      { name: "episode_id", unit: "id", meaning: "unique episode" },
      { name: "success", unit: "binary", meaning: "task completion" },
    ],
  };
  writeState(cwd, "simulation-orders", {
    updated_at: "2026-09-21T21:18:07Z",
    generated_by: "followup-lab-director-149",
    simulation_orders: [order],
  });
  const outputDir = path.join(cwd, path.dirname(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: order.request_id,
    simulator_backend: "mujoco",
    seeds: [0, 1, 2],
    episodes_per_condition: 2842,
    emitted_columns: ["episode_id", "success"],
    condition_levels: {
      policy_class: ["diffusion_policy", "chunked_behavior_cloning"],
      normalized_support_distance: [0, 1],
    },
    completed_cells: [{ cell: "diffusion_policy__d0.00__s0", episodes: 2842 }],
    remaining_cells: ["diffusion_policy__d1.00__s0"],
    rows: 2842,
    in_support_validation: {
      passed: true,
      arms: [
        { name: "diffusion_policy", in_support_success_rate: 0.7 },
        { name: "chunked_behavior_cloning", in_support_success_rate: 1 },
      ],
    },
  });
  const bundleTime = new Date("2026-09-21T20:37:40Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), bundleTime, bundleTime);

  const progress = recordProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-09-21T21:18:15Z"),
  }).progress;
  assert.equal(progress.current_milestone, "experiment_data");
  assert.equal(progress.next_milestone, "analysis");
  assert.equal(progress.advanced, true);
});

test("replacement simulation data invalidates republished pre-bundle analysis and reviews", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: the conforming 4,500-row
  // bundle completed at 17:05, but validation-results/evidence-packets still
  // cited only failed runners from the prior day. Their projections and the
  // conclusion review were rewritten at 17:07, so mtimes made progress claim
  // terminal conclusion and offered no next milestone.
  const cwd = buildCycle("conclusion");
  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
  });
  const outputPath = `.research-lab/datasets/${CYCLE}/simulations/coverage_decay_planar_push_v1/episodes.csv`;
  writeState(cwd, "simulation-orders", {
    updated_at: "2026-09-21T16:32:43Z",
    simulation_orders: [{
      request_id: "coverage_decay_planar_push_v1",
      output_path: outputPath,
      emitted_columns: [{ name: "success", unit: "binary", meaning: "task completion" }],
    }],
  });
  const outputDir = path.join(cwd, path.dirname(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: "coverage_decay_planar_push_v1",
    in_support_validation: {
      passed: true,
      arms: [{ name: "diffusion_policy", in_support_success_rate: 0.7 }],
    },
  });
  const bundleTime = new Date("2026-09-21T17:05:26Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), bundleTime, bundleTime);

  addFinishedLane(cwd, {
    laneId: "followup-runner-08",
    actionType: "methods_followup",
    finishedMs: Date.parse("2026-09-20T14:11:40Z"),
  });
  for (const [laneId, finishedAt] of [
    ["followup-engineer-28", "2026-09-21T15:55:02Z"],
    ["followup-engineer-29", "2026-09-21T16:29:13Z"],
    ["followup-engineer-30", "2026-09-21T17:07:03Z"],
  ]) {
    addFinishedLane(cwd, {
      laneId,
      actionType: "simulation_data_generation_followup",
      finishedMs: Date.parse(finishedAt),
    });
  }
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "old", provenance: { lane_id: "followup-runner-08" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "old", provenance: ["followup-runner-08"] }],
  });
  writeState(cwd, "conclusion-review", {
    ts: "2026-09-21T17:07:08Z",
    conclusion_gate_passed: false,
  });
  writeJson(progressPath({ cwd, cycleId: CYCLE }), {
    current_milestone: "conclusion",
    reached_at: "2026-09-21T15:31:42Z",
  });

  const blocked = recordProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-09-21T17:07:11Z"),
  }).progress;
  assert.equal(blocked.current_milestone, "experiment_data");
  assert.equal(blocked.next_milestone, "analysis");
  assert.equal(blocked.advanced, true);
  assert.deepEqual(blocked.waiting_on, [
    "analysis_stale_for_experiment_data: validation results and evidence packets cite no lane completed after the selected simulation bundle",
  ]);

  const analysisMs = Date.parse("2026-09-21T17:12:00Z");
  addFinishedLane(cwd, {
    laneId: "followup-runner-09",
    actionType: "hypothesis_followup",
    finishedMs: analysisMs,
  });
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "fresh", provenance: { lane_id: "followup-runner-09" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "fresh", provenance: ["followup-runner-09"] }],
  });
  const analysed = deriveProgress({ cwd, cycleId: CYCLE, now: analysisMs });
  assert.equal(analysed.current_milestone, "analysis");
  assert.equal(analysed.next_milestone, "gate_review");

  appendJsonl(cwd, "gate-review-history", [{ ts: "2026-09-21T17:13:00Z", gate_passed: false }]);
  const gated = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-21T17:13:00Z") });
  assert.equal(gated.current_milestone, "gate_review");
  assert.equal(gated.next_milestone, "conclusion");

  writeState(cwd, "conclusion-review", {
    ts: "2026-09-21T17:14:00Z",
    conclusion_gate_passed: false,
  });
  const concluded = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-21T17:14:00Z") });
  assert.equal(concluded.current_milestone, "conclusion");
  assert.equal(concluded.next_milestone, null);
});

test("fresh evidence for a selected materialized bundle reopens a stale conclusion", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-04: progress stayed at
  // terminal conclusion through three completed methods followups even though
  // the selected materialized 90,000-row bundle had fresh Runner-128 evidence
  // newer than the last gate round. The materialized planning flag must not
  // disable the selected bundle's evidence epoch.
  const cwd = buildCycle("conclusion");
  const requestId = "randomized_local_gap_placement_v1";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const outputDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: requestId,
    rows: 2,
    in_support_validation: {
      passed: true,
      arms: [{ name: "compact_diffusion_policy", in_support_success_rate: 0.75 }],
    },
  });
  const bundleTime = new Date("2026-09-20T14:30:00Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), bundleTime, bundleTime);

  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "materialized",
    selected_hypothesis: {
      identification_strategy: {
        materialized_dataset: { path: relativeCsv, rows: 2 },
      },
    },
  });
  const runnerMs = Date.parse("2026-09-20T14:40:00Z");
  addFinishedLane(cwd, {
    laneId: "followup-runner-128",
    actionType: "methods_followup",
    finishedMs: runnerMs,
  });
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "fresh", provenance: { lane_id: "followup-runner-128" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "fresh", provenance: ["followup-runner-128"] }],
  });

  const progress = deriveProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-09-20T15:00:00Z"),
  });
  assert.equal(progress.current_milestone, "analysis");
  assert.equal(progress.next_milestone, "gate_review");
  assert.deepEqual(progress.waiting_on, [
    "gate_review_not_published: gate-review-history has not been written",
  ]);
});

test("replacement bundle starts a new experiment-data churn epoch", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-06: progress retained the
  // 17:36 v1 experiment_data timestamp after v2 landed at 20:25, so the stall
  // detector attributed Runner-156, Runner-157 and Analyst-436's v1 work to
  // the v2 freshness wait. Analyst-437 had just produced the runnable v2
  // handoff; those earlier lanes could not diagnose whether v2 was stuck.
  const cwd = buildCycle("experiment_data");
  const requestId = "coverage_allocation_factorial_v2";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const outputDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: requestId,
    rows: 2,
    in_support_validation: {
      passed: true,
      arms: [{ name: "compact_diffusion_policy", in_support_success_rate: 1 }],
    },
  });
  const bundleMs = Date.parse("2026-10-06T20:25:31.895Z");
  const bundleTime = new Date(bundleMs);
  fs.utimesSync(path.join(outputDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), bundleTime, bundleTime);

  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "materialized",
    selected_hypothesis: {
      identification_strategy: { materialized_dataset: { path: relativeCsv, rows: 2 } },
    },
  });
  for (const [laneId, finishedAt] of [
    ["followup-analyst-436", "2026-10-06T18:40:42Z"],
    ["followup-runner-156", "2026-10-06T18:47:05Z"],
    ["followup-runner-157", "2026-10-06T18:47:08Z"],
  ]) {
    addFinishedLane(cwd, {
      laneId,
      actionType: "methods_followup",
      finishedMs: Date.parse(finishedAt),
    });
  }
  const freshHandoffLane = addFinishedLane(cwd, {
    laneId: "followup-analyst-437",
    actionType: "novelty_followup",
    finishedMs: Date.parse("2026-10-06T20:55:18Z"),
  });
  writeJson(path.join(freshHandoffLane, "handoff-validation-plan.json"), {
    analysis_design_memo: {
      final_handoff_readiness: { ready_for_runner: true, blocking_reason: null },
    },
    handoff_checks: [{
      check_id: "coverage_allocation_factorial_v2_primary",
      dataset_declared: relativeCsv,
      dataset: relativeCsv,
      exposures: ["support_allocation", "normalized_support_distance"],
    }],
    validation_code_blueprints: [{
      check_id: "coverage_allocation_factorial_v2_primary",
      code: "print('validate v2')",
    }],
  });
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "v1", provenance: { lane_id: "followup-runner-157" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "v1", provenance: ["followup-runner-157"] }],
  });
  writeJson(progressPath({ cwd, cycleId: CYCLE }), {
    current_milestone: "experiment_data",
    reached_at: "2026-10-06T17:36:18.061Z",
  });

  const now = Date.parse("2026-10-06T20:55:54Z");
  const blocked = recordProgress({ cwd, cycleId: CYCLE, now }).progress;
  assert.equal(blocked.current_milestone, "experiment_data");
  assert.equal(blocked.reached_at, "2026-10-06T20:55:18.000Z");
  assert.deepEqual(Object.keys(blocked.lanes_since_milestone.by_action_type), []);
  assert.deepEqual(stallFindings({ progress: blocked, config: supervisorConfig({}), now }), []);

  const freshRunnerMs = Date.parse("2026-10-06T20:56:30Z");
  addFinishedLane(cwd, {
    laneId: "followup-runner-158",
    actionType: "methods_followup",
    finishedMs: freshRunnerMs,
  });
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "v2", provenance: { lane_id: "followup-runner-158" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "v2", provenance: ["followup-runner-158"] }],
  });
  const advanced = recordProgress({ cwd, cycleId: CYCLE, now: freshRunnerMs }).progress;
  assert.equal(advanced.current_milestone, "analysis");
  assert.equal(advanced.next_milestone, "gate_review");
});

test("a conclusion built before its sibling gate-history write advances", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-04: gatekeeper-187
  // completed at 17:06:22, conclusion-review consumed it at 17:06:25, and the
  // same refresh appended gate-review-history at 17:06:28. Four gate and four
  // execution-audit lanes finished while the impossible write-order check kept
  // the pipeline at gate_review.
  const cwd = buildCycle("gate_review");
  const requestId = "support_metric_discordance_v2";
  const relativeCsv = `.research-lab/datasets/${CYCLE}/simulations/${requestId}/episodes.csv`;
  const outputDir = path.join(cwd, path.dirname(relativeCsv));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "episodes.csv"), "episode_id,success\n1,1\n2,0\n", "utf8");
  writeJson(path.join(outputDir, "manifest.json"), {
    request_id: requestId,
    rows: 2,
    in_support_validation: {
      passed: true,
      arms: [{ name: "compact_diffusion_policy", in_support_success_rate: 0.75 }],
    },
  });
  const bundleTime = new Date("2026-10-04T15:45:00Z");
  fs.utimesSync(path.join(outputDir, "episodes.csv"), bundleTime, bundleTime);
  fs.utimesSync(path.join(outputDir, "manifest.json"), bundleTime, bundleTime);

  const leadPath = path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`);
  writeJson(leadPath, {
    ...JSON.parse(fs.readFileSync(leadPath, "utf8")),
    validation_data_status: "needs_materialization",
    selected_hypothesis: {
      identification_strategy: {
        materialized_dataset: { path: relativeCsv, rows: 2 },
      },
    },
  });
  const analysisMs = Date.parse("2026-10-04T16:50:21Z");
  addFinishedLane(cwd, {
    laneId: "followup-runner-135",
    actionType: "methods_followup",
    finishedMs: analysisMs,
  });
  writeState(cwd, "validation-results", {
    validation_results: [{ validation_id: "fresh", provenance: { lane_id: "followup-runner-135" } }],
  });
  writeState(cwd, "evidence-packets", {
    evidence_packets: [{ evidence_packet_id: "fresh", provenance: ["followup-runner-135"] }],
  });

  const gateSourceMs = Date.parse("2026-10-04T17:06:22Z");
  writeState(cwd, "gate-review", {
    gate_passed: false,
    gatekeeper_review_status_by_rubric: [{
      rubric: "technical_quality",
      lane_id: "followup-gatekeeper-187",
      source_mtime: gateSourceMs,
    }],
  });
  fs.writeFileSync(
    path.join(stateDir(cwd), `${CYCLE}-gate-review-history.jsonl`),
    `${JSON.stringify({ ts: "2026-10-04T17:06:28.264Z", score: 43, pass: false })}\n`,
    "utf8",
  );
  writeState(cwd, "conclusion-review", {
    ts: "2026-10-04T17:06:25.993Z",
    conclusion_gate_passed: false,
    conclusion_blockers: [
      "Clarity: clearer primary and robustness figures are still needed",
      "Bounded by the gatekeeper's critical clarity score (28)",
    ],
  });

  const progress = deriveProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-10-04T17:06:31Z"),
  });
  assert.equal(progress.current_milestone, "conclusion");
  assert.equal(progress.next_milestone, null);

  writeState(cwd, "gate-review", {
    gate_passed: false,
    gatekeeper_review_status_by_rubric: [{
      rubric: "technical_quality",
      lane_id: "followup-gatekeeper-188",
      source_mtime: Date.parse("2026-10-04T17:06:27Z"),
    }],
  });
  const stale = deriveProgress({
    cwd,
    cycleId: CYCLE,
    now: Date.parse("2026-10-04T17:06:31Z"),
  });
  assert.equal(stale.current_milestone, "gate_review", "new gate evidence must still reopen conclusion");
});

test("an empty cycle has no milestone and waits on the field landscape", () => {
  const cwd = tmpdir("rl-stall-empty-");
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.now() });
  assert.equal(progress.current_milestone, null);
  assert.equal(progress.next_milestone, "field_landscape");
  assert.equal(progress.lead.selected, false);
});

test("a gate round from before the lead does not skip the cycle forward", () => {
  // The real shape: cycle-a-20260919 held 11 gate rounds in
  // gate-review-history.jsonl from BEFORE the lead existed. A high-water mark
  // over "which artifacts exist" would have called that cycle gate_review while
  // it had not run one experiment.
  const cwd = buildCycle("lead_selected");
  appendJsonl(cwd, "gate-review-history", [
    { ts: "2026-09-19T13:46:57Z", gate_passed: false },
    { ts: "2026-09-20T06:07:09Z", gate_passed: false },
  ]);
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-09-20T12:00:00Z") });
  assert.equal(progress.current_milestone, "lead_selected");
  assert.equal(progress.next_milestone, "reproduction_anchor");
});

test("unreviewed harvest candidates are named as what the cycle waits on", () => {
  const cwd = buildCycle("field_landscape");
  writeState(cwd, "frontier-harvest", {
    top_k: [
      { paper_id: "doi:10.48550/arxiv.2505.06111", title: "UniVLA", review_status: "pending" },
      { paper_id: "doi:10.48550/arxiv.2506.19850", title: "Unified VLA", review_status: "pending" },
      { paper_id: "doi:ok", title: "Reviewed", review_status: "accepted" },
    ],
  });
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.now() });
  assert.equal(progress.current_milestone, "field_landscape");
  assert.equal(progress.next_milestone, "frontier_harvest_reviewed");
  assert.match(progress.waiting_on[0], /frontier_harvest_unreviewed: 2 harvested top-K/);
  assert.match(progress.waiting_on[0], /arxiv\.2505\.06111/);
});

test("the newest lead-selection rejection reasons remain visible as history", () => {
  const cwd = buildCycle("owner_selection");
  writeState(cwd, "lead-selection-rejections", {
    cycle_id: CYCLE,
    rejections: [
      { rejected_at: "2026-09-20T04:00:00Z", reasons: ["an older reason"] },
      { rejected_at: "2026-09-20T05:35:53Z", reasons: ["frontier_harvest_unreviewed: 12 harvested top-K candidate(s)"] },
    ],
  });
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: Date.now() });
  assert.equal(progress.next_milestone, "lead_selected");
  assert.deepEqual(progress.lead_selection_rejections, ["frontier_harvest_unreviewed: 12 harvested top-K candidate(s)"]);
});

test("a settled frontier clears its historical lead rejection and the cycle can advance", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-02: owner_selection was
  // stuck for 429 minutes while progress treated a Sep 20 12-paper rejection as
  // live after the frontier artifact had settled every top-K review on Sep 21.
  const cwd = buildCycle("owner_selection");
  writeState(cwd, "lead-selection-rejections", {
    cycle_id: CYCLE,
    rejections: [{
      rejected_at: "2026-09-20T05:50:25Z",
      reasons: ["frontier_harvest_unreviewed: 12 harvested top-K candidate(s)"],
    }],
  });
  const waiting = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-02T05:56:00Z") });
  assert.equal(waiting.current_milestone, "owner_selection");
  assert.deepEqual(waiting.waiting_on, ["lead_selected_not_published: lab-director-hypothesis has not been written"]);

  STAGES.lead_selected(cwd);
  const advanced = deriveProgress({ cwd, cycleId: CYCLE, now: Date.parse("2026-10-02T05:57:00Z") });
  assert.equal(advanced.current_milestone, "lead_selected");
  assert.equal(advanced.next_milestone, "reproduction_anchor");
});

test("lanes finished since the milestone advanced are grouped by action_type", () => {
  const cwd = buildCycle("lead_selected");
  addFinishedLane(cwd, { laneId: "followup-lab-director-39", actionType: "lab_director_requery_followup", finishedMs: LEAD_MS + 10 * MINUTE });
  addFinishedLane(cwd, { laneId: "followup-lab-director-40", actionType: "lab_director_requery_followup", finishedMs: LEAD_MS + 20 * MINUTE });
  addFinishedLane(cwd, { laneId: "followup-scout-40", actionType: "adaptive_search_followup", status: "failed", finishedMs: LEAD_MS + 30 * MINUTE });
  // Before the lead: history, not churn.
  addFinishedLane(cwd, { laneId: "followup-scout-01", actionType: "adaptive_search_followup", finishedMs: LEAD_MS - 60 * MINUTE });

  const progress = deriveProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 60 * MINUTE });
  assert.equal(progress.lanes_since_milestone.total, 3);
  assert.equal(progress.lanes_since_milestone.by_action_type.lab_director_requery_followup.total, 2);
  assert.equal(progress.lanes_since_milestone.by_action_type.adaptive_search_followup.failed, 1);
});

test("an explicitly bound pilot falsification releases a family-alias lead stall", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-09: at lead_selected,
  // three reasoning_literature_scout lanes (and 24 other followups) finished
  // after runner-208 validly falsified hyp:8dfa8dc457fa6bfe. Its result used
  // family `pilot_eligibility_threshold` while the lead used
  // `factorial_support_geometry_decomposition`, so family matching returned
  // zero and novelty_refinement_window kept the retired method selected.
  const cwd = buildCycle("lead_selected");
  const leadKey = "hyp:8dfa8dc457fa6bfe";
  for (let index = 0; index < 3; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-scout-${319 + index}`,
      actionType: "reasoning_literature_scout",
      finishedMs: LEAD_MS + (index + 1) * MINUTE,
    });
  }
  const stalled = deriveProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 175 * MINUTE });
  const churn = stallFindings({
    progress: stalled,
    config: supervisorConfig({}),
    now: LEAD_MS + 175 * MINUTE,
  }).find((item) => item.signature === "lane_churn:lead_selected:reasoning_literature_scout");
  assert.ok(churn, "the measured lane-churn state must be reproduced");

  const validation = {
    primary_hypothesis_id: leadKey,
    handed_hypothesis_id: leadKey,
    hypothesis_alignment: { bound_to_handed_hypothesis: true, handed_hypothesis_id: leadKey },
    handoff_check_resolutions: [{
      check_id: "CHK-SGF-V1-PILOT-COMPETENCE-REPAIR",
      pass_fail: "fail",
      resolution_status: "valid_falsification",
    }],
  };
  const currentValidation = validationOfCurrentLead({
    root: path.join(cwd, ".research-lab"),
    cycleId: CYCLE,
    currentLeadKey: leadKey,
    progressSignals: {
      latestValidationMtime: LEAD_MS + 60 * MINUTE,
      latestValidationLeadMatchScore: 0,
      latestValidationSummary: validation,
    },
  });
  assert.equal(currentValidation, validation, "the exact driver binding must outrank a family alias");

  const release = hypothesisProgress.evaluateLeadSupersession({
    records: [],
    cycleId: CYCLE,
    currentLeadKey: leadKey,
    currentLeadStatement: "the support geometry lead",
    strongValidationCommit: { active: true, leadKey, kind: "novelty_refinement" },
    leadValidationSummary: currentValidation,
  });
  assert.equal(release.reason, "lead_falsified_by_completed_run");
  writeState(cwd, "lead-protection", {
    ...release,
    ts: new Date(LEAD_MS + 61 * MINUTE).toISOString(),
  });

  const reopened = deriveProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 176 * MINUTE });
  assert.equal(reopened.current_milestone, "owner_selection");
  assert.equal(reopened.next_milestone, "lead_selected");
  assert.notEqual(reopened.current_milestone, "lead_selected", "the falsified method must release replacement selection");
});

test("the progress file keeps the first moment a milestone was observed", () => {
  const cwd = buildCycle("lead_selected");
  const first = recordProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + MINUTE });
  assert.equal(first.progress.current_milestone, "lead_selected");
  assert.equal(fs.existsSync(progressPath({ cwd, cycleId: CYCLE })), true);

  // The harness republishes the lead file with a newer timestamp; nothing moved.
  writeState(cwd, "lab-director-hypothesis", {
    ...JSON.parse(fs.readFileSync(path.join(stateDir(cwd), `${CYCLE}-lab-director-hypothesis.json`), "utf8")),
    updated_at: "2026-09-20T11:40:58Z",
    selected_at_epoch_ms: LEAD_MS + 300 * MINUTE,
  });
  const second = recordProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 330 * MINUTE });
  assert.equal(second.progress.reached_at, first.progress.reached_at);
  assert.equal(second.progress.advanced, false);
  assert.ok(second.progress.minutes_in_milestone >= 329);
});

// ---------------------------------------------------------------------------
// stall triggers

function stallCycle({ minutes, lanes, actionType = "lab_director_requery_followup" }) {
  const cwd = buildCycle("lead_selected");
  for (let index = 0; index < lanes; index += 1) {
    addFinishedLane(cwd, {
      laneId: `followup-lab-director-${String(index + 10)}`,
      actionType,
      finishedMs: LEAD_MS + (index + 1) * MINUTE,
    });
  }
  const now = LEAD_MS + minutes * MINUTE;
  return { cwd, now, progress: deriveProgress({ cwd, cycleId: CYCLE, now }) };
}

test("no_milestone_progress fires at the threshold, and not a minute before", () => {
  const config = supervisorConfig({});
  assert.equal(config.stallMinutes, DEFAULT_STALL_MINUTES);

  // One lane of each kind, so only the stall clock is under test here.
  const spread = { ...config, laneChurn: 99 };
  const early = stallCycle({ minutes: DEFAULT_STALL_MINUTES - 1, lanes: 5 });
  assert.deepEqual(stallFindings({ progress: early.progress, config: spread, now: early.now }).map((f) => f.kind), []);

  const late = stallCycle({ minutes: DEFAULT_STALL_MINUTES, lanes: 5 });
  const findings = stallFindings({ progress: late.progress, config: spread, now: late.now });
  const stall = findings.find((item) => item.kind === "no_milestone_progress");
  assert.ok(stall, "the stall must be seen at exactly the threshold");
  assert.equal(stall.signature, "no_milestone_progress:lead_selected");
  assert.match(stall.detail, new RegExp(`at milestone lead_selected for ${DEFAULT_STALL_MINUTES} minutes`));
  assert.match(stall.detail, /5 lane\(s\) finished/);
});

test("a milestone that is simply slow, with nothing running, is not a stall", () => {
  // Churn is half the definition: work IS happening and the cycle is not
  // moving. A quiet cycle is a different problem and gets a different trigger.
  const quiet = stallCycle({ minutes: 600, lanes: 0 });
  const kinds = stallFindings({ progress: quiet.progress, config: supervisorConfig({}), now: quiet.now }).map((f) => f.kind);
  assert.equal(kinds.includes("no_milestone_progress"), false);
});

test("a lane that can move the next milestone is work, not a stall", () => {
  // The thresholds are short (30 minutes, 3 lanes), so the guard against a
  // false alarm is this: a landscape scout or a deep read may run for an hour.
  const cycle = stallCycle({ minutes: 600, lanes: 9 });
  const config = supervisorConfig({});
  assert.ok(stallFindings({ progress: cycle.progress, config, now: cycle.now }).length > 0);

  const working = {
    ...cycle.progress,
    running_lanes: [{ lane_id: "followup-engineer-09", action_type: "simulation_data_generation_followup", started_at: null }],
  };
  assert.deepEqual(stallFindings({ progress: working, config, now: cycle.now }), []);

  // A director re-deciding is exactly the churn; it never counts as working.
  const deciding = {
    ...cycle.progress,
    running_lanes: [{ lane_id: "followup-lab-director-70", action_type: "lab_director_requery_followup", started_at: null }],
  };
  assert.ok(stallFindings({ progress: deciding, config, now: cycle.now }).length > 0);
});

test("RESEARCHLAB_SUPERVISOR_STALL_MINUTES moves the threshold", () => {
  const config = supervisorConfig({ RESEARCHLAB_SUPERVISOR_STALL_MINUTES: "30" });
  assert.equal(config.stallMinutes, 30);
  const cycle = stallCycle({ minutes: 31, lanes: 3 });
  const kinds = stallFindings({ progress: cycle.progress, config, now: cycle.now }).map((f) => f.kind);
  assert.equal(kinds.includes("no_milestone_progress"), true);
});

test("lane_churn counts one action_type against its own threshold", () => {
  const config = supervisorConfig({});
  assert.equal(config.laneChurn, DEFAULT_LANE_CHURN);

  const below = stallCycle({ minutes: 20, lanes: DEFAULT_LANE_CHURN - 1, actionType: "labdirector_comparator_validation_followup" });
  assert.deepEqual(stallFindings({ progress: below.progress, config, now: below.now }).map((f) => f.kind), []);

  const at = stallCycle({ minutes: 20, lanes: DEFAULT_LANE_CHURN, actionType: "labdirector_comparator_validation_followup" });
  const churn = stallFindings({ progress: at.progress, config, now: at.now }).find((f) => f.kind === "lane_churn");
  assert.ok(churn);
  assert.equal(churn.signature, "lane_churn:lead_selected:labdirector_comparator_validation_followup");
  assert.equal(churn.action_type, "labdirector_comparator_validation_followup");
  // Churn does not need the stall clock: six of the same action in twenty
  // minutes is already the cycle spinning.
  assert.ok(at.now - LEAD_MS < DEFAULT_STALL_MINUTES * MINUTE);
});

test("RESEARCHLAB_SUPERVISOR_LANE_CHURN moves the churn threshold", () => {
  const config = supervisorConfig({ RESEARCHLAB_SUPERVISOR_LANE_CHURN: "3" });
  assert.equal(config.laneChurn, 3);
  const cycle = stallCycle({ minutes: 10, lanes: 3, actionType: "novelty_followup" });
  const churn = stallFindings({ progress: cycle.progress, config, now: cycle.now }).find((f) => f.kind === "lane_churn");
  assert.ok(churn);
});

test("no_evidence fires once a lead exists and nothing has been measured since", () => {
  const config = supervisorConfig({});
  assert.equal(config.noEvidenceMinutes, DEFAULT_NO_EVIDENCE_MINUTES);

  const early = stallCycle({ minutes: DEFAULT_NO_EVIDENCE_MINUTES - 1, lanes: 2 });
  assert.equal(stallFindings({ progress: early.progress, config, now: early.now }).some((f) => f.kind === "no_evidence"), false);

  const late = stallCycle({ minutes: DEFAULT_NO_EVIDENCE_MINUTES, lanes: 2 });
  const finding = stallFindings({ progress: late.progress, config, now: late.now }).find((f) => f.kind === "no_evidence");
  assert.ok(finding);
  assert.equal(finding.signature, "no_evidence:lead_selected");
  assert.match(finding.detail, new RegExp(`no new measurement or evidence artifact for ${DEFAULT_NO_EVIDENCE_MINUTES} minutes`));
});

test("no_evidence needs a lead: a cycle still choosing a problem is not measuring yet", () => {
  const cwd = buildCycle("owner_checkpoint");
  const now = Date.parse("2026-09-20T06:02:55Z") + 1000 * MINUTE;
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now });
  assert.equal(progress.lead.selected, false);
  assert.equal(stallFindings({ progress, config: supervisorConfig({}), now }).some((f) => f.kind === "no_evidence"), false);
});

test("evidence republished without new content does not reset the no-evidence clock", () => {
  // validation-results, evidence-packets and claim-traces carry no timestamp of
  // their own and the harness rewrites them every scheduling pass, so an mtime
  // would say "measured just now" forever. The fingerprint is the content.
  const cwd = buildCycle("lead_selected");
  writeState(cwd, "validation-results", { validation_results: [{ validation_id: "v1" }] });
  const first = recordProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + MINUTE });
  const changedAt = first.progress.evidence_changed_at;

  writeState(cwd, "validation-results", { validation_results: [{ validation_id: "v1" }] });
  const republished = recordProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 300 * MINUTE });
  assert.equal(republished.progress.evidence_changed_at, changedAt, "a rewrite with the same content is not new evidence");

  writeState(cwd, "validation-results", { validation_results: [{ validation_id: "v1" }, { validation_id: "v2" }] });
  const measured = recordProgress({ cwd, cycleId: CYCLE, now: LEAD_MS + 320 * MINUTE });
  assert.notEqual(measured.progress.evidence_changed_at, changedAt, "a new result IS new evidence");
});

test("the owner checkpoint is a wait on a person, never a stall", () => {
  // docs/incident-catalog.md's rule in this file's terms: a correct pause stays
  // a pause. The owner picking a candidate is the pipeline working.
  const cwd = buildCycle("owner_checkpoint");
  for (let index = 0; index < 20; index += 1) {
    addFinishedLane(cwd, { laneId: `followup-scout-${index + 10}`, actionType: "adaptive_search_followup", finishedMs: Date.parse("2026-09-19T23:00:00Z") + index * MINUTE });
  }
  const now = Date.parse("2026-09-20T12:00:00Z");
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now });
  assert.equal(progress.next_milestone, "owner_selection");
  assert.deepEqual(stallFindings({ progress, config: supervisorConfig({}), now }), []);
});

test("the stall prompt tells the agent a stall is a contract defect, not a check to delete", () => {
  const cwd = buildCycle("lead_selected");
  addFinishedLane(cwd, { laneId: "followup-lab-director-39", actionType: "lab_director_requery_followup", finishedMs: LEAD_MS + MINUTE });
  const now = LEAD_MS + 200 * MINUTE;
  const progress = deriveProgress({ cwd, cycleId: CYCLE, now });
  const primary = { kind: "no_milestone_progress", signature: "no_milestone_progress:lead_selected", detail: "stuck", lane_ids: [] };
  const evidence = __private.buildEvidence({
    cwd, cycleId: CYCLE, triggers: [primary], primary, state: { runs: [] }, repo: null, deps: {}, progress, budget: null,
  });
  const prompt = __private.buildPrompt({ cycleId: CYCLE, runId: "r1", evidencePath: "e.json", evidence, primary, cwd });
  assert.match(prompt, /This is a STALL, not a failure/);
  assert.match(prompt, /CONTRACT OR PLUMBING DEFECT/);
  assert.match(prompt, /THE FIX MUST MAKE THE CYCLE ABLE TO MOVE/);
  assert.match(prompt, /removing the stall check is/);
  assert.match(prompt, /Current milestone: lead_selected/);
  assert.match(prompt, /lab_director_requery_followup: 1 finished/);

  // And the ordinary triggers are untouched by it.
  const pausePrimary = { kind: "pause", signature: "pause:x", detail: "blocked", lane_ids: [] };
  const pausePrompt = __private.buildPrompt({ cycleId: CYCLE, runId: "r1", evidencePath: "e.json", evidence, primary: pausePrimary, cwd });
  assert.equal(/This is a STALL/.test(pausePrompt), false);
});

// ---------------------------------------------------------------------------
// the existing triggers are unchanged

test("detectTriggers still finds nothing in a cycle that is merely young", () => {
  const cwd = buildCycle("lead_selected");
  addFinishedLane(cwd, { laneId: "followup-lab-director-39", actionType: "lab_director_requery_followup", finishedMs: LEAD_MS + MINUTE });
  const triggers = __private.detectTriggers({
    cwd, cycleId: CYCLE, state: { lane_watermark: new Date(LEAD_MS).toISOString(), attempted_signatures: [] }, now: LEAD_MS + 10 * MINUTE,
  });
  assert.deepEqual(triggers, []);
});

test("a plumbing pause still outranks a stall in the same pass", () => {
  const cwd = stallCycle({ minutes: 300, lanes: 8 }).cwd;
  writeJson(path.join(stateDir(cwd), `${CYCLE}-labdirector-pause.json`), {
    cycle_id: CYCLE,
    block_type: "windows_sandbox_setup",
    phase: "running",
    reason: "Windows sandbox setup helper was canceled or incomplete",
    evidence: "tool execution setup installation incomplete",
    source: "native-codex-watchdog",
  });
  const triggers = __private.detectTriggers({
    cwd, cycleId: CYCLE, state: { lane_watermark: new Date(LEAD_MS).toISOString(), attempted_signatures: [] }, now: LEAD_MS + 300 * MINUTE,
  });
  assert.equal(triggers[0].kind, "pause");
  assert.equal(triggers.some((item) => item.kind === "no_milestone_progress"), true);
});

test("a repeated failure still outranks a stall, and its signature is unchanged", () => {
  const cwd = buildCycle("lead_selected");
  for (let index = 0; index < 4; index += 1) {
    const laneDir = addFinishedLane(cwd, {
      laneId: `followup-runner-${70 + index}`,
      actionType: "validation_followup",
      status: "failed",
      finishedMs: LEAD_MS + (index + 1) * MINUTE,
    });
    writeJson(path.join(laneDir, "lane-contract.json"), { role: "runner" });
    writeJson(path.join(laneDir, "result.json"), { status: "failed", error: "ValueError: handoff check requires a non-empty column_mapping" });
  }
  const triggers = __private.detectTriggers({
    cwd, cycleId: CYCLE, state: { lane_watermark: new Date(LEAD_MS).toISOString(), attempted_signatures: [] }, now: LEAD_MS + 300 * MINUTE,
  });
  assert.equal(triggers[0].kind, "repeated_failure");
  assert.match(triggers[0].signature, /^repeated_failure:runner\|/);
});

// ---------------------------------------------------------------------------
// budget

function turnLine(usage) {
  return `${JSON.stringify({ type: "turn.completed", usage })}\n`;
}

function laneWithLog(cwd, laneId, { role, actionType, lines, startMs, endMs }) {
  const laneDir = path.join(cwd, ".research-lab", "lanes", CYCLE, laneId);
  fs.mkdirSync(laneDir, { recursive: true });
  writeJson(path.join(laneDir, "run-state.json"), { lane_id: laneId, role });
  writeJson(path.join(laneDir, "role-plan.json"), { lane_id: laneId, role, action_type: actionType });
  fs.writeFileSync(path.join(laneDir, "events.jsonl"), [
    JSON.stringify({ event_type: "lane_spawned", ts: new Date(startMs).toISOString(), payload: { lane_id: laneId } }),
    JSON.stringify({ event_type: "lane_completed", ts: new Date(endMs).toISOString(), payload: { lane_id: laneId } }),
  ].join("\n") + "\n", "utf8");
  writeJson(path.join(laneDir, "final-status.json"), { lane_id: laneId, status: "completed", completed_at: new Date(endMs).toISOString() });
  fs.writeFileSync(path.join(laneDir, "stdout.log"), lines, "utf8");
  return laneDir;
}

test("budget aggregation reads the runtime's own usage, cached tokens included", () => {
  const cwd = tmpdir("rl-budget-");
  // The real envelope, from cycle-a-20260919/analyst-01.
  laneWithLog(cwd, "analyst-01", {
    role: "analyst",
    actionType: "methods_followup",
    startMs: LEAD_MS,
    endMs: LEAD_MS + 155 * 1000,
    lines: [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "noise" } }),
      turnLine({ input_tokens: 601636, cached_input_tokens: 571904, cache_write_input_tokens: 0, output_tokens: 8668, reasoning_output_tokens: 1687 }).trim(),
    ].join("\n") + "\n",
  });
  laneWithLog(cwd, "followup-lab-director-39", {
    role: "lab-director",
    actionType: "lab_director_requery_followup",
    startMs: LEAD_MS,
    endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 100000, cached_input_tokens: 40000, output_tokens: 5000, reasoning_output_tokens: 1000 }),
  });

  const { report } = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 600 * 1000 });
  assert.equal(report.totals.turns, 2);
  assert.equal(report.totals.input_tokens, 701636);
  assert.equal(report.totals.cached_input_tokens, 611904);
  assert.equal(report.totals.billed_input_tokens, 89732);
  assert.equal(report.totals.output_tokens, 13668);
  assert.equal(report.totals.counted_tokens, 89732 + 13668);
  assert.equal(report.by_role.analyst.counted_tokens, 601636 - 571904 + 8668);
  assert.equal(report.by_action_type.lab_director_requery_followup.counted_tokens, 60000 + 5000);
  assert.equal(report.by_lane["analyst-01"].wall_clock_seconds, 155);
  assert.equal(report.wall_clock.lane_seconds_total, 215);
  assert.equal(fs.existsSync(budgetPath({ cwd, cycleId: CYCLE })), true);
});

test("a log still being written is counted once: the partial last line waits", () => {
  const cwd = tmpdir("rl-budget-partial-");
  const laneDir = laneWithLog(cwd, "analyst-01", {
    role: "analyst", actionType: "methods_followup", startMs: LEAD_MS, endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }),
  });
  const stdout = path.join(laneDir, "stdout.log");
  // The runtime is mid-write: a complete turn, then half of the next one.
  const truncated = turnLine({ input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 400 }).trim().slice(0, 40);
  fs.appendFileSync(stdout, truncated, "utf8");

  const first = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 90 * 1000 });
  assert.equal(first.report.totals.turns, 1, "the half-written turn is not counted yet");
  assert.equal(first.report.totals.counted_tokens, 800 + 100);

  // The runtime finishes the line and adds one more.
  fs.appendFileSync(stdout, turnLine({ input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 400 }).slice(40), "utf8");
  fs.appendFileSync(stdout, turnLine({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 }), "utf8");

  const second = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 120 * 1000 });
  assert.equal(second.report.totals.turns, 3, "each turn counted exactly once across the two passes");
  assert.equal(second.report.totals.counted_tokens, (800 + 100) + (3000 + 400) + (500 + 50));
});

test("the second pass reads only what was appended", () => {
  const cwd = tmpdir("rl-budget-incremental-");
  const laneDir = laneWithLog(cwd, "analyst-01", {
    role: "analyst", actionType: "methods_followup", startMs: LEAD_MS, endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }),
  });
  const first = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 90 * 1000 });
  const cursor = first.report.cursors["analyst-01"];
  assert.equal(cursor.offset, fs.statSync(path.join(laneDir, "stdout.log")).size);

  const { turns } = readTurnsIncremental(path.join(laneDir, "stdout.log"), cursor);
  assert.deepEqual(turns, [], "nothing new to read");

  fs.appendFileSync(path.join(laneDir, "stdout.log"), turnLine({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }), "utf8");
  const again = readTurnsIncremental(path.join(laneDir, "stdout.log"), cursor);
  assert.equal(again.turns.length, 1);
  assert.equal(again.turns[0].input_tokens, 10);
});

test("a rewritten log is re-read from the start rather than silently skipped", () => {
  const cwd = tmpdir("rl-budget-rewrite-");
  const laneDir = laneWithLog(cwd, "analyst-01", {
    role: "analyst", actionType: "methods_followup", startMs: LEAD_MS, endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 9000, cached_input_tokens: 0, output_tokens: 900 }),
  });
  const stdout = path.join(laneDir, "stdout.log");
  const first = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 90 * 1000 });
  assert.equal(first.report.totals.counted_tokens, 9900);

  // A relaunched lane truncates its own log.
  fs.writeFileSync(stdout, turnLine({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }), "utf8");
  const { turns, cursor } = readTurnsIncremental(stdout, first.report.cursors["analyst-01"]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].input_tokens, 10);
  assert.equal(cursor.offset, fs.statSync(stdout).size);
});

test("the maintainer's own Codex runs are counted too", () => {
  const cwd = tmpdir("rl-budget-maintainer-");
  fs.mkdirSync(stateDir(cwd), { recursive: true });
  const runDir = path.join(cwd, ".research-lab", "maintenance", CYCLE, "run-0001");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "codex.stdout.jsonl"), turnLine({ input_tokens: 50000, cached_input_tokens: 10000, output_tokens: 2000 }), "utf8");
  const { report } = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: Date.now() });
  assert.equal(report.maintainer_codex_runs, 1);
  assert.equal(report.by_role.maintainer.counted_tokens, 40000 + 2000);
  assert.equal(report.totals.counted_tokens, 42000);
});

test("no limits configured means no ceiling at all", () => {
  assert.deepEqual(budgetLimits({}), { token_budget: null, hours_budget: null });
  assert.deepEqual(budgetLimits({ RESEARCHLAB_CYCLE_TOKEN_BUDGET: "", RESEARCHLAB_CYCLE_HOURS_BUDGET: "0" }), {
    token_budget: null, hours_budget: null,
  });
  const cwd = tmpdir("rl-budget-nolimit-");
  laneWithLog(cwd, "analyst-01", {
    role: "analyst", actionType: "methods_followup", startMs: LEAD_MS, endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 10 ** 9, cached_input_tokens: 0, output_tokens: 10 ** 8 }),
  });
  const { report } = updateBudget({ cwd, cycleId: CYCLE, env: {}, now: LEAD_MS + 90 * 1000 });
  assert.equal(report.status.exhausted, false);
  assert.equal(report.status.token_fraction, null);
});

// ---------------------------------------------------------------------------
// 80% and 100%

function budgetCycle({ counted, env }) {
  const cwd = buildCycle("lead_selected");
  laneWithLog(cwd, "analyst-01", {
    role: "analyst",
    actionType: "methods_followup",
    startMs: LEAD_MS,
    endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: counted, cached_input_tokens: 0, output_tokens: 0 }),
  });
  return { cwd, report: updateBudget({ cwd, cycleId: CYCLE, env, now: LEAD_MS + 90 * 1000 }).report };
}

test("at 80% the budget warns and the cycle keeps running", () => {
  const env = { RESEARCHLAB_CYCLE_TOKEN_BUDGET: "1000" };
  const { cwd, report } = budgetCycle({ counted: 800, env });
  assert.equal(report.status.token_fraction, 0.8);
  assert.equal(report.status.warned, true);
  assert.equal(report.status.exhausted, false);

  const state = { runs: [], attempted_signatures: [] };
  const outcome = __private.enforceBudget({
    ctx: { cwd, cycleId: CYCLE, deps: {} }, cwd, cycleId: CYCLE, env, state, budget: report, progress: null, deps: {},
  });
  assert.equal(outcome, null, "a warning never stops the cycle");
  assert.ok(state.budget_warned_at);
  const events = fs.readFileSync(path.join(cwd, ".research-lab", "events", `${CYCLE}-maintainer.jsonl`), "utf8");
  assert.match(events, /maintainer_budget_warning/);
  assert.equal(fs.existsSync(path.join(stateDir(cwd), `${CYCLE}-termination-code.json`)), false);
});

test("at 100% the cycle stops and no Codex run is started", () => {
  const env = { RESEARCHLAB_MAINTAINER: "1", RESEARCHLAB_CYCLE_TOKEN_BUDGET: "1000" };
  const { cwd } = budgetCycle({ counted: 1000, env });
  // A stall is standing at the same time; the budget still wins.
  for (let index = 0; index < 8; index += 1) {
    addFinishedLane(cwd, { laneId: `followup-lab-director-${index + 20}`, actionType: "lab_director_requery_followup", finishedMs: LEAD_MS + index * MINUTE });
  }

  let codexRuns = 0;
  const outcome = maybeRunMaintainer({
    cwd,
    cycleId: CYCLE,
    env,
    deps: { now: () => LEAD_MS + 400 * MINUTE, runCodex: () => { codexRuns += 1; throw new Error("the maintainer must not run here"); } },
  });

  assert.equal(codexRuns, 0, "spending the exhausted budget to investigate it is the one thing that cannot be right");
  assert.equal(outcome.outcome, "budget_exhausted");
  assert.match(outcome.reason, /cycle token budget exhausted: 1000 of 1000/);
  assert.ok(outcome.reason.includes(`${CYCLE}-budget.json`), "the owner is told where the budget report is");
  assert.equal(outcome.resumed, false);

  const termination = JSON.parse(fs.readFileSync(path.join(stateDir(cwd), `${CYCLE}-termination-code.json`), "utf8"));
  assert.equal(termination.code, __private.BUDGET_TERMINATION_CODE);
  assert.equal(termination.should_stop, true);
  assert.equal(termination.category, "budget_exhausted");
  assert.match(termination.metadata.budget_report_path, /-budget\.json$/);

  const pause = JSON.parse(fs.readFileSync(path.join(stateDir(cwd), `${CYCLE}-labdirector-pause.json`), "utf8"));
  assert.equal(pause.block_type, "budget_exhausted");
  assert.equal(pause.manual_resume_required, true);

  // And the decision stays with the owner: a later pass must not read its own
  // pause as plumbing and start diagnosing it.
  const triggers = __private.detectTriggers({
    cwd, cycleId: CYCLE, state: { lane_watermark: new Date(LEAD_MS).toISOString(), attempted_signatures: [] }, now: LEAD_MS + 400 * MINUTE,
  });
  assert.equal(triggers.some((item) => item.kind === "pause"), false);
  assert.equal(triggers.some((item) => item.kind === "termination"), false);

  // A second pass does not rewrite the marker or start a run either.
  const again = maybeRunMaintainer({
    cwd, cycleId: CYCLE, env,
    deps: { now: () => LEAD_MS + 410 * MINUTE, runCodex: () => { codexRuns += 1; throw new Error("no"); } },
  });
  assert.equal(codexRuns, 0);
  assert.equal(again.outcome, "budget_exhausted");
});

test("an hours budget stops the cycle the same way a token budget does", () => {
  const env = { RESEARCHLAB_MAINTAINER: "1", RESEARCHLAB_CYCLE_HOURS_BUDGET: "2" };
  const cwd = buildCycle("lead_selected");
  laneWithLog(cwd, "analyst-01", {
    role: "analyst", actionType: "methods_followup", startMs: LEAD_MS, endMs: LEAD_MS + 60 * 1000,
    lines: turnLine({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }),
  });
  const { report } = updateBudget({ cwd, cycleId: CYCLE, env, now: LEAD_MS + 3 * 3600 * 1000 });
  assert.equal(report.wall_clock.elapsed_hours, 3);
  assert.equal(report.status.exhausted, true);
  assert.equal(report.status.exhausted_by, "hours");

  let codexRuns = 0;
  const outcome = maybeRunMaintainer({
    cwd, cycleId: CYCLE, env,
    deps: { now: () => LEAD_MS + 3 * 3600 * 1000, runCodex: () => { codexRuns += 1; throw new Error("no"); } },
  });
  assert.equal(codexRuns, 0);
  assert.equal(outcome.outcome, "budget_exhausted");
  assert.match(outcome.reason, /wall-clock budget exhausted: 3 of 2 hours/);
});

test("with no budget configured the supervisor behaves exactly as before", () => {
  const env = { RESEARCHLAB_MAINTAINER: "1" };
  const { cwd } = budgetCycle({ counted: 10 ** 9, env });
  const state = { runs: [], attempted_signatures: [] };
  const { report } = updateBudget({ cwd, cycleId: CYCLE, env, now: LEAD_MS + 10 ** 7 });
  assert.equal(__private.enforceBudget({
    ctx: { cwd, cycleId: CYCLE, deps: {} }, cwd, cycleId: CYCLE, env, state, budget: report, progress: null, deps: {},
  }), null);
  assert.equal(fs.existsSync(path.join(stateDir(cwd), `${CYCLE}-termination-code.json`)), false);
});
