"use strict";

// A gate round with nothing new to read is not a round that failed to improve.
//
// MEASURED ON cycle-g-v91, 2026-09-14. Eight gatekeeper lanes queued at 08:59 ran
// at 10:11-10:24 against a lead chosen at 09:43 whose newest runner evidence was
// from 09:37. Round 48 re-read exactly what round 47 had read, scored nothing
// higher, and was the fifth flat round that halted the cycle.
//
// These drive takeSnapshot over a real cycle directory, because the rule depends
// on when runner lanes finished relative to the rounds, which only the files say.
//
// The first scored round sets every rubric's bar and already counts as a round
// without improvement in the existing counter; the expected values below include
// it rather than pretending it away.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { takeSnapshot } = require("../src/cli/progress_watchdog.js");

const CYCLE = "cg-new-input";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-14T09:00:00.000Z");

function cycleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-new-input-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "lanes", CYCLE), { recursive: true });
  return root;
}

function round(lead, minutes, novelty) {
  return {
    memory_id: lead,
    memory_type: "decision",
    task_id: `round-${minutes}`,
    ts: new Date(T0 + minutes * MINUTE).toISOString(),
    content: { statement: lead, rubric: [{ name: "novelty", score: novelty, applicable: true }] },
  };
}

function writeRounds(root, rows) {
  fs.writeFileSync(
    path.join(root, "state", `${CYCLE}-hypothesis-progress.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

function runner(root, laneId, finishedMinutes, execution) {
  const dir = path.join(root, "lanes", CYCLE, laneId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ blueprint_executions: [execution] }));
  const finalStatus = path.join(dir, "final-status.json");
  fs.writeFileSync(finalStatus, JSON.stringify({ status: "completed" }));
  const at = new Date(T0 + finishedMinutes * MINUTE);
  fs.utimesSync(finalStatus, at, at);
}

test("a flat re-review of the same lead with no new evidence does not advance the stall", () => {
  const root = cycleRoot();
  writeRounds(root, [
    round("lead-a", 0, 50), // sets the bar (counted, as before)
    round("lead-a", 10, 50), // flat, but a runner finished before it: it failed to improve
    round("lead-a", 20, 50), // flat, and nothing new since the previous round: nothing to improve on
    round("lead-b", 30, 50), // flat on a new lead: it failed to improve
  ]);
  runner(root, "followup-runner-01", 5, { status: "completed", produced_evidence: true, metrics: { gain: 0.1 } });

  const snapshot = takeSnapshot({ root, cycleId: CYCLE });
  assert.equal(snapshot.gate_rounds, 4, "every round is still a round");
  assert.equal(snapshot.rounds_since_improvement, 3);
  assert.equal(snapshot.rounds_without_new_input, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a runner that measured nothing is not new input", () => {
  const root = cycleRoot();
  writeRounds(root, [round("lead-a", 0, 50), round("lead-a", 10, 50)]);
  runner(root, "followup-runner-01", 5, { status: "completed", produced_evidence: false, metrics: { notes: "x" } });

  const snapshot = takeSnapshot({ root, cycleId: CYCLE });
  assert.equal(snapshot.rounds_since_improvement, 1, "only the bar-setting round");
  assert.equal(snapshot.rounds_without_new_input, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a result written before the evidence flag existed still counts when it finished with metrics", () => {
  const root = cycleRoot();
  writeRounds(root, [round("lead-a", 0, 50), round("lead-a", 10, 50)]);
  runner(root, "followup-runner-01", 5, { status: "completed", metrics: { gain: 0.1 } });

  const snapshot = takeSnapshot({ root, cycleId: CYCLE });
  assert.equal(snapshot.rounds_since_improvement, 2);
  assert.equal(snapshot.rounds_without_new_input, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an improving round resets the stall whatever it had to read", () => {
  const root = cycleRoot();
  writeRounds(root, [round("lead-a", 0, 50), round("lead-a", 10, 50), round("lead-a", 20, 55)]);

  const snapshot = takeSnapshot({ root, cycleId: CYCLE });
  assert.equal(snapshot.rounds_since_improvement, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
