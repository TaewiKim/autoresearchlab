"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const fs = require("fs");
const { ensureDir, readJson, writeJson } = require("../../shared/json");
const { loadCycleEvidence } = require("../shared/cycle_evidence");
const { resolveProfile, designShiftForMode } = require("../shared/derived_profile");

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function uniquePaths(paths = []) {
  return Array.from(new Set(asArray(paths).map((item) => String(item || "").trim()).filter(Boolean)));
}

function existingPaths(fs, paths = []) {
  return uniquePaths(paths).filter((filePath) => fs.existsSync(filePath));
}

function missingPaths(fs, paths = []) {
  return uniquePaths(paths).filter((filePath) => !fs.existsSync(filePath));
}

function familyNodeMap(dataGraph = {}) {
  return new Map(
    asArray(dataGraph?.nodes)
      .filter((node) => node?.type === "family")
      .map((node) => [String(node.id || "").replace(/^family:/, ""), node]),
  );
}

function enrichFamilyNomination({ familyNomination = [], hypotheses = [], familyPackageLedger = {}, dataGraph = {} }) {
  const nominationByFamily = new Map();
  for (const item of asArray(familyNomination)) {
    const familyRoot = String(item?.family_root || item?.family_id || "").trim();
    if (!familyRoot) continue;
    nominationByFamily.set(familyRoot, {
      family_root: familyRoot,
      nominated: item?.nominated !== false,
      support_count: Number(item?.support_count || 0),
      hypothesis_count: Number(item?.hypothesis_count || 0),
      primary_exposures: asArray(item?.primary_exposures),
      sample_claims: asArray(item?.sample_claims),
      mechanisms: asArray(item?.mechanisms),
    });
  }
  for (const item of asArray(hypotheses)) {
    const familyRoot = String(item?.family_root || "").trim();
    if (!familyRoot) continue;
    if (!nominationByFamily.has(familyRoot)) {
      nominationByFamily.set(familyRoot, {
        family_root: familyRoot,
        nominated: true,
        support_count: 0,
        hypothesis_count: 0,
        primary_exposures: [],
        sample_claims: [],
        mechanisms: [],
      });
    }
    const entry = nominationByFamily.get(familyRoot);
    entry.support_count += Number(item?.support_count || 0);
    entry.hypothesis_count += 1;
    if (item?.primary_exposure && !entry.primary_exposures.includes(item.primary_exposure)) {
      entry.primary_exposures.push(item.primary_exposure);
    }
    if (item?.statement && entry.sample_claims.length < 3 && !entry.sample_claims.includes(item.statement)) {
      entry.sample_claims.push(item.statement);
    }
    for (const mechanism of asArray(item?.mechanism_path || item?.mechanisms || item?.mechanism)) {
      if (entry.mechanisms.length >= 4) break;
      if (!entry.mechanisms.includes(mechanism)) entry.mechanisms.push(mechanism);
    }
  }

  const packageByFamily = new Map(
    asArray(familyPackageLedger?.family_packages).map((item) => [String(item.family_root || ""), item]),
  );
  const familyNodes = familyNodeMap(dataGraph);
  const allFamilies = Array.from(new Set([
    ...nominationByFamily.keys(),
    ...packageByFamily.keys(),
  ].filter(Boolean)));

  const nominated_families = allFamilies.map((familyRoot) => {
    const nomination = nominationByFamily.get(familyRoot) || {};
    const familyPackage = packageByFamily.get(familyRoot) || {};
    const familyNode = familyNodes.get(familyRoot) || {};
    const rivalFamilyIds = asArray(familyPackage?.rival_family_ids).length > 0
      ? asArray(familyPackage.rival_family_ids)
      : allFamilies.filter((item) => item !== familyRoot).slice(0, 4);
    const requiredValidations = asArray(familyPackage?.required_validations).length > 0
      ? asArray(familyPackage.required_validations)
      : ["edge_robustness_test", "family_pairwise_contest"];
    const supportCount = Number(nomination.support_count || familyPackage.support_count || 0);
    const topScore = Number(familyPackage.top_hypothesis_score || 0);
    const reviewerBurden = Number(familyNode?.score?.reviewer_burden_score || 0);
    const distinctivenessScore = Math.max(
      0,
      Math.min(
        100,
        35 +
          Math.min(25, asArray(nomination.mechanisms || familyPackage.mechanism_ids).length * 8) +
          Math.min(20, rivalFamilyIds.length * 5) +
          Math.min(20, topScore * 0.2) -
          Math.min(15, reviewerBurden * 3),
      ),
    );
    return {
      family_root: familyRoot,
      nominated: nomination.nominated !== false,
      nomination_reason:
        reviewerBurden > 0
          ? "Family remains important because it is contested and requires explicit rival comparison."
          : supportCount > 0
            ? "Family has active support in the current cycle and should remain in the tournament."
            : "Family remains a plausible rival package and should not be dropped prematurely.",
      distinctiveness_score: distinctivenessScore,
      required_validations: requiredValidations,
      rival_family_ids: rivalFamilyIds,
      support_count: supportCount,
      hypothesis_count: Number(nomination.hypothesis_count || 0),
      primary_exposures: asArray(nomination.primary_exposures || familyPackage.primary_exposure_variables),
      mechanisms: asArray(nomination.mechanisms || familyPackage.mechanism_ids),
      package_state: familyPackage.package_state || "candidate",
    };
  }).sort((a, b) =>
    b.distinctiveness_score - a.distinctiveness_score ||
    b.support_count - a.support_count ||
    a.family_root.localeCompare(b.family_root),
  );

  return {
    family_nomination: nominated_families,
    nominated_families: nominated_families.map((item) => item.family_root),
  };
}


function isNoiseGraphTerm(value) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[a-z]:[\\/]/i.test(raw) || raw.includes("/") || raw.includes("\\")) return true;
  if (/^(users?|home|var|tmp|private|volumes|workspace|openclaw|researchlab|runtime|artifacts|stats|lanes)(_|$)/.test(normalized)) return true;
  if (/(^|_)(users?|home|workspace|openclaw|researchlab|artifacts|stats|lanes|result|summary|json|csv|tsv|txt)(_|$)/.test(normalized) && normalized.split("_").length <= 4) return true;
  if (/^[a-z]+_[a-z0-9]+$/.test(normalized) && /^(users?|home)$/.test(normalized.split("_")[0])) return true;
  return false;
}

function hypothesisGraphPromotionGate(item = {}) {
  const blocked = [];
  for (const [field, value] of [["x_variable", item?.x_variable || item?.primary_exposure], ["y_variable", item?.y_variable || item?.outcome]]) {
    if (value && isNoiseGraphTerm(value)) blocked.push(field);
  }
  return {
    promotable: blocked.length === 0,
    blocked_fields: blocked,
    reason: blocked.length ? "path_or_runtime_token_detected" : null,
  };
}

function variableNodeId(variable) {
  if (!variable || isNoiseGraphTerm(variable)) return null;
  return `variable:${String(variable).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function edgeIdForHypothesis(item) {
  const x = variableNodeId(item?.x_variable || item?.primary_exposure || item?.primary_exposure_variables?.[0]);
  const y = variableNodeId(item?.y_variable || item?.outcome || item?.outcome_variables?.[0]);
  if (!x || !y) return null;
  return `edge:${x}:${y}:predicts`;
}

function validationStatusFromSummary(summary = {}, itemStatus = null) {
  const status = String(summary?.overall_status || itemStatus || "").toLowerCase();
  const hasCheckCount = Object.prototype.hasOwnProperty.call(summary, "checks_total");
  const failed = Number(hasCheckCount ? summary?.checks_failed || 0 : summary?.blueprints_failed || 0);
  const total = Number(hasCheckCount ? summary?.checks_total || 0 : summary?.blueprints_total || 0);
  const passed = Number(hasCheckCount ? summary?.checks_passed || 0 : summary?.blueprints_passed || 0);
  if (["failed", "error", "degraded"].includes(status) || failed > 0) return "completed_with_warning";
  if (status === "inconclusive") return "completed_with_warning";
  // A runner that reports "passed" without executing any blueprint/check is
  // only an exploratory artifact. Treating 0/0 as completed made validation
  // coverage look stronger than it really was.
  if (total <= 0 || passed <= 0) return "completed_exploratory";
  if (status === "passed" && failed === 0) return "completed";
  return itemStatus === "robust" ? "completed" : itemStatus === "weak" ? "completed_with_warning" : "completed_exploratory";
}

function normalizeRunnerValidationResults({ cwd = process.cwd(), cycleId, hypotheses = [], validationPlan = {} }) {
  if (!cycleId) return [];
  const root = runtimeRoot(cwd);
  const statsDir = path.join(root, "artifacts", "stats", cycleId);
  if (!fs.existsSync(statsDir)) return [];
  const hypothesisById = new Map(asArray(hypotheses).map((item) => [String(item?.hypothesis_id || ""), item]).filter(([id]) => id));
  const plannedByHypothesis = new Map();
  for (const validation of asArray(validationPlan?.planned_validations)) {
    for (const hypothesisId of asArray(validation?.target_hypothesis_ids)) {
      if (!plannedByHypothesis.has(hypothesisId)) plannedByHypothesis.set(hypothesisId, []);
      plannedByHypothesis.get(hypothesisId).push(validation);
    }
  }
  const out = [];
  for (const laneId of fs.readdirSync(statsDir).sort()) {
    const laneDir = path.join(statsDir, laneId);
    const resultPath = path.join(laneDir, "result.json");
    if (!fs.existsSync(resultPath)) continue;
    let result = null;
    try { result = readJson(resultPath); } catch (_) { continue; }
    const summary = result?.validation_summary && typeof result.validation_summary === "object" ? result.validation_summary : {};
    const items = asArray(result?.selected_hypotheses || result?.hypothesis_results);
    const primaryIds = Array.from(new Set([
      summary?.primary_hypothesis_id,
      ...items.map((item) => item?.hypothesis_id),
    ].map((item) => String(item || "").trim()).filter(Boolean)));
    if (primaryIds.length === 0 && !summary?.overall_status) continue;
    for (const hypothesisId of primaryIds.length ? primaryIds : [`runner:${laneId}`]) {
      const item = items.find((entry) => String(entry?.hypothesis_id || "") === hypothesisId) || hypothesisById.get(hypothesisId) || {};
      const planned = plannedByHypothesis.get(hypothesisId) || [];
      const gate = hypothesisGraphPromotionGate(item);
      const executedChecks = Number(summary?.checks_total || 0);
      const passedChecks = Number(summary?.checks_passed || 0);
      const totalChecks = executedChecks;
      const plannedTargets = planned.map((entry) => entry?.validation_target).filter(Boolean);
      const promotablePlannedTargets = plannedTargets.filter((target) => !target?.design_blocked);
      const selectedPlannedTarget = promotablePlannedTargets[0] || plannedTargets[0] || null;
      const hasDesignBlockedTargets = plannedTargets.some((target) => target?.design_blocked);
      const resultQualityGate = {
        promotable: gate.promotable && executedChecks > 0 && (plannedTargets.length === 0 || promotablePlannedTargets.length > 0),
        blocked_fields: gate.blocked_fields,
        reason: !gate.promotable
          ? gate.reason
          : executedChecks <= 0
            ? "no_executed_validation_checks"
            : plannedTargets.length > 0 && promotablePlannedTargets.length === 0
              ? "validation_target_design_blocked"
              : null,
        checks_total: totalChecks,
        checks_passed: passedChecks,
        validation_target_count: plannedTargets.length,
        design_blocked_target_count: plannedTargets.filter((target) => target?.design_blocked).length,
        validation_target_missing_requirements: uniquePaths(plannedTargets.flatMap((target) => asArray(target?.missing_requirements))),
        partial_design_block: hasDesignBlockedTargets && promotablePlannedTargets.length > 0,
      };
      const validationType = summary?.mode === "blueprint-execution" ? "runner_blueprint_validation" : "runner_output_validation";
      const summaryExecutionStatus = validationStatusFromSummary(summary, item?.status);
      const executionStatus =
        summaryExecutionStatus === "completed" && !resultQualityGate.promotable
          ? "completed_with_warning"
          : summaryExecutionStatus;
      const targetEdges = resultQualityGate.promotable
        ? Array.from(new Set([
            ...planned
              .filter((entry) => !entry?.validation_target?.design_blocked)
              .flatMap((entry) => asArray(entry?.target_edges)),
            edgeIdForHypothesis(item),
          ].filter(Boolean)))
        : [];
      out.push({
        validation_id: `validation:runner:${laneId}:${hypothesisId}`.replace(/[^a-zA-Z0-9:_-]+/g, "-"),
        validation_type: validationType,
        target_hypothesis_ids: hypothesisId.startsWith("runner:") ? [] : [hypothesisId],
        target_family_ids: Array.from(new Set([
          ...planned.flatMap((entry) => asArray(entry?.target_family_ids)),
          item?.family_root ? `family:${item.family_root}` : null,
        ].filter(Boolean))),
        target_edges: targetEdges,
        execution_status: executionStatus,
        model_spec: item?.validation_protocol?.model || result?.driver || summary?.driver || null,
        sample_definition: result?.dataset_root || item?.validation_protocol?.dataset || null,
        subgroup_definition: item?.condition || null,
        coefficients: asArray(item?.analysis_results).flatMap((entry) => asArray(entry?.metrics)).map((metric) => ({
          metric: metric.metric,
          value: Number(metric.value),
        })).filter((metric) => Number.isFinite(metric.value)),
        uncertainty: {},
        diagnostics: {
          source_lane_id: laneId,
          source_type: "runner_result",
          result_path: resultPath,
          validation_summary_path: result?.validation_summary_path || path.join(laneDir, "validation-summary.json"),
          analysis_trace_path: result?.analysis_trace_path || path.join(laneDir, "analysis-trace.json"),
          overall_status: summary?.overall_status || null,
          blueprints_total: Number(summary?.blueprints_total || 0),
          blueprints_passed: Number(summary?.blueprints_passed || 0),
          blueprints_failed: Number(summary?.blueprints_failed || 0),
          checks: summary?.checks || {},
          checks_passed: Number(summary?.checks_passed || 0),
          checks_failed: Number(summary?.checks_failed || 0),
          failed_checks: asArray(summary?.failed_checks),
          method_appropriateness_score: Number(summary?.method_appropriateness_score || 0),
          analysis_accuracy_score: Number(summary?.analysis_accuracy_score || 0),
          topic_extraction_quality: gate,
          result_quality_gate: resultQualityGate,
          validation_target: selectedPlannedTarget,
        },
        evidence_quality: {
          grade: summary?.overall_status === "passed" && resultQualityGate.promotable ? "executed" : "exploratory",
          method_appropriateness_score: Number(summary?.method_appropriateness_score || 0),
          analysis_accuracy_score: Number(summary?.analysis_accuracy_score || 0),
        },
        provenance: {
          lane_id: laneId,
          source_type: "runner_result",
          source_paths: [resultPath, result?.validation_summary_path, result?.analysis_trace_path].filter(Boolean),
          summary: summary?.overall_status
            ? `${laneId}: ${summary.overall_status}; passed ${Number(summary?.checks_passed || 0)}/${Number(summary?.checks_total || 0)} checks`
            : `${laneId}: runner result normalized`,
        },
        failure_reason: executionStatus === "completed"
          ? null
          : asArray(summary?.failed_checks).join(", ") || resultQualityGate.reason || summary?.overall_status || null,
      });
    }
  }
  return out;
}

function buildValidationResultsArtifact({ cwd = process.cwd(), cycleId = null, hypotheses = [], validationPlan = {} }) {
  const results = [];
  const validationByHypothesis = new Map();
  for (const validation of asArray(validationPlan?.planned_validations)) {
    for (const hypothesisId of asArray(validation?.target_hypothesis_ids)) {
      if (!validationByHypothesis.has(hypothesisId)) validationByHypothesis.set(hypothesisId, []);
      validationByHypothesis.get(hypothesisId).push(validation);
    }
  }

  for (const item of hypotheses) {
    const validations = validationByHypothesis.get(item?.hypothesis_id) || [];
    const metrics = asArray(item?.analysis_results).flatMap((entry) => asArray(entry?.metrics));
    const gate = hypothesisGraphPromotionGate(item);
    for (const validation of validations) {
      const validationType = String(validation?.validation_type || "").trim();
      const latestStatus = String(item?.latest_status || "").trim();
      results.push({
        validation_id: validation.validation_id,
        validation_type: validationType,
        target_hypothesis_ids: asArray(validation?.target_hypothesis_ids),
        target_family_ids: asArray(validation?.target_family_ids),
        target_edges: [],
        execution_status: latestStatus === "weak" || !gate.promotable || validation?.validation_target?.design_blocked
          ? "completed_with_warning"
          : "completed_exploratory",
        model_spec: item?.validation_protocol?.model || null,
        sample_definition: item?.validation_protocol?.dataset || "cycle_materialized_dataset",
        subgroup_definition: item?.condition || null,
        coefficients: metrics.map((metric) => ({
          metric: metric.metric,
          value: Number(metric.value),
        })),
        uncertainty: {},
        diagnostics: {
          latest_status: latestStatus || null,
          support_count: Number(item?.support_count || 0),
          topic_extraction_quality: gate,
          validation_target: validation?.validation_target || null,
          result_quality_gate: {
            promotable: false,
            reason: !gate.promotable
              ? gate.reason
              : validation?.validation_target?.design_blocked
                ? "validation_target_design_blocked"
                : "planned_validation_not_executed",
            validation_target_missing_requirements: asArray(validation?.validation_target?.missing_requirements),
          },
          mediation_result:
            validationType === "mediation_vs_proxy_test"
              ? latestStatus === "weak"
                ? "proxy_like"
                : "direct_or_resilient"
              : null,
          measurement_quality_adjusted:
            validationType === "measurement_artifact_test"
              ? latestStatus === "weak"
                ? "attenuated"
                : "stable"
              : null,
        },
        provenance: {
          lane_id: asArray(item?.validating_lanes)[0] || null,
          source_type: "hypothesis_ledger",
          source_paths: [],
          summary: `${item?.hypothesis_id || "hypothesis"} projected into planned validation ${validationType || "unknown"}; not an executed validation result`,
        },
        failure_reason:
          latestStatus === "weak"
            ? validationType === "measurement_artifact_test"
              ? "measurement_artifact_signal"
              : validationType === "mediation_vs_proxy_test"
                ? "proxy_effect"
                : validationType === "family_pairwise_contest"
                  ? "pairwise_loss"
                  : "weak_signal"
            : gate.promotable && !validation?.validation_target?.design_blocked ? "planned_validation_not_executed" : "graph_promotion_blocked_by_validation_quality_gate",
      });
    }
  }

  const runnerResults = normalizeRunnerValidationResults({ cwd, cycleId, hypotheses, validationPlan });
  const byId = new Map();
  for (const item of [...results, ...runnerResults]) {
    const id = String(item?.validation_id || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, item);
  }
  return {
    validation_results: Array.from(byId.values()),
  };
}

function buildClaimTraceArtifact({
  cwd = process.cwd(),
  cycleId,
  hypotheses = [],
  validationResultsArtifact = {},
  evidencePackets = {},
  validationPlan = {},
  dataGraph = {},
  graphDiff = {},
}) {
  const fs = require("fs");
  const root = runtimeRoot(cwd);
  const stateDir = path.join(root, "state");
  const statsDir = path.join(root, "artifacts", "stats", cycleId);
  const lanesDir = path.join(root, "lanes", cycleId);
  const validationByHypothesis = new Map();
  const packetByHypothesis = new Map();
  const plannedValidationByHypothesis = new Map();
  const graphUpdatesByHypothesis = new Map();

  for (const validation of asArray(validationResultsArtifact?.validation_results)) {
    for (const hypothesisId of asArray(validation?.target_hypothesis_ids)) {
      if (!validationByHypothesis.has(hypothesisId)) validationByHypothesis.set(hypothesisId, []);
      validationByHypothesis.get(hypothesisId).push(validation);
    }
  }

  for (const packet of asArray(evidencePackets?.evidence_packets)) {
    const hypothesisId = String(packet?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    if (!packetByHypothesis.has(hypothesisId)) packetByHypothesis.set(hypothesisId, []);
    packetByHypothesis.get(hypothesisId).push(packet);
  }

  for (const plannedValidation of asArray(validationPlan?.planned_validations)) {
    for (const hypothesisId of asArray(plannedValidation?.target_hypothesis_ids)) {
      if (!plannedValidationByHypothesis.has(hypothesisId)) plannedValidationByHypothesis.set(hypothesisId, []);
      plannedValidationByHypothesis.get(hypothesisId).push(plannedValidation);
    }
  }

  for (const update of asArray(graphDiff?.updates)) {
    const hypothesisId = String(update?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    if (!graphUpdatesByHypothesis.has(hypothesisId)) graphUpdatesByHypothesis.set(hypothesisId, []);
    graphUpdatesByHypothesis.get(hypothesisId).push(update);
  }

  const claimTraces = [];
  for (const item of asArray(hypotheses)) {
    const hypothesisId = String(item?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    const validations = validationByHypothesis.get(hypothesisId) || [];
    const packets = packetByHypothesis.get(hypothesisId) || [];
    const plannedValidations = plannedValidationByHypothesis.get(hypothesisId) || [];
    const graphUpdates = graphUpdatesByHypothesis.get(hypothesisId) || [];
    const hypothesisNodeId = `hypothesis:${hypothesisId}`;
    const sourceLanes = Array.from(new Set([
      ...asArray(item?.validating_lanes),
      ...asArray(item?.evidence).map((entry) => entry?.lane_id).filter(Boolean),
      ...packets.flatMap((packet) => asArray(packet?.provenance)),
    ]));
    const sourceRoles = Array.from(new Set(asArray(item?.evidence).map((entry) => entry?.lane_role).filter(Boolean)));
    const analysisTracePaths = existingPaths(
      fs,
      sourceLanes.map((laneId) => path.join(statsDir, laneId, "analysis-trace.json")),
    );
    const requiredSourceLaneArtifactCandidates = sourceLanes.flatMap((laneId) => uniquePaths([
      path.join(lanesDir, laneId, "result.json"),
      path.join(lanesDir, laneId, "artifacts.json"),
      path.join(statsDir, laneId, "summary.md"),
    ]));
    const supportingSourceLaneArtifactCandidates = sourceLanes.flatMap((laneId) => uniquePaths([
      path.join(lanesDir, laneId, "role-plan.json"),
      path.join(lanesDir, laneId, "task.md"),
      path.join(statsDir, laneId, "result.json"),
      path.join(statsDir, laneId, "papers.json"),
    ]));
    const sourceLaneArtifactPaths = uniquePaths([
      ...existingPaths(fs, requiredSourceLaneArtifactCandidates),
      ...existingPaths(fs, supportingSourceLaneArtifactCandidates),
    ]);
    const validationOutputCandidates = uniquePaths([
      path.join(stateDir, `${cycleId}-validation-results.json`),
    ]);
    const validationOutputPaths = existingPaths(fs, validationOutputCandidates);
    const dataTransformCandidates = uniquePaths([
      path.join(stateDir, `${cycleId}-validation-plan.json`),
      path.join(stateDir, `${cycleId}-evidence-packets.json`),
      path.join(stateDir, `${cycleId}-graph-update-log.json`),
      path.join(stateDir, `${cycleId}-data-graph.json`),
    ]);
    const dataTransformPaths = existingPaths(fs, dataTransformCandidates);
    const dataGraphAnchor = {
      node_ids: asArray(dataGraph?.nodes)
        .filter((node) => String(node?.id || node?.node_id || "") === hypothesisNodeId)
        .map((node) => String(node?.id || node?.node_id || "")),
      edge_ids: asArray(dataGraph?.edges)
        .filter((edge) => {
          const from = String(edge?.from || edge?.source || "");
          const to = String(edge?.to || edge?.target || "");
          const edgeHypothesisId = String(edge?.metadata?.hypothesis_id || "");
          return from === hypothesisNodeId || to === hypothesisNodeId || edgeHypothesisId === hypothesisId;
        })
        .map((edge) => String(edge?.id || "")),
    };
    const supportingPapers = Array.from(new Set([
      ...asArray(item?.paper_examples),
      ...asArray(item?.claims).flatMap((claim) => asArray(claim?.supporting_papers)),
    ].filter(Boolean))).slice(0, 8);
    const dataTransformSteps = Array.from(new Set([
      plannedValidations.length > 0 ? "normalize_validation_outcomes" : null,
      item?.validation_protocol?.dataset ? `dataset:${item.validation_protocol.dataset}` : null,
      ...plannedValidations.map((validation) =>
        validation?.validation_type ? `validation_plan:${validation.validation_type}` : null,
      ),
      ...packets.flatMap((packet) =>
        asArray(packet?.graph_updates).map((update) =>
          `graph_update:${update?.operation || "update"}:${update?.target_type || "target"}`,
        ),
      ),
      ...graphUpdates.map((update) =>
        `graph_state:${update?.operation || update?.state || "update"}:${update?.target_type || update?.target_kind || "target"}`,
      ),
    ].filter(Boolean)));
    const claims = asArray(item?.claims).length > 0
      ? asArray(item.claims)
      : [{
          claim_id: `claim:${hypothesisId}`,
          statement: item?.statement || hypothesisId,
          status: item?.latest_status || item?.state || "candidate",
        }];

    for (const claim of claims) {
      const traceGaps = [];
      if (sourceLanes.length === 0) traceGaps.push("source_lanes");
      if (sourceLaneArtifactPaths.length === 0 && analysisTracePaths.length === 0) traceGaps.push("source_lane_artifacts");
      if (plannedValidations.length === 0) traceGaps.push("validation_plan_records");
      if (validations.length === 0) traceGaps.push("validation_records");
      if (validationOutputPaths.length === 0) traceGaps.push("validation_outputs");
      if (dataTransformPaths.length === 0) traceGaps.push("data_transforms");
      if (packets.length === 0) traceGaps.push("evidence_packets");
      claimTraces.push({
        claim_id: claim?.claim_id || `claim:${hypothesisId}`,
        hypothesis_id: hypothesisId,
        statement: claim?.statement || item?.statement || hypothesisId,
        claim_status: claim?.status || item?.latest_status || item?.state || "candidate",
        supporting_hypothesis_ids: [hypothesisId],
        supporting_papers: supportingPapers,
        source_lanes: sourceLanes,
        source_roles: sourceRoles,
        source_graphs: asArray(item?.source_graphs),
        unresolved_gaps: asArray(item?.unresolved_gaps),
        validation_ids: validations.map((validation) => validation.validation_id).filter(Boolean),
        source_lane_artifact_paths: sourceLaneArtifactPaths,
        missing_source_lane_artifact_paths: missingPaths(fs, requiredSourceLaneArtifactCandidates),
        analysis_trace_paths: analysisTracePaths,
        validation_output_paths: validationOutputPaths,
        validation_plan_records: plannedValidations.map((validation) => ({
          validation_id: validation.validation_id,
          validation_type: validation.validation_type,
          target_edges: asArray(validation?.target_edges),
          target_family_ids: asArray(validation?.target_family_ids),
          purpose: validation?.purpose || null,
        })),
        validation_records: validations.map((validation) => ({
          validation_id: validation.validation_id,
          validation_type: validation.validation_type,
          execution_status: validation.execution_status,
          model_spec: validation.model_spec || null,
          sample_definition: validation.sample_definition || null,
          subgroup_definition: validation.subgroup_definition || null,
          target_edges: asArray(validation?.target_edges),
          diagnostics: validation?.diagnostics || {},
          failure_reason: validation?.failure_reason || null,
        })),
        data_transform_steps: dataTransformSteps,
        data_transform_paths: dataTransformPaths,
        evidence_packet_records: packets.map((packet) => ({
          evidence_packet_id: packet?.evidence_packet_id || null,
          validation_id: packet?.validation_id || null,
          provenance: asArray(packet?.provenance),
          summary: packet?.summary || null,
          graph_updates: asArray(packet?.graph_updates).map((update) => ({
            operation: update?.operation || null,
            target_type: update?.target_type || null,
            target_id: update?.target_id || null,
          })),
        })),
        graph_update_records: graphUpdates.map((update) => ({
          operation: update?.operation || update?.state || null,
          target_type: update?.target_type || update?.target_kind || null,
          target_id: update?.target_id || null,
          validation_id: update?.validation_id || null,
          evidence_id: update?.evidence_id || null,
        })),
        data_graph_anchor: dataGraphAnchor,
        missing_validation_output_paths: missingPaths(fs, validationOutputCandidates),
        missing_data_transform_paths: missingPaths(fs, dataTransformCandidates),
        trace_gaps: traceGaps,
        trace_complete:
          validations.length > 0 &&
          plannedValidations.length > 0 &&
          traceGaps.length === 0,
      });
    }
  }

  return {
    claim_trace_count: claimTraces.length,
    traceable_claim_count: claimTraces.filter((item) => item.trace_complete).length,
    claim_traces: claimTraces,
  };
}

// Robustness failure ratio: fraction of validations whose latest_status
// was weak or whose execution_status was non-completed. A ratio > 0.5
// indicates the current identification strategy is not meeting its own
// robustness checks, and design_shifts become required in the next plan
// (hypothesis-pipeline hardening item #5).
function computeRobustnessFailureRatio(validationResultsArtifact) {
  const results = asArray(validationResultsArtifact?.validation_results);
  if (results.length === 0) return 0;
  const failures = results.filter((r) => {
    const status = String(r?.execution_status || "").toLowerCase();
    const failureReason = String(r?.failure_reason || "").toLowerCase();
    return (
      status === "completed_with_warning" ||
      status === "completed_exploratory" ||
      Boolean(failureReason) ||
      status === "failed" ||
      status === "degraded"
    );
  }).length;
  return Number((failures / results.length).toFixed(3));
}

// Whether the cycle produced at least one promotable/robust hypothesis. A high
// robustness_failure_ratio only means "the identification strategy failed" when
// NO hypothesis reached promotion — otherwise the ratio is just the expected
// sea of weak rival families around a successful lead, and forcing a
// design_shift (strategy switch / regeneration) there is what livelocked the
// cycle: it kept regenerating rivals instead of authoring the promoted result.
function cycleHasPromotableHypothesis(familyPackageLedger) {
  return asArray(familyPackageLedger?.family_packages).some((pkg) => {
    const state = String(pkg?.package_state || pkg?.state || "").toLowerCase();
    return state === "provisionally_promoted" || state === "promoted";
  });
}

// Suggest design-level shifts when the current cycle's identification
// strategy clearly failed. This is non-prescriptive — the entries are
// hints the hypothesis generator and planner consume in the next cycle.
// Builder guarantees design_shifts is NON-EMPTY when robustness failure
// ratio > 0.5 OR tournament elimination fired (pairwise losses observed).
function suggestDesignShifts({ robustnessFailureRatio, familyPackageLedger, demotedFamilies, domain = null }) {
  const shifts = [];
  const packages = asArray(familyPackageLedger?.family_packages);
  const totalPairwiseLosses = packages.reduce(
    (sum, pkg) => sum + Number(pkg?.pairwise_loss_count || 0),
    0,
  );
  // A "switch identification strategy" shift is only warranted when the cycle
  // failed to promote ANY hypothesis. If a lead already reached promotion, the
  // high robustness_failure_ratio is just the weak-rival tail, not a failed
  // approach — forcing a strategy switch there livelocks the cycle.
  const hasPromotable = cycleHasPromotableHypothesis(familyPackageLedger);
  // Alternative strategies for the mode this cycle's instruments put it in.
  // This read a per-field table whose "generic" entry was the observational one,
  // so every field nobody had listed was handed econometrics.
  const designShift = designShiftForMode(domain);
  const strategies = designShift.strategies;
  const approachLabel = designShift.currentApproachLabel;
  const strategyProse = strategies.map((s) => s.replace(/_/g, " ")).join(", ");
  if (robustnessFailureRatio > 0.5 && !hasPromotable) {
    shifts.push({
      type: "switch_identification_strategy",
      rationale: `robustness_failure_ratio=${robustnessFailureRatio} exceeds 0.5; the current (${approachLabel}) strategy is not passing its own checks. Consider an alternative strategy: ${strategyProse}.`,
      suggested_strategies: strategies,
    });
  }
  if (totalPairwiseLosses >= 2) {
    shifts.push({
      type: "narrow_scope_or_strengthen_contrast",
      rationale: `Pairwise tournament eliminated ${totalPairwiseLosses} family comparisons; remaining ambiguity likely requires a sharper, more controlled contrast to distinguish rival mechanisms (e.g. ${strategies[0].replace(/_/g, " ")}).`,
    });
  }
  if (demotedFamilies.size >= 2 && robustnessFailureRatio > 0.3) {
    shifts.push({
      type: "switch_dataset_or_setting",
      rationale: `${demotedFamilies.size} families demoted and overall robustness failure rate (${robustnessFailureRatio}) suggests the current dataset/setting's granularity or coverage is the binding constraint. Move to a setting with stronger identifying variation (e.g. ${strategyProse}).`,
    });
  }
  return shifts;
}

function buildNextCyclePlan({
  familyPackageLedger = {},
  graphDiff = {},
  dataGraph = {},
  familyNomination = [],
  validationResultsArtifact = null,
  domain = null,
}) {
  const challengedFamilies = new Set();
  const demotedFamilies = new Set();
  const strengthenedFamilies = new Set();
  for (const update of asArray(graphDiff?.updates)) {
    if (String(update?.target_type) !== "family") continue;
    const familyId = String(update?.target_id || "").replace(/^family:/, "").trim();
    if (!familyId) continue;
    if (update.operation === "demote") demotedFamilies.add(familyId);
    else if (update.operation === "challenge") challengedFamilies.add(familyId);
    else if (update.operation === "strengthen") strengthenedFamilies.add(familyId);
  }

  const familyNodes = familyNodeMap(dataGraph);
  const strengthenedCount = strengthenedFamilies.size;
  const selectionScoreCap = strengthenedCount < 2 ? 70 : 100;
  const familyDiversity = Math.max(1, asArray(familyPackageLedger?.family_packages).length);
  const candidateFamilies = asArray(familyPackageLedger?.family_packages).map((item) => {
    const familyRoot = String(item?.family_root || "").trim();
    const nomination = asArray(familyNomination).find((entry) => entry?.family_root === familyRoot);
    const familyNode = familyNodes.get(familyRoot) || {};
    const underexplored = Number(item?.support_count || 0) < 2 || Number(item?.top_hypothesis_score || 0) < 50;
    const reviewerBurden = Number(familyNode?.score?.reviewer_burden_score || 0);
    const diversityPenalty = familyDiversity < 3 ? 15 : 0;
    const reviewerPenalty = Math.min(30, reviewerBurden * 5);
    const incumbentPenalty =
      familyRoot === familyPackageLedger?.incumbent_family && strengthenedFamilies.has(familyRoot) && Number(item?.family_score || 0) < 15
        ? 12
        : 0;
    const action =
      demotedFamilies.has(familyRoot)
        ? "retest_or_replace"
        : challengedFamilies.has(familyRoot)
          ? "targeted_revalidation"
          : underexplored
            ? "explore_rival_package"
            : strengthenedFamilies.has(familyRoot)
              ? "hold_as_incumbent_without_locking"
            : "continue_monitoring";
    const rawPriorityScore =
      (demotedFamilies.has(familyRoot) ? 100 : 0) +
      (challengedFamilies.has(familyRoot) ? 80 : 0) +
      (underexplored ? 60 : 0) +
      (strengthenedFamilies.has(familyRoot) ? 20 : 0) +
      Number(item?.family_score || 0) -
      reviewerPenalty -
      diversityPenalty -
      incumbentPenalty;
    const priorityScore = Math.max(0, Math.min(selectionScoreCap, rawPriorityScore));
    return {
      family_root: familyRoot,
      action,
      priority_score: priorityScore,
      reviewer_burden_score: reviewerBurden,
      selection_score_cap: selectionScoreCap,
      rationale: nomination?.nominated === false
        ? "Family exists in the frontier but remains underexplored and should be regenerated."
        : demotedFamilies.has(familyRoot)
          ? "Family weakened in the current graph update and should not be auto-protected."
          : challengedFamilies.has(familyRoot)
            ? "Family was challenged and needs pairwise or robustness revalidation."
            : underexplored
              ? "Family remains underexplored relative to the current frontier."
              : "Family remains active but should not be locked as the next-cycle incumbent.",
    };
  }).sort((a, b) => b.priority_score - a.priority_score || a.family_root.localeCompare(b.family_root));

  const robustnessFailureRatio = computeRobustnessFailureRatio(validationResultsArtifact);
  const designShifts = suggestDesignShifts({
    robustnessFailureRatio,
    familyPackageLedger,
    demotedFamilies,
    domain,
  });

  // Hard contract: if the prior cycle's robustness failure ratio > 0.5 AND the
  // cycle produced no promotable hypothesis, a next-cycle plan MUST carry at
  // least one design_shift. Emit the most conservative default
  // (switch_identification_strategy) when the heuristic above produced none —
  // the builder cannot return an "empty recovery" plan. The default's
  // strategies come from the ③ registry for the cycle's domain, never a
  // hardcoded epi list. When a lead already promoted, no shift is forced so the
  // cycle can converge to authoring.
  if (robustnessFailureRatio > 0.5 && designShifts.length === 0 && !cycleHasPromotableHypothesis(familyPackageLedger)) {
    const fallback = designShiftForMode(domain);
    designShifts.push({
      type: "switch_identification_strategy",
      rationale: "robustness_failure_ratio > 0.5 but no specific shift was suggested; default to switching identification strategy.",
      suggested_strategies: fallback.strategies.slice(0, 2),
    });
  }

  const carryForwardRules = [
    "Do not auto-lock the previous incumbent family.",
    "Prioritize challenged or demoted families for revalidation or replacement.",
    "Increase generation priority for underexplored rival families.",
  ];
  if (designShifts.length > 0) {
    carryForwardRules.push(
      "Apply at least one design_shift before generating the next hypothesis set — do not retry the same identification strategy on the same data.",
    );
  }

  return {
    incumbent_family: familyPackageLedger?.incumbent_family || null,
    graph_snapshot: {
      node_count: Number(asArray(dataGraph?.nodes).length),
      edge_count: Number(asArray(dataGraph?.edges).length),
      graph_update_count: Number(asArray(graphDiff?.updates).length),
      family_diversity_count: familyDiversity,
      completed_family_pairwise_tests: strengthenedCount,
      selection_score_cap: selectionScoreCap,
    },
    robustness_failure_ratio: robustnessFailureRatio,
    design_shifts: designShifts,
    prioritized_families: candidateFamilies,
    carry_forward_rules: carryForwardRules,
  };
}

function writeCycleStateArtifacts({
  cwd = process.cwd(),
  cycleId,
  familyNomination = [],
  hypotheses = [],
  validationPlan = {},
  dataGraph = {},
  graphDiff = {},
  familyPackageLedger = {},
  evidencePackets = {},
}) {
  const root = runtimeRoot(cwd);
  const stateDir = path.join(root, "state");
  ensureDir(stateDir);

  const familyNominationArtifact = enrichFamilyNomination({
    familyNomination,
    hypotheses,
    familyPackageLedger,
    dataGraph,
  });
  const hypothesesArtifact = {
    hypotheses,
  };
  const validationResultsArtifact = buildValidationResultsArtifact({ cwd, cycleId, hypotheses, validationPlan });
  const paths = {
    family_nomination: path.join(stateDir, `${cycleId}-family-nomination.json`),
    hypotheses: path.join(stateDir, `${cycleId}-hypotheses.json`),
    validation_results: path.join(stateDir, `${cycleId}-validation-results.json`),
    claim_traces: path.join(stateDir, `${cycleId}-claim-traces.json`),
    next_cycle_plan: path.join(stateDir, `${cycleId}-next-cycle-plan.json`),
  };

  // Materialize validation outputs before building claim traces so the
  // trace completeness check reflects persisted reproducibility artifacts.
  writeJson(paths.validation_results, validationResultsArtifact);

  const claimTraceArtifact = buildClaimTraceArtifact({
    cwd,
    cycleId,
    hypotheses,
    validationResultsArtifact,
    evidencePackets,
    validationPlan,
    dataGraph,
    graphDiff,
  });
  // Which design shifts to suggest depends on what this cycle can DO, which the
  // instrument probe measured. It used to depend on a field guessed from the
  // hypotheses' own words -- and the entry for a field nobody had listed was the
  // observational one, so an unlisted field was offered econometrics.
  const domain = resolveProfile({
    ...loadCycleEvidence({ root: runtimeRoot(cwd), cycleId }),
    context: cycleId,
  }).intervention_mode;

  const nextCyclePlanArtifact = buildNextCyclePlan({
    familyPackageLedger,
    graphDiff,
    dataGraph,
    familyNomination,
    validationResultsArtifact,
    domain,
  });

  writeJson(paths.family_nomination, familyNominationArtifact);
  writeJson(paths.hypotheses, hypothesesArtifact);
  writeJson(paths.claim_traces, claimTraceArtifact);
  writeJson(paths.next_cycle_plan, nextCyclePlanArtifact);

  return {
    paths,
    familyNominationArtifact,
    hypothesesArtifact,
    validationResultsArtifact,
    claimTraceArtifact,
    nextCyclePlanArtifact,
  };
}

module.exports = {
  buildClaimTraceArtifact,
  buildValidationResultsArtifact,
  buildNextCyclePlan,
  writeCycleStateArtifacts,
  __private: { hypothesisGraphPromotionGate, normalizeRunnerValidationResults },
};
