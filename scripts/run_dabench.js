#!/usr/bin/env node
"use strict";

// InfiAgent-DABench runner: score recorded data-analysis responses (closed-form
// @name[value] markers) against gold, report ABQ / APSQ / AUSQ + by-level, and
// append telemetry.
//
//   node scripts/run_dabench.js [--questions DIR] [--responses DIR] [--out FILE]
//
// questions/<id>.json holds {question, constraints, format, file_name, level,
// labels}; responses/<id>.json holds the analysis stage's {response}. Producing
// responses live (formatHarnessInput -> run analysis stage -> capture) is the
// documented seam; this scores recorded responses so it runs in CI today.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateQuestion, aggregate } = require("../src/evals/benchmarks/dabench_adapter");

function parseArgs(argv) {
  const a = {
    questions: "evals/dabench/questions",
    responses: "evals/dabench/responses",
    out: "evals/dabench/results/latest.jsonl",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--questions") a.questions = argv[++i];
    else if (argv[i] === "--responses") a.responses = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  return a;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const qDir = path.resolve(args.questions);
  if (!fs.existsSync(qDir)) {
    console.error(`no questions dir at ${qDir}`);
    process.exit(2);
  }
  const sha = gitSha();
  const ts = new Date().toISOString();
  const files = fs.readdirSync(qDir).filter((f) => f.endsWith(".json")).sort();

  const results = [];
  let missing = 0;
  for (const f of files) {
    const q = readJson(path.join(qDir, f));
    const id = q.id ?? q.question_id ?? path.basename(f, ".json");
    const rPath = path.join(path.resolve(args.responses), `${id}.json`);
    if (!fs.existsSync(rPath)) {
      console.error(`! ${id}: no response at ${rPath} (skipped)`);
      missing += 1;
      continue;
    }
    const resp = readJson(rPath);
    results.push(evaluateQuestion({ question: q, response: resp.response || resp.answer || "" }));
  }

  const agg = aggregate(results);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.appendFileSync(
    path.resolve(args.out),
    JSON.stringify({ ts, git_sha: sha, benchmark: "infiagent-dabench", ...agg }) + "\n",
    "utf8",
  );

  console.log("\nInfiAgent-DABench (closed-form)");
  console.log("question".padEnd(28), "correct/total", "  all?");
  for (const r of results) {
    console.log(
      String(r.question_id).padEnd(28),
      `${r.score.correct}/${r.score.total}`.padEnd(13),
      r.score.all_correct ? "  YES" : "  no",
    );
  }
  console.log(
    `\nABQ ${agg.ABQ} | APSQ ${agg.APSQ} | AUSQ ${agg.AUSQ} over ${agg.questions} questions (${missing} missing)`,
  );
  console.log(`by level: ${JSON.stringify(agg.by_level)} -> ${args.out}`);
}

main();
