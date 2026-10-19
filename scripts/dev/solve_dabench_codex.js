#!/usr/bin/env node
"use strict";

// Baseline solver: answer DABench questions with codex (the harness's LLM) and
// write closed-form responses for scoring by run_dabench.js. Runs inside the
// codex-sandbox container (needs codex auth, root). Each question is one codex
// exec in the CSV directory; the response text is captured verbatim (the adapter
// extracts @name[value] markers from it).
//
//   node scripts/dev/solve_dabench_codex.js --questions <dir> --csv-root <da-dev-tables> \
//        --out <responses dir> [--sample N] [--effort low]
//
// --sample N (stratified by level) bounds cost; codex at xhigh is ~minutes/Q, so
// use low effort + a small sample. Responses are written incrementally so a
// partial run is still scorable.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "low", sample: 0, out: "evals/dabench/_real/responses_codex" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--questions") a.questions = argv[++i];
    else if (argv[i] === "--csv-root") a.csvRoot = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
  }
  return a;
}

function stratifiedSample(files, dir, n) {
  if (!n) return files;
  const byLevel = {};
  for (const f of files) {
    const q = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    (byLevel[q.level || "unknown"] = byLevel[q.level || "unknown"] || []).push(f);
  }
  const levels = Object.keys(byLevel).sort();
  const per = Math.max(1, Math.floor(n / levels.length));
  const out = [];
  for (const lvl of levels) out.push(...byLevel[lvl].slice(0, per));
  return out.slice(0, n);
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.questions || !a.csvRoot) {
    console.error("usage: solve_dabench_codex.js --questions <dir> --csv-root <dir> --out <dir> [--sample N] [--effort low]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  const all = fs.readdirSync(a.questions).filter((f) => f.endsWith(".json")).sort();
  const files = stratifiedSample(all, a.questions, a.sample);
  console.log(`solving ${files.length}/${all.length} questions with codex (effort=${a.effort})`);

  let done = 0;
  for (const f of files) {
    const q = JSON.parse(fs.readFileSync(path.join(a.questions, f), "utf8"));
    const id = q.id || path.basename(f, ".json");
    const prompt = [
      "You are a data-analysis agent.",
      `The file ${q.file_name} is in the current directory.`,
      `Question: ${q.question}`,
      q.constraints ? `Constraints: ${q.constraints}` : "",
      `Respond with ONLY the answer marker(s) in this exact format: ${q.format}`,
    ]
      .filter(Boolean)
      .join(" ");
    const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${a.effort}" ${JSON.stringify(prompt)}`;
    let resp = "";
    const t0 = Date.now();
    try {
      resp = execSync(cmd, { cwd: a.csvRoot, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      resp = (e.stdout || "").toString() || `__error__ ${e.message}`;
    }
    resp = resp.replace(/\x1b\[[0-9;]*m/g, "");
    fs.writeFileSync(path.join(a.out, `${id}.json`), JSON.stringify({ id, response: resp }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${files.length}] ${id} (${q.level}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`wrote ${done} responses -> ${a.out}`);
}

main();
