// R5: the supervisor crash-restart loop.
//
// cycle-g-v85 sat in one for 2h13m while the watchdog printed `ok` every five
// minutes. One torn-write lane result.json (64 bad bytes in 2.1MB) made the
// strict-UTF-8 read in the harness abort the entire run; the launch wrapper
// relaunched it; it aborted again -- 106 times. None of R1-R4 could fire: no
// lanes completed (so no requery storm and no activity-without-progress), the
// budget was at 5%, and gate rounds were frozen along with everything else. A
// cycle that cannot START looks exactly like a quiet one from the outside.
//
// These run evaluate() rather than inspecting source, because the first cut of
// R5 reached for R2's block-scoped `baseline` -- syntactically fine, a
// ReferenceError the moment it fired.

const test = require("node:test");
const assert = require("node:assert");

const { evaluate, FLATLINE_WINDOW_MINUTES, WARMUP_MINUTES } = require("../src/cli/progress_watchdog.js");

const MINUTE = 60000;
const NOW = 1_756_000_000_000;

function row(minutesAgo, { lanes = 40, rounds = 12, aborts = 0 } = {}) {
  return {
    epoch_ms: NOW - minutesAgo * MINUTE,
    lanes_completed: lanes,
    gate_rounds: rounds,
    abort_count: aborts,
  };
}

function snapshot(overrides = {}) {
  return {
    ts: new Date(NOW).toISOString(),
    epoch_ms: NOW,
    lanes_total: 50,
    lanes_completed: 40,
    gate_rounds: 12,
    gate_passed: false,
    abort_count: 0,
    latest_abort: null,
    best_technical_quality: 44,
    best_reproducibility: 72,
    best_by_rubric: { technical_quality: 44 },
    rounds_since_improvement: 0,
    distinct_leads: 2,
    lead_changes: 1,
    rounds_per_lead: 6,
    role_counts: { "lab-director": 8, scout: 6, gatekeeper: 10, "lab-runner": 12 },
    ...overrides,
  };
}

// History old enough to clear the warmup and give the window a baseline.
const HISTORY = [
  row(FLATLINE_WINDOW_MINUTES + 30, { aborts: 0 }),
  row(FLATLINE_WINDOW_MINUTES + 5, { aborts: 0 }),
  row(10, { aborts: 0 }),
];

function signatures(findings) {
  return findings.map((f) => f.signature);
}

test("aborts climbing with no lane progress halts the cycle", () => {
  const findings = evaluate({
    snapshot: snapshot({
      abort_count: 106,
      latest_abort:
        "run-research aborted: Error: [researchlab-harness] failed to read " +
        ".../followup-lab-director-03/result.json at lane_counts.rs:283: " +
        "stream did not contain valid UTF-8",
    }),
    history: HISTORY,
  });
  const found = findings.find((f) => f.signature === "crash_restart_loop");
  assert.ok(found, "expected crash_restart_loop, got: " + signatures(findings).join(", "));
  assert.strictEqual(found.severity, "halt");
  assert.strictEqual(found.evidence.new_aborts, 106);
  // The operator has to know WHICH file to repair before clearing the halt.
  assert.match(found.evidence.latest_abort, /followup-lab-director-03/);
  assert.match(found.recommended_action, /BEFORE clearing the halt/);
});

test("aborts alongside real lane progress do not halt", () => {
  // A cycle that aborted a few times but is still completing work is recovering,
  // not looping. Halting it would cost more than it saves.
  const findings = evaluate({
    snapshot: snapshot({ abort_count: 9, lanes_completed: 61 }),
    history: HISTORY,
  });
  assert.ok(!signatures(findings).includes("crash_restart_loop"), signatures(findings).join(", "));
});

test("a single abort is a blip, not a loop", () => {
  const findings = evaluate({
    snapshot: snapshot({ abort_count: 1 }),
    history: HISTORY,
  });
  assert.ok(!signatures(findings).includes("crash_restart_loop"));
});

test("a healthy cycle stays clean", () => {
  const findings = evaluate({ snapshot: snapshot(), history: HISTORY });
  assert.ok(!signatures(findings).includes("crash_restart_loop"));
});

test("no baseline yet means no verdict", () => {
  // Warmed up by age but with nothing a full window old to compare against:
  // reporting a loop from a single reading would be a guess.
  const findings = evaluate({
    snapshot: snapshot({ abort_count: 106 }),
    history: [row(WARMUP_MINUTES + 1, { aborts: 0 })],
  });
  assert.ok(!signatures(findings).includes("crash_restart_loop"));
});

test("a cold cycle is not judged", () => {
  const findings = evaluate({
    snapshot: snapshot({ abort_count: 106 }),
    history: [row(2, { aborts: 0 })],
  });
  assert.ok(!signatures(findings).includes("crash_restart_loop"));
});
