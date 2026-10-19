// What a pivot has already cost, measured off the ledger.
//
// cycle-g-v85 halted on score_stagnation after 28 gate rounds and 12 lead
// changes -- 2.33 rounds per lead. The ledger denied each pivot and the deny was
// delivered to the director; the director pivoted anyway, which it is entitled
// to do. The harness constrains and informs; the director decides.
//
// What the directive never carried was the price. At 07:34 the lead
// hyp:8d6af9d40eee2b63 scored novelty 72 AND technical_quality 52, the cycle's
// best on both in one round. It was dropped 90 minutes later, the scores fell to
// 55 and 22, and nothing recovered before the halt. The directive said only that
// prior leads "died this way".
//
// churnCost reports both directions on purpose. On v85, 4 pivots landed worse
// and 6 landed better -- a directive that reported only the bad half would be
// advocacy, not evidence.

const test = require("node:test");
const assert = require("node:assert");

const { churnCost, buildProgressRecord } = require("../src/reporting/hypothesis_progress.js");

const CYCLE = "cycle-g-v85-20260826";

// Built through the module's own writer, so every record satisfies
// admitProgressRecord -- provenance, status and a matching audit_hash. A
// hand-rolled fixture is silently DENIED by the integrity check and every count
// comes back zero, which is the fail-closed behaviour working as intended.
let seq = 0;
function round(memoryId, rubric) {
  seq += 1;
  return buildProgressRecord({
    cycleId: CYCLE,
    round: seq,
    reviewLaneId: `followup-gatekeeper-${seq}`,
    statement: `statement for ${memoryId}`,
    hypothesisId: memoryId,
    rubric: Object.entries(rubric).map(([name, score]) => ({ name, score })),
    verdict: "reject",
    now: new Date(Date.UTC(2026, 7, 26, 0, seq)).toISOString(),
    eventId: `evt-${seq}`,
  });
}

function leadOf(records, index) {
  return records[index].memory_id;
}

test("it counts rounds, leads and the rate between them", () => {
  const records = [
    round("hyp:aaa", { novelty: 20, technical_quality: 20 }),
    round("hyp:aaa", { novelty: 30, technical_quality: 25 }),
    round("hyp:bbb", { novelty: 40, technical_quality: 30 }),
    round("hyp:ccc", { novelty: 10, technical_quality: 10 }),
  ];
  const cost = churnCost(records, CYCLE, leadOf(records, 2));
  assert.strictEqual(cost.gate_rounds, 4);
  assert.strictEqual(cost.lead_changes, 2);
  assert.strictEqual(cost.distinct_leads, 3);
  assert.strictEqual(cost.rounds_per_lead, 1.33);
});

test("it names the rubrics the protected lead holds the cycle record on", () => {
  const records = [
    round("hyp:aaa", { novelty: 72, technical_quality: 52 }),
    round("hyp:bbb", { novelty: 55, technical_quality: 22 }),
  ];
  const held = churnCost(records, CYCLE, leadOf(records, 0)).lead_holds_cycle_best;
  assert.deepStrictEqual(
    held.map((h) => `${h.rubric}=${h.score}`).sort(),
    ["novelty=72", "technical_quality=52"],
  );
  // And says nothing flattering about a lead that holds no record.
  assert.deepStrictEqual(churnCost(records, CYCLE, leadOf(records, 1)).lead_holds_cycle_best, []);
});

test("it reports pivots in both directions, not just the bad ones", () => {
  const records = [
    round("hyp:aaa", { novelty: 60, technical_quality: 60 }), // composite high
    round("hyp:bbb", { novelty: 10, technical_quality: 10 }), // worse
    round("hyp:ccc", { novelty: 90, technical_quality: 90 }), // better
  ];
  const cost = churnCost(records, CYCLE, leadOf(records, 0));
  assert.strictEqual(cost.pivots_that_scored_worse, 1);
  assert.strictEqual(cost.pivots_that_scored_better, 1);
});

test("rows without a rubric are not rounds", () => {
  const decision = {
    run_id: CYCLE,
    ts: "2026-08-26T00:00:00.000Z",
    event_type: "decision",
    decision: "pivot",
    audit_hash: "h",
    schema: "v1",
  };
  const records = [round("hyp:aaa", { novelty: 20 }), decision, round("hyp:aaa", { novelty: 30 })];
  const cost = churnCost(records, CYCLE, leadOf(records, 0));
  assert.strictEqual(cost.gate_rounds, 2);
  assert.strictEqual(cost.lead_changes, 0);
});

test("an empty ledger reports nothing rather than dividing by zero", () => {
  const cost = churnCost([], CYCLE, "hyp:aaa");
  assert.strictEqual(cost.gate_rounds, 0);
  assert.strictEqual(cost.distinct_leads, 0);
  assert.strictEqual(cost.rounds_per_lead, null);
  assert.deepStrictEqual(cost.lead_holds_cycle_best, []);
});

test("a single lead across many rounds is not churn", () => {
  const records = [
    round("hyp:aaa", { novelty: 20 }),
    round("hyp:aaa", { novelty: 30 }),
    round("hyp:aaa", { novelty: 40 }),
  ];
  const cost = churnCost(records, CYCLE, leadOf(records, 0));
  assert.strictEqual(cost.lead_changes, 0);
  assert.strictEqual(cost.rounds_per_lead, 3);
  assert.strictEqual(cost.pivots_that_scored_worse, 0);
});
