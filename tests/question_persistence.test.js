"use strict";

// The three-method floor existed as a sentence and was never once evaluated.
//
// cycle-g-v89 delivered "a valid falsification retires the METHOD, not the
// QUESTION" to every director prompt and produced 118 replacement hypotheses,
// none of which named a question. The lead-level churn guard denied 143 pivots
// while the question moved underneath it: 33 lead changes at 2.12 rounds per
// lead. v88 read the same symptom as a role ignoring its contract; the role was
// working through a schema with no slot for the answer.
//
// These tests pin the check that makes the floor real, and just as importantly
// pin what it must NOT block: bringing a different method to the same question
// is the wanted behaviour after a falsification and has to stay free.

const test = require("node:test");
const assert = require("node:assert");

const {
  questionPersistenceFindings,
  questionChurnSummary,
  distinctApproaches,
  REQUIRED_METHODS_BEFORE_RETIRING,
} = require("../src/reporting/question_persistence");

const QUESTION = "At what edit severity does fixed stale reuse become unsafe against fresh tracing?";
const OTHER_QUESTION = "Which denoiser preserves glossy indirect detail at low sample counts?";

function method(approach) {
  return { approach, outcome: "falsified", what_it_rules_out: "the signal is not there" };
}

test("a different method for the same question is never blocked", () => {
  // This is the behaviour the rule exists to produce. It must be the cheap path.
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      { statement: "active expected-uncertainty querying", research_problem_question: QUESTION, methods_tried: [method("residual threshold")] },
    ],
  });
  assert.deepEqual(findings, []);
});

test("wording changes to the same question do not count as a pivot", () => {
  // Directors restate the question by hand each round; exact equality would
  // turn harmless rewording into a violation and teach the role to copy-paste.
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      {
        statement: "same question, retyped",
        research_problem_question: "At what edit severity does fixed stale reuse become unsafe, against fresh tracing?",
        methods_tried: [method("residual threshold")],
      },
    ],
  });
  assert.deepEqual(findings, []);
});

test("abandoning the question early is the violation", () => {
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      { statement: "move to denoising", research_problem_question: OTHER_QUESTION, methods_tried: [method("residual threshold")] },
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].violation, "question_retired_early");
  assert.equal(findings[0].distinct_methods_tried, 1);
  assert.equal(findings[0].required, REQUIRED_METHODS_BEFORE_RETIRING);
  assert.match(findings[0].detail, /retires the method, not the question/);
});

test("three distinct approaches earn the right to leave the question", () => {
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      {
        statement: "move to denoising",
        research_problem_question: OTHER_QUESTION,
        methods_tried: [method("residual threshold"), method("AOV history rejection"), method("active querying")],
      },
    ],
  });
  assert.deepEqual(findings, []);
});

test("the same approach listed three times is one approach", () => {
  // Otherwise the floor is satisfied by repeating a name, which is the cheapest
  // way to make a real rule into a formality.
  assert.equal(distinctApproaches([method("residual threshold"), method("residual threshold"), method("Residual  Threshold")]), 1);
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      {
        statement: "move on",
        research_problem_question: OTHER_QUESTION,
        methods_tried: [method("residual threshold"), method("residual threshold"), method("residual threshold")],
      },
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].distinct_methods_tried, 1);
});

test("an unstated question is its own finding, because it is the pivot nobody can see", () => {
  // 118 of 118 in cycle-g-v89. Folding this into the floor check would report it
  // as "zero methods tried", which describes the symptom and hides the cause.
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [{ statement: "a replacement with no question", methods_tried: [] }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].violation, "question_not_stated");
  assert.match(findings[0].detail, /method floor cannot be counted/);
});

test("retires_the_question is honoured even when the question text is unchanged", () => {
  // A director may keep the wording and still declare it exhausted; the floor
  // applies to the declaration, not only to the string comparison.
  const findings = questionPersistenceFindings({
    incumbentQuestion: QUESTION,
    replacements: [
      { statement: "give up on this", research_problem_question: QUESTION, retires_the_question: true, methods_tried: [method("one")] },
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].violation, "question_retired_early");
});

test("the cycle summary reports whether any of it could be judged", () => {
  // One line that would have made v89 visible: 118 proposed, 0 stating a
  // question, nothing accountable.
  const v89Shaped = Array.from({ length: 4 }, () => ({
    replacement_hypotheses: [{ statement: "a lead" }, { statement: "another lead" }],
  }));
  const summary = questionChurnSummary(v89Shaped);
  assert.equal(summary.replacements_proposed, 8);
  assert.equal(summary.replacements_stating_a_question, 0);
  assert.equal(summary.distinct_questions, 0);
  assert.equal(summary.accountable, false);

  const accounted = questionChurnSummary([
    { replacement_hypotheses: [{ statement: "a", research_problem_question: QUESTION }] },
    { replacement_hypotheses: [{ statement: "b", research_problem_question: QUESTION }] },
  ]);
  assert.equal(accounted.accountable, true);
  assert.equal(accounted.distinct_questions, 1, "two replacements on one question is not churn");
});
