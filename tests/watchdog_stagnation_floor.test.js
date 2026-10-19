// A plateau needs something to plateau from.
//
// cycle-g-v88 launched at 09:00 on 2026-08-29 and halted at 12:24 with
// gate_rounds=5 and rounds_since_improvement=5/5. Round 1 sets every rubric's
// bar, rounds 2-5 fail to beat it, the counter reaches the threshold, and a
// cycle that has only STARTED is declared stagnant.
//
// It was the cleanest cycle this project has produced -- 8 runner results, 0
// degraded, 0 seed deaths, 0 aborts -- and it died having spent 3.7% of its
// budget with roughly 103 rounds of headroom. v87, for scale, climbed novelty 42
// at round 1 to 64 at round 21.
//
// The two earlier corrections to this signature (v81's weakest rubric jumping
// 4 -> 35 after five flat rounds; v84 halting right after 20/18/5 -> 38/35/76)
// both loosened the RULE. Neither noticed it also needs a floor on how young a
// cycle it may judge.
//
// These run evaluate() against v88's real halt snapshot rather than asserting on
// source text: the last three defects I fixed in this project were all "the value
// was right and never arrived", and a source-text assertion cannot tell those
// apart.

const test = require("node:test");
const assert = require("node:assert");

const { evaluate, FLATLINE_WINDOW_MINUTES } = require("../src/cli/progress_watchdog.js");

const MINUTE = 60000;
const NOW = 1_756_000_000_000;
const STAGNATION = "score_stagnation_without_improvement";

function row(minutesAgo, { lanes = 40, rounds = 12, aborts = 0 } = {}) {
  return {
    epoch_ms: NOW - minutesAgo * MINUTE,
    lanes_completed: lanes,
    gate_rounds: rounds,
    abort_count: aborts,
  };
}

// Old enough to clear warmup and give the flatline window a baseline, and moving
// enough that no OTHER signature fires and muddies the assertion.
const HISTORY = [
  row(FLATLINE_WINDOW_MINUTES + 30, { lanes: 10, rounds: 1 }),
  row(FLATLINE_WINDOW_MINUTES + 5, { lanes: 25, rounds: 3 }),
  row(10, { lanes: 37, rounds: 4 }),
];

function snapshot(overrides = {}) {
  return {
    ts: new Date(NOW).toISOString(),
    epoch_ms: NOW,
    lanes_total: 66,
    lanes_completed: 42,
    gate_rounds: 5,
    gate_passed: false,
    abort_count: 0,
    latest_abort: null,
    best_technical_quality: 28,
    best_reproducibility: 2,
    best_by_rubric: { clarity: 3, impact: 3, novelty: 24, reproducibility: 2, technical_quality: 28 },
    rounds_since_improvement: 5,
    distinct_leads: 4,
    lead_changes: 3,
    rounds_per_lead: 1.25,
    role_counts: { "lab-director": 6, scout: 12, gatekeeper: 8, "lab-runner": 9 },
    ...overrides,
  };
}

function signatures(findings) {
  return findings.map((f) => f.signature);
}

test("v88's actual halt snapshot no longer halts the cycle", () => {
  // Every number here is from cycle-g-v88-20260829-watchdog-halt.json.
  const findings = evaluate({ snapshot: snapshot(), history: HISTORY });
  assert.ok(
    !signatures(findings).includes(STAGNATION),
    `five rounds is a beginning, not a plateau; got ${JSON.stringify(signatures(findings))}`,
  );
});

test("a cycle that has genuinely plateaued still halts", () => {
  // The signature's whole purpose. Same flat counter, but the cycle has had the
  // rounds to show it means something.
  const findings = evaluate({
    snapshot: snapshot({ gate_rounds: 12, rounds_since_improvement: 5 }),
    history: HISTORY,
  });
  assert.ok(
    signatures(findings).includes(STAGNATION),
    `a real plateau must still be caught; got ${JSON.stringify(signatures(findings))}`,
  );
});

test("the floor is exactly two stagnation windows", () => {
  // One round below the floor and the signature must hold its tongue; at the
  // floor it must speak. An off-by-one here either kills fresh cycles or lets a
  // stuck one burn the budget.
  const below = evaluate({
    snapshot: snapshot({ gate_rounds: 9, rounds_since_improvement: 5 }),
    history: HISTORY,
  });
  assert.ok(!signatures(below).includes(STAGNATION), "9 rounds is below the floor");

  const at = evaluate({
    snapshot: snapshot({ gate_rounds: 10, rounds_since_improvement: 5 }),
    history: HISTORY,
  });
  assert.ok(signatures(at).includes(STAGNATION), "10 rounds is the floor and must fire");
});

test("passing the floor does not by itself halt a cycle that is still improving", () => {
  const findings = evaluate({
    snapshot: snapshot({ gate_rounds: 30, rounds_since_improvement: 2 }),
    history: HISTORY,
  });
  assert.ok(
    !signatures(findings).includes(STAGNATION),
    "the improvement counter still governs; the floor only gates when it may be read",
  );
});

test("the halt evidence reports the floor it was judged against", () => {
  const findings = evaluate({
    snapshot: snapshot({ gate_rounds: 12, rounds_since_improvement: 5 }),
    history: HISTORY,
  });
  const stagnation = findings.find((f) => f.signature === STAGNATION);
  assert.ok(stagnation, "expected the stagnation finding");
  assert.strictEqual(stagnation.evidence.stagnation_min_rounds, 10);
  assert.strictEqual(stagnation.evidence.stagnation_threshold, 5);
  // Whoever reads the halt file next should not have to re-derive why it fired.
  assert.strictEqual(stagnation.evidence.gate_rounds, 12);
});

// Owner decision: when the programme moves to writing the paper, the budget
// goes up again.
//
// R3 halts when a role nears its exempt ceiling AND the hypothesis gate has not
// passed. Once the owner authorises the document stage, that second condition
// stops being a symptom and becomes the premise -- cycle-g-v89 was authorised
// precisely because its gate would not pass and the science was worth writing
// up. Leaving R3 alone halted the cycle for the reason it was told to proceed
// under, and the document lanes never got to run inside the loop at all.

const { evaluate: evaluateWatchdog } = require("../src/cli/progress_watchdog");

const AUTHORIZED = { authorized: true, reason: "owner released the document stage" };

function budgetWall(snapshot) {
  return evaluateWatchdog({ snapshot: { gate_rounds: 5, epoch_ms: Date.now(), ...snapshot }, history: [] })
    .filter((finding) => finding.signature === "budget_wall_without_convergence");
}

// 2026-10-03: one follow-up budget for the cycle (default 4096), the same number
// the Rust dispatcher stops at; the wall is 90% of it, counted across roles.
test("the wall is the cycle's one budget, counted across every role", () => {
  // Under the per-role caps 180 analyst lanes halted the cycle on their own.
  assert.equal(budgetWall({ gate_passed: false, role_counts: { analyst: 180 } }).length, 0);
  const found = budgetWall({
    gate_passed: false,
    role_counts: { analyst: 1300, "lab-director": 1200, gatekeeper: 1200 },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.followup_lanes, 3700);
  assert.equal(found[0].evidence.followup_budget, 4096);
  assert.equal(found[0].evidence.document_stage_authorized, false);
  assert.match(found[0].recommended_action, /Every previous cycle that hit this wall died on it/);
  assert.equal(
    budgetWall({ gate_passed: true, role_counts: { analyst: 1300, "lab-director": 1200, gatekeeper: 1200 } }).length,
    0,
    "a passed gate is not a wall",
  );
});

test("the lanes that write the paper are not counted under a document authorisation", () => {
  // Their spend IS the authorised goal, so counting it as failure to converge
  // is the contradiction this exists to remove; research lanes still count.
  const roles = { analyst: 3400, author: 500, illustrator: 100 };
  assert.equal(budgetWall({ gate_passed: false, role_counts: roles }).length, 1);
  assert.equal(budgetWall({ gate_passed: false, role_counts: roles, document_stage_authorization: AUTHORIZED }).length, 0);
  const churning = budgetWall({
    gate_passed: false,
    role_counts: { ...roles, analyst: 3700 },
    document_stage_authorization: AUTHORIZED,
  });
  assert.equal(churning.length, 1, "research churn under a document authorisation still hits the wall");
  assert.match(churning[0].recommended_action, /document authorisation/);
});

test("an authorisation with no reason excludes nothing", () => {
  // Same fail-closed shape as the Rust gate and the document builder.
  for (const record of [{ authorized: true }, { authorized: true, reason: "  " }, { authorized: false, reason: "x" }]) {
    const found = budgetWall({
      gate_passed: false,
      role_counts: { analyst: 3400, author: 500 },
      document_stage_authorization: record.authorized === true && String(record.reason || "").trim() ? record : null,
    });
    assert.equal(found.length, 1, `${JSON.stringify(record)} must not exclude the paper's lanes`);
  }
});
