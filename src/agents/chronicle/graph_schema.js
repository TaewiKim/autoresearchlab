"use strict";

const {
  GRAPH_NODE_TYPES,
  GRAPH_EDGE_TYPES,
} = require("./data_graph_contracts");

const NODE_TYPES = Object.freeze({
  VARIABLE: "variable",
  FAMILY: "family",
  MECHANISM: "mechanism",
  HYPOTHESIS: "hypothesis",
  VALIDATION: "validation",
  EVIDENCE: "evidence",
});

const RELATIONS = Object.freeze({
  FROM_X: "from_x",
  TO_Y: "to_y",
  UNDER_Z: "under_z",
  SUPPORTS: "supports",
  SUPPORTS_CANDIDATE: "supports_candidate",
  CONTRADICTS: "contradicts",
  SUGGESTS: "suggests",
  TESTS: "tests",
  TESTED_BY: "tested_by",
  EXECUTES: "executes",
  APPLIES_TO: "applies_to",
  REQUIRES_TEST: "requires_test",
  FALSIFIED_BY: "falsified_by",
  MISSING_TEST_FOR: "missing_test_for",
  OBSERVES: "observes",
  MEASURES: "measures",
  DEFINES_VARIABLE: "defines_variable",
  HAS_UNIT: "has_unit",
  MEASURED_BY: "measured_by",
  PROXIES_FOR: "proxies_for",
  MEDIATES: "mediates",
  MODERATES: "moderates",
  CONFOUNDS: "confounds",
  COMPETES_WITH: "competes_with",
  VALID_IN: "valid_in",
  INVALID_IN: "invalid_in",
  ALIGNED_WITH: "aligned_with",
  DERIVED_FROM: "derived_from",
  GENERATED_BY: "generated_by",
  MATERIALIZES_AS: "materializes_as",
  CONTAINS_VARIABLE: "contains_variable",
  CONTAINS_INDICATOR: "contains_indicator",
  BELONGS_TO_FAMILY: "belongs_to_family",
  REPRESENTS_MECHANISM: "represents_mechanism",
  PREDICTS: "predicts",
  CORRELATES_WITH: "correlates_with",
  WEAKENS: "weakens",
  FALSIFIES: "falsifies",
  INCONCLUSIVE_FOR: "inconclusive_for",
});

const DATA_GRAPH_RELATIONS = Object.freeze(
  GRAPH_EDGE_TYPES.reduce((accumulator, relation) => {
    accumulator[relation.toUpperCase()] = relation;
    return accumulator;
  }, {}),
);

function normalizeProvenance(provenance = {}) {
  if (Array.isArray(provenance)) {
    return {
      sources: provenance.filter(Boolean),
    };
  }
  if (!provenance || typeof provenance !== "object") {
    return {
      sources: [],
    };
  }
  return {
    ...provenance,
    sources: Array.isArray(provenance.sources) ? provenance.sources.filter(Boolean) : [],
  };
}

function graphNode(node_id, type, label, extra = {}) {
  const nodeType = String(type || "").trim();
  const payload = {
    ...extra,
  };
  return {
    ...payload,
    node_id,
    type: nodeType,
    label,
    score: payload.score && typeof payload.score === "object" ? payload.score : payload.score ?? null,
    state: payload.state ?? null,
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : payload.metadata ?? {},
    provenance: normalizeProvenance(payload.provenance),
  };
}

function graphEdge(source, target, relation, extra = {}) {
  const edgeRelation = String(relation || "").trim();
  const payload = {
    ...extra,
  };
  return {
    ...payload,
    source,
    target,
    relation: edgeRelation,
    weight: payload.weight ?? null,
    score: payload.score && typeof payload.score === "object" ? payload.score : payload.score ?? null,
    status: payload.status ?? null,
    provenance: normalizeProvenance(payload.provenance),
  };
}

function addNode(nodes, node) {
  if (!node?.node_id) return;
  if (nodes.some((item) => item.node_id === node.node_id)) return;
  nodes.push(node);
}

function addEdge(edges, edge) {
  if (!edge?.source || !edge?.target || !edge?.relation) return;
  if (
    edges.some(
      (item) =>
        item.source === edge.source &&
        item.target === edge.target &&
        item.relation === edge.relation,
    )
  ) {
    return;
  }
  edges.push(edge);
}

function slug(value, fallback = "item") {
  return (
    String(value || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function typedId(type, label, fallback = "item") {
  return `${type}:${slug(label, fallback)}`;
}

// When *vocabulary* is null, the type is treated as free-form (returns true
// for any non-empty string). When a vocabulary object is passed, membership
// is checked against its node_types Set. Per-graph vocabularies live on
// graph.vocabulary and grow dynamically as agents introduce new domain
// types — see createVocabulary / vocabularyFromGraph in data_graph_contracts.
function isNodeType(type, vocabulary = null) {
  const text = String(type || "").trim();
  if (!text) return false;
  if (!vocabulary) return true;
  if (vocabulary.node_types instanceof Set) return vocabulary.node_types.has(text);
  if (Array.isArray(vocabulary.node_types)) return vocabulary.node_types.includes(text);
  return GRAPH_NODE_TYPES.includes(text);
}

function isEdgeRelation(relation, vocabulary = null) {
  const text = String(relation || "").trim();
  if (!text) return false;
  if (!vocabulary) return true;
  if (vocabulary.edge_relations instanceof Set) return vocabulary.edge_relations.has(text);
  if (Array.isArray(vocabulary.edge_relations)) return vocabulary.edge_relations.includes(text);
  return GRAPH_EDGE_TYPES.includes(text);
}

module.exports = {
  NODE_TYPES,
  RELATIONS,
  DATA_GRAPH_RELATIONS,
  graphNode,
  graphEdge,
  addNode,
  addEdge,
  slug,
  typedId,
  isNodeType,
  isEdgeRelation,
  normalizeProvenance,
};
