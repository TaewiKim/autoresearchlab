"use strict";

// The trend stage has to survey PROBLEMS and METHODS, not topics.
//
// A topic label says what a field writes about. It does not say what the field
// is stuck on, and novelty is scored on exactly that: whether a lead answers an
// open problem, and whether its method differs from the ones already proposed
// against that problem. The stage used to ask for `dominant_clusters`,
// `rising_methods`, `repeated_datasets`, `saturated_baselines` and
// `underexplored_gaps` -- five lists of labels, none of which links a method to
// the problem it attacks or records what its own authors said it could not do.
//
// cycle-g-v89 is the cost. Its best gate review scored novelty 66 with the
// reason "foundational native reuse literature remains incompletely audited",
// and the cycle had no artifact that named the open problems it was supposedly
// novel against -- so there was nothing to score the lead's novelty ON.
//
// Two halves, and both are load-bearing:
//   the DIRECTOR must produce the survey, attributed to papers  (policy.rs)
//   the GATEKEEPER must receive it structured                   (review_context)
// A survey nobody reads scores nothing, which is the failure this repository
// keeps finding.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const POLICY = fs.readFileSync(
  path.join(__dirname, "..", "native/researchlab-harness/src/labdirector/policy.rs"),
  "utf8",
);

// The BODY of the directive, not merely the file it lives in. An earlier
// refactor left this function returning `format!("{}", cycle_id)` -- the wiring
// correct and the payload empty -- and every assertion that grepped the whole
// file still passed, because the clause text was sitting in the base task
// string it was supposed to have replaced.
const SURVEY_DIRECTIVE = (() => {
  const start = POLICY.indexOf("pub(crate) fn research_trend_survey_directive");
  if (start < 0) return "";
  const end = POLICY.indexOf("\n}\n", start);
  return end < 0 ? POLICY.slice(start) : POLICY.slice(start, end);
})();

const FOLLOWUP_BUILDER = fs.readFileSync(
  path.join(__dirname, "..", "native/researchlab-harness/src/labdirector/followups/role_plan/role_plan_01.rs"),
  "utf8",
);

// The requirement lived inline in the BASE task string, which reaches
// lab-director-01 and nothing else -- and every director lane a running cycle
// dispatches is a follow-up. cycle-g-v90 and cycle-g-v91 produced no
// research-trend-analysis.json at all. Same shape as the chronicle admit-list,
// in the same file, and it is the sixth time a rule has been written where no
// dispatched lane reads it.
test("the survey is one directive, and the follow-up builder calls it", () => {
  assert.match(POLICY, /pub\(crate\) fn research_trend_survey_directive/);
  assert.match(
    FOLLOWUP_BUILDER,
    /research_trend_survey_directive\(cycle_id\)/,
    "a dispatched director lane would not receive the survey requirement",
  );
  // And the base task must not have kept a second copy to drift from.
  const inlineCopies = (POLICY.match(/research_trend_mapping_stage: BEFORE proposing/g) || []).length;
  assert.equal(inlineCopies, 1, "the clause exists in more than one place");
});

test("the director is asked for the field's open problems, not its topics", () => {
  assert.match(SURVEY_DIRECTIVE, /WHICH PROBLEMS is this field\s+currently trying to solve/);
  // Stated as a problem with a settling measurement, not as a subject area.
  for (const field of ["`why_open`", "`decisive_quantity`", "`status`"]) {
    assert.ok(SURVEY_DIRECTIVE.includes(field), `open_problems must carry ${field}`);
  }
});

test("the director is asked what each proposed method actually does", () => {
  assert.match(SURVEY_DIRECTIVE, /WHAT METHODS are being proposed against each\s+problem/);
  for (const field of [
    "`what_it_does_differently`",
    "`claimed_improvement`",
    "`compared_against`",
    "`evaluated_on`",
    "`stated_limitation`",
  ]) {
    assert.ok(SURVEY_DIRECTIVE.includes(field), `proposed_methods must carry ${field}`);
  }
  // A method has to be tied to the problem it attacks, or novelty cannot be
  // scored against it.
  assert.ok(SURVEY_DIRECTIVE.includes("`addresses_problem`"));
});

test("every surveyed problem and method must name the papers that state it", () => {
  assert.match(SURVEY_DIRECTIVE, /Every entry in both lists must carry at least one paper_id/);
  // And an unattributable one is recorded as an impression rather than dropped
  // or laundered into the evidence.
  assert.ok(SURVEY_DIRECTIVE.includes("`unattributed_impressions[]`"));
  assert.ok(SURVEY_DIRECTIVE.includes("`survey_coverage_gaps[]`"));
});

test("a thin corpus is declared, not padded", () => {
  assert.match(SURVEY_DIRECTIVE, /rather than padding either list/);
  assert.match(SURVEY_DIRECTIVE, /say so rather\s+than filling the fields from memory/);
});

// ---------------------------------------------------------------- delivery

const { collectChronicleResearchContext } = require("../src/reporting/reviews/gate/review_context");

function cycleWithTrendAnalysis(trendAnalysis) {
  const os = require("os");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-trend-"));
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "cycle-trend-research-trend-analysis.json"),
    JSON.stringify(trendAnalysis),
    "utf8",
  );
  return { cwd, root };
}

test("the survey reaches the reviewer with its structure intact", () => {
  const { cwd, root } = cycleWithTrendAnalysis({
    dominant_clusters: ["neural reuse"],
    open_problems: [{
      problem: "no method localizes the first frame at which cached shading becomes unsafe",
      why_open: "existing rejection maps are static and are not evaluated per severity bin",
      decisive_quantity: "within-one-bin localization rate of the first NRMSE>=0.02 crossing",
      status: "contested",
      paper_ids: ["doi:10.1145/3450626.3459812"],
    }],
    proposed_methods: [{
      method: "fixed AOV/history rejection",
      addresses_problem: "no method localizes the first frame at which cached shading becomes unsafe",
      what_it_does_differently: "thresholds per-pixel AOV discontinuity instead of modelling cache age",
      claimed_improvement: "fewer stale reuses at equal cost",
      compared_against: "always-reuse",
      evaluated_on: "three procedural scenes",
      stated_limitation: "authors report it is not evaluated across scene families",
      paper_ids: ["doi:10.1111/cgf.14340"],
    }],
    survey_coverage_gaps: ["offline path-tracing evaluation not covered by the admitted corpus"],
  });

  const context = collectChronicleResearchContext({ root, cycleId: "cycle-trend" }) || {};
  const problems = context.open_problems || [];
  const methods = context.proposed_methods || [];

  assert.equal(problems.length, 1, "the reviewer received no open problems to score novelty against");
  assert.match(problems[0].problem, /first frame at which cached shading becomes unsafe/);
  assert.equal(problems[0].status, "contested");
  assert.deepEqual(problems[0].paper_ids, ["doi:10.1145/3450626.3459812"]);

  assert.equal(methods.length, 1);
  // The link between a method and its problem is what a novelty score rests on.
  assert.equal(
    methods[0].addresses_problem,
    "no method localizes the first frame at which cached shading becomes unsafe",
  );
  assert.match(methods[0].stated_limitation, /not evaluated across scene families/);

  fs.rmSync(cwd, { recursive: true, force: true });
});
