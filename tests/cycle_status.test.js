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
    ["run", "retrieval", "corpus", "graph", "survey", "lead", "experiments", "gate", "capability", "delivery", "tokens", "clues"],
  );
  assert.ok(JSON.parse(JSON.stringify(status)), "the report must survive a JSON round trip");
  fs.rmSync(root, { recursive: true, force: true });
});

test("without a watchdog, the gate's rounds are read from the gate's own history", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-19: 1,763 gate rounds on
  // disk, no watchdog running, and the report said the gate had not been seen.
  const root = emptyCycle();
  const rows = [
    { ts: "2026-10-19T10:00:00Z", kind: "gate-review", score: 40, pass: false, subject: "lead a", rubric: { novelty: 30, technical_quality: 50 } },
    { ts: "2026-10-19T11:00:00Z", kind: "gate-review", score: 43, pass: false, subject: "lead b", rubric: { novelty: 32, technical_quality: 38 } },
    { ts: "2026-10-19T11:30:00Z", kind: "something-else" },
  ];
  fs.writeFileSync(path.join(root, "state", `${CYCLE}-gate-review-history.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{torn`, "utf8");
  const gate = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "gate");
  assert.equal(gate.verdict, VERDICT.OK);
  assert.equal(gate.detail.gate_rounds, 2);
  assert.deepEqual(gate.detail.best_by_rubric, { novelty: 32, technical_quality: 50 });
  assert.equal(gate.detail.distinct_leads, 2);
  assert.equal(gate.detail.latest_score, 43);
  fs.rmSync(root, { recursive: true, force: true });
});

test("token usage is read from the lanes' own usage events, current whenever asked", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-26: the budget file was
  // refreshed only by the maintainer's pass, two hours old while lanes spent,
  // and nothing displayed tokens at all.
  const root = emptyCycle();
  const lane = (id, usage) => {
    const dir = path.join(root, "lanes", CYCLE, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stdout.log"), `${JSON.stringify({ type: "turn.completed", usage })}
`);
    fs.writeFileSync(path.join(dir, "final-status.json"), JSON.stringify({ completed_at: new Date().toISOString() }));
  };
  lane("followup-scout-01", { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 });
  lane("followup-scout-02", { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 500 });
  // Totals sampled earlier: 2 hours ago 100, 30 minutes ago 1000.
  const sample = (minutesAgo, counted) => ({ ts: new Date(Date.now() - minutesAgo * 60000).toISOString(), counted_tokens: counted });
  fs.writeFileSync(path.join(root, "state", `${CYCLE}-budget.json`), JSON.stringify({ history: [sample(120, 100), sample(30, 1000)] }));
  const tokens = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "tokens");
  assert.equal(tokens.verdict, VERDICT.OK);
  // counted = (input - cached) + output
  assert.equal(tokens.detail.counted_tokens, (1000 - 400 + 100) + (5000 - 4000 + 500));
  assert.equal(tokens.detail.turns, 2);
  // The window is a difference of two sampled totals, not lanes placed by when they ended.
  // The sample nearest an hour ago is the 30-minute one, so the window is 30 minutes, and says so.
  assert.equal(tokens.detail.counted_last_hour.tokens, 2200 - 1000);
  assert.ok(Math.abs(tokens.detail.counted_last_hour.window_seconds - 1800) < 5);
  // The history does not reach 24 hours back: the oldest sample stands in, and says so.
  assert.equal(tokens.detail.counted_last_24h.tokens, 2200 - 100);
  assert.ok(Math.abs(tokens.detail.counted_last_24h.window_seconds - 7200) < 5);
  // A new turn appended later is picked up on the next ask, without a maintainer pass.
  fs.appendFileSync(path.join(root, "lanes", CYCLE, "followup-scout-02", "stdout.log"),
    `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 50 } })}
`);
  const again = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "tokens");
  assert.equal(again.detail.turns, 3);
  assert.equal(again.detail.counted_tokens, 700 + 1500 + 350);
  assert.equal(again.detail.counted_last_hour.tokens, 2550 - 1000);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a cycle with no usage events reports tokens as not-yet, and does not throw", () => {
  const root = emptyCycle();
  const tokens = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "tokens");
  assert.equal(tokens.verdict, VERDICT.ABSENT);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a gate round with rubrics nobody reviewed yet is marked partial and does not set 'best'", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-26: 'score 85, pass false' was
  // one impact-focused gatekeeper's five numbers; the other four rubrics had no
  // reviewer of their own, so the round could not pass, and nothing said so.
  const root = emptyCycle();
  const rows = [
    { ts: "2026-10-26T10:00:00Z", kind: "gate-review", score: 40, pass: false, subject: "lead c", rubric: { novelty: 60, technical_quality: 20, reproducibility: 10 } },
    { ts: "2026-10-26T18:00:00Z", kind: "gate-review", score: 50, pass: false, subject: "lead a", unreviewed_rubrics: [], mode: "reject", rubric: { novelty: 52, technical_quality: 34, reproducibility: 42 } },
    { ts: "2026-10-26T18:41:00Z", kind: "gate-review", score: 85, pass: false, subject: "lead b", unreviewed_rubrics: ["clarity", "novelty", "reproducibility", "technical_quality"], mode: "challenge", rubric: { novelty: 84, technical_quality: 89, reproducibility: 88 } },
  ];
  fs.writeFileSync(path.join(root, "state", `${CYCLE}-gate-review-history.jsonl`), rows.map((row) => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");
  const gate = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "gate");
  assert.equal(gate.detail.rounds_whole, 1);
  assert.equal(gate.detail.rounds_partial, 1);
  assert.equal(gate.detail.rounds_unrecorded, 1);
  assert.deepEqual(gate.detail.latest_unreviewed, ["clarity", "novelty", "reproducibility", "technical_quality"]);
  // The partial round's 84/89/88 is not 'best': only the whole round counts.
  assert.deepEqual(gate.detail.best_by_rubric, { novelty: 52, technical_quality: 34, reproducibility: 42 });
  assert.equal(gate.detail.best_basis, "whole rounds");
  fs.rmSync(root, { recursive: true, force: true });
});
