"use strict";

const { inferTopicTerms } = require("../shared/topic_terms");

function laneIndex(laneId) {
  const match = String(laneId || "").match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : 1;
}

function prioritizedFamilies(cyclePlanningContext = null) {
  return Array.isArray(cyclePlanningContext?.next_cycle_plan?.prioritized_families)
    ? cyclePlanningContext.next_cycle_plan.prioritized_families
    : [];
}

function buildLabRunnerAnalysisPlan({ prompt, laneId, cyclePlanningContext = null }) {
  const topicTerms = inferTopicTerms(prompt);
  const index = laneIndex(laneId);
  const validationProfile = index % 2 === 1 ? "single-validation-check" : "robustness-followup-check";
  const prioritized = prioritizedFamilies(cyclePlanningContext).slice(0, 3);
  const openEndedTimeoutPolicy = prioritized.length > 0
    ? {
        tier: "priority-validation-code",
        codex_timeout_seconds: 180,
        script_timeout_seconds: 90,
        trigger_reason: "priority validation-coding lanes need enough time for one custom check",
      }
    : {
        tier: "standard-validation-code",
        codex_timeout_seconds: 120,
        script_timeout_seconds: 60,
        trigger_reason: "standard validation-coding lanes should finish one custom check reliably",
      };
  const figureIntent = [
    "do not invent a new visual strategy in this lane",
    "reuse the statistician's hypothesis framing and visual questions",
    "only emit figure specs that directly support the requested validation check",
  ];
  const requestedVisualQuestions = [
    "What figure directly tests the statistician's lead hypothesis?",
    "What figure most clearly falsifies or supports the requested validation check?",
    "What comparison would most change the family ranking if the validation succeeds?",
    ...prioritized.map((item) => `What figure would best evaluate ${item.family_root} via ${item.action}?`),
  ];
  const analysisLoop = [
    {
      stage: "ask",
      question: "What exact validation check did the statistician ask this lane to execute?",
      deliverables: ["validation coding task", "input/output contract", "success criterion"],
      gate: "scope_gate",
    },
    {
      stage: "look",
      question: "Can the requested analysis master table be built before any hypothesis test runs?",
      deliverables: ["analysis master table", "row-grain audit", "join-key audit", "required-column audit"],
      gate: "analysis_master_table_gate",
    },
    {
      stage: "investigate",
      question: "Can Codex execute one decisive validation script against the statistician's target hypothesis?",
      deliverables: ["executed validation code", "machine-readable validation result", "support or falsification signal"],
      gate: "family_competition_gate",
    },
    {
      stage: "voice",
      question: "What should Chronicle conclude from this executed validation?",
      deliverables: ["key finding", "support or falsification verdict", "follow-up implication"],
      gate: "communication_gate",
    },
    {
      stage: "evolve",
      question: "What is the next smallest validation check if this one is inconclusive?",
      deliverables: ["next validation task", "failure mode note", "reproducibility notes"],
      gate: "reproducibility_gate",
    },
  ];

  return {
    lane_id: laneId,
    role: "lab-runner",
    role_alias: "validation-coder",
    source: "lab-director",
    prompt,
    analysis_mode: "execution-only",
    scientist_mode: "validation-code-only",
    requires_analyst_handoff: true,
    instruction_handoff_policy: "do-not-run-generic-validation-without-analyst-or-followup-instructions",
    open_ended_timeout_policy: openEndedTimeoutPolicy,
    analysis_profile: "validation-code-execution",
    execution_mandate: [
      "treat analyst outputs as the source of hypotheses, figure questions, and strategy",
      "use baseline analysis as a reusable toolkit only",
      "ask Codex to write one validation script for one decisive check",
      "do not invent new hypotheses in this lane",
      "do not broaden the visual strategy beyond the requested validation question",
    ],
    analysis_loop: analysisLoop,
    topic_terms: topicTerms,
    analysis_goals: [
      "normalize the active dataset bundle into a stable analysis table",
      "build and persist the analyst-specified analysis master table before running hypothesis validation",
      "execute one custom validation script against the statistician's requested check",
      "record support, falsification, or inconclusive outcome in machine-readable form",
      "return artifacts that Chronicle can compare across validation lanes",
    ],
    pre_validation_master_table_gate: {
      required: true,
      gate_id: "analysis_master_table_gate",
      required_check_id: "analysis_master_table_created",
      required_artifact_name_pattern: "master_table",
      must_run_before_hypothesis_validation: true,
      notes:
        "If the master table cannot be built, stop with a schema/data blocker instead of running ad hoc validation code.",
    },
    validation_coding_task: null,
    hypothesis_focus: null,
    focus_families: ["validation-execution", "pairwise-contest", "falsification"],
    focus_outcomes: topicTerms.slice(0, 5),
    validation_profile: validationProfile,
    figure_intent: figureIntent,
    requested_visual_questions: requestedVisualQuestions,
    next_cycle_context: cyclePlanningContext?.next_cycle_plan || null,
    prioritized_family_actions: prioritized,
    required_outputs: [
      "result.json",
      "summary.md",
      "analysis-trace.json",
      "machine-readable metrics",
    ],
    validation_checks: [
      "sanity-check missingness and joins",
      "build the analyst-specified master table and emit checks.analysis_master_table_created=true before interpreting validation output",
      "execute only one decisive validation task per lane",
      "treat analyst strategy as authoritative for hypothesis and figure direction",
      "flag weak support as exploratory",
      "preserve enough detail for follow-up lanes",
      "record ASK/LOOK/INVESTIGATE/VOICE/EVOLVE trace for auditability",
      "make family competition and reproducibility gates explicit",
      ...prioritized.map((item) => `address ${item.family_root} via ${item.action}`),
    ],
  };
}

module.exports = {
  buildLabRunnerAnalysisPlan,
};
