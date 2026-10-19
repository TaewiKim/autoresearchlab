"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  boundEvidenceActions,
  canAdvanceWithHighScoreNudge,
  hypothesisRegenerationActions,
} = require("../src/reporting/conclusion_review");

// The live cycle-g-v89 shape: every sub-threshold dimension carries the
// gatekeeper's cap, and the hypothesis side is not short of anything.
const BOUND_RUBRIC = [
  { name: "novelty", score: 35, bounded_by_gatekeeper: true, reasons: ["capped at 35"] },
  { name: "technical_quality", score: 40, bounded_by_gatekeeper: true, reasons: ["capped at 40"] },
  { name: "reproducibility", score: 25, bounded_by_gatekeeper: true, reasons: ["capped at 25"] },
  { name: "clarity", score: 90 },
];

const HEALTHY_SUMMARY = {
  claim_count: 168,
  hypothesis_quality_score: 90,
  derivable_hypothesis_candidates: [],
  schema_quality: { falsification_test_count: 381 },
  reasoning_graph: { claim_count: 168, unresolved_gap_count: 0 },
};

test("a fully bound deficit goes to the experiment, not the director", () => {
  const actions = boundEvidenceActions(BOUND_RUBRIC);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preferred_role, "lab-runner");
  // The lowest bound dimension is the one the experiment has to move.
  assert.equal(actions[0].target_rubric, "reproducibility");
  assert.deepEqual(actions[0].bounded_dimensions, [
    "novelty",
    "technical_quality",
    "reproducibility",
  ]);
});

test("the director is not asked to regenerate against a capped number", () => {
  assert.deepEqual(
    hypothesisRegenerationActions({
      summary: HEALTHY_SUMMARY,
      score: 34,
      blockers: ["Bounded by the gatekeeper's critical reproducibility score (25)"],
      rubric: BOUND_RUBRIC,
    }),
    [],
  );
});

test("an unbound weakness still reaches the director", () => {
  const mixed = [
    ...BOUND_RUBRIC.slice(0, 3),
    { name: "clarity", score: 40 }, // sub-threshold and NOT capped
  ];
  assert.deepEqual(boundEvidenceActions(mixed), []);
  const actions = hypothesisRegenerationActions({
    summary: HEALTHY_SUMMARY,
    score: 34,
    blockers: [],
    rubric: mixed,
  });
  assert.ok(actions.some((action) => action.type === "lab_director_requery_followup"));
});

test("nothing is emitted when every dimension clears the bar", () => {
  assert.deepEqual(
    boundEvidenceActions([{ name: "reproducibility", score: 95, bounded_by_gatekeeper: true }]),
    [],
  );
});

test("a gatekeeper-capped conclusion remains eligible for that gate", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-02: gate history alternated
  // 52 (58/56/72/35/38) and 50 (58/56/61/35/38). The 52 gate capped the next
  // conclusion; that cap then made the same gate defer and copy the 50 rubric.
  const cappedConclusion = {
    conclusion_score: 50,
    design_ceiling_rubrics: ["reproducibility", "impact"],
    conclusion_rubric: [
      { name: "novelty", score: 58, bounded_by_gatekeeper: true, applicable: true },
      { name: "technical_quality", score: 56, bounded_by_gatekeeper: true, applicable: true },
      { name: "reproducibility", score: 61, applicable: true },
      { name: "clarity", score: 35, bounded_by_gatekeeper: true, applicable: true },
      { name: "impact", score: 38, bounded_by_gatekeeper: true, applicable: true },
    ],
  };

  assert.equal(
    canAdvanceWithHighScoreNudge(cappedConclusion),
    true,
    "the next refresh must keep using the independent 52-point gate rubric instead of falling back to 50",
  );
});
