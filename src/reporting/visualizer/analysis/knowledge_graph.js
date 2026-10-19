"use strict";

function buildKnowledgeGraphDigest(knowledgeGraph, knowledgeGraphExplorer) {
  const literatureGraph = knowledgeGraph?.literature_graph || {};
  const dataGraph = knowledgeGraph?.data_graph || {};
  const reasoningGraph = knowledgeGraph?.reasoning_graph || {};
  const dataEdges = Array.isArray(knowledgeGraphExplorer?.data_graph?.edges)
    ? knowledgeGraphExplorer.data_graph.edges
    : [];
  const statusCounts = {};
  const stageCounts = {};
  for (const edge of dataEdges) {
    const status = edge?.status || "null";
    const stage = edge?.metadata?.evidence_stage || "null";
    statusCounts[status] = Number(statusCounts[status] || 0) + 1;
    stageCounts[stage] = Number(stageCounts[stage] || 0) + 1;
  }
  return {
    literature_graph: {
      hypothesis_count: Number(literatureGraph.hypothesis_count || 0),
      node_count: Number(literatureGraph.node_count || 0),
      edge_count: Number(literatureGraph.edge_count || 0),
    },
    reasoning_graph: {
      claim_count: Number(reasoningGraph.claim_count || 0),
      analysis_result_count: Number(reasoningGraph.analysis_result_count || 0),
      test_count: Number(reasoningGraph.test_count || 0),
      unresolved_gap_count: Number(reasoningGraph.unresolved_gap_count || 0),
    },
    data_graph: {
      hypothesis_count: Number(dataGraph.hypothesis_count || 0),
      node_count: Number(dataGraph.node_count || 0),
      edge_count: Number(dataGraph.edge_count || 0),
      edge_status_counts: statusCounts,
      evidence_stage_counts: stageCounts,
    },
  };
}

module.exports = { buildKnowledgeGraphDigest };
