#!/usr/bin/env node
"use strict";

// DiscoveryBench end-to-end eval with codex: per task, (1) a SOLVER analyzes the
// dataset CSV(s) and states a hypothesis, (2) a JUDGE compares it to the gold
// true_hypothesis (DiscoveryBench's faceted Hypothesis Matching, done by LLM).
// Runs in the codex-sandbox container (root, codex auth). Heavy + slow (2 codex
// calls/task), so use a small --sample. Results written incrementally.
//
//   node scripts/dev/eval_discoverybench_codex.js --tasks <dir> --out <dir> [--sample N] [--effort low]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "low", sample: 0, out: "evals/discoverybench/_real/results_codex" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
  }
  return a;
}
function codex(prompt, cwd, effort) {
  const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${effort}" ${JSON.stringify(prompt)}`;
  try {
    return execSync(cmd, { cwd: cwd || process.cwd(), encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"] }).replace(/\x1b\[[0-9;]*m/g, "");
  } catch (e) {
    return (e.stdout || "").toString();
  }
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks) {
    console.error("usage: eval_discoverybench_codex.js --tasks <dir> --out <dir> [--sample N] [--effort low]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  let files = fs.readdirSync(a.tasks).filter((f) => f.endsWith(".json")).sort();
  if (a.sample) files = files.slice(0, a.sample);

  let done = 0;
  let hmsSum = 0;
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(a.tasks, f), "utf8"));
    if (fs.existsSync(path.join(a.out, `${t.task_id}.json`))) {
      const prev = JSON.parse(fs.readFileSync(path.join(a.out, `${t.task_id}.json`), "utf8"));
      if (typeof prev.hms === "number") {
        hmsSum += prev.hms;
        done += 1;
      }
      continue;
    }
    // 1) SOLVER
    const solvePrompt = [
      "You are a data-driven scientific discovery agent.",
      `The dataset file(s) ${t.datasets.join(", ")} are in the current directory.`,
      `Question: ${t.query}`,
      "Analyze the data (load and compute as needed) and state a concrete hypothesis that answers it: name the key variable(s), the relationship, and its direction/sign (and magnitude if relevant).",
      "Respond with ONLY one line: HYPOTHESIS: <one-sentence hypothesis>.",
    ].join(" ");
    const solveOut = codex(solvePrompt, t.dataset_dir, a.effort);
    const m = solveOut.match(/HYPOTHESIS:\s*(.+)/i);
    const predicted = (m ? m[1] : solveOut.trim().split("\n").filter(Boolean).pop() || "").slice(0, 600);

    // 2) JUDGE — graded Hypothesis Matching Score (DiscoveryBench methodology):
    // decompose into 3 facets, each 0..1; HMS = mean * 100.
    const judgePrompt = [
      "Score how well the PREDICTED hypothesis matches the GOLD for the question, on three facets, each a float 0.0-1.0:",
      "context_alignment (same scope/subpopulation/conditions), variable_alignment (same key variables), relationship_accuracy (same relationship type AND direction/sign; magnitude if stated).",
      "Be strict: partial agreement gets a partial score.",
      `Question: ${t.query}`,
      `Gold: ${t.gold.hypothesis}`,
      `Predicted: ${predicted}`,
      'Output ONLY JSON: {"context": <0-1>, "variables": <0-1>, "relationship": <0-1>}.',
    ].join(" ");
    const judgeOut = codex(judgePrompt, null, a.effort);
    let facets = { context: 0, variables: 0, relationship: 0 };
    const jm = judgeOut.match(/\{[\s\S]*?"context"[\s\S]*?\}/);
    if (jm) {
      try {
        const p = JSON.parse(jm[0]);
        facets = {
          context: Number(p.context) || 0,
          variables: Number(p.variables) || 0,
          relationship: Number(p.relationship) || 0,
        };
      } catch {}
    }
    const hms = ((facets.context + facets.variables + facets.relationship) / 3) * 100;
    hmsSum += hms;
    done += 1;
    fs.writeFileSync(
      path.join(a.out, `${t.task_id}.json`),
      JSON.stringify({ task_id: t.task_id, domain: t.domain, predicted, gold: t.gold.hypothesis, facets, hms: Math.round(hms * 10) / 10 }, null, 2) + "\n",
    );
    console.log(`[${done}/${files.length}] ${t.task_id} HMS=${hms.toFixed(1)} (c=${facets.context} v=${facets.variables} r=${facets.relationship})`);
  }
  const meanHms = done ? hmsSum / done : 0;
  console.log(`\nDiscoveryBench (codex solver + graded judge): mean HMS ${meanHms.toFixed(1)} over ${done} tasks -> ${a.out}`);
  console.log("SOTA (DB-Real, paper): best Reflexion(Oracle) GPT-4o 24.5%; ReAct/CodeGen/DataVoyager ~15%.");
}

main();
