"use strict";

// The author asked for two experiments and nobody was listening.
//
// Clause 1e gives the author a third option between overclaiming and hedging:
// name the run that would license the sentence it cannot yet write. The first
// draft to read it used the option well -- a paired preregistered packet with
// and without the sham arm, and external validation on new scene families, each
// with the result that would license the claim and the result that would refute
// it. Those requests then sat in the lane's result.json, because the field was
// added to the contract and no consumer was wired.
//
// Owner routing: the DIRECTOR adopts, the ANALYST designs. These tests pin the
// parts that keep that from decaying into either extreme -- the manuscript
// setting the agenda, or the requests evaporating whenever the director is busy.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  recordExperimentRequests,
  readExperimentRequests,
  pendingExperimentRequests,
  decideExperimentRequest,
  adoptedExperimentFollowupActions,
} = require("../src/reporting/experiment_requests");

const CYCLE = "cg-gate-test-requests";

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-requests-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  return root;
}

const SHAM_REQUEST = {
  claim_it_would_support:
    "The sham audit shows that the benchmark catches a confound a conventional evaluation would publish.",
  why_current_evidence_is_short:
    "The artifacts establish parity but no conventional-style evaluation was run.",
  experiment: "Produce two preregistered packets from the same run set, with and without the sham arm.",
  what_it_would_measure: "whether the no-sham packet supports a rendering-aware claim",
  result_that_licenses_the_claim: "no-sham packet supports it and the full packet rejects it",
  result_that_refutes_it: "both packets reach the same conclusion",
};

const BOUND_REQUEST = {
  claim_it_would_support: "The policy holds clustered false-safe upper 95% at or below 0.10 across families.",
  experiment: "Run prospectively frozen external validation on new scene families.",
  result_that_licenses_the_claim: "both budget modes at or below 0.10 with no retuning",
};

test("a request needs both a claim and an experiment to enter the ledger", () => {
  // Same fail-closed shape as every other decision record here: half an entry
  // directs nothing and cannot be designed.
  const root = scratchRoot();
  const ledger = recordExperimentRequests({
    root,
    cycleId: CYCLE,
    requests: [
      SHAM_REQUEST,
      { claim_it_would_support: "a claim with no experiment behind it" },
      { experiment: "a run supporting no stated claim" },
      { claim_it_would_support: "   ", experiment: "   " },
    ],
  });
  assert.equal(ledger.requests.length, 1);
  assert.equal(ledger.requests[0].status, "pending");
  assert.equal(ledger.requests[0].decision, null);
});

test("the analyst gets nothing until the director adopts", () => {
  // The whole point of the routing: an unreviewed request must not become work.
  const root = scratchRoot();
  recordExperimentRequests({ root, cycleId: CYCLE, requests: [SHAM_REQUEST, BOUND_REQUEST] });
  assert.equal(pendingExperimentRequests({ root, cycleId: CYCLE }).length, 2);
  assert.equal(adoptedExperimentFollowupActions({ root, cycleId: CYCLE }).length, 0);

  const decided = decideExperimentRequest({
    root,
    cycleId: CYCLE,
    claim: SHAM_REQUEST.claim_it_would_support,
    adopt: true,
    reason: "the instrument claim is the cycle's strongest and this is the run that settles it",
  });
  assert.equal(decided.ok, true);

  const actions = adoptedExperimentFollowupActions({ root, cycleId: CYCLE });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preferred_role, "analyst");
  assert.match(actions[0].description, /design the experiment the author requested/);
  // The interpretation travels with the design, because an experiment whose
  // meaning is decided afterwards is what the preregistration rule here prevents.
  assert.equal(
    actions[0].experiment_request.result_that_licenses_the_claim,
    SHAM_REQUEST.result_that_licenses_the_claim,
  );
  assert.equal(
    actions[0].experiment_request.result_that_refutes_it,
    SHAM_REQUEST.result_that_refutes_it,
  );
  assert.match(actions[0].experiment_request.adopted_because, /strongest/);
});

test("a decision without a reason is refused in both directions", () => {
  const root = scratchRoot();
  recordExperimentRequests({ root, cycleId: CYCLE, requests: [SHAM_REQUEST] });
  for (const adopt of [true, false]) {
    const result = decideExperimentRequest({
      root,
      cycleId: CYCLE,
      claim: SHAM_REQUEST.claim_it_would_support,
      adopt,
      reason: "   ",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /requires a reason/);
  }
  assert.equal(pendingExperimentRequests({ root, cycleId: CYCLE }).length, 1);
});

test("a declined request stays in the record with why", () => {
  // So a later cycle can see that the question was asked and answered, rather
  // than never raised.
  const root = scratchRoot();
  recordExperimentRequests({ root, cycleId: CYCLE, requests: [BOUND_REQUEST] });
  decideExperimentRequest({
    root,
    cycleId: CYCLE,
    claim: BOUND_REQUEST.claim_it_would_support,
    adopt: false,
    reason: "external families need a data-acquisition cycle this programme has not scheduled",
  });
  const stored = readExperimentRequests({ root, cycleId: CYCLE }).requests;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "declined");
  assert.match(stored[0].decision.reason, /data-acquisition cycle/);
  assert.equal(pendingExperimentRequests({ root, cycleId: CYCLE }).length, 0);
  assert.equal(adoptedExperimentFollowupActions({ root, cycleId: CYCLE }).length, 0);
});

test("re-raising a decided request does not reopen the decision", () => {
  // The author reworks its draft every round and will restate the same request.
  // A decision the director already made must not be silently undone by that.
  const root = scratchRoot();
  recordExperimentRequests({ root, cycleId: CYCLE, requests: [SHAM_REQUEST] });
  decideExperimentRequest({
    root,
    cycleId: CYCLE,
    claim: SHAM_REQUEST.claim_it_would_support,
    adopt: false,
    reason: "out of scope for this cycle",
  });

  recordExperimentRequests({
    root,
    cycleId: CYCLE,
    requests: [{ ...SHAM_REQUEST, experiment: "the same request, reworded by a later draft" }],
  });

  const stored = readExperimentRequests({ root, cycleId: CYCLE }).requests;
  assert.equal(stored.length, 1, "the same claim is the same request");
  assert.equal(stored[0].status, "declined");
  assert.match(stored[0].decision.reason, /out of scope/);
  assert.match(stored[0].experiment, /reworded by a later draft/, "the wording still refreshes");
});
