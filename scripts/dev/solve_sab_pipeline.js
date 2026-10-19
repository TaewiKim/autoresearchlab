#!/usr/bin/env node
"use strict";

// ScienceAgentBench solver via the researchlab analyst->lab-runner loop.
//
//   ANALYST (codex, read-only): writes a COMPLETE standalone Python program for
//     the task, given the instruction, domain knowledge, dataset folder tree and
//     preview. The program reads the task's dataset under the benchmark dir and
//     writes its output to pred_results/<output_fname> (SAB's contract).
//   LAB-RUNNER: executes the program with `conda run -n sci-agent-eval python`
//     from the benchmark working dir, observes exit code / stderr / whether the
//     expected output file appeared.
//   OBSERVE/REVISE: on failure (non-zero exit, missing output) the traceback is
//     fed back to the analyst, which revises — the SAB "self-debug" loop, capped
//     at --rounds.
//
// The "answer" admitted per task is the program PLUS proof it ran and produced
// the output file (provenance: program sha + exit code + output-file sha),
// recorded in an append-only events.jsonl. Scoring is done separately by SAB's
// own eval scripts (Success Rate / Valid Execution Rate).
//
//   node scripts/dev/solve_sab_pipeline.js --tasks <tasks.jsonl> \
//       --bench-dir /tmp/sab/benchmark --out <dir> --ids 1,11,21 [--rounds 3] [--effort medium]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { codexText, extractJsonBlock, sha16, auditEvent } = require("./dabstep_stage_lib");

function parseArgs(argv) {
  const a = { effort: "medium", rounds: 3, conda: "sci-agent-eval", out: "evals/sab/_real/pred_pipeline" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--bench-dir") a.bench = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--ids") a.ids = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--rounds") a.rounds = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
    else if (argv[i] === "--conda") a.conda = argv[++i];
  }
  return a;
}

function extractProgram(text) {
  const blocks = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks[blocks.length - 1];
  return null;
}

// MBM-style admission checks (deterministic, no LLM): the active message is
// the authorization context — an artifact is only admitted if it is bound to
// what the message actually names.
//
// 1) named-tool binding: if task_inst/domain_knowledge names a library
//    ("the X library", `X` backticked module-ish tokens), the program must
//    import/use it — a silent fallback to a substitute source is an
//    unauthorized-source admission (deny with reason code).
function namedToolViolations(t, code) {
  const text = `${t.task_inst || ""}\n${t.domain_knowledge || ""}`;
  const named = new Set();
  for (const m of text.matchAll(/(?:the\s+|from\s+the\s+)?`?([A-Za-z][A-Za-z0-9_.-]{2,})`?\s+(?:library|package|toolkit)/gi)) named.add(m[1].toLowerCase());
  for (const m of text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) named.add(m[1].toLowerCase());
  const generic = new Set(["python", "the", "this", "csv", "json", "pandas", "numpy", "data", "file", "shap"]);
  const out = [];
  for (const n of named) {
    if (generic.has(n)) continue;
    const base = n.split(".")[0].replace(/-/g, "_");
    if (!new RegExp(`(import|from)\\s+${base}|pip[^\\n]*install[^\\n]*${n}`, "i").test(code)) out.push(n);
  }
  return out;
}

// 2) message-stated schema binding: explicit format fragments in the
//    instruction (quoted "A; B; C" / "A, B, C" header-like strings) must
//    appear in the produced text output's header.
function schemaViolations(t, outPath) {
  const inst = String(t.task_inst || "");
  const hints = [...inst.matchAll(/["“]([A-Za-z][A-Za-z0-9 _]*(?:\s*[;,]\s*[A-Za-z][A-Za-z0-9 _]*){1,})["”]/g)].map((m) => m[1]);
  if (!hints.length || !fs.existsSync(outPath) || !/\.(csv|txt|tsv)$/i.test(outPath)) return [];
  const head = fs.readFileSync(outPath, "utf8").slice(0, 2000).toLowerCase();
  const out = [];
  for (const h of hints) {
    const cols = h.split(/[;,]/).map((s) => s.trim().toLowerCase()).filter((s) => s && !/^\d+$/.test(s));
    if (cols.length >= 2) {
      const missing = cols.filter((c) => !head.includes(c.replace(/\s+/g, " ").split(" ")[0]));
      if (missing.length) out.push(`instruction states format "${h}" but output header lacks: ${missing.join(", ")}`);
    }
  }
  return out;
}

// Scout retrieval over the LOCAL corpus: the dataset folder often ships the
// intended implementation as .py modules (gold imports them). Surface their
// import paths + def/class signatures + docstrings so the analyst calls them
// instead of reinventing — the SAB analog of DABStep's manual-section scout.
function scoutDatasetScripts(t, bench) {
  const top = (t.dataset_folder_tree || "").split("\n")[0].replace(/^[|\-\s]+/, "").replace(/\/$/, "").trim();
  if (!top) return "";
  const root = path.join(bench, "datasets", top);
  if (!fs.existsSync(root)) return "";
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || found.length > 40) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== "__pycache__") walk(fp, depth + 1);
      else if (e.name.endsWith(".py") && e.name !== "__init__.py") found.push(fp);
    }
  };
  walk(root, 0);
  if (!found.length) return "";
  const parts = [];
  for (const fp of found.slice(0, 12)) {
    const rel = path.relative(bench, fp).replace(/\.py$/, "").replace(/[/\\]/g, ".");
    const src = fs.readFileSync(fp, "utf8");
    const sigs = [...src.matchAll(/^(?:def|class)\s+[A-Za-z_][\w]*\s*\([^)]*\)?[^:]*:/gm)].map((m) => m[0].trim()).slice(0, 12);
    if (sigs.length) parts.push(`# module: ${rel}\n${sigs.join("\n")}`);
  }
  return parts.join("\n\n").slice(0, 4000);
}

function buildPrompt(t, round, feedback, shippedScripts) {
  const base = [
    `Active task: ScienceAgentBench instance ${t.instance_id} (${t.domain}). This applies to this task only.`,
    "You are the ANALYST lane of the researchlab harness. Write ONE complete, standalone Python program that solves the task; a separate lab-runner executes it and reports back.",
    "",
    "Hard requirements for the program:",
    "- It runs from the benchmark working directory. The task dataset is under `benchmark/datasets/` exactly as shown in the dataset tree below; read from there with relative paths.",
    `- It MUST create the output file at exactly: ${t.output_fname} (create its directory if needed).`,
    "- Set any randomness seed for determinism. Keep runtime modest (CPU).",
    "- Print concise progress so the lab-runner report is informative; the LAST line on success must be exactly: DONE",
    "",
    "USE THE DOMAIN'S SOURCE OF TRUTH (do not reimplement methods from scratch):",
    "- If the dataset folder tree contains Python scripts/modules (.py under the dataset), they ARE the intended implementation — import and call them (their package path is `benchmark.datasets.<...>.<module>`), do not rewrite their logic.",
    "- If the task instruction or domain knowledge names a specific library or method (e.g. a named feature generator, a named model family, a named filtering tool), use THAT library; its outputs (column names, schema, conventions) are what the result is checked against. A hand-rolled equivalent will produce non-canonical column names/values and fail.",
    "- You MAY install a needed package at the very top of the program: `import subprocess,sys; subprocess.run([sys.executable,'-m','pip','install','-q','<pkg>'],check=False)` before importing it. Prefer the exact library the domain uses over a generic substitute.",
    "- Match the OUTPUT SCHEMA the task implies: if a canonical library/standard defines the columns or table layout (e.g. standard descriptor names), emit exactly those; do not invent ad-hoc column names.",
    "- A FILTERING task selects ROWS — it must preserve the input's full column set (plus any column the task/domain text references, e.g. a classification or organism field used as a filter key). Never drop columns when only row-filtering is asked.",
    "",
    `Task instruction:\n${t.task_inst}`,
    t.domain_knowledge ? `\nDomain knowledge:\n${String(t.domain_knowledge).slice(0, 4000)}` : "",
    `\nDataset folder tree:\n${t.dataset_folder_tree}`,
    t.dataset_preview ? `\nDataset preview:\n${String(t.dataset_preview).slice(0, 3000)}` : "",
    shippedScripts ? `\nScout — dataset-shipped modules (import and call these; this is the intended implementation, do not reinvent):\n${shippedScripts}` : "",
  ];
  if (round > 0 && feedback) {
    base.push("", `--- Lab-runner report from your previous program (round ${round}) ---`, feedback, "Revise the full program to fix this. Output the complete program again.");
  }
  base.push("", "Respond with ONLY one fenced ```python code block containing the complete program.");
  return base.join("\n");
}

function runProgram(code, bench, conda, outFname, roundDir) {
  const progPath = path.join(roundDir, "pred_program.py");
  fs.mkdirSync(roundDir, { recursive: true });
  fs.writeFileSync(progPath, code);
  // SAB contract: programs run from the repo root (parent of benchmark/), read
  // benchmark/datasets/... and write pred_results/... — output_fname already
  // carries the pred_results/ prefix. Run a copy there; clean stale output.
  const work = path.dirname(bench);
  const runProg = path.join(work, "_rl_pred_program.py");
  fs.copyFileSync(progPath, runProg);
  const outPath = path.join(work, outFname);
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch {}
  let exitCode = 0;
  let output = "";
  try {
    output = execSync(`conda run -n ${conda} python -u _rl_pred_program.py`, {
      cwd: work,
      encoding: "utf8",
      timeout: 1800000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    exitCode = e.status || 1;
    output = `${(e.stdout || "").toString()}\n[STDERR]\n${(e.stderr || "").toString()}`;
  }
  const produced = fs.existsSync(outPath);
  let outSha = null;
  if (produced) {
    outSha = sha16(fs.readFileSync(outPath));
    // Preserve the produced output next to the program for the SAB scorer.
    fs.copyFileSync(outPath, path.join(roundDir, path.basename(outFname)));
  }
  try {
    fs.unlinkSync(runProg);
  } catch {}
  return { exitCode, output: output.slice(-8000), produced, outSha, progSha: sha16(code) };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.bench) {
    console.error("usage: solve_sab_pipeline.js --tasks <jsonl> --bench-dir <dir> --out <dir> --ids 1,11 [--rounds 3] [--effort medium]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  // tasks.jsonl was written by pandas and contains bare NaN tokens (invalid
  // JSON); replace them with null before parsing each line.
  const parseLine = (l) => JSON.parse(l.replace(/:\s*NaN\s*([,}])/g, ": null$1"));
  let rows = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map(parseLine);
  if (a.ids) rows = rows.filter((r) => a.ids.includes(String(r.instance_id)));
  console.log(`solving ${rows.length} SAB tasks via analyst->lab-runner (effort=${a.effort}, rounds<=${a.rounds})`);

  let done = 0;
  for (const t of rows) {
    const respPath = path.join(a.out, `${t.instance_id}.json`);
    if (fs.existsSync(respPath)) {
      done += 1;
      continue;
    }
    const taskDir = path.join(a.out, `work_${t.instance_id}`);
    const t0 = Date.now();
    const shippedScripts = scoutDatasetScripts(t, a.bench);
    if (shippedScripts) auditEvent(taskDir, "scout_dataset_scripts", { instance_id: t.instance_id, bytes: shippedScripts.length });
    let feedback = null;
    let success = false;
    let roundsUsed = 0;
    let prov = null;
    for (let r = 0; r < a.rounds; r += 1) {
      roundsUsed = r + 1;
      const roundDir = path.join(taskDir, `round_${r}`);
      fs.mkdirSync(roundDir, { recursive: true });
      const out = codexText(buildPrompt(t, r, feedback, shippedScripts), a.effort, roundDir, "analyst_prompt");
      const code = extractProgram(out);
      auditEvent(taskDir, "analyst_program", { instance_id: t.instance_id, round: r, ok: Boolean(code), prog_sha: code ? sha16(code) : null });
      if (!code) {
        feedback = "no python code block found in your response";
        continue;
      }
      const res = runProgram(code, a.bench, a.conda, t.output_fname, roundDir);
      auditEvent(taskDir, "lab_runner_exec", { instance_id: t.instance_id, round: r, exit_code: res.exitCode, produced_output: res.produced, prog_sha: res.progSha, out_sha: res.outSha });
      if (res.exitCode === 0 && res.produced) {
        // MBM admission gates: artifact must be bound to what the active
        // message names (tool provenance + stated output schema), else deny
        // with reason codes and send back for revision.
        const toolViol = namedToolViolations(t, code);
        const schemaViol = schemaViolations(t, path.join(path.dirname(a.bench), t.output_fname));
        auditEvent(taskDir, "mbm_admission", { instance_id: t.instance_id, round: r, named_tool_violations: toolViol, schema_violations: schemaViol });
        if (toolViol.length || schemaViol.length) {
          feedback = [
            "Your program ran, but ADMISSION WAS DENIED (message-binding violations):",
            toolViol.length ? `- named_tool_not_used: the task/domain text names [${toolViol.join(", ")}] but your program neither imports nor installs them. Use the named tool — do not substitute.` : "",
            ...schemaViol.map((s) => `- schema_mismatch: ${s}`),
            "Fix and resubmit the complete program.",
          ].filter(Boolean).join("\n");
          continue;
        }
        success = true;
        prov = { round: r, prog_sha: res.progSha, out_sha: res.outSha };
        // Save the admitted program for SAB scoring (pred_programs/<gold_name>).
        fs.writeFileSync(path.join(a.out, t.gold_program_name), code);
        break;
      }
      feedback = `exit_code=${res.exitCode}; produced_output_file=${res.produced}\nprogram stdout/stderr (tail):\n${res.output}`;
    }
    fs.writeFileSync(respPath, JSON.stringify({ instance_id: t.instance_id, gold_program_name: t.gold_program_name, output_fname: t.output_fname, success_exec: success, rounds: roundsUsed, provenance: prov }, null, 2) + "\n");
    auditEvent(taskDir, "final", { instance_id: t.instance_id, success_exec: success, provenance: prov });
    done += 1;
    console.log(`[${done}/${rows.length}] inst ${t.instance_id} (${t.domain}) ${Math.round((Date.now() - t0) / 1000)}s rounds=${roundsUsed} exec=${success ? "ok" : "FAIL"}`);
  }
  console.log(`wrote -> ${a.out} (programs named by gold_program_name for SAB scoring)`);
}

main();
