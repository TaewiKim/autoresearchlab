"use strict";

// LitQA2 adapter (search stage / Scout).
//
// LitQA2 (FutureHouse, part of LAB-Bench) is a multiple-choice benchmark over
// recent full-text scientific literature: questions are written so they cannot
// be answered without retrieving the relevant paper. Following LAB-Bench, every
// question includes an "insufficient information / unsure" option, so the agent
// may ABSTAIN. Metrics:
//   accuracy  = correct / total
//   precision = correct / answered        (answered = non-abstained)
//   coverage  = answered / total
// For the search variant we also score retrieval: did the agent retrieve the
// source paper (by DOI)?
//
// This probes the Scout search stage. formatHarnessInput() turns a question
// into the search input (question + options + permission to answer "unsure");
// running Scout and capturing {answer, retrieved_dois} is the live seam.

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function round(x) {
  return x == null ? null : Math.round(x * 1000) / 1000;
}

const UNSURE = /(insufficient|unsure|cannot (answer|be determined|determine)|not enough information|i don'?t know|no answer)/i;

// Resolve the option the response selected, as an option index (or null).
// Accepts response.answer as a letter ("C"), the option text, or free text
// containing "answer: <letter>".
function selectedIndex(response, options) {
  const opts = Array.isArray(options) ? options : [];
  let ans = response && typeof response === "object" ? response.answer ?? response.choice ?? "" : response;
  ans = String(ans || "").trim();
  // Extract an explicit "answer: X" letter from free text if present.
  const m = ans.match(/answer\s*[:=]\s*([A-Za-z])\b/i);
  if (m) ans = m[1];
  if (!ans) return null;
  // letter form
  if (/^[A-Za-z]$/.test(ans)) {
    const idx = ans.toUpperCase().charCodeAt(0) - 65;
    return idx >= 0 && idx < opts.length ? idx : null;
  }
  // exact option text
  const i = opts.findIndex((o) => norm(o) === norm(ans));
  return i >= 0 ? i : null;
}

function isAbstain(optionText, response) {
  if (response && typeof response === "object" && (response.abstain === true || norm(response.answer) === "unsure")) {
    return true;
  }
  return UNSURE.test(String(optionText || ""));
}

// question: { id, question, options:[...], answer_index | answer (text/letter),
//             source_doi? }
function goldIndex(question) {
  if (Number.isInteger(question.answer_index)) return question.answer_index;
  const opts = question.options || [];
  const a = String(question.answer ?? question.ideal ?? "").trim();
  if (/^[A-Za-z]$/.test(a)) return a.toUpperCase().charCodeAt(0) - 65;
  const i = opts.findIndex((o) => norm(o) === norm(a));
  return i;
}

function scoreQuestion({ response, question }) {
  const opts = question.options || [];
  const sel = selectedIndex(response, opts);
  const abstained = sel == null || isAbstain(opts[sel], response);
  const gold = goldIndex(question);
  const correct = !abstained && sel === gold;

  let retrieved = null;
  if (question.source_doi) {
    const dois = (response && response.retrieved_dois) || [];
    retrieved = Array.isArray(dois) && dois.some((d) => norm(d) === norm(question.source_doi));
  }
  return { answered: !abstained, correct, abstained, selected: sel, gold, retrieved };
}

function aggregate(results) {
  const n = results.length;
  if (!n) return { questions: 0, accuracy: null, precision: null, coverage: null, retrieval_recall: null };
  const correct = results.filter((r) => r.score.correct).length;
  const answered = results.filter((r) => r.score.answered).length;
  const withSource = results.filter((r) => r.score.retrieved != null);
  const retrieved = withSource.filter((r) => r.score.retrieved).length;
  return {
    questions: n,
    accuracy: round(correct / n),
    precision: answered ? round(correct / answered) : null,
    coverage: round(answered / n),
    retrieval_recall: withSource.length ? round(retrieved / withSource.length) : null,
  };
}

function formatHarnessInput(question) {
  return {
    benchmark: "litqa2",
    id: question.id || null,
    question: question.question || "",
    options: question.options || [],
    answer_instruction:
      "Answer by selecting one option letter; you MAY answer 'unsure' if the literature does not support a confident choice. Return retrieved_dois for the papers you used.",
  };
}

function evaluateQuestion({ question, response }) {
  return { id: question.id || null, score: scoreQuestion({ response, question }) };
}

module.exports = {
  selectedIndex,
  goldIndex,
  scoreQuestion,
  aggregate,
  formatHarnessInput,
  evaluateQuestion,
};
