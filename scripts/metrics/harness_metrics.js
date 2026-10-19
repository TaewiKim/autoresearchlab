#!/usr/bin/env node
"use strict";

// Quantitative performance review for the AI co-scientist harness.
//
// Computes per-stage KPIs from a cycle's persisted artifacts so the
// harness can be measured and improved step by step (and so a paper can report
// real numbers). Stages mirror the multi-agent pipeline:
//   Discovery (Scout) -> Hypothesis (LabDirector) -> Analysis (Analyst)
//   -> Validation (LabRunner) -> Gate (Gatekeeper) -> Yield (Author/claims)
// plus cross-cutting Reliability/Cost.
//
//   node scripts/metrics/harness_metrics.js --cycle <id> [--root .research-lab] [--json out.json]
//
// Every metric is read defensively; anything absent is reported as null rather
// than invented, so the report is an honest measurement, not an estimate.

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { root: ".research-lab", json: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--cycle") a.cycle = argv[++i];
    else if (argv[i] === "--root") a.root = argv[++i];
    else if (argv[i] === "--json") a.json = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.cycle) {
  console.error("usage: harness_metrics.js --cycle <id> [--root .research-lab] [--json out.json]");
  process.exit(2);
}
const STATE = path.join(args.root, "state");
const LANES = path.join(args.root, "lanes", args.cycle);

function rd(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, `${args.cycle}-${name}.json`), "utf8"));
  } catch {
    return null;
  }
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// ---- Lane reliability by role (from each lane's final-status.json) ----
function laneStats() {
  const byRole = {};
  let total = 0;
  let completed = 0;
  if (fs.existsSync(LANES)) {
    for (const lane of fs.readdirSync(LANES)) {
      const role = lane.replace(/^followup-/, "").replace(/-\d+.*$/, "");
      let status = "unknown";
      try {
        status = JSON.parse(fs.readFileSync(path.join(LANES, lane, "final-status.json"), "utf8")).status || "unknown";
      } catch {
        status = "no-final-status";
      }
      const r = (byRole[role] = byRole[role] || { total: 0, completed: 0, failed: 0, other: 0 });
      r.total += 1;
      total += 1;
      if (status === "completed") {
        r.completed += 1;
        completed += 1;
      } else if (status === "failed" || status === "timeout") r.failed += 1;
      else r.other += 1;
    }
  }
  for (const r of Object.values(byRole)) r.success_rate_pct = pct(r.completed, r.total);
  return { total_lanes: total, overall_completion_pct: pct(completed, total), by_role: byRole };
}

// ---- Discovery (Scout) ----
function discovery() {
  const g = rd("data-graph") || {};
  const datasets = (g.nodes || []).filter((n) => String(n.id || "").startsWith("dataset:"));
  const verified = datasets.filter((n) => (n.metadata || {}).verification_method);
  const bundles = rd("data-bundles");
  const materialized = Array.isArray(bundles?.bundles)
    ? bundles.bundles.length
    : Array.isArray(bundles)
    ? bundles.length
    : null;
  return {
    datasets_discovered: datasets.length,
    datasets_verified: verified.length,
    verified_pct: pct(verified.length, datasets.length),
    datasets_materialized: materialized,
  };
}

// ---- Hypothesis (LabDirector) ----
function hypothesis() {
  const h = rd("hypothesis-ledger") || {};
  const fam = rd("family-package-ledger") || {};
  const total = num(h.hypothesis_count);
  return {
    hypothesis_count: total,
    promoted_count: num(h.promoted_count),
    promotion_pct: total ? pct(h.promoted_count || 0, total) : null,
    challenged_count: num(h.challenged_count),
    weakened_count: num(h.weakened_count),
    strengthened_count: num(h.strengthened_count),
    demoted_count: num(h.demoted_count),
    retired_count: num(h.retired_count),
    design_blocked_count: num(h.design_blocked_count),
    average_hypothesis_score: num(h.average_hypothesis_score),
    average_evidence_quality_score: num(h.average_evidence_quality_score),
    family_package_count: num(fam.family_package_count),
    incumbent_family: fam.incumbent_family || null,
  };
}

// ---- Validation (LabRunner) ----
function validation() {
  const v = rd("validation-results");
  const results = v?.validation_results || v;
  const list = Array.isArray(results) ? results : results ? Object.values(results) : [];
  const byStatus = {};
  let executed = 0; // any "completed*"
  let confirmatory = 0; // completed and NOT exploratory
  let failed = 0;
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const status = String(r.execution_status || r.overall_status || r.status || "unknown").toLowerCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status.startsWith("completed")) {
      executed += 1;
      if (!status.includes("exploratory")) confirmatory += 1;
    } else if (status.includes("fail") || status.includes("error")) failed += 1;
  }
  return {
    validation_records: list.length,
    executed,
    executed_pct: pct(executed, list.length),
    confirmatory_completed: confirmatory,
    confirmatory_pct: pct(confirmatory, list.length),
    failed,
    status_distribution: byStatus,
  };
}

// ---- Gate (Gatekeeper) ----
function gate() {
  const gr = rd("gate-review") || {};
  const cr = rd("conclusion-review") || {};
  const ar = rd("approval-review") || {};
  const blockers = Array.isArray(gr.gate_scientific_blockers) ? gr.gate_scientific_blockers.length : null;
  return {
    gate_passed: gr.gate_passed ?? null,
    conclusion_gate_passed: gr.conclusion_gate_passed ?? cr.conclusion_gate_passed ?? null,
    approval_gate_passed: gr.approval_gate_passed ?? null,
    conclusion_score: num(cr.conclusion_score),
    exploratory_score: num(cr.exploratory_score),
    conclusion_band: cr.conclusion_band || null,
    all_rubrics_approved: ar.all_rubrics_approved ?? cr.all_rubrics_approved ?? null,
    open_scientific_blockers: blockers,
  };
}

// ---- Yield (Author / claims) ----
function yieldStage() {
  const ct = rd("claim-traces") || {};
  const agg = rd("cycle-aggregate-metrics") || {};
  return {
    claim_trace_count: num(ct.claim_trace_count),
    traceable_claim_count: num(ct.traceable_claim_count),
    traceable_pct: ct.claim_trace_count ? pct(ct.traceable_claim_count || 0, ct.claim_trace_count) : null,
    primary_claim_count: num(agg.primary_claim_count),
    supporting_claim_count: num(agg.supporting_claim_count),
    open_question_count: num(agg.open_question_count),
  };
}

// ---- Reliability / cost ----
function reliability(lanes) {
  const agg = rd("cycle-aggregate-metrics") || {};
  const bad =
    (num(agg.quota_exceeded_lane_count) || 0) +
    (num(agg.rate_limited_lane_count) || 0) +
    (num(agg.timeout_lane_count) || 0);
  return {
    total_lanes: lanes.total_lanes,
    failure_notice_count: num(agg.failure_notice_count),
    quota_exceeded_lane_count: num(agg.quota_exceeded_lane_count),
    rate_limited_lane_count: num(agg.rate_limited_lane_count),
    timeout_lane_count: num(agg.timeout_lane_count),
    infra_loss_lanes: bad,
    infra_loss_pct: pct(bad, lanes.total_lanes),
  };
}

const lanes = laneStats();
const report = {
  cycle_id: args.cycle,
  stages: {
    "1_discovery_scout": discovery(),
    "2_hypothesis_labdirector": hypothesis(),
    "3_analysis_analyst": { note: "canonical_resolution_rate via scripts/run_analyst_evals.js (offline eval)" },
    "4_validation_labrunner": validation(),
    "5_gate_gatekeeper": gate(),
    "6_yield_author": yieldStage(),
  },
  lane_reliability: lanes,
  reliability_cost: reliability(lanes),
};

if (args.json) {
  fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
  fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2) + "\n", "utf8");
}

// Markdown summary
const L = [];
L.push(`# Harness performance — ${args.cycle}`, "");
const s = report.stages;
L.push("## Pipeline stages");
L.push(`- **Discovery (Scout)**: ${s["1_discovery_scout"].datasets_discovered} datasets (${s["1_discovery_scout"].verified_pct}% verified), materialized=${s["1_discovery_scout"].datasets_materialized}`);
const hy = s["2_hypothesis_labdirector"];
L.push(`- **Hypothesis (LabDirector)**: ${hy.hypothesis_count} hypotheses, promoted ${hy.promoted_count} (${hy.promotion_pct}%), avg score ${hy.average_hypothesis_score}, avg evidence ${hy.average_evidence_quality_score}, design-blocked ${hy.design_blocked_count}, families ${hy.family_package_count}`);
const va = s["4_validation_labrunner"];
L.push(`- **Validation (LabRunner)**: ${va.validation_records} records, executed ${va.executed_pct}%, confirmatory ${va.confirmatory_pct}%, failed ${va.failed}, status ${JSON.stringify(va.status_distribution)}`);
const ga = s["5_gate_gatekeeper"];
L.push(`- **Gate (Gatekeeper)**: gate_passed=${ga.gate_passed}, conclusion=${ga.conclusion_score} (${ga.conclusion_band}), approval=${ga.approval_gate_passed}, open blockers=${ga.open_scientific_blockers}`);
const yi = s["6_yield_author"];
L.push(`- **Yield**: ${yi.primary_claim_count} primary / ${yi.supporting_claim_count} supporting claims, traceable ${yi.traceable_pct}%, open questions ${yi.open_question_count}`);
L.push("");
L.push("## Lane reliability");
L.push(`- Total lanes: ${lanes.total_lanes}, overall completion ${lanes.overall_completion_pct}%`);
for (const [role, r] of Object.entries(lanes.by_role).sort((a, b) => b[1].total - a[1].total)) {
  L.push(`  - ${role}: ${r.completed}/${r.total} (${r.success_rate_pct}%) — failed ${r.failed}`);
}
const rc = report.reliability_cost;
L.push("", "## Reliability / cost");
L.push(`- Infra loss: ${rc.infra_loss_lanes} lanes (${rc.infra_loss_pct}%) [quota ${rc.quota_exceeded_lane_count}, rate-limit ${rc.rate_limited_lane_count}, timeout ${rc.timeout_lane_count}], failure notices ${rc.failure_notice_count}`);
console.log(L.join("\n"));
