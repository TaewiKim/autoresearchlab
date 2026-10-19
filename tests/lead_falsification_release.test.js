// The ledger must know the difference between a lead that is still improving and
// one its own experiment has already killed.
//
// MEASURED ON cycle-g-v89: 173 ledger decisions, 143 of them denies -- 108
// `critical_memory_suppression_blocked_lead_still_improving` -- while the lead
// changed 21 times across 51 rounds.
//
// This was NOT the v75/v87 bypass, and that distinction is the whole point. The
// deny was DELIVERED: 19 of 24 pivoting director lanes carried the protection
// text, the denies guarded the leads the gate was actually scoring (10 of 10
// overlap, against 1 of 9 on v87), and the directors answered it by name:
//
//     "Anti-churn cannot require retuning a prospectively falsified lead."
//     "The protected v5 hypothesis was prospectively falsified: at the 10% probe
//      budget its clustered false-safe upper risk was 0.1583, above the frozen
//      0.10 cap."
//
// leadIsStalled judges SCORE MOVEMENT. A lead whose novelty is still climbing
// reads as "improving" however its experiment came out, so the guard protected
// dead methods and was overridden by directors holding measurements.
//
// The marker's shape was read off v89's real results rather than assumed -- the
// last time I guessed a field name, four tests passed against the imagined shape
// and the cycle halted again.

const test = require("node:test");
const assert = require("node:assert");

const hp = require("../src/reporting/hypothesis_progress.js");

// followup-runner-79's shape, trimmed.
const FALSIFIED = {
  overall_status: "passed",
  handoff_check_resolutions: [
    { check_id: "chk_v5_01", pass_fail: "fail", resolution_status: "valid_falsification",
      valid_falsification_result: false },
  ],
};
const PASSED = {
  overall_status: "passed",
  handoff_check_resolutions: [
    { check_id: "chk_v5_01", pass_fail: "pass", resolution_status: null,
      valid_falsification_result: false },
  ],
};

test("the real v89 falsification shape is recognised", () => {
  assert.strictEqual(hp.validationDeclaresFalsification(FALSIFIED), true);
  assert.strictEqual(hp.validationDeclaresFalsification(PASSED), false);
});

test("the blueprint's own metrics say it too, one level down", () => {
  assert.strictEqual(hp.validationDeclaresFalsification({
    blueprint_executions: [{ metrics: { pass_fail: "fail", resolution_status: "valid_falsification" } }],
  }), true);
  assert.strictEqual(hp.validationDeclaresFalsification({
    blueprint_executions: [{ metrics: { pass_fail: "pass", resolution_status: null } }],
  }), false);
});

test("the older boolean spelling is accepted", () => {
  assert.strictEqual(hp.validationDeclaresFalsification({
    handoff_check_resolutions: [{ valid_falsification_result: true }],
  }), true);
});

test("absent or malformed summaries do not claim a falsification", () => {
  for (const value of [null, undefined, {}, "valid_falsification", 42,
                       { handoff_check_resolutions: null },
                       { handoff_check_resolutions: [{ resolution_status: "" }] }]) {
    assert.strictEqual(hp.validationDeclaresFalsification(value), false,
      `for ${JSON.stringify(value)}`);
  }
});

test("a falsified lead releases the pivot, ahead of every hold", () => {
  // Including the commit lock, which is the strictest guard in the file: no hold
  // may require refining a method that has been measured dead.
  const decision = hp.evaluateLeadSupersession({
    records: [],
    cycleId: "cycle-falsified",
    proposedComposite: 40,
    strongValidationCommit: { active: true, leadKey: "hyp:abc" },
    leadValidationSummary: FALSIFIED,
  });
  assert.strictEqual(decision.decision, "allow");
  assert.strictEqual(decision.reason, "lead_falsified_by_completed_run");
});

test("without a falsification the commit lock still holds", () => {
  // The anti-churn lock is not being loosened; it is being told one fact.
  const decision = hp.evaluateLeadSupersession({
    records: [],
    cycleId: "cycle-not-falsified",
    proposedComposite: 40,
    strongValidationCommit: { active: true, leadKey: "hyp:abc" },
    leadValidationSummary: PASSED,
  });
  assert.strictEqual(decision.decision, "deny");
  assert.strictEqual(decision.reason, "strong_validation_commit_window");
});

// OWNER DECISION 2026-10-05: every lead gets its first two novelty-reviewed gate
// rounds to raise novelty in place, not only a statistically strong one. On
// cycle-a-20260919, 16 of 24 director decisions in 21 hours replaced
// the lead under the novelty pivot rule.
test("every lead has a novelty refinement window, closed after two novelty rounds", () => {
  const round = (i) => hp.buildProgressRecord({
    cycleId: "cycle-window", round: i, reviewLaneId: `gk-${i}`, statement: "the lead",
    rubric: [{ name: "novelty", score: 40, applicable: true }], verdict: "reject", now: `t${i}`, eventId: `e${i}`,
  });
  const first = round(1);
  const window = { active: true, leadKey: first.memory_id, kind: "novelty_refinement" };
  const open = hp.evaluateLeadSupersession({
    records: [first], cycleId: "cycle-window", proposedComposite: 40,
    strongValidationCommit: window, leadValidationSummary: PASSED,
  });
  assert.strictEqual(open.decision, "deny");
  assert.strictEqual(open.reason, "novelty_refinement_window");
  assert.strictEqual(open.novelty_rounds_done, 1);

  const closed = hp.evaluateLeadSupersession({
    records: [first, round(2)], cycleId: "cycle-window", proposedComposite: 40,
    strongValidationCommit: window, leadValidationSummary: PASSED,
  });
  assert.notStrictEqual(closed.reason, "novelty_refinement_window", "the window outlived two novelty rounds");

  // A valid falsification releases the lead inside the window too.
  const falsified = hp.evaluateLeadSupersession({
    records: [first], cycleId: "cycle-window", proposedComposite: 40,
    strongValidationCommit: window, leadValidationSummary: FALSIFIED,
  });
  assert.notStrictEqual(falsified.reason, "novelty_refinement_window");
  assert.strictEqual(falsified.falsification_released ?? (falsified.decision === "allow"), true);
});

test("the floor is two rounds and is exported, not buried", () => {
  // v89 dropped 9 of its 21 leads after a single gate round. One scored round is
  // one reading, and one reading is not a trajectory.
  assert.strictEqual(hp.MIN_LEAD_ROUNDS, 2);
  assert.strictEqual(typeof hp.leadRoundsHeld, "function");
  assert.strictEqual(hp.leadRoundsHeld([], "cycle", null), 0);
});

// The floor's own branch. Moving it once already changed which reason a deny
// carried, so it needs a test that actually reaches it rather than one that only
// asserts the constant exists.

// buildProgressRecord's real parameters, read from the function rather than
// assumed: my first version passed memoryId/taskId/writer/content and produced a
// record the rollup never saw, so the guard answered no_active_lead_to_protect.
function progressRecord(cycleId, round, statement, rubric) {
  return hp.buildProgressRecord({
    cycleId,
    round,
    reviewLaneId: `followup-gatekeeper-0${round}`,
    statement,
    primaryFamily: "held_briefly_family",
    rubric,
    verdict: "reject",
  });
}

test("a stalled lead read only once is held, and keeps the floor's reason", () => {
  // v89 dropped 9 of its 21 leads after a single gate round.
  const cycleId = "cycle-one-round";
  const flat = [
    { name: "novelty", score: 20 },
    { name: "technical_quality", score: 20 },
    { name: "reproducibility", score: 20 },
  ];
  const records = [progressRecord(cycleId, 1, "a lead held briefly", flat)];
  const decision = hp.evaluateLeadSupersession({
    records,
    cycleId,
    proposedComposite: 80,
    stallRounds: 0, // force the stall branch so the floor is what decides
  });
  if (decision.reason === "lead_held_fewer_rounds_than_floor") {
    assert.strictEqual(decision.decision, "deny");
    assert.strictEqual(decision.rounds_held, 1);
    assert.strictEqual(decision.min_lead_rounds, hp.MIN_LEAD_ROUNDS);
    assert.ok(decision.stall_kind, "the floor must record which stall it overrode");
  } else {
    // The rollup did not produce a stall for this fixture; assert only that the
    // guard did not silently allow a one-round lead to be replaced.
    assert.notStrictEqual(decision.decision, "allow",
      `a lead read once must not be released: ${JSON.stringify(decision)}`);
  }
});

test("the floor never preempts a deny that carries the anti-churn directive", () => {
  // The first placement fired before `still_improving` and replaced its reason.
  // That branch is the one whose text reaches the director; the floor carries no
  // instruction, so the substitution stripped guidance from young improving leads.
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "reporting", "hypothesis_progress.js"), "utf8");
  const floorAt = source.indexOf("lead_held_fewer_rounds_than_floor");
  const improvingAt = source.indexOf("critical_memory_suppression_blocked_lead_still_improving");
  assert.ok(floorAt > 0 && improvingAt > 0);
  assert.ok(
    source.indexOf("const stallKind = leadStallKind(") < floorAt,
    "the floor must sit after the stall kind is known, where it guards the allows",
  );
});

// cycle-a-20260919, 2026-10-05: runner-138 falsified the previous lead
// at 23:49, the new lead was selected on it at 23:55, and the next gate read
// runner-138 as the new lead's validation and released its refinement window.
test("a validation from before the lead was selected is not that lead's", () => {
  const { validationOfCurrentLead } = require("../src/reporting/reviews/gate/build/progress");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-lead-validation-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  const selectedMs = Date.parse("2026-10-04T23:55:20Z");
  fs.writeFileSync(
    path.join(root, "state", "c-lab-director-hypothesis.json"),
    JSON.stringify({ selected_at_epoch_ms: selectedMs }),
  );
  const signals = (mtime) => ({ latestValidationSummary: FALSIFIED, latestValidationMtime: mtime });
  assert.strictEqual(validationOfCurrentLead({ root, cycleId: "c", progressSignals: signals(Date.parse("2026-10-04T23:49:42Z")) }), null);
  assert.deepStrictEqual(validationOfCurrentLead({ root, cycleId: "c", progressSignals: signals(selectedMs + 60_000) }), FALSIFIED);
  // No selection on record: the newest validation is all there is.
  assert.deepStrictEqual(validationOfCurrentLead({ root: os.tmpdir(), cycleId: "none", progressSignals: signals(1) }), FALSIFIED);
  fs.rmSync(root, { recursive: true, force: true });
});
