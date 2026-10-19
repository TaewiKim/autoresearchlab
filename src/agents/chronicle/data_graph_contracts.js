"use strict";

const PIPELINE_STAGES = Object.freeze({
  RETRIEVAL: "retrieval",
  FRONTIER_EXTRACTION: "frontier_extraction",
  DATA_GRAPH_CONSTRUCTION: "data_graph_construction",
  HYPOTHESIS_GENERATION: "hypothesis_generation",
  VALIDATION_PLANNING: "validation_planning",
  VALIDATION_EXECUTION: "validation_execution",
  EVIDENCE_PACKET_EMISSION: "evidence_packet_emission",
  GRAPH_UPDATE: "graph_update",
});

const ARTIFACT_FILES = Object.freeze({
  FRONTIER_CATALOG: "frontier_catalog.json",
  DATA_GRAPH: "data_graph.json",
  VALIDATION_PLAN: "validation_plan.json",
  EVIDENCE_PACKET: "evidence_packet.json",
  GRAPH_UPDATE_LOG: "graph_update_log.json",
});

// Seed vocabulary — the strings the chronicle's hypothesis pipeline emits by
// convention. NOT a closed allowlist: every cycle's data-graph carries its
// own vocabulary section and grows it as agents (scout, lab-director,
// analyst, ...) introduce new domain-specific node types and edge relations.
// See createVocabulary / extendVocabulary below; nothing rejects strings
// that aren't on this list.
const GRAPH_NODE_TYPES_SEED = [
  "variable",
  "family",
  "mechanism",
  "hypothesis",
  "validation",
  "evidence",
];

const GRAPH_EDGE_TYPES_SEED = [
  "belongs_to_family",
  "represents_mechanism",
  "predicts",
  "correlates_with",
  "mediates",
  "confounds",
  "moderates",
  "competes_with",
  "tests",
  "supports",
  "weakens",
  "falsifies",
  "inconclusive_for",
];

// Back-compat aliases. Prior code imported these as the canonical vocabulary
// list; they now name the seed defaults but keep the same values so legacy
// consumers see the same strings.
const GRAPH_NODE_TYPES = GRAPH_NODE_TYPES_SEED;
const GRAPH_EDGE_TYPES = GRAPH_EDGE_TYPES_SEED;

function _normalizeStringSet(values) {
  const set = new Set();
  if (!values) return set;
  const iter = Array.isArray(values)
    ? values
    : values instanceof Set
      ? Array.from(values)
      : [];
  for (const value of iter) {
    const text = String(value || "").trim();
    if (text) set.add(text);
  }
  return set;
}

function createVocabulary(seed = {}) {
  return {
    node_types: _normalizeStringSet(seed?.node_types),
    edge_relations: _normalizeStringSet(seed?.edge_relations),
  };
}

function extendVocabulary(vocab, { node_type = null, edge_relation = null } = {}) {
  if (!vocab) return false;
  let added = false;
  if (node_type) {
    const text = String(node_type).trim();
    if (text && !vocab.node_types.has(text)) {
      vocab.node_types.add(text);
      added = true;
    }
  }
  if (edge_relation) {
    const text = String(edge_relation).trim();
    if (text && !vocab.edge_relations.has(text)) {
      vocab.edge_relations.add(text);
      added = true;
    }
  }
  return added;
}

function serializeVocabulary(vocab) {
  return {
    node_types: Array.from(vocab?.node_types || []).sort(),
    edge_relations: Array.from(vocab?.edge_relations || []).sort(),
  };
}

// Build a vocabulary that captures every distinct node.type and
// edge.relation already present in *graph*. If graph already carries a
// `vocabulary` section, seed from it so previously-registered types that
// happen to have no surviving nodes/edges aren't lost on round-trip.
function vocabularyFromGraph(graph) {
  const vocab = createVocabulary(graph?.vocabulary);
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    extendVocabulary(vocab, { node_type: node?.type });
  }
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    extendVocabulary(vocab, { edge_relation: edge?.relation });
  }
  return vocab;
}

function artifactPathSet(basePath) {
  return {
    frontier_catalog: `${basePath}/${ARTIFACT_FILES.FRONTIER_CATALOG}`,
    data_graph: `${basePath}/${ARTIFACT_FILES.DATA_GRAPH}`,
    validation_plan: `${basePath}/${ARTIFACT_FILES.VALIDATION_PLAN}`,
    evidence_packet: `${basePath}/${ARTIFACT_FILES.EVIDENCE_PACKET}`,
    graph_update_log: `${basePath}/${ARTIFACT_FILES.GRAPH_UPDATE_LOG}`,
  };
}

module.exports = {
  PIPELINE_STAGES,
  ARTIFACT_FILES,
  GRAPH_NODE_TYPES,
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES_SEED,
  GRAPH_EDGE_TYPES_SEED,
  createVocabulary,
  extendVocabulary,
  serializeVocabulary,
  vocabularyFromGraph,
  artifactPathSet,
};
