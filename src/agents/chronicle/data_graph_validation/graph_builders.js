"use strict";

const { createDataGraph } = require("../data_graph_artifacts");
const { __private: cycleStatePrivate = {} } = require("../cycle_state_artifacts");

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

function fallbackBaseDataGraph(hypotheses = []) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  for (const item of hypotheses) {
    const familyId = familyNodeId(item?.family_root);
    const hypothesisId = hypothesisNodeId(item?.hypothesis_id);
    const promotionGate = graphPromotionGate(item);
    const x = promotionGate.promotable ? variableNodeId(item?.x_variable || item?.primary_exposure) : null;
    const y = promotionGate.promotable ? variableNodeId(item?.y_variable || item?.outcome) : null;
    const predictiveEdgeId = promotionGate.promotable ? edgeIdForHypothesis(item) : null;
    for (const node of [
      familyId ? {
        id: familyId,
        type: "family",
        label: item.family_root,
        score: { family_score: 0 },
        state: item.state || "candidate",
        provenance: uniqueStrings([item.hypothesis_id, ...(item.validating_lanes || [])].filter(Boolean)),
      } : null,
      x ? { id: x, type: "variable", label: item.x_variable || item.primary_exposure, provenance: uniqueStrings([item.hypothesis_id]) } : null,
      y ? { id: y, type: "variable", label: item.y_variable || item.outcome, provenance: uniqueStrings([item.hypothesis_id]) } : null,
      hypothesisId ? {
        id: hypothesisId,
        type: "hypothesis",
        label: item.statement || item.hypothesis_id,
        state: item.state || item.latest_status || "candidate",
        provenance: uniqueStrings([item.hypothesis_id, ...(item.validating_lanes || [])].filter(Boolean)),
      } : null,
    ].filter(Boolean)) {
      if (seenNodes.has(node.id)) continue;
      seenNodes.add(node.id);
      nodes.push(node);
    }
    for (const edge of [
      familyId && hypothesisId ? {
        id: `edge:${hypothesisId}:${familyId}:belongs_to_family`,
        from: hypothesisId,
        to: familyId,
        relation: "belongs_to_family",
        provenance: uniqueStrings([item.hypothesis_id]),
      } : null,
      x && y && predictiveEdgeId ? {
        id: predictiveEdgeId,
        from: x,
        to: y,
        relation: "predicts",
        score: { support_score: 0, falsification_score: 0, instability_score: 0, update_count: 0 },
        status: "untested",
        provenance: uniqueStrings([item.hypothesis_id, ...(item.validating_lanes || [])].filter(Boolean)),
      } : null,
    ].filter(Boolean)) {
      if (seenEdges.has(edge.id)) continue;
      seenEdges.add(edge.id);
      edges.push(edge);
    }
  }
  return createDataGraph({ nodes, edges });
}

function buildReasoningGraphArtifact({ cycleId, hypotheses = [], evidencePackets = {}, validationResults = {}, graphDiff = {} }) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  const addNode = (node) => {
    if (!node?.id || seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge) => {
    if (!edge?.id || seenEdges.has(edge.id)) return;
    seenEdges.add(edge.id);
    edges.push(edge);
  };
  for (const item of asArray(hypotheses)) {
    const hypothesisId = String(item?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    const hNode = hypothesisNodeId(hypothesisId);
    const fNode = familyNodeId(item?.family_root);
    addNode({
      id: hNode,
      type: "hypothesis",
      label: item?.statement || hypothesisId,
      state: item?.state || item?.latest_status || "candidate",
      provenance: uniqueStrings([hypothesisId, ...asArray(item?.validating_lanes)]),
    });
    if (fNode) {
      addNode({ id: fNode, type: "family", label: item.family_root, state: item?.state || "candidate" });
      addEdge({
        id: `reasoning:${hNode}:${fNode}:belongs_to_family`,
        from: hNode,
        to: fNode,
        relation: "belongs_to_family",
        provenance: uniqueStrings([hypothesisId]),
      });
    }
    for (const claim of asArray(item?.claims)) {
      const claimId = String(claim?.claim_id || `claim:${hypothesisId}`).trim();
      addNode({ id: claimId, type: "claim", label: claim?.statement || claimId, status: claim?.status || "candidate" });
      addEdge({ id: `reasoning:${claimId}:${hNode}:supported_by`, from: claimId, to: hNode, relation: "supported_by" });
    }
  }
  for (const validation of asArray(validationResults?.validation_results)) {
    const validationId = String(validation?.validation_id || "").trim();
    if (!validationId) continue;
    addNode({
      id: validationId,
      type: "validation_result",
      label: validation?.validation_type || validationId,
      status: validation?.execution_status || null,
      provenance: validation?.provenance || {},
      diagnostics: validation?.diagnostics || {},
    });
    for (const hypothesisId of asArray(validation?.target_hypothesis_ids)) {
      addEdge({
        id: `reasoning:${validationId}:hypothesis:${hypothesisId}:validates`,
        from: validationId,
        to: hypothesisNodeId(hypothesisId),
        relation: validation?.execution_status === "completed" ? "supports" : "challenges",
        provenance: validation?.provenance || {},
      });
    }
  }
  for (const packet of asArray(evidencePackets?.evidence_packets)) {
    const packetId = String(packet?.evidence_packet_id || "").trim();
    if (!packetId) continue;
    addNode({ id: packetId, type: "evidence_packet", label: packet?.summary || packetId, verdict: packet?.verdict || null, provenance: asArray(packet?.provenance) });
    if (packet?.hypothesis_id) {
      addEdge({ id: `reasoning:${packetId}:hypothesis:${packet.hypothesis_id}:evidences`, from: packetId, to: hypothesisNodeId(packet.hypothesis_id), relation: "evidences" });
    }
  }
  return {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    graph_kind: "reasoning_knowledge_graph",
    nodes,
    edges,
    graph_update_log: graphDiff,
  };
}

module.exports = {
  fallbackBaseDataGraph,
  buildReasoningGraphArtifact,
};
