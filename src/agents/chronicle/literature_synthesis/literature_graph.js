"use strict";

const { RELATIONS, graphNode, graphEdge, addNode, addEdge, typedId } = require("../graph_schema");
const { lowerJoined, uniqueTitles } = require("./compact");
const {
  tokenize,
  topConcepts,
  conceptBundle,
  groundedVariableBundle,
  buildCodebookGraph,
  slugifyFragment,
  clampScore,
} = require("./codebook");

function buildHypothesisNode(options = {}) {
  return {
    node_id: `hypothesis:${options.hypothesis_id || "candidate"}`,
    type: "hypothesis",
    layer: "hypothesis",
    statement: options.statement || null,
    status: options.status || "candidate",
    direction: options.direction || "unknown",
    expected_impact: clampScore(options.expected_impact),
    verifiability: clampScore(options.verifiability),
    structural_novelty: clampScore(options.structural_novelty),
    total_score: clampScore(options.total_score),
  };
}

function inferCondition(bundle, rolePlan) {
  // The previous version routed any "coverage" or "surveillance"
  // mention to a fixed health-domain conditioning label. Now we just
  // surface whatever the topic-derived bundle's tertiary concept is —
  // domain-neutral.
  return bundle?.tertiary || null;
}

function paperSignalProfile(paper) {
  const year = Number(paper?.year || 0) || null;
  const quality = paper?.literature_screening?.quality || {};
  const tracks = Array.isArray(quality.tracks) ? quality.tracks : [];
  const citedByCount = quality.citation_count_verified === true ? paper.cited_by_count : null;
  const currentYear = new Date().getUTCFullYear();
  const recencyBand = !year ? "unknown" : year > currentYear ? "unknown"
    : currentYear - year <= 1 ? "latest" : currentYear - year <= 3 ? "recent"
      : currentYear - year <= 6 ? "established" : "legacy";
  const venueTier = quality.venue_metric_verified === true ? "verified-q1" : "unknown";
  const citationBand = citedByCount === null ? "unknown" : citedByCount >= 150 ? "very-high"
    : citedByCount >= 100 ? "high" : "below-impact-threshold";
  const evidenceStrength = tracks.includes("established_impact") ? "verified-impact-track"
    : tracks.includes("recent_frontier") ? "recent-frontier-impact-undetermined" : "unverified";
  return { year, citedByCount, recencyBand, venueTier, citationBand, evidenceStrength, qualityTracks: tracks };
}

function queryMatchesPaper(query, paper) {
  const queryTokens = tokenize(query);
  const paperTokens = new Set(tokenize(`${paper?.title || ""} ${paper?.abstract || ""}`));
  const overlap = queryTokens.filter((token) => paperTokens.has(token));
  return overlap.length >= 2;
}

function scenarioMatchesPaper(scenario, paper) {
  const text = lowerJoined(paper);
  const terms = Array.isArray(scenario?.search_terms) ? scenario.search_terms : [];
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

// Confounder candidates used to be a hand-curated WHO/health list
// (health_system_capacity, measurement_quality, etc.). They now come
// from the rolePlan's explicit candidate_confounders array if present,
// otherwise the synthesizer surfaces nothing — better to under-claim
// than fabricate domain-irrelevant confounders.
function deriveConfounders(papers, rolePlan) {
  const explicit = Array.isArray(rolePlan?.candidate_confounders)
    ? rolePlan.candidate_confounders
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  return explicit.slice(0, 4);
}

// Same principle for rival explanations: the previous implementation
// shipped four WHO-domain rival sentences. They now come from
// rolePlan.candidate_rival_explanations or from upstream-supplied
// hypothesis content; otherwise empty.
function deriveRivalExplanations(papers, rolePlan) {
  const explicit = Array.isArray(rolePlan?.candidate_rival_explanations)
    ? rolePlan.candidate_rival_explanations
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  return explicit.slice(0, 3);
}

function paperVariableMatches(paper, variable) {
  const text = lowerJoined(paper);
  return (variable?.concepts || []).some((term) => text.includes(String(term).toLowerCase()));
}

function phraseWindows(text, maxTerms = 3) {
  const tokens = tokenize(text);
  const phrases = new Set();
  for (let size = 1; size <= maxTerms; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      phrases.add(tokens.slice(index, index + size).join(" "));
    }
  }
  return phrases;
}

function variableGroundingScore(paper, variable) {
  if (!variable) return 0;
  const text = lowerJoined(paper);
  const titlePhrases = phraseWindows(paper?.title || "", 3);
  let score = 0;
  for (const concept of variable.concepts || []) {
    const normalized = String(concept).toLowerCase();
    if (text.includes(normalized)) score += 2;
    if (titlePhrases.has(normalized)) score += 2;
  }
  return score;
}

function scenarioGroundingLabels(paper, scenarios = []) {
  return scenarios
    .filter((scenario) => scenarioMatchesPaper(scenario, paper))
    .map((scenario) => scenario.label)
    .filter(Boolean);
}

function evidenceWeight(profile, extra = 0) {
  const recency =
    profile.recencyBand === "latest" ? 1 :
      profile.recencyBand === "recent" ? 0.85 :
        profile.recencyBand === "established" ? 0.7 : 0.5;
  const venue =
    profile.venueTier === "flagship" ? 1 :
      profile.venueTier === "high-impact" ? 0.9 :
        profile.venueTier === "field-leading" ? 0.8 : 0.6;
  const citation =
    profile.citationBand === "very-high" ? 1 :
      profile.citationBand === "high" ? 0.85 :
        profile.citationBand === "moderate" ? 0.7 : 0.5;
  return clampScore(recency * 0.35 + venue * 0.3 + citation * 0.25 + extra * 0.1);
}

function graphMerge(target, graph) {
  const seenNodes = new Set(target.nodes.map((item) => item.node_id));
  const seenEdges = new Set(target.edges.map((item) => `${item.source}|${item.relation}|${item.target}`));
  for (const node of graph?.nodes || []) {
    if (!node?.node_id || seenNodes.has(node.node_id)) continue;
    seenNodes.add(node.node_id);
    target.nodes.push(node);
  }
  for (const edge of graph?.edges || []) {
    const key = `${edge.source}|${edge.relation}|${edge.target}`;
    if (!edge?.source || !edge?.target || seenEdges.has(key)) continue;
    seenEdges.add(key);
    target.edges.push(edge);
  }
}

function aggregateLiteratureGraphs(lanes = []) {
  const aggregate = {
    graph_type: "literature-knowledge-graph",
    layer: "literature",
    graph_layers: ["literature", "codebook"],
    node_count: 0,
    edge_count: 0,
    nodes: [],
    edges: [],
    source_lane_ids: [],
  };

  for (const lane of lanes) {
    if (!lane?.literature_graph) continue;
    graphMerge(aggregate, lane.literature_graph);
    if (lane.lane_id) aggregate.source_lane_ids.push(lane.lane_id);
  }

  aggregate.node_count = aggregate.nodes.length;
  aggregate.edge_count = aggregate.edges.length;
  return aggregate.nodes.length > 0 || aggregate.edges.length > 0 ? aggregate : null;
}

function buildLiteratureGraph(papers, rolePlan, options = {}) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  const roleQueries = Array.isArray(rolePlan?.queries) ? rolePlan.queries : [];
  const discoveredQueries = Array.isArray(options.discovered_queries) ? options.discovered_queries : [];
  const scenarios = Array.isArray(options.hypothesis_scenarios) ? options.hypothesis_scenarios : [];
  const queries = [
    ...roleQueries.map((query) => ({ query, source: "role-plan" })),
    ...discoveredQueries.map((query) => ({ query, source: "search-expansion" })),
  ];

  function addNode(node) {
    if (seenNodes.has(node.node_id)) return;
    seenNodes.add(node.node_id);
    nodes.push(node);
  }

  function addEdge(edge) {
    const key = `${edge.source}|${edge.relation}|${edge.target}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  }

  const concepts = topConcepts(papers, 10);
  const bundle = conceptBundle(papers, rolePlan);
  const grounded = groundedVariableBundle(papers, rolePlan);
  const condition = inferCondition(bundle, rolePlan);
  const codebookGraph = buildCodebookGraph(grounded);
  graphMerge({ nodes, edges }, codebookGraph);

  concepts.forEach((concept, index) => {
    addNode(graphNode(`concept:${slugifyFragment(concept)}`, "concept", concept, {
      rank: index + 1,
      layer: "literature",
    }));
  });

  queries.slice(0, 10).forEach((item, index) => {
    const queryId = `query:${index + 1}`;
    addNode(graphNode(queryId, "query", item.query, { source: item.source, layer: "literature" }));
    topConcepts([{ title: item.query, abstract: "" }], 4).forEach((concept) => {
      addEdge(
        graphEdge(queryId, `concept:${slugifyFragment(concept)}`, "retrieves-literature-for"),
      );
    });
  });

  papers.slice(0, 12).forEach((paper, index) => {
    const paperId = `paper:${slugifyFragment(paper.doi || paper.title || `paper-${index + 1}`)}`;
    const journalId = paper.journal ? `journal:${slugifyFragment(paper.journal)}` : null;
    const profile = paperSignalProfile(paper);
    const abstractAvailable = Boolean(String(paper.abstract || paper.abstract_snippet || "").trim());
    const fullTextStatus = paper.full_text_status || (abstractAvailable ? "abstract_only" : "metadata_only");
    const xGrounding = grounded ? variableGroundingScore(paper, grounded.x) : 0;
    const yGrounding = grounded ? variableGroundingScore(paper, grounded.y) : 0;
    const zGrounding = grounded ? variableGroundingScore(paper, grounded.z) : 0;
    const matchedScenarioLabels = scenarioGroundingLabels(paper, scenarios);
    const supportWeight = evidenceWeight(profile, matchedScenarioLabels.length > 0 ? 0.1 : 0);
    addNode(
      graphNode(paperId, "paper", paper.title || `Paper ${index + 1}`, {
        year: profile.year,
        doi: paper.doi || null,
        journal: paper.journal || null,
        cited_by_count: profile.citedByCount,
        recency_band: profile.recencyBand,
        citation_band: profile.citationBand,
        venue_tier: profile.venueTier,
        evidence_strength: profile.evidenceStrength,
        evidence_quality_tracks: profile.qualityTracks,
        full_text_status: fullTextStatus,
        kg_seed_basis: paper.kg_seed_basis || (fullTextStatus === "abstract_only" ? "abstract" : fullTextStatus),
        abstract_available: abstractAvailable,
        open_access: Boolean(paper.open_access),
        grounding_scores: {
          x: xGrounding,
          y: yGrounding,
          z: zGrounding,
        },
        matched_scenarios: matchedScenarioLabels,
        layer: "literature",
      }),
    );
    if (journalId) {
      addNode(graphNode(journalId, "journal", paper.journal, {
        layer: "literature",
      }));
      addEdge(graphEdge(paperId, journalId, "published-in", { weight: supportWeight }));
    }

    topConcepts([{ title: paper.title, abstract: paper.abstract }], 5).forEach((concept) => {
      const conceptId = `concept:${slugifyFragment(concept)}`;
      addNode(graphNode(conceptId, "concept", concept, { layer: "literature" }));
      addEdge(graphEdge(paperId, conceptId, "supports", { weight: supportWeight }));
    });

    (grounded ? [grounded.x, grounded.y, grounded.z] : []).filter(Boolean).forEach((variable) => {
      const variableId = `variable:${variable.variable_id}`;
      const groundingScore = variableGroundingScore(paper, variable);
      if (groundingScore > 0) {
        addEdge(graphEdge(paperId, variableId, "measures-or-discusses", {
          weight: clampScore(Math.min(1, groundingScore / 6)),
          grounding_score: groundingScore,
        }));
      }
    });

    queries.slice(0, 10).forEach((item, queryIndex) => {
      const queryId = `query:${queryIndex + 1}`;
      if (queryMatchesPaper(item.query, paper)) {
        addEdge(graphEdge(queryId, paperId, "retrieved-evidence", { weight: supportWeight }));
      }
    });
  });

  scenarios.slice(0, 8).forEach((scenario, index) => {
    const scenarioId = `scenario:${slugifyFragment(scenario.label || `scenario-${index + 1}`)}`;
    addNode(graphNode(scenarioId, "scenario", scenario.label || `scenario-${index + 1}`, {
      layer: "literature",
      hypothesis: scenario.hypothesis || null,
      validation_scenario: scenario.validation_scenario || null,
    }));
    if (grounded?.x_variable) addEdge(graphEdge(scenarioId, `variable:${grounded.x_variable}`, "tests-x"));
    if (grounded?.y_variable) addEdge(graphEdge(scenarioId, `variable:${grounded.y_variable}`, "tests-y"));
    if (grounded?.z_variable) addEdge(graphEdge(scenarioId, `variable:${grounded.z_variable}`, "tests-z"));
    (scenario.search_terms || []).slice(0, 4).forEach((term) => {
      queries.slice(0, 10).forEach((item, queryIndex) => {
        const queryId = `query:${queryIndex + 1}`;
        if (String(item.query).toLowerCase().includes(String(term).toLowerCase())) {
          addEdge(graphEdge(scenarioId, queryId, "expands-search-with"));
        }
      });
    });
    papers.slice(0, 12).forEach((paper, paperIndex) => {
      const paperId = `paper:${slugifyFragment(paper.doi || paper.title || `paper-${paperIndex + 1}`)}`;
      if (scenarioMatchesPaper(scenario, paper)) {
        addEdge(graphEdge(paperId, scenarioId, "motivates-scenario", {
          weight: evidenceWeight(paperSignalProfile(paper), 0.1),
        }));
      }
    });
  });

  if (condition) {
    addNode(graphNode(`condition:${slugifyFragment(condition)}`, "condition", condition, { layer: "literature" }));
  }

  const primaryId = `concept:${slugifyFragment(bundle.primary)}`;
  const secondaryId = `concept:${slugifyFragment(bundle.secondary)}`;
  const tertiaryId = `concept:${slugifyFragment(bundle.tertiary)}`;
  addNode(graphNode(primaryId, "concept", bundle.primary, { layer: "literature" }));
  addNode(graphNode(secondaryId, "concept", bundle.secondary, { layer: "literature" }));
  addNode(graphNode(tertiaryId, "concept", bundle.tertiary, { layer: "literature" }));
  addEdge(graphEdge(primaryId, tertiaryId, "related-through-context"));
  addEdge(graphEdge(tertiaryId, secondaryId, "related-to-outcome"));
  if (grounded?.x_variable) {
    const xVariableId = `variable:${grounded.x_variable}`;
    addNode(graphNode(xVariableId, "variable", grounded.x_label, { role: "input", layer: "literature" }));
    addEdge(graphEdge(xVariableId, primaryId, "proxy-for"));
  }
  if (grounded?.y_variable) {
    const yVariableId = `variable:${grounded.y_variable}`;
    addNode(graphNode(yVariableId, "variable", grounded.y_label, { role: "outcome", layer: "literature" }));
    addEdge(graphEdge(yVariableId, secondaryId, "proxy-for"));
  }
  if (grounded?.z_variable) {
    const zVariableId = `variable:${grounded.z_variable}`;
    addNode(graphNode(zVariableId, "variable", grounded.z_label, { role: "condition", layer: "literature" }));
    addEdge(graphEdge(zVariableId, tertiaryId, "proxy-for"));
    if (condition) {
      addEdge(graphEdge(zVariableId, `condition:${slugifyFragment(condition)}`, "measured-under"));
    }
  }
  if (condition) {
    addEdge(graphEdge(primaryId, `condition:${slugifyFragment(condition)}`, "valid-under"));
    addEdge(graphEdge(secondaryId, `condition:${slugifyFragment(condition)}`, "observed-under"));
  }

  return {
    graph_type: "literature-knowledge-graph",
    layer: "literature",
    graph_layers: ["literature", "codebook"],
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
    anchor_path: {
      start_variable: grounded?.x_variable || null,
      mediator: grounded?.z_variable || null,
      end_variable: grounded?.y_variable || null,
      supporting_claims: uniqueTitles(papers, 4),
      supporting_conditions: condition ? [condition] : [],
    },
    codebook_grounding: grounded,
    codebook_graph: codebookGraph,
  };
}

function buildScoreBundle({ paperSupport, graphSupport, condition, directness = 0.6, impact = 0.6 }) {
  const paperCount = Array.isArray(paperSupport) ? paperSupport.length : 0;
  const graphEdgeCount = Number(graphSupport?.edge_count || 0);
  const verifiability = clampScore(0.4 + paperCount * 0.08 + (condition ? 0.1 : 0.04) + directness * 0.15);
  const expectedImpact = clampScore(impact + Math.min(0.18, paperCount * 0.03));
  const structuralNovelty = clampScore(0.35 + Math.min(0.2, graphEdgeCount / 40) + (condition ? 0.08 : 0));
  const totalScore = clampScore(
    expectedImpact * 0.4 + verifiability * 0.4 + structuralNovelty * 0.2,
  );
  return {
    expected_impact: expectedImpact,
    verifiability,
    structural_novelty: structuralNovelty,
    total_score: totalScore,
  };
}

function buildStructuredClaims({ statement, rationale, paperSupport, options = {} }) {
  const claimId = typedId("claim", statement);
  return [
    {
      claim_id: claimId,
      statement: statement || null,
      rationale: rationale || null,
      x_variable: options.x_variable || null,
      y_variable: options.y_variable || null,
      context: options.condition || null,
      direction: options.direction || "unknown",
      supporting_papers: Array.isArray(paperSupport) ? paperSupport.slice(0, 5) : [],
    },
  ];
}

function buildResearchReasoningGraph(baseGraph, hypothesis) {
  const graph = {
    graph_type: baseGraph?.graph_type || "literature-knowledge-graph",
    layer: baseGraph?.layer || "literature",
    graph_layers: Array.isArray(baseGraph?.graph_layers)
      ? Array.from(new Set([...baseGraph.graph_layers, "research-reasoning"]))
      : ["literature", "research-reasoning"],
    node_count: 0,
    edge_count: 0,
    nodes: Array.isArray(baseGraph?.nodes) ? baseGraph.nodes.map((node) => ({ ...node })) : [],
    edges: Array.isArray(baseGraph?.edges) ? baseGraph.edges.map((edge) => ({ ...edge })) : [],
    anchor_path: baseGraph?.anchor_path || null,
    codebook_grounding: baseGraph?.codebook_grounding || null,
    codebook_graph: baseGraph?.codebook_graph || null,
  };

  const hypothesisNodeId = `hypothesis:${hypothesis.hypothesis_id}`;
  addNode(graph.nodes, graphNode(hypothesisNodeId, "hypothesis", hypothesis.statement, {
    layer: "research-reasoning",
    direction: hypothesis.direction || "unknown",
  }));

  if (hypothesis.x_variable) {
    addEdge(graph.edges, graphEdge(`variable:${hypothesis.x_variable}`, hypothesisNodeId, RELATIONS.FROM_X));
  }
  if (hypothesis.y_variable) {
    addEdge(graph.edges, graphEdge(hypothesisNodeId, `variable:${hypothesis.y_variable}`, RELATIONS.TO_Y));
  }

  for (const claim of hypothesis.claims || []) {
    addNode(graph.nodes, graphNode(claim.claim_id, "claim", claim.statement, {
      layer: "research-reasoning",
      rationale: claim.rationale || null,
    }));
    addEdge(graph.edges, graphEdge(claim.claim_id, hypothesisNodeId, RELATIONS.SUPPORTS_CANDIDATE));
    for (const paperTitle of claim.supporting_papers || []) {
      addEdge(graph.edges, graphEdge(`paper:${slugifyFragment(paperTitle)}`, claim.claim_id, RELATIONS.SUGGESTS));
    }
  }

  for (const item of hypothesis.structured_hypothesis_components?.mechanisms || []) {
    addNode(graph.nodes, { ...item, layer: "research-reasoning" });
    addEdge(graph.edges, graphEdge(item.node_id, hypothesisNodeId, RELATIONS.MEDIATES));
  }
  for (const item of hypothesis.structured_hypothesis_components?.moderators || []) {
    const contextNodeId = item.node_id.replace(/^moderator:/, "context:");
    addNode(graph.nodes, graphNode(contextNodeId, "context", item.label, { layer: "research-reasoning" }));
    addEdge(graph.edges, graphEdge(contextNodeId, hypothesisNodeId, RELATIONS.MODERATES));
  }
  for (const item of hypothesis.structured_hypothesis_components?.confounders || []) {
    addNode(graph.nodes, { ...item, layer: "research-reasoning" });
    addEdge(graph.edges, graphEdge(item.node_id, hypothesisNodeId, RELATIONS.CONFOUNDS));
  }
  for (const item of hypothesis.structured_hypothesis_components?.rival_explanations || []) {
    addNode(graph.nodes, { ...item, layer: "research-reasoning" });
    addEdge(graph.edges, graphEdge(item.node_id, hypothesisNodeId, RELATIONS.COMPETES_WITH));
  }
  for (const test of hypothesis.structured_hypothesis_components?.falsification_tests || []) {
    addNode(graph.nodes, graphNode(test.test_id, "test", test.label, {
      layer: "research-reasoning",
      kind: test.kind || "validation_step",
    }));
    addEdge(graph.edges, graphEdge(hypothesisNodeId, test.test_id, RELATIONS.REQUIRES_TEST));
  }

  graph.node_count = graph.nodes.length;
  graph.edge_count = graph.edges.length;
  return graph;
}

module.exports = {
  buildHypothesisNode,
  inferCondition,
  paperSignalProfile,
  deriveConfounders,
  deriveRivalExplanations,
  graphMerge,
  aggregateLiteratureGraphs,
  buildLiteratureGraph,
  buildScoreBundle,
  buildStructuredClaims,
  buildResearchReasoningGraph,
};
