"use strict";

// The requests reached the director's role plan and its prompt, the lane
// completed, and every request stayed pending -- because nothing read the
// decision back. `decideExperimentRequest` had no caller anywhere in the runtime,
// so the ledger had no way out of `pending` however the director answered.
//
// These pin the whole return path: the director's answer lands in the ledger, an
// adopted request becomes analyst work, and a decision without a reason is not a
// decision.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  recordExperimentRequests,
  readExperimentRequests,
  applyDirectorExperimentDecisions,
  adoptedExperimentFollowupActions,
} = require("../src/reporting/experiment_requests");

const CLAIM = "Rendering-derived acquisition beats a severity-only control";
const OTHER = "The result extends to venue-normal workloads";

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-loop-"));
  recordExperimentRequests({
    root,
    cycleId: "cycle",
    requests: [
      { claim_it_would_support: CLAIM, experiment: "mask the severity labels and break the monotone risk order" },
      { claim_it_would_support: OTHER, experiment: "evaluate independent complex scenes at full resolution" },
    ],
    source: "/lanes/author-01/result.json",
  });
  return root;
}

function writeDirectorLane(root, name, decisions, mtime = new Date()) {
  const dir = path.join(root, "lanes", "cycle", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify({ extracted_json: { experiment_request_decisions: decisions } }), "utf8");
  fs.utimesSync(file, mtime, mtime);
}

function statusOf(root, claim) {
  return readExperimentRequests({ root, cycleId: "cycle" }).requests
    .find((item) => item.claim_it_would_support === claim)?.status;
}

test("the director's answer reaches the ledger", () => {
  const root = scratch();
  assert.equal(statusOf(root, CLAIM), "pending");

  writeDirectorLane(root, "followup-lab-director-138", [
    { claim_it_would_support: CLAIM, decision: "adopt", reason: "the sham reproduces the arm; this settles it" },
    { claim_it_would_support: OTHER, decision: "decline", reason: "out of budget this cycle; revisit after the discriminator" },
  ]);

  const outcome = applyDirectorExperimentDecisions({ root, cycleId: "cycle" });
  assert.equal(outcome.applied.length, 2);
  assert.equal(statusOf(root, CLAIM), "adopted");
  assert.equal(statusOf(root, OTHER), "declined");
});

test("an adopted request becomes analyst work carrying its licensing and refuting results", () => {
  const root = scratch();
  writeDirectorLane(root, "followup-lab-director-138", [
    { claim_it_would_support: CLAIM, decision: "adopt", reason: "settles the sham parity" },
  ]);
  applyDirectorExperimentDecisions({ root, cycleId: "cycle" });

  const actions = adoptedExperimentFollowupActions({ root, cycleId: "cycle" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preferred_role, "analyst");
  assert.equal(actions[0].type, "author_requested_experiment");
  assert.match(actions[0].description, /mask the severity labels/);
  assert.equal(actions[0].experiment_request.adopted_because, "settles the sham parity");
});

test("a decision without a reason is not a decision", () => {
  // Declining without one is indistinguishable from not having read it.
  const root = scratch();
  writeDirectorLane(root, "followup-lab-director-138", [
    { claim_it_would_support: CLAIM, decision: "decline" },
  ]);
  const outcome = applyDirectorExperimentDecisions({ root, cycleId: "cycle" });
  assert.equal(outcome.applied.length, 0);
  assert.equal(statusOf(root, CLAIM), "pending");
  assert.match(outcome.skipped[0].why, /requires a reason/);
});

test("a later lane may reverse an earlier decision, and an unanswered request stays pending", () => {
  const root = scratch();
  writeDirectorLane(root, "followup-lab-director-138",
    [{ claim_it_would_support: CLAIM, decision: "decline", reason: "not yet" }],
    new Date(Date.now() - 60_000));
  writeDirectorLane(root, "followup-lab-director-139",
    [{ claim_it_would_support: CLAIM, decision: "adopt", reason: "the sham changed the picture" }],
    new Date());

  applyDirectorExperimentDecisions({ root, cycleId: "cycle" });
  assert.equal(statusOf(root, CLAIM), "adopted");
  assert.equal(statusOf(root, OTHER), "pending", "a request nobody answered is still a question");
});

test("silence is counted only against a lane that was actually shown the request", () => {
  // Delivery was proven at every layer -- ledger, role plan, prompt, contract
  // field and rule -- and three director lanes in a row returned no decision,
  // because omitting one cost nothing. The count is what a guard can act on.
  const { unansweredExperimentRequests } = require("../src/reporting/experiment_requests");
  const root = scratch();

  const shown = (name, keys, decisions = [], mtime = new Date()) => {
    const dir = path.join(root, "lanes", "cycle", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "role-plan.json"),
      JSON.stringify({ pending_experiment_requests: keys.map((c) => ({ claim_it_would_support: c })) }),
      "utf8",
    );
    const file = path.join(dir, "result.json");
    fs.writeFileSync(file, JSON.stringify({ extracted_json: { experiment_request_decisions: decisions } }), "utf8");
    fs.utimesSync(file, mtime, mtime);
  };

  // Two lanes shown the request and silent; one lane never shown it.
  shown("followup-lab-director-140", [CLAIM]);
  shown("followup-lab-director-141", [CLAIM]);
  shown("followup-lab-director-142", []);
  applyDirectorExperimentDecisions({ root, cycleId: "cycle" });

  assert.equal(unansweredExperimentRequests({ root, cycleId: "cycle", minIgnored: 3 }).length, 0,
    "two silences is not yet a refusal");
  assert.equal(unansweredExperimentRequests({ root, cycleId: "cycle", minIgnored: 2 }).length, 1);

  // A third lane that WAS shown it crosses the threshold.
  shown("followup-lab-director-143", [CLAIM]);
  applyDirectorExperimentDecisions({ root, cycleId: "cycle" });
  assert.equal(unansweredExperimentRequests({ root, cycleId: "cycle", minIgnored: 3 }).length, 1);

  // And answering clears it, whichever way the answer goes.
  shown("followup-lab-director-144", [CLAIM], [
    { claim_it_would_support: CLAIM, decision: "decline", reason: "the budget goes to the venue-scale run first" },
  ]);
  applyDirectorExperimentDecisions({ root, cycleId: "cycle" });
  assert.equal(unansweredExperimentRequests({ root, cycleId: "cycle", minIgnored: 3 }).length, 0);
});

test("an undecided request blocks the paper and asks the director, not the author", () => {
  const { undecidedExperimentFindings } = require("../src/reporting/experiment_requests");
  const root = scratch();
  const { blockers, actions } = undecidedExperimentFindings({ root, cycleId: "cycle" });

  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /has not been decided/);
  assert.match(blockers[0], /the director owns the decision/);
  assert.ok(actions.every((item) => item.preferred_role === "lab-director"));
  assert.ok(actions.every((item) => item.required_for_gate === true));
  assert.match(actions[0].description, /adopt or decline, with a reason either way/);
});

test("the pivot guard denies only on repeated silence, and never when unwired", () => {
  const { evaluateLeadSupersession } = require("../src/reporting/hypothesis_progress");
  const denied = evaluateLeadSupersession({
    records: [],
    cycleId: "cycle",
    ignoredExperimentRequests: [{ experiment: "mask the severity labels" }],
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "unanswered_experiment_request");
  assert.match(denied.director_guidance, /Declining is a perfectly good answer/);

  // An unwired caller passes nothing and must deny nothing on this ground.
  const open = evaluateLeadSupersession({ records: [], cycleId: "cycle" });
  assert.notEqual(open.reason, "unanswered_experiment_request");
});

// MEASURED on cycle-g-v89: 18 requests, 16 declined, 0 adopted, 2 pending -- and
// the eighteen are three experiments asked over and over in new words. An
// undecided request is a gate blocker, so the manuscript sat at 65 against a raw
// score of 100, held by two blockers naming runs already refused sixteen times.
//
// Matching a reworded claim to its decided twin was tried first and the data
// refused it: same-experiment pairs scored 0.03-0.90 and different-experiment
// pairs 0.04-0.47, so no threshold separates them. What needs no guess is the
// programme's own answer rate.
test("a channel that has refused everything instructs the author, not blocks the paper", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const {
    recordExperimentRequests,
    decideExperimentRequest,
    undecidedExperimentFindings,
  } = require("../src/reporting/experiment_requests");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-"));
  const cycleId = "cycle-01";

  const ask = (claim) =>
    recordExperimentRequests({
      root,
      cycleId,
      requests: [{ claim_it_would_support: claim, experiment: `run something for ${claim}` }],
      source: "followup-author-01",
    });

  // Five refusals, each for a differently worded ask.
  for (let i = 0; i < 5; i += 1) {
    ask(`claim number ${i}`);
    decideExperimentRequest({
      root,
      cycleId,
      claim: `claim number ${i}`,
      adopt: false,
      reason: "the research budget is spent",
      decidedBy: "lab-director",
    });
  }
  // A sixth ask, undecided.
  ask("claim number 5, reworded");

  const findings = undecidedExperimentFindings({ root, cycleId });
  assert.deepEqual(findings.blockers, [], "the paper is no longer held by a refused channel");

  const authorAction = findings.actions.find((a) => a.preferred_role === "author");
  assert.ok(authorAction, "the author is told the runs are not coming");
  assert.match(authorAction.description, /declined 5 experiment request\(s\) and adopted none/);
  assert.match(authorAction.description, /Do not withdraw the finding -- bound it/);
  assert.equal(authorAction.required_for_gate, true);

  // The director still owes the answer; it just no longer holds the manuscript.
  const directorAction = findings.actions.find((a) => a.preferred_role === "lab-director");
  assert.ok(directorAction);
  assert.equal(directorAction.required_for_gate, false);
});

// A channel still weighing requests one at a time must keep its hold: a pending
// request there is a real question, not a refused policy.
test("one adoption keeps the channel live, and the blocker with it", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const {
    recordExperimentRequests,
    decideExperimentRequest,
    undecidedExperimentFindings,
  } = require("../src/reporting/experiment_requests");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-live-"));
  const cycleId = "cycle-01";
  const ask = (claim) =>
    recordExperimentRequests({
      root,
      cycleId,
      requests: [{ claim_it_would_support: claim, experiment: `run something for ${claim}` }],
      source: "followup-author-01",
    });

  for (let i = 0; i < 6; i += 1) {
    ask(`claim number ${i}`);
    decideExperimentRequest({
      root,
      cycleId,
      claim: `claim number ${i}`,
      adopt: i === 0, // one genuine adoption
      reason: i === 0 ? "worth the budget" : "not this one",
      decidedBy: "lab-director",
    });
  }
  ask("a genuinely new question");

  const findings = undecidedExperimentFindings({ root, cycleId });
  assert.equal(findings.blockers.length, 1, "a live channel still holds the paper");
  assert.equal(findings.actions[0].preferred_role, "lab-director");
});
