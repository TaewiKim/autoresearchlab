"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { aggregateGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");
const { buildGateFollowupActions } = require("../src/reporting/reviews/gate/actions");

// cycle-g-v77: the first gate round dispatched all five rubric reviewers before
// any hypothesis or measurement existed. They scored 0, and because a covered
// rubric is never re-listed in pendingRubrics, technical_quality and
// reproducibility stayed pinned at 0 for the remaining 4.5 hours while nine
// later gatekeepers scored those same axes 24-58 and 35-61.

const HARD = ["novelty", "technical_quality", "reproducibility"];

function review(laneId, focus, scores) {
  return {
    lane_id: laneId,
    focus_rubric: focus,
    verdict: "reject",
    rubric: Object.entries(scores).map(([name, score]) => ({ name, score, applicable: true })),
  };
}

test("a rubric review is not opened when there is nothing to review", () => {
  const actions = buildGateFollowupActions({}, [], HARD, {});
  assert.deepEqual(actions, [], "no hypotheses and no validation results means nothing to score");
});

test("a rubric review is opened once evidence exists", () => {
  const withValidation = buildGateFollowupActions(
    { validation_results: [{ hypothesis: "h1", status: "passed", coefficients: { psnr: 27.4 } }] },
    [],
    ["technical_quality"],
    {},
  );
  assert.equal(withValidation.length, 1);
  assert.equal(withValidation[0].target_rubric, "technical_quality");

  const withHypotheses = buildGateFollowupActions(
    {
      derivable_hypothesis_candidates: [
        { statement: "primary_family=adaptive_sampling: variance-guided allocation beats uniform" },
      ],
    },
    [],
    ["reproducibility"],
    {},
  );
  assert.equal(withHypotheses.length, 1);
  assert.equal(withHypotheses[0].target_rubric, "reproducibility");
});

test("a focused reviewer that scored 0 does not pin the rubric", () => {
  const agg = aggregateGatekeeperReviews({
    parsedReviews: [
      // The evidence-blind reviewer that owned technical_quality on v77.
      review("followup-gatekeeper-02", "technical_quality", {
        novelty: 0, technical_quality: 0, reproducibility: 0,
      }),
      review("gatekeeper-01", "novelty", {
        novelty: 24, technical_quality: 42, reproducibility: 48,
      }),
      review("gatekeeper-03", "clarity", {
        novelty: 38, technical_quality: 57, reproducibility: 61,
      }),
    ],
    expectedRubrics: HARD,
  });
  const byName = new Map(agg.rubric.map((item) => [item.name, item]));
  // Fail-closed: the LOWEST measured score, not the most generous one.
  assert.equal(byName.get("technical_quality").score, 42);
  assert.equal(byName.get("technical_quality").replaced_uninformative_focused_review, "followup-gatekeeper-02");
  // A replaced rubric is a real observation, so it must still bind.
  assert.notEqual(byName.get("technical_quality").focused_review_missing, true);
  // reproducibility had no focused reviewer at all. The evidence-blind reviewer
  // also contributed a 0 here, as cross-rubric evidence — the MINIMUM rule used
  // to pick that 0 over the two reviewers who measured the axis.
  assert.equal(byName.get("reproducibility").score, 48);
  assert.equal(byName.get("reproducibility").focused_review_missing, true);
  // A focused reviewer that actually scored keeps its own score.
  assert.equal(byName.get("novelty").score, 24);
});

test("a rubric every reviewer scores 0 keeps its 0", () => {
  const agg = aggregateGatekeeperReviews({
    parsedReviews: [
      review("gk-a", "technical_quality", { technical_quality: 0 }),
      review("gk-b", "novelty", { technical_quality: 0, novelty: 30 }),
    ],
    expectedRubrics: ["novelty", "technical_quality"],
  });
  const byName = new Map(agg.rubric.map((item) => [item.name, item]));
  assert.equal(byName.get("technical_quality").score, 0);
  assert.equal(byName.get("technical_quality").replaced_uninformative_focused_review, undefined);
});

test("a non-zero focused score is never overridden by other reviewers", () => {
  const agg = aggregateGatekeeperReviews({
    parsedReviews: [
      review("gk-focus", "reproducibility", { reproducibility: 61 }),
      review("gk-other", "novelty", { reproducibility: 2, novelty: 40 }),
    ],
    expectedRubrics: ["novelty", "reproducibility"],
  });
  const byName = new Map(agg.rubric.map((item) => [item.name, item]));
  assert.equal(byName.get("reproducibility").score, 61, "the specialist owns its axis");
});

// cycle-g-v81: one round scored novelty/technical_quality/impact at 100 - an
// aggregation placeholder, not a reviewer's judgement - and the next round of
// the same lead came back 25/18/12. The placeholder set that lead's
// best_composite to 90 and kept it `bestSoFarLead` for the rest of the cycle,
// so the anti-churn guard spent 95 decisions protecting a lead that had been
// abandoned at round 44 of 57.
const hypothesisProgress = require("../src/reporting/hypothesis_progress");

// Built through buildProgressRecord, which computes the audit_hash. A
// hand-signed fixture is rejected by the ledger's audit gate and the rollup
// comes back EMPTY, which would make every assertion below pass vacuously.
function round(n, rubric, composite) {
  return hypothesisProgress.buildProgressRecord({
    cycleId: "cyc",
    round: n,
    reviewLaneId: `gatekeeper-0${n}`,
    statement: "primary_family=x: a lead",
    hypothesisId: "hyp-aaaa",
    familyRoot: null,
    rubric: rubric.map(([name, score]) => ({ name, score, applicable: true })),
    verdict: "reject",
    gatePassed: false,
    now: new Date(n * 1000).toISOString(),
    eventId: `evt-${n}`,
    composite,
  });
}

test("a placeholder 100 never becomes a lead's high-water mark", () => {
  const records = [
    round(1, [["novelty", 58], ["technical_quality", 58]]),
    round(2, [["novelty", 100], ["technical_quality", 100]]),
    round(3, [["novelty", 25], ["technical_quality", 18]]),
  ];
  const rollup = hypothesisProgress.rollupByHypothesis(records, "cyc");
  assert.ok(rollup.size > 0, "the fixture must survive the ledger's audit gate");
  const lead = [...rollup.values()][0];
  assert.equal(lead.rounds, 3, "all three rounds are admitted");
  assert.equal(lead.best_by_rubric.novelty, 58, "100 must not become a rubric's best");
  assert.equal(lead.best_by_rubric.technical_quality, 58);
  assert.ok(
    lead.best_composite < 90,
    `a composite from a placeholder round is not a best (got ${lead.best_composite})`,
  );
  assert.deepEqual(
    lead.rubric_history.novelty,
    [58, 25],
    "the placeholder is absent from the trajectory stall is judged on",
  );
});
