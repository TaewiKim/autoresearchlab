"use strict";

// DiscoveryBench adapter — the most general benchmark for the co-scientist.
//
// DiscoveryBench (allenai/discoverybench, arXiv:2407.01725) is agent-neutral and
// multi-domain: given dataset(s) + a discovery goal, the agent must derive a
// hypothesis, scored by *faceted Hypothesis Matching* against a gold hypothesis.
// It maps 1:1 onto this harness's core loop (data + goal -> hypothesis), so it
// supplies an external ground truth for end-to-end yield.
//
// Two seams:
//   * formatHarnessInput(task)  -> the cycle input (goal prompt + dataset metadata)
//     a task becomes; running the harness on it and capturing the promoted
//     hypothesis is the live integration.
//   * scoreHypothesis(...)      -> faceted match. The canonical DiscoveryBench
//     evaluator uses an LLM judge for semantic facet matching; we implement a
//     deterministic structural matcher (offline, testable) and expose a `judge`
//     hook to swap in the LLM judge. Facets follow DiscoveryBench: context,
//     variables, relationship; HMS = strict all-facets match.

function norm(s) {
  return String(s || "").toLowerCase();
}
function tokens(s) {
  return norm(s).split(/[^a-z0-9_]+/).filter(Boolean);
}
function round(x) {
  return Math.round(x * 1000) / 1000;
}

// Direction/nature of the relationship, coarsely classified so a predicted
// hypothesis can be matched to the gold's relationship facet without an LLM.
const REL_CLASSES = [
  { key: "none", pat: /\b(no (significant )?(effect|association|relationship|correlation)|null result|not associated)/ },
  { key: "nonlinear", pat: /\b(nonlinear|non-linear|u-shaped|inverted-u|quadratic|threshold|interaction effect)/ },
  // No trailing \b: stems like "increas"/"positive" must match "increases"/"positively".
  { key: "negative", pat: /\b(negative|inverse|decreas|lower|reduc|declin|fewer|less)/ },
  { key: "positive", pat: /\b(positive|direct|increas|higher|greater|rise|elevat|more)/ },
];
function relationshipClass(text) {
  const t = norm(text);
  for (const c of REL_CLASSES) if (c.pat.test(t)) return c.key;
  return "unspecified";
}

function variablesMatch(goldVars, predicted) {
  const list = Array.isArray(goldVars) ? goldVars : [];
  if (!list.length) return 1;
  const ptext = norm(predicted);
  const pset = new Set(tokens(predicted));
  let found = 0;
  for (const v of list) {
    const vt = tokens(v);
    const hit =
      (norm(v) && ptext.includes(norm(v))) ||
      (vt.length && vt.every((t) => pset.has(t))) ||
      vt.some((t) => t.length > 3 && pset.has(t));
    if (hit) found += 1;
  }
  return found / list.length;
}

function contextMatch(goldContext, predicted) {
  const gt = tokens(goldContext).filter((t) => t.length > 3);
  if (!gt.length) return 1; // no context constraint in the gold
  const pset = new Set(tokens(predicted));
  return gt.filter((t) => pset.has(t)).length / gt.length;
}

// Score a predicted hypothesis (free text) against a gold DiscoveryBench target.
// gold: { hypothesis, context, variables: [...], relationship | relationship_class }
function scoreHypothesis({ predicted, gold, judge = null, thresholds = {} } = {}) {
  if (typeof judge === "function") {
    // LLM-judge seam: faithful DiscoveryBench faceted matching.
    return judge({ predicted, gold });
  }
  const varTh = thresholds.variables ?? 0.5;
  const ctxTh = thresholds.context ?? 0.3;

  const vScore = variablesMatch(gold.variables, predicted);
  const cScore = contextMatch(gold.context, predicted);
  const goldRel = gold.relationship_class || relationshipClass(gold.relationship || gold.hypothesis || "");
  const predRel = relationshipClass(predicted);

  const variables_match = vScore >= varTh;
  const context_match = cScore >= ctxTh;
  const relationship_match = goldRel === "unspecified" ? null : predRel === goldRel;

  const relOk = relationship_match === null ? true : relationship_match;
  const hms = variables_match && context_match && relOk ? 1 : 0;
  return {
    hms, // strict all-facets Hypothesis Matching Score (0/1)
    soft_score: round((vScore + cScore + (relOk ? 1 : 0)) / 3),
    facets: {
      variables: { score: round(vScore), match: variables_match },
      context: { score: round(cScore), match: context_match },
      relationship: { gold: goldRel, predicted: predRel, match: relationship_match },
    },
  };
}

// A DiscoveryBench task -> the harness cycle input it should drive.
function formatHarnessInput(task) {
  const meta = task.dataset_metadata || {};
  const cols = Array.isArray(meta.columns) ? meta.columns : [];
  return {
    cycle_prompt: task.query || task.goal || "",
    domain: task.domain || null,
    datasets: task.datasets || (meta.name ? [meta.name] : []),
    dataset_metadata: meta,
    column_hint: cols.map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean),
    benchmark: "discoverybench",
    task_id: task.task_id || task.id || null,
  };
}

function evaluateTask({ task, predicted, judge = null }) {
  const score = scoreHypothesis({ predicted, gold: task.gold, judge, thresholds: task.thresholds });
  return { task_id: task.task_id || task.id || null, domain: task.domain || null, score };
}

module.exports = {
  scoreHypothesis,
  relationshipClass,
  variablesMatch,
  contextMatch,
  formatHarnessInput,
  evaluateTask,
};
