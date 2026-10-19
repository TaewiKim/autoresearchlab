"use strict";

const fs = require("fs");
const path = require("path");
const { buildRolePlan } = require("..");
const { runtimeRoot } = require("../../runtime/native_client");
const { buildCanonicalReference } = require("../shared/canonical_reference");
const { admitRecord } = require("../shared/memory_gate");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  // Defensive parse: a partial / truncated JSON file (e.g. an agent
  // crashed mid-write, or an external process saved an empty version)
  // must NOT abort the whole cycle. Returning null lets the caller
  // fall back to its default just like a missing file.
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildDataGraphDigest({ dataGraph, graphUpdateLog, nextCyclePlan }) {
  const edges = Array.isArray(dataGraph?.edges) ? dataGraph.edges : [];
  const updates = Array.isArray(graphUpdateLog?.updates) ? graphUpdateLog.updates : [];
  const prioritized = Array.isArray(nextCyclePlan?.prioritized_families) ? nextCyclePlan.prioritized_families : [];
  const incumbentFamily = nextCyclePlan?.incumbent_family || null;

  const validatedEdges = [];
  const challengedIncumbentEdges = [];
  const rivalFamilyDigest = new Map();

  for (const edge of edges) {
    const metadata = edge?.metadata || {};
    const familyRoot = String(metadata.family_root || "").trim();
    const status = String(edge?.status || "").trim();
    const evidenceStage = String(metadata.evidence_stage || "").trim();
    const item = {
      edge_id: edge?.id || null,
      family_root: familyRoot || null,
      source: edge?.source || edge?.from || null,
      target: edge?.target || edge?.to || null,
      relation: edge?.relation || edge?.type || null,
      status: status || null,
      evidence_stage: evidenceStage || null,
      confidence_tier: metadata.confidence_tier || null,
      evidence_rank: Number(edge?.score?.evidence_rank || 0),
      last_validation_id: metadata.last_validation_id || null,
    };

    if (evidenceStage === "validated") {
      validatedEdges.push(item);
    }
    if (familyRoot && (status === "challenged" || status === "weakened")) {
      const bucket = rivalFamilyDigest.get(familyRoot) || {
        family_root: familyRoot,
        validated_edge_count: 0,
        challenged_edge_count: 0,
        supported_edge_count: 0,
      };
      if (evidenceStage === "validated") bucket.validated_edge_count += 1;
      bucket.challenged_edge_count += 1;
      rivalFamilyDigest.set(familyRoot, bucket);
      if (familyRoot === incumbentFamily) challengedIncumbentEdges.push(item);
    } else if (familyRoot && status === "supported") {
      const bucket = rivalFamilyDigest.get(familyRoot) || {
        family_root: familyRoot,
        validated_edge_count: 0,
        challenged_edge_count: 0,
        supported_edge_count: 0,
      };
      if (evidenceStage === "validated") bucket.validated_edge_count += 1;
      bucket.supported_edge_count += 1;
      rivalFamilyDigest.set(familyRoot, bucket);
    }
  }

  for (const item of prioritized) {
    const familyRoot = String(item?.family_root || "").trim();
    if (!familyRoot) continue;
    const bucket = rivalFamilyDigest.get(familyRoot) || {
      family_root: familyRoot,
      validated_edge_count: 0,
      challenged_edge_count: 0,
      supported_edge_count: 0,
    };
    bucket.priority_action = item?.action || null;
    rivalFamilyDigest.set(familyRoot, bucket);
  }

  const unresolvedDataGaps = updates
    .filter((item) => String(item?.op_scope || "") === "family" || String(item?.op || "").includes("challenge"))
    .slice(0, 12)
    .map((item) => ({
      family_root: item?.family_root || null,
      hypothesis_id: item?.hypothesis_id || null,
      op: item?.op || null,
      rationale: item?.rationale || null,
      validation_type: item?.validation_type || null,
    }));

  validatedEdges.sort((a, b) => b.evidence_rank - a.evidence_rank);
  challengedIncumbentEdges.sort((a, b) => b.evidence_rank - a.evidence_rank);

  return {
    incumbent_family: incumbentFamily,
    validated_edges: validatedEdges.slice(0, 10),
    challenged_incumbent_edges: challengedIncumbentEdges.slice(0, 10),
    rival_family_digest: Array.from(rivalFamilyDigest.values())
      .sort((a, b) =>
        (b.supported_edge_count + b.challenged_edge_count) - (a.supported_edge_count + a.challenged_edge_count) ||
        String(a.family_root || "").localeCompare(String(b.family_root || "")))
      .slice(0, 8),
    unresolved_data_gaps: unresolvedDataGaps,
  };
}

function loadCyclePlanningContext({ cwd = process.cwd(), cycleId }) {
  const root = runtimeRoot(cwd);
  const statePath = (suffix) => path.join(root, "state", `${cycleId}-${suffix}.json`);
  // MBM-Core message-bound read gate: every shared-memory record admitted into
  // the cycle planning context is validated against the active message (this
  // planning read, bound to the cycle) and audited. Records are loaded by a
  // `${cycleId}-...` path, so a cross-run record that somehow carries a foreign
  // cycle_id is denied (fail-closed) with a reason code; legitimate
  // cycle-scoped broadcast context passes the no-constraint checks. Every
  // allow/deny is appended to the per-cycle gate audit log for reconstruction.
  const activeMessage = {
    cycle_id: cycleId,
    lane_id: "lab-director",
    role: "lab-director",
    task: "cycle_planning",
    stage: "evidence",
    scope: "cycle",
  };
  const auditLogPath = path.join(root, "state", `${cycleId}-memory-gate-audit.jsonl`);
  const readGated = (filePath, recordId) =>
    admitRecord(readJsonIfExists(filePath), { activeMessage, auditLogPath, recordId });

  const nextCyclePlan = readGated(path.join(root, "state", `${cycleId}-next-cycle-plan.json`), "next-cycle-plan");
  const dataGraph = readGated(path.join(root, "state", `${cycleId}-data-graph.json`), "data-graph");
  const graphUpdateLog = readGated(path.join(root, "state", `${cycleId}-graph-update-log.json`), "graph-update-log");
  const dataGraphDigest = buildDataGraphDigest({ dataGraph, graphUpdateLog, nextCyclePlan });
  return {
    source_paths: {
      gate_review: statePath("gate-review"),
      conclusion_review: statePath("conclusion-review"),
      approval_review: statePath("approval-review"),
      researcher_view: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
    },
    next_cycle_plan: nextCyclePlan,
    family_package_ledger: readGated(path.join(root, "state", `${cycleId}-family-package-ledger.json`), "family-package-ledger"),
    family_nomination: readGated(path.join(root, "state", `${cycleId}-family-nomination.json`), "family-nomination"),
    validation_results: readGated(path.join(root, "state", `${cycleId}-validation-results.json`), "validation-results"),
    literature_summary: readGated(path.join(root, "state", `${cycleId}-literature-summary.json`), "literature-summary"),
    trend_summary: readGated(path.join(root, "state", `${cycleId}-trend-summary.json`), "trend-summary"),
    research_trend_analysis: readGated(path.join(root, "state", `${cycleId}-research-trend-analysis.json`), "research-trend-analysis"),
    lab_director_literature: readGated(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), "lab-director-literature"),
    literature_graph: readGated(path.join(root, "state", `${cycleId}-literature-graph.json`), "literature-graph"),
    conclusion_review: readGated(path.join(root, "state", `${cycleId}-conclusion-review.json`), "conclusion-review"),
    gate_review: readGated(path.join(root, "state", `${cycleId}-gate-review.json`), "gate-review"),
    report_review: readGated(path.join(root, "state", `${cycleId}-report-review.json`), "report-review"),
    paper_review: readGated(path.join(root, "state", `${cycleId}-paper-review.json`), "paper-review"),
    // The author can name a run that would license a sentence it cannot yet
    // write. The director decides whether the programme takes it; the analyst
    // designs it only after that, so the manuscript never sets the agenda.
    experiment_requests: readGated(path.join(root, "state", `${cycleId}-experiment-requests.json`), "experiment-requests"),
    researcher_view: readGated(path.join(root, "researcher-views", `${cycleId}-researcher-view.json`), "researcher-view"),
    data_graph_digest: dataGraphDigest,
    // Data Foundations layer: pin one canonical reference per cycle here, where
    // the raw graph is already loaded, so every downstream role plan consults
    // the same governed, snapshot-stable registry of datasets/families.
    canonical_reference: buildCanonicalReference({
      dataGraph,
      dataGraphDigest,
      cycleId,
    }),
  };
}

function buildLaneQueryPlan({ cwd = process.cwd(), cycleId, prompt, manifest, researchStage = "evidence" }) {
  const cyclePlanningContext = loadCyclePlanningContext({ cwd, cycleId });
  return manifest.map((lane) => buildRolePlan({
    prompt,
    lane,
    cycleId,
    researchStage,
    cyclePlanningContext,
  }));
}

module.exports = {
  buildLaneQueryPlan,
  loadCyclePlanningContext,
};
