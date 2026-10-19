"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseMarkers,
  valueMatches,
  scoreQuestion,
  aggregate,
  formatHarnessInput,
} = require("../src/evals/benchmarks/dabench_adapter");

test("parses @name[value] markers into per-name lists (preserves duplicates)", () => {
  const m = parseMarkers("result: @mean_fare[34.65], @median_fare_class1[69.30] done");
  assert.deepEqual(m.mean_fare, ["34.65"]);
  assert.deepEqual(m.median_fare_class1, ["69.30"]);
  // repeated names (per-group answers) are preserved as a multiset
  const r = parseMarkers("@r[0.38], @r[0.78], @r[0.56]");
  assert.deepEqual(r.r, ["0.38", "0.78", "0.56"]);
});

test("repeated-name answers are matched as a multiset (per-group questions)", () => {
  const gold = [
    { name: "r", value: 0.38, decimals: 2 },
    { name: "r", value: 0.78, decimals: 2 },
    { name: "r", value: 0.56, decimals: 2 },
  ];
  const s = scoreQuestion({ response: "@r[0.56], @r[0.38], @r[0.78]", gold });
  assert.equal(s.all_correct, true);
  assert.equal(s.correct, 3);
});

test("numeric match rounds to the specified decimals", () => {
  assert.equal(valueMatches("34.6542", 34.65, 2), true);
  assert.equal(valueMatches("34.66", 34.65, 2), false);
  assert.equal(valueMatches("$34.6542", 34.65, 2), true); // strips currency/commas
});

test("categorical match is trimmed/case-insensitive", () => {
  assert.equal(valueMatches(" Male ", "male"), true);
  assert.equal(valueMatches("female", "male"), false);
});

test("question correct only if ALL sub-answers match (ABQ semantics)", () => {
  const gold = [
    { name: "a", value: 1.0, decimals: 2 },
    { name: "b", value: 2.0, decimals: 2 },
  ];
  const all = scoreQuestion({ response: "@a[1.00], @b[2.00]", gold });
  assert.equal(all.all_correct, true);
  assert.equal(all.subquestion_accuracy, 1);

  const partial = scoreQuestion({ response: "@a[1.00], @b[9.99]", gold });
  assert.equal(partial.all_correct, false);
  assert.equal(partial.correct, 1);
  assert.equal(partial.subquestion_accuracy, 0.5);
});

test("missing marker counts as wrong sub-answer", () => {
  const s = scoreQuestion({ response: "@a[1.00]", gold: [{ name: "a", value: 1 }, { name: "b", value: 2 }] });
  assert.equal(s.subs.find((x) => x.name === "b").got, null);
  assert.equal(s.all_correct, false);
});

test("aggregate computes ABQ / APSQ / AUSQ and by-level", () => {
  const results = [
    { level: "easy", score: scoreQuestion({ response: "@a[1]", gold: [{ name: "a", value: 1 }] }) },
    { level: "hard", score: scoreQuestion({ response: "@a[1], @b[0]", gold: [{ name: "a", value: 1 }, { name: "b", value: 2 }] }) },
  ];
  const agg = aggregate(results);
  assert.equal(agg.ABQ, 0.5); // 1 of 2 fully correct
  assert.equal(agg.APSQ, 0.75); // (1 + 0.5)/2
  assert.equal(agg.AUSQ, 0.667); // 2 correct of 3 sub-answers
  assert.equal(agg.by_level.easy.ABQ, 1);
  assert.equal(agg.by_level.hard.ABQ, 0);
});

test("formatHarnessInput requires closed-form answers", () => {
  const input = formatHarnessInput({ id: "q1", file_name: "t.csv", question: "mean?", format: "@m[v]", level: "easy" });
  assert.equal(input.benchmark, "infiagent-dabench");
  assert.equal(input.csv, "t.csv");
  assert.match(input.answer_format_instruction, /@answer_name\[value\]/);
});
