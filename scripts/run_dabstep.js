#!/usr/bin/env node
"use strict";

// DABStep runner: score codex answers on the public DEV split (gold answers) and
// report accuracy overall + by level, against the leaderboard SOTA.
//
//   node scripts/run_dabstep.js --tasks <dev.jsonl> --responses <dir> [--out FILE]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateTask, aggregate } = require("../src/evals/benchmarks/dabstep_adapter");

function parseArgs(argv) {
  const a = { out: "evals/dabstep/results/latest.jsonl" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--responses") a.responses = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  return a;
}
function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.responses) {
    console.error("usage: run_dabstep.js --tasks <dev.jsonl> --responses <dir> [--out FILE]");
    process.exit(2);
  }
  const tasks = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const results = [];
  let missing = 0;
  for (const t of tasks) {
    const rp = path.join(path.resolve(a.responses), `${t.task_id}.json`);
    if (!fs.existsSync(rp)) {
      missing += 1;
      continue;
    }
    const resp = JSON.parse(fs.readFileSync(rp, "utf8"));
    results.push(evaluateTask({ task: t, predicted: resp.answer ?? resp.response ?? "" }));
  }
  const agg = aggregate(results);
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  fs.appendFileSync(path.resolve(a.out), JSON.stringify({ ts: new Date().toISOString(), git_sha: gitSha(), benchmark: "dabstep-dev", ...agg }) + "\n");

  console.log("\nDABStep (public dev split)");
  console.log("task".padEnd(8), "level".padEnd(6), "ok", " pred -> gold");
  for (const r of results) {
    console.log(
      String(r.task_id).padEnd(8),
      String(r.level).padEnd(6),
      r.match ? "✓" : "✗",
      ` ${String(r.predicted).slice(0, 30)} -> ${String(r.gold).slice(0, 30)}`,
    );
  }
  console.log(`\naccuracy ${agg.accuracy} over ${agg.tasks} dev tasks (${missing} missing); by level ${JSON.stringify(agg.by_level)}`);
  console.log("Leaderboard SOTA (test): overall ~16% (o3-mini); by level easy ~76% / hard ~14.5% (o4-mini).");
}

main();
