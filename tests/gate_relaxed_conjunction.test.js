"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");

const HARD = ["novelty", "technical_quality", "reproducibility"];

// Build a per-rubric gatekeeper review whose verdict follows the anchor bands
// (>=80 approve, 70-79 challenge, <70 reject) so the aggregate sees consistent
// per-review verdicts + rubric scores.
function review(focus_rubric, score, extra = {}) {
  const verdict = score >= 80 ? "approve" : score >= 70 ? "challenge" : "reject";
  return {
    focus_rubric,
    verdict,
    rubric: [{ name: focus_rubric, score, applicable: true }],
    ...extra,
  };
}

function verdictFor(scores, extra = {}) {
  const parsedReviews = HARD.map((name, i) => review(name, scores[i], extra[name] || {}));
  return aggregateGatekeeperReviews({ parsedReviews, expectedRubrics: HARD }).verdict;
}

test("relaxed gate: two approves + one challenge-band hard rubric -> approve", () => {
  assert.equal(verdictFor([85, 82, 74]), "approve");
});

test("relaxed gate: all three approve -> approve", () => {
  assert.equal(verdictFor([88, 84, 81]), "approve");
});

test("relaxed gate: one hard rubric in reject band (<70) -> reject", () => {
  assert.equal(verdictFor([85, 82, 68]), "reject");
});

test("relaxed gate: only one approve, two challenge-band -> challenge (not tolerable)", () => {
  assert.equal(verdictFor([85, 74, 74]), "challenge");
});

test("honest floor holds: v62-class lead 62/58/52 (all reject band) -> reject", () => {
  assert.equal(verdictFor([62, 58, 52]), "reject");
});

test("partial-current-hypothesis credit still blocks even when scores are tolerable", () => {
  const parsedReviews = HARD.map((name, i) =>
    review(name, [85, 82, 74][i], name === "reproducibility" ? { partial_current_hypothesis_credit: true } : {}),
  );
  assert.equal(aggregateGatekeeperReviews({ parsedReviews, expectedRubrics: HARD }).verdict, "challenge");
});

test("pending rubric -> empty verdict (unchanged)", () => {
  const parsedReviews = [review("novelty", 85), review("technical_quality", 82)];
  // reproducibility missing -> pending
  assert.equal(aggregateGatekeeperReviews({ parsedReviews, expectedRubrics: HARD }).verdict, "");
});
