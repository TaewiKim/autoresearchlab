"use strict";

// A schema is still a clause until something refuses to proceed without it.
//
// cycle-g-v89 got the fields: `research_problem_question`, `methods_tried` and
// `retires_the_question` reached followup-lab-director-71's prompt, verified by
// grep -- 2, 3 and 2 occurrences. The lane then returned three replacement
// hypotheses, all with the question NOT STATED and methods_tried empty. Adding
// the slot made the omission visible; it did not make it cost anything.
//
// So the pivot guard reads it. A replacement that does not say which question it
// answers cannot supersede the lead, which is what turns the field from a
// request into a requirement. These tests pin that, and pin just as hard what it
// must not block: a different method for the same question is the behaviour the
// rule wants after a falsification, and it stays free.

const test = require("node:test");
const assert = require("node:assert");

const { evaluateLeadSupersession } = require("../src/reporting/hypothesis_progress");

const QUESTION = "At what edit severity does fixed stale reuse become unsafe against fresh tracing?";
const OTHER = "Which denoiser preserves glossy indirect detail at low sample counts?";

// A completed run that declares its preregistered kill condition met. This is
// the path 53 of 83 allowed pivots took on cycle-g-v89.
const FALSIFIED = {
  handoff_check_resolutions: [{ resolution_status: "valid_falsification" }],
  blueprint_executions: [{ metrics: { crossing_error_bins: 5 } }],
};

// Enforcement switches on the director's replacement RECORD being supplied, not
// on the fields inside it: a call site that has not been wired must stay
// permissive, because denying every pivot for my omission looks identical in the
// log to a director refusing to answer.
function decide({ proposedQuestion, proposedMethodsTried, ...extra } = {}) {
  return evaluateLeadSupersession({
    records: [],
    cycleId: "cg-gate-test-question",
    leadValidationSummary: FALSIFIED,
    currentQuestion: QUESTION,
    proposedReplacement: {
      statement: "a replacement",
      research_problem_question: proposedQuestion || null,
      methods_tried: proposedMethodsTried || [],
    },
    ...extra,
  });
}

test("an unwired call site stays permissive", () => {
  // The distinction this whole fix exists to make: an absent record is my
  // wiring, an empty question inside a present record is the director.
  const decision = evaluateLeadSupersession({
    records: [],
    cycleId: "cg-gate-test-question",
    leadValidationSummary: FALSIFIED,
    currentQuestion: QUESTION,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason, "lead_falsified_by_completed_run");
});

test("a falsified lead still releases when the replacement names its question", () => {
  // The release itself must survive: nobody may be asked to keep refining a
  // method its own kill condition has retired.
  const decision = decide({
    proposedQuestion: QUESTION,
    proposedMethodsTried: [{ approach: "fixed residual threshold" }],
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason, "lead_falsified_by_completed_run");
});

test("a replacement with no question cannot supersede the lead", () => {
  // The v89 case: 118 replacements, none stating a question, every pivot
  // unexamined.
  const decision = decide({ proposedQuestion: null, proposedMethodsTried: [] });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "replacement_states_no_research_question");
  assert.equal(decision.falsification_released, true, "the release is recorded, not silently dropped");
  // The deny has to teach, or a cycle that cannot pivot never learns why.
  assert.match(decision.director_guidance, /Restate the question this hypothesis answers/);
  assert.match(decision.director_guidance, /verbatim if it is the same question/);
});

test("changing the question early is denied with the count that blocked it", () => {
  const decision = decide({
    proposedQuestion: OTHER,
    proposedMethodsTried: [{ approach: "fixed residual threshold" }],
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "question_retired_before_method_floor");
  assert.equal(decision.distinct_methods_tried, 1);
  assert.equal(decision.methods_required, 3);
  assert.match(decision.director_guidance, /The falsification retired the METHOD/);
});

test("three distinct approaches release the question", () => {
  const decision = decide({
    proposedQuestion: OTHER,
    proposedMethodsTried: [
      { approach: "fixed residual threshold" },
      { approach: "AOV history rejection" },
      { approach: "active expected-uncertainty querying" },
    ],
  });
  assert.equal(decision.decision, "allow");
});

test("the same approach three times is one approach", () => {
  // A floor satisfied by repeating a name is a formality, and the cheapest way
  // to turn this back into a clause.
  const decision = decide({
    proposedQuestion: OTHER,
    proposedMethodsTried: [
      { approach: "residual threshold" },
      { approach: "Residual  Threshold" },
      { approach: "residual threshold" },
    ],
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.distinct_methods_tried, 1);
});

test("rewording the same question is not a pivot", () => {
  // Directors restate the question by hand each round. Exact equality would
  // teach the role to copy-paste rather than to think.
  const decision = decide({
    proposedQuestion: "At what edit severity does fixed stale reuse become unsafe, against fresh tracing?",
    proposedMethodsTried: [],
  });
  assert.equal(decision.decision, "allow");
});
