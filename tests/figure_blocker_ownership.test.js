"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  figureCitationFollowupActions,
  figureVerificationFollowupActions,
} = require("../src/reporting/document_reviews/figure_evidence");

// The recorded shape, taken from cycle-g-v89's own paper review: one flat row
// per check, NOT a figure carrying a list of its own checks. The first version
// of this fix assumed the nested shape, passed a test written against that
// assumption, and produced zero actions on the live data.
const RECORDED_CHECKS = [
  { figure_id: "fig:a", check: "cited_in_manuscript", passed: false, detail: "..." },
  { figure_id: "fig:a", check: "generator_is_the_lane_s_own", passed: true, detail: "..." },
  { figure_id: "fig:b", check: "cited_in_manuscript", passed: true, detail: "..." },
  { figure_id: "fig:c", check: "cited_in_manuscript", passed: false, detail: "..." },
];

test("an uncited figure becomes gate-required author work", () => {
  const actions = figureCitationFollowupActions(RECORDED_CHECKS);
  assert.equal(actions.length, 2, "one per uncited figure, deduplicated");
  assert.ok(actions[0].blocker_reasons[0].startsWith("fig:a"));
  assert.ok(actions[1].blocker_reasons[0].startsWith("fig:c"));
  for (const action of actions) {
    assert.equal(action.preferred_role, "author", "citing a figure is a sentence in the text");
    assert.equal(action.required_for_gate, true);
    assert.equal(action.priority, "critical");
  }
});

test("a cited figure asks for nothing", () => {
  assert.deepEqual(
    figureCitationFollowupActions([{ figure_id: "fig:b", check: "cited_in_manuscript", passed: true }]),
    [],
  );
});

// The request carries required_for_gate and the action used to drop it. A
// gate-required document action scores 9,900 in the task graph while everything
// else competes in the low hundreds, so the flag decides whether this is
// dispatched next or eventually.
test("verification actions keep the gate flag their request carried", () => {
  const [required] = figureVerificationFollowupActions([
    { figure_id: "fig:a", source_artifact: "artifacts/stats/a.json", required_for_gate: true },
  ]);
  assert.equal(required.required_for_gate, true);
  assert.equal(required.preferred_role, "gatekeeper", "the lane that drew it does not certify it");

  const [optional] = figureVerificationFollowupActions([{ figure_id: "fig:b" }]);
  assert.equal(optional.required_for_gate, false, "absent means not required, never undefined");
});
