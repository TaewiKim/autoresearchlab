"use strict";

const path = require("path");
const { RELATIONS } = require("../graph_schema");
const {
  asArray,
  numericScore,
  inferFamilyRoot,
} = require("./normalization");

function entryTags(entry) {
  const text = `${entry.hypothesis_id || ""} ${entry.statement || ""}`.toLowerCase();
  const tags = new Set();
  if (text.includes("alternative") || text.includes("mediated") || text.includes("direct pathway")) {
    tags.add("alternative");
  }
  if (text.includes("region") || text.includes("moderation") || text.includes("heterogeneity")) {
    tags.add("region");
  }
  if (
    text.includes("threshold") ||
    text.includes("partition") ||
    text.includes("low-coverage") ||
    text.includes("lower-coverage")
  ) {
    tags.add("threshold");
  }
  if (
    text.includes("high-upside") ||
    text.includes("lower baseline") ||
    text.includes("low baseline") ||
    text.includes("especially impactful")
  ) {
    tags.add("high-upside");
  }
  if (text.includes("rival explanation") || text.includes("counterfactual")) {
    tags.add("rival");
  }
  if (
    text.includes("method") ||
    text.includes("quality") ||
    text.includes("confound") ||
    text.includes("adjust") ||
    text.includes("robust")
  ) {
    tags.add("methods");
  }
  if (text.includes("change") || text.includes("delta")) {
    tags.add("change");
  }
  if (text.includes("stronger")) {
    tags.add("comparative-strength");
  }
  return tags;
}

function normalizeEvidenceRole(role) {
  if (!role) return null;
  if (role === "followup-analyst") return "analyst";
  if (role === "followup-scout") return "scout";
  if (role === "followup-runner") return "lab-runner";
  return role;
}

function canonicalClusterKey(entry) {
  const tags = entryTags(entry);
  const text = `${entry.hypothesis_id || ""} ${entry.statement || ""}`.toLowerCase();

  // Cluster keys are derived from generic structural tags only —
  // never from domain-specific outcome words (neonatal / life /
  // maternal / coverage / vaccination). Those used to route any cycle
  // into a fixed health-domain cluster taxonomy regardless of the
  // actual research topic.
  if (tags.has("high-upside")) return "cluster-high-upside-general";
  if (tags.has("threshold")) return "cluster-threshold-general";
  if (tags.has("alternative")) return "cluster-alternative-mechanism";
  if (tags.has("rival")) return "cluster-rival-explanation";
  if (tags.has("region")) return "cluster-region-moderation";
  if (tags.has("methods")) return "cluster-methods-quality";
  if (tags.has("change")) return "cluster-change-general";
  if (tags.has("comparative-strength")) return "cluster-comparative-strength";
  return null;
}

function normalizedText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").trim();
}

function textTokenSet(value) {
  return new Set(
    normalizedText(value)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4),
  );
}

function candidateHypothesisText(rolePlan = {}) {
  const candidates = asArray(rolePlan?.planner_metadata?.candidate_hypotheses)
    .map((item) => String(item?.statement || item?.claim || item || ""))
    .filter((item) => item.trim());
  if (candidates.length) return candidates.join(" ");
  return "";
}

function resultHypothesisText(result = {}) {
  const selected = asArray(result.selected_hypotheses)
    .concat(asArray(result.hypothesis_results))
    .map((item) => String(item?.statement || item?.claim || item?.hypothesis || item || ""))
    .filter((item) => item.trim());
  const handoffText = [
    result?.validation_summary?.primary_hypothesis_id,
    result?.primary_hypothesis_id,
    result?.summary,
    result?.role_plan?.planner_metadata?.cycle_analyst_handoff?.summary,
    result?.role_plan?.planner_metadata?.analyst_handoff?.summary,
  ].filter(Boolean);
  return selected.concat(handoffText).join(" ");
}

function expectedDatasetRootFromRolePlan(rolePlan = {}) {
  return (
    rolePlan?.planner_metadata?.handoff_validation_plan?.dataset_root ||
    rolePlan?.planner_metadata?.analyst_handoff?.dataset_root ||
    rolePlan?.planner_metadata?.cycle_analyst_handoff?.dataset_root ||
    rolePlan?.planner_metadata?.cycle_analyst_handoff?.payload?.dataset_root ||
    rolePlan?.handoff_validation_plan?.dataset_root ||
    rolePlan?.analyst_handoff?.dataset_root ||
    null
  );
}

function pathContainsOrEquals(parent, child) {
  if (!parent || !child) return false;
  const parentPath = path.resolve(String(parent));
  const childPath = path.resolve(String(child));
  if (parentPath === childPath) return true;
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validationDatasetMatchesHandoff(result = {}, rolePlan = {}) {
  const expected = expectedDatasetRootFromRolePlan(rolePlan);
  if (!expected) return { matches: true, reason: "no_handoff_dataset_root_declared" };
  const actual = result?.dataset_root || result?.role_plan?.dataset_root || null;
  const matches = pathContainsOrEquals(expected, actual);
  return {
    matches,
    reason: matches ? "handoff_dataset_root_match" : "handoff_dataset_root_mismatch",
    expected_dataset_root: expected,
    actual_dataset_root: actual,
  };
}

function validationResultMatchesPlannerCandidate(result = {}, rolePlan = {}) {
  if (rolePlan?.planner_metadata?.runner_handoff_required === true) {
    return { matches: false, reason: "runner_handoff_required_without_analyst_lane" };
  }
  const datasetMatch = validationDatasetMatchesHandoff(result, rolePlan);
  if (!datasetMatch.matches) return datasetMatch;
  const candidateText = candidateHypothesisText(rolePlan);
  if (!candidateText) {
    return { matches: true, reason: "no_candidate_hypotheses_declared" };
  }
  const candidateTokens = textTokenSet(candidateText);
  if (candidateTokens.size < 4) {
    return { matches: true, reason: "candidate_text_too_short_for_overlap_filter" };
  }
  const resultTokens = textTokenSet(resultHypothesisText(result));
  const overlap = overlapCount(candidateTokens, resultTokens);
  const requiredOverlap = Math.min(4, Math.max(2, Math.ceil(candidateTokens.size * 0.08)));
  return {
    matches: overlap >= requiredOverlap,
    reason: overlap >= requiredOverlap ? "candidate_overlap_ok" : "candidate_overlap_below_threshold",
    overlap,
    required_overlap: requiredOverlap,
  };
}

function overlapCount(left, right) {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function protocolAlignment(left, right) {
  const leftProtocol = left.validation_protocol || {};
  const rightProtocol = right.validation_protocol || {};
  let score = 0;
  const reasons = [];

  if (
    leftProtocol.dataset &&
    rightProtocol.dataset &&
    String(leftProtocol.dataset) === String(rightProtocol.dataset)
  ) {
    score += 3;
    reasons.push("shared_dataset");
  }

  const modelOverlap = overlapCount(
    textTokenSet(leftProtocol.model),
    textTokenSet(rightProtocol.model),
  );
  if (modelOverlap > 0) {
    score += Math.min(2, modelOverlap);
    reasons.push("model_alignment");
  }

  const comparisonOverlap = overlapCount(
    textTokenSet(leftProtocol.comparison),
    textTokenSet(rightProtocol.comparison),
  );
  if (comparisonOverlap > 0) {
    score += Math.min(2, comparisonOverlap);
    reasons.push("comparison_alignment");
  }

  return { score, reasons };
}

function bridgeAlignment(literatureEntry, dataEntry) {
  let score = 0;
  const reasons = [];

  if (
    literatureEntry.x_variable &&
    dataEntry.x_variable &&
    literatureEntry.x_variable === dataEntry.x_variable
  ) {
    score += 4;
    reasons.push("shared_x_variable");
  }
  if (
    literatureEntry.y_variable &&
    dataEntry.y_variable &&
    literatureEntry.y_variable === dataEntry.y_variable
  ) {
    score += 5;
    reasons.push("shared_y_variable");
  }
  if (
    literatureEntry.condition &&
    dataEntry.condition &&
    String(literatureEntry.condition) === String(dataEntry.condition)
  ) {
    score += 3;
    reasons.push("shared_condition");
  }

  const mechanismOverlap = overlapCount(
    textTokenSet(literatureEntry.mechanism),
    textTokenSet(dataEntry.mechanism),
  );
  if (mechanismOverlap > 0) {
    score += Math.min(3, mechanismOverlap);
    reasons.push("mechanism_alignment");
  }

  const confounderOverlap = overlapCount(
    textTokenSet(JSON.stringify(literatureEntry.confounders || [])),
    textTokenSet(JSON.stringify(dataEntry.confounders || [])),
  );
  if (confounderOverlap > 0) {
    score += Math.min(2, confounderOverlap);
    reasons.push("confounder_alignment");
  }

  const protocol = protocolAlignment(literatureEntry, dataEntry);
  score += protocol.score;
  reasons.push(...protocol.reasons);

  const validationPlanOverlap = overlapCount(
    textTokenSet(JSON.stringify(literatureEntry.validation_plan || [])),
    textTokenSet(JSON.stringify(dataEntry.validation_plan || [])),
  );
  if (validationPlanOverlap > 0) {
    score += Math.min(2, validationPlanOverlap);
    reasons.push("validation_plan_alignment");
  }

  const supportPathOverlap = overlapCount(
    textTokenSet(JSON.stringify(literatureEntry.support_paths || [])),
    textTokenSet(JSON.stringify(dataEntry.support_paths || [])),
  );
  if (supportPathOverlap > 0) {
    score += Math.min(2, supportPathOverlap);
    reasons.push("support_path_alignment");
  }

  return { score, reasons: Array.from(new Set(reasons)) };
}

function bridgeLiteratureAndDataEvidence(ledger) {
  const entries = Array.from(ledger.values());
  const literatureEntries = entries.filter((item) => item.kind === "literature" || item.kind === "mixed");
  const dataEntries = entries.filter((item) => item.kind === "data" || item.kind === "mixed");

  for (const dataEntry of dataEntries) {
    for (const literatureEntry of literatureEntries) {
      if (dataEntry.hypothesis_id === literatureEntry.hypothesis_id) continue;
      const alignment = bridgeAlignment(literatureEntry, dataEntry);
      if (alignment.score < 6) continue;

      const alreadyLinked = (dataEntry.evidence || []).some(
        (item) =>
          item.source === "literature-bridge" &&
          item.supporting_hypothesis_id === literatureEntry.hypothesis_id,
      );
      if (alreadyLinked) continue;

      if (!Array.isArray(dataEntry.bridge_edges)) dataEntry.bridge_edges = [];
      dataEntry.bridge_edges.push({
        source: `hypothesis:${literatureEntry.hypothesis_id}`,
        target: `hypothesis:${dataEntry.hypothesis_id}`,
        relation: RELATIONS.ALIGNED_WITH,
        bridge_alignment_score: alignment.score,
        bridge_alignment_reasons: alignment.reasons,
        shared_x_variable: literatureEntry.x_variable === dataEntry.x_variable,
        shared_y_variable: literatureEntry.y_variable === dataEntry.y_variable,
        shared_condition: literatureEntry.condition === dataEntry.condition,
      });
      dataEntry.evidence.push({
        source: "literature-bridge",
        lane_role: "analyst",
        supporting_hypothesis_id: literatureEntry.hypothesis_id,
        supporting_statement: literatureEntry.statement,
        bridge_alignment_score: alignment.score,
        bridge_alignment_reasons: alignment.reasons,
        supporting_papers: (literatureEntry.evidence || [])
          .flatMap((item) => item.paper_support || [])
          .slice(0, 5),
      });
    }
  }
}

function summarizeEvidence(entry) {
  const evidence = entry.evidence || [];
  const evidenceCounts = { literature: 0, data: 0, bridge: 0 };
  const roles = new Set();
  const papers = new Set();
  const outcomes = new Set();
  const families = new Set();

  for (const item of evidence) {
    const normalizedRole = normalizeEvidenceRole(item.lane_role);
    if (normalizedRole) roles.add(normalizedRole);

    if (item.source === "data") evidenceCounts.data += 1;
    else if (item.source === "literature") evidenceCounts.literature += 1;
    else if (item.source === "literature-bridge") evidenceCounts.bridge += 1;

    for (const paper of item.paper_support || item.supporting_papers || []) {
      if (paper) papers.add(paper);
    }
    if (item.outcome) outcomes.add(item.outcome);
    if (item.family) families.add(item.family);
  }

  const supportBasis = [];
  if (evidenceCounts.data > 0) supportBasis.push("data");
  if (evidenceCounts.literature > 0 || evidenceCounts.bridge > 0) supportBasis.push("literature");

  return {
    support_basis: supportBasis,
    evidence_counts: evidenceCounts,
    evidence_roles: Array.from(roles),
    paper_examples: Array.from(papers).slice(0, 5),
    outcomes: Array.from(outcomes),
    families: Array.from(families),
    cluster_key: canonicalClusterKey(entry),
  };
}

function summarizeKnowledgeGraphs(entry) {
  const graphs = (entry.evidence || [])
    .map((item) => item.graph_support)
    .filter((item) => item && typeof item === "object");
  const layers = new Set();
  let nodeCount = 0;
  let edgeCount = 0;

  for (const graph of graphs) {
    if (graph.layer) layers.add(String(graph.layer));
    nodeCount += Number(graph.node_count || 0);
    edgeCount += Number(graph.edge_count || 0);
  }

  return {
    source_graphs: Array.isArray(entry.source_graphs) ? entry.source_graphs : [],
    graph_layers: Array.from(layers),
    graph_node_count: nodeCount,
    graph_edge_count: edgeCount,
    graph_density_hint: nodeCount > 0 ? Number((edgeCount / nodeCount).toFixed(2)) : 0,
    bridge_edge_count: Array.isArray(entry.bridge_edges) ? entry.bridge_edges.length : 0,
  };
}

function aggregateKnowledgeGraphSummary(hypotheses, sourceGraph) {
  const relevant = hypotheses.filter((item) => (item.source_graphs || []).includes(sourceGraph));
  const nodeIds = new Set();
  const edgeIds = new Set();

  for (const item of relevant) {
    const graph = item.graph_support;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) continue;
    for (const node of graph.nodes) {
      if (node?.node_id) nodeIds.add(String(node.node_id));
    }
    for (const edge of graph.edges) {
      if (!edge?.source || !edge?.target) continue;
      edgeIds.add(`${edge.source}|${edge.relation || "related"}|${edge.target}`);
    }
  }

  return {
    hypothesis_count: relevant.length,
    node_count: nodeIds.size,
    edge_count: edgeIds.size,
  };
}

function aggregateBridgeGraphSummary(hypotheses) {
  const edgeIds = new Set();
  const hypothesisIds = new Set();
  for (const item of hypotheses) {
    for (const edge of item.bridge_edges || []) {
      if (!edge?.source || !edge?.target) continue;
      edgeIds.add(`${edge.source}|${edge.relation || RELATIONS.ALIGNED_WITH}|${edge.target}`);
      hypothesisIds.add(edge.source);
      hypothesisIds.add(edge.target);
    }
  }
  return {
    bridge_edge_count: edgeIds.size,
    aligned_hypothesis_count: hypothesisIds.size,
  };
}

function summarizeSchemaQuality(hypotheses) {
  let mechanismNodeCount = 0;
  let moderatorNodeCount = 0;
  let confounderNodeCount = 0;
  let rivalNodeCount = 0;
  let falsificationTestCount = 0;
  let claimCount = 0;
  let analysisResultCount = 0;

  for (const item of hypotheses) {
    mechanismNodeCount += (item.mechanisms || []).length;
    moderatorNodeCount += (item.moderators || []).length;
    confounderNodeCount += (item.confounders || []).length;
    rivalNodeCount += (item.rivals || []).length;
    falsificationTestCount += (item.falsification_tests || []).length;
    claimCount += (item.claims || []).length;
    analysisResultCount += (item.analysis_results || []).length;
  }

  return {
    mechanism_node_count: mechanismNodeCount,
    moderator_node_count: moderatorNodeCount,
    confounder_node_count: confounderNodeCount,
    rival_node_count: rivalNodeCount,
    falsification_test_count: falsificationTestCount,
    claim_count: claimCount,
    analysis_result_count: analysisResultCount,
  };
}

function aggregateReasoningSpineSummary(hypotheses) {
  const claimIds = new Set();
  const analysisIds = new Set();
  const testIds = new Set();
  let unresolvedGapCount = 0;

  for (const item of hypotheses) {
    for (const claim of item.claims || []) {
      if (claim?.claim_id) claimIds.add(claim.claim_id);
    }
    for (const result of item.analysis_results || []) {
      if (result?.analysis_result_id) analysisIds.add(result.analysis_result_id);
    }
    for (const test of item.falsification_tests || []) {
      if (test?.test_id) testIds.add(test.test_id);
    }
    unresolvedGapCount += (item.unresolved_gaps || []).length;
  }

  return {
    claim_count: claimIds.size,
    analysis_result_count: analysisIds.size,
    test_count: testIds.size,
    unresolved_gap_count: unresolvedGapCount,
  };
}

module.exports = {
  entryTags,
  normalizeEvidenceRole,
  canonicalClusterKey,
  normalizedText,
  textTokenSet,
  candidateHypothesisText,
  resultHypothesisText,
  expectedDatasetRootFromRolePlan,
  pathContainsOrEquals,
  validationDatasetMatchesHandoff,
  validationResultMatchesPlannerCandidate,
  overlapCount,
  protocolAlignment,
  bridgeAlignment,
  bridgeLiteratureAndDataEvidence,
  summarizeEvidence,
  summarizeKnowledgeGraphs,
  aggregateKnowledgeGraphSummary,
  aggregateBridgeGraphSummary,
  summarizeSchemaQuality,
  aggregateReasoningSpineSummary,
};
