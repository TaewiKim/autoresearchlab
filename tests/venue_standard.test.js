"use strict";

// The gate held one bar for every venue. cycle-g-v89 passed at 92 against a
// fixed 90 while targeting ACM TOG with seven references, a 64x64 evaluation,
// two comparators the manuscript itself calls proxies, and a control that
// reproduced its headline result exactly.
//
// These pin the three rules the calibration is built on: no venue table,
// naming a venue obliges you to read it, and evidence may raise the bar but
// never lower it.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
  calibratedPaperStandard,
  venueStandardFindings,
} = require("../src/reporting/document_reviews/venue_standard");

function paperWith(venue, extra = {}) {
  return { target_venue: venue, references: [], ...extra };
}

const SELECTIVE = {
  name: "ACM Transactions on Graphics",
  standard: {
    acceptance_rate: 0.17,
    source_url: "https://example.org/tog/statistics",
    checked_on: "2026-09-07",
    evaluation_norm: { described: "production scenes at 1080p and realistic sample counts" },
    accepts_contribution_types: ["method", "benchmark"],
  },
};

test("with no venue recorded the standard is the owner's floor, and says so", () => {
  const standard = calibratedPaperStandard(paperWith(null));
  assert.equal(standard.gate_threshold, 80);
  assert.equal(standard.minimum_references, 5);
  assert.equal(standard.calibrated, false);
  assert.equal(standard.basis, "no venue recorded");
  assert.deepEqual(venueStandardFindings(paperWith(null)), []);
});

test("naming a venue without reading it is itself a finding", () => {
  // The opposite direction from venue_fit, which waives a requirement only on
  // evidence. "We are submitting to TOG" is a claim about a bar, and an
  // unrecorded bar can be neither met nor missed.
  const paper = paperWith({ name: "ACM Transactions on Graphics" });
  const findings = venueStandardFindings(paper);
  assert.ok(findings.some((item) => /is named but its standard was never read/.test(item)));
  assert.equal(calibratedPaperStandard(paper).gate_threshold, 80, "an unread venue does not move the bar");
});

test("a selective venue raises the threshold and the reference floor", () => {
  const standard = calibratedPaperStandard(paperWith(SELECTIVE));
  assert.equal(standard.calibrated, true);
  assert.equal(standard.gate_threshold, 97);
  assert.equal(standard.minimum_references, 25);
  assert.equal(standard.minimum_high_impact, 5);
  assert.match(standard.basis, /acceptance rate of 17%/);
  assert.match(standard.basis, /read 2026-09-07/);
});

test("a lenient venue does not buy a cheaper gate", () => {
  // Retargeting to an easier venue would otherwise be the fastest route past the
  // gate, which is the shape of every scoring bug this project has had.
  const lenient = {
    name: "Open Workshop",
    standard: { acceptance_rate: 0.85, source_url: "https://example.org/ws", checked_on: "2026-09-07" },
  };
  const standard = calibratedPaperStandard(paperWith(lenient));
  assert.equal(standard.gate_threshold, 86);
  assert.equal(standard.minimum_references, 5);
});

test("an acceptance rate reads the same whether written as a percentage or a fraction", () => {
  const asPercent = { ...SELECTIVE, standard: { ...SELECTIVE.standard, acceptance_rate: 17 } };
  assert.equal(
    calibratedPaperStandard(paperWith(asPercent)).gate_threshold,
    calibratedPaperStandard(paperWith(SELECTIVE)).gate_threshold,
  );
});

test("a control that reproduces the result blocks the claim, whatever the paper calls itself", () => {
  // The first manuscript this ran against answered by declaring "benchmark" and
  // changing nothing else: no controls listed, no experiment requested, the body
  // byte-identical. Relabelling is the retreat the rule exists to stop.
  const base = {
    controls_that_reproduce_the_result: ["severity-label sham"],
    evaluation_scale: { matches_venue_norm: true },
  };
  for (const type of ["method", "benchmark", "evaluation"]) {
    const finding = venueStandardFindings(paperWith(SELECTIVE, { ...base, contribution_type: type }))
      .find((item) => /reproduce the reported result/.test(item));
    assert.ok(finding, `a ${type} paper does not escape the control that matched its arm`);
    assert.match(finding, /severity-label sham/);
    assert.match(finding, /not a resolution/);
  }
});

test("the two exits from a reproducing control both cost something", () => {
  const base = {
    contribution_type: "method",
    controls_that_reproduce_the_result: ["severity-label sham"],
    evaluation_scale: { matches_venue_norm: true },
  };
  const fires = (extra) =>
    venueStandardFindings(paperWith(SELECTIVE, { ...base, ...extra }))
      .some((item) => /reproduce the reported result/.test(item));

  // Ask for the measurement that separates the arm from the control.
  assert.equal(fires({ additional_experiments_requested: [{ request: "run the discriminating condition" }] }), false);
  // Or give up the claim the control reproduced.
  assert.equal(fires({ withdrawn_claims: ["the severity-label sham arm localizes the boundary"] }), false);
  // Withdrawing some other claim does not count.
  assert.equal(fires({ withdrawn_claims: ["residual correlation predicts the boundary"] }), true);
});

test("proxy comparators do not carry a method claim at a venue that was read", () => {
  const paper = paperWith(SELECTIVE, {
    contribution_type: "method",
    controls_that_reproduce_the_result: [],
    evaluation_scale: { matches_venue_norm: true },
    baselines: [
      { name: "Path Verification image proxy", kind: "proxy" },
      { name: "deterministic bisection", kind: "implementation" },
    ],
  });
  const finding = venueStandardFindings(paper).find((item) => /PROXIES rather than implementations/.test(item));
  assert.ok(finding);
  assert.match(finding, /Path Verification image proxy/);
  assert.equal(/deterministic bisection/.test(finding), false, "an implemented baseline is not a finding");
});

test("a venue that was read must have its evaluation norm recorded, and met", () => {
  const noNorm = paperWith(
    { ...SELECTIVE, standard: { ...SELECTIVE.standard, evaluation_norm: null } },
    { contribution_type: "benchmark", controls_that_reproduce_the_result: [] },
  );
  assert.ok(venueStandardFindings(noNorm).some((item) => /no evaluation norm was recorded/.test(item)));

  const below = paperWith(SELECTIVE, {
    contribution_type: "benchmark",
    controls_that_reproduce_the_result: [],
    evaluation_scale: { described: "64x64 images at 8 spp", matches_venue_norm: false, why: "resolution is two orders below" },
  });
  const finding = venueStandardFindings(below).find((item) => /does not meet .* own norm/.test(item));
  assert.ok(finding);
  assert.match(finding, /64x64 images at 8 spp/);
  assert.match(finding, /production scenes at 1080p/);
});

test("the reference floor is reported as the venue's number, not as a bare count", () => {
  const paper = paperWith(SELECTIVE, {
    contribution_type: "benchmark",
    controls_that_reproduce_the_result: [],
    evaluation_scale: { matches_venue_norm: true },
    references: Array.from({ length: 7 }, (_, i) => ({ title: `Ref ${i}`, type: "article", doi: `10.1/${i}` })),
  });
  const finding = venueStandardFindings(paper).find((item) => /reference list holds/.test(item));
  assert.ok(finding);
  assert.match(finding, /holds 7 entries/);
  assert.match(finding, /at least 25/);
  assert.match(finding, /17% acceptance rate/);
});

test("a venue that accepts only some contribution types says so about this one", () => {
  const paper = paperWith(SELECTIVE, {
    contribution_type: "negative_result",
    controls_that_reproduce_the_result: [],
    evaluation_scale: { matches_venue_norm: true },
  });
  const finding = venueStandardFindings(paper).find((item) => /does not accept a negative_result paper/.test(item));
  assert.ok(finding);
  assert.match(finding, /it accepts method, benchmark/);
});

test("every standard blocker carries the author action that would clear it", () => {
  // A blocker with no action is a blocker nobody is asked to clear. The first
  // cycle run under this gate emitted 3 blockers and ZERO recommended actions:
  // no author lane was opened, the supervisor spent its rounds on gatekeepers,
  // and the run halted on stagnation with the manuscript byte-identical to the
  // one it started with. The halt said "more gate reviews will not raise them",
  // which was exactly right.
  const { buildPaperSubgates } = require("../src/reporting/document_reviews/requests");
  const findings = ["first finding", "second finding"];
  const subgates = buildPaperSubgates({
    root: path.join(os.tmpdir(), "venue-standard-actions"),
    cycleId: "cycle",
    paper: { title: "A paper" },
    rubric: [{ name: "novelty_and_impact_positioning", score: 99, reasons: [], applicable: true }],
    rawScore: 99,
    editorialRisk: { score_cap: 100 },
    analysisRequests: [],
    referenceRequests: [],
    figureRequests: [],
    threshold: 97,
    standardFindings: findings,
  });

  const actions = subgates.authorGate.recommended_followup_actions
    .filter((item) => item.type === "manuscript_standard_followup");
  assert.equal(actions.length, findings.length);
  assert.deepEqual(actions.map((item) => item.blocker_reasons[0]), findings);
  assert.ok(actions.every((item) => item.preferred_role === "author"));
  assert.ok(actions.every((item) => item.priority === "critical"));
  assert.ok(actions.every((item) => item.required_for_gate === true));
  assert.ok(actions.every((item) => item.target_score === 97), "the action aims at the venue's bar");

  for (const finding of findings) {
    assert.ok(subgates.authorGate.blockers.includes(finding), "and the blocker is still a blocker");
  }
});
