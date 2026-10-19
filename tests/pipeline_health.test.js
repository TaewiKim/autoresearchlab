"use strict";

// The supervisor sees the defects that do not stop a cycle.
//
// Every fixture below is a shape measured on cycle-a-20260919 on
// 2026-09-29, when each of these was found by reading the lanes by hand while
// the maintainer -- woken only by pauses, crashes, stops and stalls -- saw
// nothing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HEALTH_KIND,
  healthReportPath,
  pipelineHealthFindings,
} = require("../src/orchestrator/pipeline_health");
const { maybeRunMaintainer, __private: maintainer } = require("../src/orchestrator/maintainer");
const { currentAnalysisContract } = require("../src/policy/analysis_contract");

const CYCLE = "health-cycle";
const HOUR = 3_600_000;

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-health-"));
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  return { cwd, root, lanes: path.join(root, "lanes", CYCLE) };
}

function lane(fx, laneId, { createdMs = Date.now(), finalStatus = null, result = null, rolePlan = {}, handoff = null } = {}) {
  const dir = path.join(fx.lanes, laneId);
  write(path.join(dir, "lane-contract.json"), { lane_id: laneId });
  const when = new Date(createdMs);
  fs.utimesSync(path.join(dir, "lane-contract.json"), when, when);
  write(path.join(dir, "role-plan.json"), rolePlan);
  if (result) write(path.join(dir, "result.json"), result);
  if (finalStatus) write(path.join(dir, "final-status.json"), { result_path: path.join(dir, "result.json"), ...finalStatus });
  if (handoff) write(path.join(dir, "handoff-validation-plan.json"), handoff);
  return dir;
}

function cycleState(fx, statuses) {
  write(path.join(fx.root, "state", `${CYCLE}-cycle-run-state.json`), {
    lane_statuses: Object.entries(statuses).map(([lane_id, status]) => ({ lane_id, status })),
  });
}

function subtypes(findings) {
  return findings.map((item) => item.subtype).sort();
}

test("actual code and configuration receipts distinguish changed analysis from a copied handoff alias", () => {
  const fx = fixture(), now = Date.now();
  const handoff = path.join(fx.root, "lanes", CYCLE, "followup-analyst-794", "handoff-validation-plan.json");
  write(handoff, { handoff_seal: { execution_id: "old-execution" } });
  const rolePlan = { planner_metadata: { analyst_handoff_path: handoff } };
  const oldResult = { status: "completed" };
  const newResult = { status: "completed", execution_receipts: [{ script_sha256: "a".repeat(64), check_spec_sha256: "b".repeat(64), duration_seconds: 1 }] };
  lane(fx, "followup-runner-296", { rolePlan, result: oldResult, finalStatus: { status: "completed", completed_at: new Date(now - 1000).toISOString() } });
  lane(fx, "followup-runner-297", { rolePlan, result: newResult, finalStatus: { status: "completed", completed_at: new Date(now).toISOString() } });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 }), []);
  lane(fx, "followup-runner-298", { rolePlan, result: { ...newResult, execution_receipts: [{ ...newResult.execution_receipts[0], duration_seconds: 2 }] }, finalStatus: { status: "completed", completed_at: new Date(now).toISOString() } });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 });
  assert.deepEqual(subtypes(findings), ["duplicate_execution"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-297", "followup-runner-298"]);
});

test("an exact-assignment execution missing from the gate is detected despite a different family label", () => {
  const fx = fixture();
  const now = Date.now();
  const statement = "Disagreement-targeted acquisition improves paired terminal error.";
  const dataset = path.join(fx.root, "datasets", "acquisition_v1", "episodes.csv");
  const table = path.join(fx.root, "artifacts", "contrast_summary.csv");
  write(table, "effect,upper\n-0.001,0.001\n");
  const result = {
    status: "completed", dataset_root: path.dirname(dataset),
    hypothesis_results: [{ family: "acquisition_falsifier" }],
    blueprint_executions: [{ blueprint_id: "paired-analysis", status: "completed", tables: [{ path: table }] }],
  };
  lane(fx, "followup-runner-289", {
    result, finalStatus: { status: "completed", completed_at: new Date(now - HOUR).toISOString() },
    rolePlan: { assigned_hypotheses: [statement] },
  });
  const gatePath = path.join(fx.root, "state", `${CYCLE}-gate-review.json`);
  const hypothesisPath = path.join(fx.root, "state", `${CYCLE}-lab-director-hypothesis.json`);
  const hypothesis = { statement, dataset_or_accession: dataset };
  write(hypothesisPath, hypothesis);
  write(gatePath, { latest_validation_lane_id: null, current_hypothesis_identity: { lead_key: "current" } });
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now })), ["current_lead_validation_unbound"]);
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now - 55 * 60_000 })), []);

  // A genuinely different estimand or retired lead must not be force-bound.
  write(hypothesisPath, { ...hypothesis, statement: "A different scientific claim." });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
  write(hypothesisPath, { ...hypothesis, dataset_or_accession: path.join(fx.root, "other", "episodes.csv") });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
  write(hypothesisPath, hypothesis);
  write(gatePath, { latest_validation_lane_id: "followup-runner-289" });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
});

test("a contract-mismatched exact-assignment run does not displace verified current-lead evidence", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-16: runner 332 executed the
  // exact current-lead assignment and wrote tables after verified runner 331,
  // but its primary contrasts failed the canonical output contract. The gate
  // correctly retained 331 while the health detector called it unbound.
  const fx = fixture();
  const now = Date.now();
  const statement = "Resource-matched policy slopes differ from chunked BC on at least one axis.";
  const dataset = path.join(fx.root, "datasets", "resource_matched_axis_curves_v1", "episodes.csv");
  write(path.join(fx.root, "state", `${CYCLE}-lab-director-hypothesis.json`), {
    selected_hypothesis: {
      statement,
      primary_family: "resource_matched_axis_specific_extrapolation",
      dataset_or_accession: dataset,
      identification_strategy: { estimands: ["axis-specific slope contrasts"] },
    },
  });
  write(path.join(fx.root, "state", `${CYCLE}-analysis-contract-policy.json`), {
    enabled: true,
    specs: {
      resource_matched_axis_specific_extrapolation: {
        canonical_statement: statement,
        canonical_estimands: ["axis-specific slope contrasts"],
        comparator: "chunked_bc",
        required_contrast_ids: ["slope:initial_pose"],
        dataset_sha256: "a".repeat(64),
      },
    },
  });
  const contract = currentAnalysisContract(fx.root, CYCLE);
  const result = (status, problems = []) => ({
    status: "completed",
    dataset_root: path.dirname(dataset),
    analysis_contract_validation: {
      contract_id: contract.contract_id,
      status,
      evidence_role: "primary",
      problems,
    },
    blueprint_executions: [{ blueprint_id: "axis-slopes", status: "completed", tables: [] }],
  });
  lane(fx, "followup-runner-331", {
    result: result("verified"),
    finalStatus: { status: "completed", completed_at: new Date(now - 2 * HOUR).toISOString() },
    rolePlan: { assigned_hypotheses: [statement] },
  });
  const table = path.join(fx.root, "artifacts", "stats", CYCLE, "followup-runner-332", "primary_contrasts.csv");
  write(table, "contrast_id,estimate\nslope:initial_pose,\n");
  const mismatched = result("mismatch", ["primary_contrast_estimates_missing"]);
  mismatched.blueprint_executions[0].tables.push({ name: "primary_contrasts.csv", path: table });
  lane(fx, "followup-runner-332", {
    result: mismatched,
    finalStatus: { status: "completed", completed_at: new Date(now - HOUR).toISOString() },
    rolePlan: { assigned_hypotheses: [statement] },
  });
  write(path.join(fx.root, "state", `${CYCLE}-gate-review.json`), {
    latest_validation_lane_id: "followup-runner-331",
    validation_matches_current_lead: true,
  });

  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.deepEqual(subtypes(findings), ["analysis_contract_mismatch"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-332"]);

  // Once that same immutable execution is contract-verified, leaving 331 bound
  // is the routing pathology and must still wake the maintainer.
  mismatched.analysis_contract_validation = {
    ...mismatched.analysis_contract_validation,
    status: "verified",
    problems: [],
  };
  write(path.join(fx.lanes, "followup-runner-332", "result.json"), mismatched);
  const verifiedFindings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.deepEqual(subtypes(verifiedFindings), ["current_lead_validation_unbound"]);
  assert.deepEqual(verifiedFindings[0].lane_ids, ["followup-runner-332"]);
});

test("a single broken pinned prior-artifact reference is detected and duplicate failures share one trigger", () => {
  const fx = fixture();
  const now = Date.now();
  const result = { status: "failed", blueprint_executions: [{
    status: "failed",
    error: `ValueError: expected exactly one eval_log.json with SHA-256 ${"c".repeat(64)} under RESEARCHLAB_PRIOR_ARTIFACTS_ROOT=/work/artifacts; found 0`,
  }] };
  lane(fx, "followup-runner-288", { result, finalStatus: { status: "failed", completed_at: new Date(now - 60_000).toISOString() } });
  let findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.deepEqual(subtypes(findings), ["missing_prior_artifact"]);
  const signature = findings[0].signature;
  lane(fx, "followup-runner-290", { result, finalStatus: { status: "failed", completed_at: new Date(now).toISOString() } });
  findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signature, signature);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-290"]);
  const fixedAt = { [signature]: now + 1000 };
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now + 2000, fixedAt }), []);
  lane(fx, "followup-runner-293", { result, finalStatus: { status: "failed", completed_at: new Date(now + 3000).toISOString() } });
  const recurrence = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now + 4000, fixedAt });
  assert.equal(recurrence.length, 1);
  assert.notEqual(recurrence[0].signature, signature);
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now + 25 * HOUR }), []);
});

test("scientific null results and ordinary execution errors do not trigger pinned-reference recovery", () => {
  const fx = fixture();
  const now = Date.now();
  lane(fx, "followup-runner-291", {
    result: { status: "completed", blueprint_executions: [{ status: "completed", metrics: { pass_fail: "fail", resolution_status: "valid_falsification" } }] },
    finalStatus: { status: "completed", completed_at: new Date(now).toISOString() },
  });
  lane(fx, "followup-runner-292", {
    result: { status: "failed", blueprint_executions: [{ status: "failed", error: "ValueError: model did not converge" }] },
    finalStatus: { status: "failed", completed_at: new Date(now).toISOString() },
  });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
});

test("active-lead quality contract mismatches wake the maintainer without changing the gate", () => {
  const fx = fixture();
  const gatePath = path.join(fx.root, "state", `${CYCLE}-gate-review.json`);
  const result = {
    validation_summary: {
      checks: { canonical_resolution_fraction: true },
      analyst_quality_standard: { failed_requirements: ["required_validation_check:canonical_resolution_fraction=1.0"] },
    },
  };
  const dir = lane(fx, "followup-runner-100", { result });
  const gate = { latest_validation_lane_id: "followup-runner-100", validation_matches_current_lead: true, score: 42 };
  write(gatePath, gate);
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE });
  assert.deepEqual(subtypes(findings), ["validation_contract_mismatch"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatePath, "utf8")), gate);

  // A properly evaluated failing numerical criterion is a scientific failure.
  result.validation_summary.analyst_quality_standard.evaluated_requirements = [
    { requirement: "canonical_resolution_fraction=1.0", observed_values: [0.5], satisfied: false },
  ];
  write(path.join(dir, "result.json"), result);
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE }), []);

  delete result.validation_summary.analyst_quality_standard.evaluated_requirements;
  write(path.join(dir, "result.json"), result);
  write(gatePath, { ...gate, validation_matches_current_lead: false });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE }), []);
});

test("rigor summary contradictions are detected only with direct table evidence", () => {
  const fx = fixture();
  const gatePath = path.join(fx.root, "state", `${CYCLE}-gate-review.json`);
  const result = { validation_summary: { rigor_profile: {
    signals: { multi_seed: false }, table_evidence: { multi_seed: { distinct_values: 10 } },
  } } };
  const dir = lane(fx, "followup-runner-101", { result });
  write(gatePath, { latest_validation_lane_id: "followup-runner-101", validation_matches_current_lead: true });
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE })), ["validation_contract_mismatch"]);
  result.validation_summary.rigor_profile.table_evidence = {};
  write(path.join(dir, "result.json"), result);
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE }), []);
});

test("a run that measured nothing but records its check as pass is found", () => {
  const fx = fixture();
  // followup-runner-67..70: failed before inference, resolution pass_fail "pass".
  lane(fx, "followup-runner-67", {
    finalStatus: { status: "completed" },
    result: {
      status: "failed",
      validation_summary: {
        blueprints_passed: 0,
        handoff_check_resolutions: [{ check_id: "coverage-decay-axis-equivalence-v5", pass_fail: "pass", valid_falsification_result: false }],
      },
    },
  });
  // A real falsification is not this defect.
  lane(fx, "followup-runner-71", {
    finalStatus: { status: "completed" },
    result: {
      status: "failed",
      validation_summary: {
        blueprints_passed: 0,
        handoff_check_resolutions: [{ check_id: "RECOVERY", pass_fail: "fail", valid_falsification_result: true }],
      },
    },
  });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE });
  assert.deepEqual(subtypes(findings), ["failed_run_recorded_as_pass"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-67"]);
  assert.equal(findings[0].kind, HEALTH_KIND);
});

test("after its fix is accepted, a recorded pass is judged only on later runs", () => {
  // cycle-a-20260919, 2026-10-01: fixed on 09-30 (a1b4637), still
  // reported for the 54 runs written before the fix.
  const fx = fixture();
  const fixMs = Date.now() - 2 * HOUR;
  const measuredNothing = {
    status: "failed",
    validation_summary: { blueprints_passed: 0, handoff_check_resolutions: [{ check_id: "v5", pass_fail: "pass", valid_falsification_result: false }] },
  };
  lane(fx, "followup-runner-70", { finalStatus: { status: "completed", completed_at: new Date(fixMs - HOUR).toISOString() }, result: measuredNothing });
  const fixedAt = { [`${HEALTH_KIND}:failed_run_recorded_as_pass`]: fixMs };
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, fixedAt }), []);
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE })), ["failed_run_recorded_as_pass"]);

  // The harness doing it again after the fix is found.
  lane(fx, "followup-runner-104", { finalStatus: { status: "completed", completed_at: new Date().toISOString() }, result: measuredNothing });
  const again = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, fixedAt });
  assert.deepEqual(again[0]?.lane_ids, ["followup-runner-104"]);
});

test("two runners completing the same sealed execution are found; one is not", () => {
  const fx = fixture();
  const since = Date.now() - HOUR;
  const sealed = (id) => ({ handoff_seal: { status: "sealed", execution_id: id } });
  const a = lane(fx, "followup-analyst-222", { handoff: sealed("exec-1") });
  const b = lane(fx, "followup-analyst-226", { handoff: sealed("exec-1") });
  const c = lane(fx, "followup-analyst-231", { handoff: sealed("exec-2") });
  const passed = { status: "completed", validation_summary: { blueprints_passed: 1, handoff_check_resolutions: [{ check_id: "gap_fill" }] } };
  const done = { status: "completed", completed_at: new Date().toISOString() };
  for (const [runner, analystDir] of [["followup-runner-91", a], ["followup-runner-92", b], ["followup-runner-94", c]]) {
    lane(fx, runner, {
      finalStatus: done,
      result: passed,
      rolePlan: { planner_metadata: { analyst_handoff_path: path.join(analystDir, "handoff-validation-plan.json") } },
    });
  }
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, sinceMs: since });
  assert.deepEqual(subtypes(findings), ["duplicate_execution"]);
  assert.deepEqual(findings[0].lane_ids.sort(), ["followup-runner-91", "followup-runner-92"]);
  // Before the watermark it is history the supervisor does not re-diagnose.
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, sinceMs: Date.now() + HOUR }), []);
});

test("a queued lane overtaken by later lanes of the same work is starved; a lane the scheduler closed is not", () => {
  const fx = fixture();
  const now = Date.now();
  const review = { action_type: "independent_gate_review_followup" };
  // followup-gatekeeper-32: enqueued 17 h before, while novelty re-reviews
  // enqueued later ran.
  lane(fx, "followup-gatekeeper-32", { createdMs: now - 17 * HOUR, rolePlan: review });
  for (const [id, hours] of [["followup-gatekeeper-33", 16], ["followup-gatekeeper-36", 13], ["followup-gatekeeper-38", 13]]) {
    lane(fx, id, { createdMs: now - hours * HOUR, rolePlan: review, finalStatus: { status: "completed" } });
  }
  // A week-old lane whose final status the self-healer moved aside, recorded failed.
  lane(fx, "followup-gatekeeper-07", { createdMs: now - 200 * HOUR, rolePlan: review });
  cycleState(fx, {
    "followup-gatekeeper-32": "pending",
    "followup-gatekeeper-07": "failed",
    "followup-gatekeeper-33": "completed",
    "followup-gatekeeper-36": "completed",
    "followup-gatekeeper-38": "completed",
  });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.deepEqual(subtypes(findings), ["starved_lane"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-gatekeeper-32"]);
});

test("gate reviews of other rubrics do not overtake a dependency-blocked review", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-01: the finding grouped
  // every independent_gate_review_followup together, so completed novelty
  // reviews made technical-quality, clarity and reproducibility reviews look
  // starved even while the scheduler recorded waiting-for-new-lead-evidence.
  const fx = fixture();
  const now = Date.now();
  lane(fx, "followup-gatekeeper-100", {
    createdMs: now - 44 * HOUR,
    rolePlan: { action_type: "independent_gate_review_followup", target_rubric: "technical_quality" },
  });
  for (const [id, rubric] of [["124", "novelty"], ["132", "clarity"], ["136", "impact"]]) {
    lane(fx, `followup-gatekeeper-${id}`, {
      createdMs: now - HOUR,
      rolePlan: { action_type: "independent_gate_review_followup", target_rubric: rubric },
      finalStatus: { status: "completed" },
    });
  }
  cycleState(fx, {
    "followup-gatekeeper-100": "pending",
    "followup-gatekeeper-124": "completed",
    "followup-gatekeeper-132": "completed",
    "followup-gatekeeper-136": "completed",
  });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
});

test("lanes waiting for a role that never comes are found; a role that is on its way is not", () => {
  // cycle-a-20260919, 2026-10-01: two analysts waited 20 h for an
  // engineer the cap refused every pass.
  const fx = fixture();
  const now = Date.now();
  lane(fx, "followup-engineer-240", {
    createdMs: now - 20 * HOUR,
    finalStatus: { status: "completed", completed_at: new Date(now - 19 * HOUR).toISOString() },
  });
  lane(fx, "followup-analyst-253", { createdMs: now - 20 * HOUR });
  lane(fx, "followup-analyst-254", { createdMs: now - 19 * HOUR });
  // Gatekeepers waiting for a runner that is pending now: not absent.
  lane(fx, "followup-gatekeeper-50", { createdMs: now - 30 * HOUR });
  lane(fx, "followup-runner-101", { createdMs: now - 9 * HOUR });
  cycleState(fx, {
    "followup-engineer-240": "completed",
    "followup-analyst-253": "pending",
    "followup-analyst-254": "pending",
    "followup-gatekeeper-50": "pending",
    "followup-runner-101": "pending",
  });
  const waitFor = (laneId, role, reason) => ({ lane_id: laneId, awaited_role: role, reason });
  write(path.join(fx.root, "plans", `${CYCLE}-run-summary.json`), {
    pass_summaries: [{
      skipped: [
        waitFor("followup-analyst-253", "engineer", "waiting-for-simulation-data request_id=v2 (engineer)"),
        waitFor("followup-analyst-254", "engineer", "waiting-for-simulation-data request_id=v2 (engineer)"),
        waitFor("followup-gatekeeper-50", "lab-runner", "waiting-for-new-lead-evidence last_round=round-47 recorded_at=2026-10-01T14:37:41Z"),
        { lane_id: "followup-runner-101", reason: "no-worker-slots" },
      ],
    }],
  });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now });
  assert.deepEqual(subtypes(findings), ["awaited_role_absent"]);
  assert.equal(findings[0].signature, `${HEALTH_KIND}:awaited_role_absent:engineer`);
  assert.deepEqual(findings[0].lane_ids, ["followup-analyst-253", "followup-analyst-254"]);
  assert.match(findings[0].detail, /followup-engineer-240/);

  // An engineer lane is created: the role is on its way.
  lane(fx, "followup-engineer-241", { createdMs: now - HOUR });
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now })), []);
});

test("a role that just finished a long-running lane is not reported absent", () => {
  const fx = fixture();
  const now = Date.now();
  lane(fx, "followup-engineer-563", {
    createdMs: now - 10 * HOUR,
    finalStatus: { status: "completed", completed_at: new Date(now - 60_000).toISOString() },
    rolePlan: { action_type: "simulation_data_generation_followup" },
  });
  lane(fx, "followup-analyst-731", { createdMs: now - 13 * HOUR });
  cycleState(fx, { "followup-engineer-563": "completed", "followup-analyst-731": "pending" });
  write(path.join(fx.root, "plans", `${CYCLE}-run-summary.json`), {
    pass_summaries: [{ skipped: [{
      lane_id: "followup-analyst-731", awaited_role: "engineer",
      reason: "waiting-for-simulation-data request_id=randomized_support_equivalence_v3 (engineer)",
    }] }],
  });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now }), []);
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now + 7 * HOUR })), ["awaited_role_absent"]);
});

test("a gate that keeps returning to scores it left is oscillating; a gate that moves is not", () => {
  const fx = fixture();
  const history = path.join(fx.root, "state", `${CYCLE}-gate-review-history.jsonl`);
  const at = (minutes) => new Date(Date.now() - (120 - minutes) * 60_000).toISOString();
  const row = (minutes, score, clarity) => JSON.stringify({ ts: at(minutes), kind: "gate-review", score, subject: "lead A", rubric: { clarity } });
  write(history, `${[row(0, 33, 52), row(10, 43, 52), row(20, 48, 64)].join("\n")}\n`);
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE }), [], "a rising gate is the research moving");
  // 21:15 60 / 21:17 40 / 21:19 60 / 21:23 44 / 22:50 56 / 22:53 44 / 23:07 56 / 23:10 44
  write(history, `${[row(0, 60, 88), row(2, 40, 52), row(4, 60, 88), row(8, 40, 52), row(10, 60, 88), row(12, 40, 52)].join("\n")}\n`);
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE });
  assert.deepEqual(subtypes(findings), ["gate_oscillation"]);
  const revisioned = [row(0, 60, 88), row(2, 40, 52), row(4, 60, 88), row(8, 40, 52), row(10, 60, 88), row(12, 40, 52)]
    .map((line) => JSON.stringify({ ...JSON.parse(line), evidence_revision: { validation_lane_id: "runner-same" } }));
  write(history, `${revisioned.join("\n")}\n`);
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE })), ["gate_oscillation"], "same-evidence oscillation must remain detectable");
});

test("new validation evidence is not reported as two gate computations oscillating", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-17: the history read by the
  // finding recorded 0 at 03:34, 05:45 and 06:15. Each zero immediately
  // followed a different completed validation (runners 391, 398 and 402), and
  // the intervening states were new focused-rubric reviews of that evidence.
  const fx = fixture();
  const history = path.join(fx.root, "state", `${CYCLE}-gate-review-history.jsonl`);
  const subject = "policy-aware acquisition utility on the shared-state MuJoCo panel";
  const measured = [
    ["03:00", 0, 0, "followup-runner-384"],
    ["03:24", 48, 38, "followup-runner-384"],
    ["03:34", 0, 0, "followup-runner-391"],
    ["03:48", 59, 58, "followup-runner-391"],
    ["03:52", 59, 58, "followup-runner-391"],
    ["04:08", 52, 45, "followup-runner-391"],
    ["05:20", 53, 45, "followup-runner-391"],
    ["05:28", 55, 55, "followup-runner-391"],
    ["05:45", 0, 0, "followup-runner-398"],
    ["05:55", 56, 76, "followup-runner-398"],
    ["06:05", 58, 76, "followup-runner-398"],
    ["06:15", 0, 0, "followup-runner-402"],
    ["06:32", 15, 74, "followup-runner-402"],
    ["06:42", 44, 74, "followup-runner-402"],
    ["06:48", 53, 74, "followup-runner-402"],
    ["07:02", 56, 74, "followup-runner-402"],
  ].map(([hm, score, novelty, validationLane]) => ({
    ts: `2026-10-17T${hm}:00Z`,
    kind: "gate-review",
    score,
    subject,
    rubric: { novelty },
    evidence_revision: {
      analysis_contract_id: validationLane === "followup-runner-402" ? "analysis:b160" : "analysis:59a",
      validation_lane_id: validationLane,
    },
  }));

  write(history, `${measured.map(({ evidence_revision, ...row }) => JSON.stringify(row)).join("\n")}\n`);
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: Date.parse("2026-10-17T10:07:57Z") })), ["gate_oscillation"], "without the evidence revision, the measured records reproduce the finding");

  write(history, `${measured.map((row) => JSON.stringify(row)).join("\n")}\n`);
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: Date.parse("2026-10-17T10:07:57Z") }), []);
});

test("a reviewer told there are no artifacts, while the run wrote them, is undelivered evidence", () => {
  const fx = fixture();
  write(path.join(fx.root, "state", `${CYCLE}-gate-review.json`), {
    latest_validation_lane_id: "followup-runner-98",
    rubric: [{
      name: "reproducibility",
      reasons: ["Evidence_packet_count is zero and validation_artifact_paths is empty; raw outputs, manifests, hashes, configurations, and analysis commands are not supplied."],
    }],
  });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE }), [], "no artifacts on disk: the reviewer is right");
  write(path.join(fx.root, "artifacts", "stats", CYCLE, "followup-runner-98", "blueprints", "support_metric", "table.csv"), "a,b\n1,2\n");
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE })), ["evidence_undelivered"]);
});

test("repeated seal refusals are found", () => {
  const fx = fixture();
  const since = Date.now() - HOUR;
  for (const id of ["followup-analyst-301", "followup-analyst-302", "followup-analyst-303"]) {
    lane(fx, id, {
      finalStatus: { status: "completed", completed_at: new Date().toISOString() },
      handoff: { handoff_seal: { status: "rejected", rejections: ["check `C` names `episodes.csv`, which is 12 different files under /x/y"] } },
    });
  }
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, sinceMs: since })), ["seal_rejections"]);
});

test("health findings come after every blocker and stall", () => {
  const fx = fixture();
  lane(fx, "followup-runner-67", {
    finalStatus: { status: "completed" },
    result: { status: "failed", validation_summary: { blueprints_passed: 0, handoff_check_resolutions: [{ check_id: "v5", pass_fail: "pass" }] } },
  });
  const triggers = maintainer.detectTriggers({
    cwd: fx.cwd,
    cycleId: CYCLE,
    error: new Error("native harness panicked"),
    state: {},
  });
  assert.deepEqual(triggers.map((item) => item.kind), ["native_exception", HEALTH_KIND]);
});

test("with no attempts left a health finding is reported and never stops the cycle", () => {
  const fx = fixture();
  lane(fx, "followup-runner-67", {
    finalStatus: { status: "completed" },
    result: { status: "failed", validation_summary: { blueprints_passed: 0, handoff_check_resolutions: [{ check_id: "v5", pass_fail: "pass" }] } },
  });
  // cycle-a-20260919: twelve of twelve runs spent by 09-22.
  write(maintainer.statePath({ cwd: fx.cwd, cycleId: CYCLE }), {
    cycle_id: CYCLE,
    lane_watermark: new Date().toISOString(),
    runs: [{ run_id: "run-01", signature: "pause:x", outcome: "accepted" }],
    attempted_signatures: ["pause:x"],
  });
  const outcome = maybeRunMaintainer({
    cwd: fx.cwd,
    cycleId: CYCLE,
    env: { ...process.env, RESEARCHLAB_MAINTAINER: "1", RESEARCHLAB_MAINTAINER_MAX_RUNS: "1" },
  });
  assert.equal(outcome, null);
  assert.equal(fs.existsSync(path.join(fx.root, "state", `${CYCLE}-termination-code.json`)), false, "no stop code");
  assert.equal(fs.existsSync(path.join(fx.root, "state", `${CYCLE}-labdirector-pause.json`)), false, "no pause");
  const report = JSON.parse(fs.readFileSync(healthReportPath({ cwd: fx.cwd, cycleId: CYCLE }), "utf8"));
  assert.deepEqual(report.findings.map((item) => item.subtype), ["failed_run_recorded_as_pass"]);
  const events = fs.readFileSync(path.join(fx.root, "events", `${CYCLE}-maintainer.jsonl`), "utf8");
  assert.match(events, /maintainer_health_finding_unattended/);
});

test("the maintainer's brief for a health finding says the cycle is running", () => {
  const primary = {
    kind: HEALTH_KIND,
    subtype: "failed_run_recorded_as_pass",
    signature: `${HEALTH_KIND}:failed_run_recorded_as_pass`,
    detail: "54 runner(s) failed before measuring anything",
    lane_ids: [],
  };
  const prompt = maintainer.buildPrompt({
    cycleId: CYCLE,
    runId: "run-13",
    evidencePath: "/tmp/evidence.json",
    evidence: { lanes: [] },
    primary,
    cwd: "/tmp/worktree",
  });
  assert.match(prompt, /is running, and the supervisor/);
  assert.match(prompt, /HEALTH finding, not a blockage/);
  assert.doesNotMatch(prompt, /is blocked or/);
});

// cycle-a-20260919, 2026-10-16..18: four defects found by reading the
// lanes by hand, again, while every detector above was quiet.

function measuredRunner(fx, laneId, { completedMs, estimate = "0.89921875", script = laneId, label = null }) {
  const dir = path.join(fx.lanes, laneId);
  const table = path.join(dir, "primary_contrasts.csv");
  write(table, `contrast_id,estimate,simultaneous_lower,simultaneous_upper\ndp_r030,${estimate},0.1584535838,1.6399839162\ndp_r020,0.2414,-0.3045,0.79\n`);
  lane(fx, laneId, {
    finalStatus: { status: "completed", completed_at: new Date(completedMs).toISOString(), ...(label ? { failure_category: label } : {}) },
    result: {
      status: "completed",
      ...(label ? { degraded: true, failure_category: label } : {}),
      analysis_contract_validation: { status: "verified", evidence_role: "primary", executed_code_sha256: [shaOf(script)] },
      blueprint_executions: [{ status: "completed", tables: [{ name: "primary_contrasts.csv", path: table }] }],
    },
  });
}

function shaOf(text) {
  return require("crypto").createHash("sha256").update(text).digest("hex");
}

test("runners that keep writing the same numbers from new scripts are one repeated measurement", () => {
  const fx = fixture(), now = Date.now();
  measuredRunner(fx, "followup-runner-458", { completedMs: now - 3 * HOUR });
  measuredRunner(fx, "followup-runner-459", { completedMs: now - 2 * HOUR });
  // A different measurement is not a repeat of this one.
  measuredRunner(fx, "followup-runner-470", { completedMs: now - HOUR, estimate: "0.7119140625" });
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 }), []);
  measuredRunner(fx, "followup-runner-460", { completedMs: now - HOUR });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 });
  assert.deepEqual(subtypes(findings), ["repeated_result"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-458", "followup-runner-459", "followup-runner-460"]);
  assert.match(findings[0].detail, /from 3 different scripts/);
  // Over: a repetition that stopped hours ago is history, not a defect now.
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now: now + 5 * HOUR, sinceMs: 0 }), []);
  // The same numbers under renamed contrasts are the same measurement.
  const renamed = fixture();
  for (const [index, id] of ["followup-runner-478", "followup-runner-479", "followup-runner-497"].entries()) {
    measuredRunner(renamed, id, { completedMs: now - (3 - index) * HOUR, estimate: "0.7119140625" });
  }
  const table = path.join(renamed.lanes, "followup-runner-497", "primary_contrasts.csv");
  fs.writeFileSync(table, fs.readFileSync(table, "utf8").replace("dp_r030", "r030_success_dp_minus_raw").replace("dp_r020", "secondary_r020"));
  assert.deepEqual(subtypes(pipelineHealthFindings({ cwd: renamed.cwd, cycleId: CYCLE, now, sinceMs: 0 })), ["repeated_result"]);
});

test("a run labelled as measuring nothing whose primary table holds estimates is a contradiction", () => {
  const fx = fixture(), now = Date.now();
  measuredRunner(fx, "followup-runner-471", { completedMs: now - HOUR, label: "no_measurement_produced" });
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 });
  assert.deepEqual(subtypes(findings), ["measurement_label_contradicted"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-runner-471"]);
  // An empty table under that label is the label telling the truth.
  const empty = fixture();
  lane(empty, "followup-runner-472", {
    finalStatus: { status: "completed", completed_at: new Date(now - HOUR).toISOString() },
    result: { failure_category: "no_measurement_produced", blueprint_executions: [{ tables: [] }] },
  });
  assert.deepEqual(pipelineHealthFindings({ cwd: empty.cwd, cycleId: CYCLE, now, sinceMs: 0 }), []);
});

test("agent work the harness keeps setting aside for one reason is a finding", () => {
  const fx = fixture(), now = Date.now();
  const notices = path.join(fx.root, "events", `${CYCLE}-harness-notices.jsonl`);
  const notice = (analyst, kind = "contract_already_measured", ageHours = 1) => JSON.stringify({
    ts: new Date(now - ageHours * HOUR).toISOString(),
    event_type: kind,
    payload: { handoff_path: path.join(fx.lanes, analyst, "handoff-validation-plan.json") },
  });
  write(notices, [notice("followup-analyst-1011"), notice("followup-analyst-1012"), notice("followup-analyst-1012"), notice("followup-analyst-900", "contract_already_measured", 30)].join("\n") + "\n");
  // Two distinct handoffs in a day, and one older: under the threshold.
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 }), []);
  fs.appendFileSync(notices, `${notice("followup-analyst-1013")}\n`);
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0 });
  assert.deepEqual(subtypes(findings), ["discarded_work"]);
  assert.deepEqual(findings[0].lane_ids, ["followup-analyst-1011", "followup-analyst-1012", "followup-analyst-1013"]);
  // After a fix of this kind is accepted, what was set aside before it is not counted again.
  const fixedAt = { [`${findings[0].signature}`]: now - HOUR / 2 };
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0, fixedAt }), []);
});

test("an append-only log that grows past its hourly budget is a finding", () => {
  const fx = fixture();
  const now = Date.parse("2026-10-16T07:30:00Z");
  const dir = path.join(fx.root, "runtime", `${CYCLE}-labdirector-decisions`);
  write(path.join(dir, "2026-10-16T05.jsonl"), "x".repeat(2 * 1024 * 1024));
  write(path.join(dir, "2026-10-16T07.jsonl"), "x".repeat(3 * 1024 * 1024));
  const config = { RESEARCHLAB_HEALTH_LOG_HOUR_MB: "2.5" };
  // The open hour is still being written; it is not judged.
  assert.deepEqual(pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0, env: config }), []);
  write(path.join(dir, "2026-10-16T06.jsonl"), "x".repeat(3 * 1024 * 1024));
  const findings = pipelineHealthFindings({ cwd: fx.cwd, cycleId: CYCLE, now, sinceMs: 0, env: config });
  assert.deepEqual(subtypes(findings), ["log_growth"]);
  assert.match(findings[0].detail, /decision ledger .* took 3 MB in the hour 2026-10-16T06/);
});

test("the maintainer is shown the fixes it already made for the same kind of defect", () => {
  const fixes = Array.from({ length: 3 }, (_, index) => ({
    run_id: `run-${index}`,
    signature: `${HEALTH_KIND}:analysis_contract_mismatch:${index}`,
    outcome: "accepted",
    finished_at: new Date(Date.now() - (index + 1) * HOUR).toISOString(),
    commit: `${index}`.repeat(40),
    commit_title: `Contract verifier accepts spelling ${index}`,
  }));
  const primary = { kind: HEALTH_KIND, subtype: "analysis_contract_mismatch", signature: `${HEALTH_KIND}:analysis_contract_mismatch:new`, detail: "" };
  const fx = fixture();
  const evidenceFor = (runs) => maintainer.buildEvidence({ cwd: fx.cwd, cycleId: CYCLE, triggers: [primary], primary, state: { runs }, repo: null, deps: {} });
  const prompt = (runs) => maintainer.buildPrompt({ cycleId: CYCLE, runId: "run-x", evidencePath: "/tmp/e.json", evidence: evidenceFor(runs), primary, cwd: fx.cwd });
  assert.doesNotMatch(prompt(fixes.slice(0, 2)), /has been fixed/);
  const text = prompt([...fixes, { ...fixes[0], signature: `${HEALTH_KIND}:gate_oscillation:x`, commit_title: "unrelated" }]);
  assert.match(text, /This kind of defect has been fixed 3 times in 7 days/);
  assert.match(text, /Contract verifier accepts spelling 2/);
  assert.doesNotMatch(text, /unrelated/);
});
