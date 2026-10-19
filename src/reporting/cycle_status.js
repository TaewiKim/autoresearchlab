"use strict";

// One place to ask a cycle how it is doing.
//
// These are the questions the owner has asked, in these words, across a long
// run: how is it going / is the search working / are approvals sound / the
// graphs / research trends (problems and methods) / the problem and its
// solution / what experiments remain / are the roles talking. Answering each
// meant a fresh one-off script every time, and a one-off script is where a
// wrong baseline and a broken glob came from today.
//
// So the answers live here, computed the same way each time, and the primary
// output is STRUCTURED: a list of checks, each with an id, a verdict, the
// numbers behind it, and where it read them. A dashboard renders that list; the
// text view in src/cli/cycle_status.js is one renderer of it, not the truth.
//
// Three rules this file keeps, because each was learned the expensive way:
//
//   A missing artifact is a datum, never an exception. A cycle that has not
//   reached a stage yet must read as "not yet", not as a crash.
//
//   Every check says WHERE it looked. A number with no path behind it cannot be
//   checked by the next person, and today three of my own reports were wrong in
//   ways only the path would have shown.
//
//   A verdict is `ok`, `attention` or `absent`, and `absent` is not a failure.
//   A stall record missing from a moving cycle is correct; calling it a fault
//   teaches everyone to ignore the report.

const fs = require("fs");
const path = require("path");

const { evaluateCycleDelivery, undeliveredSignals } = require("../provenance/delivery_gate");

const VERDICT = Object.freeze({ OK: "ok", ATTENTION: "attention", ABSENT: "absent" });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function check(id, label, verdict, detail, where, note = null) {
  return { id, label, verdict, detail, where, note };
}

function minutesSince(iso) {
  const parsed = Date.parse(iso || "");
  if (Number.isNaN(parsed)) return null;
  return Math.round((Date.now() - parsed) / 60000);
}

// --------------------------------------------------------------------- checks

function runCheck(root, cycleId) {
  const statePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const state = readJson(statePath);
  const halt = fs.existsSync(path.join(root, "state", `${cycleId}-watchdog-halt.json`));
  const stopped = fs.existsSync(path.join(root, "state", `${cycleId}-termination-code.json`));
  if (!state) {
    return check("run", "cycle", VERDICT.ABSENT, { }, statePath, "no cycle state on disk yet");
  }
  const age = minutesSince(state.updated_at);
  const counts = state.lane_counts || {};
  const verdict = halt || stopped
    ? VERDICT.ATTENTION
    : (age !== null && age > 45 && !(counts.running > 0) ? VERDICT.ATTENTION : VERDICT.OK);
  return check("run", "cycle", verdict, {
    ...counts,
    updated_at: state.updated_at,
    minutes_since_update: age,
    halted: halt,
    terminated: stopped,
  }, statePath,
  halt ? "a watchdog halt is in place" : stopped ? "a termination code is in place" : null);
}

function retrievalCheck(root, cycleId) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  const lanes = listDirs(lanesRoot).filter((name) => name.includes("scout"));
  let retrieved = 0;
  let accepted = 0;
  let throttled = 0;
  const per = [];
  for (const lane of lanes) {
    const audit = readJson(path.join(lanesRoot, lane, "literature-screening-audit.json"));
    if (!audit) continue;
    const counts = audit.counts || {};
    retrieved += counts.retrieved || 0;
    accepted += counts.accepted || 0;
    per.push({ lane, ...counts, review_bundle_status: audit.review_bundle_status });
    const journal = path.join(lanesRoot, lane, "search-agent-journal.json");
    try {
      if (/429|rate.?limit|throttl/i.test(fs.readFileSync(journal, "utf8"))) throttled += 1;
    } catch { /* no journal */ }
  }
  if (!per.length) {
    return check("retrieval", "literature search", VERDICT.ABSENT, { scout_lanes: lanes.length }, lanesRoot,
      "no screening audit written yet");
  }
  return check("retrieval", "literature search",
    accepted > 0 ? VERDICT.OK : VERDICT.ATTENTION,
    { retrieved, accepted, lanes_with_audit: per.length, lanes_reporting_throttle: throttled, per_lane: per },
    lanesRoot,
    throttled ? "a provider refused for rate, not for content; the corpus is not a measure of the field" : null);
}

function corpusCheck(root, cycleId) {
  const file = path.join(root, "state", `${cycleId}-literature-summary.json`);
  const summary = readJson(file);
  if (!summary) return check("corpus", "admitted corpus", VERDICT.ABSENT, {}, file, "no summary yet");
  const recent = summary.recent_frontier_papers || [];
  const standing = summary.established_impact_papers || [];
  const years = [...recent, ...standing].map((paper) => paper && paper.year).filter(Boolean);
  return check("corpus", "admitted corpus",
    standing.length > 0 ? VERDICT.OK : VERDICT.ATTENTION,
    {
      recent_frontier: recent.length,
      established_impact: standing.length,
      earliest_year: years.length ? Math.min(...years) : null,
      latest_year: years.length ? Math.max(...years) : null,
    }, file,
    standing.length ? null : "no citation-backed paper reached the graph, so novelty has no baseline to be measured against");
}

function graphCheck(root, cycleId) {
  const out = {};
  for (const kind of ["literature-graph", "data-graph", "reasoning-graph"]) {
    const graph = readJson(path.join(root, "state", `${cycleId}-${kind}.json`));
    out[kind.replace("-", "_")] = graph
      ? { nodes: (graph.nodes || []).length, edges: (graph.edges || []).length }
      : null;
  }
  const built = Object.values(out).filter((value) => value && value.nodes > 0).length;
  return check("graph", "knowledge graphs", built ? VERDICT.OK : VERDICT.ABSENT, out,
    path.join(root, "state"), built ? null : "no graph has nodes yet");
}

function surveyCheck(root, cycleId) {
  const file = path.join(root, "state", `${cycleId}-research-trend-analysis.json`);
  const survey = readJson(file);
  if (!survey) return check("survey", "problems and methods", VERDICT.ABSENT, {}, file, "the director has not surveyed yet");
  const problems = survey.open_problems || [];
  const methods = survey.proposed_methods || [];
  const attributed = (items) => items.filter((item) => (item && item.paper_ids || []).length > 0).length;
  return check("survey", "problems and methods",
    problems.length && methods.length ? VERDICT.OK : VERDICT.ATTENTION,
    {
      open_problems: problems.length,
      open_problems_attributed: attributed(problems),
      proposed_methods: methods.length,
      proposed_methods_attributed: attributed(methods),
      unattributed_impressions: (survey.unattributed_impressions || []).length,
      survey_coverage_gaps: (survey.survey_coverage_gaps || []).length,
    }, file,
    problems.length ? null : "empty lists with stated coverage gaps are the contract working, not a fault: the corpus could not support an attributed entry");
}

function leadCheck(root, cycleId) {
  const file = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  const artifact = readJson(file);
  if (!artifact) return check("lead", "the lead", VERDICT.ABSENT, {}, file, "no hypothesis chosen yet");
  const selected = artifact.selected_hypothesis || artifact;
  const filled = (key) => {
    const value = selected[key];
    return Array.isArray(value) ? value.length : (value ? 1 : 0);
  };
  const detail = {
    statement: selected.statement || null,
    primary_family: selected.primary_family || null,
    generated_by: artifact.generated_by || null,
    falsification_conditions: filled("falsification_conditions"),
    rival_mechanisms: filled("rival_mechanisms"),
    candidate_hypothesis_ranking: filled("candidate_hypothesis_ranking"),
    supporting_literature_edges: filled("supporting_literature_edges"),
    supporting_data_graph_edges: filled("supporting_data_graph_edges"),
    validation_data_status: selected.validation_data_status || artifact.validation_data_status || null,
  };
  const complete = detail.falsification_conditions && detail.rival_mechanisms;
  return check("lead", "the lead", complete ? VERDICT.OK : VERDICT.ATTENTION, detail, file,
    complete ? null : "a lead with no stated way to be wrong is what the gate exists to refuse");
}

function experimentCheck(root, cycleId) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  const lanes = listDirs(lanesRoot).filter((name) => name.includes("runner"));
  const blueprints = new Map();
  let withNumbers = 0;
  for (const lane of lanes) {
    const result = readJson(path.join(lanesRoot, lane, "result.json"));
    if (!result) continue;
    let counted = false;
    for (const run of result.blueprint_executions || []) {
      const id = String(run.blueprint_id || "");
      if (!id || id.startsWith("bp-deferred") || id.startsWith("BLOCKED")) continue;
      if (!run.metrics) continue;
      // A metrics object is not a measurement. MEASURED ON cycle-g-v91,
      // 2026-09-14: runners that measured nothing by design and runners whose
      // blueprint timed out both carry one (notes, observed_seconds, a remedy),
      // and this check reported "58 of 67 measured something" through three
      // zero-measurement runs and three timeouts. Trust the driver's own verdict
      // where it gives one; a result written before that flag existed counts
      // only when its execution finished.
      if (run.produced_evidence === false) continue;
      if (run.produced_evidence !== true && run.status && run.status !== "completed") continue;
      blueprints.set(id, (blueprints.get(id) || 0) + 1);
      counted = true;
    }
    if (counted) withNumbers += 1;
  }
  // No runner lane at all is a stage not reached, not a stage gone wrong. The
  // rule this file keeps: absent is never attention, or the report cries wolf
  // on every young cycle and stops being read.
  const verdict = !lanes.length
    ? VERDICT.ABSENT
    : (withNumbers ? VERDICT.OK : VERDICT.ATTENTION);
  return check("experiments", "executions that produced numbers",
    verdict,
    {
      runner_lanes: lanes.length,
      lanes_with_measured_output: withNumbers,
      distinct_blueprints: blueprints.size,
      per_blueprint: Object.fromEntries(blueprints),
    }, lanesRoot,
    withNumbers ? null : "lanes can complete without measuring anything; a completed runner is not a result");
}

function gateCheck(root, cycleId) {
  const historyPath = path.join(root, "state", `${cycleId}-watchdog-history.jsonl`);
  let latest = null;
  try {
    const lines = fs.readFileSync(historyPath, "utf8").trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        latest = JSON.parse(lines[index]);
        break;
      } catch { /* keep walking back */ }
    }
  } catch { /* no history */ }
  const review = readJson(path.join(root, "state", `${cycleId}-gate-review.json`)) || {};
  if (!latest) {
    return check("gate", "the gate", VERDICT.ABSENT, { gate_passed: review.gate_passed ?? null }, historyPath,
      "no watchdog observation yet");
  }
  return check("gate", "the gate", latest.gate_rounds > 0 ? VERDICT.OK : VERDICT.ATTENTION, {
    gate_rounds: latest.gate_rounds ?? null,
    best_by_rubric: latest.best_by_rubric || null,
    distinct_leads: latest.distinct_leads ?? null,
    lead_changes: latest.lead_changes ?? null,
    gate_passed: review.gate_passed ?? null,
    observed_at: latest.ts || null,
  }, historyPath,
  latest.gate_rounds > 0 ? null : "lanes can complete for hours without a single gate round; that is the shape the watchdog halts on");
}

function capabilityCheck(root, cycleId) {
  const file = path.join(root, "state", `${cycleId}-instrument-inventory.json`);
  const inventory = readJson(file);
  if (!inventory) return check("capability", "measured instruments", VERDICT.ABSENT, {}, file, "no probe has run");
  const unprobed = inventory.implemented_but_not_probed || [];
  return check("capability", "measured instruments",
    unprobed.length ? VERDICT.ATTENTION : VERDICT.OK,
    {
      backends: inventory.backends || (inventory.backend ? [inventory.backend] : []),
      verified: (inventory.verified_instruments || []).length,
      unavailable: (inventory.unavailable_instruments || []).length,
      measurable_quantities: (inventory.measurable_quantities || []).length,
      implemented_but_not_probed: unprobed,
    }, file,
    unprobed.length ? "a capability that exists here and was never measured; every hypothesis must cite this inventory" : null);
}

function deliveryCheck(root, cycleId) {
  const reports = evaluateCycleDelivery({ root, cycleId });
  const unread = undeliveredSignals(reports);
  return check("delivery", "signals between roles",
    unread.length ? VERDICT.ATTENTION : VERDICT.OK,
    {
      signals: reports.length,
      produced_and_unread: unread.map((report) => report.signal),
      per_signal: reports.map((report) => ({
        signal: report.signal,
        verdict: report.verdict,
        readers: report.delivered ? report.delivered.count : null,
      })),
    }, "src/provenance/delivery_gate.js",
    unread.length ? "a message with a recipient and no reader is the shape that cost two cycles" : null);
}

/**
 * Every check, in one structured answer.
 *
 * Order is the order the questions get asked in practice: is it alive, is it
 * finding things, is it admitting them, does it have a claim, is it measuring,
 * is the gate moving, can the roles hear each other.
 */
function cycleStatus({ root, cycleId }) {
  const checks = [
    runCheck(root, cycleId),
    retrievalCheck(root, cycleId),
    corpusCheck(root, cycleId),
    graphCheck(root, cycleId),
    surveyCheck(root, cycleId),
    leadCheck(root, cycleId),
    experimentCheck(root, cycleId),
    gateCheck(root, cycleId),
    capabilityCheck(root, cycleId),
    deliveryCheck(root, cycleId),
  ];
  return {
    schema: "researchlab.cycle_status.v1",
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    root,
    summary: {
      ok: checks.filter((item) => item.verdict === VERDICT.OK).length,
      attention: checks.filter((item) => item.verdict === VERDICT.ATTENTION).length,
      absent: checks.filter((item) => item.verdict === VERDICT.ABSENT).length,
      needs_attention: checks.filter((item) => item.verdict === VERDICT.ATTENTION).map((item) => item.id),
    },
    checks,
  };
}

module.exports = { VERDICT, cycleStatus };
