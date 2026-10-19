"use strict";

const IMPACT_FIRST_HYPOTHESIS_MANDATE = Object.freeze({
  active: true,
  policy_version: "typed-evidence-admission-v3",
  selection_rule:
    "Select exploration candidates from multiple mechanism families, then admit a validation lead only when its typed evidence route, procedure signature, prior-art boundary, estimand, falsification criteria, and smallest useful effect are concrete and traceable. Scores guide prioritization; they never substitute for evidence.",
  evidence_routes: [
    "literature_frontier",
    "controlled_simulation",
    "physical_experiment",
    "human_study",
    "formal_proof",
    "observational_dataset",
    "benchmark",
  ],
  admission_states: ["exploration_candidate_selected", "validation_lead_ready"],
  required_candidate_fields: [
    "hypothesis_id",
    "statement",
    "impact_claim",
    "decision_relevance",
    "state_of_art_delta",
    "why_now",
    "novelty_delta_score",
    "expected_impact_score",
    "testability_score",
    "data_feasibility_score",
    "validation_data_availability_score",
    "validation_dataset_accession_or_bundle",
    "validation_variable_mapping",
    "validation_data_blockers",
    "decisive_validation_plan",
    "why_not_merely_audit",
    "research_question",
    "mechanism",
    "procedure_signature",
    "closest_prior_art",
    "prior_art_evidence_scope",
    "novelty_delta",
    "strongest_inversion",
    "boring_baseline",
    "primary_estimand",
    "smallest_useful_effect",
    "falsification_criteria",
    "null_contribution",
    "instrument_limitations",
    "admission_state",
    "evidence_route",
    "evidence_artifacts",
    "evidence_provenance",
  ],
  minimum_initial_scores: {
    // Retained for consumers that still read this compatibility field. These
    // are no longer admission thresholds or self-attestation requirements.
    expected_impact_score: null,
    novelty_delta_score: null,
    testability_score: null,
    data_feasibility_score: null,
    validation_data_availability_score: null,
  },
  validation_data_availability_rubric: {
    typed_route: "Evidence is admissible only when its route-specific artifact and provenance are named.",
    missing: "No route-specific evidence or credible acquisition/procedure path is named.",
  },
  demotion_rules: [
    "A reproducibility audit cannot be the lead unless it overturns a high-stakes baseline, exposes a broadly reusable mechanism, or changes a consequential scientific or engineering decision.",
    "A metric drop from a published result is audit evidence, not a high-impact hypothesis by itself.",
    "Candidates with unclear state-of-art delta or unclear decision relevance must be kept as supporting checks, not promoted as the lead.",
    "Candidates without a typed evidence route, procedure signature, and traceable artifact path must remain exploration candidates.",
  ],
  lead_selection_deliverables: [
    "impact-ranked candidate hypothesis table",
    "validation-evidence availability ranking for each candidate, including route-specific artifact paths and missing measurements",
    "state-of-art baseline and delta for each candidate",
    "decision-changing validation plan for the selected lead",
    "explicit reason the lead is more than a reproducibility audit",
    "route-specific evidence and provenance ledger",
  ],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildImpactFirstHypothesisMandate() {
  return clone(IMPACT_FIRST_HYPOTHESIS_MANDATE);
}

function roleUsesImpactFirstHypothesisMandate(role) {
  return ["lab-director", "scout", "analyst", "gatekeeper", "falsifier"].includes(String(role || ""));
}

module.exports = {
  IMPACT_FIRST_HYPOTHESIS_MANDATE,
  buildImpactFirstHypothesisMandate,
  roleUsesImpactFirstHypothesisMandate,
};
