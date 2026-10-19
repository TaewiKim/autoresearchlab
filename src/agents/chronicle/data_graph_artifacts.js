"use strict";

const { serializeVocabulary, vocabularyFromGraph } = require("./data_graph_contracts");

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

function inferredEdgeProvenance(normalized) {
  if (normalized.provenance.length > 0) return normalized.provenance;
  const hints = [];
  if (normalized.id) hints.push(normalized.id);
  if (normalized.from && normalized.from.startsWith("hypothesis:")) hints.push(normalized.from.replace(/^hypothesis:/, ""));
  if (normalized.to && normalized.to.startsWith("hypothesis:")) hints.push(normalized.to.replace(/^hypothesis:/, ""));
  if (normalized.from && normalized.from.startsWith("family:")) hints.push(normalized.from.replace(/^family:/, ""));
  if (normalized.to && normalized.to.startsWith("family:")) hints.push(normalized.to.replace(/^family:/, ""));
  return uniqueStrings(hints);
}

function normalizeScore(score = {}) {
  if (!score || typeof score !== "object") return {};
  return Object.fromEntries(
    Object.entries(score)
      .map(([key, value]) => [key, Number(value)])
      .filter(([, value]) => Number.isFinite(value)),
  );
}

function normalizeFrontierFamily(item = {}) {
  const familyId = String(item.family_id || item.family_root || item.family || "").trim();
  if (!familyId) return null;
  return {
    family_id: familyId,
    label: String(item.label || familyId).trim(),
    members: asArray(item.members).map((member) => String(member).trim()).filter(Boolean),
    support_count: Number(item.support_count || 0),
    mechanism_ids: asArray(item.mechanism_ids || item.mechanisms).map((value) => String(value).trim()).filter(Boolean),
    status: String(item.status || item.rival_status || "candidate_primary").trim(),
    provenance: asArray(item.provenance),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
  };
}

function normalizeMechanism(item = {}) {
  const mechanismId = String(item.mechanism_id || item.id || item.label || "").trim();
  if (!mechanismId) return null;
  return {
    mechanism_id: mechanismId,
    label: String(item.label || mechanismId).trim(),
    provenance: asArray(item.provenance),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
  };
}

function normalizeRivalStructure(item = {}) {
  const structureId = String(item.structure_id || item.id || "").trim();
  if (!structureId) return null;
  return {
    structure_id: structureId,
    root_family_id: String(item.root_family_id || item.family_root || "").trim(),
    outcome: String(item.outcome || "").trim(),
    structure_type: String(item.structure_type || "primary_exposure").trim(),
    mechanism_ids: asArray(item.mechanism_ids).map((value) => String(value).trim()).filter(Boolean),
    provenance: asArray(item.provenance),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
  };
}

function createFrontierCatalog(payload = {}) {
  return {
    candidate_primary_variable_families: asArray(payload.candidate_primary_variable_families || payload.primary_variable_families)
      .map(normalizeFrontierFamily)
      .filter(Boolean),
    candidate_mechanisms: asArray(payload.candidate_mechanisms).map(normalizeMechanism).filter(Boolean),
    candidate_rival_structures: asArray(payload.candidate_rival_structures).map(normalizeRivalStructure).filter(Boolean),
    candidate_confounders: asArray(payload.candidate_confounders).map((value) => String(value).trim()).filter(Boolean),
    candidate_mediators: asArray(payload.candidate_mediators).map((value) => String(value).trim()).filter(Boolean),
    candidate_measurement_artifacts: asArray(payload.candidate_measurement_artifacts).map((value) => String(value).trim()).filter(Boolean),
    support_counts: payload.support_counts && typeof payload.support_counts === "object" ? payload.support_counts : {},
    uncertainty_notes: asArray(payload.uncertainty_notes).map((value) => String(value).trim()).filter(Boolean),
  };
}

function createDataGraph(payload = {}) {
  const nodes = [];
  const seenNodes = new Set();
  for (const node of asArray(payload.nodes)) {
    const normalized = {
      id: String(node?.id || "").trim(),
      type: String(node?.type || "").trim(),
      label: String(node?.label || node?.id || "").trim(),
      metadata: node?.metadata && typeof node.metadata === "object" ? node.metadata : {},
      score: normalizeScore(node?.score),
      state: node?.state ?? null,
      provenance: uniqueStrings(node?.provenance),
    };
    if (!normalized.id || !normalized.type || seenNodes.has(normalized.id)) continue;
    seenNodes.add(normalized.id);
    nodes.push(normalized);
  }

  const edges = [];
  const seenEdges = new Set();
  for (const edge of asArray(payload.edges)) {
    const normalized = {
      id: String(edge?.id || "").trim(),
      from: String(edge?.from || edge?.source || "").trim(),
      to: String(edge?.to || edge?.target || "").trim(),
      relation: String(edge?.relation || edge?.type || "").trim(),
      weight: Number.isFinite(Number(edge?.weight)) ? Number(edge.weight) : null,
      metadata: edge?.metadata && typeof edge.metadata === "object" ? edge.metadata : {},
      score: normalizeScore(edge?.score),
      status: edge?.status ?? null,
      provenance: uniqueStrings(edge?.provenance),
    };
    const key = normalized.id || `${normalized.from}:${normalized.relation}:${normalized.to}`;
    if (!normalized.from || !normalized.to || !normalized.relation || seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({
      ...normalized,
      provenance: inferredEdgeProvenance(normalized),
      source: normalized.from,
      target: normalized.to,
      type: normalized.relation,
    });
  }

  // Build a self-describing vocabulary section from whatever types/relations
  // actually showed up — plus any vocabulary the input graph already carried,
  // so previously-registered terms aren't lost on a round-trip.
  const vocabulary = serializeVocabulary(
    vocabularyFromGraph({
      vocabulary: payload?.vocabulary || null,
      nodes,
      edges,
    }),
  );

  return {
    vocabulary,
    nodes,
    edges,
  };
}

function createEvidencePacket(payload = {}) {
  return {
    evidence_packet_id: String(payload.evidence_packet_id || payload.id || "").trim(),
    validation_id: String(payload.validation_id || "").trim(),
    hypothesis_id: String(payload.hypothesis_id || "").trim(),
    family_root: String(payload.family_root || payload.family_id || "").replace(/^family:/, "").trim(),
    target_ids: asArray(payload.target_ids).map((value) => String(value).trim()).filter(Boolean),
    outcome: String(payload.outcome || "").trim(),
    verdict: String(payload.verdict || "inconclusive").trim(),
    summary: String(payload.summary || "").trim(),
    measures: payload.measures && typeof payload.measures === "object" ? payload.measures : {},
    graph_updates: asArray(payload.graph_updates).map((update) => ({
      target_type: String(update?.target_type || "").trim(),
      target_id: String(update?.target_id || "").trim(),
      operation: String(update?.operation || "").trim(),
      relation: String(update?.relation || "").trim(),
      delta: Number.isFinite(Number(update?.delta)) ? Number(update.delta) : null,
      rationale: String(update?.rationale || "").trim(),
      family_root: String(update?.family_root || update?.family_id || "").replace(/^family:/, "").trim(),
      hypothesis_id: String(update?.hypothesis_id || "").trim(),
    })).filter((update) => update.target_type && update.target_id && update.operation),
    provenance: asArray(payload.provenance),
  };
}

module.exports = {
  createFrontierCatalog,
  createDataGraph,
  createEvidencePacket,
};
