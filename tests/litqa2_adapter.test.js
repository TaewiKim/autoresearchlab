"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { selectedIndex, scoreQuestion, aggregate } = require("../src/evals/benchmarks/litqa2_adapter");

const q = {
  id: "q1",
  question: "what is the hazard ratio?",
  options: ["0.72", "1.00", "1.35", "Insufficient information to answer"],
  answer_index: 0,
  source_doi: "10.1000/x",
};

test("selectedIndex resolves letter, option text, and free-text 'answer:'", () => {
  assert.equal(selectedIndex({ answer: "A" }, q.options), 0);
  assert.equal(selectedIndex({ answer: "1.35" }, q.options), 2);
  assert.equal(selectedIndex("I think the answer: C here", q.options), 2);
  assert.equal(selectedIndex({ answer: "" }, q.options), null);
});

test("correct answer + retrieved source", () => {
  const s = scoreQuestion({ response: { answer: "A", retrieved_dois: ["10.1000/x"] }, question: q });
  assert.equal(s.correct, true);
  assert.equal(s.answered, true);
  assert.equal(s.retrieved, true);
});

test("wrong answer counts as answered-but-incorrect", () => {
  const s = scoreQuestion({ response: { answer: "C" }, question: q });
  assert.equal(s.answered, true);
  assert.equal(s.correct, false);
});

test("choosing the unsure option is an abstention (answered=false), not wrong", () => {
  const s = scoreQuestion({ response: { answer: "D" }, question: q }); // "Insufficient information"
  assert.equal(s.abstained, true);
  assert.equal(s.answered, false);
  assert.equal(s.correct, false);
});

test("aggregate: accuracy/precision/coverage with abstention, retrieval recall", () => {
  const results = [
    { score: scoreQuestion({ response: { answer: "A", retrieved_dois: ["10.1000/x"] }, question: q }) }, // correct, retrieved
    { score: scoreQuestion({ response: { answer: "C" }, question: q }) }, // wrong, answered
    { score: scoreQuestion({ response: { answer: "D" }, question: q }) }, // abstain
  ];
  const agg = aggregate(results);
  assert.equal(agg.accuracy, round(1 / 3)); // 1 correct of 3
  assert.equal(agg.coverage, round(2 / 3)); // 2 answered of 3
  assert.equal(agg.precision, round(1 / 2)); // 1 correct of 2 answered
  assert.equal(agg.retrieval_recall, round(1 / 3)); // 1 retrieved of 3 with source_doi
});

function round(x) {
  return Math.round(x * 1000) / 1000;
}
