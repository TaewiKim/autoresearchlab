"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeConclusionReadiness } = require("../src/reporting/visualizer/analysis");

test("computeConclusionReadiness: family nominations and graph coverage clear novelty blockers", () => {
  const result = computeConclusionReadiness({
    report: {
      claim_count: 3,
      supporting_claim_count: 3,
      open_question_count: 0,
      recommended_action_count: 2,
      completed_experiment_lanes: 4,
      figure_spec: { figures: [{ id: "primary" }, { id: "robustness" }] },
    },
    literature: {
      hypothesis_count: 6,
      top_papers: ["paper-a", "paper-b", "paper-c"],
      summary: "observational cohort setting participants outcome exposure confounder data source bias statistical method effect size limitations",
    },
    laneCounts: { completed: 6, running: 0, failed: 0 },
    topPapers: ["paper-a", "paper-b", "paper-c"],
    claims: [
      { reason: "Primary effect remains after adjustment and sensitivity analysis.", supporting_papers: ["paper-a"], supporting_lanes: ["lane-a"] },
      { reason: "Independent cohort result supports the same mechanism.", supporting_papers: ["paper-b"], supporting_lanes: ["lane-b"] },
      { reason: "Rival pathway is weaker under robustness checks.", supporting_papers: ["paper-c"], supporting_lanes: ["lane-c"] },
    ],
    focusHypotheses: [
      { hypothesis_id: "h-main", state: "provisionally_promoted", latest_status: "robust", family_root: "mechanism_anchored_differential_expression", cluster_key: "cluster-main" },
      { hypothesis_id: "h-alt", state: "contending", latest_status: "exploratory", family_root: "alternative-mechanism", cluster_key: "cluster-alt" },
      { hypothesis_id: "h-mod", state: "contending", latest_status: "robust", family_root: "causal_mediation_with_moderator", cluster_key: "cluster-mod", validation_protocol: { model: "pooled or stratified correlation model" } },
      { hypothesis_id: "h-rival", state: "contending", latest_status: "exploratory", family_root: "rival_pathway", cluster_key: "cluster-rival" },
    ],
    hypothesisLedger: {
      promoted_count: 2,
      average_evidence_quality_score: 82,
      schema_quality: {
        mechanism_node_count: 10,
        moderator_node_count: 2,
        confounder_node_count: 8,
        rival_node_count: 5,
        falsification_test_count: 8,
        claim_count: 8,
        analysis_result_count: 24,
      },
      knowledge_graph: {
        reasoning_graph: {
          claim_count: 6,
          analysis_result_count: 24,
          test_count: 8,
          unresolved_gap_count: 3,
        },
        bridge_graph: { bridge_edge_count: 20 },
      },
      derivable_hypothesis_candidates: [{ id: "d1" }, { id: "d2" }],
      hypotheses: [],
    },
    familyNomination: [
      {
        family_root: "mechanism_anchored_differential_expression",
        support_count: 6,
        hypothesis_count: 2,
        distinctiveness_score: 94,
        required_validations: ["Recompute the primary contrast and compare rival mechanisms."],
      },
      {
        family_root: "alternative-mechanism",
        support_count: 8,
        hypothesis_count: 3,
        distinctiveness_score: 76,
        required_validations: ["Compare against rival mechanism families."],
      },
      {
        family_root: "causal_mediation_with_moderator",
        support_count: 7,
        hypothesis_count: 1,
        distinctiveness_score: 58,
        required_validations: ["Run stratified moderator and family-pairwise validation."],
      },
    ],
    familyTournament: { family_count: 3 },
    followupProgress: [],
    validationSignals: {
      method_appropriateness: [84, 88],
      analysis_accuracy: [86, 90],
    },
    projectionCount: 2,
  });

  const novelty = result.rubric.find((item) => item.name === "novelty");
  assert.ok(novelty.score >= 95, `novelty score should be approval-ready, got ${novelty.score}`);
  assert.deepEqual(
    novelty.reasons.filter((reason) => reason.startsWith("Novelty:")),
    [],
  );
});
