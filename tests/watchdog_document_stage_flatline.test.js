"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluate } = require("../src/cli/progress_watchdog");

// cycle-g-v89 was halted at 14:23 on `activity_without_gate_progress`: 28 lanes
// completed across 100 minutes, zero gate rounds. Measured over that same
// window, the cycle was doing exactly the work it was authorised to do:
//
//   author 15, scout 8, lab-director 2, analyst 1, illustrator 1, lab-runner 1
//   paper v0072 13:20, v0073 13:28, v0071 13:36, v0074 13:44
//   paper review score 53, paper_gate_passed false, blockers named
//   followup-runner-131 ran the owner-adopted experiment to a falsification
//
// The gate produced nothing because the owner authorised the write-up of a gate
// that would not pass -- "The gate's reject stands and is not being rewritten."
// Zero gate rounds is the premise of that authorisation, so R2 was halting the
// cycle for the reason it had been told to proceed under.

const AUTHORIZATION = {
  authorized: true,
  authorized_by: "owner",
  scope: ["author", "illustrator"],
};

// 100 minutes, 28 new lanes, no gate round: v89's recorded shape.
function history({ paperMoves, rounds = 0, samples = 12, intervalMin = 9.31 }) {
  const t0 = 1789000000000;
  const rows = [];
  for (let i = 0; i < samples; i += 1) {
    const frac = i / (samples - 1);
    rows.push({
      epoch_ms: t0 + Math.round(i * intervalMin * 60000),
      lanes_completed: Math.round(1192 + 28 * frac),
      gate_rounds: rounds,
      gate_passed: false,
      best_technical_quality: 0,
      best_reproducibility: 0,
      paper_score: 53,
      paper_blocker_count: 4,
      // The manuscript timestamp is the signal that arrives first: the author
      // rewrites far more often than the review re-scores.
      paper_artifact_mtime: paperMoves ? t0 + Math.round(i * intervalMin * 60000) : t0,
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
    role_counts: { author: 15, scout: 8, "lab-director": 2, analyst: 1, illustrator: 1, "lab-runner": 1 },
    paper_score: last.paper_score,
    paper_blocker_count: last.paper_blocker_count,
    paper_artifact_mtime: last.paper_artifact_mtime,
    ...overrides,
  };
}

function flatline(findings) {
  return findings.find((f) => f.signature === "activity_without_gate_progress") || null;
}

test("an authorised document stage writing revisions is not a flatline", () => {
  const rows = history({ paperMoves: true });
  const snapshot = snapshotFrom(rows, { document_stage_authorization: AUTHORIZATION });
  assert.equal(
    flatline(evaluate({ snapshot, history: rows })),
    null,
    "v89 wrote three paper revisions inside the window that halted it",
  );
});

test("an authorised document stage whose paper is frozen still halts", () => {
  // The authorisation moves what the rule measures; it does not disarm it.
  const rows = history({ paperMoves: false });
  const snapshot = snapshotFrom(rows, { document_stage_authorization: AUTHORIZATION });
  const found = flatline(evaluate({ snapshot, history: rows }));
  assert.ok(found, "a paper whose score, blockers and text are all frozen is stuck");
  assert.equal(found.severity, "halt");
  assert.equal(found.evidence.document_stage_authorized, true);
  assert.equal(found.evidence.paper_score, 53);
  assert.match(found.recommended_action, /gate rounds are not the unit of progress/);
});

test("without an authorisation the rule is unchanged", () => {
  // No owner authorisation: lanes completing with no gate round is the v82
  // failure the rule was written for, and it must still halt on it.
  const rows = history({ paperMoves: true });
  const found = flatline(evaluate({ snapshot: snapshotFrom(rows), history: rows }));
  assert.ok(found, "an unauthorised cycle producing no gate round still halts");
  assert.equal(found.evidence.document_stage_authorized, false);
  assert.match(found.recommended_action, /pipeline is spinning without scoring/);
});

test("an authorised document stage that is also scoring is left alone", () => {
  const rows = history({ paperMoves: true, rounds: 5 });
  rows[rows.length - 1].gate_rounds = 6;
  const snapshot = snapshotFrom(rows, { document_stage_authorization: AUTHORIZATION });
  assert.equal(flatline(evaluate({ snapshot, history: rows })), null);
});
