#!/usr/bin/env node
"use strict";

// Baseline solver: answer LitQA2 multiple-choice questions with codex and write
// responses for run_litqa2.js. Runs in the codex-sandbox container (root, codex
// auth). This is a CLOSED-BOOK baseline (no literature retrieval) — LitQA2 is
// designed to require retrieval, so a closed-book LLM is expected to do poorly
// or abstain; that is itself a meaningful measurement.
//
//   node scripts/dev/solve_litqa2_codex.js --questions <dir> --out <dir> [--sample N] [--effort low]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "low", sample: 0, out: "evals/litqa2/_real/responses_codex" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--questions") a.questions = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
  }
  return a;
}
const LETTERS = "ABCDEFGHIJ".split("");

function main() {
  const a = parseArgs(process.argv);
  if (!a.questions) {
    console.error("usage: solve_litqa2_codex.js --questions <dir> --out <dir> [--sample N] [--effort low]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  let files = fs.readdirSync(a.questions).filter((f) => f.endsWith(".json")).sort();
  if (a.sample) files = files.slice(0, a.sample);
  console.log(`solving ${files.length} LitQA2 questions with codex (effort=${a.effort}, closed-book)`);

  let done = 0;
  for (const f of files) {
    const q = JSON.parse(fs.readFileSync(path.join(a.questions, f), "utf8"));
    const opts = q.options.map((o, i) => `${LETTERS[i]}. ${o}`).join("\n");
    const prompt = [
      "Answer the multiple-choice question. If the literature does not let you choose confidently, pick the 'Insufficient information' option.",
      `Question: ${q.question}`,
      `Options:\n${opts}`,
      "Respond with ONLY: Answer: <letter>",
    ].join("\n");
    const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${a.effort}" ${JSON.stringify(prompt)}`;
    let resp = "";
    const t0 = Date.now();
    try {
      resp = execSync(cmd, { encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      resp = (e.stdout || "").toString();
    }
    resp = resp.replace(/\x1b\[[0-9;]*m/g, "");
    fs.writeFileSync(path.join(a.out, `${q.id}.json`), JSON.stringify({ id: q.id, answer: resp }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${files.length}] ${q.id} ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`wrote ${done} responses -> ${a.out}`);
}

main();
