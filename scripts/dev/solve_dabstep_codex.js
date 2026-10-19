#!/usr/bin/env node
"use strict";

// Baseline solver: answer DABStep dev tasks with codex. Runs in the codex-sandbox
// container (root, codex auth). codex analyzes the shared context (payments.csv,
// fees.json, manual.md, ...) in --context-dir and answers per the task guidelines.
// Closed-form factoid; the response's "FINAL ANSWER:" line is captured.
//
//   node scripts/dev/solve_dabstep_codex.js --tasks <dev.jsonl> --context-dir <dir> \
//        --out <dir> [--sample N] [--effort low]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "low", sample: 0, sandbox: "read-only", out: "evals/dabstep/_real/responses_codex" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--context-dir") a.ctx = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
    else if (argv[i] === "--sandbox") a.sandbox = argv[++i];
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.ctx) {
    console.error("usage: solve_dabstep_codex.js --tasks <dev.jsonl> --context-dir <dir> --out <dir> [--sample N] [--effort low]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  let rows = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (a.sample) rows = rows.slice(0, a.sample);
  const files = fs.readdirSync(a.ctx).filter((f) => !f.startsWith("."));
  console.log(`solving ${rows.length} DABStep tasks with codex (effort=${a.effort})`);

  let done = 0;
  for (const t of rows) {
    if (fs.existsSync(path.join(a.out, `${t.task_id}.json`))) {
      done += 1;
      continue;
    }
    const prompt = [
      "You are a data-analysis agent with a working directory containing these files:",
      files.join(", ") + ".",
      "You MUST write Python (pandas) code to a file and RUN it to compute the answer from the actual data — do NOT guess or answer from memory.",
      "First read manual.md and payments-readme.md for the domain rules and the payments.csv schema, then load payments.csv (and fees.json / merchant_data.json / *.csv as needed) and compute.",
      "Verify your answer is consistent with the real values in the data (e.g. valid category values come from the columns themselves).",
      `Question: ${t.question}`,
      `Guidelines: ${t.guidelines || ""}`,
      "After running your code, end your response with exactly one line: FINAL ANSWER: <answer>",
    ].join(" ");
    // approval_policy=never lets non-interactive exec run code WITHIN the sandbox
    // (no interactive approval prompts) — the sandbox itself (workspace-write)
    // still confines writes to the workspace; this is not a sandbox bypass.
    const cmd = `codex exec --skip-git-repo-check --sandbox ${a.sandbox} -c approval_policy="never" -c model_reasoning_effort="${a.effort}" ${JSON.stringify(prompt)}`;
    let resp = "";
    const t0 = Date.now();
    try {
      resp = execSync(cmd, { cwd: a.ctx, encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      resp = (e.stdout || "").toString();
    }
    resp = resp.replace(/\x1b\[[0-9;]*m/g, "");
    const m = resp.match(/FINAL ANSWER:\s*(.+)/i);
    const answer = (m ? m[1] : resp.trim().split("\n").filter(Boolean).pop() || "").trim().slice(0, 300);
    fs.writeFileSync(path.join(a.out, `${t.task_id}.json`), JSON.stringify({ task_id: t.task_id, answer }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${rows.length}] ${t.task_id} (${t.level}) ${Math.round((Date.now() - t0) / 1000)}s -> ${answer.slice(0, 60)}`);
  }
  console.log(`wrote responses -> ${a.out}`);
}

main();
