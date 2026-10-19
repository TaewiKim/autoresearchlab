"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluate,
  FLATLINE_WINDOW_MINUTES,
  FLATLINE_MIN_NEW_LANES,
} = require("../src/cli/progress_watchdog");

// cycle-g-v82 completed 285 lanes over 5.5 hours and produced ZERO gate rounds,
// and every watchdog pass printed `ok`. R2 exists precisely for that shape. It
// missed because the baseline was the oldest row INSIDE the 90-minute window, so
// its age was set by the sampling cadence: rows 9.31 minutes apart put the
// baseline at 83.9 minutes against a `>= FLATLINE_WINDOW_MINUTES - 1` test. The
// rule was written when this loop ran every 120s, where rows are ~2 minutes
// apart and the baseline is reliably 88-90 minutes old.
//
// The fixture below reproduces v82's recorded history exactly: 37 samples,
// 9.31-minute mean interval, lanes_completed 0 -> 285, gate_rounds flat at 0.

const V82 = {
  samples: 37,
  interval_min: 9.31,
  lanes_first: 0,
  lanes_last: 285,
  role_counts: {
    analyst: 8, author: 1, chronicle: 66, gatekeeper: 9,
    "lab-director": 99, "lab-runner": 7, scout: 127, illustrator: 1,
  },
};

function history({ samples, intervalMin, lanesFirst, lanesLast, rounds = 0, t0 = 1787529390241 }) {
  const rows = [];
  for (let i = 0; i < samples; i += 1) {
    const frac = samples === 1 ? 0 : i / (samples - 1);
    rows.push({
      epoch_ms: t0 + Math.round(i * intervalMin * 60000),
      lanes_completed: Math.round(lanesFirst + (lanesLast - lanesFirst) * frac),
      gate_rounds: typeof rounds === "function" ? rounds(frac) : rounds,
      gate_passed: false,
      best_technical_quality: 0,
      best_reproducibility: 0,
    });
  }
  return rows;
}

function snapshotFrom(rows, overrides = {}) {
  const last = rows[rows.length - 1];
  return {
    epoch_ms: last.epoch_ms,
    lanes_total: last.lanes_completed,
    lanes_completed: last.lanes_completed,
    gate_rounds: last.gate_rounds,
    gate_passed: false,
    best_technical_quality: 0,
    best_reproducibility: 0,
    best_by_rubric: {},
    rounds_since_improvement: 0,
    distinct_leads: 0,
    lead_changes: 0,
    rounds_per_lead: null,
    role_counts: V82.role_counts,
    ...overrides,
  };
}

function flatline(findings) {
  return findings.find((f) => f.signature === "activity_without_gate_progress") || null;
}

test("v82's own history halts on the flatline it actually was", () => {
  const rows = history({
    samples: V82.samples,
    intervalMin: V82.interval_min,
    lanesFirst: V82.lanes_first,
    lanesLast: V82.lanes_last,
  });
  // The exact miss: baseline age under the old rule was 83.9min, needing >= 89.
  const found = flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows }));
  assert.ok(found, "285 lanes and 0 gate rounds over 5.5 hours must halt");
  assert.equal(found.severity, "halt");
  assert.equal(found.evidence.gate_rounds_total, 0);
  assert.ok(
    found.evidence.window_minutes >= FLATLINE_WINDOW_MINUTES,
    `the baseline must be at least a full window old (got ${found.evidence.window_minutes})`,
  );
  assert.ok(found.evidence.lanes_completed_delta >= FLATLINE_MIN_NEW_LANES);
});

test("the verdict is the same at every sampling cadence", () => {
  // Same six hours, same 285 lanes, same zero rounds - only the interval moves.
  // A supervision rule that flips on how often it looks is not a rule.
  for (const intervalMin of [2, 5, 9.31, 15, 30]) {
    const samples = Math.floor((6 * 60) / intervalMin) + 1;
    const rows = history({ samples, intervalMin, lanesFirst: 0, lanesLast: 285 });
    const found = flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows }));
    assert.ok(found, `must halt at a ${intervalMin}min cadence`);
    assert.ok(
      found.evidence.window_minutes >= FLATLINE_WINDOW_MINUTES,
      `${intervalMin}min cadence looked back only ${found.evidence.window_minutes}min`,
    );
  }
});

test("a cycle producing gate rounds is left alone", () => {
  // cycle-g-v81's healthy shape: rounds accumulating alongside the lanes.
  const rows = history({
    samples: 40, intervalMin: 9.31, lanesFirst: 0, lanesLast: 300,
    rounds: (frac) => Math.round(frac * 73),
  });
  assert.equal(flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows })), null);
});

test("one round late in the window is enough to stay alive", () => {
  // The rule must key on the DELTA, not the total: a cycle that scored once at
  // the very end is moving, however slowly.
  const rows = history({ samples: 40, intervalMin: 9.31, lanesFirst: 0, lanesLast: 300 });
  rows[rows.length - 1].gate_rounds = 1;
  assert.equal(flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows })), null);
});

test("a young cycle is never judged", () => {
  // 60 minutes of history cannot answer a 90-minute question, and a booting
  // cycle legitimately has no gate round yet.
  const rows = history({ samples: 7, intervalMin: 9.31, lanesFirst: 0, lanesLast: 120 });
  assert.equal(flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows })), null);
});

test("a quiet cycle is not a flatlined one", () => {
  // Zero rounds AND almost no lanes completing is a different failure (a stalled
  // dispatcher, a dead quota) with a different diagnosis. R2 only speaks to
  // activity that produces nothing.
  const rows = history({ samples: 40, intervalMin: 9.31, lanesFirst: 40, lanesLast: 45 });
  assert.equal(flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows })), null);
});

// cycle-g-v84 halted at rounds_since_improvement=5/5 with novelty 38,
// technical_quality 35 and reproducibility 76 -- all climbed from 20/18/5 within
// the preceding hour. The stagnation counter replays the append-only ledger, so
// the five flat rounds were still the tail of the file after the halt was
// archived, and the next pass re-halted before the cycle could act on the fix.
// A halt that cannot be cleared by addressing its cause can only be cleared by
// destroying evidence.
const fsx = require("node:fs");
const osx = require("node:os");
const pathx = require("node:path");
const { takeSnapshot } = require("../src/cli/progress_watchdog");

// A flat round only counts toward the stall when it had something new to read
// (see tests/watchdog_new_input_rounds.test.js), so these stalls are built the
// way a real one is: a runner measures something between every pair of rounds,
// and the rounds still fail to beat the bar.
function ledgerRoot(rows, cycleId, clearedAtMs, evidenceAtMs = []) {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "wd-stall-"));
  fsx.mkdirSync(pathx.join(root, "state"), { recursive: true });
  fsx.mkdirSync(pathx.join(root, "lanes", cycleId), { recursive: true });
  fsx.writeFileSync(
    pathx.join(root, "state", `${cycleId}-hypothesis-progress.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  evidenceAtMs.forEach((finishedAtMs, index) => {
    const lane = pathx.join(root, "lanes", cycleId, `followup-runner-${index + 1}`);
    fsx.mkdirSync(lane, { recursive: true });
    fsx.writeFileSync(
      pathx.join(lane, "result.json"),
      JSON.stringify({ blueprint_executions: [{ status: "completed", produced_evidence: true, metrics: { gain: 1 } }] }),
    );
    const finalStatus = pathx.join(lane, "final-status.json");
    fsx.writeFileSync(finalStatus, JSON.stringify({ status: "completed" }));
    fsx.utimesSync(finalStatus, finishedAtMs / 1000, finishedAtMs / 1000);
  });
  if (clearedAtMs) {
    const archived = pathx.join(root, "state", `${cycleId}-watchdog-halt.json.cleared-with-a-fix`);
    fsx.writeFileSync(archived, "{}");
    fsx.utimesSync(archived, clearedAtMs / 1000, clearedAtMs / 1000);
  }
  return root;
}

// One measured result finishing half a minute before each round from the second on.
function evidenceBefore(rows) {
  return rows.slice(1).map((row) => Date.parse(row.ts) - 30000);
}

function decision(tsMs, rubric) {
  return {
    memory_type: "decision",
    memory_id: "hyp:aaaa",
    ts: new Date(tsMs).toISOString(),
    content: { rubric: rubric.map(([name, score]) => ({ name, score, applicable: true })) },
  };
}

test("a halt clear restarts the stall but keeps the bar", () => {
  const t0 = 1787000000000;
  const climbed = [
    decision(t0 + 0, [["novelty", 20], ["technical_quality", 18]]),
    decision(t0 + 60000, [["novelty", 38], ["technical_quality", 35]]),
  ];
  // Five rounds that beat nothing: the stall that halted v84.
  const flat = [2, 3, 4, 5, 6].map((n) =>
    decision(t0 + n * 60000, [["novelty", 30], ["technical_quality", 25]]),
  );
  const rows = [...climbed, ...flat];
  const cycleId = "cyc";

  const beforeClear = takeSnapshot({ root: ledgerRoot(rows, cycleId, 0, evidenceBefore(rows)), cycleId });
  assert.equal(beforeClear.rounds_since_improvement, 5, "the halt was correct when it fired");

  // Cleared AFTER the last flat round, i.e. the operator saw the stall and acted.
  const afterClear = takeSnapshot({
    root: ledgerRoot(rows, cycleId, t0 + 7 * 60000, evidenceBefore(rows)),
    cycleId,
    haltClearedAt: t0 + 7 * 60000,
  });
  assert.equal(afterClear.rounds_since_improvement, 0, "the cleared stall must not re-fire");
  assert.deepEqual(
    afterClear.best_by_rubric,
    { novelty: 38, technical_quality: 35 },
    "the high-water marks are real measurements and stay the bar to beat",
  );
});

test("a stall accumulated AFTER the clear still halts", () => {
  // The rule has to keep working, or clearing a halt would disable it.
  const t0 = 1787000000000;
  const clearedAt = t0 + 60000;
  const rows = [
    decision(t0, [["novelty", 20]]),
    decision(t0 + 30000, [["novelty", 38]]),
    ...[2, 3, 4, 5, 6].map((n) => decision(clearedAt + n * 60000, [["novelty", 30]])),
  ];
  const snap = takeSnapshot({
    root: ledgerRoot(rows, "cyc", clearedAt, evidenceBefore(rows)),
    cycleId: "cyc",
    haltClearedAt: clearedAt,
  });
  assert.equal(snap.rounds_since_improvement, 5, "post-clear rounds still accumulate");
  assert.equal(snap.best_by_rubric.novelty, 38);
});
