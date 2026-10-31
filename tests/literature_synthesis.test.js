"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { synthesizeCycleLiterature } = require("../src/agents/chronicle/literature_synthesis");
const { POLICY_VERSION, hash, paperIdentity } = require("../src/policy/literature_screening");

function screenedPaper(paper, objective, { established = false } = {}) {
  const quality = established
    ? {
        eligible: true,
        tracks: ["established_impact"],
        evidence: [{ criterion: "verified_citation_count", value: 250, source: "test", source_url: "https://example.org/metrics", observed_at: "2026-01-01" }],
      }
    : { eligible: true, tracks: ["recent_frontier"], evidence: [{ criterion: "recency", basis: "publication_year" }] };
  const identity = paperIdentity(paper);
  const abstract = paper.abstract;
  return {
    ...paper,
    ...(established
      ? { cited_by_count: 250, citation_count_provenance: { value: 250, source: "test", source_url: "https://example.org/metrics", observed_at: "2026-01-01" } }
      : {}),
    literature_screening: {
      status: "accepted",
      policy_version: POLICY_VERSION,
      context_hash: hash(`test-context:${objective}`),
      objective_hash: hash(objective),
      quality,
      review: {
        paper_id: identity,
        objective_hash: hash(objective),
        abstract_sha256: hash(abstract),
        abstract_read_in_full: true,
        reviewer: { kind: "codex_cli", identity: "gpt-6-luna" },
        reviewed_at: "2026-01-01T00:00:00Z",
        decision: "directly_relevant",
        // Per paper: a reason reused word-for-word across papers is now read as
        // a template, which is what all 252 of v90's accepted reviews were.
        direct_relevance_reason: `The abstract of "${paper.title}" addresses the stated objective and reports its measured outcome.`,
        // A quote and three distinct passages, not the abstract pasted four
        // times: `abstract.includes(quote)` is free when the quote IS the
        // abstract, which is how a rendering corpus admitted an EEG paper.
        supporting_passage: abstractQuote(abstract, 0, 20),
        linkage: {
          study_task: { abstract_evidence: abstractQuote(abstract, 0), objective_link: "The abstract describes the task addressed by the research objective." },
          method: { abstract_evidence: abstractQuote(abstract, 1), objective_link: "The abstract names the method used to study the objective." },
          outcome: { abstract_evidence: abstractQuote(abstract, 2), objective_link: "The abstract reports an outcome relevant to the objective." },
        },
        limitations: "The abstract alone does not establish generalization beyond the reported study setting.",
      },
    },
  };
}

/**
 * A fragment actually inside `abstract`: long enough for the gate's minimum,
 * short enough that it is a quote rather than the document. `minChars` is 20 for
 * the supporting passage and 12 for a linkage passage, matching the gate.
 */
function abstractQuote(abstract, index, minChars = 12) {
  const text = String(abstract || "").replace(/\s+/gu, " ").trim();
  // As much as the gate allows, because downstream consumers read these
  // passages as the evidence text: a minimal quote starves them.
  const span = Math.max(minChars, Math.floor(text.length * 0.45));
  const stride = Math.max(1, Math.floor((text.length - span) / 3));
  let start = Math.min(index * stride, Math.max(0, text.length - span));
  // Step off a leading space: the gate trims before measuring, so a fragment
  // that starts with one loses a character and can fall under the minimum.
  while (start > 0 && start < text.length && text[start] === " ") start -= 1;
  const end = Math.min(text.length, start + span);
  return text.slice(start, end).trim();
}

function withScholarlyLookupDisabled(fn) {
  const previous = process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = "0";
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
    } else {
      process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = previous;
    }
  }
}

test("literature synthesis materializes a PaperOrchestra-inspired writing loop", () => {
  withScholarlyLookupDisabled(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lit-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-lit-0001";
  const laneDir = path.join(root, "lanes", cycleId, "scout-001");
  ensureDir(laneDir);

  writeJson(path.join(laneDir, "result.json"), {
    driver: "literature-search-driver",
    role: "scout",
    role_plan: {
      objective: "Clarify how immunization coverage relates to child survival across regions.",
      search_queries: [
        "dtp3 coverage neonatal mortality confounding mechanisms",
        "immunization coverage life expectancy ecological study",
      ],
      candidate_primary_families: [
        {
          family: "routine_immunization",
          label: "Routine immunization",
          members: ["vaccination coverage", "immunization coverage"],
          support_count: 2,
          mechanisms: ["delivery-system constraints"],
        },
      ],
      candidate_outcomes: [
        {
          id: "child_survival",
          label: "Child survival",
          concepts: ["survival", "mortality"],
        },
      ],
    },
    discovered_queries: [
      "regional heterogeneity vaccination mortality",
      "measurement quality immunization coverage",
    ],
    papers: [
      {
        title: "Immunization Coverage and Child Survival in Multi-Country Panels",
        year: 2024,
        doi: "10.1000/example-1",
        abstract: "Vaccination coverage is associated with lower neonatal mortality and stronger survival in lower-coverage settings across regions.",
        authors: ["A. Author", "B. Author"],
      },
      {
        title: "Regional Heterogeneity in Routine Immunization and Mortality",
        year: 2023,
        abstract: "Regional inequality and delivery-system constraints moderate the relationship between immunization coverage and neonatal outcomes.",
        url: "https://example.org/paper-2",
      },
      {
        title: "Measurement Quality in Administrative Coverage Estimates",
        year: 2022,
        abstract: "Administrative coverage estimates are vulnerable to surveillance quality and reporting structure, requiring robustness checks.",
      },
    ].map((paper) => screenedPaper(paper, "Clarify how immunization coverage relates to child survival across regions.", {
      established: paper.year <= 2022,
    })),
  });

  const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "document" });
  assert.ok(output.outputPath.endsWith("-lab-director-literature.json"));
  assert.equal(output.summary.lane_count, 1);
  assert.equal(output.summary.writing_loop.mode, "paper_orchestra_inspired");
  assert.ok(output.summary.writing_loop.summary.section_count >= 3);
  assert.ok(output.summary.writing_loop.summary.verified_citation_count >= 1);
  assert.equal(output.summary.writing_loop.venue_profile.profile_id, "general_research");
  assert.ok(Array.isArray(output.summary.writing_loop.section_outline));
  assert.ok(Array.isArray(output.summary.writing_loop.evidence_matrix));
  assert.ok(Array.isArray(output.summary.writing_loop.novelty_packets));
  assert.ok(output.summary.writing_loop.novelty_packets.length >= 1);
  assert.ok(Number(output.summary.writing_loop.summary.paper_count || 0) >= 3);
  assert.ok(Number(output.summary.writing_loop.summary.targeted_query_count || 0) >= 2);
  assert.ok(Array.isArray(output.summary.lanes[0].writing_loop.section_packets));
  assert.ok(output.summary.lanes[0].writing_loop.section_packets.length >= 3);
  assert.ok(Array.isArray(output.summary.lanes[0].writing_loop.revision_queue));
  const literatureSummaryPath = path.join(root, "state", `${cycleId}-literature-summary.json`);
  const literatureGraphPath = path.join(root, "state", `${cycleId}-literature-graph.json`);
  const dataGraphPath = path.join(root, "state", `${cycleId}-data-graph.json`);
  const trendSummaryPath = path.join(root, "state", `${cycleId}-trend-summary.json`);
  assert.ok(fs.existsSync(literatureSummaryPath));
  assert.ok(fs.existsSync(literatureGraphPath));
  assert.ok(fs.existsSync(dataGraphPath));
  assert.ok(fs.existsSync(trendSummaryPath));
  const literatureGraph = JSON.parse(fs.readFileSync(literatureGraphPath, "utf8"));
  const dataGraph = JSON.parse(fs.readFileSync(dataGraphPath, "utf8"));
  const trendSummary = JSON.parse(fs.readFileSync(trendSummaryPath, "utf8"));
  assert.equal(literatureGraph.graph_type, "literature-knowledge-graph");
  assert.ok(Number(literatureGraph.node_count || 0) > 0);
  assert.equal(dataGraph.graph_type, "data-knowledge-graph");
  assert.ok(Array.isArray(dataGraph.nodes));
  assert.ok(dataGraph.nodes.length > 0);
  assert.ok(Array.isArray(trendSummary.cluster_labels));
  assert.ok(trendSummary.cluster_labels.length > 0);
  assert.equal(output.summary.state_artifacts.data_graph_preserved, false);

  fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test("literature synthesis preserves an existing non-empty state data graph", () => {
  withScholarlyLookupDisabled(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lit-preserve-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-lit-preserve-0001";
  const laneDir = path.join(root, "lanes", cycleId, "scout-001");
  const stateDir = path.join(root, "state");
  ensureDir(laneDir);
  ensureDir(stateDir);

  const existingDataGraph = {
    graph_type: "validated-data-graph",
    nodes: [{ id: "dataset:existing", type: "dataset", label: "Existing dataset" }],
    edges: [],
  };
  writeJson(path.join(stateDir, `${cycleId}-data-graph.json`), existingDataGraph);
  writeJson(path.join(laneDir, "result.json"), {
    driver: "literature-search-driver",
    role: "scout",
    role_plan: {
      objective: "Clarify how coverage relates to survival evidence.",
      search_queries: ["coverage survival literature"],
    },
    papers: [
      screenedPaper({
        title: "Coverage Survival Evidence",
        year: 2024,
        abstract: "Coverage and survival evidence for synthesis.",
      }, "Clarify how coverage relates to survival evidence."),
    ],
  });

  const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
  const dataGraph = JSON.parse(fs.readFileSync(path.join(stateDir, `${cycleId}-data-graph.json`), "utf8"));
  assert.equal(output.summary.state_artifacts.data_graph_preserved, true);
  assert.equal(dataGraph.graph_type, "validated-data-graph");
  assert.deepEqual(dataGraph.nodes, existingDataGraph.nodes);

  fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test("literature synthesis limits writing-loop outputs during evidence stage", () => {
  withScholarlyLookupDisabled(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lit-evidence-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-lit-evidence-0001";
  const laneDir = path.join(root, "lanes", cycleId, "scout-001");
  ensureDir(laneDir);

  writeJson(path.join(laneDir, "result.json"), {
    driver: "literature-search-driver",
    role: "scout",
    role_plan: {
      search_queries: ["dtp3 coverage evidence stage query"],
    },
    papers: [
      {
        title: "Evidence Stage Coverage",
        year: 2024,
        doi: "10.1000/example-evidence",
        abstract: "Coverage evidence available for early synthesis.",
      },
    ],
  });

  const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
  assert.ok(Array.isArray(output.summary.writing_loop.section_outline));
  assert.equal(output.summary.writing_loop.section_outline.length >= 1, true);
  assert.deepEqual(output.summary.writing_loop.evidence_matrix, []);
  assert.deepEqual(output.summary.writing_loop.section_packets, []);
  assert.deepEqual(output.summary.writing_loop.novelty_packets, []);
  assert.deepEqual(output.summary.writing_loop.revision_queue, []);
  assert.deepEqual(output.summary.lanes[0].writing_loop.section_packets, []);

  fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test("citation verification tracks stronger metadata consistency signals", () => {
  withScholarlyLookupDisabled(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lit-verify-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-lit-verify-0001";
  const laneDir = path.join(root, "lanes", cycleId, "scout-001");
  ensureDir(laneDir);

  writeJson(path.join(laneDir, "result.json"), {
    driver: "literature-search-driver",
    role: "scout",
    role_plan: {
      objective: "Verify metadata consistency for coverage and survival evidence.",
      search_queries: ["dtp3 coverage life expectancy peer reviewed evidence"],
    },
    papers: [
      screenedPaper({
        title: "Trusted Coverage and Survival Evidence",
        year: 2024,
        doi: "10.1000/example-verified",
        venue: "The Lancet",
        authors: ["A. Author", "B. Author"],
        abstract: "Coverage links with survival in multi-country panels.",
        source_url: "https://doi.org/10.1000/example-verified",
      }, "Verify metadata consistency for coverage and survival evidence."),
      screenedPaper({
        title: "Weak Metadata Example",
        year: new Date().getUTCFullYear(),
        abstract: "Sparse metadata only.",
      }, "Verify metadata consistency for coverage and survival evidence."),
    ],
  });

  const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
  const ledger = output.summary.writing_loop.citation_ledger;
  const strong = ledger.find((item) => item.title === "Trusted Coverage and Survival Evidence");
  const weak = ledger.find((item) => item.title === "Weak Metadata Example");

  assert.equal(output.summary.writing_loop.venue_profile.profile_id, "medical_observational");
  assert.equal(strong.verification_status, "verified");
  assert.equal(strong.verification_method, "persistent_identifier_plus_trusted_source");
  assert.ok(Number(strong.metadata_consistency_score || 0) >= 4);
  assert.equal(weak.verification_status, "partial", "screened abstract provenance is not equivalent to verified bibliographic metadata");

  fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test("literature graph preserves abstract-only papers as KG seeds", () => {
  withScholarlyLookupDisabled(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lit-abstract-only-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-lit-abstract-only";
  const laneDir = path.join(root, "lanes", cycleId, "scout-001");
  ensureDir(laneDir);

  writeJson(path.join(laneDir, "result.json"), {
    driver: "literature-search-driver",
    role: "scout",
    role_plan: {
      objective: "Extract mechanism and outcome concepts from the closed article abstract.",
      search_queries: ["closed article mechanism outcome"],
    },
    papers: [
      screenedPaper({
        title: "Closed Article With Abstract Evidence",
        year: 2024,
        pmid: "12345",
        source: "pubmed",
        open_access: false,
        full_text_status: "abstract_only",
        kg_seed_basis: "abstract",
        abstract: "Mechanism and outcome terms are sufficient for concept extraction and graph support.",
      }, "Extract mechanism and outcome concepts from the closed article abstract."),
    ],
  });

  synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
  const literatureGraph = JSON.parse(fs.readFileSync(path.join(root, "state", `${cycleId}-literature-graph.json`), "utf8"));
  const paperNode = literatureGraph.nodes.find((node) => node.type === "paper");
  assert.ok(paperNode);
  assert.equal(paperNode.full_text_status, "abstract_only");
  assert.equal(paperNode.kg_seed_basis, "abstract");
  assert.equal(paperNode.open_access, false);
  assert.equal(paperNode.abstract_available, true);
  assert.ok(literatureGraph.edges.some((edge) => edge.source === paperNode.node_id && edge.relation === "supports"));

  fs.rmSync(cwd, { recursive: true, force: true });
  });
});
