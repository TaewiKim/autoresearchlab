"use strict";

// Shared stage plumbing for the DABStep researchlab-pipeline solvers.
//
// The harness separates LLM planning lanes (codex, text out, read-only) from
// deterministic execution (the lab-runner validation driver). These helpers
// give benchmark solvers the same split: codexText() is the lane transport,
// runLabRunner() invokes the real drivers/analysis/python_stats.py driver on a
// role_plan.json carrying an analyst_handoff, and the extract*/digest helpers
// implement the file contracts between stages.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

// Append-only per-task event graph (MBM-style audit log): every lane output,
// execution, admission and gate decision is recorded with reason codes so the
// final answer is reconstructable from the events alone.
function auditEvent(taskDir, type, payload) {
  fs.mkdirSync(taskDir, { recursive: true });
  const p = path.join(taskDir, "events.jsonl");
  let seq = 0;
  try {
    seq = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {}
  const ev = { seq, ts: new Date().toISOString(), type, ...payload };
  fs.appendFileSync(p, JSON.stringify(ev) + "\n");
  return ev;
}

// Lane transport: codex plans only (read-only sandbox, text out). Prompt goes
// through a file + "$(cat ...)" so arbitrary feedback text can't break quoting.
function codexText(prompt, effort, scratchDir, name) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const pf = path.join(scratchDir, `${name || "prompt"}.txt`);
  fs.writeFileSync(pf, prompt);
  const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${effort}" "$(cat ${JSON.stringify(pf)})"`;
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" })
      .replace(/\x1b\[[0-9;]*m/g, "");
  } catch (e) {
    return ((e.stdout || "").toString()).replace(/\x1b\[[0-9;]*m/g, "");
  }
}

// Parse the last fenced ```json block (fallback: first {...} region).
function extractJsonBlock(text) {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fences.length ? fences : [text.slice(text.indexOf("{"))];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return { value: JSON.parse(candidates[i]) };
    } catch (e) {
      if (i === 0) return { error: `not valid JSON: ${e.message}` };
    }
  }
  return { error: "no JSON block found" };
}

// Analyst handoff: JSON contract; the blueprint code may come either escaped
// inside the JSON or as "@python-block" referencing a fenced ```python block
// (escaping a whole script into a JSON string is the main revision-loop churn).
function extractHandoff(text) {
  const parsed = extractJsonBlock(text);
  if (parsed.error) return { error: `handoff ${parsed.error}` };
  const obj = parsed.value;
  if (!obj || !Array.isArray(obj.validation_code_blueprints)) {
    return { error: "JSON parsed but missing validation_code_blueprints[]" };
  }
  const pyFences = [...text.matchAll(/```python\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let fenceIdx = 0;
  for (const bp of obj.validation_code_blueprints) {
    if ((!bp.code || bp.code === "@python-block") && fenceIdx < pyFences.length) {
      bp.code = pyFences[fenceIdx];
      fenceIdx += 1;
    }
  }
  if (obj.validation_code_blueprints.some((bp) => !bp.code || !String(bp.code).trim())) {
    return { error: "a blueprint has no code (neither escaped JSON string nor a ```python block)" };
  }
  return { handoff: obj };
}

// Lab-runner stage: the real validation driver consumes the role plan and
// executes the handoff blueprints (script.py + logs under blueprints/<check>/).
function runLabRunner(handoff, ctx, roundDir) {
  const rolePlanPath = path.join(roundDir, "role_plan.json");
  const labDir = path.join(roundDir, "lab");
  fs.mkdirSync(roundDir, { recursive: true });
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
  const observations = [];
  const candidates = [];
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
      if (m) {
        // Answer candidate with provenance: bound to THIS round's executed
        // blueprint (check id + script/stdout hashes), never to LLM text.
        candidates.push({
          check: d,
          // generous cap: ID-list answers can run to hundreds of items
          // (a 416-item list is ~2000 chars); a 300-char cap silently
          // truncated a fully correct answer
          answer: m[1].trim().slice(0, 8000),
          script_sha: sha16(read("script.py")),
          stdout_sha: sha16(stdout),
        });
      }
    }
  }
  let validation = null;
  const vp = path.join(labDir, "validation-summary.json");
  if (fs.existsSync(vp)) {
    try {
      validation = JSON.parse(fs.readFileSync(vp, "utf8"));
    } catch {}
  }
  // Admission gate (message-bound): admit only an unambiguous, provenance-bound
  // answer; otherwise deny with a reason code that goes back to the analyst.
  let answer = null;
  let admitted = null;
  let denial = null;
  const distinct = [...new Set(candidates.map((c) => c.answer.trim().toLowerCase()))];
  if (candidates.length === 0) {
    denial = observations.length ? "no_final_answer" : driverError ? "execution_failed" : "no_execution_output";
  } else if (distinct.length > 1) {
    denial = "conflicting_final_answers";
  } else {
    admitted = candidates[candidates.length - 1];
    answer = admitted.answer;
  }
  return { answer, admitted, candidates, denial, observations, validation, driverError };
}

function formatFeedback(result) {
  if (result.error) return `handoff rejected before execution: ${result.error}`;
  const parts = [];
  if (result.denial) parts.push(`answer admission DENIED, reason code: ${result.denial}${result.denial === "conflicting_final_answers" ? ` (your blueprints printed different FINAL ANSWER lines: ${JSON.stringify((result.candidates || []).map((c) => ({ check: c.check, answer: c.answer })))}; make exactly one blueprint print the single final answer)` : ""}`);
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

// Cheap mechanical context digest: file list + CSV headers + markdown TOCs.
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
    } else if (f.endsWith(".json")) {
      const raw = fs.readFileSync(p, "utf8");
      let shape = `${Math.round(raw.length / 1024)}KB`;
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v) && v.length) shape += `, array of ${v.length} objects with keys: ${Object.keys(v[0]).join(", ")}`;
        else if (v && typeof v === "object") shape += `, object with keys: ${Object.keys(v).slice(0, 25).join(", ")}`;
      } catch {}
      lines.push(`${f}: ${shape}`);
    }
  }
  return lines.join("\n");
}

// Scout retrieval mechanics: extract named "## ..." sections from a markdown
// manual (section = heading line until the next same-or-higher-level heading).
function extractManualSections(manualPath, wanted, capChars) {
  if (!fs.existsSync(manualPath)) return "";
  const text = fs.readFileSync(manualPath, "utf8");
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(#{1,3})\s+(.*)/);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = [];
  for (const w of wanted || []) {
    const wn = norm(w);
    const h = heads.find((x) => norm(x.title) === wn) || heads.find((x) => norm(x.title).includes(wn) || wn.includes(norm(x.title)));
    if (!h) continue;
    const next = heads.find((x) => x.line > h.line && x.level <= h.level);
    out.push(lines.slice(h.line, next ? next.line : lines.length).join("\n"));
  }
  return out.join("\n\n").slice(0, capChars || 12000);
}

function readJsonSample(p, maxItems) {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(v)) return JSON.stringify(v.slice(0, maxItems || 2), null, 1).slice(0, 3000);
    return JSON.stringify(v, null, 1).slice(0, 3000);
  } catch {
    return "";
  }
}

module.exports = {
  codexText,
  extractJsonBlock,
  extractHandoff,
  runLabRunner,
  formatFeedback,
  contextDigest,
  extractManualSections,
  readJsonSample,
  sha16,
  auditEvent,
};
