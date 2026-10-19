"use strict";

// The questions the owner asks, answered the same way every time.
//
// How is it going / is the search working / are approvals sound / the graphs /
// research trends / the problem and its solution / what experiments remain /
// are the roles talking -- each one used to mean a fresh
// one-off script, and a one-off script is where today's wrong baseline and
// silently-empty glob came from. These tests pin the shape a dashboard will
// read and the three rules the report keeps.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { cycleStatus, VERDICT } = require("../src/reporting/cycle_status");

const CYCLE = "cg-status-test";

function emptyCycle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "lanes", CYCLE), { recursive: true });
  return root;
}

function writeState(root, name, value) {
  fs.writeFileSync(
    path.join(root, "state", `${CYCLE}-${name}.json`),
    JSON.stringify(value),
    "utf8",
  );
}

test("a cycle with nothing on disk reports not-yet, and does not throw", () => {
  // The rule that matters most for a dashboard: a stage not reached is a datum.
  // An exception here would take the panel down for a cycle that is merely young.
  const root = emptyCycle();
  const status = cycleStatus({ root, cycleId: CYCLE });
  assert.equal(status.schema, "researchlab.cycle_status.v1");
  assert.ok(status.checks.length >= 10);
  const absent = status.checks.filter((item) => item.verdict === VERDICT.ABSENT);
  assert.ok(absent.length >= 6, `expected most checks absent, got ${absent.length}`);
  // Absent is never attention: a young cycle is not a cycle in trouble.
  assert.equal(status.summary.attention, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("every check says where it looked", () => {
  // A number with no path behind it cannot be checked by the next person, and
  // three of today's reports were wrong in ways only the path would have shown.
  const root = emptyCycle();
  for (const item of cycleStatus({ root, cycleId: CYCLE }).checks) {
    assert.ok(String(item.where || "").trim(), `${item.id} does not say where it read`);
    assert.ok(String(item.label || "").trim(), `${item.id} has no label`);
    assert.ok(Object.values(VERDICT).includes(item.verdict), `${item.id}: ${item.verdict}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a halted cycle asks for attention and says so", () => {
  const root = emptyCycle();
  writeState(root, "cycle-run-state", {
    lane_counts: { completed: 10, running: 0, pending: 5 },
    updated_at: new Date().toISOString(),
  });
  writeState(root, "watchdog-halt", { halted_at: new Date().toISOString() });
  const run = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "run");
  assert.equal(run.verdict, VERDICT.ATTENTION);
  assert.equal(run.detail.halted, true);
  assert.match(run.note, /halt/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a lead with no stated way to be wrong wants attention", () => {
  // This is the field the schema could not carry for a whole cycle, so the one
  // check that would have shown it missing belongs here.
  const root = emptyCycle();
  writeState(root, "lab-director-hypothesis", {
    generated_by: "followup-lab-director-31",
    selected_hypothesis: { statement: "a claim", primary_family: "f" },
  });
  const lead = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "lead");
  assert.equal(lead.verdict, VERDICT.ATTENTION);
  assert.equal(lead.detail.falsification_conditions, 0);
  assert.match(lead.note, /no stated way to be wrong/);

  writeState(root, "lab-director-hypothesis", {
    generated_by: "followup-lab-director-31",
    selected_hypothesis: {
      statement: "a claim",
      primary_family: "f",
      falsification_conditions: ["it does not beat the comparator by 0.03"],
      rival_mechanisms: ["the comparator already explains it"],
      supporting_literature_edges: ["doi:10.1/x"],
    },
  });
  const better = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "lead");
  assert.equal(better.verdict, VERDICT.OK);
  assert.equal(better.detail.rival_mechanisms, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a completed runner that measured nothing is not counted as a result", () => {
  // Lanes can complete having executed a deferral. cycle-g-v91 had four of
  // them reporting completed with no number anywhere, which read as progress.
  const root = emptyCycle();
  const lane = path.join(root, "lanes", CYCLE, "followup-runner-01");
  fs.mkdirSync(lane, { recursive: true });
  fs.writeFileSync(
    path.join(lane, "result.json"),
    JSON.stringify({ blueprint_executions: [{ blueprint_id: "bp-deferred-bundle-gate-01" }] }),
    "utf8",
  );
  let experiments = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "experiments");
  assert.equal(experiments.detail.lanes_with_measured_output, 0);
  assert.equal(experiments.verdict, VERDICT.ATTENTION);
  assert.match(experiments.note, /completed runner is not a result/);

  fs.writeFileSync(
    path.join(lane, "result.json"),
    JSON.stringify({
      blueprint_executions: [{ blueprint_id: "bp_real_v2", metrics: { checks: { gain: 0.017 } } }],
    }),
    "utf8",
  );
  experiments = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "experiments");
  assert.equal(experiments.detail.lanes_with_measured_output, 1);
  assert.equal(experiments.detail.distinct_blueprints, 1);
  assert.equal(experiments.verdict, VERDICT.OK);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a metrics object from a run that measured nothing or timed out is not a measurement", () => {
  // cycle-g-v91, 2026-09-14: zero-measurement runs carry notes and a verdict,
  // timed-out runs carry observed_seconds and a remedy. Both have `metrics`.
  const root = emptyCycle();
  const write = (laneId, run) => {
    const lane = path.join(root, "lanes", CYCLE, laneId);
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, "result.json"), JSON.stringify({ blueprint_executions: [run] }), "utf8");
  };
  write("followup-runner-65", {
    blueprint_id: "BP-A", status: "completed", produced_evidence: false,
    metrics: { pass_fail: "inconclusive", notes: "zero runs performed" },
  });
  write("followup-runner-66", {
    blueprint_id: "BP-B", status: "timeout",
    metrics: { design_overrun: true, observed_seconds: 1494.3, partial_tables: 0 },
  });
  let experiments = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "experiments");
  assert.equal(experiments.detail.runner_lanes, 2);
  assert.equal(experiments.detail.lanes_with_measured_output, 0);
  assert.equal(experiments.verdict, VERDICT.ATTENTION);

  write("followup-runner-73", {
    blueprint_id: "BP-C", status: "completed", produced_evidence: true,
    metrics: { pass_fail: "pass", gain: 0.02 },
  });
  experiments = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "experiments");
  assert.equal(experiments.detail.lanes_with_measured_output, 1);
  assert.deepEqual(Object.keys(experiments.detail.per_blueprint), ["BP-C"]);
  assert.equal(experiments.verdict, VERDICT.OK);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an empty survey with stated gaps is the contract working, not a fault", () => {
  // The director refusing to pad open_problems with unattributed entries is
  // obedience. A report that called it a failure would teach the reader to
  // ignore the one signal that says the corpus is too thin.
  const root = emptyCycle();
  writeState(root, "research-trend-analysis", {
    open_problems: [],
    proposed_methods: [],
    unattributed_impressions: ["a hunch"],
    survey_coverage_gaps: ["no policy-compliant paper_id is available"],
  });
  const survey = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "survey");
  assert.equal(survey.verdict, VERDICT.ATTENTION);
  assert.match(survey.note, /the contract working, not a fault/);
  assert.equal(survey.detail.survey_coverage_gaps, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an implemented capability nobody probed is named", () => {
  // One line that would have made cycle-g-v91 obvious on day one.
  const root = emptyCycle();
  writeState(root, "instrument-inventory", {
    backends: ["python"],
    verified_instruments: ["python_standard_library_statistics"],
    implemented_but_not_probed: ["mitsuba"],
  });
  const capability = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "capability");
  assert.equal(capability.verdict, VERDICT.ATTENTION);
  assert.deepEqual(capability.detail.implemented_but_not_probed, ["mitsuba"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the shape a dashboard reads is stable", () => {
  const root = emptyCycle();
  const status = cycleStatus({ root, cycleId: CYCLE });
  for (const key of ["schema", "cycle_id", "generated_at", "root", "summary", "checks"]) {
    assert.ok(key in status, `${key} is missing from the report`);
  }
  for (const key of ["ok", "attention", "absent", "needs_attention"]) {
    assert.ok(key in status.summary, `summary.${key} is missing`);
  }
  // Ids are the dashboard's keys; renaming one silently moves a panel.
  assert.deepEqual(
    status.checks.map((item) => item.id),
    ["run", "retrieval", "corpus", "graph", "survey", "lead", "experiments", "gate", "capability", "delivery"],
  );
  assert.ok(JSON.parse(JSON.stringify(status)), "the report must survive a JSON round trip");
  fs.rmSync(root, { recursive: true, force: true });
});
