"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { __private } = require("../src/agents/chronicle/hypothesis_ledger");

test("validation ledger rejects runner outputs that do not match planner candidate hypotheses", () => {
  const rolePlan = {
    planner_metadata: {
      candidate_hypotheses: [
        {
          statement:
            "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
        },
      ],
    },
  };
  const staleRunnerResult = {
    selected_hypotheses: [
      {
        statement:
          "A separate tumor microenvironment mediation claim explains mutation burden and drug-response sensitivity.",
      },
    ],
    validation_summary: {
      primary_hypothesis_id: "stale-mediation-claim",
    },
  };
  const match = __private.validationResultMatchesPlannerCandidate(staleRunnerResult, rolePlan);
  assert.equal(match.matches, false);
  assert.equal(match.reason, "candidate_overlap_below_threshold");
});

test("validation ledger accepts runner outputs that overlap planner candidate hypotheses", () => {
  const rolePlan = {
    planner_metadata: {
      candidate_hypotheses: [
        {
          statement:
            "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
        },
      ],
    },
  };
  const matchingRunnerResult = {
    selected_hypotheses: [
      {
        statement:
          "The revised validation tests whether adhesion and migration remodeling remains stronger than the cytotoxicity program after sensitivity checks.",
      },
    ],
  };
  const match = __private.validationResultMatchesPlannerCandidate(matchingRunnerResult, rolePlan);
  assert.equal(match.matches, true);
});

test("validation ledger rejects runner outputs that were marked as requiring analyst handoff reroute", () => {
  const rolePlan = {
    planner_metadata: {
      runner_handoff_required: true,
      candidate_hypotheses: [
        {
          statement:
            "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
        },
      ],
    },
  };
  const runnerResult = {
    selected_hypotheses: [
      {
        statement:
          "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
      },
    ],
  };
  const match = __private.validationResultMatchesPlannerCandidate(runnerResult, rolePlan);
  assert.equal(match.matches, false);
  assert.equal(match.reason, "runner_handoff_required_without_analyst_lane");
});

test("validation ledger rejects runner outputs executed on a dataset root that differs from the analyst handoff", () => {
  const rolePlan = {
    planner_metadata: {
      handoff_validation_plan: {
        dataset_root: "/tmp/researchlab/datasets/cycle-a/intended-bundle",
      },
      candidate_hypotheses: [
        {
          statement:
            "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
        },
      ],
    },
  };
  const runnerResult = {
    dataset_root: "/tmp/researchlab/datasets/cycle-a/legacy-bundle/csv",
    selected_hypotheses: [
      {
        statement:
          "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
      },
    ],
  };
  const match = __private.validationResultMatchesPlannerCandidate(runnerResult, rolePlan);
  assert.equal(match.matches, false);
  assert.equal(match.reason, "handoff_dataset_root_mismatch");
});

test("validation ledger accepts runner outputs executed under the handoff dataset root", () => {
  const rolePlan = {
    planner_metadata: {
      handoff_validation_plan: {
        dataset_root: "/tmp/researchlab/datasets/cycle-a/intended-bundle",
      },
      candidate_hypotheses: [
        {
          statement:
            "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
        },
      ],
    },
  };
  const runnerResult = {
    dataset_root: "/tmp/researchlab/datasets/cycle-a/intended-bundle/csv",
    selected_hypotheses: [
      {
        statement:
          "Dataset-specific adhesion and migration remodeling is stronger than the canonical cytotoxicity program under the revised lead hypothesis.",
      },
    ],
  };
  const match = __private.validationResultMatchesPlannerCandidate(runnerResult, rolePlan);
  assert.equal(match.matches, true);
});

test("validation ledger does not downgrade explicit robust hypothesis verdict on partial diagnostic failures", () => {
  assert.equal(
    __private.mergeLedgerStatus("robust", "exploratory"),
    "robust",
  );
});

test("validation ledger allows explicit weak or failed validations to downgrade status", () => {
  assert.equal(
    __private.mergeLedgerStatus("robust", "weak", { allowDowngrade: true }),
    "weak",
  );
});
