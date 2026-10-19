"use strict";

// The research process, as text in the terminal.
//
//   researchlab follow --cycle-id <id> [--history <n>] [--interval <s>] [--once]
//
// Everything a cycle does is already written to disk as it happens: the
// scheduler's lane table (state/<cycle>-cycle-run-state.json), each lane's
// result, the lead the LabDirector selected, the gate's score history, the
// harness's notices and the maintainer's runs. This follows those files and
// prints one line per thing that happened -- a lane started or finished and
// what it found, the lead changed, the gate moved, the harness warned, the
// maintainer fixed something. It only reads; it can run beside a cycle, after
// one, or from another terminal, and stopping it changes nothing.

const fs = require("fs");
const path = require("path");
const { forEachLine } = require("../observability/segmented_log");

const DEFAULT_INTERVAL_SECONDS = 2;
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function oneLine(value, limit = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell !== ""));
  return (body || []).map((cells) => Object.fromEntries((header || []).map((name, column) => [name, cells[column] ?? ""])));
}

function shortNumber(value) {
  const number = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(number)) return String(value ?? "?");
  return Math.abs(number) >= 100 ? number.toFixed(1) : Number(number.toPrecision(4)).toString();
}

// ---------------------------------------------------------------------------
// What a finished lane found, in a line or three.

function laneOutput(result) {
  const extracted = result?.extracted_json;
  if (extracted && typeof extracted === "object") return extracted;
  try {
    return JSON.parse(String(result?.output_last_message || ""));
  } catch {
    return {};
  }
}

function runnerSummary(result) {
  const summary = result?.validation_summary || {};
  const lines = [];
  const parts = [];
  if (summary.blueprints_total !== undefined) parts.push(`${summary.blueprints_passed ?? 0}/${summary.blueprints_total} blueprints passed`);
  const contract = result?.analysis_contract_validation || summary.analysis_contract_validation;
  if (contract?.status) parts.push(`contract ${contract.status}${contract.evidence_role === "supporting" ? " (supporting audit)" : ""}`);
  if (result?.failure_category) parts.push(result.failure_category);
  lines.push(parts.join(" · ") || String(result?.status || ""));
  const table = (result?.blueprint_executions || []).flatMap((execution) => execution?.tables || [])
    .find((item) => item?.name === "primary_contrasts.csv" && item.path);
  if (table) {
    try {
      const rows = parseCsv(fs.readFileSync(table.path, "utf8"));
      for (const row of rows.slice(0, 3)) {
        const estimate = row.estimate === "" ? (row.status || "not estimable") : shortNumber(row.estimate);
        lines.push(`  ${oneLine(row.contrast_id, 70)} = ${estimate} [${shortNumber(row.simultaneous_lower)}, ${shortNumber(row.simultaneous_upper)}]`);
      }
      if (rows.length > 3) lines.push(`  (+${rows.length - 3} more contrasts in ${table.path})`);
    } catch {
      // A table that cannot be read is named, not shown.
    }
  }
  const failed = (result?.blueprint_executions || []).find((execution) => execution?.status === "failed" && execution.error);
  if (failed) lines.push(`  error: ${oneLine(failed.error, 160)}`);
  return lines;
}

function directorSummary(result) {
  const output = laneOutput(result);
  const lines = [];
  const decision = output.requery_decision || output.decision || output.decision_status;
  lines.push(`decision ${decision || "?"}${output.summary ? `: ${oneLine(output.summary, 220)}` : ""}`);
  if (output.rationale) lines.push(`  why: ${oneLine(output.rationale, 260)}`);
  const lead = output.selected_hypothesis?.statement;
  if (lead) lines.push(`  lead: ${oneLine(lead, 220)}`);
  for (const action of (output.next_actions || []).slice(0, 2)) {
    lines.push(`  next (${action.preferred_role || action.type || "?"}): ${oneLine(action.description, 180)}`);
  }
  return lines;
}

function gatekeeperSummary(result) {
  const output = laneOutput(result);
  const rubric = (output.rubric || [])
    .filter((item) => item && item.score !== undefined)
    .map((item) => `${item.name}=${item.score}`)
    .join(" ");
  const lines = [`verdict ${output.verdict || "?"}${rubric ? ` · ${rubric}` : ""}`];
  if (output.summary) lines.push(`  ${oneLine(output.summary, 240)}`);
  const objection = (output.major_objections || [])[0];
  if (objection) lines.push(`  objection: ${oneLine(typeof objection === "string" ? objection : objection.objection || JSON.stringify(objection), 200)}`);
  return lines;
}

function genericSummary(result, finalStatus) {
  const output = laneOutput(result);
  const text = output.summary || output.lab_director_validation_report?.summary || output.assessment || output.status_summary;
  const lines = [];
  if (text) lines.push(oneLine(text, 240));
  const reason = finalStatus?.failure_category || result?.failure_category;
  if (reason) lines.push(`  ${reason}`);
  return lines.length ? lines : [String(result?.status || finalStatus?.status || "")];
}

function finishedLaneLines(lane, laneDir) {
  const finalStatus = readJson(path.join(laneDir, "final-status.json")) || {};
  const result = readJson(finalStatus.result_path || path.join(laneDir, "result.json")) || readJson(path.join(laneDir, "result.json")) || {};
  const role = lane.role || "";
  if (role === "lab-runner") return runnerSummary(result);
  if (role === "lab-director") return directorSummary(result);
  if (role === "gatekeeper") return gatekeeperSummary(result);
  return genericSummary(result, finalStatus);
}

function startedLaneDetail(laneDir) {
  const plan = readJson(path.join(laneDir, "role-plan.json")) || {};
  const action = plan.action_type || "";
  const brief = plan.followup_description || plan.description || "";
  return [action, oneLine(brief, 160)].filter(Boolean).join(": ");
}

// ---------------------------------------------------------------------------
// Following files.

function createPrinter({ out = process.stdout, color = null, now = () => new Date() } = {}) {
  const useColor = color ?? (Boolean(out.isTTY) && !process.env.NO_COLOR);
  const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
  const tags = {
    start: ["36", "start"], done: ["32", "done "], fail: ["31", "fail "], abort: ["33", "abort"],
    lead: ["35;1", "lead "], gate: ["34;1", "gate "], note: ["33", "note "], maint: ["35", "maint"], cycle: ["1", "cycle"],
    wait: ["33;1", "wait "],
  };
  return (tag, head, lines = [], at = now()) => {
    const time = (at instanceof Date ? at : new Date(at)).toISOString().slice(11, 19);
    const [code, label] = tags[tag] || ["0", tag];
    out.write(`${paint("2", time)} ${paint(code, `[${label}]`)} ${head}\n`);
    for (const line of lines.filter(Boolean)) out.write(`                 ${line}\n`);
  };
}

// An append-only JSONL file, read from where the last read stopped.
function jsonlFollower(filePath, { fromStart = false } = {}) {
  let offset = fromStart ? 0 : fileSize(filePath);
  return () => {
    const records = [];
    if (fileSize(filePath) < offset) offset = 0; // rewritten
    offset = forEachLine(filePath, offset, (text) => {
      try {
        records.push(JSON.parse(text));
      } catch {
        // A line cut short is skipped; the next one stands alone.
      }
    });
    return records;
  };
}

function laneLine(print, lane, laneDir, previous) {
  const role = lane.role || "?";
  const status = String(lane.status || "");
  if (status === "running" && previous !== "running") {
    print("start", `${role} ${lane.lane_id}`, [startedLaneDetail(laneDir)]);
    return;
  }
  if (!TERMINAL_STATUSES.has(status) || TERMINAL_STATUSES.has(previous || "")) return;
  const tag = status === "completed" ? "done" : status === "failed" ? "fail" : "abort";
  print(tag, `${role} ${lane.lane_id}`, finishedLaneLines(lane, laneDir));
}

function leadKey(hypothesis) {
  const lead = hypothesis?.selected_hypothesis || hypothesis || {};
  return lead.statement ? `${hypothesis?.selected_at_epoch_ms || ""}|${lead.statement}` : "";
}

function leadLines(hypothesis) {
  const lead = hypothesis?.selected_hypothesis || hypothesis || {};
  const decision = hypothesis?.lab_director_decision || {};
  return [
    oneLine(lead.statement, 400),
    lead.dataset_or_accession || hypothesis?.dataset_or_accession ? `  data: ${lead.dataset_or_accession || hypothesis.dataset_or_accession}` : "",
    decision.lane_id ? `  by ${decision.lane_id} (${decision.requery_decision || "?"})` : "",
  ];
}

function gateLine(record) {
  const rubric = Object.entries(record?.rubric || {}).map(([name, score]) => `${name}=${score}`).join(" ");
  return [`score ${record?.score ?? "?"}${record?.pass ? " PASSED" : ""} · ${rubric} · ${record?.blockers ?? 0} blocker(s)`, ""];
}

function noticeLines(record) {
  const payload = record?.payload || {};
  const detail = payload.effect || payload.reason || payload.message || payload.objections || payload.lane_id || payload.handoff_path || "";
  return [oneLine(Array.isArray(detail) ? detail.join("; ") : typeof detail === "object" ? JSON.stringify(detail) : detail, 240)];
}

function followCycle({
  root,
  cycleId,
  history = 0,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  once = false,
  print = createPrinter(),
  shouldStop = () => false,
} = {}) {
  const statePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  const gateHistoryPath = path.join(root, "state", `${cycleId}-gate-review-history.jsonl`);
  const noticesPath = path.join(root, "events", `${cycleId}-harness-notices.jsonl`);
  const maintainerPath = path.join(root, "runtime", `${cycleId}-maintainer.json`);
  const pausePath = path.join(root, "state", `${cycleId}-labdirector-pause.json`);
  const lanesRoot = path.join(root, "lanes", cycleId);

  const state = readJson(statePath);
  const hypothesis = readJson(hypothesisPath);
  const counts = state?.lane_counts || {};
  print("cycle", `${cycleId}: ${state?.status || "not started"}`, [
    state ? `lanes ${counts.total ?? 0} · completed ${counts.completed ?? 0} · running ${counts.running ?? 0} · pending ${counts.pending ?? 0} · failed ${counts.failed ?? 0}` : `waiting for ${statePath}`,
  ]);
  if (leadKey(hypothesis)) print("lead", `current lead (${(hypothesis.selected_hypothesis || hypothesis).primary_family || "?"})`, leadLines(hypothesis));
  const lastGate = (() => {
    let last = null;
    forEachLine(gateHistoryPath, Math.max(0, fileSize(gateHistoryPath) - 64 * 1024), (text) => {
      try { last = JSON.parse(text); } catch { /* partial first line */ }
    });
    return last;
  })();
  if (lastGate) print("gate", "latest gate review", gateLine(lastGate), lastGate.ts || new Date());

  // Lanes already finished, newest last, when history is asked for.
  const seen = new Map();
  const lanes = Array.isArray(state?.lane_statuses) ? state.lane_statuses : [];
  const finished = lanes.filter((lane) => TERMINAL_STATUSES.has(String(lane.status || "")));
  const replay = new Set(history > 0
    ? finished
      .map((lane) => ({ lane, at: mtimeMs(path.join(lanesRoot, lane.lane_id, "final-status.json")) }))
      .sort((a, b) => a.at - b.at)
      .slice(-history)
      .map((item) => item.lane.lane_id)
    : []);
  for (const lane of lanes) {
    if (replay.has(lane.lane_id)) {
      laneLine(print, lane, path.join(lanesRoot, lane.lane_id), "pending");
    }
    seen.set(lane.lane_id, String(lane.status || ""));
  }

  const notices = jsonlFollower(noticesPath);
  const gates = jsonlFollower(gateHistoryPath);
  let stateMtime = mtimeMs(statePath);
  let lastLead = leadKey(hypothesis);
  let maintainerRuns = (readJson(maintainerPath)?.runs || []).length;
  let hypothesisMtime = mtimeMs(hypothesisPath);
  let pauseMtime = 0;
  let maintainerMtime = mtimeMs(maintainerPath);
  let lastGateKey = lastGate ? JSON.stringify([lastGate.score, lastGate.pass, lastGate.rubric]) : "";
  let lastCycleStatus = state?.status || "";

  const tick = () => {
    // Lanes: the scheduler's table, plus each open lane's own run state, so a
    // start is seen when it happens rather than at the next aggregation.
    const nextMtime = mtimeMs(statePath);
    const current = nextMtime !== stateMtime ? readJson(statePath) : null;
    if (current) {
      stateMtime = nextMtime;
      for (const lane of current.lane_statuses || []) {
        const previous = seen.get(lane.lane_id);
        const status = String(lane.status || "");
        if (previous !== status) laneLine(print, lane, path.join(lanesRoot, lane.lane_id), previous);
        seen.set(lane.lane_id, status);
      }
      if (current.status && current.status !== lastCycleStatus) {
        lastCycleStatus = current.status;
        const c = current.lane_counts || {};
        print("cycle", `${cycleId}: ${current.status}`, [`completed ${c.completed ?? 0} · running ${c.running ?? 0} · pending ${c.pending ?? 0} · failed ${c.failed ?? 0}`]);
      }
    }
    for (const [laneId, status] of seen) {
      if (status !== "pending" && status !== "prepared") continue;
      const runState = readJson(path.join(lanesRoot, laneId, "run-state.json"));
      if (runState?.status === "running") {
        const contract = readJson(path.join(lanesRoot, laneId, "lane-contract.json")) || {};
        laneLine(print, { lane_id: laneId, role: contract.role, status: "running" }, path.join(lanesRoot, laneId), status);
        seen.set(laneId, "running");
      }
    }

    // The cycle waiting on something: on the owner's choice, say what to type.
    const nextPause = mtimeMs(pausePath);
    if (nextPause && nextPause !== pauseMtime) {
      pauseMtime = nextPause;
      const pause = readJson(pausePath) || {};
      if (pause.block_type === "owner_selection") {
        print("wait", "the cycle is waiting for you to choose the problem it pursues", [
          `researchlab candidates --cycle-id ${cycleId}`,
          `researchlab select --cycle-id ${cycleId} --candidate <candidate-id> --note "why"`,
          pause.auto_proceed_at ? `(without a choice it proceeds on its own at ${pause.auto_proceed_at})` : "",
        ]);
      } else if (pause.status === "blocked" || pause.block_type) {
        print("wait", `the cycle is paused: ${pause.block_type || "blocked"}`, [oneLine(pause.reason, 240), pause.resume_condition ? oneLine(`to resume: ${pause.resume_condition}`, 240) : ""]);
      }
    }

    if (mtimeMs(hypothesisPath) !== hypothesisMtime) {
      hypothesisMtime = mtimeMs(hypothesisPath);
      const nextHypothesis = readJson(hypothesisPath);
      const key = leadKey(nextHypothesis);
      if (key && key !== lastLead) {
        lastLead = key;
        print("lead", `lead changed (${(nextHypothesis.selected_hypothesis || nextHypothesis).primary_family || "?"})`, leadLines(nextHypothesis));
      }
    }

    for (const record of gates()) {
      const gateKey = JSON.stringify([record.score, record.pass, record.rubric]);
      if (gateKey === lastGateKey) continue;
      lastGateKey = gateKey;
      print("gate", record.pass ? "gate PASSED" : "gate review", gateLine(record), record.ts || new Date());
    }

    for (const record of notices()) {
      print("note", record.event_type || record.event || "notice", noticeLines(record), record.ts || new Date());
    }

    if (mtimeMs(maintainerPath) !== maintainerMtime) {
      maintainerMtime = mtimeMs(maintainerPath);
      const runs = readJson(maintainerPath)?.runs || [];
      for (const run of runs.slice(maintainerRuns)) {
        if (!run.finished_at) continue; // reported when it has an outcome
        print("maint", `${run.verdict || run.outcome || "run"}: ${oneLine(run.commit_title || run.signature, 160)}`, [run.reason ? oneLine(run.reason, 240) : ""], run.finished_at);
        maintainerRuns += 1;
      }
    }
  };

  if (once) {
    tick();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (shouldStop()) {
        clearInterval(timer);
        tick();
        resolve();
        return;
      }
      try {
        tick();
      } catch (error) {
        process.stderr.write(`follow: ${error.message}\n`);
      }
    }, Math.max(0.2, intervalSeconds) * 1000);
  });
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function runFollowCommand(argv, { cwd = process.cwd() } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  if (!cycleId) throw new Error("follow requires --cycle-id <id>");
  const root = path.resolve(readFlag(argv, "--root") || path.join(cwd, ".research-lab"));
  const history = Number(readFlag(argv, "--history") || 0);
  const intervalSeconds = Number(readFlag(argv, "--interval") || DEFAULT_INTERVAL_SECONDS);
  // Started by run-research: stop when it is gone.
  const parentPid = Number(readFlag(argv, "--parent-pid") || 0);
  const shouldStop = parentPid ? () => !processAlive(parentPid) : () => false;
  await followCycle({ root, cycleId, history, intervalSeconds, once: argv.includes("--once"), shouldStop });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

module.exports = {
  followCycle,
  createPrinter,
  runFollowCommand,
  __private: { directorSummary, gatekeeperSummary, runnerSummary, parseCsv },
};
