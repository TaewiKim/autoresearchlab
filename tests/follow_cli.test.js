"use strict";

// The research process as text: `researchlab follow` prints what a cycle
// writes, and `researchlab tell` reaches its LabDirector, with no web UI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const { followCycle } = require("../src/cli/follow");

const CYCLE = "follow-cycle";

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-follow-"));
  const root = path.join(cwd, ".research-lab");
  const lanes = path.join(root, "lanes", CYCLE);
  const state = (laneStatuses, status = "running") => write(path.join(root, "state", `${CYCLE}-cycle-run-state.json`), {
    status,
    lane_counts: { total: laneStatuses.length, completed: laneStatuses.filter((lane) => lane.status === "completed").length },
    lane_statuses: laneStatuses,
  });
  return { cwd, root, lanes, state };
}

function capture() {
  const lines = [];
  const print = (tag, head, rest = []) => {
    lines.push(`[${tag}] ${head}`);
    for (const line of rest.filter(Boolean)) lines.push(`    ${line}`);
  };
  return { lines, print };
}

test("follow prints what happened: lanes, a runner's estimates, the lead, the gate, notices, maintainer runs", async () => {
  const fx = fixture();
  fx.state([{ lane_id: "followup-runner-7", role: "lab-runner", status: "pending" }]);
  write(path.join(fx.lanes, "followup-runner-7", "role-plan.json"), { action_type: "methods_followup", followup_description: "execute the analyst handoff" });
  const gateHistory = path.join(fx.root, "state", `${CYCLE}-gate-review-history.jsonl`);
  const notices = path.join(fx.root, "events", `${CYCLE}-harness-notices.jsonl`);
  write(gateHistory, "");
  write(notices, "");
  const { lines, print } = capture();
  let stop = false;
  const following = followCycle({ root: fx.root, cycleId: CYCLE, intervalSeconds: 0.2, print, shouldStop: () => stop });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The runner starts, then finishes with a primary contrast table.
  write(path.join(fx.lanes, "followup-runner-7", "run-state.json"), { status: "running" });
  write(path.join(fx.lanes, "followup-runner-7", "lane-contract.json"), { role: "lab-runner" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const table = path.join(fx.lanes, "followup-runner-7", "primary_contrasts.csv");
  write(table, "contrast_id,estimate,simultaneous_lower,simultaneous_upper\ndp_minus_retrieval,0.0050223,-0.0256,0.0357\n");
  write(path.join(fx.lanes, "followup-runner-7", "result.json"), {
    status: "completed",
    validation_summary: { blueprints_total: 1, blueprints_passed: 1 },
    analysis_contract_validation: { status: "verified", evidence_role: "primary" },
    blueprint_executions: [{ status: "completed", tables: [{ name: "primary_contrasts.csv", path: table }] }],
  });
  write(path.join(fx.lanes, "followup-runner-7", "final-status.json"), { status: "completed" });
  fx.state([{ lane_id: "followup-runner-7", role: "lab-runner", status: "completed" }]);
  write(path.join(fx.root, "state", `${CYCLE}-lab-director-hypothesis.json`), {
    selected_at_epoch_ms: 1,
    selected_hypothesis: { primary_family: "corrected_retrieval", statement: "Difference-aware retrieval recovers the deficit." },
    lab_director_decision: { lane_id: "followup-lab-director-3", requery_decision: "replace" },
  });
  fs.appendFileSync(gateHistory, `${JSON.stringify({ ts: "2026-10-18T14:00:00Z", score: 78, pass: false, blockers: 2, rubric: { novelty: 78, impact: 64 } })}\n`);
  fs.appendFileSync(notices, `${JSON.stringify({ ts: "2026-10-18T14:01:00Z", event_type: "contract_already_measured", payload: { effect: "no lab-runner is created" } })}\n`);
  write(path.join(fx.root, "runtime", `${CYCLE}-maintainer.json`), { runs: [{ outcome: "accepted", verdict: "harness_bug_fixed", commit_title: "Fix the thing", finished_at: "2026-10-18T14:02:00Z" }] });
  await new Promise((resolve) => setTimeout(resolve, 400));
  stop = true;
  await following;

  const text = lines.join("\n");
  assert.match(text, /\[start\] lab-runner followup-runner-7\n    methods_followup: execute the analyst handoff/);
  assert.match(text, /\[done\] lab-runner followup-runner-7\n    1\/1 blueprints passed · contract verified\n      dp_minus_retrieval = 0\.005022 \[-0\.0256, 0\.0357\]/);
  assert.match(text, /\[lead\] lead changed \(corrected_retrieval\)\n    Difference-aware retrieval recovers the deficit\./);
  assert.match(text, /\[gate\] gate review\n    score 78 · novelty=78 impact=64 · 2 blocker\(s\)/);
  assert.match(text, /\[note\] contract_already_measured\n    no lab-runner is created/);
  assert.match(text, /\[maint\] harness_bug_fixed: Fix the thing/);
  // Each thing once.
  assert.equal(lines.filter((line) => line.startsWith("[done]")).length, 1);
});

test("follow --once shows the cycle, its lead and the last lanes, then exits", () => {
  const fx = fixture();
  fx.state([
    { lane_id: "followup-lab-director-9", role: "lab-director", status: "completed" },
    { lane_id: "followup-gatekeeper-4", role: "gatekeeper", status: "completed" },
  ]);
  write(path.join(fx.lanes, "followup-lab-director-9", "final-status.json"), { status: "completed" });
  write(path.join(fx.lanes, "followup-lab-director-9", "result.json"), {
    extracted_json: { requery_decision: "uphold", summary: "Keep the lead.", rationale: "The runner confirmed it.", next_actions: [{ preferred_role: "gatekeeper", description: "Review novelty." }] },
  });
  write(path.join(fx.lanes, "followup-gatekeeper-4", "final-status.json"), { status: "completed" });
  write(path.join(fx.lanes, "followup-gatekeeper-4", "result.json"), {
    extracted_json: { verdict: "reject", rubric: [{ name: "impact", score: 29 }], major_objections: ["Weak comparator."] },
  });
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "cli", "index.js"), "follow", "--cycle-id", CYCLE, "--history", "5", "--once"], { cwd: fx.cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\[cycle\] follow-cycle: running/);
  assert.match(run.stdout, /\[done \] lab-director followup-lab-director-9\n +decision uphold: Keep the lead\.\n +why: The runner confirmed it\.\n +next \(gatekeeper\): Review novelty\./);
  assert.match(run.stdout, /\[done \] gatekeeper followup-gatekeeper-4\n +verdict reject · impact=29\n +objection: Weak comparator\./);
});

test("tell puts a researcher's message on the LabDirector's bus", () => {
  const fx = fixture();
  fx.state([]);
  const cli = path.join(__dirname, "..", "src", "cli", "index.js");
  const run = spawnSync(process.execPath, [cli, "tell", "--cycle-id", CYCLE, "--message", "Compare against a competent retrieval baseline."], { cwd: fx.cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^queued msg-\S+ for the LabDirector of follow-cycle/);
  const raised = path.join(fx.root, "messages", CYCLE);
  const found = fs.readdirSync(raised, { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl"))
    .some((name) => fs.readFileSync(path.join(raised, name), "utf8").includes("Compare against a competent retrieval baseline."));
  assert.ok(found, "the message is on the bus");
  // A cycle that does not exist is said, not silently created.
  const missing = spawnSync(process.execPath, [cli, "tell", "--cycle-id", "no-such-cycle", "--message", "hi"], { cwd: fx.cwd, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no cycle no-such-cycle/);
});

test("a follower started for a parent process stops when the parent is gone", () => {
  const fx = fixture();
  fx.state([]);
  const parent = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const goneParent = Number(parent.stdout);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "cli", "index.js"), "follow", "--cycle-id", CYCLE, "--interval", "0.2", "--parent-pid", String(goneParent)], { cwd: fx.cwd, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 8000, "it stopped on its own");
});

test("the owner checkpoint is answered from the CLI, and follow says when it is waiting", async () => {
  const fx = fixture();
  fx.state([]);
  const state = path.join(fx.root, "state");
  const cliPath = path.join(__dirname, "..", "src", "cli", "index.js");
  const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: fx.cwd, encoding: "utf8" });
  // Before the checkpoint there is nothing to choose.
  assert.match(run(["candidates", "--cycle-id", CYCLE]).stdout, /No candidates yet/);
  write(path.join(state, `${CYCLE}-owner-candidates.json`), { candidates: [{ candidate_id: "Coverage_Controlled", hypothesis: "Coverage explains the gap." }, { candidate_id: "loss_vs_refinement" }] });
  write(path.join(state, `${CYCLE}-owner-candidates.md`), "# Owner checkpoint\n\n## 1. `Coverage_Controlled` -- Coverage explains the gap.\n");
  assert.match(run(["candidates", "--cycle-id", CYCLE]).stdout, /Coverage_Controlled[\s\S]*researchlab select --cycle-id follow-cycle --candidate/);
  const refused = run(["select", "--cycle-id", CYCLE, "--candidate", "nope"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not one of the candidates: Coverage_Controlled, loss_vs_refinement/);
  const chosen = run(["select", "--cycle-id", CYCLE, "--candidate", "coverage_controlled", "--note", "closest to the owner's question"]);
  assert.equal(chosen.status, 0, chosen.stderr);
  const selection = JSON.parse(fs.readFileSync(path.join(state, `${CYCLE}-owner-selection.json`), "utf8"));
  assert.deepEqual([selection.candidate_id, selection.note], ["Coverage_Controlled", "closest to the owner's question"]);

  const { lines, print } = capture();
  let stop = false;
  const following = followCycle({ root: fx.root, cycleId: CYCLE, intervalSeconds: 0.2, print, shouldStop: () => stop });
  write(path.join(state, `${CYCLE}-labdirector-pause.json`), { status: "blocked", block_type: "owner_selection" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  stop = true;
  await following;
  assert.match(lines.join("\n"), /\[wait\] the cycle is waiting for you to choose the problem it pursues\n    researchlab candidates --cycle-id follow-cycle/);
});
