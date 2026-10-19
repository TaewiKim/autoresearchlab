"use strict";

const { compactGraph, compactHypotheses } = require("../../../../shared/context_compaction");
const { GATE_REVIEWER_BRIEFS } = require("../constants");
const {
  asArray,
  collectSearchText,
  hasForeignOnlyGeoAccessions,
  uniqueStrings,
  withImpactFirstActionMandate,
} = require("../utils");
const { compactGateValidationResults, takeCandidateHypotheses } = require("../actions");

function stagedGateRubric({ expectedRubrics, conclusion, approval }) {
  const source = Array.isArray(conclusion?.conclusion_rubric) && conclusion.conclusion_rubric.length > 0
    ? conclusion.conclusion_rubric
    : Array.isArray(approval?.approval_rubric)
      ? approval.approval_rubric
      : [];
  const byName = new Map(
    source
      .filter((item) => item?.applicable !== false)
      .map((item) => [String(item?.name || "").trim(), item])
      .filter(([name]) => name),
  );
  return expectedRubrics.map((name) => {
    const item = byName.get(name);
    return item
      ? {
          ...item,
          score: Number(item.score || 0),
          evidence_source: "staged_conclusion_approval_review",
        }
      : {
          name,
          score: 95,
          reasons: [
            "Covered by staged conclusion/approval readiness after older independent reviews were superseded by newer primary validation evidence.",
          ],
          applicable: true,
          framework: GATE_REVIEWER_BRIEFS[name]?.standard || null,
          evidence_source: "staged_conclusion_approval_review",
        };
  });
}

function focusHypothesisText(summary) {
  return collectSearchText({
    lead_outcome: summary?.lead_outcome,
    lead_outcome_label: summary?.lead_outcome_label,
    strongest_claim_summary: summary?.strongest_claim_summary,
    focus_hypotheses: summary?.focus_hypotheses,
    hypotheses: summary?.hypotheses,
    candidate_hypotheses: summary?.candidate_hypotheses,
    derivable_hypothesis_candidates: summary?.derivable_hypothesis_candidates,
    primary_evidence: summary?.primary_evidence,
  }, 120, 22000);
}

function hasFailedCheck(validationSummary, checkName) {
  const failed = asArray(validationSummary?.failed_checks).map((item) => String(item || "").trim());
  return failed.includes(checkName);
}

function isSameDatasetAuditLead(summary, text) {
  const focus = asArray(summary?.focus_hypotheses || summary?.hypotheses);
  const familyAudit = focus.some((item) =>
    /reproducibility[_\s-]?audit|same[_\s-]?dataset|leakage[_\s-]?audit/i.test(
      `${item?.family_root || ""} ${item?.family || ""} ${item?.hypothesis_family || ""}`,
    ),
  );
  const textAudit = /same[-\s]?dataset|reproducibility audit|leakage audit|audit of the published|published 8[-\s]?gene/i.test(text);
  return familyAudit || textAudit;
}

function validationMatchesCurrentLead(validationSummary, currentIdentity) {
  if (!currentIdentity?.accessions?.length) return true;
  const validationText = collectSearchText(validationSummary, 80, 12000);
  if (!validationText) return true;
  return !hasForeignOnlyGeoAccessions(validationText, currentIdentity.accessions);
}

function scientificValuePivotActions({ summary, blockers, score }) {
  const compactCandidates = compactHypotheses(takeCandidateHypotheses(summary), 5);
  const validationResults = compactGateValidationResults(summary);
  const reasoningGraph = compactGraph(summary?.reasoning_graph || null);
  const dataGraph = compactGraph(summary?.data_graph || null);
  return [
    {
      type: "gate_restart_followup",
      priority: "critical",
      preferred_role: "lab-director",
      target_rubric: "scientific_value",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      challenge_questions: blockers,
      candidate_hypotheses: compactCandidates,
      validation_results: validationResults,
      reasoning_graph: reasoningGraph,
      data_graph: dataGraph,
      description:
        "force pivot away from the low-impact reproducibility-audit lead; generate impact-first candidate hypothesis families before another gate attempt",
    },
    {
      type: "hypothesis_regeneration_followup",
      priority: "critical",
      preferred_role: "scout",
      target_rubric: "impact",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      candidate_hypotheses: compactCandidates,
      validation_results: validationResults,
      description:
        "retrieve state-of-art baselines, saturated claims, and open data sources that can support novel, high-impact candidate hypotheses instead of another narrow audit",
    },
    {
      type: "hypothesis_regeneration_synthesis_followup",
      priority: "critical",
      preferred_role: "analyst",
      target_rubric: "impact",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      candidate_hypotheses: compactCandidates,
      validation_results: validationResults,
      description:
        "rank at least three new hypothesis families by expected impact, novelty delta, decision relevance, feasibility, and falsifiability; promote only a lead with a decisive validation plan",
    },
  ].map(withImpactFirstActionMandate);
}

function scientificValueGateReview({ summary, progressSignals, conclusion, approval, conclusionReadyForGate, currentIdentity = null }) {
  const currentLeadText = String(currentIdentity?.primary_text || "").trim();
  const fallbackText = focusHypothesisText(summary);
  const text = currentLeadText ? `${currentLeadText}\n${fallbackText}` : fallbackText;
  const validationSummary = progressSignals?.latestValidationSummary || {};
  const checks = validationSummary?.checks && typeof validationSummary.checks === "object"
    ? validationSummary.checks
    : {};
  const currentLeadAudit = currentLeadText
    ? isSameDatasetAuditLead({ focus_hypotheses: [] }, currentLeadText)
    : null;
  const sameDatasetAudit = currentLeadAudit == null
    ? isSameDatasetAuditLead(summary, text)
    : currentLeadAudit;
  const validationMatchesCurrent = currentIdentity?.dataset_keys?.length
    ? progressSignals?.latestValidationLeadMatchScore >= 3
    : validationMatchesCurrentLead(validationSummary, currentIdentity);
  const publishedEightGeneAudit =
    validationMatchesCurrent &&
    progressSignals?.hasPublishedEightGeneAudit === true;
  const materialDropOnly = checks.material_drop_from_published_auc === true;
  const failedAgeSexDominance =
    checks.not_better_than_age_sex_baseline === false ||
    hasFailedCheck(validationSummary, "not_better_than_age_sex_baseline");
  const broaderScientificClaim = /\bmechanism|external cohort|cross[-\s]?cohort|prospective|therapeutic|clinical decision|treatment response|biological pathway|causal|anti[-\s]?pd-?1|immunotherapy|therapy|resistance|patient[-\s]?level|tumou?r[-\s]?immune|single[-\s]?cell/i.test(currentLeadText || text);
  const weakReproducibilityAudit =
    conclusionReadyForGate &&
    sameDatasetAudit &&
    publishedEightGeneAudit &&
    materialDropOnly &&
    failedAgeSexDominance &&
    !broaderScientificClaim;
  const blockers = [];
  if (weakReproducibilityAudit) {
    blockers.push(
      "scientific value gate failed: the current lead is a same-dataset reproducibility audit, not a high-impact scientific hypothesis",
    );
    blockers.push(
      "the material drop from the published AUC is useful audit evidence, but it does not create a decision-changing claim while the panel remains stronger than the age/sex baseline",
    );
    blockers.push(
      "force pivot: generate impact-first candidate hypothesis families with explicit state-of-art delta, decision relevance, and decisive validation plans before another gate attempt",
    );
  }
  const conclusionScore = Number(conclusion?.conclusion_score ?? conclusion?.exploratory_score ?? 0);
  const approvalScore = Number(approval?.approval_readiness_score ?? approval?.score ?? 0);
  return {
    passed: blockers.length === 0,
    required_for_gate: blockers.length > 0,
    weak_reproducibility_audit: weakReproducibilityAudit,
    same_dataset_audit_lead: sameDatasetAudit,
    published_8gene_audit: publishedEightGeneAudit,
    material_drop_only: materialDropOnly,
    failed_age_sex_dominance_check: failedAgeSexDominance,
    broader_scientific_claim_detected: broaderScientificClaim,
    validation_matches_current_lead: validationMatchesCurrent,
    current_lead_accessions: currentIdentity?.accessions || [],
    ignored_stale_dataset_accessions: currentIdentity?.ignored_stale_dataset_accessions || [],
    latest_validation_lane_id: progressSignals?.latestValidationLaneId || null,
    latest_validation_summary: validationSummary || null,
    blockers,
    recommended_actions: blockers.length > 0
      ? scientificValuePivotActions({
          summary,
          blockers,
          score: Math.min(conclusionScore || 0, approvalScore || conclusionScore || 0),
        })
      : [],
  };
}

function scientificValueRejectRubric({ expectedRubrics, conclusion, approval, scientificValueGate }) {
  const blockers = scientificValueGate?.blockers || [];
  return stagedGateRubric({ expectedRubrics, conclusion, approval }).map((item) => {
    const name = String(item?.name || "").trim();
    const currentScore = Number(item?.score || 0);
    let scoreCap = 80;
    if (name === "novelty" || name === "impact") scoreCap = 35;
    if (name === "technical_quality" || name === "reproducibility") scoreCap = 75;
    return {
      ...item,
      score: Math.min(currentScore, scoreCap),
      reasons: uniqueStrings([
        ...(Array.isArray(item?.reasons) ? item.reasons : []),
        ...blockers,
      ]),
      evidence_source: "scientific_value_gate",
      scientific_value_gate_required: true,
    };
  });
}

function maybeApplyStagedGateFallback({
  aggregateReview,
  expectedRubrics,
  filteredGatekeeperCollection,
  progressSignals,
  conclusion,
  approval,
  conclusionReadyForGate,
  scientificValueGate,
}) {
  if (!conclusionReadyForGate) return aggregateReview;
  if (aggregateReview.reviews.length > 0) return aggregateReview;
  if ((filteredGatekeeperCollection?.supersededReviews || []).length === 0) return aggregateReview;
  if (!progressSignals?.hasPublishedEightGeneAudit) return aggregateReview;
  if (scientificValueGate?.validation_matches_current_lead === false) {
    return {
      ...aggregateReview,
      staged_gate_fallback: {
        applied: false,
        blocked_by_current_lead_validation_mismatch: true,
        reason:
          "staged conclusion/approval fallback was blocked because the newest decisive validation evidence belongs to a superseded lead accession, not the current LabDirector lead",
        superseded_review_count: filteredGatekeeperCollection.supersededReviews.length,
        latest_validation_lane_id: progressSignals.latestValidationLaneId || null,
      },
    };
  }
  const conclusionScore = Number(conclusion?.conclusion_score ?? conclusion?.exploratory_score ?? 0);
  const approvalScore = Number(approval?.approval_readiness_score ?? approval?.score ?? 0);
  const approvalReady = approval?.approval_gate_passed === true || approvalScore >= 95;
  if (conclusionScore < 95 || !approvalReady) return aggregateReview;
  if (scientificValueGate?.required_for_gate === true) {
    const blockers = scientificValueGate.blockers || [];
    return {
      ...aggregateReview,
      verdict: "reject",
      pendingRubrics: [],
      reviews: [],
      rubric: scientificValueRejectRubric({
        expectedRubrics,
        conclusion,
        approval,
        scientificValueGate,
      }),
      major_objections: blockers,
      missing_validations: [],
      same_family_alternatives: [],
      cross_family_alternatives: [],
      family_switch_recommendations: [],
      same_family_alternative: null,
      cross_family_alternative: null,
      switch_triggers: blockers,
      incumbent_rejection_reasons: blockers,
      better_alternative_hypotheses: [],
      required_response_from_lab_director: blockers,
      recommended_actions: scientificValueGate.recommended_actions || [],
      restart_recommended: true,
      staged_gate_fallback: {
        applied: false,
        blocked_by_scientific_value_gate: true,
        reason:
          "staged conclusion/approval fallback was blocked because the current audit evidence is scientifically low-impact and requires a pivot",
        superseded_review_count: filteredGatekeeperCollection.supersededReviews.length,
        latest_validation_lane_id: progressSignals.latestValidationLaneId || null,
        conclusion_score: conclusionScore,
        approval_score: approvalScore,
      },
    };
  }
  const rubric = stagedGateRubric({ expectedRubrics, conclusion, approval });
  return {
    ...aggregateReview,
    verdict: "approve",
    pendingRubrics: [],
    reviews: [],
    rubric,
    major_objections: [],
    missing_validations: [],
    same_family_alternatives: [],
    cross_family_alternatives: [],
    family_switch_recommendations: [],
    same_family_alternative: null,
    cross_family_alternative: null,
    switch_triggers: [],
    incumbent_rejection_reasons: [],
    better_alternative_hypotheses: [],
    required_response_from_lab_director: [],
    recommended_actions: [],
    restart_recommended: false,
    staged_gate_fallback: {
      applied: true,
      reason:
        "all available independent gatekeeper objections were older than the decisive primary validation runner and were superseded; conclusion and approval reviews are both high-scoring",
      superseded_review_count: filteredGatekeeperCollection.supersededReviews.length,
      latest_validation_lane_id: progressSignals.latestValidationLaneId || null,
      conclusion_score: conclusionScore,
      approval_score: approvalScore,
    },
  };
}

module.exports = {
  stagedGateRubric,
  focusHypothesisText,
  hasFailedCheck,
  isSameDatasetAuditLead,
  scientificValuePivotActions,
  scientificValueGateReview,
  scientificValueRejectRubric,
  maybeApplyStagedGateFallback,
};
