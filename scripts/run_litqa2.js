#!/usr/bin/env node
"use strict";

// LitQA2 runner: score recorded Scout answers (MC + abstention + retrieved DOIs)
// -> accuracy / precision / coverage / retrieval-recall, append telemetry.
//
//   node scripts/run_litqa2.js [--questions DIR] [--responses DIR] [--out FILE]
//
// questions/<id>.json holds {question, options, answer_index|answer, source_doi};
// responses/<id>.json holds Scout's {answer, retrieved_dois}. Running Scout live
// (formatHarnessInput -> search -> capture) is the documented seam.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateQuestion, aggregate } = require("../src/evals/benchmarks/litqa2_adapter");

function parseArgs(argv) {
  const a = { questions: "evals/litqa2/questions", responses: "evals/litqa2/responses", out: "evals/litqa2/results/latest.jsonl" };
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
    const id = q.id || path.basename(f, ".json");
    const rPath = path.join(path.resolve(args.responses), `${id}.json`);
    if (!fs.existsSync(rPath)) {
      console.error(`! ${id}: no response at ${rPath} (skipped)`);
      missing += 1;
      continue;
    }
    results.push(evaluateQuestion({ question: q, response: readJson(rPath) }));
  }

  const agg = aggregate(results);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.appendFileSync(path.resolve(args.out), JSON.stringify({ ts, git_sha: sha, benchmark: "litqa2", ...agg }) + "\n", "utf8");

  console.log("\nLitQA2 (literature MC with abstention)");
  console.log("id".padEnd(24), "sel/gold", " result");
  for (const r of results) {
    const s = r.score;
    const res = s.abstained ? "abstain" : s.correct ? "correct" : "wrong";
    console.log(String(r.id).padEnd(24), `${s.selected}/${s.gold}`.padEnd(9), ` ${res}${s.retrieved != null ? ` (retrieved=${s.retrieved})` : ""}`);
  }
  console.log(
    `\naccuracy ${agg.accuracy} | precision ${agg.precision} | coverage ${agg.coverage} | retrieval ${agg.retrieval_recall} over ${agg.questions} (${missing} missing) -> ${args.out}`,
  );
}

main();
