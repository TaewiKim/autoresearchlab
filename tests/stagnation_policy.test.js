"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldBreakForStagnation } = require("../src/policy/stagnation_policy");

function summaryWithApprovalGate(passed) {
  return {
    approval_review: {
      review: {
        approval_gate_passed: passed,
      },
    },
    conclusion_review: {
      review: {
        conclusion_gate_passed: passed,
      },
    },
    gate_review: {
      review: {
        gate_passed: passed,
      },
    },
    report_review: {
      review: {
        communication_gate_passed: passed,
      },
    },
    paper_review: {
      review: {
        submission_gate_passed: passed,
      },
    },
  };
}

test("pre-gate stagnation below the saturation bound keeps pivoting (no break)", () => {
  assert.equal(
    shouldBreakForStagnation({
      summary: summaryWithApprovalGate(false),
      stagnantRounds: 3,
      stagnationBreakEnabled: true,
      latestPassProducedWork: false,
    }),
    false,
  );
});

test("pre-gate saturation (>=8 stagnant rounds, nothing promoted, no running lanes) breaks the runaway", () => {
  // Bug B fix: an unproductive pre-approval loop that keeps spawning followups
  // without promoting anything or changing its fingerprint must terminate
  // instead of ballooning indefinitely.
  assert.equal(
    shouldBreakForStagnation({
      summary: summaryWithApprovalGate(false),
      stagnantRounds: 8,
      stagnationBreakEnabled: true,
      latestPassProducedWork: false,
    }),
    true,
  );
});

test("pre-gate saturation does NOT break while a hypothesis is promoted (real progress)", () => {
  const summary = summaryWithApprovalGate(false);
  summary.hypothesis_ledger = { summary: { promoted_count: 1 } };
  assert.equal(
    shouldBreakForStagnation({
      summary,
      stagnantRounds: 20,
      stagnationBreakEnabled: true,
      latestPassProducedWork: false,
    }),
    false,
  );
});

test("post-gate no-work stagnation can still stop cleanly", () => {
  assert.equal(
    shouldBreakForStagnation({
      summary: summaryWithApprovalGate(true),
      stagnantRounds: 10,
      stagnationBreakEnabled: true,
      latestPassProducedWork: false,
    }),
    true,
  );
});
