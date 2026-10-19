"use strict";

const fs = require("fs");
const path = require("path");
const { readJson, writeJson } = require("../../shared/json");
const { runtimeRoot } = require("../../runtime/native_client");
const { createDataGraph, createEvidencePacket } = require("./data_graph_artifacts");
const { buildValidationResultsArtifact, __private: cycleStatePrivate = {} } = require("./cycle_state_artifacts");
const { lintCycleArtifact } = require("./data_graph_vocabulary_lint");
const { buildDatasetProfile, selectValidationDesigns, buildValidationTarget } = require("./dataset_design_selector");
const { fallbackBaseDataGraph, buildReasoningGraphArtifact } = require("./data_graph_validation/graph_builders");
const { cycleStateReader } = require("../shared/gated_state");

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      asArray(values)
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
}


function graphPromotionGate(item = {}) {
  if (cycleStatePrivate && typeof cycleStatePrivate.hypothesisGraphPromotionGate === "function") {
    return cycleStatePrivate.hypothesisGraphPromotionGate(item);
  }
  return { promotable: true, blocked_fields: [], reason: null };
}

function sourceLaneIdsFromPacket(packet = {}) {
  return uniqueStrings([
    ...asArray(packet?.provenance),
    packet?.provenance?.lane_id,
  ]);
}

function diffProvenanceFields(packet = {}, fallback = {}) {
  const laneIds = sourceLaneIdsFromPacket(packet);
  return {
    source_lane_ids: laneIds,
    source_type: fallback.source_type || "validation_result",
    source_summary: packet?.summary || fallback.summary || null,
  };
}

function familyNodeId(familyRoot) {
  return familyRoot ? `family:${familyRoot}` : null;
}

function hypothesisNodeId(hypothesisId) {
  return hypothesisId ? `hypothesis:${hypothesisId}` : null;
}

function variableNodeId(variable) {
  if (!variable) return null;
  return `variable:${String(variable).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function edgeIdForHypothesis(item) {
  const x = variableNodeId(item?.x_variable || item?.primary_exposure || item?.primary_exposure_variables?.[0]);
  const y = variableNodeId(item?.y_variable || item?.outcome || item?.outcome_variables?.[0]);
  if (!x || !y) return null;
  return `edge:${x}:${y}:predicts`;
}

function parsePredictiveEdgeId(edgeId) {
  const match = String(edgeId || "").match(/^edge:(variable:[^:]+):(variable:[^:]+):([^:]+)$/);
  if (!match) return null;
  return {
    from: match[1],
    to: match[2],
    relation: match[3],
  };
}

function edgeConfidenceTier({ status = null, updateCount = 0, supportScore = 0, falsificationScore = 0, sourceKind = null }) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "falsified") return "rejected";
  if (normalizedStatus === "supported" && updateCount >= 1 && supportScore > falsificationScore) return "validation_supported";
  if (normalizedStatus === "challenged") return "validation_contested";
  if (String(sourceKind || "").trim().toLowerCase() === "literature" && supportScore > 0) return "literature_supported";
  if (String(sourceKind || "").trim().toLowerCase() === "literature") return "literature_nominated";
  return "provisional";
}

function edgeEvidenceRank({ status = null, updateCount = 0, supportScore = 0, falsificationScore = 0, instabilityScore = 0, sourceKind = null }) {
  const tier = edgeConfidenceTier({ status, updateCount, supportScore, falsificationScore, sourceKind });
  if (tier === "validation_supported") return 90 + Math.min(9, supportScore + updateCount);
  if (tier === "validation_contested") return 55 - Math.min(15, falsificationScore + instabilityScore);
  if (tier === "rejected") return 20 - Math.min(10, falsificationScore);
  if (tier === "literature_supported") return 45 + Math.min(20, supportScore);
  if (tier === "literature_nominated") return 30 + Math.min(10, supportScore);
  return 40;
}

function statusToVerdict(status) {
  const value = String(status || "").toLowerCase();
  if (value === "robust" || value === "strengthened" || value === "provisionally_promoted") return "supported";
  if (value === "weak" || value === "demoted" || value === "retired") return "falsified";
  if (value === "challenged") return "weakened";
  return "inconclusive";
}

function stateUpdateFromVerdict(verdict) {
  if (verdict === "supported") return "strengthened";
  if (verdict === "falsified") return "demoted";
  if (verdict === "weakened") return "challenged";
  return "candidate";
}

function metricObject(analysisResults = []) {
  const measures = {};
  for (const result of analysisResults) {
    for (const metric of asArray(result?.metrics)) {
      const key = String(metric?.metric || "").trim();
      const value = Number(metric?.value);
      if (!key || !Number.isFinite(value)) continue;
      measures[key] = value;
    }
  }
  return measures;
}

function normalizeValidationRequirement(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (text.includes("family_pairwise_contest") || text.includes("pairwise")) return "family_pairwise_contest";
  if (text.includes("mediation_vs_proxy")) return "mediation_vs_proxy_test";
  if (text.includes("measurement_artifact")) return "measurement_artifact_test";
  if (text.includes("subgroup_stability")) return "subgroup_stability_test";
  if (text.includes("negative_control")) return "negative_control_test";
  if (text.includes("temporal_plausibility")) return "temporal_plausibility_test";
  if (text.includes("structure_contest")) return "structure_contest";
  if (text.includes("edge_robustness")) return "edge_robustness_test";
  return text.replace(/\s+/g, "_");
}

function validationWeight(validationType, verdict) {
  const type = String(validationType || "");
  if (type === "family_pairwise_contest") {
    return verdict === "supported" ? 2.5 : verdict === "falsified" ? -2 : verdict === "weakened" ? -1 : 0;
  }
  if (type === "measurement_artifact_test") {
    return verdict === "supported" ? 1 : verdict === "falsified" ? -2.5 : verdict === "weakened" ? -1.5 : 0;
  }
  if (type === "mediation_vs_proxy_test") {
    return verdict === "supported" ? 1.25 : verdict === "falsified" ? -2 : verdict === "weakened" ? -1.25 : 0;
  }
  if (type === "structure_contest") {
    return verdict === "supported" ? 1.5 : verdict === "falsified" ? -1.5 : verdict === "weakened" ? -0.75 : 0;
  }
  return verdict === "supported" ? 1 : verdict === "falsified" ? -1 : verdict === "weakened" ? -0.5 : 0;
}

function inferValidationVerdict({ validation = {}, result = null, hypothesis = {}, defaultVerdict = "inconclusive" }) {
  const validationType = String(validation?.validation_type || "");
  const executionStatus = String(result?.execution_status || "").toLowerCase();
  const failureReason = String(result?.failure_reason || "").toLowerCase();
  const latestStatus = String(result?.diagnostics?.latest_status || hypothesis?.latest_status || hypothesis?.state || "").toLowerCase();
  const diagnostics = result?.diagnostics || {};

  if (validationType === "measurement_artifact_test") {
    if (
      failureReason.includes("measurement") ||
      failureReason.includes("artifact") ||
      String(diagnostics?.measurement_quality_adjusted || "").includes("attenuated")
    ) return "falsified";
    if (executionStatus === "completed_with_warning" || executionStatus === "completed_exploratory") return "weakened";
    if (executionStatus.startsWith("completed")) return "supported";
  }

  if (validationType === "mediation_vs_proxy_test") {
    if (
      failureReason.includes("proxy") ||
      failureReason.includes("attenuated") ||
      String(diagnostics?.mediation_result || "").includes("proxy")
    ) return "falsified";
    if (executionStatus === "completed_with_warning" || executionStatus === "completed_exploratory") return "weakened";
    if (executionStatus.startsWith("completed")) return "supported";
  }

  if (validationType === "family_pairwise_contest" || validationType === "structure_contest") {
    if (failureReason.includes("rival") || failureReason.includes("pairwise_loss") || failureReason.includes("lost_contest")) return "falsified";
    if (executionStatus === "completed_with_warning" || executionStatus === "completed_exploratory") return "weakened";
    if (executionStatus.startsWith("completed")) return latestStatus === "weak" ? "weakened" : "supported";
  }

  if (executionStatus === "failed" || executionStatus === "rejected") return "falsified";
  if (executionStatus === "completed_with_warning" || executionStatus === "completed_exploratory") return "weakened";
  if (executionStatus === "completed") return latestStatus === "weak" ? "weakened" : "supported";

  return defaultVerdict;
}

function familyDeltaForValidation(validationType, verdict) {
  if (validationType === "family_pairwise_contest") {
    return verdict === "supported" ? 16 : verdict === "falsified" ? -14 : verdict === "weakened" ? -7 : 0;
  }
  if (validationType === "measurement_artifact_test") {
    return verdict === "supported" ? 6 : verdict === "falsified" ? -12 : verdict === "weakened" ? -8 : 0;
  }
  if (validationType === "mediation_vs_proxy_test") {
    return verdict === "supported" ? 8 : verdict === "falsified" ? -10 : verdict === "weakened" ? -6 : 0;
  }
  if (validationType === "structure_contest") {
    return verdict === "supported" ? 10 : verdict === "falsified" ? -9 : verdict === "weakened" ? -5 : 0;
  }
  return verdict === "supported" ? 12 : verdict === "falsified" ? -10 : verdict === "weakened" ? -4 : 0;
}

function buildValidationPlan({ hypotheses = [], familyStateSummary = [], datasetProfile = null, validationDesignCandidates = null }) {
  const planned = [];
  const seen = new Set();
  const activeHypotheses = hypotheses.filter((item) => String(item?.state || "") !== "retired");
  const profile = datasetProfile || buildDatasetProfile({});
  const designCandidates = asArray(validationDesignCandidates).length
    ? asArray(validationDesignCandidates)
    : selectValidationDesigns(profile, activeHypotheses);
  const bestFeasibleDesign = designCandidates.find((item) => item?.feasible) || designCandidates[0] || null;
  const rankedFamilies = asArray(familyStateSummary)
    .map((item) => ({
      family_root: item.family_root,
      count: Number(item.count || 0),
    }))
    .filter((item) => item.family_root)
    .sort((a, b) => b.count - a.count || String(a.family_root).localeCompare(String(b.family_root)));

  for (const item of activeHypotheses) {
    const hypothesisId = String(item?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    const familyRoot = String(item?.family_root || "").trim();
    const edgeId = edgeIdForHypothesis(item);
    const required = new Set([
      ...asArray(item?.test_plan).map(normalizeValidationRequirement),
      ...asArray(item?.required_validations).map(normalizeValidationRequirement),
    ].filter(Boolean));
    required.add("edge_robustness_test");
    if (String(item?.condition || "").trim()) required.add("subgroup_stability_test");
    if (familyRoot === "measurement_quality") required.add("measurement_artifact_test");
    let sequence = 1;
    for (const requiredValidation of required) {
      const validationType = normalizeValidationRequirement(requiredValidation) || "edge_robustness_test";
      const validationId = `validation:${hypothesisId}:${sequence}`;
      const key = `${validationType}:${hypothesisId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const validationTarget = buildValidationTarget({ hypothesis: item, profile, design: bestFeasibleDesign });
      planned.push({
        validation_id: validationId,
        validation_type: validationType,
        target_hypothesis_ids: [hypothesisId],
        target_family_ids: familyRoot ? [familyNodeId(familyRoot)] : [],
        target_edges: edgeId && !validationTarget.design_blocked ? [edgeId] : [],
        selected_design_id: validationTarget.selected_design_id,
        validation_target: validationTarget,
        purpose:
          validationType === "measurement_artifact_test"
            ? "Stress-test whether measurement quality explains the observed association."
            : validationType === "mediation_vs_proxy_test"
              ? "Distinguish direct effect from proxy or mediation explanations."
              : validationType === "family_pairwise_contest"
                ? "Compare rival family-rooted packages on matched outcome and robustness criteria."
                : validationType === "structure_contest"
                  ? "Test whether a rival structure explains the outcome better than the incumbent structure."
            : validationType === "subgroup_stability_test"
              ? "Resolve graph uncertainty about subgroup or conditional stability."
              : "Resolve whether the primary predictive edge remains stable under validation.",
        priority: String(item?.state || "") === "provisionally_promoted" ? "high" : "medium",
      });
      sequence += 1;
    }
  }

  if (rankedFamilies.length >= 2) {
    const left = rankedFamilies[0].family_root;
    const right = rankedFamilies[1].family_root;
    planned.push({
      validation_id: `validation:family-contest:${left}:${right}`,
      validation_type: "family_pairwise_contest",
      target_hypothesis_ids: activeHypotheses
        .filter((item) => item.family_root === left || item.family_root === right)
        .slice(0, 4)
        .map((item) => item.hypothesis_id),
      target_family_ids: [familyNodeId(left), familyNodeId(right)].filter(Boolean),
      target_edges: activeHypotheses
        .filter((item) => item.family_root === left || item.family_root === right)
        .map(edgeIdForHypothesis)
        .filter(Boolean)
        .slice(0, 4),
      purpose: "Compare incumbent and challenger family explanatory stability in a direct contest.",
      priority: "high",
    });
  }

  if (rankedFamilies.some((item) => item.family_root === "measurement_quality")) {
    planned.push({
      validation_id: "validation:measurement-quality:stress-test",
      validation_type: "measurement_artifact_test",
      target_hypothesis_ids: activeHypotheses
        .filter((item) => item.family_root !== "measurement_quality")
        .slice(0, 4)
        .map((item) => item.hypothesis_id),
      target_family_ids: [familyNodeId("measurement_quality")],
      target_edges: activeHypotheses.map(edgeIdForHypothesis).filter(Boolean).slice(0, 6),
      purpose: "Test whether measurement-quality artifacts materially weaken substantive family claims.",
      priority: "high",
    });
  }

  return {
    dataset_profile: profile,
    validation_design_candidates: designCandidates,
    planned_validations: planned,
  };
}

function buildEvidencePackets({ hypotheses = [], validationPlan = {}, validationResults = {} }) {
  const packets = [];
  const validations = asArray(validationPlan?.planned_validations);
  const validationByHypothesis = new Map();
  const validationResultById = new Map(
    asArray(validationResults?.validation_results).map((item) => [String(item?.validation_id || ""), item]),
  );
  for (const validation of validations) {
    for (const hypothesisId of asArray(validation?.target_hypothesis_ids)) {
      if (!validationByHypothesis.has(hypothesisId)) validationByHypothesis.set(hypothesisId, []);
      validationByHypothesis.get(hypothesisId).push(validation);
    }
  }
  for (const result of asArray(validationResults?.validation_results)) {
    const validationId = String(result?.validation_id || "").trim();
    if (!validationId) continue;
    for (const hypothesisId of asArray(result?.target_hypothesis_ids)) {
      if (!validationByHypothesis.has(hypothesisId)) validationByHypothesis.set(hypothesisId, []);
      const bucket = validationByHypothesis.get(hypothesisId);
      if (bucket.some((entry) => String(entry?.validation_id || "") === validationId)) continue;
      bucket.push({
        validation_id: validationId,
        validation_type: result?.validation_type || "runner_output_validation",
        target_hypothesis_ids: asArray(result?.target_hypothesis_ids),
        target_family_ids: asArray(result?.target_family_ids),
        target_edges: asArray(result?.target_edges),
        purpose: result?.provenance?.summary || "Normalize executed runner output into graph-update evidence.",
      });
    }
  }

  for (const item of hypotheses) {
    const hypothesisId = String(item?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    const familyRoot = String(item?.family_root || "").trim();
    const defaultVerdict = statusToVerdict(item?.latest_status || item?.state);
    const promotionGate = graphPromotionGate(item);
    const analysisMeasures = metricObject(item?.analysis_results);
    const validationsForHypothesis = validationByHypothesis.get(hypothesisId) || [];
    const plannedEdgeIds = new Set(validationsForHypothesis.flatMap((entry) => asArray(entry?.target_edges)));
    const candidateEdgeId = edgeIdForHypothesis(item);
    const edgeId = promotionGate.promotable && candidateEdgeId && plannedEdgeIds.has(candidateEdgeId) ? candidateEdgeId : null;
    const pairwiseContest = validationsForHypothesis.find((entry) => entry.validation_type === "family_pairwise_contest");
    const validationOutcomes = validationsForHypothesis.map((validation) => {
      const result = validationResultById.get(String(validation?.validation_id || ""));
      const verdict = inferValidationVerdict({ validation, result, hypothesis: item, defaultVerdict });
      return {
        validation_id: validation.validation_id,
        validation_type: validation.validation_type,
        verdict,
        result,
        edge_weight: validationWeight(validation.validation_type, verdict),
        family_delta: familyDeltaForValidation(validation.validation_type, verdict),
      };
    });
    const verdictCounts = validationOutcomes.reduce((acc, entry) => {
      acc[entry.verdict] = (acc[entry.verdict] || 0) + 1;
      return acc;
    }, {});
    const verdict =
      verdictCounts.falsified > 0
        ? "falsified"
        : verdictCounts.weakened > 0
          ? "weakened"
          : verdictCounts.supported > 0
            ? "supported"
            : defaultVerdict;
    const familyImplications = [];
    const familyDelta = validationOutcomes.reduce((sum, entry) => sum + Number(entry.family_delta || 0), 0);
    if (familyRoot) {
      familyImplications.push({
        family_id: familyNodeId(familyRoot),
        family_root: familyRoot,
        delta_score: familyDelta,
        reason:
          verdict === "supported"
            ? "Primary edge and family package remained supported under available validations."
            : verdict === "falsified"
              ? "Primary edge was weak or contradicted in available validations."
              : "Validation evidence remains inconclusive or mixed.",
      });
    }
    for (const rival of asArray(item?.rival_to).slice(0, 3)) {
      const rivalDelta = validationOutcomes.reduce((sum, entry) => {
        if (entry.validation_type === "family_pairwise_contest" || entry.validation_type === "structure_contest") {
          return sum + (entry.verdict === "supported" ? -6 : entry.verdict === "falsified" ? 8 : 0);
        }
        if (entry.validation_type === "measurement_artifact_test" && entry.verdict === "falsified") {
          return sum + 5;
        }
        return sum;
      }, 0);
      familyImplications.push({
        family_id: familyNodeId(rival),
        family_root: rival,
        delta_score: rivalDelta,
        reason:
          verdict === "supported"
            ? "Rival family underperformed against the supported family-rooted hypothesis."
            : verdict === "falsified"
              ? "Rival family gains room when the tested family weakens."
              : "No directional implication established yet.",
      });
    }

    packets.push(createEvidencePacket({
      id: `evidence:${hypothesisId}`,
      validation_id: validationsForHypothesis[0]?.validation_id || "",
      hypothesis_id: hypothesisId,
      family_root: familyRoot,
      target_ids: [hypothesisNodeId(hypothesisId), familyNodeId(familyRoot), edgeId].filter(Boolean),
      outcome: item?.y_variable || "",
      verdict,
      summary: promotionGate.promotable
        ? (pairwiseContest
          ? `${hypothesisId} evaluated under ${pairwiseContest.validation_type} and companion validations with validation-type-specific weighting.`
          : `${hypothesisId} normalized into a graph-update-ready evidence packet.`)
        : `${hypothesisId} normalized as evidence, but graph edge promotion was blocked by topic-quality gate: ${promotionGate.blocked_fields.join(",")}.`,
      measures: {
        ...analysisMeasures,
        validation_type_counts: validationsForHypothesis.reduce((acc, entry) => {
          acc[entry.validation_type] = (acc[entry.validation_type] || 0) + 1;
          return acc;
        }, {}),
        graph_promotion_blocked: !promotionGate.promotable,
        graph_promotion_block_reason: promotionGate.reason,
      },
      graph_updates: [
        edgeId ? {
          target_type: "edge",
          target_id: edgeId,
          hypothesis_id: hypothesisId,
          family_root: familyRoot,
          operation: verdict === "supported" ? "support" : verdict === "falsified" ? "falsify" : verdict === "weakened" ? "weaken" : "mark_inconclusive",
          relation: "predicts",
          delta: validationOutcomes.reduce((sum, entry) => sum + Number(entry.edge_weight || 0), 0),
          rationale: `Derived from normalized validation outcomes: ${validationOutcomes.map((entry) => `${entry.validation_type}:${entry.verdict}`).join(", ") || "no_validation_outcome"}.`,
        } : null,
        familyRoot ? {
          target_type: "family",
          target_id: familyNodeId(familyRoot),
          hypothesis_id: hypothesisId,
          family_root: familyRoot,
          operation: verdict === "supported" ? "strengthen" : verdict === "falsified" ? "demote" : verdict === "weakened" ? "challenge" : "observe",
          relation: "family_state",
          delta: familyDelta,
          rationale: "Family-level implication derived from validation-type-specific graph update rules.",
        } : null,
        {
          target_type: "hypothesis",
          target_id: hypothesisNodeId(hypothesisId),
          hypothesis_id: hypothesisId,
          family_root: familyRoot,
          operation: "set_state",
          relation: "hypothesis_state",
          delta: null,
          rationale: stateUpdateFromVerdict(verdict),
        },
      ].filter(Boolean),
      provenance: asArray(item?.validating_lanes),
    }));

    packets[packets.length - 1].hypothesis_id = hypothesisId;
    packets[packets.length - 1].tested_edges = edgeId ? [{
      edge_id: edgeId,
      relation: "predicts",
      verdict,
      sign: String(item?.direction || "unknown"),
      effect_size: Number.isFinite(Number(analysisMeasures.primary_effect))
        ? Number(analysisMeasures.primary_effect)
        : Number.isFinite(Number(analysisMeasures.pooled_effect))
          ? Number(analysisMeasures.pooled_effect)
          : null,
      uncertainty: {
        supported_count: Number(verdictCounts.supported || 0),
        weakened_count: Number(verdictCounts.weakened || 0),
        falsified_count: Number(verdictCounts.falsified || 0),
      },
      robustness: {
        validation_count: validationsForHypothesis.length,
        validation_outcomes: validationOutcomes,
      },
    }] : [];
    packets[packets.length - 1].family_implications = familyImplications;
    packets[packets.length - 1].hypothesis_implication = {
      hypothesis_id: hypothesisId,
      verdict,
      state_update: stateUpdateFromVerdict(verdict),
    };
  }

  return {
    evidence_packets: packets,
  };
}

function nextFamilyState(currentState, delta) {
  const state = String(currentState || "candidate");
  if (delta >= 10) return state === "candidate" || state === "contending" ? "provisionally_promoted" : state;
  if (delta <= -10) return "demoted";
  if (delta < 0) return state === "provisionally_promoted" ? "challenged" : state === "candidate" ? "contending" : "challenged";
  return state;
}

function nextHypothesisState(currentState, update) {
  if (update === "strengthened") return "strengthened";
  if (update === "demoted") return "demoted";
  if (update === "challenged") return "challenged";
  return currentState || "candidate";
}

function applyGateReviewSignals({ graph, gateReview = null, familyScores = null, hypothesisState = null, diffs = null }) {
  if (!gateReview || typeof gateReview !== "object") return;
  const reviewFamilies = new Map();
  const crossFamilyAlternatives = asArray(gateReview?.cross_family_alternatives);
  for (const alt of crossFamilyAlternatives) {
    const familyId = String(alt?.family_root || alt?.family_id || "").replace(/^family:/, "").trim();
    if (!familyId) continue;
    reviewFamilies.set(familyId, (reviewFamilies.get(familyId) || 0) + 1);
  }

  const incumbentCandidates = Array.from((familyScores || new Map()).entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const incumbentFamily = incumbentCandidates[0]?.[0] || null;
  if (!incumbentFamily) return;

  const incumbentNodeId = familyNodeId(incumbentFamily);
  const incumbentNode = graph.nodeMap.get(incumbentNodeId);
  if (!incumbentNode) return;

  const objections = asArray(gateReview?.incumbent_rejection_reasons).length + asArray(gateReview?.switch_triggers).length;
  const challengerSupport = Array.from(reviewFamilies.values()).reduce((sum, value) => sum + value, 0);
  if (objections <= 0 && challengerSupport <= 0) return;

  const operation = objections >= 2 && challengerSupport > 0 ? "demote" : "challenge";
  const delta = operation === "demote" ? -10 : -4;
  const nextNode = {
    ...incumbentNode,
    score: {
      ...(incumbentNode.score || {}),
      family_score: Number(incumbentNode.score?.family_score || 0) + delta,
      reviewer_burden_score: Number(incumbentNode.score?.reviewer_burden_score || 0) + objections,
    },
    state: operation === "demote" ? "demoted" : "challenged",
    provenance: Array.from(new Set([...(incumbentNode.provenance || []), "gate_review"].filter(Boolean))),
  };
  graph.nodeMap.set(incumbentNodeId, nextNode);
  diffs.push({
    target_type: "family",
    target_id: incumbentNodeId,
    operation,
    delta,
    evidence_id: "gate_review",
    source_lane_ids: [],
    source_type: "gate_review",
    source_summary: "Gate review challenged incumbent family state.",
  });

  for (const [familyId, count] of reviewFamilies.entries()) {
    const nodeId = familyNodeId(familyId);
    const node = graph.nodeMap.get(nodeId);
    if (!node) continue;
    const next = {
      ...node,
      score: {
        ...(node.score || {}),
        family_score: Number(node.score?.family_score || 0) + count * 3,
      },
      provenance: Array.from(new Set([...(node.provenance || []), "gate_review"].filter(Boolean))),
    };
    graph.nodeMap.set(nodeId, next);
    diffs.push({
      target_type: "family",
      target_id: nodeId,
      operation: "strengthen",
      delta: count * 3,
      evidence_id: "gate_review",
      source_lane_ids: [],
      source_type: "gate_review",
      source_summary: "Gate review strengthened challenger family signal.",
    });
  }

  for (const [targetId, currentState] of hypothesisState.entries()) {
    if (!targetId.includes(incumbentFamily)) continue;
    hypothesisState.set(targetId, operation === "demote" ? "demoted" : nextHypothesisState(currentState, "challenged"));
  }
}

function applyEvidencePackets({ dataGraph = {}, evidencePackets = {}, hypotheses = [], gateReview = null }) {
  const graph = createDataGraph(dataGraph);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id || `${edge.from}:${edge.relation}:${edge.to}`, { ...edge }]));
  const hypothesisById = new Map(
    hypotheses
      .map((item) => [String(item?.hypothesis_id || "").trim(), item])
      .filter((entry) => entry[0]),
  );
  const hypothesisFamilyRoot = new Map(
    hypotheses
      .map((item) => [hypothesisNodeId(item?.hypothesis_id), String(item?.family_root || "").trim()])
      .filter((entry) => entry[0] && entry[1]),
  );
  const hypothesisState = new Map(
    hypotheses.map((item) => [hypothesisNodeId(item?.hypothesis_id), String(item?.state || item?.latest_status || "candidate")]),
  );
  const familyScores = new Map(
    graph.nodes
      .filter((node) => node.type === "family")
      .map((node) => [String(node.id || "").replace(/^family:/, ""), Number(node.score?.family_score || 0)]),
  );
  const diffs = [];

  for (const packet of asArray(evidencePackets?.evidence_packets)) {
    const packetFamilyRoot = String(packet?.family_root || "").trim();
    const packetHypothesisId = String(packet?.hypothesis_id || "").trim();
    for (const update of asArray(packet?.graph_updates)) {
      const updateFamilyRoot = String(update?.family_root || packetFamilyRoot || "").trim();
      const updateHypothesisId = String(update?.hypothesis_id || packetHypothesisId || "").trim();
      if (update.target_type === "edge") {
        let edge = edgeMap.get(update.target_id);
        if (!edge) {
          const parsed = parsePredictiveEdgeId(update.target_id);
          if (!parsed) continue;
          edge = {
            id: update.target_id,
            from: parsed.from,
            to: parsed.to,
            relation: parsed.relation,
            score: { support_score: 0, falsification_score: 0, instability_score: 0, update_count: 0 },
            status: "untested",
            weight: null,
            metadata: {
              family_root: updateFamilyRoot || packetFamilyRoot || null,
              hypothesis_id: updateHypothesisId || packetHypothesisId || null,
              source_kind: "validation",
            },
            provenance: uniqueStrings([packet.evidence_packet_id, packet.validation_id, ...(packet.provenance || [])]),
          };
          edgeMap.set(update.target_id, edge);

          for (const [nodeId, label] of [
            [parsed.from, parsed.from.replace(/^variable:/, "").replace(/-/g, "_")],
            [parsed.to, parsed.to.replace(/^variable:/, "").replace(/-/g, "_")],
          ]) {
            if (!nodeMap.has(nodeId)) {
              nodeMap.set(nodeId, {
                id: nodeId,
                type: "variable",
                label,
                provenance: uniqueStrings([updateHypothesisId || packetHypothesisId].filter(Boolean)),
              });
            }
          }
        }
        const currentScore = Number(edge.score?.support_score || 0);
        const currentFalsification = Number(edge.score?.falsification_score || 0);
        const currentInstability = Number(edge.score?.instability_score || 0);
        const currentUpdateCount = Number(edge.score?.update_count || 0);
        const nextEdge = {
          ...edge,
          score: {
            ...(edge.score || {}),
            support_score: update.operation === "support" ? currentScore + 1 : currentScore,
            falsification_score: update.operation === "falsify" ? currentFalsification + 1 : currentFalsification,
            instability_score: update.operation === "weaken" ? currentInstability + 1 : currentInstability,
            update_count: currentUpdateCount + 1,
          },
          weight: Number.isFinite(Number(update.delta)) ? Number(update.delta) : edge.weight ?? null,
          status:
            update.operation === "support"
              ? "supported"
              : update.operation === "falsify"
                ? "falsified"
                : update.operation === "weaken"
                  ? "challenged"
                  : "inconclusive",
          metadata: {
            ...(edge.metadata || {}),
            family_root: updateFamilyRoot || edge.metadata?.family_root || null,
            hypothesis_id: updateHypothesisId || edge.metadata?.hypothesis_id || null,
            last_update_operation: update.operation,
            last_update_rationale: update.rationale || null,
            last_validation_id: packet.validation_id || null,
          },
          provenance: uniqueStrings([...(edge.provenance || []), packet.evidence_packet_id, packet.validation_id, ...(packet.provenance || [])]),
        };
        nextEdge.metadata = {
          ...(nextEdge.metadata || {}),
          source_kind: currentUpdateCount > 0 || edge.metadata?.source_kind === "validation" ? "validation" : (edge.metadata?.source_kind || "validation"),
        };
        nextEdge.metadata.evidence_stage = nextEdge.metadata.source_kind === "validation" ? "validated" : "literature";
        nextEdge.metadata.confidence_tier = edgeConfidenceTier({
          status: nextEdge.status,
          updateCount: Number(nextEdge.score?.update_count || 0),
          supportScore: Number(nextEdge.score?.support_score || 0),
          falsificationScore: Number(nextEdge.score?.falsification_score || 0),
          sourceKind: nextEdge.metadata.source_kind,
        });
        nextEdge.score.evidence_rank = edgeEvidenceRank({
          status: nextEdge.status,
          updateCount: Number(nextEdge.score?.update_count || 0),
          supportScore: Number(nextEdge.score?.support_score || 0),
          falsificationScore: Number(nextEdge.score?.falsification_score || 0),
          instabilityScore: Number(nextEdge.score?.instability_score || 0),
          sourceKind: nextEdge.metadata.source_kind,
        });
        edgeMap.set(update.target_id, nextEdge);
        diffs.push({
          target_type: "edge",
          target_id: update.target_id,
          operation: update.operation,
          evidence_id: packet.evidence_packet_id,
          family_root: updateFamilyRoot || null,
          hypothesis_id: updateHypothesisId || null,
          validation_id: packet.validation_id || null,
          ...diffProvenanceFields(packet),
        });
      }
      if (update.target_type === "family") {
        const node = nodeMap.get(update.target_id);
        if (!node) continue;
        const currentAggregate = Number(node.score?.family_score || 0);
        const delta = Number(update.delta || 0);
        const nextNode = {
          ...node,
          score: {
            ...(node.score || {}),
            family_score: currentAggregate + delta,
            update_count: Number(node.score?.update_count || 0) + 1,
          },
          state: nextFamilyState(node.state, delta),
          metadata: {
            ...(node.metadata || {}),
            family_root: updateFamilyRoot || String(update.target_id || "").replace(/^family:/, "") || null,
            hypothesis_id: updateHypothesisId || node.metadata?.hypothesis_id || null,
            last_update_operation: update.operation,
            last_update_rationale: update.rationale || null,
            last_validation_id: packet.validation_id || null,
          },
          provenance: uniqueStrings([...(node.provenance || []), packet.evidence_packet_id, packet.validation_id, ...(packet.provenance || [])]),
        };
        nodeMap.set(update.target_id, nextNode);
        familyScores.set(String(update.target_id || "").replace(/^family:/, ""), currentAggregate + delta);
        diffs.push({
          target_type: "family",
          target_id: update.target_id,
          operation: update.operation,
          delta,
          evidence_id: packet.evidence_packet_id,
          family_root: updateFamilyRoot || String(update.target_id || "").replace(/^family:/, "") || null,
          hypothesis_id: updateHypothesisId || null,
          validation_id: packet.validation_id || null,
          ...diffProvenanceFields(packet),
        });
      }
      if (update.target_type === "hypothesis") {
        const current = hypothesisState.get(update.target_id) || "candidate";
        const next = nextHypothesisState(current, update.rationale || update.next_state || update.operation);
        hypothesisState.set(update.target_id, next);
        const node = nodeMap.get(update.target_id);
        if (node) {
          nodeMap.set(update.target_id, {
            ...node,
            state: next,
            score: {
              ...(node.score || {}),
              update_count: Number(node.score?.update_count || 0) + 1,
            },
            metadata: {
              ...(node.metadata || {}),
              family_root: updateFamilyRoot || hypothesisFamilyRoot.get(update.target_id) || node.metadata?.family_root || null,
              graph_update_state: next,
              last_update_operation: update.operation,
              last_update_rationale: update.rationale || null,
              last_validation_id: packet.validation_id || null,
            },
            provenance: uniqueStrings([...(node.provenance || []), packet.evidence_packet_id, packet.validation_id, ...(packet.provenance || [])]),
          });
        }
        diffs.push({
          target_type: "hypothesis",
          target_id: update.target_id,
          operation: update.operation,
          next_state: next,
          evidence_id: packet.evidence_packet_id,
          family_root: updateFamilyRoot || hypothesisFamilyRoot.get(update.target_id) || null,
          hypothesis_id: updateHypothesisId || String(update.target_id || "").replace(/^hypothesis:/, "") || null,
          validation_id: packet.validation_id || null,
          ...diffProvenanceFields(packet),
        });
      }
    }
  }

  applyGateReviewSignals({
    graph: { nodeMap, edgeMap },
    gateReview,
    familyScores,
    hypothesisState,
    diffs,
  });

  const updatedGraph = createDataGraph({
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  });
  const validationCoverage = asArray(evidencePackets?.evidence_packets)
    .flatMap((packet) => asArray(packet?.tested_edges))
    .flatMap((entry) => asArray(entry?.robustness?.validation_outcomes))
    .reduce((acc, entry) => {
      const key = String(entry?.validation_type || "").trim();
      if (!key) return acc;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

  return {
    data_graph: updatedGraph,
    graph_diff: {
      generated_at: new Date().toISOString(),
      updates: diffs,
      validation_coverage: validationCoverage,
      updated_hypothesis_states: Array.from(hypothesisState.entries()).map(([target_id, state]) => ({
        target_id,
        state,
      })),
    },
  };
}

function buildValidationArtifacts({ cwd = process.cwd(), cycleId, hypotheses = [], familyStateSummary = [], validationResults = null }) {
  const root = runtimeRoot(cwd);
  const stateDir = path.join(root, "state");
  // Every record below enters chronicle's context, and chronicle's output is
  // what every other role reasons over. Admit them the way MBM-Core requires.
  const admit = cycleStateReader({ root, cycleId, task: "chronicle_validation_artifacts", stage: "evidence" });
  const literaturePath = path.join(root, "plans", `${cycleId}-lab-director-literature.json`);
  const literature = admit.path(literaturePath, "lab-director-literature") || {};
  const gateReviewPath = path.join(stateDir, `${cycleId}-gate-review.json`);
  const gateReview = admit.path(gateReviewPath, "gate-review");
  const baseDataGraph =
    literature?.data_graph && Array.isArray(literature.data_graph.nodes) && literature.data_graph.nodes.length > 0
      ? literature.data_graph
      : fallbackBaseDataGraph(hypotheses);
  const datasetProfile = buildDatasetProfile({ literature, dataGraph: literature?.data_graph || null, cwd, cycleId });
  const validationDesignCandidates = selectValidationDesigns(datasetProfile, hypotheses);
  const validationPlan = buildValidationPlan({ hypotheses, familyStateSummary, datasetProfile, validationDesignCandidates });
  const validationResultsPath = path.join(stateDir, `${cycleId}-validation-results.json`);
  const rawValidationResults = validationResults
    || admit.path(validationResultsPath, "validation-results")
    || buildValidationResultsArtifact({ cwd, cycleId, hypotheses, validationPlan });
  const evidencePackets = buildEvidencePackets({ hypotheses, validationPlan, validationResults: rawValidationResults });
  const graphUpdate = applyEvidencePackets({
    dataGraph: baseDataGraph,
    evidencePackets,
    hypotheses,
    gateReview,
  });
  const reasoningGraph = buildReasoningGraphArtifact({
    cycleId,
    hypotheses,
    evidencePackets,
    validationResults: rawValidationResults,
    graphDiff: graphUpdate.graph_diff,
  });
  const knowledgeGraph = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    graph_kind: "knowledge_graph_bundle",
    literature_graph: literature?.literature_graph || null,
    reasoning_graph: reasoningGraph,
  };

  const validationPlanPath = path.join(stateDir, `${cycleId}-validation-plan.json`);
  const evidencePacketsPath = path.join(stateDir, `${cycleId}-evidence-packets.json`);
  const dataGraphPath = path.join(stateDir, `${cycleId}-data-graph.json`);
  const graphDiffPath = path.join(stateDir, `${cycleId}-graph-update-log.json`);
  const reasoningGraphPath = path.join(stateDir, `${cycleId}-reasoning-graph.json`);
  const knowledgeGraphPath = path.join(stateDir, `${cycleId}-knowledge-graph.json`);

  writeJson(validationPlanPath, validationPlan);
  writeJson(evidencePacketsPath, evidencePackets);
  // Never clobber a populated data graph with an empty one. A chronicle
  // re-bootstrap can build graphUpdate.data_graph from an empty node/edge map
  // (before it repopulates), and an unconditional write then wipes the KG that
  // scouts + prior passes accumulated — destroying the data nodes and the
  // literature<->data bridge edges the conclusion rubric scores on. An empty
  // graph is never a valid replacement for a populated one; keep the existing.
  const nextDataGraphNodeCount = Array.isArray(graphUpdate.data_graph?.nodes)
    ? graphUpdate.data_graph.nodes.length
    : 0;
  let skipDataGraphWrite = false;
  if (nextDataGraphNodeCount === 0) {
    const existingDataGraph = readJson(dataGraphPath);
    const existingDataGraphNodeCount = Array.isArray(existingDataGraph?.nodes)
      ? existingDataGraph.nodes.length
      : 0;
    skipDataGraphWrite = existingDataGraphNodeCount > 0;
  }
  if (!skipDataGraphWrite) {
    writeJson(dataGraphPath, graphUpdate.data_graph);
  }
  writeJson(graphDiffPath, graphUpdate.graph_diff);
  writeJson(reasoningGraphPath, reasoningGraph);
  writeJson(knowledgeGraphPath, knowledgeGraph);

  // Post-cycle vocabulary drift check. Advisory-only — a populated
  // warnings array does not block the cycle.
  const vocabLintPath = path.join(stateDir, `${cycleId}-vocabulary-lint.json`);
  let vocabularyLint = null;
  try {
    vocabularyLint = lintCycleArtifact(dataGraphPath, {
      cycleId,
      outputPath: vocabLintPath,
    });
  } catch (err) {
    vocabularyLint = { error: String(err && err.message ? err.message : err) };
    writeJson(vocabLintPath, vocabularyLint);
  }

  return {
    validationPlan,
    evidencePackets,
    graphUpdate,
    reasoningGraph,
    knowledgeGraph,
    validationResults: rawValidationResults,
    vocabularyLint,
    paths: {
      validation_plan: validationPlanPath,
      evidence_packets: evidencePacketsPath,
      data_graph: dataGraphPath,
      graph_update_log: graphDiffPath,
      reasoning_graph: reasoningGraphPath,
      knowledge_graph: knowledgeGraphPath,
      vocabulary_lint: vocabLintPath,
    },
  };
}

module.exports = {
  buildValidationPlan,
  buildEvidencePackets,
  applyEvidencePackets,
  buildValidationArtifacts,
  __private: { buildReasoningGraphArtifact, graphPromotionGate, buildDatasetProfile, selectValidationDesigns, buildValidationTarget },
};
