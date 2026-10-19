"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const source = fs.readFileSync(
  require.resolve("../src/reporting/lab_director_research_notes.js"),
  "utf8",
);

// An unscored rubric is not a satisfied one.
//
// `Number(gateReview.score ?? gateReview.gate_score ?? 100) < 60` read a gate
// review with no score as a perfect one: the comparison went false, the
// director was never told the gate had rejected, and no requery action was
// raised. Absence became approval.
//
// Everything else in this runtime already fails closed here -- `average()`
// returns 0 for an empty rubric and counts an unscored item as 0 -- so this was
// the single place where a missing number was worth full marks.

test("a gate review with no score is read as zero, not as full marks", () => {
  assert.ok(
    source.includes("gateReview.gate_score ?? 0"),
    "the fallback must be 0",
  );
  assert.ok(
    !/gate_score \?\? 100/.test(source),
    "no path may treat an absent gate score as 100",
  );
});

test("no score default anywhere in this file grants marks for silence", () => {
  // Catches the pattern returning, in this file or any near neighbour of it:
  // a nullish-coalescing fallback to a passing number on a score-shaped field.
  const offenders = [...source.matchAll(/(\w*[Ss]core\w*)\s*\?\?\s*(\d+)/g)]
    .filter(([, , value]) => Number(value) >= 50);
  assert.deepEqual(
    offenders.map((m) => m[0]),
    [],
    "a missing score must never default to a passing value",
  );
});
