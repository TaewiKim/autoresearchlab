#!/usr/bin/env node
"use strict";

// One renderer of src/reporting/cycle_status.js, not the truth.
//
//   node src/cli/cycle_status.js --cycle-id <id>          human-readable
//   node src/cli/cycle_status.js --cycle-id <id> --json    what a dashboard reads
//
// Exits 1 when any check wants attention, so it can sit in a loop or a check
// script. An absent check is not attention: a cycle that has not reached a
// stage yet is not a cycle in trouble.

const path = require("path");
const { cycleStatus, VERDICT } = require("../reporting/cycle_status");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const cycleId = arg("cycle-id");
if (!cycleId) {
  console.error("usage: cycle_status.js --cycle-id <id> [--root <.research-lab>] [--json]");
  process.exit(2);
}
const root = arg("root", path.join(process.cwd(), ".research-lab"));
const status = cycleStatus({ root, cycleId });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.summary.attention ? 1 : 0);
}

const MARK = {
  [VERDICT.OK]: "ok       ",
  [VERDICT.ATTENTION]: "ATTENTION",
  [VERDICT.ABSENT]: "not yet  ",
};

// A handful of numbers per check, chosen because they are the ones actually
// asked about. The full detail is in --json; this is the glance.
const HEADLINE = {
  run: (d) => `${d.completed ?? 0} done / ${d.running ?? 0} running / ${d.pending ?? 0} pending, updated ${d.minutes_since_update ?? "?"}m ago`,
  retrieval: (d) => `${d.accepted ?? 0} admitted of ${d.retrieved ?? 0} retrieved across ${d.lanes_with_audit ?? 0} lane(s)`,
  corpus: (d) => `${d.recent_frontier ?? 0} recent + ${d.established_impact ?? 0} citation-backed, ${d.earliest_year ?? "?"}-${d.latest_year ?? "?"}`,
  graph: (d) => Object.entries(d).map(([name, value]) => `${name.split("_")[0]} ${value ? value.nodes : "-"}n/${value ? value.edges : "-"}e`).join("  "),
  survey: (d) => `${d.open_problems ?? 0} problems (${d.open_problems_attributed ?? 0} attributed), ${d.proposed_methods ?? 0} methods, ${d.survey_coverage_gaps ?? 0} stated gaps`,
  lead: (d) => `${d.primary_family || "none"} — falsification ${d.falsification_conditions}, rivals ${d.rival_mechanisms}, lit edges ${d.supporting_literature_edges}`,
  experiments: (d) => `${d.lanes_with_measured_output ?? 0} of ${d.runner_lanes ?? 0} runner lanes measured something, ${d.distinct_blueprints ?? 0} distinct blueprint(s)`,
  gate: (d) => `round ${d.gate_rounds ?? "?"}, best ${JSON.stringify(d.best_by_rubric || {})}`,
  capability: (d) => `${d.verified ?? 0} verified, ${d.unavailable ?? 0} measured absent${d.implemented_but_not_probed?.length ? `, UNPROBED: ${d.implemented_but_not_probed.join(", ")}` : ""}`,
  delivery: (d) => `${d.signals ?? 0} signals, ${d.produced_and_unread?.length ?? 0} produced and read by nobody`,
};

console.log(`${status.cycle_id}   ${status.generated_at}`);
console.log("");
for (const item of status.checks) {
  const headline = HEADLINE[item.id] ? HEADLINE[item.id](item.detail || {}) : "";
  console.log(`${MARK[item.verdict]}  ${item.label.padEnd(34)} ${headline}`);
  if (item.note) console.log(`             ${item.note}`);
}
console.log("");
console.log(`${status.summary.ok} ok, ${status.summary.attention} need attention, ${status.summary.absent} not yet`);
if (status.summary.attention) {
  console.log(`attention: ${status.summary.needs_attention.join(", ")}`);
}
process.exit(status.summary.attention ? 1 : 0);
