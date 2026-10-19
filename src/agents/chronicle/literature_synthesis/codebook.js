"use strict";

const { RELATIONS, graphNode, graphEdge, addNode, addEdge, slug } = require("../graph_schema");
const { candidatePrimaryFamilies, candidateOutcomes } = require("../../shared/frontier_discovery");

function inferFamilyRootFromVariable(variableId, fallbackFamily = null) {
  const fallback = String(fallbackFamily || "").trim();
  if (fallback) return fallback;
  const value = String(variableId || "").trim();
  if (!value) return "unclassified_family";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    || "unclassified_family";
}

// Rival families used to be a hard-coded WHO list. The actual rivals
// for a hypothesis family are whatever OTHER families the cycle is
// currently weighing — the caller passes those in via *peers*. With
// no peers, rivals is empty.
function rivalFamiliesFor(root, peers = []) {
  if (!Array.isArray(peers)) return [];
  return peers
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== root);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "their", "were", "been", "have",
  "has", "had", "will", "would", "there", "which", "while", "using", "used", "than", "such",
  "these", "those", "about", "across", "within", "under", "between", "among", "global", "study",
  "studies", "analysis", "research", "based", "after", "before", "during", "because", "through",
  "into", "onto", "over", "also", "more", "less", "some", "many", "most", "each", "both", "can",
  "may", "might", "should", "could", "paper", "papers", "evidence", "findings", "result", "results",
]);

// Codebook variables/datasets/methods used to ship as a hand-curated
// WHO-aligned table (DTP3 coverage, neonatal mortality, WHO country-
// year panel, etc.). That made the synthesizer produce health-domain
// hypotheses regardless of cycle topic. The codebook is now derived
// from cycle inputs (rolePlan.candidate_primary_families and the
// retrieved papers) — see ``buildDynamicCodebook`` below. With no
// upstream seeds, the codebook stays empty and the synthesizer
// produces no template hypotheses, deferring to whatever the
// lab-director and analyst lanes emit.
const CODEBOOK_VARIABLES = [];
const CODEBOOK_DATASETS = [];
const CODEBOOK_METHODS = [];

// Build a per-cycle codebook from the role_plan + papers. Each
// candidate_primary_family the rolePlan declares becomes one input
// variable; candidate_outcomes (when present) become outcome variables.
// No fixed taxonomy.
function buildDynamicCodebook(rolePlan = {}, papers = []) {
  const variables = [];
  const seen = new Set();
  // Followup lanes built by the native dispatcher (role_plan_01.rs) carry only
  // focus_* fields, not the candidate_primary_families / candidate_outcomes the
  // initial JS query plan seeds. Without them groundedVariableBundle returns
  // null and ALL structured-hypothesis synthesis is suppressed for every
  // followup lane — which silently caps the cycle at the single data-driven
  // family and stalls novelty (scout_no_candidate_families_stagnation). Fall
  // back to the same domain-neutral, prompt-grounded candidate families and
  // outcomes the initial lanes use so every lane grounds consistently. These
  // are derived from the cycle prompt, not hard-coded domain defaults.
  const promptText = String(
    rolePlan?.prompt || rolePlan?.objective || rolePlan?.followup_description || "",
  ).trim();
  let families = Array.isArray(rolePlan?.candidate_primary_families)
    ? rolePlan.candidate_primary_families
    : [];
  if (families.length === 0 && promptText) {
    families = candidatePrimaryFamilies(promptText);
  }
  for (const family of families) {
    const familyRoot = String(family?.family || family?.family_root || "").trim();
    if (!familyRoot || seen.has(`input:${familyRoot}`)) continue;
    seen.add(`input:${familyRoot}`);
    const label = String(family?.label || familyRoot.replace(/_/g, " "));
    variables.push({
      variable_id: familyRoot,
      label,
      concepts: Array.isArray(family?.members)
        ? family.members.map((item) => String(item).toLowerCase())
        : [familyRoot.replace(/_/g, " ")],
      role: "input",
      dtype: "float",
      unit: "value",
      quantity_type: "metric",
      description: `Primary exposure variable for the ${label} family (cycle-derived).`,
      dataset_id: null,
      method_id: null,
    });
  }
  let outcomes = Array.isArray(rolePlan?.candidate_outcomes)
    ? rolePlan.candidate_outcomes
    : [];
  if (outcomes.length === 0 && promptText) {
    outcomes = candidateOutcomes(promptText);
  }
  for (const outcome of outcomes) {
    const id = String(outcome?.id || outcome?.variable_id || outcome?.label || "").trim();
    if (!id || seen.has(`outcome:${id}`)) continue;
    seen.add(`outcome:${id}`);
    variables.push({
      variable_id: id.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label: String(outcome?.label || id),
      concepts: Array.isArray(outcome?.concepts) ? outcome.concepts : [],
      role: "outcome",
      dtype: outcome?.dtype || "float",
      unit: outcome?.unit || "value",
      quantity_type: outcome?.quantity_type || "metric",
      description: `Cycle-derived outcome variable.`,
      dataset_id: null,
      method_id: null,
    });
  }
  return { variables, datasets: [], methods: [] };
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && !STOPWORDS.has(item));
}

function topConcepts(papers, limit = 8) {
  const counts = new Map();
  for (const paper of papers) {
    const joined = `${paper.title || ""} ${paper.abstract || ""}`;
    for (const token of tokenize(joined)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function conceptBundle(papers, rolePlan) {
  const concepts = topConcepts(papers, 10);
  const queries = Array.isArray(rolePlan?.queries) ? rolePlan.queries : [];
  const queryTokens = topConcepts(
    queries.map((query) => ({ title: query, abstract: "" })),
    6,
  );
  const merged = Array.from(new Set([...concepts, ...queryTokens]));
  return {
    primary: merged[0] || "primary factor",
    secondary: merged[1] || "key outcome",
    tertiary: merged[2] || "contextual condition",
    concepts: merged.slice(0, 8),
  };
}

function groundedVariableBundle(papers, rolePlan) {
  const concepts = conceptBundle(papers, rolePlan).concepts || [];
  const candidateFamilies = Array.isArray(rolePlan?.candidate_primary_families)
    ? rolePlan.candidate_primary_families
    : [];
  const text = [
    ...concepts,
    ...(Array.isArray(rolePlan?.queries) ? rolePlan.queries : []),
    ...(candidateFamilies.flatMap((family) => [
      family.family,
      ...(Array.isArray(family.members) ? family.members : []),
      ...(Array.isArray(family.mechanisms) ? family.mechanisms : []),
    ])),
  ].join(" ").toLowerCase();

  function scoreVariable(candidate) {
    let score = candidate.concepts.reduce(
      (sum, token) => (text.includes(String(token).toLowerCase()) ? sum + 1 : sum),
      0,
    );
    for (const family of candidateFamilies) {
      const familyText = JSON.stringify(family).toLowerCase();
      // Generic match: any variable whose id appears in the family's
      // serialised description gets a bonus. Removes the WHO-specific
      // (variable_id, family.family) coupling that previously hand-
      // routed dtp3_coverage/zero_dose_burden/facility_delivery/etc.
      if (familyText.includes(candidate.variable_id.replaceAll("_", " "))) score += 3;
      if (familyText.includes(String(candidate.variable_id).toLowerCase())) score += 2;
      if (String(family?.family || "").trim() === candidate.variable_id) score += 5;
    }
    return score;
  }

  const dynamic = buildDynamicCodebook(rolePlan, papers).variables;
  const codebook = CODEBOOK_VARIABLES.length > 0 ? CODEBOOK_VARIABLES : dynamic;
  const ranked = codebook.map((item) => ({
    ...item,
    score: scoreVariable(item),
  }));
  const input = ranked
    .filter((item) => item.role === "input")
    .sort((a, b) => b.score - a.score)[0];
  const outcome = ranked
    .filter((item) => item.role === "outcome")
    .sort((a, b) => b.score - a.score)[0];
  const condition = ranked
    .filter((item) => item.role === "condition")
    .sort((a, b) => b.score - a.score)[0];

  // With no upstream-provided variables we have nothing to ground —
  // return null so callers can skip template synthesis rather than
  // fabricating placeholders. The previous version fell through to
  // CODEBOOK_VARIABLES[0/1/4] which were the WHO defaults.
  if (!input || !outcome) return null;

  return {
    x: input,
    x_variable: input.variable_id,
    x_label: input.label,
    y: outcome,
    y_variable: outcome.variable_id,
    y_label: outcome.label,
    z: condition || null,
    z_variable: condition?.variable_id || null,
    z_label: condition?.label || null,
  };
}

function discoverPrimaryFamilyRoots(papers, rolePlan) {
  const candidates = new Map();
  const seeded = Array.isArray(rolePlan?.candidate_primary_families)
    ? rolePlan.candidate_primary_families
    : [];
  for (const item of seeded) {
    const familyRoot = String(item?.family || item?.family_root || "").trim();
    if (!familyRoot) continue;
    candidates.set(familyRoot, {
      family_root: familyRoot,
      support_count: Number(item?.support_count || 0),
      mechanisms: Array.isArray(item?.mechanisms) ? item.mechanisms.slice(0, 4) : [],
    });
  }

  // Earlier this injected five hard-coded WHO heuristic families
  // (immunization_coverage, zero_dose_burden, maternal_newborn_care,
  // equity_gap, measurement_quality) and counted how many WHO-specific
  // tokens the retrieved papers contained — which forced every cycle
  // to either match those families or have no families at all. The
  // domain-neutral version trusts only the families the role_plan
  // actually seeded.
  return Array.from(candidates.values())
    .filter((item) => Number(item.support_count || 0) > 0
      || (Array.isArray(item.mechanisms) && item.mechanisms.length > 0))
    .sort((a, b) => b.support_count - a.support_count || a.family_root.localeCompare(b.family_root));
}

// Look up the canonical input variable for a family root. With a
// dynamic codebook (cycle-derived), the input variable for any
// family root is just the variable whose id matches the root — the
// dynamic builder names them that way. The earlier WHO version
// hard-routed five fixed mappings.
function selectPrimaryVariableForFamily(familyRoot, codebook = CODEBOOK_VARIABLES) {
  if (!familyRoot) return null;
  const variables = Array.isArray(codebook) ? codebook : [];
  return (
    variables.find((item) => item.variable_id === familyRoot && item.role === "input")
    || variables.find((item) => item.variable_id === familyRoot)
    || null
  );
}


function slugifyFragment(value, limit = 64) {
  return slug(value).slice(0, limit);
}

function dynamicHypothesisId(statement, prefix = "hyp") {
  return `${prefix}-${slugifyFragment(statement)}`;
}

function clampScore(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function buildCodebookGraph(grounded) {
  if (!grounded) {
    return {
      graph_type: "codebook-knowledge-graph",
      layer: "codebook",
      node_count: 0,
      edge_count: 0,
      nodes: [],
      edges: [],
    };
  }
  const variables = [grounded.x, grounded.y, grounded.z].filter(Boolean);
  const variableIds = new Set();
  const methodIds = new Set();
  const unitIds = new Set();
  const datasetIds = new Set();
  const nodes = [];
  const edges = [];

  for (const variable of variables) {
    if (!variable?.variable_id || variableIds.has(variable.variable_id)) continue;
    variableIds.add(variable.variable_id);
    // Default datasetId is "cycle-data-graph" — domain-neutral. The
    // earlier default ("who_country_year_panel") asserted a WHO panel
    // even when the cycle had nothing to do with WHO.
    const datasetId = variable.dataset_id || "cycle-data-graph";
    const unitId = `unit:${slugifyFragment(variable.unit || "unitless")}`;
    const methodId = variable.method_id || "codebook-method";
    datasetIds.add(datasetId);
    methodIds.add(methodId);
    unitIds.add(unitId);

    addNode(nodes, graphNode(`dataset:${datasetId}`, "dataset", CODEBOOK_DATASETS.find((item) => item.dataset_id === datasetId)?.label || datasetId, {
      layer: "codebook",
      source_type: CODEBOOK_DATASETS.find((item) => item.dataset_id === datasetId)?.source_type || "dataset",
    }));
    addNode(nodes, graphNode(`variable:${variable.variable_id}`, "variable", variable.label, {
      layer: "codebook",
      role: variable.role,
      dtype: variable.dtype,
      description: variable.description,
    }));
    addNode(nodes, graphNode(unitId, "unit", variable.unit || "unitless", {
      layer: "codebook",
      quantity_type: variable.quantity_type || "unknown",
    }));
    const method = CODEBOOK_METHODS.find((item) => item.method_id === methodId);
    addNode(nodes, graphNode(`method:${methodId}`, "method", method?.label || methodId, {
      layer: "codebook",
      method_type: method?.method_type || "measurement",
    }));
    addEdge(edges, graphEdge(`dataset:${datasetId}`, `variable:${variable.variable_id}`, variable.role === "condition" ? "has_condition" : "has_variable"));
    addEdge(edges, graphEdge(`variable:${variable.variable_id}`, unitId, RELATIONS.HAS_UNIT));
    addEdge(edges, graphEdge(`variable:${variable.variable_id}`, `method:${methodId}`, RELATIONS.MEASURED_BY));
  }

  return {
    graph_type: "codebook-knowledge-graph",
    layer: "codebook",
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
  };
}

module.exports = {
  inferFamilyRootFromVariable,
  rivalFamiliesFor,
  CODEBOOK_VARIABLES,
  CODEBOOK_DATASETS,
  CODEBOOK_METHODS,
  buildDynamicCodebook,
  tokenize,
  topConcepts,
  conceptBundle,
  groundedVariableBundle,
  discoverPrimaryFamilyRoots,
  selectPrimaryVariableForFamily,
  slugifyFragment,
  dynamicHypothesisId,
  clampScore,
  buildCodebookGraph,
};
