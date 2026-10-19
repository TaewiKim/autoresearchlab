"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../../../shared/json");
const { compactString, uniqueTopPapers, writeJsonCompact } = require("./compact");

function arrayOf(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function uniqueStringsBounded(values, limit = 12) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const text = compactString(String(value || "").replace(/\s+/g, " ").trim(), 220);
    const key = String(text || "").toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function graphCounts(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return {
    node_count: Number(graph?.node_count || nodes.length || 0),
    edge_count: Number(graph?.edge_count || edges.length || 0),
  };
}

function graphHasContent(graph) {
  const counts = graphCounts(graph);
  return counts.node_count > 0 || counts.edge_count > 0;
}

function graphNodeLabels(graph, options = {}) {
  const type = String(options.type || "").trim();
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes
    .filter((node) => !type || String(node?.type || "") === type)
    .map((node) => node?.label || node?.name || node?.node_id || node?.id)
    .filter(Boolean);
}

function paperIdentifier(paper, index = 0) {
  return String(
    paper?.doi ||
    paper?.paper_id ||
    paper?.url ||
    paper?.title ||
    `paper:${index + 1}`,
  ).trim();
}

function compactTopPaperForTrend(paper, index) {
  if (!paper || typeof paper !== "object") return null;
  return {
    paper_id: paperIdentifier(paper, index),
    title: compactString(paper.title || "", 220) || null,
    year: paper.year || paper.publication_year || null,
    doi: paper.doi || paper.DOI || null,
    venue: compactString(paper.venue || paper.journal || "", 140) || null,
  };
}

function materializeGraphForState(graph, defaults = {}) {
  const base = graph && typeof graph === "object" ? graph : {};
  const nodes = Array.isArray(base.nodes) ? base.nodes : [];
  const edges = Array.isArray(base.edges) ? base.edges : [];
  return {
    ...base,
    graph_type: base.graph_type || defaults.graph_type || null,
    layer: base.layer || defaults.layer || null,
    graph_layers: Array.isArray(base.graph_layers)
      ? base.graph_layers
      : Array.isArray(defaults.graph_layers)
        ? defaults.graph_layers
        : undefined,
    cycle_id: defaults.cycle_id || base.cycle_id || null,
    generated_at: defaults.generated_at || base.generated_at || null,
    source: base.source || "chronicle_literature_synthesis",
    node_count: Number(base.node_count || nodes.length || 0),
    edge_count: Number(base.edge_count || edges.length || 0),
    nodes,
    edges,
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildTrendSummaryArtifact({
  cycleId,
  researchStage,
  lanes,
  literatureGraph,
  dataGraph,
  familyNomination,
  familyTournament,
  writingLoop,
}) {
  const topPapers = uniqueTopPapers(lanes, 16)
    .map(compactTopPaperForTrend)
    .filter(Boolean);
  const paperIds = topPapers.map((paper) => paper.paper_id).filter(Boolean);
  const conceptLabels = graphNodeLabels(literatureGraph, { type: "concept" });
  const familyLabels = (familyNomination || []).map((item) => item.family_root);
  const mechanismLabels = uniqueStringsBounded([
    ...graphNodeLabels(literatureGraph, { type: "mechanism" }),
    ...(familyNomination || []).flatMap((item) => item.mechanisms || []),
  ], 12);
  const methodologyLabels = uniqueStringsBounded([
    ...(lanes || []).flatMap((lane) =>
      arrayOf(lane?.hypotheses).flatMap((hypothesis) => [
        hypothesis?.validation_protocol?.model,
        hypothesis?.identification_strategy?.method,
        ...(Array.isArray(hypothesis?.test_plan) ? hypothesis.test_plan : []),
      ])),
    ...(Array.isArray(writingLoop?.section_outline)
      ? writingLoop.section_outline.map((section) => section?.title || section?.heading || section?.section)
      : []),
  ], 10);
  const counts = {
    literature_graph: graphCounts(literatureGraph),
    data_graph: graphCounts(dataGraph),
  };
  const ranking = Array.isArray(familyTournament?.ranking) ? familyTournament.ranking : [];
  const totalSupport = ranking.reduce((sum, item) => sum + Number(item.support_count || 0), 0);
  const topFamily = ranking[0] || null;
  const topFamilyShare = totalSupport > 0
    ? Number((Number(topFamily?.support_count || 0) / totalSupport).toFixed(3))
    : 0;
  const underexploredFamilies = ranking
    .filter((item) => Number(item.hypothesis_count || 0) === 0 || Number(item.support_count || 0) <= 1)
    .map((item) => item.family_root);
  const openGaps = uniqueStringsBounded([
    counts.literature_graph.edge_count === 0 ? "Literature graph has no supported mechanism/outcome edges yet." : null,
    counts.data_graph.node_count === 0 ? "Data graph has no dataset, sample-group, or variable nodes yet." : null,
    ...underexploredFamilies.map((family) => `${family} has low hypothesis or support coverage in the current literature lanes.`),
    ...(familyNomination || []).flatMap((item) => item.sample_claims || []),
  ], 12);

  return {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    research_stage: researchStage,
    source: "chronicle_literature_synthesis",
    cluster_labels: uniqueStringsBounded([...familyLabels, ...conceptLabels], 12),
    dominant_mechanisms: mechanismLabels,
    rising_methodologies: methodologyLabels,
    saturated_baselines: ranking
      .filter((item) => Number(item.support_count || 0) >= 2 || Number(item.hypothesis_count || 0) >= 2)
      .slice(0, 8)
      .map((item) => ({
        family_root: item.family_root,
        support_count: Number(item.support_count || 0),
        hypothesis_count: Number(item.hypothesis_count || 0),
        paper_ids: paperIds.slice(0, 6),
      })),
    open_gaps: openGaps,
    research_attention_map: {
      lane_count: lanes.length,
      paper_count: topPapers.length,
      top_papers: topPapers.slice(0, 10),
      cluster_support: ranking.slice(0, 10).map((item) => ({
        family_root: item.family_root,
        support_count: Number(item.support_count || 0),
        hypothesis_count: Number(item.hypothesis_count || 0),
        nomination_count: Number(item.nomination_count || 0),
      })),
      graph_counts: counts,
    },
    attention_concentration: {
      top_family: topFamily?.family_root || null,
      top_family_support_share: topFamilyShare,
      family_count: ranking.length,
      underexplored_family_count: underexploredFamilies.length,
      interpretation: topFamilyShare >= 0.6
        ? "Current literature attention is concentrated around one family; pivot candidates should target underexplored mechanisms or moderators."
        : "Current literature attention is distributed across multiple candidate families.",
    },
  };
}

function cycleStateArtifactPaths(root, cycleId) {
  const stateDir = path.join(root, "state");
  return {
    state_dir: stateDir,
    literature_summary_path: path.join(stateDir, `${cycleId}-literature-summary.json`),
    literature_graph_path: path.join(stateDir, `${cycleId}-literature-graph.json`),
    data_graph_path: path.join(stateDir, `${cycleId}-data-graph.json`),
    trend_summary_path: path.join(stateDir, `${cycleId}-trend-summary.json`),
  };
}

function writeCycleKnowledgeStateArtifacts({
  root,
  cycleId,
  researchStage,
  lanes,
  literatureGraph,
  dataGraph,
  familyNomination,
  familyTournament,
  writingLoop,
}) {
  const paths = cycleStateArtifactPaths(root, cycleId);
  ensureDir(paths.state_dir);
  const generatedAt = new Date().toISOString();
  const literatureGraphArtifact = materializeGraphForState(literatureGraph, {
    cycle_id: cycleId,
    generated_at: generatedAt,
    graph_type: "literature-knowledge-graph",
    layer: "literature",
    graph_layers: ["literature", "codebook"],
  });
  writeJsonCompact(paths.literature_graph_path, literatureGraphArtifact);

  const existingDataGraph = readJsonIfExists(paths.data_graph_path);
  const dataGraphPreserved = graphHasContent(existingDataGraph);
  if (!dataGraphPreserved) {
    const dataGraphArtifact = materializeGraphForState(dataGraph, {
      cycle_id: cycleId,
      generated_at: generatedAt,
      graph_type: "data-knowledge-graph",
      layer: "data",
      graph_layers: ["data"],
    });
    writeJsonCompact(paths.data_graph_path, dataGraphArtifact);
  }

  const trendSummary = buildTrendSummaryArtifact({
    cycleId,
    researchStage,
    lanes,
    literatureGraph: literatureGraphArtifact,
    dataGraph: dataGraphPreserved ? existingDataGraph : dataGraph,
    familyNomination,
    familyTournament,
    writingLoop,
  });
  writeJsonCompact(paths.trend_summary_path, trendSummary);

  return {
    ...paths,
    data_graph_preserved: dataGraphPreserved,
    trend_summary: trendSummary,
  };
}

module.exports = {
  cycleStateArtifactPaths,
  writeCycleKnowledgeStateArtifacts,
};
