"use strict";

const fs = require("fs");
const { screeningEvidenceFields } = require("../../../policy/literature_screening");
const path = require("path");
const { ensureDir } = require("../../../shared/json");
const { topConcepts } = require("./codebook");

function lowerJoined(paper) {
  return `${paper.title || ""} ${paper.abstract || ""}`.toLowerCase();
}

// Themes used to be hand-assembled WHO/health phrasings ("vaccination
// coverage…", "neonatal/child mortality…"). Those leaked health-domain
// language into every cycle's brief regardless of topic. Now we just
// surface the dominant content tokens so chronicle can decide what to
// say in its own words.
function deriveThemes(papers) {
  const tokens = topConcepts(papers, 6);
  if (tokens.length === 0) return [];
  return [
    `Recurring concepts across the retrieved literature: ${tokens.slice(0, 6).join(", ")}.`,
  ];
}

function topTitles(papers, count = 5) {
  return papers.slice(0, count).map((paper) => paper.title).filter(Boolean);
}

function uniqueTitles(papers, count = 8) {
  const seen = new Set();
  const titles = [];
  for (const paper of papers) {
    const title = String(paper.title || "").trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
    if (titles.length >= count) break;
  }
  return titles;
}

function uniqueTopPapers(lanes, count = 8) {
  const byKey = new Map();
  for (const lane of lanes) {
    for (const paper of lane.top_papers || []) {
      const key = String(paper.doi || paper.title || "").toLowerCase();
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, paper);
    }
  }
  return Array.from(byKey.values()).slice(0, count);
}

function compactString(value, maxChars = 1200) {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
}

function compactStructuredValue(value, options = {}) {
  const maxArray = Number(options.maxArray || 12);
  const maxString = Number(options.maxString || 1200);
  const maxDepth = Number(options.maxDepth || 4);
  const depth = Number(options.depth || 0);
  if (typeof value === "string") return compactString(value, maxString);
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return value.slice(0, maxArray);
    return value.slice(0, maxArray).map((item) =>
      compactStructuredValue(item, {
        ...options,
        depth: depth + 1,
      }),
    );
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= maxDepth) return { _truncated: true };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      compactStructuredValue(item, {
        ...options,
        depth: depth + 1,
      }),
    ]),
  );
}

function compactPaper(paper) {
  if (!paper || typeof paper !== "object") return null;
  return {
    ...screeningEvidenceFields(paper),
    title: paper.title || paper.paper_title || null,
    year: paper.year || paper.publication_year || null,
    doi: paper.doi || paper.DOI || null,
    url: paper.url || paper.source_url || null,
    venue: compactString(paper.venue || paper.journal || "", 160) || null,
    abstract_snippet: compactString(paper.abstract_snippet || paper.abstract || "", 420) || null,
  };
}

function compactGraphForLiteratureSummary(graph, options = {}) {
  if (!graph || typeof graph !== "object") return null;
  const nodeLimit = Number(options.nodeLimit || 80);
  const edgeLimit = Number(options.edgeLimit || 120);
  const hypothesisLimit = Number(options.hypothesisLimit || 40);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const hypotheses = Array.isArray(graph.hypotheses) ? graph.hypotheses : [];
  return {
    graph_type: graph.graph_type || graph.graph_kind || null,
    layer: graph.layer || null,
    node_count: Number(graph.node_count || nodes.length || 0),
    edge_count: Number(graph.edge_count || edges.length || 0),
    claim_count: Number(graph.claim_count || 0),
    analysis_result_count: Number(graph.analysis_result_count || 0),
    nodes: nodes.slice(0, nodeLimit).map((item) => ({
      node_id: item?.node_id || item?.id || null,
      type: item?.type || null,
      label: compactString(item?.label || item?.name || item?.statement || "", 220) || null,
      status: item?.status || null,
      layer: item?.layer || null,
    })),
    edges: edges.slice(0, edgeLimit).map((item) => ({
      source: item?.source || item?.from || null,
      target: item?.target || item?.to || null,
      relation: item?.relation || item?.type || null,
      status: item?.status || null,
      paper_ids: Array.isArray(item?.paper_ids) ? item.paper_ids.slice(0, 6) : undefined,
    })),
    hypotheses: hypotheses.slice(0, hypothesisLimit).map(compactHypothesisForLiteratureSummary),
    compacted: nodes.length > nodeLimit || edges.length > edgeLimit || hypotheses.length > hypothesisLimit,
  };
}

function compactClaimForLiteratureSummary(item) {
  if (!item || typeof item !== "object") return null;
  return {
    claim_id: item.claim_id || item.id || null,
    hypothesis_id: item.hypothesis_id || null,
    statement: compactString(item.statement || item.claim || "", 480) || null,
    status: item.status || null,
    support_count: item.support_count ?? null,
  };
}

function compactHypothesisForLiteratureSummary(item) {
  if (!item || typeof item !== "object") return item;
  return {
    hypothesis_id: item.hypothesis_id || item.id || null,
    statement: compactString(item.statement || "", 900) || null,
    core_claim: compactString(item.core_claim || item.statement || "", 900) || null,
    family: item.family || item.hypothesis_family || null,
    family_root: item.family_root || null,
    primary_exposure: item.primary_exposure || item.x_variable || null,
    x_variable: item.x_variable || null,
    y_variable: item.y_variable || null,
    condition: item.condition || null,
    direction: item.direction || null,
    mechanism: compactString(item.mechanism || "", 360) || null,
    mechanisms: Array.isArray(item.mechanisms) ? item.mechanisms.map((value) => compactString(value, 240)).slice(0, 12) : [],
    mechanism_path: Array.isArray(item.mechanism_path) ? item.mechanism_path.map((value) => compactString(value, 240)).slice(0, 12) : [],
    moderators: Array.isArray(item.moderators) ? item.moderators.map((value) => compactString(value, 240)).slice(0, 12) : [],
    confounders: Array.isArray(item.confounders) ? item.confounders.map((value) => compactString(value, 240)).slice(0, 12) : [],
    rivals: Array.isArray(item.rivals) ? item.rivals.map((value) => compactString(value, 240)).slice(0, 12) : [],
    rival_to: Array.isArray(item.rival_to) ? item.rival_to.slice(0, 12) : [],
    test_plan: Array.isArray(item.test_plan) ? item.test_plan.map((value) => compactString(value, 480)).slice(0, 12) : [],
    validation_plan: Array.isArray(item.validation_plan) ? item.validation_plan.map((value) => compactString(value, 480)).slice(0, 12) : [],
    validation_protocol: compactStructuredValue(item.validation_protocol || null, {
      maxArray: 8,
      maxString: 520,
      maxDepth: 4,
    }),
    support_paths: Array.isArray(item.support_paths) ? item.support_paths.slice(0, 12) : [],
    graph_support: compactStructuredValue(item.graph_support || null, {
      maxArray: 8,
      maxString: 420,
      maxDepth: 4,
    }),
    codebook_grounding: compactStructuredValue(item.codebook_grounding || null, {
      maxArray: 8,
      maxString: 420,
      maxDepth: 4,
    }),
    hypothesis_node: compactStructuredValue(item.hypothesis_node || null, {
      maxArray: 8,
      maxString: 420,
      maxDepth: 4,
    }),
    structured_hypothesis_components: compactStructuredValue(item.structured_hypothesis_components || null, {
      maxArray: 8,
      maxString: 420,
      maxDepth: 4,
    }),
    claims: Array.isArray(item.claims)
      ? item.claims.map(compactClaimForLiteratureSummary).filter(Boolean).slice(0, 12)
      : [],
    paper_support: Array.isArray(item.paper_support)
      ? item.paper_support.map((value) => compactStructuredValue(value, {
          maxArray: 6,
          maxString: 360,
          maxDepth: 3,
        })).slice(0, 12)
      : [],
    rationale: compactString(item.rationale || "", 700) || null,
    source_graph: item.source_graph || null,
    falsification_rule: compactString(item.falsification_rule || "", 520) || null,
    falsification_tests: Array.isArray(item.falsification_tests)
      ? item.falsification_tests.map((value) => compactStructuredValue(value, {
          maxArray: 6,
          maxString: 360,
          maxDepth: 3,
        })).slice(0, 12)
      : [],
    schema_version: item.schema_version || null,
    required_output_complete: Boolean(item.required_output_complete),
    expected_impact: item.expected_impact ?? null,
    verifiability: item.verifiability ?? null,
    structural_novelty: item.structural_novelty ?? null,
    total_score: item.total_score ?? null,
  };
}

function compactWritingLoopForLiteratureSummary(loop, options = {}) {
  if (!loop || typeof loop !== "object") return loop || null;
  const sectionLimit = Number(options.sectionLimit || 10);
  const evidenceLimit = Number(options.evidenceLimit || 24);
  const packetLimit = Number(options.packetLimit || 10);
  const citationLimit = Number(options.citationLimit || 24);
  return {
    mode: loop.mode || null,
    summary: loop.summary || null,
    venue_profile: loop.venue_profile || null,
    section_outline: Array.isArray(loop.section_outline)
      ? loop.section_outline.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, sectionLimit)
      : [],
    evidence_matrix: Array.isArray(loop.evidence_matrix)
      ? loop.evidence_matrix.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, evidenceLimit)
      : [],
    novelty_packets: Array.isArray(loop.novelty_packets)
      ? loop.novelty_packets.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, packetLimit)
      : [],
    section_packets: Array.isArray(loop.section_packets)
      ? loop.section_packets.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 520,
          maxDepth: 4,
        })).slice(0, packetLimit)
      : [],
    revision_queue: Array.isArray(loop.revision_queue)
      ? loop.revision_queue.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, packetLimit)
      : [],
    citation_ledger: Array.isArray(loop.citation_ledger)
      ? loop.citation_ledger.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 360,
          maxDepth: 4,
        })).slice(0, citationLimit)
      : [],
    top_papers: Array.isArray(loop.top_papers) ? loop.top_papers.map(compactPaper).filter(Boolean).slice(0, 12) : [],
    verified_citations: Array.isArray(loop.verified_citations)
      ? loop.verified_citations.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 360,
          maxDepth: 4,
        })).slice(0, citationLimit)
      : [],
    compacted:
      (Array.isArray(loop.section_outline) && loop.section_outline.length > sectionLimit) ||
      (Array.isArray(loop.evidence_matrix) && loop.evidence_matrix.length > evidenceLimit) ||
      (Array.isArray(loop.section_packets) && loop.section_packets.length > packetLimit) ||
      (Array.isArray(loop.citation_ledger) && loop.citation_ledger.length > citationLimit),
  };
}

function rolePlanDigest(rolePlan) {
  if (!rolePlan || typeof rolePlan !== "object") return null;
  return {
    objective: compactString(rolePlan.objective || rolePlan.user_prompt || rolePlan.prompt || "", 480) || null,
    query_count: Array.isArray(rolePlan.queries || rolePlan.search_queries)
      ? (rolePlan.queries || rolePlan.search_queries).length
      : 0,
    search_queries: Array.isArray(rolePlan.queries || rolePlan.search_queries)
      ? (rolePlan.queries || rolePlan.search_queries).map((value) => compactString(value, 220)).slice(0, 8)
      : [],
    candidate_primary_family_count: Array.isArray(rolePlan.candidate_primary_families)
      ? rolePlan.candidate_primary_families.length
      : 0,
  };
}

function compactLaneForLiteratureSummary(lane) {
  if (!lane || typeof lane !== "object") return lane;
  return {
    lane_id: lane.lane_id || null,
    synthesis_path: lane.synthesis_path || null,
    source_driver: lane.source_driver || null,
    role: lane.role || null,
    role_plan_digest: rolePlanDigest(lane.role_plan),
    paper_count: Number(lane.paper_count || 0),
    discovered_queries: Array.isArray(lane.discovered_queries)
      ? lane.discovered_queries.map((value) => compactString(value, 220)).slice(0, 12)
      : [],
    hypothesis_scenarios: Array.isArray(lane.hypothesis_scenarios)
      ? lane.hypothesis_scenarios.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, 12)
      : [],
    frontier_catalog_summary: lane.frontier_catalog && typeof lane.frontier_catalog === "object"
      ? {
          family_count: Array.isArray(lane.frontier_catalog.families) ? lane.frontier_catalog.families.length : 0,
          candidate_count: Array.isArray(lane.frontier_catalog.candidates) ? lane.frontier_catalog.candidates.length : 0,
        }
      : null,
    family_nomination: Array.isArray(lane.family_nomination)
      ? lane.family_nomination.map((item) => compactStructuredValue(item, {
          maxArray: 8,
          maxString: 420,
          maxDepth: 4,
        })).slice(0, 20)
      : [],
    family_tournament: compactStructuredValue(lane.family_tournament || null, {
      maxArray: 12,
      maxString: 420,
      maxDepth: 4,
    }),
    data_graph: compactGraphForLiteratureSummary(lane.data_graph, {
      nodeLimit: 50,
      edgeLimit: 80,
      hypothesisLimit: 20,
    }),
    literature_graph: compactGraphForLiteratureSummary(lane.literature_graph, {
      nodeLimit: 50,
      edgeLimit: 80,
      hypothesisLimit: 20,
    }),
    codebook_graph: compactGraphForLiteratureSummary(lane.codebook_graph, {
      nodeLimit: 40,
      edgeLimit: 60,
      hypothesisLimit: 0,
    }),
    hypotheses: Array.isArray(lane.hypotheses)
      ? lane.hypotheses.map(compactHypothesisForLiteratureSummary)
      : [],
    claims: Array.isArray(lane.claims)
      ? lane.claims.map(compactClaimForLiteratureSummary).filter(Boolean).slice(0, 40)
      : [],
    themes: Array.isArray(lane.themes) ? lane.themes.map((value) => compactString(value, 360)).slice(0, 12) : [],
    writing_loop: compactWritingLoopForLiteratureSummary(lane.writing_loop, {
      sectionLimit: 6,
      evidenceLimit: 8,
      packetLimit: 4,
      citationLimit: 8,
    }),
    top_papers: Array.isArray(lane.top_papers) ? lane.top_papers.map(compactPaper).filter(Boolean).slice(0, 8) : [],
    recent_frontier_papers: (lane.recent_frontier_papers || []).slice(0, 8).map(compactPaper),
    established_impact_papers: (lane.established_impact_papers || []).slice(0, 8).map(compactPaper),
    literature_screening: lane.literature_screening || null,
    search_agent_contract: lane.search_agent_contract && typeof lane.search_agent_contract === "object"
      ? {
          applicable: lane.search_agent_contract.applicable === true,
          valid: lane.search_agent_contract.valid === true,
          status: lane.search_agent_contract.status || null,
          decision_ready: lane.search_agent_contract.decision_ready === true,
          gaps: Array.isArray(lane.search_agent_contract.gaps) ? lane.search_agent_contract.gaps.slice(0, 16) : [],
          accepted_evidence_ids: Array.isArray(lane.search_agent_contract.accepted_evidence_ids)
            ? lane.search_agent_contract.accepted_evidence_ids.slice(0, 24)
            : [],
          lineage: lane.search_agent_contract.lineage && typeof lane.search_agent_contract.lineage === "object"
            ? {
                source_lane_id: lane.search_agent_contract.lineage.source_lane_id || null,
                action_type: lane.search_agent_contract.lineage.action_type || null,
                contract_signature: lane.search_agent_contract.lineage.contract_signature || null,
                round_ids: Array.isArray(lane.search_agent_contract.lineage.round_ids)
                  ? lane.search_agent_contract.lineage.round_ids.slice(0, 80)
                  : [],
                round_count: Number(lane.search_agent_contract.lineage.round_count || 0),
              }
            : null,
          source_contract: lane.search_agent_contract.source_contract || null,
        }
      : null,
    summary_compacted: true,
  };
}

function writeJsonCompact(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

// Domain-neutral family-root inference. Trust upstream-provided
// fallback first; otherwise slugify the variable id. Never imposes a
// fixed health-domain taxonomy — the previous version mapped every
// recognisable WHO phrase to one of five fixed roots regardless of
// what the cycle actually researched.

module.exports = {
  lowerJoined,
  deriveThemes,
  topTitles,
  uniqueTitles,
  uniqueTopPapers,
  compactString,
  compactStructuredValue,
  compactPaper,
  compactGraphForLiteratureSummary,
  compactClaimForLiteratureSummary,
  compactHypothesisForLiteratureSummary,
  compactWritingLoopForLiteratureSummary,
  rolePlanDigest,
  compactLaneForLiteratureSummary,
  writeJsonCompact,
};
