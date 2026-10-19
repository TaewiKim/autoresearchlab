"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  evaluateLeadSupersession,
  buildProgressRecord,
  STALL_ROUNDS,
} = require("../src/reporting/hypothesis_progress");
const {
  authoritativeGateFollowupActions,
  leadProtectionPrefix,
} = require("../src/reporting/reviews/gate/actions");
const { stallFindings } = require("../src/orchestrator/cycle_progress");

// The state that issued 335 of cycle-g-v89's 365 pivot allows: a lead whose
// newest completed validation reports a valid falsification.
const FALSIFIED = {
  handoff_check_resolutions: [
    { check_id: "kill-condition", valid_falsification_result: true },
  ],
};

const CYCLE = "cycle";
const QUESTION = "residual reuse stops beating a fresh render at severity s";

// A lead has to exist, and to have had its fair window, before the falsification
// branch is reached at all: the anti-suppression guard protects a young or still
// improving incumbent first, and rightly.
const RECORDS = Array.from({ length: STALL_ROUNDS + 1 }, (_, index) => index + 1).map((round) =>
  buildProgressRecord({
    cycleId: CYCLE,
    round,
    reviewLaneId: `gk-${round}`,
    statement: QUESTION,
    rubric: [
      { name: "novelty", score: 58, applicable: true },
      { name: "technical_quality", score: 50, applicable: true },
    ],
    verdict: "challenge",
    now: `t${round}`,
    eventId: `evt-${round}`,
  }),
);

function decide(extra) {
  return evaluateLeadSupersession({
    records: RECORDS,
    cycleId: CYCLE,
    leadValidationSummary: FALSIFIED,
    ...extra,
  });
}

test("a caller that looked and found no replacement denies, with guidance", () => {
  const decision = decide({ replacementLookupPerformed: true });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "falsification_pivot_states_no_replacement");
  assert.match(decision.director_guidance, /retires the METHOD/);
});

test("a falsification-accountability deny requests a replacement instead of protecting the retired lead", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-03: this exact state was
  // emitted repeatedly while runner audit lanes completed: falsification was
  // released, no replacement was recorded, and the director was told not to
  // author the replacement required to clear the denial.
  const blocked = decide({ replacementLookupPerformed: true });
  const actions = authoritativeGateFollowupActions({
    summary: { conclusion_readiness_score: 31 },
    aggregateReview: {
      verdict: "reject",
      restart_recommended: true,
      pendingRubrics: [],
      major_objections: [],
      missing_validations: [],
      switch_triggers: [],
      incumbent_rejection_reasons: [],
      required_response_from_lab_director: [],
      recommended_actions: [],
      cross_family_alternatives: [
        {
          family_root: "replacement_method",
          statement: "Test a different method against the same research question.",
          why_better: "The incumbent method met its preregistered kill condition.",
        },
      ],
    },
    labDirectorResponse: null,
    previousReviewContext: null,
    chronicleResearchContext: null,
    leadSupersession: blocked,
  });
  const requery = actions.find((item) => item.type === "lab_director_requery_followup");
  assert.ok(requery, "the blocked pivot must route back to the director for the missing replacement record");
  assert.match(requery.description, /FALSIFICATION RELEASE/);
  assert.match(requery.description, /replacement_hypotheses/);
  assert.doesNotMatch(
    requery.description,
    /THE LEAD YOU MUST KEEP REFINING|do NOT author a replacement|novelty IN PLACE|KEEP this exact lead/i,
  );

  const released = decide({
    replacementLookupPerformed: true,
    proposedReplacement: {
      statement: "Test a different method against the same research question.",
      research_problem_question: QUESTION,
      methods_tried: [{ approach: "shared coverage equivalence" }],
    },
    currentQuestion: QUESTION,
  });
  assert.equal(released.decision, "allow");
  assert.equal(released.reason, "lead_falsified_by_completed_run");
});

// The reason the fail-open existed, and it still holds: an unwired call site must
// not halt the programme for an omission that is mine, not the director's.
test("a caller that never looked is still permitted", () => {
  const decision = decide({});
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason, "lead_falsified_by_completed_run");
});

test("a replacement that keeps the question is allowed", () => {
  const decision = decide({
    replacementLookupPerformed: true,
    proposedReplacement: {
      statement: "a different estimator for the same boundary",
      research_problem_question: QUESTION,
      methods_tried: [{ approach: "upper-tail concentration" }],
    },
    currentQuestion: QUESTION,
  });
  assert.equal(decision.decision, "allow");
});

test("a current-lead falsification retires that lead and reaches the director despite a stronger historical lead", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-07: at terminal conclusion
  // the support-boundary lead had failed its 0.20 activation premise, while the
  // supersession release named historical best hyp:bee8... and its allow path
  // delivered no directive. Three scouts, three runners and six gate reviews
  // then finished without moving the milestone.
  const trigger = stallFindings({
    progress: {
      current_milestone: "conclusion",
      next_milestone: null,
      reached_at: "2026-10-07T12:32:05.270Z",
      waiting_on: [],
      running_lanes: [],
      lead: { selected: false },
      lanes_since_milestone: {
        total: 3,
        newest: [],
        by_action_type: {
          reasoning_literature_scout: {
            total: 3,
            lane_ids: ["followup-scout-284", "followup-scout-285", "followup-scout-287"],
          },
        },
      },
    },
    config: { stallMinutes: 30, laneChurn: 3, noEvidenceMinutes: 90 },
    now: Date.parse("2026-10-07T14:51:21.296Z"),
  }).find((item) => item.kind === "lane_churn");
  assert.equal(trigger.signature, "lane_churn:conclusion:reasoning_literature_scout");

  const historical = buildProgressRecord({
    cycleId: CYCLE,
    round: 1,
    reviewLaneId: "followup-gatekeeper-previous",
    statement: "a stronger historical lead",
    rubric: [
      { name: "novelty", score: 88, applicable: true },
      { name: "technical_quality", score: 84, applicable: true },
    ],
    verdict: "challenge",
  });
  const currentStatement = "the current support-boundary method";
  const current = buildProgressRecord({
    cycleId: CYCLE,
    round: 2,
    reviewLaneId: "followup-gatekeeper-current",
    statement: currentStatement,
    rubric: [
      { name: "novelty", score: 35, applicable: true },
      { name: "technical_quality", score: 18, applicable: true },
    ],
    verdict: "reject",
  });
  const decision = evaluateLeadSupersession({
    records: [historical, current],
    cycleId: CYCLE,
    currentLeadKey: current.memory_id,
    currentLeadStatement: currentStatement,
    proposedHypothesisKey: current.memory_id,
    proposedStatement: currentStatement,
    leadValidationSummary: FALSIFIED,
    proposedReplacement: {
      statement: "a replacement method for the same question",
      research_problem_question: currentStatement,
      methods_tried: [{ approach: "support-boundary discontinuity" }],
    },
    currentQuestion: currentStatement,
    replacementLookupPerformed: true,
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason, "lead_falsified_by_completed_run");
  assert.equal(decision.lead, current.memory_id, "the current method, not the historical best, must be retired");
  assert.match(leadProtectionPrefix(decision), /current METHOD.*retired/i);

  const actions = authoritativeGateFollowupActions({
    summary: { conclusion_readiness_score: 39 },
    aggregateReview: {
      verdict: "reject",
      restart_recommended: true,
      pendingRubrics: [],
      major_objections: ["the activation premise failed"],
      missing_validations: [],
      switch_triggers: [],
      incumbent_rejection_reasons: [],
      required_response_from_lab_director: [],
      cross_family_alternatives: [],
      recommended_actions: [{
        type: "gate_restart_followup",
        preferred_role: "lab-director",
        description: "decide the next method",
      }],
    },
    labDirectorResponse: null,
    previousReviewContext: null,
    chronicleResearchContext: null,
    leadSupersession: decision,
  });
  const requery = actions.find((item) => item.preferred_role === "lab-director");
  assert.ok(requery, "the falsified conclusion must route back to the director");
  assert.equal(requery.lead_supersession.lead, current.memory_id);
  assert.match(requery.description, /do NOT uphold, refine, or resubmit/i);
});

test("changing the question under the method floor denies", () => {
  const decision = decide({
    replacementLookupPerformed: true,
    proposedReplacement: {
      statement: "an entirely different question about AOV cache invalidation",
      research_problem_question: "when does an AOV cache need invalidating",
      methods_tried: [{ approach: "upper-tail concentration" }],
    },
    currentQuestion: QUESTION,
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "question_retired_before_method_floor");
  assert.equal(decision.distinct_methods_tried, 1);
});

test("three distinct approaches may retire the question", () => {
  const decision = decide({
    replacementLookupPerformed: true,
    proposedReplacement: {
      statement: "an entirely different question about AOV cache invalidation",
      research_problem_question: "when does an AOV cache need invalidating",
      methods_tried: [
        { approach: "upper-tail concentration" },
        { approach: "residual radial tail" },
        { approach: "AOV support" },
      ],
    },
    currentQuestion: QUESTION,
  });
  assert.equal(decision.decision, "allow");
});

// A replacement WAS proposed and the substring match against the lead statement
// failed. Judging the proposal the director actually made beats treating it as
// no proposal at all.
test("a proposal that states no question is the director's answer, not silence", () => {
  const decision = decide({
    replacementLookupPerformed: true,
    proposedReplacement: { statement: "something new", why_selected: "it is newer" },
    currentQuestion: QUESTION,
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "replacement_states_no_research_question");
});
