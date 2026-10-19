#!/usr/bin/env node
"use strict";

// Consolidated evaluation dashboard for the AI co-scientist harness.
// Runs every per-stage benchmark adapter + the analyst resolution eval and
// prints one summary, so "did that change help?" is a single command. Each
// runner scores recorded outputs (fixtures by default); point the adapters at
// real benchmark data + live harness captures for real numbers (see each
// evals/<bench>/README.md). Per-cycle stage KPIs come from harness_metrics.js.
//
//   node scripts/run_all_evals.js [--cycle <id>]

const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) if (argv[i] === "--cycle") a.cycle = argv[++i];
  return a;
}

const RUNS = [
  { stage: "End-to-end (discovery)", name: "DiscoveryBench", cmd: "node scripts/run_discoverybench.js", grab: /mean HMS[^\n]*/ },
  { stage: "Analysis (Analyst)", name: "InfiAgent-DABench", cmd: "node scripts/run_dabench.js", grab: /ABQ[^\n]*/ },
  { stage: "KG construction (Chronicle)", name: "Text2KGBench", cmd: "node scripts/run_text2kg.js", grab: /micro P\/R\/F1[^\n]*/ },
  { stage: "Search (Scout)", name: "LitQA2", cmd: "node scripts/run_litqa2.js", grab: /accuracy[^\n]*/ },
  { stage: "Analysis (resolution)", name: "Analyst resolution eval", cmd: "node scripts/run_analyst_evals.js", grab: /cases passed[^\n]*/ },
];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" });
  } catch (e) {
    // Runners may exit non-zero on a failing gate (e.g. an expected-blocked
    // eval case); we still want their printed summary.
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
}

function main() {
  const args = parseArgs(process.argv);
  console.log("AI co-scientist — consolidated evaluation\n" + "=".repeat(42));
  for (const r of RUNS) {
    const out = run(r.cmd);
    const line = (out.match(r.grab) || [])[0] || "(no summary — see runner output)";
    console.log(`\n[${r.stage}] ${r.name}`);
    console.log(`  ${line.trim()}`);
  }
  if (args.cycle) {
    console.log(`\n[Per-stage cycle KPIs] ${args.cycle}`);
    const out = run(`node scripts/metrics/harness_metrics.js --cycle ${args.cycle}`);
    out
      .split("\n")
      .filter((l) => /\*\*|completion|Infra loss/.test(l))
      .forEach((l) => console.log(`  ${l.replace(/\*\*/g, "").trim()}`));
  }
  console.log(
    "\nNote: fixture/smoke numbers validate the harness end-to-end. For real scores,\n" +
      "populate evals/<bench>/ with the published datasets and capture live harness outputs.",
  );
}

main();
