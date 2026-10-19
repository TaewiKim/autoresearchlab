#!/usr/bin/env node
"use strict";

// DABStep solver using the REAL researchlab analyst->lab-runner pipeline:
//
//   1. ANALYST (codex, read-only): emits the harness handoff contract — a JSON
//      object with handoff_checks[] + validation_code_blueprints[] (the same
//      shape src/agents/analyst/query_plan.js mandates and
//      _find_analyst_handoff()/_collect_blueprints() consume).
//   2. LAB-RUNNER: drivers/analysis/python_stats.py --role-plan-file — the
//      actual validation driver a cycle lane runs — executes the blueprints
//      (script.py + stdout/stderr logs under blueprints/<check_id>/).
//   3. OBSERVE/REVISE: failed checks (validation-summary.json, stderr) are fed
//      back to the analyst, which resubmits a revised handoff — the
//      lab-runner->analyst resubmission loop, capped at --rounds.
//
// The answer is taken ONLY from an executed blueprint's stdout ("FINAL
// ANSWER:" line), never from analyst text.
//
//   node scripts/dev/solve_dabstep_analyst.js --tasks <dev.jsonl> \
//        --context-dir <dir> --out <dir> [--sample N] [--effort medium] [--rounds 4]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "medium", sample: 0, rounds: 4, out: "evals/dabstep/_real/responses_analyst" };
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

// Analyst lane transport: codex plans only (read-only sandbox, text out).
// Prompt goes through a file + "$(cat ...)" so feedback text can't break quoting.
function codexAnalyst(prompt, effort, scratchDir) {
  const pf = path.join(scratchDir, "analyst_prompt.txt");
  fs.writeFileSync(pf, prompt);
  const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${effort}" "$(cat ${JSON.stringify(pf)})"`;
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" })
      .replace(/\x1b\[[0-9;]*m/g, "");
  } catch (e) {
    return ((e.stdout || "").toString()).replace(/\x1b\[[0-9;]*m/g, "");
  }
}

function extractHandoff(text) {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fences.length ? fences : [text.slice(text.indexOf("{"))];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && Array.isArray(obj.validation_code_blueprints)) return { handoff: obj };
      return { error: "JSON parsed but missing validation_code_blueprints[]" };
    } catch (e) {
      if (i === 0) return { error: `handoff is not valid JSON: ${e.message}` };
    }
  }
  return { error: "no JSON handoff found in analyst output" };
}

// Lab-runner stage: the real validation driver consumes the role plan.
function runLabRunner(handoff, ctx, roundDir) {
  const rolePlanPath = path.join(roundDir, "role_plan.json");
  const labDir = path.join(roundDir, "lab");
  fs.writeFileSync(rolePlanPath, JSON.stringify({ lane_id: "dabstep-analyst", analyst_handoff: handoff }, null, 2));
  let driverError = null;
  try {
    execSync(
      ["python3", "drivers/analysis/python_stats.py", "--csv-root", ctx, "--output-dir", labDir, "--role-plan-file", rolePlanPath].join(" "),
      { encoding: "utf8", timeout: 420000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    driverError = String(e.stderr || e.message).slice(-2000);
  }
  // Observe executed blueprints: stdout/stderr logs + validation summary.
  const observations = [];
  let answer = null;
  const bpRoot = path.join(labDir, "blueprints");
  if (fs.existsSync(bpRoot)) {
    for (const d of fs.readdirSync(bpRoot)) {
      const read = (f) => {
        const p = path.join(bpRoot, d, f);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      };
      const stdout = read("stdout.log");
      const stderr = read("stderr.log");
      observations.push({ check: d, stdout: stdout.slice(-6000), stderr: stderr.slice(-3000) });
      const m = stdout.match(/FINAL ANSWER:\s*(.+)\s*$/im);
      if (m) answer = m[1].trim().slice(0, 300);
    }
  }
  let validation = null;
  const vp = path.join(labDir, "validation-summary.json");
  if (fs.existsSync(vp)) {
    try {
      validation = JSON.parse(fs.readFileSync(vp, "utf8"));
    } catch {}
  }
  return { answer, observations, validation, driverError };
}

function contextDigest(ctx) {
  const files = fs.readdirSync(ctx).filter((f) => !f.startsWith("."));
  const lines = [`Files in the data directory: ${files.join(", ")}.`];
  for (const f of files) {
    const p = path.join(ctx, f);
    if (f.endsWith(".csv")) {
      lines.push(`${f} columns: ${fs.readFileSync(p, "utf8").slice(0, 2000).split("\n")[0]}`);
    } else if (f.endsWith(".md")) {
      const heads = fs.readFileSync(p, "utf8").split("\n").filter((l) => /^#{1,3} /.test(l)).slice(0, 40);
      lines.push(`${f} sections: ${heads.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

function buildAnalystPrompt(t, digest, round, feedback) {
  const checkId = `dabstep-${t.task_id}`;
  const base = [
    "You are the ANALYST lane of the researchlab harness. You do not run code yourself: you emit a structured handoff and the lab-runner validation driver executes your blueprints against the real data, then reports results back to you for revision.",
    "",
    "Emit a handoff as ONE fenced ```json block with exactly this shape:",
    "```",
    `{"summary": "<one line>",`,
    ` "handoff_checks": [{"check_id": "${checkId}", "outcome": "<what the check establishes>", "success_criteria": {"description": "script prints a FINAL ANSWER computed from the data"}}],`,
    ` "validation_code_blueprints": [{"blueprint_id": "bp-${checkId}", "check_id": "${checkId}", "language": "python", "code": "<COMPLETE runnable python script as one JSON string (escape newlines)>"}]}`,
    "```",
    "",
    "Blueprint code rules (the lab-runner executes it verbatim):",
    "- Read the data directory from the environment variable RESEARCHLAB_CSV_ROOT (the driver also passes --csv-root/--output-dir/--check-file argv; ignore argv).",
    "- Use pandas/json/re. Print intermediate facts you will want to see in the execution report.",
    "- NEVER print a guessed or hardcoded answer: the final answer must be computed from the loaded data. Parse domain rules from manual.md / fees.json in the data directory when needed.",
    "- manual.md is the source of truth for domain definitions (fraud metrics, fee rules, etc.). When a question term is ambiguous (e.g. 'top X for fraud' could be count or rate), locate and use the manual's definition rather than picking an interpretation; print the manual passage you relied on.",
    "- If the question depends on a concept the manual and data do NOT define (no applicable rule exists), do not invent a proxy: when the guidelines allow it, the computed conclusion should be FINAL ANSWER: Not Applicable.",
    "- When (and only when) the computed answer is ready, make the script's LAST printed line exactly: FINAL ANSWER: <answer formatted per the guidelines>",
    "- If you still need to inspect data first, print what you need and end stdout with the line CONTINUE; the lab-runner report will show you the output for your next handoff.",
    "",
    `Data context:\n${digest}`,
    "",
    `Question: ${t.question}`,
    `Answer guidelines: ${t.guidelines || ""}`,
  ];
  if (round > 0 && feedback) {
    base.push("", `--- Lab-runner report for your previous handoff (round ${round}) ---`, feedback, "Submit a revised handoff accordingly.");
  }
  base.push("", "Respond with ONLY the fenced ```json handoff block.");
  return base.join("\n");
}

function formatFeedback(result) {
  if (result.error) return `handoff rejected before execution: ${result.error}`;
  const parts = [];
  if (result.driverError) parts.push(`driver error: ${result.driverError}`);
  for (const o of result.observations || []) {
    parts.push(`check ${o.check} stdout (tail):\n${o.stdout || "(empty)"}`);
    if (o.stderr) parts.push(`check ${o.check} stderr (tail):\n${o.stderr}`);
  }
  if (result.validation && result.validation.checks) {
    parts.push(`validation summary: ${JSON.stringify(result.validation.checks).slice(0, 1500)}`);
  }
  return parts.join("\n\n").slice(0, 12000) || "(no execution output)";
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.ctx) {
    console.error("usage: solve_dabstep_analyst.js --tasks <dev.jsonl> --context-dir <dir> --out <dir> [--sample N] [--effort medium] [--rounds 4]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  let rows = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (a.sample) rows = rows.slice(0, a.sample);
  const digest = contextDigest(a.ctx);
  console.log(`solving ${rows.length} DABStep tasks via analyst->lab-runner pipeline (effort=${a.effort}, rounds<=${a.rounds})`);

  let done = 0;
  for (const t of rows) {
    const respPath = path.join(a.out, `${t.task_id}.json`);
    if (fs.existsSync(respPath)) {
      done += 1;
      continue;
    }
    const t0 = Date.now();
    let answer = "";
    let feedback = null;
    let roundsUsed = 0;
    for (let r = 0; r < a.rounds; r += 1) {
      roundsUsed = r + 1;
      const roundDir = path.join(a.out, `work_${t.task_id}`, `round_${r}`);
      fs.mkdirSync(roundDir, { recursive: true });
      const analystOut = codexAnalyst(buildAnalystPrompt(t, digest, r, feedback), a.effort, roundDir);
      const extracted = extractHandoff(analystOut);
      if (extracted.error) {
        feedback = formatFeedback(extracted);
        continue;
      }
      const result = runLabRunner(extracted.handoff, a.ctx, roundDir);
      feedback = formatFeedback(result);
      if (result.answer && !/^continue$/i.test(result.answer)) {
        answer = result.answer;
        break;
      }
    }
    fs.writeFileSync(respPath, JSON.stringify({ task_id: t.task_id, answer, rounds: roundsUsed }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${rows.length}] ${t.task_id} (${t.level}) ${Math.round((Date.now() - t0) / 1000)}s rounds=${roundsUsed} -> ${answer.slice(0, 60) || "(no answer)"}`);
  }
  console.log(`wrote responses -> ${a.out}`);
}

main();
