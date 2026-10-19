#!/usr/bin/env node
"use strict";

// DiscoveryBench runner: score harness-derived hypotheses against gold tasks via
// faceted Hypothesis Matching, aggregate HMS, and append telemetry.
//
//   node scripts/run_discoverybench.js [--tasks DIR] [--predictions DIR] [--out FILE]
//
// Each tasks/<id>.json holds {query, dataset_metadata, gold:{...}}; each
// predictions/<id>.json holds the harness's derived {hypothesis}. Producing
// predictions live (formatHarnessInput -> run cycle -> capture promoted
// hypothesis) is the documented integration; this runner scores recorded
// predictions so it works in CI today.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateTask } = require("../src/evals/benchmarks/discoverybench_adapter");

function parseArgs(argv) {
  const a = {
    tasks: "evals/discoverybench/tasks",
    predictions: "evals/discoverybench/predictions",
    out: "evals/discoverybench/results/latest.jsonl",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--predictions") a.predictions = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  return a;
}
function readJson(f) {
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const taskDir = path.resolve(args.tasks);
  if (!fs.existsSync(taskDir)) {
    console.error(`no tasks dir at ${taskDir}`);
    process.exit(2);
  }
  const sha = gitSha();
  const ts = new Date().toISOString();
  const files = fs.readdirSync(taskDir).filter((f) => f.endsWith(".json")).sort();

  const rows = [];
  const telemetry = [];
  let missing = 0;
  for (const f of files) {
    const task = readJson(path.join(taskDir, f));
    const id = task.task_id || task.id || path.basename(f, ".json");
    const predPath = path.join(path.resolve(args.predictions), `${id}.json`);
    if (!fs.existsSync(predPath)) {
      console.error(`! ${id}: no prediction at ${predPath} (skipped)`);
      missing += 1;
      continue;
    }
    const pred = readJson(predPath);
    const predicted = pred.hypothesis || pred.predicted || "";
    const r = evaluateTask({ task, predicted });
    rows.push(r);
    telemetry.push({
      ts,
      git_sha: sha,
      benchmark: "discoverybench",
      task_id: r.task_id,
      domain: r.domain,
      hms: r.score.hms,
      soft_score: r.score.soft_score,
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.appendFileSync(
    path.resolve(args.out),
    telemetry.map((t) => JSON.stringify(t)).join("\n") + (telemetry.length ? "\n" : ""),
    "utf8",
  );

  const n = rows.length;
  const hms = n ? rows.reduce((a, r) => a + r.score.hms, 0) / n : 0;
  const soft = n ? rows.reduce((a, r) => a + r.score.soft_score, 0) / n : 0;
  console.log("\nDiscoveryBench (faceted Hypothesis Matching)");
  console.log("task_id".padEnd(34), "HMS", "soft", " facets");
  for (const r of rows) {
    const fa = r.score.facets;
    console.log(
      String(r.task_id).padEnd(34),
      String(r.score.hms),
      `  ${r.score.soft_score.toFixed(2)}`,
      ` var=${fa.variables.score} ctx=${fa.context.score} rel=${fa.relationship.predicted}/${fa.relationship.gold}`,
    );
  }
  console.log(`\nmean HMS ${hms.toFixed(3)} | mean soft ${soft.toFixed(3)} over ${n} tasks (${missing} missing) -> ${args.out}`);
}

main();
