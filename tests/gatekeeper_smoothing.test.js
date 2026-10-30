"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { aggregateGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");

// MEASURED ON cycle-a-20260919, 2026-10-30: the same lead on the same
// analysis contract was scored technical_quality 58, 46, 34 by three reviewers in
// 25 minutes with no new evidence, and a round that passed at 81 was a reject at
// 77 seven minutes later because clarity was re-sampled 76 -> 58. A rubric is now
// the median of the newest reviews of one lead on one contract, and a pass
// needs two such reviews behind every rubric.

const RUBRICS = ["novelty", "technical_quality", "reproducibility", "clarity", "impact"];
let clock = 0;

function review(lane, focus, score, extra = {}) {
  clock += 1;
  return {
    lane_id: lane,
    focus_rubric: focus,
    verdict: score >= 80 ? "approve" : score >= 70 ? "challenge" : "reject",
    source_mtime: clock,
    briefed_lead_key: "hyp:a",
    briefed_analysis_contract_id: "analysis:c1",
    rubric: RUBRICS.map((name) => ({ name, score: name === focus ? score : 99, applicable: true, reasons: [`${name} reason`] })),
    ...extra,
  };
}

function scoreOf(aggregate, name) {
  return aggregate.rubric.find((item) => item.name === name).score;
}

test("the median of three reviews of the same evidence is the score, not the newest", () => {
  const reviews = [
    review("g1", "technical_quality", 58),
    review("g2", "technical_quality", 46),
    review("g3", "technical_quality", 34), // newest
  ];
  const aggregate = aggregateGatekeeperReviews({ parsedReviews: reviews, expectedRubrics: ["technical_quality"] });
  assert.equal(scoreOf(aggregate, "technical_quality"), 46);
  assert.deepEqual(aggregate.reviews[0].smoothed_from.map((item) => item.score), [34, 46, 58]);
  assert.equal(aggregate.reviews[0].lane_id, "g3", "the lane that spoke last keeps the bookkeeping");
});

test("one low outlier among agreeing reviews does not decide the rubric", () => {
  const reviews = [
    review("g1", "clarity", 76),
    review("g2", "clarity", 76),
    review("g3", "clarity", 58),
  ];
  const aggregate = aggregateGatekeeperReviews({ parsedReviews: reviews, expectedRubrics: ["clarity"] });
  assert.equal(scoreOf(aggregate, "clarity"), 76);
  assert.equal(aggregate.reviews[0].verdict, "challenge", "the verdict is the median review's, not the newest's reject");
});

test("two reviews give the lower of the two", () => {
  const aggregate = aggregateGatekeeperReviews({
    parsedReviews: [review("g1", "impact", 80), review("g2", "impact", 62)],
    expectedRubrics: ["impact"],
  });
  assert.equal(scoreOf(aggregate, "impact"), 62);
});

test("only the newest three count, and new evidence starts the count over", () => {
  const old = [10, 10, 10].map((score, i) => review(`o${i}`, "reproducibility", score));
  const recent = [70, 72, 74].map((score, i) => review(`r${i}`, "reproducibility", score));
  const aggregate = aggregateGatekeeperReviews({ parsedReviews: [...old, ...recent], expectedRubrics: ["reproducibility"] });
  assert.equal(scoreOf(aggregate, "reproducibility"), 72, "the oldest reviews fall out of the window");

  const other = review("n1", "reproducibility", 90, { briefed_analysis_contract_id: "analysis:c2" });
  const switched = aggregateGatekeeperReviews({ parsedReviews: [...old, ...recent, other], expectedRubrics: ["reproducibility"] });
  assert.equal(scoreOf(switched, "reproducibility"), 90, "a review of another contract stands alone");
  assert.deepEqual(switched.unconfirmedRubrics, ["reproducibility"]);
});

test("a review of another lead does not smooth this one", () => {
  const aggregate = aggregateGatekeeperReviews({
    parsedReviews: [
      review("g1", "novelty", 84),
      review("g2", "novelty", 20, { briefed_lead_key: "hyp:b" }),
    ],
    expectedRubrics: ["novelty"],
  });
  assert.equal(scoreOf(aggregate, "novelty"), 20, "the newest is the other lead's, and it is alone");
});

test("a zero is not an observation and does not pull the median down", () => {
  const aggregate = aggregateGatekeeperReviews({
    parsedReviews: [review("g1", "technical_quality", 0), review("g2", "technical_quality", 60), review("g3", "technical_quality", 64)],
    expectedRubrics: ["technical_quality"],
  });
  assert.equal(scoreOf(aggregate, "technical_quality"), 60);
});

test("reviews with no lead or contract stamp are not smoothed and have nothing to be confirmed against", () => {
  const unstamped = { briefed_lead_key: null, briefed_analysis_contract_id: null };
  const aggregate = aggregateGatekeeperReviews({
    parsedReviews: [review("g1", "clarity", 90, unstamped), review("g2", "clarity", 40, unstamped)],
    expectedRubrics: ["clarity"],
  });
  assert.equal(scoreOf(aggregate, "clarity"), 40, "the newest wins, as before");
  assert.deepEqual(aggregate.unconfirmedRubrics, []);
});

test("a rubric resting on one review is unconfirmed; two make it confirmed", () => {
  const first = RUBRICS.map((name) => review(`a-${name}`, name, 85));
  let aggregate = aggregateGatekeeperReviews({ parsedReviews: first, expectedRubrics: RUBRICS });
  assert.equal(aggregate.verdict, "approve");
  assert.deepEqual(aggregate.unconfirmedRubrics, RUBRICS);

  const second = RUBRICS.slice(0, 4).map((name) => review(`b-${name}`, name, 83));
  aggregate = aggregateGatekeeperReviews({ parsedReviews: [...first, ...second], expectedRubrics: RUBRICS });
  assert.deepEqual(aggregate.unconfirmedRubrics, ["impact"]);

  const third = review("b-impact", "impact", 86);
  aggregate = aggregateGatekeeperReviews({ parsedReviews: [...first, ...second, third], expectedRubrics: RUBRICS });
  assert.deepEqual(aggregate.unconfirmedRubrics, []);
  assert.equal(aggregate.verdict, "approve");
});

test("a second review that disagrees takes the pass away", () => {
  const first = RUBRICS.map((name) => review(`a-${name}`, name, 85));
  const second = RUBRICS.map((name) => review(`b-${name}`, name, name === "clarity" ? 58 : 85));
  const aggregate = aggregateGatekeeperReviews({ parsedReviews: [...first, ...second], expectedRubrics: RUBRICS });
  assert.equal(scoreOf(aggregate, "clarity"), 58);
  assert.notEqual(aggregate.verdict, "approve");
});

test("a rubric held for confirmation is asked for again, with nothing new since the last round", () => {
  const { authoritativeGateFollowupActions } = require("../src/reporting/reviews/gate/actions");
  const summary = { validation_results: [{ hypothesis: "h1", status: "passed", coefficients: { psnr: 27.4 } }] };
  const actions = authoritativeGateFollowupActions({
    summary,
    aggregateReview: { pendingRubrics: [], confirmationRubrics: ["clarity"], rubric: [] },
    labDirectorResponse: null,
    previousReviewContext: null,
    chronicleResearchContext: null,
  });
  const asked = actions.filter((item) => item.type === "independent_gate_review_followup").map((item) => item.target_rubric);
  assert.deepEqual(asked, ["clarity"]);
});
