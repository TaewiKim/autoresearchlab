"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchAnswer, evaluateTask, aggregate } = require("../src/evals/benchmarks/dabstep_adapter");

// matchAnswer is a faithful port of the OFFICIAL DABStep scorer
// (huggingface.co/spaces/adyen/DABstep, evaluation/scorer.py question_scorer) —
// the same standard the leaderboard SOTA numbers were measured with.

test("exact normalized match", () => {
  assert.equal(matchAnswer("NL", "NL"), true);
  assert.equal(matchAnswer(" nl ", "NL"), true);
  assert.equal(matchAnswer("BE", "NL"), false);
});

test("Not Applicable matching (official: cleaned equality, no n/a aliasing)", () => {
  assert.equal(matchAnswer("Not Applicable", "Not Applicable"), true);
  assert.equal(matchAnswer("N/A", "Not Applicable"), false); // official scorer rejects this
  assert.equal(matchAnswer("yes", "Not Applicable"), false);
});

test("numeric: semantically different values fail isclose(1e-4)", () => {
  assert.equal(matchAnswer("0.117667", "0.120132"), false); // diff 2.5e-3 > 1e-4
  assert.equal(matchAnswer("0.120132", "0.120132"), true);
  assert.equal(matchAnswer("0.1201321", "0.120132"), true); // within tolerance
});

test("numeric: float-noise at 1e-13 passes (official isclose tolerance)", () => {
  assert.equal(matchAnswer("-0.94810300000000", "-0.94810300000017"), true);
  assert.equal(matchAnswer("-0.5", "-0.7"), false);
});

test("numeric: larger values round to the shorter printed precision", () => {
  assert.equal(matchAnswer("7.789", "7.79"), true);
  assert.equal(matchAnswer("7.79", "7.79"), true);
  assert.equal(matchAnswer("116.13", "13.57"), false);
});

test("list answers are order-insensitive", () => {
  assert.equal(matchAnswer("B, A, C", "A, B, C"), true);
  assert.equal(matchAnswer("A, B", "A, B, C"), false);
});

test("numeric ID lists compare as lists, not one giant number", () => {
  assert.equal(matchAnswer("286, 381, 454", "454, 286, 381"), true);
  assert.equal(matchAnswer("286, 381, 454", "454, 286, 999"), false);
  assert.equal(matchAnswer("286, 381", "454, 286, 381"), false);
});

test("single-word subset rule (official)", () => {
  assert.equal(matchAnswer("BE", "B. BE"), true); // {be} ⊆ {b, be}
  assert.equal(matchAnswer("A. NL", "B. BE"), false);
});

test("evaluateTask uses the official scorer", () => {
  const task = { task_id: "1273", level: "hard", answer: "0.120132", guidelines: "rounded to 6 decimals" };
  assert.equal(evaluateTask({ task, predicted: "0.117667" }).match, false);
  assert.equal(evaluateTask({ task, predicted: "0.120132" }).match, true);
});

test("aggregate splits by level", () => {
  const agg = aggregate([
    { task_id: "1", level: "easy", match: true },
    { task_id: "2", level: "easy", match: true },
    { task_id: "3", level: "hard", match: false },
  ]);
  assert.equal(agg.accuracy, 0.667);
  assert.equal(agg.by_level.easy.accuracy, 1);
  assert.equal(agg.by_level.hard.accuracy, 0);
});
