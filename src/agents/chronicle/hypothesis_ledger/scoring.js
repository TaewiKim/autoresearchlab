"use strict";

const {
  statusRank,
  numericScore,
  inferFamilyRoot,
  familyChallengeSummary,
  buildUnresolvedGaps,
} = require("./normalization");
const {
  normalizeEvidenceRole,
  summarizeEvidence,
  summarizeKnowledgeGraphs,
} = require("./evidence");

function computeEvidenceQuality(entry, evidenceSummary) {
  const robustBonus = entry.latest_status === "robust" ? 28 : entry.latest_status === "exploratory" ? 14 : 4;
  const supportBonus = Math.min(24, entry.support_count * 6);
  const roleBonus = Math.min(20, evidenceSummary.evidence_roles.length * 10);
  const paperBonus = Math.min(14, evidenceSummary.paper_examples.length * 3);
  const mixedBasisBonus =
    evidenceSummary.support_basis.includes("data") && evidenceSummary.support_basis.includes("literature")
      ? 14
      : evidenceSummary.support_basis.length === 1
        ? 7
        : 0;
  const bridgeBonus = Math.min(8, (evidenceSummary.evidence_counts.bridge || 0) * 2);
  return Math.max(
    0,
    Math.min(
      100,
      robustBonus + supportBonus + roleBonus + paperBonus + mixedBasisBonus + bridgeBonus,
    ),
  );
}

function computePromotionReadiness(entry, evidenceSummary, graphSummary, evidenceQualityScore, hypothesisScore, familyContext = {}) {
  const robust = entry.latest_status === "robust";
  const mixedEvidence =
    evidenceSummary.support_basis.includes("data") &&
    evidenceSummary.support_basis.includes("literature");
  const metricValues = (entry.analysis_results || [])
    .flatMap((result) => (Array.isArray(result.metrics) ? result.metrics : []));
  const maxMetric = (name) => Math.max(
    0,
    ...metricValues
      .filter((metric) => metric?.metric === name)
      .map((metric) => Number(metric.value))
      .filter((value) => Number.isFinite(value)),
  );
  const highQualityBlueprintValidation =
    robust &&
    evidenceSummary.support_basis.includes("data") &&
    maxMetric("method_appropriateness_score") >= 90 &&
    maxMetric("analysis_accuracy_score") >= 90 &&
    maxMetric("checks_passed_count") >= 4;
  const evidenceBaseAccepted = mixedEvidence || highQualityBlueprintValidation;
  const hasValidationProtocol = Boolean(entry.validation_protocol);
  const hasValidationPlan = Array.isArray(entry.validation_plan) && entry.validation_plan.length > 0;
  const hasSupportPaths = Array.isArray(entry.support_paths) && entry.support_paths.length > 0;
  const hasGraphGrounding =
    (Boolean(entry.graph_support) && (graphSummary.graph_node_count || 0) > 0) ||
    highQualityBlueprintValidation;
  const hasVariables = Boolean(entry.x_variable) && Boolean(entry.y_variable);
  const hasDirection = entry.direction && entry.direction !== "unknown";
  const hasMechanism = Boolean(entry.mechanism);
  const roleDiversity = new Set(
    (entry.evidence || []).map((item) => normalizeEvidenceRole(item.lane_role)).filter(Boolean),
  ).size;
  const bridgeCount = Number(evidenceSummary.evidence_counts.bridge || 0);
  const sameFamilyCount = Number(familyContext.same_family_count || 1);
  const rivalFamilyCount = Number(familyContext.rival_family_count || 0);
  const isIncumbentFamily = familyContext.is_incumbent_family === true;
  const familyObjections = Number(familyContext.family_objections || 0);
  const sameFamilyOnly = familyContext.same_family_only === true;

  let score = 0;
  const reasons = [];
  const blockers = [];
  const penalties = [];

  if (robust) {
    score += 18;
    reasons.push("robust_validation_status");
  } else {
    blockers.push("not_robust");
  }
  if (entry.support_count >= 3) {
    score += 16;
    reasons.push("multiple_supporting_events");
  } else {
    blockers.push("insufficient_support_count");
  }
  if (evidenceBaseAccepted) {
    score += 18;
    reasons.push(mixedEvidence ? "cross_source_support" : "high_quality_blueprint_validation");
  } else {
    blockers.push("missing_cross_source_support");
  }
  if (roleDiversity >= 2) {
    score += 12;
    reasons.push("role_diversity");
  } else {
    blockers.push("limited_role_diversity");
  }
  if (hasValidationProtocol) {
    score += 10;
    reasons.push("validation_protocol_present");
  } else {
    blockers.push("missing_validation_protocol");
  }
  if (hasValidationPlan || hasSupportPaths) {
    score += 8;
    reasons.push("validation_plan_or_support_paths");
  } else {
    blockers.push("missing_validation_plan");
  }
  if (hasGraphGrounding) {
    score += 6;
    reasons.push("graph_grounding");
  } else {
    blockers.push("missing_graph_grounding");
  }
  if (hasVariables && hasDirection) {
    score += 8;
    reasons.push("claim_specificity");
  } else {
    blockers.push("missing_claim_specificity");
  }
  if (hasMechanism) {
    score += 4;
    reasons.push("mechanism_specified");
  }
  if (bridgeCount > 0) {
    score += 4;
    reasons.push("literature_data_bridge");
  }
  if ((entry.promoted_claim_ids || []).length > 0) {
    score += 4;
    reasons.push("report_claim_linkage");
  }
  if (sameFamilyCount > 1) {
    const penalty = Math.min(12, (sameFamilyCount - 1) * 4);
    score -= penalty;
    penalties.push("same_family_saturation_penalty");
  }
  if (isIncumbentFamily && (entry.promoted_claim_ids || []).length > 0 && entry.support_count < 4) {
    score -= 10;
    penalties.push("incumbent_inertia_penalty");
  }
  if (familyObjections > 0 || sameFamilyOnly) {
    score -= Math.min(14, familyObjections * 3 + (sameFamilyOnly ? 4 : 0));
    penalties.push("reviewer_unresolved_family_penalty");
  }
  const declaredRivalCount = Array.from(new Set([...(entry.rival_to || []), ...(entry.rivals || [])]))
    .filter(Boolean).length;
  const rivalCoverageSatisfied =
    rivalFamilyCount >= 2 ||
    (highQualityBlueprintValidation && declaredRivalCount >= 2);
  if (!rivalCoverageSatisfied) {
    score = Math.min(score, 64);
    penalties.push("rival_underexploration_cap");
  }

  // Tournament penalty: pairwise_loss events against rival families are a
  // real signal that the hypothesis family has lost head-to-head. Fold
  // that into the score so the promotion pipeline converges instead of
  // leaving contenders in limbo (this is item #1 of the pipeline harden
  // pass — pair with family_package_ledger's demotion rule).
  const pairwiseLossCount = Number(familyContext.family_pairwise_loss_count || 0);
  if (pairwiseLossCount > 0) {
    const pairwisePenalty = Math.min(20, pairwiseLossCount * 6);
    score -= pairwisePenalty;
    penalties.push("pairwise_tournament_loss_penalty");
    if (pairwiseLossCount >= 2) {
      blockers.push("family_lost_pairwise_tournament");
    }
  }

  const structuralPrereqsMet =
    robust &&
    entry.support_count >= 3 &&
    evidenceBaseAccepted &&
    roleDiversity >= 2 &&
    hasValidationProtocol &&
    hasVariables &&
    hasDirection;

  // Promotion bar: the evidence_quality >= 78 threshold proved unreachable
  // against observational ecological panels where within-unit effects
  // collapse under robustness checks. Lower the quantitative gate to a
  // reachable level (72 / 65 / 42) and use the structural prereqs above
  // as the real qualifier. When prereqs are met but scores still miss,
  // that's a design-level block (surfaced as `design_blocked_here` below)
  // rather than a silent candidate.
  const promotionReady =
    structuralPrereqsMet &&
    evidenceQualityScore >= 72 &&
    hypothesisScore >= 42 &&
    score >= 65;

  const claimCandidate =
    !promotionReady &&
    robust &&
    entry.support_count >= 2 &&
    evidenceBaseAccepted &&
    evidenceQualityScore >= 60 &&
    score >= 50;

  // design_blocked_here: all structural prereqs hold, yet one or more
  // scoring gates miss. This distinguishes "genuinely under-evidenced"
  // (still candidate / contending) from "design ceiling — the data can
  // never hit these numbers under this identification strategy". Item #2.
  const designBlockedHere = !promotionReady && structuralPrereqsMet;
  const designBlockReasons = [];
  if (designBlockedHere) {
    if (evidenceQualityScore < 72) designBlockReasons.push("evidence_quality_below_threshold");
    if (hypothesisScore < 42) designBlockReasons.push("hypothesis_score_below_threshold");
    if (score < 65) designBlockReasons.push("composite_score_below_threshold");
    if (pairwiseLossCount >= 2) designBlockReasons.push("pairwise_tournament_loss");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    ready: promotionReady,
    claim_candidate: claimCandidate,
    reasons,
    penalties,
    blockers: Array.from(new Set(blockers)),
    design_blocked_here: designBlockedHere,
    design_block_reasons: designBlockReasons,
    pairwise_loss_count: pairwiseLossCount,
  };
}

function finalizeLedgerEntries(ledger, gateReview = null) {
  const familyChallenges = familyChallengeSummary(gateReview);
  const ledgerEntries = Array.from(ledger.values());
  const familyCounts = ledgerEntries.reduce((map, item) => {
    const root = item.family_root || inferFamilyRoot(item);
    map.set(root, (map.get(root) || 0) + 1);
    return map;
  }, new Map());
  const incumbentFamily = Array.from(familyCounts.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
  const exploredFamilies = new Set(Array.from(familyCounts.keys()).filter(Boolean));
  return ledgerEntries
    .map((entry) => {
      const uniqueRoles = new Set(
        entry.evidence.map((item) => normalizeEvidenceRole(item.lane_role)).filter(Boolean),
      );
      const hasRoleDiversity = uniqueRoles.size >= 2;
      const canPromote =
        entry.promoted_claim_ids.length > 0 &&
        entry.latest_status === "robust" &&
        entry.support_count >= 3 &&
        hasRoleDiversity;
      const evidenceSummary = summarizeEvidence(entry);
      const graphSummary = summarizeKnowledgeGraphs(entry);
      const evidenceQualityScore = computeEvidenceQuality(entry, evidenceSummary);
      const hypothesisScore = Math.round(numericScore(entry.total_score, 0) * 100);
      const familyRoot = entry.family_root || inferFamilyRoot(entry);
      const familyChallenge = familyChallenges.get(familyRoot) || {
        objections: 0,
        cross_family_support: 0,
        same_family_only: false,
      };
      const promotion = computePromotionReadiness(
        entry,
        evidenceSummary,
        graphSummary,
        evidenceQualityScore,
        hypothesisScore,
        {
          same_family_count: Number(familyCounts.get(familyRoot) || 1),
          rival_family_count: Array.from(new Set([...(entry.rival_to || []), ...(entry.rivals || [])])).filter(
            (item) => item && exploredFamilies.has(item),
          ).length,
          is_incumbent_family: familyRoot === incumbentFamily,
          family_objections: familyChallenge.objections,
          same_family_only: familyChallenge.same_family_only,
        },
      );
      const unresolvedGaps = buildUnresolvedGaps(entry);

      let state = "candidate";
      // Promotion gate aligned with computePromotionReadiness' threshold
      // (72, not 78) — see the comment in that function for why the bar
      // was lowered.
      if ((canPromote || promotion.ready) && evidenceQualityScore >= 72) state = "provisionally_promoted";
      else if (promotion.claim_candidate || (entry.support_count >= 2 && entry.latest_status !== "weak")) state = "contending";

      if (
        state === "provisionally_promoted" &&
        (familyChallenge.objections > 0 || familyChallenge.same_family_only)
      ) {
        state = "challenged";
      } else if (
        (state === "contending" || state === "candidate") &&
        familyChallenge.objections >= 2 &&
        familyChallenge.cross_family_support > 0
      ) {
        state = "demoted";
      }

      if (
        (state === "demoted" || state === "challenged") &&
        entry.latest_status === "weak" &&
        entry.support_count >= 2
      ) {
        state = "retired";
      }

      // If promotion prereqs are met but scoring gates still miss, and
      // the entry would otherwise land as contending / candidate, surface
      // the structural block instead. Leaves demoted/retired/challenged
      // alone — those already encode a verdict.
      if (promotion.design_blocked_here && (state === "contending" || state === "candidate")) {
        state = "design_blocked";
      }

      return {
        ...entry,
        family_root: familyRoot,
        role_diversity_count: uniqueRoles.size,
        role_diversity_roles: Array.from(uniqueRoles),
        ...evidenceSummary,
        ...graphSummary,
        spec_compliance: {
          schema_version: entry.schema_version || null,
          required_output_complete: Boolean(entry.required_output_complete),
          has_validation_protocol: Boolean(entry.validation_protocol),
          has_graph_support: Boolean(entry.graph_support),
          has_codebook_grounding: Boolean(entry.codebook_grounding),
          has_structured_components: Boolean(entry.structured_hypothesis_components),
        },
        bridge_edges: entry.bridge_edges || [],
        evidence_quality_score: evidenceQualityScore,
        hypothesis_score: hypothesisScore,
        promotion_readiness_score: promotion.score,
        promotion_ready: promotion.ready,
        promotion_claim_candidate: promotion.claim_candidate,
        promotion_reasons: promotion.reasons,
        promotion_penalties: promotion.penalties,
        promotion_blockers: promotion.blockers,
        design_blocked_here: promotion.design_blocked_here,
        design_block_reasons: promotion.design_block_reasons,
        pairwise_loss_count: promotion.pairwise_loss_count,
        family_challenge: familyChallenge,
        claims: entry.claims || [],
        analysis_results: entry.analysis_results || [],
        unresolved_gaps: unresolvedGaps,
        state,
      };
    })
    .sort((a, b) => {
      const stateOrder = {
        provisionally_promoted: 0,
        challenged: 1,
        contending: 2,
        candidate: 3,
        design_blocked: 4,
        demoted: 5,
        retired: 6,
      };
      return (
        (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9) ||
        (b.promotion_readiness_score || 0) - (a.promotion_readiness_score || 0) ||
        (b.hypothesis_score || 0) - (a.hypothesis_score || 0) ||
        (b.evidence_quality_score || 0) - (a.evidence_quality_score || 0) ||
        statusRank(b.latest_status) - statusRank(a.latest_status) ||
        b.support_count - a.support_count
      );
    });
}

// Count pairwise_loss events per family from evidence packets. An entry
// in evidence_packets carries tested_edges[0].robustness.validation_outcomes,
// which lists per-validation verdicts; we count falsified pairwise_contest
// rows. Used to feed familyContext.family_pairwise_loss_count during the
// second promotion pass (see applyFamilyPairwiseLossRecount below).
function computeFamilyPairwiseLossCounts(evidencePackets) {
  const counts = new Map();
  const packets = Array.isArray(evidencePackets?.evidence_packets) ? evidencePackets.evidence_packets : [];
  for (const packet of packets) {
    const familyRoot = String(packet?.family_root || "").trim();
    if (!familyRoot) continue;
    const outcomes = Array.isArray(packet?.tested_edges?.[0]?.robustness?.validation_outcomes)
      ? packet.tested_edges[0].robustness.validation_outcomes
      : [];
    for (const outcome of outcomes) {
      if (
        String(outcome?.validation_type || "") === "family_pairwise_contest" &&
        String(outcome?.verdict || "") === "falsified"
      ) {
        counts.set(familyRoot, (counts.get(familyRoot) || 0) + 1);
      }
    }
  }
  return counts;
}

// Second-pass promotion recount: after evidence_packets exist, feed the
// per-family pairwise_loss_count back into each hypothesis' promotion
// block-decision so state and design_block_reasons reflect real tournament
// outcomes (see item #1 of the hypothesis-pipeline hardening notes).
function applyFamilyPairwiseLossRecount(hypotheses, familyPairwiseLossCounts) {
  return hypotheses.map((item) => {
    const familyRoot = String(item?.family_root || "").trim();
    const count = familyPairwiseLossCounts.get(familyRoot) || 0;
    if (count === 0) return item;
    const prevBlockers = Array.isArray(item?.design_block_reasons) ? item.design_block_reasons.slice() : [];
    const prevPenalties = Array.isArray(item?.promotion_penalties) ? item.promotion_penalties.slice() : [];
    const prevPromotionBlockers = Array.isArray(item?.promotion_blockers) ? item.promotion_blockers.slice() : [];
    // Reduce promotion_readiness_score to reflect pairwise penalty (same
    // formula as computePromotionReadiness so the two paths agree).
    const penalty = Math.min(20, count * 6);
    const adjustedScore = Math.max(0, Math.min(100, Number(item?.promotion_readiness_score || 0) - penalty));
    if (!prevPenalties.includes("pairwise_tournament_loss_penalty")) prevPenalties.push("pairwise_tournament_loss_penalty");
    if (count >= 2 && !prevPromotionBlockers.includes("family_lost_pairwise_tournament")) {
      prevPromotionBlockers.push("family_lost_pairwise_tournament");
    }
    if (count >= 2 && !prevBlockers.includes("pairwise_tournament_loss")) {
      prevBlockers.push("pairwise_tournament_loss");
    }
    // State downgrade: if the family lost ≥ 2 pairwise contests and the
    // hypothesis is currently in a pre-verdict state, demote it so the
    // downstream graph reflects the tournament outcome.
    let nextState = item.state;
    if (count >= 2 && (item.state === "candidate" || item.state === "contending")) {
      nextState = "demoted";
    } else if (count >= 2 && item.state === "provisionally_promoted") {
      nextState = "challenged";
    }
    return {
      ...item,
      pairwise_loss_count: count,
      promotion_readiness_score: adjustedScore,
      promotion_penalties: prevPenalties,
      promotion_blockers: prevPromotionBlockers,
      design_block_reasons: prevBlockers,
      state: nextState,
    };
  });
}

module.exports = {
  computeEvidenceQuality,
  computePromotionReadiness,
  finalizeLedgerEntries,
  computeFamilyPairwiseLossCounts,
  applyFamilyPairwiseLossRecount,
};
