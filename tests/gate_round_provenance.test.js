"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

// cycle-g-v76: 19 gatekeeper lanes scored a rubric, the ledger got 3 records, and
// the watchdog halted on activity_without_gate_progress. The round's
// source_message_id came from `reviews.find(...)` — the FIRST lane in the list —
// so it never changed as new gatekeepers arrived, and the idempotency guard read
// every later round as a redundant re-append. It only became load-bearing once
// lead identity was fixed and rounds started accruing to one lead.
function sourceLaneFor(reviews, cycleId) {
  const contributing = Array.from(
    new Set(reviews.map((r) => (r && (r.source_lane_id || r.lane_id)) || null).filter(Boolean).map(String)),
  ).sort();
  return contributing.length ? contributing.join("+") : `${cycleId}-gate-review`;
}

test("a new gatekeeper joining the aggregate changes the round's provenance", () => {
  const round1 = [{ lane_id: "gatekeeper-01" }, { lane_id: "gatekeeper-02" }];
  const round2 = [{ lane_id: "gatekeeper-01" }, { lane_id: "gatekeeper-02" }, { lane_id: "gatekeeper-03" }];
  assert.notEqual(sourceLaneFor(round1, "cyc"), sourceLaneFor(round2, "cyc"),
    "a genuinely new gatekeeper result must produce a new round");
});

test("re-aggregating the same gatekeepers is still redundant, whatever the order", () => {
  const a = [{ lane_id: "gatekeeper-02" }, { lane_id: "gatekeeper-01" }];
  const b = [{ lane_id: "gatekeeper-01" }, { lane_id: "gatekeeper-02" }];
  assert.equal(sourceLaneFor(a, "cyc"), sourceLaneFor(b, "cyc"),
    "the same set in a different order is the same round");
});

test("the old first-match rule could not tell those apart", () => {
  const first = (reviews) => (reviews.find((r) => r && (r.source_lane_id || r.lane_id)) || {}).lane_id;
  const round1 = [{ lane_id: "gatekeeper-01" }, { lane_id: "gatekeeper-02" }];
  const round2 = [{ lane_id: "gatekeeper-01" }, { lane_id: "gatekeeper-02" }, { lane_id: "gatekeeper-03" }];
  assert.equal(first(round1), first(round2), "old rule: identical provenance despite a new reviewer");
});

test("no lane ids at all still yields a stable fallback", () => {
  assert.equal(sourceLaneFor([{}], "cyc"), "cyc-gate-review");
});
