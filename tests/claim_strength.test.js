"use strict";

// Honesty is a constraint on a claim, not a claim.
//
// The integrity checks all passed on cycle-g-v89 and produced a manuscript whose
// Interpretation says the result is "restricted to benchmarked localization
// rather than a rendering-specific mechanism or deployment-ready safety
// guarantee". Every sentence in it is true. Together they claim nothing, and the
// gate had no check that could tell a careful result from a careful absence.
//
// These pin the questions that do: does the manuscript establish anything, whose
// claim does a negative result kill, and what survived a withdrawal.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  claimStrengthFindings,
  claimStrengthReport,
  establishedClaim,
  isHedged,
} = require("../src/reporting/document_reviews/claim_strength");

// A manuscript that has already made both required declarations, so each test
// below is about the one thing it changes.
function declared(extra = {}) {
  return {
    contribution_type: "method",
    controls_that_reproduce_the_result: [],
    ...extra,
  };
}

const STRONG = "The active policy localizes the first unsafe severity exactly on all three held families using 2.0 queries against 3.7 for bisection.";
const HEDGED = "The benchmark establishes that exact localization is achievable, restricted to benchmarked localization rather than a rendering-specific mechanism.";

test("a claim carrying a measurement and no qualifier is the claim", () => {
  const found = establishedClaim(declared({ results: [STRONG] }));
  assert.equal(found.found, true);
  assert.equal(found.sentence, STRONG);
  assert.deepEqual(claimStrengthFindings(declared({ results: [STRONG] })), []);
});

test("a manuscript whose every candidate is hedged states no claim", () => {
  const paper = declared({ results: [HEDGED, "The result may generalize to other renderers."] });
  const finding = claimStrengthFindings(paper).find((item) => /states no positive claim/.test(item));
  assert.ok(finding);
  assert.match(finding, /2 hedged of 2 candidates/);
  assert.match(finding, /request for the next experiment, not a manuscript/);
});

test("scope-shrinking phrases count as hedges, plain specifications do not", () => {
  assert.equal(isHedged("The result is restricted to the benchmarked families."), true);
  assert.equal(isHedged("This may indicate a boundary."), true);
  assert.equal(isHedged("The bound holds under matched-SPP and matched-time budgets."), false);
  assert.equal(isHedged("Clustered false-safe risk was 0.17 under matched SPP."), false);
});

test("a sentence with no measured quantity is a position, not a claim", () => {
  const paper = declared({ results: ["The benchmark makes the first unsafe crossing measurable and reviewable."] });
  assert.equal(establishedClaim(paper).found, false);
  assert.ok(claimStrengthFindings(paper).some((item) => /states no positive claim/.test(item)));
});

test("both declarations are required, and omitting one is not a pass", () => {
  // These fired on nothing when run against the real v89 manuscript, because it
  // declares neither field while its own Results report a sham that matched.
  const undeclared = { results: [STRONG] };
  const findings = claimStrengthFindings(undeclared);
  assert.ok(findings.some((item) => /contribution_type is not stated/.test(item)));
  assert.ok(findings.some((item) => /controls_that_reproduce_the_result is not stated/.test(item)));

  // An empty list is an assertion a gatekeeper can check. A missing field is not.
  const asserted = claimStrengthFindings(declared({ results: [STRONG] }));
  assert.equal(asserted.some((item) => /controls_that_reproduce/.test(item)), false);
});

test("a cycle may not finish by subtraction", () => {
  const paper = declared({
    results: [HEDGED],
    withdrawn_claims: ["residual correlation predicts the safe reuse boundary"],
  });
  const finding = claimStrengthFindings(paper).find((item) => /were withdrawn and none replaced them/.test(item));
  assert.ok(finding);
  assert.match(finding, /residual correlation predicts the safe reuse boundary/);
  assert.match(finding, /the question it was answering is still open/);
});

test("a withdrawal beside a surviving claim is fine", () => {
  const paper = declared({
    results: [STRONG],
    withdrawn_claims: ["residual correlation predicts the safe reuse boundary"],
  });
  assert.equal(claimStrengthFindings(paper).some((item) => /none replaced them/.test(item)), false);
});

test("a negative result has to name whose claim it kills, and cite it", () => {
  const unnamed = declared({ contribution_type: "negative_result", results: [STRONG] });
  assert.ok(claimStrengthFindings(unnamed).some((item) => /name the standing claim it kills/.test(item)));

  const uncited = declared({
    contribution_type: "negative_result",
    results: [STRONG],
    refutes: { claim: "image-space residuals localize the safe reuse boundary" },
  });
  const finding = claimStrengthFindings(uncited).find((item) => /stated but not attributed/.test(item));
  assert.ok(finding);
  assert.match(finding, /image-space residuals localize/);

  // A cited refutation still owes the move it implies, so this case carries the
  // derived next approach too; otherwise the assertion below would be passing on
  // a different finding.
  const cited = declared({
    contribution_type: "negative_result",
    results: [STRONG],
    refutes: {
      claim: "image-space residuals localize the safe reuse boundary",
      source: { title: "Path verification for reuse", doi: "10.1145/example" },
    },
    next_approach: {
      approach: "condition the query on paired-residual dispersion rather than on severity order",
      derived_from: "all 27 arms missed the 0.10 bound while the strongest correlate reached r=0.927",
    },
    additional_experiments_requested: [{ request: "run the discriminating condition" }],
  });
  assert.deepEqual(claimStrengthFindings(cited), []);
});

test("the report carries the posture, so hedging drift is visible across revisions", () => {
  const report = claimStrengthReport(declared({ results: [STRONG, HEDGED], withdrawn_claims: ["x"] }));
  assert.equal(report.states_a_positive_claim, true);
  assert.equal(report.established_claim, STRONG);
  assert.equal(report.candidate_sentences, 2);
  assert.equal(report.hedged_candidate_sentences, 1);
  assert.equal(report.hedge_ratio, 0.5);
  assert.equal(report.withdrawn_claims, 1);
});

test("a negative result owes the next approach it points to", () => {
  // Owner rule: when something fails, the failure is evidence about where the
  // answer is. cycle-g-v89 ran 27 methods against one question and every one
  // missed the same bound of 0.10 -- a pattern that says something specific --
  // and concluded that the bound was not met.
  const stops = declared({
    contribution_type: "negative_result",
    results: [STRONG],
    refutes: { claim: "residuals localize the boundary", source: { doi: "10.1145/example" } },
  });
  const finding = claimStrengthFindings(stops).find((item) => /stops there/.test(item));
  assert.ok(finding);
  assert.match(finding, /a failure is evidence about where the answer is/i);
});

test("the next approach has to be derived from a measurement, not written beforehand", () => {
  const base = {
    contribution_type: "negative_result",
    controls_that_reproduce_the_result: [],
    results: [STRONG],
    refutes: { claim: "residuals localize the boundary", source: { doi: "10.1145/example" } },
    additional_experiments_requested: [{ request: "run the discriminating condition" }],
  };

  // Boilerplate: true of any study, learned from none.
  const boilerplate = { ...base, next_approach: { approach: "evaluate on more scenes at higher resolution", derived_from: "the limitations section" } };
  const finding = claimStrengthFindings(boilerplate).find((item) => /stated but not derived/.test(item));
  assert.ok(finding);
  assert.match(finding, /could have been written before the experiment ran/);

  // Derived: it points at a number this work produced.
  const derived = {
    ...base,
    next_approach: {
      approach: "condition the query on paired-residual dispersion rather than on severity order",
      derived_from: "all 27 arms missed the 0.10 bound while the strongest correlate reached r=0.927 against stale error",
      source_artifact: "artifacts/07-v4_three_fold_resolution_summary.csv",
    },
  };
  assert.deepEqual(claimStrengthFindings(derived), []);
});

test("a next approach that is never requested is future work, and future work is where results stop", () => {
  const paper = declared({
    withdrawn_claims: ["residual correlation predicts the safe boundary"],
    results: [STRONG],
    next_approach: {
      approach: "condition on paired-residual dispersion",
      derived_from: "27 arms missed the 0.10 bound; the strongest correlate reached r=0.927",
    },
  });
  const finding = claimStrengthFindings(paper).find((item) => /named but never requested/.test(item));
  assert.ok(finding);
  assert.match(finding, /additional_experiments_requested/);
  assert.match(finding, /the director decides/);
});

// MEASURED on cycle-g-v89 at 13:44, and it was a contradiction I introduced.
// The exhausted-channel rule told the author "the runs are not coming, stop
// conditioning the manuscript on them" while this rule told the same author to
// "put it in additional_experiments_requested so the director decides". Asking
// is only a requirement while asking can be answered.
test("an exhausted request channel lifts the demand to request, not to name", () => {
  const { claimStrengthFindings } = require("../src/reporting/document_reviews/claim_strength");

  const negativeResult = {
    contribution_type: "evaluation",
    controls_that_reproduce_the_result: ["a sham matched the active method at zero crossing error"],
    claim: "Active acquisition did not beat the severity-only sham; crossing error was 0.0 for both.",
    refutes: "that rendering-derived acquisition localises the boundary better than severity order",
    next_approach: {
      approach: "mask the severity labels and randomise candidates into a nonmonotone risk sequence",
      derived_from: "the sham matched at 0.0 crossing error over 2 queried severities",
      source_artifact: "artifacts/stats/parity.json",
    },
    additional_experiments_requested: [],
  };

  const live = claimStrengthFindings(negativeResult);
  assert.ok(
    live.some((f) => /named but never requested/.test(f)),
    "while the channel can answer, the next approach must be requested",
  );

  const exhausted = claimStrengthFindings(negativeResult, { experimentChannelExhausted: true });
  assert.ok(
    !exhausted.some((f) => /named but never requested/.test(f)),
    "a refused channel must not demand one more request",
  );

  // The half the owner asked for survives either way: a negative result still
  // has to name the move it points to, derived from a number it produced.
  const silent = { ...negativeResult, next_approach: null };
  for (const opts of [undefined, { experimentChannelExhausted: true }]) {
    const findings = claimStrengthFindings(silent, opts);
    assert.ok(
      findings.some((f) => /did not work and stops there/.test(f)),
      "naming the next approach is required whatever the channel is doing",
    );
  }
});
