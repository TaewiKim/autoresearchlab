"use strict";

const fs = require("fs");
const path = require("path");
const { readJson } = require("../../../shared/json");
const {
  hypothesisKey,
  statusRank,
  normalizeLedgerStatus,
  mergeLedgerStatus,
  numericScore,
  asArray,
  normalizeMechanisms,
  normalizeModerators,
  normalizeConfounders,
  normalizeRivals,
  normalizeFalsificationTests,
  inferFamilyRoot,
  structuredHypothesisComponents,
  normalizeClaims,
  synthesizeAnalysisResults,
  synthesizeValidationProtocol,
  synthesizeCodebookGrounding,
  synthesizeHypothesisNode,
  synthesizeGraphSupport,
  requiredOutputComplete,
  laneRolePlan,
  resultFileMayContainHypotheses,
} = require("./normalization");
const { validationResultMatchesPlannerCandidate } = require("./evidence");
const { cycleStateReader } = require("../../shared/gated_state");

function collectLiteratureHypotheses(root, cycleId, ledger) {
  const literaturePath = path.join(root, "plans", `${cycleId}-lab-director-literature.json`);
  if (!fs.existsSync(literaturePath)) return;
  const literature = readJson(literaturePath);
  for (const lane of literature.lanes || []) {
    for (const item of lane.hypotheses || []) {
      const key = hypothesisKey(item);
      if (!ledger.has(key)) {
        const normalizedValidationProtocol = item.validation_protocol || synthesizeValidationProtocol(item);
        const normalizedStructuredComponents =
          item.structured_hypothesis_components || structuredHypothesisComponents(item);
        const normalizedGraphSupport = item.graph_support || synthesizeGraphSupport(item, "literature");
        const normalizedCodebookGrounding = item.codebook_grounding || synthesizeCodebookGrounding(item);
        const normalizedHypothesisNode = item.hypothesis_node || synthesizeHypothesisNode(item);
        ledger.set(key, {
          hypothesis_id: item.hypothesis_id || key,
          statement: item.statement,
          kind: "literature",
          family_root: inferFamilyRoot(item),
          primary_exposure: item.primary_exposure || item.x_variable || null,
          core_claim: item.core_claim || item.statement || null,
          rival_to: Array.isArray(item.rival_to) ? item.rival_to : [],
          mechanism_path: Array.isArray(item.mechanism_path) ? item.mechanism_path : normalizeMechanisms(item),
          test_plan: Array.isArray(item.test_plan) ? item.test_plan : Array.isArray(item.validation_plan) ? item.validation_plan : [],
          latest_status: "exploratory",
          support_count: 0,
          validating_lanes: [],
          evidence: [],
          source_briefs: [],
          promoted_claim_ids: [],
          claims: normalizeClaims(item),
          analysis_results: [],
          x_variable: item.x_variable || null,
          y_variable: item.y_variable || null,
          condition: item.condition || null,
          direction: item.direction || "unknown",
          mechanism: item.mechanism || null,
          mechanisms: normalizeMechanisms(item),
          moderators: normalizeModerators(item),
          confounders: normalizeConfounders(item),
          rivals: normalizeRivals(item),
          falsification_rule: item.falsification_rule || null,
          falsification_tests: normalizeFalsificationTests(item),
          validation_plan: Array.isArray(item.validation_plan) ? item.validation_plan : [],
          validation_protocol: normalizedValidationProtocol,
          support_paths: Array.isArray(item.support_paths) ? item.support_paths : [],
          graph_support: normalizedGraphSupport,
          codebook_grounding: normalizedCodebookGrounding,
          hypothesis_node: normalizedHypothesisNode,
          structured_hypothesis_components: normalizedStructuredComponents,
          schema_version: item.schema_version || "scientific-hypothesis-spec-v1",
          required_output_complete: Boolean(item.required_output_complete) || requiredOutputComplete({
            ...item,
            validation_protocol: normalizedValidationProtocol,
          }),
          source_graphs: ["literature"],
          bridge_edges: [],
          expected_impact: numericScore(item.expected_impact, 0),
          verifiability: numericScore(item.verifiability, 0),
          structural_novelty: numericScore(item.structural_novelty, 0),
          total_score: numericScore(item.total_score, 0),
          graph_update_state: null,
          graph_update_evidence_ids: [],
          graph_update_operations: [],
        });
      }
      const entry = ledger.get(key);
      entry.claims = [
        ...(entry.claims || []),
        ...normalizeClaims(item).filter(
          (claim) => !(entry.claims || []).some((existing) => existing.claim_id === claim.claim_id),
        ),
      ];
      entry.family_root = entry.family_root || inferFamilyRoot(item);
      entry.primary_exposure = entry.primary_exposure || item.primary_exposure || item.x_variable || null;
      entry.core_claim = entry.core_claim || item.core_claim || item.statement || null;
      entry.rival_to = Array.from(new Set([...(entry.rival_to || []), ...asArray(item.rival_to).map(String)]));
      entry.mechanism_path = Array.from(new Set([...(entry.mechanism_path || []), ...asArray(item.mechanism_path).map(String), ...normalizeMechanisms(item)]));
      entry.test_plan = Array.from(new Set([...(entry.test_plan || []), ...asArray(item.test_plan).map(String), ...asArray(item.validation_plan).map(String)]));
      entry.x_variable = entry.x_variable || item.x_variable || null;
      entry.y_variable = entry.y_variable || item.y_variable || null;
      entry.condition = entry.condition || item.condition || null;
      entry.direction = entry.direction === "unknown" ? item.direction || entry.direction : entry.direction;
      entry.mechanism = entry.mechanism || item.mechanism || null;
      entry.mechanisms = Array.from(new Set([...(entry.mechanisms || []), ...normalizeMechanisms(item)]));
      entry.moderators = Array.from(new Set([...(entry.moderators || []), ...normalizeModerators(item)]));
      entry.confounders = Array.from(new Set([...(entry.confounders || []), ...normalizeConfounders(item)]));
      entry.rivals = Array.from(new Set([...(entry.rivals || []), ...normalizeRivals(item)]));
      entry.falsification_rule = entry.falsification_rule || item.falsification_rule || null;
      entry.falsification_tests = [
        ...(entry.falsification_tests || []),
        ...normalizeFalsificationTests(item).filter(
          (test) => !(entry.falsification_tests || []).some((existing) => existing.test_id === test.test_id),
        ),
      ];
      entry.validation_protocol = entry.validation_protocol || item.validation_protocol || synthesizeValidationProtocol(item);
      if ((!entry.validation_plan || entry.validation_plan.length === 0) && Array.isArray(item.validation_plan)) {
        entry.validation_plan = item.validation_plan;
      }
      if ((!entry.support_paths || entry.support_paths.length === 0) && Array.isArray(item.support_paths)) {
        entry.support_paths = item.support_paths;
      }
      entry.graph_support = entry.graph_support || item.graph_support || synthesizeGraphSupport(item, "literature");
      entry.codebook_grounding = entry.codebook_grounding || item.codebook_grounding || synthesizeCodebookGrounding(item);
      entry.hypothesis_node = entry.hypothesis_node || item.hypothesis_node || synthesizeHypothesisNode(item);
      entry.structured_hypothesis_components = entry.structured_hypothesis_components || item.structured_hypothesis_components || structuredHypothesisComponents(item);
      entry.schema_version = entry.schema_version || item.schema_version || "scientific-hypothesis-spec-v1";
      entry.required_output_complete = entry.required_output_complete || Boolean(item.required_output_complete) || requiredOutputComplete({
        ...item,
        validation_protocol: entry.validation_protocol || item.validation_protocol || synthesizeValidationProtocol(item),
      });
      if (!entry.source_graphs.includes("literature")) entry.source_graphs.push("literature");
      entry.expected_impact = Math.max(entry.expected_impact || 0, numericScore(item.expected_impact, 0));
      entry.verifiability = Math.max(entry.verifiability || 0, numericScore(item.verifiability, 0));
      entry.structural_novelty = Math.max(entry.structural_novelty || 0, numericScore(item.structural_novelty, 0));
      entry.total_score = Math.max(entry.total_score || 0, numericScore(item.total_score, 0));
      entry.support_count += 1;
      if (!entry.validating_lanes.includes(lane.lane_id)) {
        entry.validating_lanes.push(lane.lane_id);
      }
      entry.evidence.push({
        source: "literature",
        lane_id: lane.lane_id,
        lane_role: lane.role || "analyst",
        paper_support: item.paper_support || [],
        rationale: item.rationale || null,
        graph_support: item.graph_support || null,
        source_graph: item.source_graph || "literature",
      });
      entry.latest_status = statusRank(entry.latest_status) >= statusRank("exploratory")
        ? entry.latest_status
        : "exploratory";
    }
  }
}

// Data hypotheses are validated from lab-director-assigned statement strings, so
// they arrive at the ledger with no structured x_variable/y_variable/direction —
// which silently blocks promotion (the gate's structuralPrereqsMet needs all three).
// Recover them from genuine, already-present sources rather than leaving them null
// or fabricating placeholders: the exposure family the hypothesis was actually built
// around, the cycle's own discovered data-graph outcome node that the hypothesis
// text matches, and the directional sense the claim itself expresses (the same
// categorical scheme the structured-hypothesis builders emit). Only populate when a
// genuine match/term exists; otherwise leave it null so unfounded hypotheses stay
// unpromotable.
function deriveDataHypothesisVariables(item, dataGraph) {
  const xVariable =
    item.x_variable || item.primary_exposure || item.family_root || inferFamilyRoot(item) || null;
  const text = `${item.statement || ""} ${item.core_claim || ""} ${item.hypothesis || ""}`.toLowerCase();
  let yVariable = item.y_variable || null;
  if (!yVariable && dataGraph && Array.isArray(dataGraph.nodes) && text.trim()) {
    let best = null;
    let bestScore = 0;
    for (const node of dataGraph.nodes) {
      if (String(node.type || node.node_type || "") !== "outcome") continue;
      const label = String(node.label || node.name || "").toLowerCase();
      const tokens = label.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
      const score = tokens.filter((token) => text.includes(token)).length;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    if (best && bestScore >= 1) {
      yVariable = String(best.id || best.label || "").replace(/^out:/, "") || null;
    }
  }
  if (!yVariable && text.trim()) {
    // Fallback when the data graph carries no matching outcome node (e.g. a
    // chronicle re-bootstrap reset it to an empty {nodes,edges} shell): structure
    // the outcome the hypothesis itself explicitly names. Anchor on domain-neutral
    // outcome-type terms so we only capture a genuinely-stated scientific outcome,
    // never invent one — a hypothesis with no stated outcome stays null/unpromotable.
    const OUTCOME_ANCHORS = [
      "reclassification", "progression", "conversion", "stratification",
      "classification", "prediction", "response", "survival", "mortality",
      "recurrence", "diagnosis", "subtype", "severity", "prognosis", "setpoint",
      "heterogeneity", "discrimination", "remission", "relapse",
    ];
    const hit = OUTCOME_ANCHORS.find((term) => text.includes(term));
    if (hit) yVariable = hit;
  }
  let direction = item.direction && item.direction !== "unknown" ? item.direction : null;
  if (!direction && text.trim()) {
    if (/\b(improv|outperform|better|exceed|higher|increas|superior|stronger|elevat)\w*/.test(text)) {
      direction = "comparative";
    } else if (/\b(reduc|lower|decreas|worse|attenuat|suppress)\w*/.test(text)) {
      direction = "negative";
    } else if (/\b(differ|vary|varies|moderat|interact|depend|conditional|stratif|subgroup|context)\w*/.test(text)) {
      direction = "conditional";
    }
  }
  return { x_variable: xVariable, y_variable: yVariable, direction };
}

function collectDataHypotheses(root, cycleId, ledger) {
  const artifactsRoot = path.join(root, "artifacts", "stats", cycleId);
  if (!fs.existsSync(artifactsRoot)) return;
  // The data graph is what the ledger reasons over; admit it for THIS cycle.
  const dataGraph = cycleStateReader({ root, cycleId, task: "hypothesis_ledger" })("data-graph.json") || null;
  const laneIds = fs.readdirSync(artifactsRoot).sort((a, b) => {
    const aPath = path.join(artifactsRoot, a, "result.json");
    const bPath = path.join(artifactsRoot, b, "result.json");
    const aTime = fs.existsSync(aPath) ? fs.statSync(aPath).mtimeMs : 0;
    const bTime = fs.existsSync(bPath) ? fs.statSync(bPath).mtimeMs : 0;
    return aTime - bTime || a.localeCompare(b);
  });
  for (const laneId of laneIds) {
    const resultPath = path.join(artifactsRoot, laneId, "result.json");
    if (!fs.existsSync(resultPath)) continue;
    if (!resultFileMayContainHypotheses(resultPath)) continue;
    const result = readJson(resultPath);
    const rolePlan = result?.role_plan || laneRolePlan(root, cycleId, laneId) || {};
    const plannerMatch = validationResultMatchesPlannerCandidate(result, rolePlan);
    if (!plannerMatch.matches) {
      continue;
    }
    const validationSummary = result.validation_summary || {};
    const validationChecks =
      validationSummary && typeof validationSummary.checks === "object" && validationSummary.checks
        ? validationSummary.checks
        : {};
    const passedValidationCheckCount = Object.values(validationChecks).filter((value) => value === true).length;
    const failedValidationCheckCount = Object.values(validationChecks).filter((value) => value === false).length;
    const summaryPassed =
      validationSummary.overall_status === "passed" &&
      failedValidationCheckCount === 0 &&
      Number(validationSummary.checks_failed || 0) === 0;
    const validationSupportIncrement =
      summaryPassed
        ? Math.max(1, Math.min(3, passedValidationCheckCount || Number(validationSummary.blueprints_passed || 0) || 1))
        : 0;
    // Domain-GENERAL strong-evidence contract: a passing validation that both
    // reports its hypothesis SUPPORTED and reports a FALSIFICATION boundary
    // that HELD is robust data evidence, regardless of field. Any blueprint
    // (render, omics, econ, ...) signals this by emitting the two neutral
    // contract flags below; there is no per-domain check-name branch here.
    // Blueprints that don't emit them fall through to the normal path
    // (status left to the item), so nothing else changes.
    const strongFalsifiedValidation =
      summaryPassed &&
      validationChecks.hypothesis_supported === true &&
      validationChecks.falsification_boundary_held === true;
    const normalizedValidationStatus =
      summaryPassed
        ? (strongFalsifiedValidation ? "robust" : null)
        : validationSummary.overall_status === "inconclusive" || failedValidationCheckCount > 0
          ? "exploratory"
          : "weak";
    const analystHandoffPresent = Boolean(
      rolePlan?.planner_metadata?.analyst_handoff ||
      rolePlan?.planner_metadata?.cycle_analyst_handoff ||
      rolePlan?.planner_metadata?.handoff_validation_plan,
    );
    for (const item of result.selected_hypotheses || result.hypothesis_results || []) {
      const key = hypothesisKey(item);
      const derived = deriveDataHypothesisVariables(item, dataGraph);
      const itemStatus = normalizeLedgerStatus(item.status);
      const initialValidationStatus = itemStatus || normalizedValidationStatus || "weak";
      if (!ledger.has(key)) {
        const normalizedValidationProtocol = item.validation_protocol || synthesizeValidationProtocol(item);
        const normalizedStructuredComponents =
          item.structured_hypothesis_components || structuredHypothesisComponents(item);
        const normalizedGraphSupport = item.graph_support || synthesizeGraphSupport(item, "data");
        const normalizedCodebookGrounding = item.codebook_grounding || synthesizeCodebookGrounding(item);
        const normalizedHypothesisNode = item.hypothesis_node || synthesizeHypothesisNode(item);
        ledger.set(key, {
          hypothesis_id: item.hypothesis_id || key,
          statement: item.statement,
          kind: "data",
          family_root: inferFamilyRoot(item),
          primary_exposure: item.primary_exposure || item.x_variable || null,
          core_claim: item.core_claim || item.statement || null,
          rival_to: Array.isArray(item.rival_to) ? item.rival_to : [],
          mechanism_path: Array.isArray(item.mechanism_path) ? item.mechanism_path : normalizeMechanisms(item),
          test_plan: Array.isArray(item.test_plan) ? item.test_plan : Array.isArray(item.validation_plan) ? item.validation_plan : [],
          latest_status: initialValidationStatus,
          support_count: 0,
          validating_lanes: [],
          evidence: [],
          source_briefs: [],
          promoted_claim_ids: [],
          claims: normalizeClaims(item),
          analysis_results: synthesizeAnalysisResults(item, laneId, rolePlan),
          x_variable: item.x_variable || derived.x_variable || null,
          y_variable: item.y_variable || derived.y_variable || null,
          condition: item.condition || null,
          direction: item.direction || derived.direction || "unknown",
          mechanism: item.mechanism || null,
          mechanisms: normalizeMechanisms(item),
          moderators: normalizeModerators(item),
          confounders: normalizeConfounders(item),
          rivals: normalizeRivals(item),
          falsification_rule: item.falsification_rule || null,
          falsification_tests: normalizeFalsificationTests(item),
          validation_plan: Array.isArray(item.validation_plan) ? item.validation_plan : [],
          validation_protocol: normalizedValidationProtocol,
          support_paths: Array.isArray(item.support_paths) ? item.support_paths : [],
          graph_support: normalizedGraphSupport,
          codebook_grounding: normalizedCodebookGrounding,
          hypothesis_node: normalizedHypothesisNode,
          structured_hypothesis_components: normalizedStructuredComponents,
          schema_version: item.schema_version || "scientific-hypothesis-spec-v1",
          required_output_complete: Boolean(item.required_output_complete) || requiredOutputComplete({
            ...item,
            validation_protocol: normalizedValidationProtocol,
          }),
          source_graphs: ["data"],
          bridge_edges: [],
          expected_impact: numericScore(item.expected_impact, 0),
          verifiability: numericScore(item.verifiability, 0),
          structural_novelty: numericScore(item.structural_novelty, 0),
          total_score: numericScore(item.total_score, 0),
          graph_update_state: null,
          graph_update_evidence_ids: [],
          graph_update_operations: [],
        });
      }
      const entry = ledger.get(key);
      entry.kind = entry.kind === "literature" ? "mixed" : "data";
      entry.claims = [
        ...(entry.claims || []),
        ...normalizeClaims(item).filter(
          (claim) => !(entry.claims || []).some((existing) => existing.claim_id === claim.claim_id),
        ),
      ];
      entry.analysis_results = [
        ...(entry.analysis_results || []),
        ...synthesizeAnalysisResults(item, laneId, rolePlan).filter(
          (result) =>
            !(entry.analysis_results || []).some(
              (existing) => existing.analysis_result_id === result.analysis_result_id,
            ),
        ),
      ];
      entry.family_root = entry.family_root || inferFamilyRoot(item);
      entry.primary_exposure = entry.primary_exposure || item.primary_exposure || item.x_variable || null;
      entry.core_claim = entry.core_claim || item.core_claim || item.statement || null;
      entry.rival_to = Array.from(new Set([...(entry.rival_to || []), ...asArray(item.rival_to).map(String)]));
      entry.mechanism_path = Array.from(new Set([...(entry.mechanism_path || []), ...asArray(item.mechanism_path).map(String), ...normalizeMechanisms(item)]));
      entry.test_plan = Array.from(new Set([...(entry.test_plan || []), ...asArray(item.test_plan).map(String), ...asArray(item.validation_plan).map(String)]));
      entry.x_variable = entry.x_variable || item.x_variable || derived.x_variable || null;
      entry.y_variable = entry.y_variable || item.y_variable || derived.y_variable || null;
      entry.condition = entry.condition || item.condition || null;
      entry.direction =
        entry.direction && entry.direction !== "unknown"
          ? entry.direction
          : item.direction && item.direction !== "unknown"
            ? item.direction
            : derived.direction || entry.direction;
      entry.mechanism = entry.mechanism || item.mechanism || null;
      entry.mechanisms = Array.from(new Set([...(entry.mechanisms || []), ...normalizeMechanisms(item)]));
      entry.moderators = Array.from(new Set([...(entry.moderators || []), ...normalizeModerators(item)]));
      entry.confounders = Array.from(new Set([...(entry.confounders || []), ...normalizeConfounders(item)]));
      entry.rivals = Array.from(new Set([...(entry.rivals || []), ...normalizeRivals(item)]));
      entry.falsification_rule = entry.falsification_rule || item.falsification_rule || null;
      entry.falsification_tests = [
        ...(entry.falsification_tests || []),
        ...normalizeFalsificationTests(item).filter(
          (test) => !(entry.falsification_tests || []).some((existing) => existing.test_id === test.test_id),
        ),
      ];
      entry.validation_protocol = entry.validation_protocol || item.validation_protocol || synthesizeValidationProtocol(item);
      if ((!entry.validation_plan || entry.validation_plan.length === 0) && Array.isArray(item.validation_plan)) {
        entry.validation_plan = item.validation_plan;
      }
      if ((!entry.support_paths || entry.support_paths.length === 0) && Array.isArray(item.support_paths)) {
        entry.support_paths = item.support_paths;
      }
      entry.graph_support = entry.graph_support || item.graph_support || synthesizeGraphSupport(item, "data");
      entry.codebook_grounding = entry.codebook_grounding || item.codebook_grounding || synthesizeCodebookGrounding(item);
      entry.hypothesis_node = entry.hypothesis_node || item.hypothesis_node || synthesizeHypothesisNode(item);
      entry.structured_hypothesis_components = entry.structured_hypothesis_components || item.structured_hypothesis_components || structuredHypothesisComponents(item);
      entry.schema_version = entry.schema_version || item.schema_version || "scientific-hypothesis-spec-v1";
      entry.required_output_complete = entry.required_output_complete || Boolean(item.required_output_complete) || requiredOutputComplete({
        ...item,
        validation_protocol: entry.validation_protocol || item.validation_protocol || synthesizeValidationProtocol(item),
      });
      if (!entry.source_graphs.includes("data")) entry.source_graphs.push("data");
      entry.expected_impact = Math.max(entry.expected_impact || 0, numericScore(item.expected_impact, 0));
      entry.verifiability = Math.max(entry.verifiability || 0, numericScore(item.verifiability, 0));
      entry.structural_novelty = Math.max(entry.structural_novelty || 0, numericScore(item.structural_novelty, 0));
      entry.total_score = Math.max(entry.total_score || 0, numericScore(item.total_score, 0));
      entry.support_count += validationSupportIncrement;
      if (!entry.validating_lanes.includes(laneId)) {
        entry.validating_lanes.push(laneId);
      }
      entry.latest_status = mergeLedgerStatus(
        entry.latest_status,
        itemStatus || normalizedValidationStatus,
        {
          allowDowngrade:
            itemStatus === "weak" ||
            validationSummary.overall_status === "failed" ||
            validationSummary.overall_status === "error",
        },
      );
      const itemEvidence =
        item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence)
          ? item.evidence
          : {};
      const validationEvidence = {
        ...itemEvidence,
        blueprints_passed: Number(validationSummary.blueprints_passed || itemEvidence.blueprints_passed || 0),
        checks_passed_count: passedValidationCheckCount,
        checks_failed_count: failedValidationCheckCount,
        overall_status: validationSummary.overall_status || null,
        method_appropriateness_score: Number(validationSummary.method_appropriateness_score || itemEvidence.method_appropriateness_score || 0),
        analysis_accuracy_score: Number(validationSummary.analysis_accuracy_score || itemEvidence.analysis_accuracy_score || 0),
      };
      entry.evidence.push({
        source: "data",
        lane_id: laneId,
        lane_role: rolePlan.role || "lab-runner",
        family: item.family || null,
        outcome: item.outcome || null,
        role_plan_profile: rolePlan.analysis_profile || null,
        evidence: validationEvidence,
        graph_support: item.graph_support || null,
        source_graph: item.source_graph || "data",
      });
      if (analystHandoffPresent) {
        entry.evidence.push({
          source: "data",
          lane_id: laneId,
          lane_role: "analyst",
          family: item.family || null,
          outcome: item.outcome || null,
          role_plan_profile: "analyst-handoff",
          evidence: {
            handoff_present: true,
            checks_specified_count: Array.isArray(rolePlan?.planner_metadata?.analyst_handoff?.handoff_checks)
              ? rolePlan.planner_metadata.analyst_handoff.handoff_checks.length
              : 0,
          },
          graph_support: item.graph_support || null,
          source_graph: "data",
        });
      }
    }
  }
}

function collectPromotions(root, cycleId, ledger) {
  const reportsDir = path.join(root, "reports");
  if (!fs.existsSync(reportsDir)) return;
  const prefix = `${cycleId}-research-report-`;
  const reportFiles = fs.readdirSync(reportsDir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  if (!reportFiles.length) return;
  const report = readJson(path.join(reportsDir, reportFiles[reportFiles.length - 1]));
  for (const claim of report.claims || []) {
    const claimId = claim.claim_id || "";
    const reason = String(claim.reason || "");
    for (const entry of ledger.values()) {
      if (
        reason.toLowerCase().includes(String(entry.statement || "").toLowerCase()) ||
        claimId.includes(entry.hypothesis_id || "")
      ) {
        if (!entry.promoted_claim_ids.includes(claimId)) {
          entry.promoted_claim_ids.push(claimId);
        }
      }
    }
  }
}

module.exports = {
  collectLiteratureHypotheses,
  collectDataHypotheses,
  collectPromotions,
};
