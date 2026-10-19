// The requery-storm rule measured cycle AGE, not a storm.
//
// R1 halted when lab-director lanes passed 100 and outnumbered scouts 2:1.
// Scouts run at the opening and then stop; directors are spent about one per gate
// round for as long as the cycle lives. So every long cycle trips it eventually,
// and cycle-g-v89 did -- 113 directors, 5 scouts, 123 gate rounds -- halting
// twice on resume with a passing paper gate and a complete submission package.
//
// What separated cycle-g-v58 was never the ratio. Its directors climbed while the
// gate never moved: 427 requery lanes against 0 rounds. Dividing by gate rounds
// says that directly, and unlike a windowed baseline it still fires on the first
// pass of a fresh cycle, which is when a storm burns the most budget.
//
// These run evaluate() against both real snapshots rather than asserting on
// source text.

const test = require("node:test");
const assert = require("node:assert");

const { evaluate, FLATLINE_WINDOW_MINUTES } = require("../src/cli/progress_watchdog.js");

const MINUTE = 60000;
const NOW = 1_756_000_000_000;
const STORM = "requery_storm";

function row(minutesAgo, { lanes = 400, rounds = 100, aborts = 0 } = {}) {
  return { epoch_ms: NOW - minutesAgo * MINUTE, lanes_completed: lanes, gate_rounds: rounds, abort_count: aborts };
}

// Old enough to clear warmup, and moving enough that the flatline and crash-loop
// signatures stay quiet so the assertion is about R1 alone.
const HISTORY = [
  row(FLATLINE_WINDOW_MINUTES + 30, { lanes: 300, rounds: 80 }),
  row(FLATLINE_WINDOW_MINUTES + 5, { lanes: 380, rounds: 95 }),
  row(10, { lanes: 560, rounds: 118 }),
];

function snapshot(overrides = {}) {
  return {
    epoch_ms: NOW,
    lanes_completed: 591,
    gate_rounds: 123,
    abort_count: 0,
    gate_passed: true,
    rounds_since_improvement: 0,
    distinct_leads: 6,
    lead_changes: 5,
    rounds_per_lead: 20.5,
    best_technical_quality: 72,
    best_reproducibility: 66,
    best_by_rubric: {},
    role_counts: { "lab-director": 113, scout: 5, gatekeeper: 228 },
    ...overrides,
  };
}

function signatures(findings) {
  return findings.map((item) => item.signature);
}

test("a long healthy cycle is not a storm: one director per gate round is the work", () => {
  // cycle-g-v89's own numbers, which halted it twice on resume.
  const findings = evaluate({ snapshot: snapshot(), history: HISTORY });
  assert.equal(
    signatures(findings).includes(STORM),
    false,
    `0.92 directors per round is not a loop: ${JSON.stringify(signatures(findings))}`,
  );
});

test("directors climbing while the gate does not move is still a storm", () => {
  // cycle-g-v58's shape: requery lanes exploding, gate rounds barely moving.
  const findings = evaluate({
    snapshot: snapshot({ role_counts: { "lab-director": 427, scout: 4, gatekeeper: 12 }, gate_rounds: 3 }),
    history: HISTORY,
  });
  assert.ok(signatures(findings).includes(STORM), JSON.stringify(signatures(findings)));
  const storm = findings.find((item) => item.signature === STORM);
  assert.equal(storm.evidence.directors_per_gate_round, 142.33);
  assert.equal(storm.evidence.gate_rounds, 3);
});

test("a storm is caught on a cycle with no gate rounds at all, not one window later", () => {
  // The reason this stayed rate-based rather than becoming a windowed baseline:
  // a fresh cycle that storms has no history to compare against, and that is
  // exactly when the spend is worth stopping.
  const findings = evaluate({
    snapshot: snapshot({ role_counts: { "lab-director": 150, scout: 2, gatekeeper: 0 }, gate_rounds: 0 }),
    history: HISTORY,
  });
  assert.ok(signatures(findings).includes(STORM), JSON.stringify(signatures(findings)));
});

test("the scout ratio still guards the case it was written for", () => {
  // Directors per round above the ceiling, but scouts keeping pace: this is a
  // cycle acquiring data, not one re-asking the same question.
  const findings = evaluate({
    snapshot: snapshot({ role_counts: { "lab-director": 120, scout: 90, gatekeeper: 10 }, gate_rounds: 2 }),
    history: HISTORY,
  });
  assert.equal(signatures(findings).includes(STORM), false, JSON.stringify(signatures(findings)));
});
