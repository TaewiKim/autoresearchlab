"use strict";

// The three-method floor existed as a sentence and was never once evaluated.
//
// The contract has said since cd64ba8 that a valid falsification retires the
// METHOD, not the QUESTION, and that a research_problem may not be retired until
// three distinct approaches have been spent on it. cycle-g-v89 delivered that
// text to every director prompt and produced:
//
//     director lanes                                 65
//     lanes emitting a research_problem               1
//     replacement_hypotheses proposed               118
//     replacement_hypotheses carrying a question      0
//
// The lead-level churn guard was working the whole time -- 143 pivots denied
// against 83 allowed -- while the question moved underneath it, because nothing
// counted questions. 33 lead changes at 2.12 rounds per lead.
//
// v88 recorded this as "directors emitted research_problem:null despite
// receiving the contract", which reads as a role ignoring instructions. The role
// was working through a schema with no slot for the answer. The slot exists now;
// this is the part that reads it, so the floor is a check rather than a hope.
//
// What it deliberately does NOT do is block a method change. Bringing a
// different approach to the same question is the behaviour the rule wants, and
// it should be cheap. Only abandoning the question early is a violation.

const REQUIRED_METHODS_BEFORE_RETIRING = 3;

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

// Questions are restated by hand each round, so exact equality would count
// harmless rewording as a pivot. Compare on normalised content instead.
function questionKey(question) {
  return text(question).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 240);
}

function distinctApproaches(methodsTried) {
  const seen = new Set();
  for (const entry of asArray(methodsTried)) {
    const approach = typeof entry === "string" ? entry : text(entry?.approach);
    const key = questionKey(approach);
    if (key) seen.add(key);
  }
  return seen.size;
}

/**
 * Judge one director output's replacement hypotheses against the floor.
 *
 * Returns a finding per replacement that cannot be accounted for, so the caller
 * can surface them; an empty array means every proposed replacement either keeps
 * its question or has earned the right to leave it.
 */
function questionPersistenceFindings({ replacements, incumbentQuestion = null }) {
  const findings = [];
  const incumbent = questionKey(incumbentQuestion);

  asArray(replacements).forEach((replacement, index) => {
    const question = text(replacement?.research_problem_question);
    const methods = asArray(replacement?.methods_tried);
    const retires = replacement?.retires_the_question === true
      || text(replacement?.retires_the_question).toLowerCase() === "true";
    const label = text(replacement?.statement).slice(0, 80) || `replacement ${index + 1}`;

    // An unstated question is the pivot the rule cannot see. This is the case
    // that was 118 of 118, so it is named as its own finding rather than folded
    // into the floor check.
    if (!question) {
      findings.push({
        replacement: label,
        violation: "question_not_stated",
        detail:
          "replacement names no research_problem_question, so whether it keeps or abandons the "
          + "current question cannot be determined and the method floor cannot be counted",
      });
      return;
    }

    const changesQuestion = Boolean(incumbent) && questionKey(question) !== incumbent;
    if (!changesQuestion && !retires) {
      // The normal, wanted case: a different method for the same question.
      return;
    }

    const spent = distinctApproaches(methods);
    if (spent < REQUIRED_METHODS_BEFORE_RETIRING) {
      findings.push({
        replacement: label,
        violation: "question_retired_early",
        detail:
          `replacement moves off the current question with ${spent} distinct approach(es) recorded in `
          + `methods_tried, below the floor of ${REQUIRED_METHODS_BEFORE_RETIRING}. A falsification `
          + "retires the method, not the question: bring a different approach to the same question, or "
          + "record the approaches already spent on it.",
        distinct_methods_tried: spent,
        required: REQUIRED_METHODS_BEFORE_RETIRING,
      });
    }
  });

  return findings;
}

/**
 * Cycle-level view: how often the question actually moved, and how much of that
 * movement the floor can account for. This is the number that would have made
 * the v89 churn visible in one line.
 */
function questionChurnSummary(directorOutputs) {
  let replacements = 0;
  let stated = 0;
  let retiring = 0;
  const questions = new Set();

  for (const output of asArray(directorOutputs)) {
    for (const replacement of asArray(output?.replacement_hypotheses)) {
      replacements += 1;
      const question = questionKey(replacement?.research_problem_question);
      if (question) {
        stated += 1;
        questions.add(question);
      }
      if (replacement?.retires_the_question === true) retiring += 1;
    }
  }

  return {
    replacements_proposed: replacements,
    replacements_stating_a_question: stated,
    distinct_questions: questions.size,
    replacements_retiring_the_question: retiring,
    // The v89 reading: 118 proposed, 0 stating a question, so no floor was
    // evaluable and every pivot passed unexamined.
    accountable: replacements === 0 || stated === replacements,
  };
}

module.exports = {
  questionPersistenceFindings,
  questionChurnSummary,
  distinctApproaches,
  questionKey,
  REQUIRED_METHODS_BEFORE_RETIRING,
};
