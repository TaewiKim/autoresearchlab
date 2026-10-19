"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { buildConclusionReview } = require("../src/reporting/conclusion_review");
const hypothesisProgress = require("../src/reporting/hypothesis_progress");
const { runtimeRoot } = require("../src/runtime/native_client");

// cycle-g-v75: the ledger denied a pivot at 07:39 and 07:40; at 07:42 the
// CONCLUSION review created followup-lab-director-33 telling the director to
// "narrow, split, replace, or demote the lead hypotheses". It was a third
// requery path and it referenced the ledger zero times.
function labWithLedger(decision) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ledger-"));
  // buildConclusionReview reads state under runtimeRoot(cwd), not cwd itself.
  const root = runtimeRoot(cwd);
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  // Write through the real appender: the ledger fail-closes on any record whose
  // audit_hash does not match, so a hand-written fixture reads as absent — which
  // is the correct treatment of a tampered record, and would have made this test
  // pass for the wrong reason.
  if (decision) {
    hypothesisProgress.appendDecisionEvent(root, "cyc", decision, fs, new Date(0).toISOString());
  }
  return cwd;
}

// A summary weak enough that hypothesisRegenerationActions fires.
const WEAK = {
  claim_count: 1,
  hypothesis_quality_score: 10,
  derivable_hypothesis_candidates: [],
  schema_quality: {},
  reasoning_graph: {},
  open_validation_gaps: [],
};

function requeryAction(root) {
  const review = buildConclusionReview({
    cwd: root,
    cycleId: "cyc",
    researcherView: { summary: WEAK, conclusion_score: 10, conclusion_blockers: ["alternative hypothesis families are still too limited"] },
    fs,
  });
  const actions = review?.review?.recommended_followup_actions || review?.recommended_followup_actions || [];
  return actions.find((a) => a.type === "lab_director_requery_followup");
}

test("under a ledger deny the conclusion review stops inviting a lead replacement", () => {
  const root = labWithLedger({
    decision: "deny",
    reason: "critical_memory_suppression_blocked_lead_still_improving",
    lead: "hyp:f199ba08",
    lead_statement: "primary_family=failure_boundary_modeling: fit overlap/ESS diagnostics",
    binding_rubric: { name: "reproducibility" },
  });
  const action = requeryAction(root);
  assert.ok(action, "the conclusion review must still ask for a requery");
  assert.match(action.description, /THE LEAD YOU MUST KEEP REFINING IS/);
  assert.match(action.description, /failure_boundary_modeling/);
  assert.match(action.description, /Replacing or demoting it is not available/);
  assert.doesNotMatch(action.description, /replace, or demote the lead hypotheses/);
  assert.equal(action.lead_supersession.lead, "hyp:f199ba08");
  assert.ok(action.challenge_questions.every((q) => !/replaced, or demoted/.test(q)));
});

test("with no deny recorded the conclusion review is unchanged", () => {
  const action = requeryAction(labWithLedger(null));
  assert.ok(action);
  assert.match(action.description, /narrow, split, replace, or demote the lead hypotheses/);
  assert.doesNotMatch(action.description, /KEEP REFINING/);
  assert.equal(action.lead_supersession, null);
});

test("an allow decision does not protect either", () => {
  const action = requeryAction(labWithLedger({ decision: "allow", reason: "lead_stalled_pivot_permitted", lead: "hyp:abc" }));
  assert.ok(action);
  assert.doesNotMatch(action.description, /KEEP REFINING/);
});
