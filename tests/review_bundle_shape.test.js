"use strict";

// A template named like the file invites being written AS the file.
//
// `review_contract()` describes what the reviewer must produce under a key
// called `review_file`. That name reads as "here is the file" rather than "here
// is what goes IN the file", and on cycle-g-v91 scout-02 wrote the whole object
// verbatim:
//
//     { policy_version, review_file: { policy_version, context_hash,
//                                      reviews: [3 real reviews] } }
//
// while an earlier pass of the SAME lane had written the flat shape with 22.
// `screen_papers` reads `supplied.get("reviews")`, found nothing, admitted no
// paper, and the corpus stayed empty -- which is why the trend survey could emit
// no attributed problem or method and reported `survey_coverage_gaps` instead.
//
// Three real reviews, read against the right objective, invisible for one level
// of nesting.
//
// Both halves are fixed: the reader unwraps, and the key is renamed so the
// unwrap stops being needed rather than becoming the shape everyone writes.
// These tests pin the JS side of the same contract -- what the gate requires of
// a receipt once a review does reach it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SCREENING_PY = fs.readFileSync(
  path.join(__dirname, "..", "drivers/literature/search_lib/screening.py"),
  "utf8",
);

test("the queue no longer offers a key that reads like the file itself", () => {
  assert.ok(
    !SCREENING_PY.includes('"review_file": {"policy_version"'),
    "the template is still named review_file, which is what was copied verbatim",
  );
  assert.match(SCREENING_PY, /write_exactly_this_object_as_the_review_file/);
});

test("the queue says in words that the object is the whole file", () => {
  assert.match(SCREENING_PY, /The object above IS the whole file/);
  assert.match(SCREENING_PY, /do not wrap it in\s*"\s*"another key/);
});

test("the reader accepts both shapes", () => {
  // The unwrap is deliberately tolerant: the reviews were real and the only
  // thing wrong was the nesting, so refusing them would have been defensible
  // and useless.
  assert.match(SCREENING_PY, /def unwrap_review_bundle/);
  assert.match(SCREENING_PY, /supplied = unwrap_review_bundle\(reviews\)/);
  // Flat stays flat: a correct bundle must not be reshaped on the way in.
  // Flat stays flat: a correct bundle must not be reshaped on the way in. The
  // branch now also notes that the tolerance was consulted and did nothing,
  // which is how an unused coercion becomes findable -- so a recording line is
  // allowed between the test and the return, and the return must still hand
  // back the same object.
  assert.match(
    SCREENING_PY,
    /if isinstance\(reviews\.get\("reviews"\), list\):(?:\s*\n(?!\s*return)[^\n]*)*\s*\n\s*return reviews/,
  );
});

test("an unwrapped bundle keeps the context hash the gate binds to", () => {
  // The outer object carries the policy version and the inner the context hash,
  // so the merge has to take the inner and fall back outward -- a bundle that
  // lost its context_hash would be refused as surely as one nobody could read.
  assert.match(SCREENING_PY, /merged\.update\(nested\)/);
  assert.match(SCREENING_PY, /merged\.pop\("review_file", None\)/);
});
