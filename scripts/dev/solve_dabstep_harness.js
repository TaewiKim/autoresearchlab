#!/usr/bin/env node
"use strict";

// DABStep solver using the researchlab analysis loop: codex PLANS (emits a
// Python blueprint as text, read-only sandbox), the researchlab blueprint
// executor RUNS it (scripts/dev/run_blueprint_dabstep.py -> _run_blueprint),
// the loop OBSERVES executed stdout/stderr and REVISES on failure — the same
// plan->run->observe->iterate split the analyst->lab-runner stages use in a
// cycle. The answer is taken ONLY from the executed script's stdout (a
// "FINAL ANSWER:" line), so it cannot be an unexecuted LLM guess.
//
//   node scripts/dev/solve_dabstep_harness.js --tasks <dev.jsonl> \
//        --context-dir <dir> --out <dir> [--sample N] [--effort medium] \
//        [--rounds 4]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "medium", sample: 0, rounds: 4, out: "evals/dabstep/_real/responses_harness" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--context-dir") a.ctx = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
    else if (argv[i] === "--rounds") a.rounds = Number(argv[++i]);
  }
  return a;
}

// codex is the PLANNER only: read-only sandbox, text out. Prompt goes through a
// temp file + "$(cat ...)" so arbitrary feedback text can't break shell quoting.
function codexPlan(prompt, effort, scratchDir) {
  const pf = path.join(scratchDir, "prompt.txt");
  fs.writeFileSync(pf, prompt);
  const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${effort}" "$(cat ${JSON.stringify(pf)})"`;
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" })
      .replace(/\x1b\[[0-9;]*m/g, "");
  } catch (e) {
    return ((e.stdout || "").toString()).replace(/\x1b\[[0-9;]*m/g, "");
  }
}

function extractCode(text) {
  const blocks = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

// Run one blueprint through the researchlab executor; returns its JSON result.
function runBlueprint(code, ctx, outRoot, checkId) {
  const codeFile = path.join(outRoot, "blueprint.py");
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(codeFile, code);
  const cmd = [
    "python3", "scripts/dev/run_blueprint_dabstep.py",
    "--code-file", codeFile,
    "--csv-root", ctx,
    "--out-root", outRoot,
    "--check-id", checkId,
    "--timeout", "240",
  ].join(" ");
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    return { status: "runner_error", stdout: "", stderr: String(e.stderr || e.message).slice(-2000) };
  }
}

function contextDigest(ctx) {
  const files = fs.readdirSync(ctx).filter((f) => !f.startsWith("."));
  const lines = [`Files in the data directory: ${files.join(", ")}.`];
  for (const f of files) {
    const p = path.join(ctx, f);
    if (f.endsWith(".csv")) {
      const header = fs.readFileSync(p, "utf8").slice(0, 2000).split("\n")[0];
      lines.push(`${f} columns: ${header}`);
    } else if (f.endsWith(".md")) {
      const heads = fs.readFileSync(p, "utf8").split("\n").filter((l) => /^#{1,3} /.test(l)).slice(0, 40);
      lines.push(`${f} sections: ${heads.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(t, digest, round, prev) {
  const base = [
    "You are the planning half of a data-analysis agent loop. You write a Python script; a separate executor runs it against the real data and shows you its stdout/stderr; you revise across rounds.",
    "Rules for the script:",
    "- Read the data directory from the environment variable RESEARCHLAB_CSV_ROOT (the executor also passes --csv-root/--output-dir/--check-file argv; ignore argv).",
    "- Use pandas/json/re from the standard stack. Print any intermediate facts you need to see.",
    "- NEVER print a guessed or hardcoded answer: the final answer must be computed from the loaded data. If domain rules are needed, parse them from manual.md / fees.json in the data directory.",
    "- manual.md is the source of truth for domain definitions (fraud metrics, fee rules, etc.). When a question term is ambiguous (e.g. 'top X for fraud' could be count or rate), locate and use the manual's definition rather than picking an interpretation; print the manual passage you relied on.",
    "- If the question depends on a concept the manual and data do NOT define (no applicable rule exists), do not invent a proxy: when the guidelines allow it, the computed conclusion should be FINAL ANSWER: Not Applicable.",
    `- When (and only when) the computed answer is ready, make the script's LAST printed line exactly: FINAL ANSWER: <answer formatted per the guidelines>`,
    "- If you still need to inspect data before answering, print what you need this round and end stdout with the line CONTINUE (you will get another round).",
    "",
    `Data context:\n${digest}`,
    "",
    `Question: ${t.question}`,
    `Answer guidelines: ${t.guidelines || ""}`,
  ];
  if (round > 0 && prev) {
    base.push(
      "",
      `--- Round ${round} feedback from the executor (your previous script's result) ---`,
      `status: ${prev.status}${prev.error ? `; error: ${prev.error}` : ""}`,
      prev.stdout ? `stdout (tail):\n${prev.stdout}` : "stdout: (empty)",
      prev.stderr ? `stderr (tail):\n${prev.stderr}` : "",
      "Revise the script accordingly.",
    );
  }
  base.push("", "Respond with ONLY one fenced ```python code block containing the complete script.");
  return base.join("\n");
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.ctx) {
    console.error("usage: solve_dabstep_harness.js --tasks <dev.jsonl> --context-dir <dir> --out <dir> [--sample N] [--effort medium] [--rounds 4]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  let rows = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (a.sample) rows = rows.slice(0, a.sample);
  const digest = contextDigest(a.ctx);
  console.log(`solving ${rows.length} DABStep tasks via researchlab analysis loop (effort=${a.effort}, rounds<=${a.rounds})`);

  let done = 0;
  for (const t of rows) {
    const respPath = path.join(a.out, `${t.task_id}.json`);
    if (fs.existsSync(respPath)) {
      done += 1;
      continue;
    }
    const taskDir = path.join(a.out, `work_${t.task_id}`);
    const t0 = Date.now();
    let answer = "";
    let prev = null;
    let roundsUsed = 0;
    for (let r = 0; r < a.rounds; r += 1) {
      roundsUsed = r + 1;
      const roundDir = path.join(taskDir, `round_${r}`);
      fs.mkdirSync(roundDir, { recursive: true });
      const planOut = codexPlan(buildPrompt(t, digest, r, prev), a.effort, roundDir);
      const code = extractCode(planOut);
      if (!code) {
        prev = { status: "no_code", stdout: "", stderr: "planner returned no python code block" };
        continue;
      }
      const exec = runBlueprint(code, a.ctx, roundDir, `dabstep-${t.task_id}-r${r}`);
      prev = exec;
      const m = (exec.stdout || "").match(/FINAL ANSWER:\s*(.+)\s*$/i);
      if (m && exec.status === "completed") {
        answer = m[1].trim().slice(0, 300);
        break;
      }
    }
    fs.writeFileSync(respPath, JSON.stringify({ task_id: t.task_id, answer, rounds: roundsUsed, executed: prev ? prev.status : null }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${rows.length}] ${t.task_id} (${t.level}) ${Math.round((Date.now() - t0) / 1000)}s rounds=${roundsUsed} -> ${answer.slice(0, 60) || "(no answer)"}`);
  }
  console.log(`wrote responses -> ${a.out}`);
}

main();
