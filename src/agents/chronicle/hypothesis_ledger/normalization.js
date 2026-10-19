"use strict";

const fs = require("fs");
const path = require("path");
const { readJson } = require("../../../shared/json");
const { RELATIONS, graphNode, graphEdge, addNode, addEdge, typedId } = require("../graph_schema");
const { cycleStateReader } = require("../../shared/gated_state");

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hypothesisKey(item) {
  return item.hypothesis_id || slugify(item.statement);
}

function statusRank(status) {
  if (status === "robust") return 3;
  if (status === "exploratory") return 2;
  if (status === "weak") return 1;
  return 0;
}

function normalizeLedgerStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "robust" || value === "exploratory" || value === "weak") return value;
  return null;
}

function mergeLedgerStatus(existingStatus, nextStatus, { allowDowngrade = false } = {}) {
  const existing = normalizeLedgerStatus(existingStatus);
  const next = normalizeLedgerStatus(nextStatus);
  if (!existing) return next || "weak";
  if (!next) return existing;
  if (allowDowngrade) return next;
  return statusRank(next) >= statusRank(existing) ? next : existing;
}

function numericScore(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugId(prefix, value, fallback = "item") {
  const fragment = slugify(value || fallback) || fallback;
  return `${prefix}:${fragment}`;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function applyGraphUpdateStates(hypotheses = [], graphDiff = {}) {
  const stateMap = new Map(
    asArray(graphDiff?.updated_hypothesis_states).map((item) => [
      String(item?.target_id || "").replace(/^hypothesis:/, ""),
      String(item?.state || "").trim(),
    ]),
  );
  const evidenceMap = new Map();
  for (const update of asArray(graphDiff?.updates)) {
    if (update?.target_type !== "hypothesis") continue;
    const hypothesisId = String(update?.target_id || "").replace(/^hypothesis:/, "").trim();
    if (!hypothesisId) continue;
    const entry = evidenceMap.get(hypothesisId) || { evidence_ids: [], operations: [] };
    if (update?.evidence_id) entry.evidence_ids.push(String(update.evidence_id));
    if (update?.next_state) entry.operations.push(String(update.next_state));
    evidenceMap.set(hypothesisId, entry);
  }
  return hypotheses.map((item) => {
    const graphUpdateState = stateMap.get(String(item?.hypothesis_id || "").trim()) || null;
    const graphUpdateInfo = evidenceMap.get(String(item?.hypothesis_id || "").trim()) || null;
    return {
      ...item,
      graph_update_state: graphUpdateState,
      graph_update_evidence_ids: graphUpdateInfo ? Array.from(new Set(graphUpdateInfo.evidence_ids)) : [],
      graph_update_operations: graphUpdateInfo ? Array.from(new Set(graphUpdateInfo.operations)) : [],
    };
  });
}

function normalizeMechanisms(item) {
  return asArray(item?.mechanisms || item?.mechanism).map((value) => String(value));
}

function normalizeModerators(item) {
  return asArray(item?.moderators || item?.condition).map((value) => String(value));
}

function normalizeConfounders(item) {
  return asArray(item?.confounders).map((value) => String(value));
}

function normalizeRivals(item) {
  return asArray(item?.rival_explanations || item?.rivals).map((value) => String(value));
}

function normalizeFalsificationTests(item) {
  const explicit = asArray(item?.falsification_tests)
    .map((test) => {
      if (!test) return null;
      if (typeof test === "string") {
        return {
          test_id: typedId("test", test),
          type: "falsification_test",
          kind: "rule",
          label: test,
        };
      }
      const label = test.label || test.statement || test.name;
      if (!label) return null;
      return {
        test_id: test.test_id || typedId("test", label),
        type: "falsification_test",
        kind: test.kind || "validation_step",
        label: String(label),
      };
    })
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const fallback = [];
  if (item?.falsification_rule) {
    fallback.push({
      test_id: typedId("test", item.falsification_rule),
      type: "falsification_test",
      kind: "rule",
      label: String(item.falsification_rule),
    });
  }
  for (const step of asArray(item?.validation_plan)) {
    fallback.push({
      test_id: typedId("test", step),
      type: "falsification_test",
      kind: "validation_step",
      label: String(step),
    });
  }
  return fallback;
}

// Domain-neutral family-root inference. Trusts upstream-provided
// ``family_root`` first, then ``family`` / ``hypothesis_family``, then
// derives a slug from the primary exposure variable. Never imposes a
// fixed taxonomy — the ledger is supposed to track whatever family
// vocabulary the current cycle's lab-director / analyst chose, not a
// template carried over from any prior domain.
function inferFamilyRoot(item) {
  const explicit = String(item?.family_root || "").trim();
  if (explicit) return explicit;
  const familyHint = String(item?.family || item?.hypothesis_family || "").trim();
  if (familyHint) return familyHint;
  const variable = String(item?.x_variable || item?.primary_exposure || "").trim();
  if (variable) {
    return variable.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  return "unclassified_family";
}

function readGateReview(root, cycleId) {
  const gateReviewPath = path.join(root, "state", `${cycleId}-gate-review.json`);
  if (!fs.existsSync(gateReviewPath)) return null;
  return cycleStateReader({ root, cycleId, task: "hypothesis_ledger_normalization" })
    .path(gateReviewPath, "gate-review");
}

function readCycleLiterature(root, cycleId) {
  const literaturePath = path.join(root, "plans", `${cycleId}-lab-director-literature.json`);
  if (!fs.existsSync(literaturePath)) return null;
  return readJson(literaturePath);
}

function familyChallengeSummary(gateReview) {
  const summary = new Map();
  const reviews = Array.isArray(gateReview?.gatekeeper_reviews) ? gateReview.gatekeeper_reviews : [];
  const topLevelCrossFamily = Array.isArray(gateReview?.cross_family_alternatives) ? gateReview.cross_family_alternatives : [];
  for (const item of reviews) {
    const objections = [
      ...(Array.isArray(item?.major_objections) ? item.major_objections : []),
      ...(Array.isArray(item?.switch_triggers) ? item.switch_triggers : []),
      ...(Array.isArray(item?.incumbent_rejection_reasons) ? item.incumbent_rejection_reasons : []),
    ];
    const sameFamily = Array.isArray(item?.same_family_alternatives) ? item.same_family_alternatives : [];
    const crossFamily = Array.isArray(item?.cross_family_alternatives) ? item.cross_family_alternatives : [];
    for (const alt of crossFamily) {
      const root = String(alt?.family_root || "").trim();
      if (!root) continue;
      if (!summary.has(root)) summary.set(root, { objections: 0, cross_family_support: 0, same_family_only: false });
      summary.get(root).cross_family_support += 1;
    }
    // Apply objections to whichever families the gate review actually
    // named as `incumbent`. Previously this attributed objections to a
    // hard-coded "immunization_coverage" root regardless of cycle
    // domain — that pinned every cycle's challenger arithmetic to one
    // domain. Now we read the named incumbent(s), if any.
    const incumbentRoots = Array.isArray(item?.incumbent_family_roots)
      ? item.incumbent_family_roots.map((root) => String(root || "").trim()).filter(Boolean)
      : [];
    for (const root of incumbentRoots) {
      if (!summary.has(root)) summary.set(root, { objections: 0, cross_family_support: 0, same_family_only: false });
      summary.get(root).objections += objections.length;
      if (sameFamily.length > 0 && crossFamily.length === 0) summary.get(root).same_family_only = true;
    }
  }
  for (const alt of topLevelCrossFamily) {
    const root = String(alt?.family_root || "").trim();
    if (!root) continue;
    if (!summary.has(root)) summary.set(root, { objections: 0, cross_family_support: 0, same_family_only: false });
    summary.get(root).cross_family_support += 1;
  }
  return summary;
}

function familyFocusPriority(item, familyCounts) {
  const stateOrder = {
    provisionally_promoted: 0,
    challenged: 1,
    contending: 2,
    candidate: 3,
    demoted: 4,
    retired: 5,
  };
  const familyRoot = item.family_root || "unclassified_family";
  const familyCount = Number(familyCounts.get(familyRoot) || 0);
  const statement = String(item.statement || "").toLowerCase();
  const condition = String(item.condition || "").toLowerCase();
  const primaryPackage =
    statement.includes("may explain cross-country variation") ||
    statement.includes("rival dag rooted");
  const scenarioLike =
    statement.includes("stronger primary family") ||
    statement.includes("better than the current mean exposure") ||
    statement.includes("leading causal families");
  const repetitiveRobustness =
    condition.includes("region exclusion sensitivity") ||
    statement.includes("remain directionally stable even when") ||
    statement.includes("region and year adjustment");
  const evidenceCounts = item.evidence_counts || {};
  const dataEvidenceCount = Number(evidenceCounts.data || 0);
  const literatureOnlyBlocked =
    dataEvidenceCount <= 0 &&
    Array.isArray(item.unresolved_gaps) &&
    item.unresolved_gaps.includes("literature_only_no_data_test");
  const hasExecutableData =
    dataEvidenceCount > 0 ||
    (Array.isArray(item.source_graphs) && item.source_graphs.includes("data")) ||
    item.kind === "data" ||
    item.kind === "mixed";

  let score = 0;
  score -= (stateOrder[item.state] ?? 9) * 1000;
  score += Number(item.promotion_readiness_score || 0) * 8;
  score += Number(item.hypothesis_score || 0) * 4;
  score += Number(item.evidence_quality_score || 0) * 2;
  score += statusRank(item.latest_status) * 25;
  score += Number(item.support_count || 0) * 6;
  if (hasExecutableData) score += 800;
  if (literatureOnlyBlocked) score -= 2500;
  if (primaryPackage) score += 180;
  if (scenarioLike) score += 90;
  if (familyCount > 1) score -= Math.min(120, (familyCount - 1) * 10);
  if (repetitiveRobustness) score -= 140;
  return score;
}

function selectFocusHypotheses(hypotheses, limit = 6) {
  const active = Array.isArray(hypotheses)
    ? hypotheses.filter((item) => item.state !== "retired")
    : [];
  const familyCounts = active.reduce((map, item) => {
    const root = item.family_root || "unclassified_family";
    map.set(root, (map.get(root) || 0) + 1);
    return map;
  }, new Map());
  const ranked = active
    .map((item) => ({ item, focus_priority: familyFocusPriority(item, familyCounts) }))
    .sort((a, b) =>
      b.focus_priority - a.focus_priority ||
      (b.item.hypothesis_score || 0) - (a.item.hypothesis_score || 0) ||
      (b.item.evidence_quality_score || 0) - (a.item.evidence_quality_score || 0),
    );

  const selected = [];
  const seenIds = new Set();
  const seenFamilies = new Set();

  for (const entry of ranked) {
    const familyRoot = entry.item.family_root || "unclassified_family";
    const id = entry.item.hypothesis_id || entry.item.statement;
    if (seenIds.has(id) || seenFamilies.has(familyRoot)) continue;
    selected.push(entry.item);
    seenIds.add(id);
    seenFamilies.add(familyRoot);
    if (selected.length >= limit) return selected;
  }

  for (const entry of ranked) {
    const id = entry.item.hypothesis_id || entry.item.statement;
    if (seenIds.has(id)) continue;
    selected.push(entry.item);
    seenIds.add(id);
    if (selected.length >= limit) break;
  }

  return selected;
}

function structuredHypothesisComponents(item) {
  return {
    mechanisms: normalizeMechanisms(item).map((label) => ({
      node_id: typedId("mechanism", label),
      type: "mechanism",
      label,
    })),
    moderators: normalizeModerators(item).map((label) => ({
      node_id: typedId("moderator", label),
      type: "moderator",
      label,
    })),
    confounders: normalizeConfounders(item).map((label) => ({
      node_id: typedId("confounder", label),
      type: "confounder",
      label,
    })),
    rival_explanations: normalizeRivals(item).map((label) => ({
      node_id: typedId("rival", label),
      type: "rival_explanation",
      label,
    })),
    falsification_tests: normalizeFalsificationTests(item),
  };
}

function normalizeClaims(item) {
  const explicit = asArray(item?.claims)
    .map((claim, index) => {
      if (!claim) return null;
      if (typeof claim === "string") {
        return {
          claim_id: typedId("claim", claim),
          statement: claim,
          status: "candidate",
        };
      }
      const statement = claim.statement || claim.claim || item?.statement;
      if (!statement) return null;
      return {
        claim_id: claim.claim_id || typedId("claim", `${statement}-${index + 1}`),
        statement,
        rationale: claim.rationale || null,
        x_variable: claim.x_variable || item?.x_variable || null,
        y_variable: claim.y_variable || item?.y_variable || null,
        context: claim.context || item?.condition || null,
        direction: claim.direction || item?.direction || "unknown",
        supporting_papers: asArray(claim.supporting_papers || claim.paper_support).slice(0, 5),
        status: claim.status || "candidate",
      };
    })
    .filter(Boolean);
  if (explicit.length > 0) return explicit;
  if (!item?.statement) return [];
  return [
    {
      claim_id: typedId("claim", item.statement),
      statement: item.statement,
      rationale: item.rationale || null,
      x_variable: item.x_variable || null,
      y_variable: item.y_variable || null,
      context: item.condition || null,
      direction: item.direction || "unknown",
      supporting_papers: asArray(item.paper_support).slice(0, 5),
      status: "candidate",
    },
  ];
}

function synthesizeAnalysisResults(item, laneId, rolePlan = {}) {
  const evidence = item?.evidence && typeof item.evidence === "object" ? item.evidence : {};
  const metrics = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics.push({ metric: key, value });
    }
  }
  if (metrics.length === 0 && !laneId) return [];
  const statement = item?.statement || item?.hypothesis_id || laneId || "analysis";
  return [
    {
      analysis_result_id: typedId("analysis", `${laneId || "lane"}-${statement}`),
      lane_id: laneId || null,
      role: rolePlan.role || null,
      family: item?.family || null,
      outcome: item?.outcome || item?.y_variable || null,
      metrics,
      status: item?.status || "unknown",
    },
  ];
}

function buildUnresolvedGaps(entry) {
  const gaps = [];
  if (!Array.isArray(entry.claims) || entry.claims.length === 0) gaps.push("missing_structured_claim");
  if (!entry.x_variable || !entry.y_variable) gaps.push("missing_variable_pair");
  if (!entry.mechanism && (!entry.mechanisms || entry.mechanisms.length === 0)) gaps.push("missing_mechanism");
  if (!Array.isArray(entry.falsification_tests) || entry.falsification_tests.length === 0) {
    gaps.push("missing_falsification_test");
  }
  if ((entry.source_graphs || []).includes("literature") && !(entry.source_graphs || []).includes("data")) {
    gaps.push("literature_only_no_data_test");
  }
  if ((entry.source_graphs || []).includes("data") && (entry.bridge_edges || []).length === 0) {
    gaps.push("data_without_literature_alignment");
  }
  if ((entry.analysis_results || []).length === 0 && (entry.source_graphs || []).includes("data")) {
    gaps.push("missing_analysis_result");
  }
  return gaps;
}

function synthesizeValidationProtocol(item) {
  return {
    dataset: "cycle-data-graph",
    model: item.family === "adjusted-signal"
      ? "unit-time adjusted correlation model"
      : item.family === "unit-change"
        ? "unit change correlation model"
        : item.family === "partition-and-threshold"
          ? "threshold comparison model"
          : "pooled or stratified correlation model",
    comparison: item.condition ? `conditional comparison under ${item.condition}` : "pooled baseline comparison",
    acceptance_criterion: `${item.x_variable || "x"} remains directionally consistent for ${item.y_variable || "y"} in the designated validation checks.`,
  };
}

function synthesizeCodebookGrounding(item) {
  if (!item?.x_variable && !item?.y_variable) return null;
  return {
    x_variable: item.x_variable
      ? {
          variable_id: item.x_variable,
          dataset_id: "cycle-data-graph",
        }
      : null,
    y_variable: item.y_variable
      ? {
          variable_id: item.y_variable,
          dataset_id: "cycle-data-graph",
        }
      : null,
    condition_variable: item.condition || null,
  };
}

function synthesizeHypothesisNode(item) {
  return {
    node_id: `hypothesis:${item.hypothesis_id || hypothesisKey(item)}`,
    type: "hypothesis",
    layer: "hypothesis",
    statement: item.statement || null,
    status: item.status || item.latest_status || "candidate",
  };
}

function synthesizeGraphSupport(item, sourceGraph) {
  if (!item?.x_variable || !item?.y_variable) return null;
  const hypothesisId = item.hypothesis_id || hypothesisKey(item);
  const nodes = [];
  const edges = [];
  const hypothesisNodeId = `hypothesis:${hypothesisId}`;

  addNode(nodes, graphNode(`variable:${item.x_variable}`, "variable", item.x_variable, { layer: sourceGraph }));
  addNode(nodes, graphNode(`variable:${item.y_variable}`, "variable", item.y_variable, { layer: sourceGraph }));
  addNode(nodes, graphNode(hypothesisNodeId, "hypothesis", item.statement || hypothesisId, {
    layer: "hypothesis",
    status: item.status || item.latest_status || "candidate",
  }));
  addEdge(edges, graphEdge(`variable:${item.x_variable}`, hypothesisNodeId, RELATIONS.FROM_X));
  addEdge(edges, graphEdge(hypothesisNodeId, `variable:${item.y_variable}`, RELATIONS.TO_Y));

  const components = item.structured_hypothesis_components || structuredHypothesisComponents(item);
  for (const node of components.moderators || []) {
    addNode(nodes, { ...node, layer: sourceGraph });
    addEdge(edges, graphEdge(node.node_id, hypothesisNodeId, RELATIONS.MODERATES));
  }
  for (const node of components.mechanisms || []) {
    addNode(nodes, { ...node, layer: "hypothesis" });
    addEdge(edges, graphEdge(node.node_id, hypothesisNodeId, RELATIONS.MEDIATES));
  }
  for (const node of components.confounders || []) {
    addNode(nodes, { ...node, layer: "hypothesis" });
    addEdge(edges, graphEdge(node.node_id, hypothesisNodeId, RELATIONS.CONFOUNDS));
  }
  for (const node of components.rival_explanations || []) {
    addNode(nodes, { ...node, layer: "hypothesis" });
    addEdge(edges, graphEdge(node.node_id, hypothesisNodeId, RELATIONS.COMPETES_WITH));
  }
  for (const test of components.falsification_tests || []) {
    addNode(nodes, graphNode(test.test_id, test.type || "falsification_test", test.label, {
      layer: "hypothesis",
      kind: test.kind || "validation_step",
    }));
    addEdge(edges, graphEdge(hypothesisNodeId, test.test_id, RELATIONS.REQUIRES_TEST));
  }

  const grounding = synthesizeCodebookGrounding(item);
  if (grounding?.x_variable?.dataset_id) {
    addNode(nodes, graphNode(`dataset:${grounding.x_variable.dataset_id}`, "dataset", grounding.x_variable.dataset_id, { layer: sourceGraph }));
    addEdge(edges, graphEdge(`dataset:${grounding.x_variable.dataset_id}`, `variable:${item.x_variable}`, RELATIONS.OBSERVES));
  }
  if (grounding?.y_variable?.dataset_id) {
    addNode(nodes, graphNode(`dataset:${grounding.y_variable.dataset_id}`, "dataset", grounding.y_variable.dataset_id, { layer: sourceGraph }));
    addEdge(edges, graphEdge(`dataset:${grounding.y_variable.dataset_id}`, `variable:${item.y_variable}`, RELATIONS.OBSERVES));
  }

  return {
    graph_type: `${sourceGraph}-knowledge-graph`,
    layer: sourceGraph,
    graph_layers: [sourceGraph, "hypothesis"],
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
    structured_components: {
      mechanism_count: (components.mechanisms || []).length,
      moderator_count: (components.moderators || []).length,
      confounder_count: (components.confounders || []).length,
      rival_count: (components.rival_explanations || []).length,
      falsification_test_count: (components.falsification_tests || []).length,
    },
  };
}

function requiredOutputComplete(item) {
  return Boolean(
    item?.x_variable &&
    item?.y_variable &&
    item?.condition &&
    item?.direction &&
    item?.mechanism &&
    item?.validation_protocol &&
    item?.falsification_rule
  );
}

function laneRolePlan(root, cycleId, laneId) {
  const rolePlanPath = path.join(root, "lanes", cycleId, laneId, "role-plan.json");
  if (!fs.existsSync(rolePlanPath)) return null;
  return readJson(rolePlanPath);
}

function resultFileMayContainHypotheses(resultPath) {
  const needles = [
    Buffer.from('"selected_hypotheses"'),
    Buffer.from('"hypothesis_results"'),
  ];
  const maxNeedleLength = Math.max(...needles.map((needle) => needle.length));
  let fd = null;
  try {
    fd = fs.openSync(resultPath, "r");
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let carry = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead <= 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      if (needles.some((needle) => chunk.indexOf(needle) >= 0)) return true;
      carry = chunk.subarray(Math.max(0, chunk.length - maxNeedleLength + 1));
      position += bytesRead;
    }
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors in the lightweight pre-scan
      }
    }
  }
  return false;
}

module.exports = {
  slugify,
  hypothesisKey,
  statusRank,
  normalizeLedgerStatus,
  mergeLedgerStatus,
  numericScore,
  slugId,
  asArray,
  applyGraphUpdateStates,
  normalizeMechanisms,
  normalizeModerators,
  normalizeConfounders,
  normalizeRivals,
  normalizeFalsificationTests,
  inferFamilyRoot,
  readGateReview,
  readCycleLiterature,
  familyChallengeSummary,
  familyFocusPriority,
  selectFocusHypotheses,
  structuredHypothesisComponents,
  normalizeClaims,
  synthesizeAnalysisResults,
  buildUnresolvedGaps,
  synthesizeValidationProtocol,
  synthesizeCodebookGrounding,
  synthesizeHypothesisNode,
  synthesizeGraphSupport,
  requiredOutputComplete,
  laneRolePlan,
  resultFileMayContainHypotheses,
};
