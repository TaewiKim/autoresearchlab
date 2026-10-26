"use strict";

// The maintainer: the supervisor's self-healing, extended to the harness code.
//
// healCycleOnce resets lane state; it never edits code and never lifts a pause.
// When the thing blocking a cycle is a bug in the harness itself -- a watchdog
// that misreads a log tail, a scheduler that starves the one lane everything
// waits on, a marker read mid-rewrite -- resetting lanes only replays the bug,
// and until now a person had to diagnose it, patch it, commit, rebuild and
// resume. Every one of those was the same shape of work:
//
//   2224a9c  a mid-line log tail paused cycle-b-20260918 as a setup failure
//   8f99d52  converted literature scouts pinned to a weak model
//   8089666  an engineer lane starved by the awaited-role promotion
//   326857d  duplicate engineer lanes from a stale lane index
//   67850c8  a sandbox marker read mid-rewrite paused the cycle
//
// This module does that work between run-plan calls, so nothing holds the
// native binary and a pause cannot block it. One Codex run diagnoses and, when
// the blocker is a harness bug, makes the smallest fix plus a regression test.
// Nothing the agent says is trusted. The agent works in a private, detached git
// worktree of HEAD (under <top>/.maintainer-worktrees/<cycle>/<run>), never in
// the main working tree; its changes are exactly `git status` of that worktree,
// because nothing else writes there. The orchestrator checks them against an
// allow-list and the test-count rules, runs the three suites in the worktree
// against the same failures at a clean HEAD worktree, builds the release binary
// there, commits in the worktree and only then fast-forwards the main branch to
// that commit -- refusing if any touched path has local changes in the main
// tree. A rejected run discards the worktree; the main tree was never touched.
//
// The agent itself runs in Docker (researchlab:local) when an image is
// configured, with the repository mounted read-only and only its worktree and
// run directory writable; see resolveVenue.
//
// Opt-in with RESEARCHLAB_MAINTAINER=1.
//
// The native harness still has its own supervisor_engineering_bugfix lane. It
// cannot help with the cases above: it is an ordinary lane, so it queues behind
// every other pending lane and cannot launch at all while the cycle is paused
// (followup-supervisor-01 on cycle-b-20260918, created 12:37, never ran),
// and it has no gate, commit, rebuild or resume path.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { codexSubscriptionEnvironment } = require("../policy/research_api");
const { nativeBuildEnv } = require("../runtime/native_runtime");
const { clearTerminationCode, readTerminationCode, writeTerminationCode } = require("../reporting/termination_code");
const { healCycleOnce } = require("./self_healing_cycle");
const { deriveProgress, recordProgress, stallFindings, supervisorConfig, progressPath } = require("./cycle_progress");
const { budgetPath, updateBudget } = require("./cycle_budget");
const { HEALTH_KIND, pipelineHealthFindings, writeHealthReport } = require("./pipeline_health");
const { repairQueuedAnalystContracts } = require("../policy/analysis_contract");
const { codexLoginRevoked, readCodexLoginRequired, recordCodexLoginRequired } = require("./codex_login");

const DEFAULT_MODEL = "gpt-5.6-sol";
// The supervisor's attempts are limited per WEEK, not per cycle. A cycle runs for
// weeks and finds new defects all along; a total fixed at the start leaves it
// unattended for the rest of its life once spent.
// MEASURED ON cycle-a-20260919, 2026-10-26: the lifetime cap (100) was
// spent on 2026-10-19 (4, 8, 43, 15, 27 and 3 runs in the weeks to then), and for
// the following week every finding the supervisor raised -- 11 of them, among
// them work set aside again and again for one reason -- went unattended.
// The last two full weeks used 15 and 27; the week of 43 is the runaway to bound.
const DEFAULT_MAX_RUNS = 30;
const MAX_RUNS_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_TIMEOUT_SECONDS = 45 * 60;
const DEFAULT_MAX_DIFF_LINES = 400;
// Rebases of an accepted-in-the-worktree fix onto a HEAD that moved during the
// run (see rebaseCandidate).
const DEFAULT_REBASE_ATTEMPTS = 2;
const REPEATED_FAILURE_THRESHOLD = 3;
const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD"]);
const NATIVE_MANIFEST = "native/researchlab-harness/Cargo.toml";
const MAINTAINER_TARGET_DIR = "native/researchlab-harness/target-maintainer";
// Beside the package, inside the Docker mount (the git top level), gitignored.
const WORKTREES_DIR = ".maintainer-worktrees";
const CONTAINER_ROOT = "/work";
const CONTAINER_AUTH_PATH = "/root/.codex/auth.json";
const VENUES = new Set(["host", "docker"]);

// Paths relative to the package root. Everything else -- manifests, lockfiles,
// docs, the launcher, .research-lab data -- is out of the maintainer's reach.
const ALLOWED_PATH_PREFIXES = [
  "native/researchlab-harness/src/",
  "src/",
  "drivers/",
  "scripts/",
  "tests/",
];

// Pauses that are real waits, not plumbing: the provider's quota resets on its
// own clock, and a researcher's /pause is a person's decision. So is the owner
// checkpoint of the expert problem selection (labdirector::problem_selection):
// lead selection waits for the owner to pick a candidate, and nothing is broken.
// A spent budget is the same shape: the cycle is not broken, it has run out of
// what the owner gave it, and only the owner decides whether to give it more.
const WAITING_PAUSE_BLOCK_TYPES = new Set(["provider_quota", "owner_selection", "budget_exhausted", "supervisor_cap_reached"]);

const BUDGET_TERMINATION_CODE = "CYCLE_BUDGET_EXHAUSTED";
const CAP_TERMINATION_CODE = "SUPERVISOR_RUNS_EXHAUSTED";

// Stops the harness caused. Approval, gate and scientific completion codes are
// outcomes of the research and are never the maintainer's business.
const HARNESS_STOP_CODES = new Set([
  "RUNTIME_SETUP_BLOCKED",
  "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK",
]);
const NON_HARNESS_STOP_CATEGORIES = new Set(["gate_passed", "provider_quota"]);

const VERDICTS = ["harness_bug_fixed", "not_a_harness_bug", "environment_block", "could_not_fix"];

// Codex passes this through OpenAI's strict JSON-schema mode: every property is
// required and objects are closed (see chat_agent.js).
const OUTPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "summary",
    "root_cause",
    "files_changed",
    "tests_added",
    "clears_pause",
    "commit_title",
  ],
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    summary: { type: "string" },
    root_cause: { type: "string" },
    files_changed: { type: "array", items: { type: "string" } },
    tests_added: { type: "array", items: { type: "string" } },
    clears_pause: { type: "boolean" },
    commit_title: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// small helpers

function nowIso(deps) {
  return new Date(deps?.now ? deps.now() : Date.now()).toISOString();
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonlRow(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function sha1OfFile(filePath) {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function shortHash(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 12);
}

function clip(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 15))}… [truncated]`;
}

function clipTail(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `[truncated] …${value.slice(value.length - limit)}`;
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message || ""}\n${value.stack || ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// The last `maxBytes` of a file, starting at a line boundary.
//
// MEASURED ON cycle-b-20260918, 2026-09-18 (2224a9c): a tail that began in
// the middle of a JSONL line lost the prefix that said what the line was, and a
// classifier read an agent's prose as a runtime error. A tail read here drops
// its partial first line for the same reason.
function readTail(filePath, maxBytes) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return "";
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function tailLines(filePath, count, maxBytes = 64 * 1024) {
  return readTail(filePath, maxBytes).split(/\r?\n/).filter((line) => line.trim()).slice(-count);
}

// Numbers, hashes, paths and timestamps differ between two lanes that hit the
// same bug; the words around them do not.
function normalizeErrorText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s"'`]+/g, "<path>")
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function maintainerConfig(env = process.env) {
  const positive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const nonNegativeInteger = (raw, fallback) => {
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    enabled: env.RESEARCHLAB_MAINTAINER === "1",
    push: env.RESEARCHLAB_MAINTAINER_PUSH === "1",
    restart: env.RESEARCHLAB_MAINTAINER_RESTART !== "0",
    // Runs allowed in any rolling seven days. RESEARCHLAB_MAINTAINER_MAX_RUNS,
    // the old total over the cycle's life, is no longer read.
    maxRuns: positive(env.RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK, DEFAULT_MAX_RUNS),
    timeoutSeconds: positive(env.RESEARCHLAB_MAINTAINER_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    maxDiffLines: positive(env.RESEARCHLAB_MAINTAINER_MAX_DIFF_LINES, DEFAULT_MAX_DIFF_LINES),
    // 0 turns rebasing off: a moved HEAD rejects the run, as it used to.
    rebaseAttempts: nonNegativeInteger(env.RESEARCHLAB_MAINTAINER_REBASE_ATTEMPTS, DEFAULT_REBASE_ATTEMPTS),
    model: String(env.RESEARCHLAB_MAINTAINER_MODEL || DEFAULT_MODEL).trim(),
    python: String(env.RESEARCHLAB_MAINTAINER_PYTHON || "python").trim(),
    // host | docker; unset means docker when an image is configured.
    venue: VENUES.has(String(env.RESEARCHLAB_MAINTAINER_VENUE || "").trim().toLowerCase())
      ? String(env.RESEARCHLAB_MAINTAINER_VENUE).trim().toLowerCase()
      : "",
    dockerImage: String(env.RESEARCHLAB_MAINTAINER_DOCKER_IMAGE || env.RESEARCHLAB_SCOUT_DOCKER_IMAGE || "").trim(),
    dockerCmd: String(env.RESEARCHLAB_MAINTAINER_DOCKER_CMD || "docker").trim() || "docker",
    dockerMount: String(env.RESEARCHLAB_MAINTAINER_DOCKER_MOUNT || "").trim(),
  };
}

// ---------------------------------------------------------------------------
// paths and persisted state

function researchRoot(cwd) {
  return path.join(cwd, ".research-lab");
}

function statePath({ cwd, cycleId }) {
  return path.join(researchRoot(cwd), "runtime", `${cycleId}-maintainer.json`);
}

function eventsPath({ cwd, cycleId }) {
  return path.join(researchRoot(cwd), "events", `${cycleId}-maintainer.jsonl`);
}

function pauseMarkerPaths({ cwd, cycleId }) {
  return [
    path.join(researchRoot(cwd), "state", `${cycleId}-labdirector-pause.json`),
    // The native harness still writes a legacy copy for its older callers.
    path.join(researchRoot(cwd), "runtime", `${cycleId}-labdirector-pause.json`),
  ];
}

function terminationPath({ cwd, cycleId }) {
  return path.join(researchRoot(cwd), "state", `${cycleId}-termination-code.json`);
}

function logEvent({ cwd, cycleId, deps }, eventType, payload = {}) {
  const row = { ts: nowIso(deps), cycle_id: cycleId, event_type: eventType, payload };
  try {
    appendJsonlRow(eventsPath({ cwd, cycleId }), row);
  } catch {
    // Logging must never be the thing that stops a cycle.
  }
  return row;
}

function loadState({ cwd, cycleId, deps }) {
  const existing = safeReadJson(statePath({ cwd, cycleId }));
  if (existing && typeof existing === "object") {
    existing.runs = Array.isArray(existing.runs) ? existing.runs : [];
    existing.attempted_signatures = Array.isArray(existing.attempted_signatures)
      ? existing.attempted_signatures
      : [];
    return existing;
  }
  // The first time the maintainer looks at a cycle, lanes that finished before
  // it was switched on are history: a relaunch after a human fix must not spend
  // the maintainer's budget re-diagnosing what that human already dealt with.
  // Pauses and stops are current state and are still seen.
  const state = {
    cycle_id: cycleId,
    created_at: nowIso(deps),
    lane_watermark: nowIso(deps),
    runs: [],
    attempted_signatures: [],
    in_progress: null,
    cap_reached_logged: false,
  };
  saveState({ cwd, cycleId }, state);
  return state;
}

function saveState({ cwd, cycleId }, state) {
  writeJsonFile(statePath({ cwd, cycleId }), state);
}

// ---------------------------------------------------------------------------
// triggers

function laneRoleOf(laneDir, laneId) {
  const contract = safeReadJson(path.join(laneDir, "lane-contract.json"))
    || safeReadJson(path.join(laneDir, "contract.json"))
    || {};
  if (contract.role) return String(contract.role);
  const match = /^(?:followup-)?([a-z]+(?:-[a-z]+)*?)-\d+/.exec(laneId);
  return match ? match[1] : "unknown";
}

function laneCompletedAtMs(laneDir, finalStatus) {
  const declared = Date.parse(finalStatus?.completed_at || finalStatus?.finished_at || "");
  if (Number.isFinite(declared)) return declared;
  try {
    return fs.statSync(path.join(laneDir, "final-status.json")).mtimeMs;
  } catch {
    return 0;
  }
}

// Only what the RUNTIME reported about the failure. result.json also carries
// the agent's own output, and an agent reading papers about schemas, quotas or
// timeouts is not a harness failure -- the lesson self_healing_cycle.js records
// three times over.
function runtimeReportedErrorText(finalStatus, result) {
  const pick = (source) => {
    if (!source || typeof source !== "object") return [];
    return ["status", "failure_category", "error", "warning", "block_type", "returncode", "timed_out", "stalled_stream"]
      .filter((key) => source[key] !== undefined && source[key] !== null && source[key] !== "")
      // MEASURED ON cycle-a-20260919, 2026-09-20. Four clean scout
      // envelopes hashed `returncode=0 timed_out=false stalled_stream=false`
      // as the same runtime error and raised a repeated-failure maintainer run.
      .filter((key) => key !== "returncode" || Number(source[key]) !== 0)
      .filter((key) => !["timed_out", "stalled_stream"].includes(key) || source[key] === true)
      .map((key) => `${key}=${textOf(source[key])}`);
  };
  // MEASURED ON cycle-a-20260919, 2026-10-17: scouts 314, 461,
  // and 514 all exited cleanly after recovering from an apply_patch tool
  // rejection. Their retained diagnostic stderr was identical, so the
  // maintainer grouped three different literature outcomes as one runtime
  // failure even though returncode=0 and neither timeout flag was set.
  const cleanExit = Number(result?.returncode) === 0
    && result?.timed_out !== true
    && result?.stalled_stream !== true;
  return [
    ...pick(finalStatus),
    ...pick(result),
    result?.stderr && !cleanExit ? `stderr=${clipTail(textOf(result.stderr), 2000)}` : "",
  ].filter(Boolean).join(" ");
}

// Errors the analysis driver itself recorded while executing a lane's checks.
// These are execution reports, not the agent's prose, and a lane can finish
// `completed` with every check dead in them.
//
// MEASURED ON cycle-b-20260918, 2026-09-19. followup-runner-70..76 all
// finished `completed` with blueprint_executions[0].error "ValueError: handoff
// check requires a non-empty column_mapping", no tables and no metrics. Seven
// runners in a row produced no evidence and the maintainer, reading only
// `failed` lanes and top-level errors, never saw it.
function executionReportedErrors(result) {
  const errors = [];
  const collect = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item && typeof item === "object" && item.error !== undefined && item.error !== null && item.error !== "") {
        errors.push(textOf(item.error));
      }
    }
  };
  collect(result?.blueprint_executions);
  collect(result?.analysis_trace?.blueprints);
  return [...new Set(errors)];
}

function completedExecutionProducedEvidence(result) {
  return String(result?.status || "") === "completed"
    && (Array.isArray(result?.blueprint_executions) ? result.blueprint_executions : [])
      .some((item) => item?.status === "completed" && !item?.error);
}

// Port of infrastructure_bug_signature in
// native/researchlab-harness/src/labdirector/recovery/supervisor_recovery.rs,
// kept literal (every needle of an entry must be present) so the two agree.
const INFRASTRUCTURE_SIGNATURES = [
  ["missing-executable", ["no such file or directory", "os error 2"]],
  ["command-not-found", ["command not found", "not found"]],
  ["codex-version-mismatch", ["requires a newer version of codex", "codex"]],
  ["filesystem-cleanup-race", ["enotempty", "directory not empty"]],
  ["schema-contract-error", ["schema", "additionalproperties"]],
  ["runtime-panic", ["thread '", "panicked"]],
  ["invalid-config", ["invalid config", "unrecognized key"]],
];

function infrastructureBugSignature(text) {
  const haystack = String(text || "").toLowerCase();
  for (const [signature, needles] of INFRASTRUCTURE_SIGNATURES) {
    if (needles.every((needle) => haystack.includes(needle))) return signature;
  }
  if (haystack.includes("enoent") || haystack.includes("failed to run")) return "process-launch-failure";
  return null;
}

function listFinishedLanes({ cwd, cycleId }) {
  const lanesRoot = path.join(researchRoot(cwd), "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(lanesRoot);
  } catch {
    return [];
  }
  const lanes = [];
  for (const laneId of entries) {
    const laneDir = path.join(lanesRoot, laneId);
    const finalStatus = safeReadJson(path.join(laneDir, "final-status.json"));
    if (!finalStatus) continue;
    lanes.push({
      lane_id: laneId,
      lane_dir: laneDir,
      final_status: finalStatus,
      completed_at_ms: laneCompletedAtMs(laneDir, finalStatus),
    });
  }
  return lanes;
}

function readPauseMarker({ cwd, cycleId }) {
  for (const markerPath of pauseMarkerPaths({ cwd, cycleId })) {
    const marker = safeReadJson(markerPath);
    if (marker) return { path: markerPath, marker };
  }
  return null;
}

function pauseIsPlumbing(marker) {
  if (!marker || typeof marker !== "object") return false;
  if (WAITING_PAUSE_BLOCK_TYPES.has(String(marker.block_type || ""))) return false;
  // A researcher's /pause (cycle_control.rs write_pause_marker) has no
  // block_type and source "researcher".
  if (!marker.block_type && String(marker.source || "") === "researcher") return false;
  return true;
}

function isHarnessStop(termination) {
  if (termination?.should_stop !== true) return false;
  if (NON_HARNESS_STOP_CATEGORIES.has(String(termination.category || ""))) return false;
  return HARNESS_STOP_CODES.has(String(termination.code || ""));
}

// Every reason the maintainer might act on right now, most urgent first.
//
// `progress` is the pipeline position (cycle_progress.js). Passing it in avoids
// deriving it twice per pass; omitting it derives it here, so a caller that
// only cares about the error-shaped triggers keeps working unchanged.
function detectTriggers({ cwd, cycleId, error = null, state, progress = null, supervisor = null, now = Date.now() }) {
  const triggers = [];

  if (error) {
    const firstLines = textOf(error).split(/\r?\n/).filter((line) => line.trim()).slice(0, 3).join(" ");
    triggers.push({
      kind: "native_exception",
      signature: `native_exception:${shortHash(normalizeErrorText(firstLines))}`,
      detail: clip(textOf(error), 8000),
      lane_ids: [],
    });
  }

  const pause = readPauseMarker({ cwd, cycleId });
  if (pause && pauseIsPlumbing(pause.marker)) {
    const marker = pause.marker;
    // Two false pauses of one block_type have been two different bugs (67850c8
    // and 2224a9c were both windows_sandbox_setup), so the evidence is part of
    // the signature, not only the type.
    triggers.push({
      kind: "pause",
      signature: [
        "pause",
        marker.block_type || "unspecified",
        marker.phase || "",
        shortHash(normalizeErrorText(marker.evidence || marker.reason || "")),
      ].join(":"),
      detail: clip(marker.reason || "", 2000),
      pause_marker_path: pause.path,
      lane_ids: marker.lane_id ? [String(marker.lane_id)] : [],
    });
  }

  const termination = readTerminationCode({ cwd, cycleId });
  // A pause writes its own stop code; that is one blocker, not two.
  if (!triggers.some((item) => item.kind === "pause") && isHarnessStop(termination)) {
    const laneIds = [];
    if (termination.metadata?.lane_id) laneIds.push(String(termination.metadata.lane_id));
    for (const item of Array.isArray(termination.metadata?.lane_failure_diagnostics)
      ? termination.metadata.lane_failure_diagnostics.slice(0, 6)
      : []) {
      if (item?.lane_id) laneIds.push(String(item.lane_id));
    }
    triggers.push({
      kind: "termination",
      signature: `termination:${termination.code}:${shortHash(normalizeErrorText(termination.reason || ""))}`,
      detail: clip(termination.reason || "", 2000),
      lane_ids: [...new Set(laneIds)],
    });
  }

  const watermarkMs = Date.parse(state?.lane_watermark || "") || 0;
  const lanes = listFinishedLanes({ cwd, cycleId });
  const laneIdSet = new Set(lanes.map((lane) => lane.lane_id));
  const groups = new Map();
  const latestEvidenceExecutionByRole = new Map();
  for (const lane of lanes) {
    if (lane.completed_at_ms <= watermarkMs) continue;
    const status = String(lane.final_status.status || "");
    const result = safeReadJson(path.join(lane.lane_dir, "result.json")) || {};
    const role = laneRoleOf(lane.lane_dir, lane.lane_id);
    if (status === "completed") {
      const executionErrors = executionReportedErrors(result);
      if (executionErrors.length) {
        const category = "completed_with_execution_error";
        const key = `${role}|${category}|${shortHash(normalizeErrorText(executionErrors.join(" ")))}`;
        if (!groups.has(key)) groups.set(key, { role, category, lanes: [], latest_at_ms: 0 });
        const group = groups.get(key);
        group.lanes.push(lane.lane_id);
        group.latest_at_ms = Math.max(group.latest_at_ms, lane.completed_at_ms);
      } else if (completedExecutionProducedEvidence(result)) {
        latestEvidenceExecutionByRole.set(
          role,
          Math.max(latestEvidenceExecutionByRole.get(role) || 0, lane.completed_at_ms),
        );
      }
      continue;
    }
    if (status !== "failed") continue;
    const category = String(lane.final_status.failure_category || result.failure_category || "failed");
    const errorText = runtimeReportedErrorText(lane.final_status, result);
    const normalizedError = normalizeErrorText(errorText.replace(/failure_category=\S+|status=\S+/g, ""));
    // MEASURED ON cycle-b-20260918, 2026-09-18: three expected literature
    // review handoffs had no runtime error and collided on the empty-string hash.
    if (normalizedError) {
      const errorSignature = shortHash(normalizedError);
      const key = `${role}|${category}|${errorSignature}`;
      if (!groups.has(key)) groups.set(key, { role, category, lanes: [] });
      groups.get(key).lanes.push(lane.lane_id);
    }

    // A recovery lane that failed on the same infrastructure signature, with no
    // further recovery after it, is a chain the lane-level healer has given up
    // on: whatever the bug is, retrying did not route around it.
    const recovery = /^(.*)-recovery-(\d+)$/.exec(lane.lane_id);
    if (recovery) {
      const next = `${recovery[1]}-recovery-${String(Number(recovery[2]) + 1).padStart(recovery[2].length, "0")}`;
      const infra = infrastructureBugSignature(errorText);
      if (infra && !laneIdSet.has(next)) {
        triggers.push({
          kind: "recovery_exhausted",
          signature: `recovery_exhausted:${role}:${infra}`,
          detail: `${lane.lane_id} failed with infrastructure signature ${infra} and no further recovery lane exists`,
          lane_ids: [recovery[1], lane.lane_id],
        });
      }
    }
  }
  for (const [key, group] of groups) {
    if (group.lanes.length < REPEATED_FAILURE_THRESHOLD) continue;
    // MEASURED ON cycle-a-20260919, 2026-09-30: runners 67-70
    // retained one pre-fix dataset-routing error forever, even after later
    // runners completed error-free blueprints. That history is no longer a
    // current clog; a strictly later evidence-producing execution retires it.
    if (group.category === "completed_with_execution_error"
      && (latestEvidenceExecutionByRole.get(group.role) || 0) > group.latest_at_ms) continue;
    triggers.push({
      kind: "repeated_failure",
      signature: `repeated_failure:${key}`,
      detail: group.category === "completed_with_execution_error"
      ? `${group.lanes.length} ${group.role} lanes finished completed but their executions all recorded the same error, producing no evidence`
      : `${group.lanes.length} ${group.role} lanes failed with ${group.category} and the same runtime-reported error since the maintainer was enabled`,
      lane_ids: group.lanes.slice(-8),
    });
  }

  // A cycle that is running and failing nothing, but not MOVING. Nothing above
  // can see this shape: MEASURED ON cycle-a-20260919, 2026-09-20, the
  // lead was recorded at 15:02:55 local and for the next 5h38m the milestone
  // did not change while 40 lanes finished, most of them `completed`. Derived
  // last because a pause or a stop explains a stall and should be diagnosed as
  // itself.
  // runMaintainer passes the recorded model (whose reached_at is pinned across
  // passes). Deriving here keeps this function read-only for any other caller.
  const stallProgress = progress || deriveProgress({ cwd, cycleId, now });
  for (const finding of stallFindings({
    progress: stallProgress,
    config: supervisor || supervisorConfig(),
    now,
  })) {
    triggers.push({ ...finding, lane_ids: finding.lane_ids || [] });
  }

  // Defects that do not stop the cycle: work wasted or something false written
  // while it runs (see pipeline_health.js). Last in line -- anything that holds
  // the pipeline is diagnosed first -- and windowed from when the supervisor
  // began watching for them, so history fixed before then is not re-diagnosed.
  const healthSince = Date.parse(state?.health_watermark || "") || now;
  // A defect whose fix was accepted is judged on what happened after the fix.
  const fixedAt = {};
  for (const run of Array.isArray(state?.runs) ? state.runs : []) {
    const at = Date.parse(run?.finished_at || "");
    if (run?.outcome === "accepted" && run.signature && at) fixedAt[run.signature] = Math.max(fixedAt[run.signature] || 0, at);
  }
  for (const finding of pipelineHealthFindings({ cwd, cycleId, sinceMs: healthSince, now, fixedAt })) {
    triggers.push({ ...finding, lane_ids: finding.lane_ids || [] });
  }

  // A pause first: when one stands, a native exception in the same pass is
  // usually its consequence (the self-healer stops retrying on a setup block).
  const priority = [
    "pause",
    "native_exception",
    "termination",
    "recovery_exhausted",
    "repeated_failure",
    "no_milestone_progress",
    "no_evidence",
    "lane_churn",
    HEALTH_KIND,
  ];
  triggers.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
  return triggers;
}

// ---------------------------------------------------------------------------
// evidence

function lastAgentMessage(laneDir) {
  const fromFile = readTail(path.join(laneDir, "output-last-message.txt"), 6000)
    || readTail(path.join(laneDir, "output-last-message.md"), 6000);
  if (fromFile.trim()) return clipTail(fromFile.trim(), 4000);
  const lines = tailLines(path.join(laneDir, "stdout.log"), 200, 256 * 1024);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        return clipTail(String(event.item.text || ""), 4000);
      }
    } catch {
      // A bare CLI line; not an agent message.
    }
  }
  return null;
}

function laneEvidence({ cwd, cycleId, laneId }) {
  const laneDir = path.join(researchRoot(cwd), "lanes", cycleId, laneId);
  if (!fs.existsSync(laneDir)) return { lane_id: laneId, missing: true };
  const result = safeReadJson(path.join(laneDir, "result.json"));
  const resultExcerpt = result && typeof result === "object"
    ? Object.fromEntries(
        ["status", "failure_category", "error", "warning", "block_type", "returncode", "timed_out",
          "stalled_stream", "degraded", "driver", "execution_venue", "recommended_actions"]
          .filter((key) => result[key] !== undefined)
          .map((key) => [key, typeof result[key] === "string" ? clip(result[key], 2000) : boundedJson(result[key], 2000)]),
      )
    : null;
  const file = (name) => {
    const filePath = path.join(laneDir, name);
    return fs.existsSync(filePath) ? filePath : null;
  };
  return {
    lane_id: laneId,
    role: laneRoleOf(laneDir, laneId),
    final_status: safeReadJson(path.join(laneDir, "final-status.json")),
    result_excerpt: resultExcerpt,
    result_stderr_tail: result?.stderr ? clipTail(textOf(result.stderr), 3000) : null,
    stderr_tail: clipTail(readTail(path.join(laneDir, "stderr.log"), 6000), 4000),
    launcher_stderr_tail: clipTail(readTail(path.join(laneDir, "launcher.stderr.log"), 3000), 2000),
    last_agent_message: lastAgentMessage(laneDir),
    events_tail: tailLines(path.join(laneDir, "events.jsonl"), 12).map((line) => clip(line, 800)),
    files: {
      lane_dir: laneDir,
      final_status: file("final-status.json"),
      result: file("result.json"),
      stdout: file("stdout.log"),
      stderr: file("stderr.log"),
      events: file("events.jsonl"),
      invocation: file("invocation.json"),
      role_plan: file("role-plan.json"),
      lane_contract: file("lane-contract.json"),
      task: file("task.md"),
    },
  };
}

function boundedJson(value, limit) {
  const text = JSON.stringify(value);
  if (!text || text.length <= limit) return value;
  return { truncated: true, excerpt: clip(text, limit) };
}

// The kind of defect a signature names, without the instance: the trigger
// kind, and for a health finding its subtype too.
function defectKind(signature) {
  const parts = String(signature || "").split(":");
  return parts[0] === HEALTH_KIND ? parts.slice(0, 2).join(":") : parts[0];
}

// What the maintainer already did about this kind of defect.
//
// MEASURED ON cycle-a-20260919, 2026-10-16..17: twelve accepted runs
// were triggered by pipeline_health:analysis_contract_mismatch, each with its
// own instance signature, and each widened the contract verifier for the one
// spelling its runner had used (a status word, a gate-ID shape, a threshold
// column). No run was shown the others, so none looked for what they shared:
// the analysts were never given the output form the verifier accepts. The
// cause was found by hand, after the twelfth patch.
const RECURRENCE_WINDOW_DAYS = 7;
const RECURRENCE_THRESHOLD = 3;

function priorFixesOfKind({ state, primary, now = Date.now() }) {
  const kind = defectKind(primary?.signature);
  if (!kind) return [];
  return (Array.isArray(state?.runs) ? state.runs : [])
    .filter((run) => run?.outcome === "accepted" && defectKind(run.signature) === kind)
    .filter((run) => now - (Date.parse(run.finished_at || run.started_at || "") || 0) <= RECURRENCE_WINDOW_DAYS * 86_400_000)
    .map((run) => ({
      finished_at: run.finished_at || null,
      signature: run.signature,
      commit: run.commit ? String(run.commit).slice(0, 12) : null,
      commit_title: run.commit_title || null,
      reason: clip(String(run.reason || ""), 600),
    }));
}

function recurrenceGuidance(evidence, primary) {
  const fixes = evidence.prior_fixes_of_this_kind || [];
  if (fixes.length < RECURRENCE_THRESHOLD) return [];
  return [
    `## This kind of defect has been fixed ${fixes.length} times in ${RECURRENCE_WINDOW_DAYS} days`,
    `Every accepted maintainer run below was triggered by ${defectKind(primary.signature)}, as this one is. Each fixed`,
    "its own instance, and the defect kept coming back in a new shape. Read these commits (`git show <hash>`) before",
    "you read this instance:",
    ...fixes.map((fix) => `- ${fix.commit || "(no commit)"} ${fix.finished_at ? fix.finished_at.slice(0, 16) : ""} ${fix.commit_title || ""}${fix.reason ? ` -- ${fix.reason}` : ""}`),
    "",
    "Find what these instances have in common -- what the agents are told, what one component writes and another",
    "reads, a rule two components implement differently -- and fix THAT, so the next instance does not arise. Another",
    "patch for this instance's spelling alone is not a fix; if you conclude the cause really is different this time,",
    "say in your summary what distinguishes it from the fixes above.",
    "",
  ];
}

function buildEvidence({ cwd, cycleId, triggers, primary, state, repo, deps, progress = null, budget = null }) {
  const pause = readPauseMarker({ cwd, cycleId });
  const termination = readTerminationCode({ cwd, cycleId });
  const laneIds = [...new Set(triggers.flatMap((item) => item.lane_ids || []))].slice(0, 10);
  const eventsRoot = path.join(researchRoot(cwd), "events");
  const recentEvents = {};
  for (const name of [`${cycleId}-cycle-events.jsonl`, `${cycleId}-supervisor-actions.jsonl`, `${cycleId}-controller.jsonl`]) {
    const filePath = path.join(eventsRoot, name);
    if (fs.existsSync(filePath)) {
      recentEvents[name] = { path: filePath, tail: tailLines(filePath, 20).map((line) => clip(line, 1500)) };
    }
  }
  return {
    cycle_id: cycleId,
    generated_at: nowIso(deps),
    primary_trigger: primary,
    all_triggers: triggers,
    pause_marker: pause ? { path: pause.path, marker: boundedJson(pause.marker, 8000) } : null,
    termination_code: termination
      ? { path: terminationPath({ cwd, cycleId }), code: boundedJson(termination, 20000) }
      : null,
    lanes: laneIds.map((laneId) => laneEvidence({ cwd, cycleId, laneId })),
    prior_fixes_of_this_kind: priorFixesOfKind({ state, primary, now: Date.parse(nowIso(deps)) || Date.now() }),
    // Where the cycle is and what it is waiting on. For a stall trigger this is
    // the whole case; for every other trigger it is the context that says
    // whether the blocker is holding the pipeline or merely noisy.
    pipeline_progress: progress
      ? {
        path: progressPath({ cwd, cycleId }),
        current_milestone: progress.current_milestone,
        reached_at: progress.reached_at,
        minutes_in_milestone: progress.minutes_in_milestone,
        next_milestone: progress.next_milestone,
        next_milestone_artifact: progress.next_milestone_artifact,
        waiting_on: progress.waiting_on,
        lead: progress.lead,
        lead_selection_rejections: progress.lead_selection_rejections,
        director_next_actions: boundedJson(progress.director_next_actions, 4000),
        lanes_since_milestone: boundedJson(progress.lanes_since_milestone, 8000),
        last_evidence: progress.last_evidence,
        milestone_order: progress.milestone_order,
      }
      : null,
    budget: budget
      ? {
        path: budgetPath({ cwd, cycleId }),
        counting_rule: budget.counting_rule,
        totals: budget.totals,
        wall_clock: budget.wall_clock,
        limits: budget.limits,
        status: budget.status,
        maintainer_runs: budget.maintainer_runs,
        by_action_type: boundedJson(budget.by_action_type, 6000),
      }
      : null,
    recent_events: recentEvents,
    git_log: repo ? gitText(repo, ["log", "-10", "--oneline"]).trim().split(/\r?\n/) : [],
    previous_maintainer_runs: (state?.runs || []).map((run) => ({
      run_id: run.run_id,
      signature: run.signature,
      verdict: run.verdict || null,
      outcome: run.outcome,
      reason: run.reason || null,
      commit: run.commit || null,
    })),
    paths: {
      lanes_root: path.join(researchRoot(cwd), "lanes", cycleId),
      state_root: path.join(researchRoot(cwd), "state"),
      events_root: eventsRoot,
    },
  };
}

// ---------------------------------------------------------------------------
// git

function gitRun(repo, args, options = {}) {
  return spawnSync("git", args, {
    cwd: repo.top,
    encoding: options.encoding === "buffer" ? undefined : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    input: options.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function gitText(repo, args) {
  const result = gitRun(repo, args);
  return result.status === 0 ? String(result.stdout || "") : "";
}

function openRepo(cwd) {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel", "--show-prefix"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) return null;
  const [top, prefix = ""] = String(probe.stdout || "").split(/\r?\n/);
  if (!top) return null;
  const repo = { top: path.resolve(top.trim()), prefix: prefix.trim(), cwd };
  repo.head = gitText(repo, ["rev-parse", "HEAD"]).trim();
  repo.branch = gitText(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return repo;
}

// `git status` paths are relative to the top level; the rules are about the
// package root, which is a subdirectory of it in this repository.
function packageRelative(repo, topPath) {
  if (!repo.prefix) return topPath;
  return topPath.startsWith(repo.prefix) ? topPath.slice(repo.prefix.length) : null;
}

function absoluteOf(repo, topPath) {
  return path.join(repo.top, ...topPath.split("/"));
}

function porcelainStatus(repo) {
  const result = gitRun(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.status}`);
  const parts = String(result.stdout || "").split("\0");
  const entries = new Map();
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item || item.length < 4) continue;
    const xy = item.slice(0, 2);
    entries.set(item.slice(3), xy);
    // A rename or copy is followed by its source path.
    if (xy[0] === "R" || xy[0] === "C") index += 1;
  }
  return entries;
}

function existsInHead(repo, topPath) {
  return gitRun(repo, ["cat-file", "-e", `HEAD:${topPath}`]).status === 0;
}

function headContent(repo, topPath) {
  const result = gitRun(repo, ["show", `HEAD:${topPath}`]);
  return result.status === 0 ? String(result.stdout || "") : null;
}

// ---------------------------------------------------------------------------
// the maintainer's own worktree
//
// MEASURED ON cycle-b-20260919, 2026-09-19 (run-01-20260919T105739Z): the
// maintainer ran Codex in the live working tree and took "its" changes to be
// the before/after diff of that tree. Two other agents were editing the same
// tree; when the run timed out (could_not_fix) it "restored" six files that
// were not its own -- reverting drivers/literature/search_lib/http_client.py
// and deleting four new Rust files and fulltext.py. A concurrent writer to a
// shared tree is indistinguishable from the agent. Each run now edits a
// detached worktree of HEAD that nothing else writes to, and the main tree
// changes only by a fast-forward to the accepted commit.

function safeName(text) {
  return String(text || "").replace(/[^A-Za-z0-9_.-]/g, "-");
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function worktreesRoot(repo) {
  return path.join(repo.top, WORKTREES_DIR);
}

function cycleWorktreesDir(repo, cycleId) {
  return path.join(worktreesRoot(repo), safeName(cycleId));
}

function gitCommonDir(repo) {
  const text = gitText(repo, ["rev-parse", "--git-common-dir"]).trim();
  return text ? path.resolve(repo.top, text) : path.join(repo.top, ".git");
}

// The worktrees must not show up in the main tree's `git status` (other agents
// and the harness read it). The repository's .gitignore lists the directory;
// a clone without that line gets it in its local exclude file instead.
function ensureWorktreesIgnored(repo) {
  const probe = `${WORKTREES_DIR}/probe`;
  if (gitRun(repo, ["check-ignore", "-q", "--no-index", probe]).status === 0) return false;
  const excludePath = path.join(gitCommonDir(repo), "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${separator}/${WORKTREES_DIR}/\n`, "utf8");
  return true;
}

function worktreeAdminDir(worktreeDir) {
  try {
    const text = fs.readFileSync(path.join(worktreeDir, ".git"), "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    return match ? path.resolve(worktreeDir, match[1]) : null;
  } catch {
    return null;
  }
}

// A git-runnable view of a worktree: gitRun, porcelainStatus, headContent and
// the gate's shape rules take it exactly like the main repository.
function worktreeView(repo, dir, base) {
  const prefix = repo.prefix || "";
  const pkg = prefix ? path.join(dir, ...prefix.replace(/\/+$/, "").split("/")) : dir;
  return { top: dir, prefix, cwd: pkg, pkg, root: dir, base, admin: worktreeAdminDir(dir) };
}

function createWorktree(repo, dir, base) {
  if (!isInside(dir, worktreesRoot(repo))) throw new Error(`worktree path outside ${WORKTREES_DIR}: ${dir}`);
  if (fs.existsSync(dir)) removeWorktree(repo, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = gitRun(repo, ["worktree", "add", "--detach", "--quiet", dir, base]);
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${clip(`${add.stdout || ""}\n${add.stderr || ""}`, 1200)}`);
  }
  return worktreeView(repo, dir, base);
}

// Admin entries (<common-dir>/worktrees/<name>) whose worktree lies under
// `underDir`. Never `git worktree prune`: that also drops other people's
// prunable worktrees (and with them the HEADs that keep their commits alive).
function maintainerAdminEntries(repo, underDir) {
  const adminRoot = path.join(gitCommonDir(repo), "worktrees");
  let names = [];
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const adminDir = path.join(adminRoot, name);
    let gitdir = "";
    try {
      gitdir = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    const worktreeDir = path.dirname(path.resolve(gitdir));
    if (isInside(worktreeDir, underDir)) entries.push({ admin: adminDir, dir: worktreeDir });
  }
  return entries;
}

function removeWorktree(repo, dir, admin = null) {
  const outcome = { path: dir, removed: false };
  // Only ever a directory of our own; nothing else is deleted here.
  if (!isInside(dir, worktreesRoot(repo))) {
    outcome.error = `refusing to remove a path outside ${WORKTREES_DIR}`;
    return outcome;
  }
  const adminDir = admin
    || worktreeAdminDir(dir)
    || maintainerAdminEntries(repo, worktreesRoot(repo)).find((entry) => path.resolve(entry.dir) === path.resolve(dir))?.admin
    || null;
  if (fs.existsSync(dir)) {
    const result = gitRun(repo, ["worktree", "remove", "--force", "--force", dir]);
    if (result.status !== 0) outcome.git_error = clip(String(result.stderr || result.stdout || ""), 600);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (error) {
        outcome.error = String(error?.message || error);
      }
    }
  }
  if (adminDir && fs.existsSync(adminDir) && isInside(adminDir, path.join(gitCommonDir(repo), "worktrees"))) {
    try {
      fs.rmSync(adminDir, { recursive: true, force: true });
    } catch (error) {
      outcome.admin_error = String(error?.message || error);
    }
  }
  outcome.removed = !fs.existsSync(dir);
  return outcome;
}

// Whatever a crashed run of this cycle left behind: registered worktrees and
// bare directories under .maintainer-worktrees/<cycle>/.
function sweepStaleWorktrees(repo, cycleId) {
  const cycleDir = cycleWorktreesDir(repo, cycleId);
  const removed = [];
  const seen = new Set();
  for (const entry of maintainerAdminEntries(repo, cycleDir)) {
    seen.add(path.resolve(entry.dir));
    removed.push(removeWorktree(repo, entry.dir, entry.admin));
  }
  let names = [];
  try {
    names = fs.readdirSync(cycleDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const dir = path.join(cycleDir, name);
    if (seen.has(path.resolve(dir))) continue;
    removed.push(removeWorktree(repo, dir));
  }
  return removed;
}

// Exactly what the agent changed: nothing else writes in its worktree.
function worktreeChanges(worktree) {
  return [...porcelainStatus(worktree)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([topPath, xy]) => ({
      path: topPath,
      pre_dirty: false,
      exists: fs.existsSync(absoluteOf(worktree, topPath)),
      xy,
    }));
}

// Stage the candidate and keep it as a patch in the run directory, so it
// survives the worktree. The staged tree is what gets committed, whatever the
// test suites write into the worktree afterwards.
function stageCandidate(worktree, changes, runDir, patchName = "candidate.patch") {
  const paths = changes.map((change) => change.path);
  const add = gitRun(worktree, ["--literal-pathspecs", "add", "-A", "--", ...paths]);
  if (add.status !== 0) throw new Error(`git add in the worktree failed: ${clip(add.stderr, 800)}`);
  const tree = gitText(worktree, ["write-tree"]).trim();
  const diff = gitRun(worktree, ["diff", "--cached", "--binary", "HEAD"], { encoding: "buffer" });
  const patchPath = path.join(runDir, patchName);
  fs.writeFileSync(patchPath, diff.stdout || Buffer.alloc(0));
  return { tree, patch_path: patchPath };
}

// Paths among `topPaths` with any local change in the main tree: modified,
// staged, deleted or untracked.
function dirtyPaths(repo, topPaths) {
  if (!topPaths.length) return [];
  const result = gitRun(repo, [
    "--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...topPaths,
  ]);
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.status}`);
  const parts = String(result.stdout || "").split("\0");
  const dirty = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item || item.length < 4) continue;
    dirty.push(item.slice(3));
    if (item[0] === "R" || item[0] === "C") index += 1;
  }
  return [...new Set(dirty)].sort();
}

// .research-lab is gitignored, so git cannot see anything touch cycle state;
// the pause marker and stop code this module acts on are guarded by hand.
function snapshotGuarded({ runDir, guardedPaths }) {
  const guarded = {};
  const guardDir = path.join(runDir, "guarded");
  guardedPaths.forEach((filePath, index) => {
    const exists = fs.existsSync(filePath);
    const entry = { exists, sha: exists ? sha1OfFile(filePath) : null, copy: null };
    if (exists) {
      fs.mkdirSync(guardDir, { recursive: true });
      entry.copy = path.join(guardDir, `${index}.bin`);
      fs.copyFileSync(filePath, entry.copy);
    }
    guarded[filePath] = entry;
  });
  return { guarded };
}

// Guarded files that changed, and whether each one was removed. Only a removal
// is held against the agent: a lane still running in the background may write
// a new pause while the agent works, and that is indistinguishable from here.
function guardedChanges(snapshot) {
  return Object.entries(snapshot.guarded || {})
    .filter(([filePath, before]) => {
      const exists = fs.existsSync(filePath);
      return exists !== before.exists || (exists && sha1OfFile(filePath) !== before.sha);
    })
    .map(([filePath, before]) => ({ path: filePath, removed: before.exists && !fs.existsSync(filePath) }));
}

// Only a pause or stop that DISAPPEARED is put back. A lane still running in
// the background can legitimately write a new one while the agent works, and a
// newer, stricter state must not be rolled back to an older one.
function restoreRemovedGuarded(snapshot) {
  const outcomes = [];
  for (const [filePath, before] of Object.entries(snapshot.guarded || {})) {
    if (!before.exists || !before.copy || fs.existsSync(filePath)) continue;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.copyFileSync(before.copy, filePath);
      outcomes.push({ path: filePath, restored: true, guarded: true });
    } catch (error) {
      outcomes.push({ path: filePath, restored: false, guarded: true, reason: String(error?.message || error) });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// the deterministic gate: path and test-shape rules

function isAllowedPath(relative) {
  if (relative == null) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function testCountOf(relative, content) {
  if (content == null) return 0;
  if (/\.rs$/.test(relative)) {
    return (content.match(/#\[(?:tokio::)?test\]/g) || []).length;
  }
  if (/\.(?:c|m)?js$/.test(relative)) {
    return (content.match(/(?<![\w.$])(?:test|it)(?:\.only)?\s*\(/g) || []).length;
  }
  if (/\.py$/.test(relative)) {
    return (content.match(/^\s*(?:async\s+)?def\s+test_\w*/gm) || []).length;
  }
  return 0;
}

// Ways to make a failing test stop failing without fixing anything.
function skipCountOf(relative, content) {
  if (content == null) return 0;
  if (/\.rs$/.test(relative)) return (content.match(/#\[ignore\b/g) || []).length;
  if (/\.(?:c|m)?js$/.test(relative)) {
    return (content.match(/(?<![\w$])(?:test|it|describe)\.(?:skip|todo)\s*\(|\{\s*skip\s*:\s*(?!false)/g) || []).length;
  }
  if (/\.py$/.test(relative)) {
    return (content.match(/@(?:pytest\.mark\.skip|pytest\.mark\.xfail|unittest\.skip|skip)\w*|\bself\.skipTest\(|\bpytest\.skip\(/g) || []).length;
  }
  return 0;
}

function changedLineCount(repo, change) {
  if (!change.pre_dirty && existsInHead(repo, change.path)) {
    const numstat = gitText(repo, ["diff", "--numstat", "HEAD", "--", change.path]).trim();
    if (!numstat) return 0;
    let total = 0;
    for (const line of numstat.split(/\r?\n/)) {
      const [added, deleted] = line.split(/\s+/);
      if (added === "-" || deleted === "-") return Number.POSITIVE_INFINITY;
      total += Number(added || 0) + Number(deleted || 0);
    }
    return total;
  }
  const absolute = absoluteOf(repo, change.path);
  if (!fs.existsSync(absolute)) return 0;
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) return Number.POSITIVE_INFINITY;
  return bytes.toString("utf8").split(/\r?\n/).length;
}

// Returns { ok, reasons, details }. Nothing here reads what the agent said.
function checkChangeShape({ repo, changes, maxDiffLines }) {
  const reasons = [];
  const details = { files: [] };
  let testsGained = 0;
  let totalLines = 0;
  for (const change of changes) {
    const relative = packageRelative(repo, change.path);
    const record = { path: change.path, package_path: relative };
    if (change.pre_dirty) {
      reasons.push(`touched a file that already had uncommitted changes: ${change.path}`);
    }
    if (!isAllowedPath(relative)) {
      reasons.push(`path outside the maintainer's allow-list: ${change.path}`);
    }
    const before = change.pre_dirty ? null : headContent(repo, change.path);
    const absolute = absoluteOf(repo, change.path);
    const after = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
    const key = relative || change.path;
    record.tests_before = testCountOf(key, before);
    record.tests_after = testCountOf(key, after);
    record.skips_before = skipCountOf(key, before);
    record.skips_after = skipCountOf(key, after);
    record.changed_lines = changedLineCount(repo, change);
    if (record.tests_after < record.tests_before) {
      reasons.push(`test count fell in ${change.path} (${record.tests_before} -> ${record.tests_after})`);
    }
    if (record.skips_after > record.skips_before) {
      reasons.push(`a test was skipped or ignored in ${change.path}`);
    }
    testsGained += Math.max(0, record.tests_after - record.tests_before);
    totalLines += record.changed_lines;
    details.files.push(record);
  }
  details.tests_gained = testsGained;
  details.changed_lines = totalLines;
  if (changes.length === 0) reasons.push("no files changed");
  if (changes.length > 0 && testsGained < 1) reasons.push("no regression test was added");
  if (totalLines > maxDiffLines) reasons.push(`diff is ${totalLines} changed lines (limit ${maxDiffLines})`);
  return { ok: reasons.length === 0, reasons, details };
}

// ---------------------------------------------------------------------------
// test suites

function nodeTestFailures(output) {
  const lines = String(output || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^✖ failing tests:/.test(line.trim()));
  const failures = [];
  if (start < 0) return failures;
  let file = null;
  for (const line of lines.slice(start + 1)) {
    const at = /^test at (.+?):\d+:\d+\s*$/.exec(line.trim());
    if (at) {
      file = at[1].replace(/\\/g, "/");
      continue;
    }
    const failed = /^✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(line);
    if (failed && file) {
      failures.push(`${file}::${failed[1]}`);
      file = null;
    }
  }
  return [...new Set(failures)];
}

function cargoTestFailures(output) {
  const failures = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^test (\S+) \.\.\. FAILED\s*$/.exec(line.trim());
    if (match) failures.push(match[1]);
  }
  return [...new Set(failures)];
}

function pytestFailures(output) {
  const failures = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/.exec(line.trim());
    if (match) failures.push(match[1]);
  }
  return [...new Set(failures)];
}

function maintainerTargetDir(cwd) {
  return path.join(cwd, ...MAINTAINER_TARGET_DIR.split("/"));
}

// `targetDir`: the main tree's target-maintainer, shared by the candidate and
// baseline worktrees so dependencies are built once.
function suiteCommand(suite, { cwd, only, config, targetDir = null }) {
  if (suite === "cargo") {
    const args = ["test", "--manifest-path", NATIVE_MANIFEST, "--", "--test-threads=1"];
    if (only && only.length) args.push("--exact", ...only);
    return {
      command: process.env.CARGO || "cargo",
      args,
      env: { ...nativeBuildEnv(), CARGO_TARGET_DIR: targetDir || maintainerTargetDir(cwd) },
      timeoutMs: 90 * 60 * 1000,
      parse: cargoTestFailures,
    };
  }
  if (suite === "node") {
    const files = only && only.length
      ? [...new Set(only.map((id) => id.split("::")[0]))]
      : ["tests/*.test.js"];
    return {
      command: process.execPath,
      args: ["--test", "--test-reporter=spec", ...files],
      env: { ...process.env, RESEARCHLAB_MAINTAINER: "0" },
      timeoutMs: 30 * 60 * 1000,
      parse: nodeTestFailures,
    };
  }
  if (suite === "pytest") {
    return {
      command: config.python,
      args: ["-m", "pytest", "-q", "-p", "no:cacheprovider", ...(only && only.length ? only : ["tests"])],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      timeoutMs: 30 * 60 * 1000,
      parse: pytestFailures,
    };
  }
  throw new Error(`unknown suite ${suite}`);
}

// { status: passed | failed | crashed, failures: [...ids], output_tail }
function defaultRunTestSuite(suite, { cwd, only = null, config, targetDir = null }) {
  const spec = suiteCommand(suite, { cwd, only, config, targetDir });
  const result = spawnSync(spec.command, spec.args, {
    cwd,
    env: spec.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: spec.timeoutMs,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const failures = spec.parse(output);
  let status = "passed";
  if (result.error || result.status === null) status = "crashed";
  else if (failures.length > 0) status = "failed";
  else if (result.status !== 0) status = "crashed";
  return {
    status,
    failures,
    exit_code: result.status,
    error: result.error ? String(result.error.message || result.error) : null,
    output_tail: clipTail(output, 6000),
  };
}

// With `targetDir` (the gate, in the worktree) the build goes to the
// maintainer's own target directory; without it (after the accept, in the main
// tree) it is the real binary, and whatever the maintainer used for its own
// builds must not redirect it.
function defaultBuildRelease({ cwd, targetDir = null }) {
  const env = { ...nativeBuildEnv() };
  if (targetDir) env.CARGO_TARGET_DIR = targetDir;
  else delete env.CARGO_TARGET_DIR;
  const result = spawnSync(process.env.CARGO || "cargo", ["build", "--release"], {
    cwd: path.join(cwd, "native", "researchlab-harness"),
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    exit_code: result.status,
    output_tail: clipTail(`${result.stdout || ""}\n${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`, 6000),
  };
}

// Run every suite in the candidate worktree; a failure that also fails in a
// clean worktree of HEAD (`baselineCwd()`, created on first need) is baseline.
// Neither run touches the main tree.
function runSuitesWithBaseline({ cwd, baselineCwd, targetDir, config, runTestSuite, log }) {
  const suites = ["cargo", "node", "pytest"];
  const report = [];
  for (const suite of suites) {
    log("maintainer_suite_started", { suite });
    const withChange = runTestSuite(suite, { cwd, only: null, config, targetDir });
    const entry = { suite, with_change: withChange };
    if (withChange.status === "passed") {
      report.push(entry);
      log("maintainer_suite_finished", { suite, status: "passed" });
      continue;
    }
    const headCwd = baselineCwd();
    const atHead = withChange.status === "crashed"
      ? runTestSuite(suite, { cwd: headCwd, only: null, config, targetDir })
      : runTestSuite(suite, { cwd: headCwd, only: withChange.failures, config, targetDir });
    entry.at_head = atHead;
    if (withChange.status === "crashed") {
      // A suite that cannot run at HEAD either (a missing interpreter, say) is
      // not evidence against the change; one that ran at HEAD and not with the
      // change is.
      entry.new_failures = atHead.status === "crashed" ? [] : ["<suite crashed with the change>"];
      entry.unavailable = atHead.status === "crashed";
    } else {
      const baseline = new Set(atHead.failures || []);
      entry.new_failures = withChange.failures.filter((id) => !baseline.has(id));
      entry.baseline_failures = withChange.failures.filter((id) => baseline.has(id));
    }
    log("maintainer_suite_finished", {
      suite,
      status: withChange.status,
      new_failures: entry.new_failures,
      baseline_failures: entry.baseline_failures || [],
      unavailable: entry.unavailable === true,
    });
    report.push(entry);
    if (entry.new_failures.length > 0) break;
  }
  const newFailures = report.flatMap((entry) => (entry.new_failures || []).map((id) => `${entry.suite}: ${id}`));
  return { ok: newFailures.length === 0, new_failures: newFailures, suites: report };
}

// ---------------------------------------------------------------------------
// Codex

function codexCommand(env = process.env) {
  for (const candidate of [env.RESEARCHLAB_MAINTAINER_CODEX_CMD, env.RESEARCHLAB_CODEX_CMD]) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  // Same order as agent_command.rs: the standalone Windows CLI before PATH,
  // because the desktop app can leave its own older copy first on PATH.
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    const standalone = path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    if (fs.existsSync(standalone)) return standalone;
  }
  return "codex";
}

function codexArgs({ model, lastMessagePath, schemaPath, cwd }) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--model", model,
    "--config", 'model_reasoning_effort="high"',
    // Ephemeral runs cannot attach child agents (codex_lane.rs).
    "--disable", "multi_agent",
    "--disable", "multi_agent_v2",
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "--config", "sandbox_workspace_write.network_access=false",
    "--config", 'approval_policy="never"',
    "--config", 'forced_login_method="chatgpt"',
    "--config", 'model_provider="openai"',
    "--cd", cwd,
    "--output-last-message", lastMessagePath,
    "--output-schema", schemaPath,
    "-",
  ];
}

// ---------------------------------------------------------------------------
// execution venue: the host, or a Linux container
//
// MEASURED ON cycle-b-20260919, 2026-09-19 (run-01-20260919T105739Z): the
// maintainer's host Codex (Windows elevated sandbox, workspace-write, network
// off) could not start a single shell command in 45 minutes. Its stream has
// three mcp_tool_call items (plugins from the user's Codex config) and three
// agent messages saying local commands fail to start; it timed out. Scouts
// left the shared Windows sandbox for Docker for the same family of reasons
// (native/researchlab-harness/src/runtime/docker_scout.rs); the maintainer
// follows them: bubblewrap inside researchlab:local, only auth.json from the
// host Codex home (no config, so no plugins), the repository read-only, and
// only its own worktree and run directory writable.

// `D:\a\b`, `D:/a/b/` and `\\?\D:\a\b` all become `D:/a/b`.
function normalizeHostPath(value) {
  let text = String(value || "");
  if (text.startsWith("\\\\?\\")) text = text.slice(4);
  text = text.replace(/\\/g, "/");
  while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

// The container spelling of a host path under the mount, or null outside it.
function hostToContainer(mountRoot, hostPath) {
  const target = normalizeHostPath(hostPath);
  const mount = normalizeHostPath(mountRoot);
  if (target.length < mount.length || target.slice(0, mount.length).toLowerCase() !== mount.toLowerCase()) return null;
  const rest = target.slice(mount.length);
  if (!rest) return CONTAINER_ROOT;
  return rest.startsWith("/") ? `${CONTAINER_ROOT}${rest}` : null;
}

function isPathNameChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_.-]/.test(ch);
}

// A run of `/` and `\` at `pos`: [length, backslash count].
function separatorRun(text, pos) {
  let length = 0;
  let backslashes = 0;
  for (;;) {
    const ch = text[pos + length];
    if (ch === "/") length += 1;
    else if (ch === "\\") {
      length += 1;
      backslashes += 1;
    } else break;
  }
  return [length, backslashes];
}

function matchMountAt(text, start, components) {
  if (start > 0 && isPathNameChar(text[start - 1])) return null;
  let pos = start;
  let escaped = false;
  for (let index = 0; index < components.length; index += 1) {
    if (index > 0) {
      const [length, backslashes] = separatorRun(text, pos);
      if (length === 0 || length > 2 || (length === 2 && backslashes !== 2)) return null;
      escaped = escaped || backslashes === 2;
      pos += length;
    }
    const component = components[index];
    const end = pos + component.length;
    if (end > text.length || text.slice(pos, end).toLowerCase() !== component.toLowerCase()) return null;
    pos = end;
  }
  if (isPathNameChar(text[pos])) return null;
  return [pos, escaped];
}

// Port of translate_host_paths in docker_scout.rs: every host path under the
// mount becomes its /work/... spelling -- `D:\x`, `D:/x`, mixed separators and
// the JSON-escaped `D:\\x` of the evidence embedded in the prompt. In escaped
// text a single backslash is an escape (`\n`, `\"`) and ends the path.
function translateHostPaths(mountRoot, text) {
  const mount = normalizeHostPath(mountRoot);
  const components = mount.split("/");
  const first = components[0] || "";
  const source = String(text ?? "");
  let out = "";
  let copied = 0;
  let pos = 0;
  while (pos < source.length) {
    const ch = source[pos];
    const candidate = first === "" ? ch === "/" || ch === "\\" : ch.toLowerCase() === first[0].toLowerCase();
    const match = candidate ? matchMountAt(source, pos, components) : null;
    if (!match) {
      pos += 1;
      continue;
    }
    let [end, escaped] = match;
    out += source.slice(copied, pos) + CONTAINER_ROOT;
    for (;;) {
      const [length, backslashes] = separatorRun(source, end);
      if (length === 0) break;
      const loneBackslash = backslashes === 1 && length === 1;
      if ((escaped && loneBackslash) || (loneBackslash && source[end + 1] === "\"")) break;
      escaped = escaped || backslashes >= 2;
      out += "/";
      end += length;
      const nameStart = end;
      while (end < source.length && !/[/\\\s"'`,;)\]}<>|]/.test(source[end])) end += 1;
      out += source.slice(nameStart, end);
    }
    copied = end;
    pos = end;
  }
  return out + source.slice(copied);
}

function maintainerContainerName(cycleId, runId) {
  return `rl-maint-${cycleId}-${runId}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 128);
}

// The host Codex auth.json. HOME is often unset for a Windows process.
function codexAuthJson(env) {
  const homes = [
    env.CODEX_HOME,
    env.USERPROFILE ? path.join(env.USERPROFILE, ".codex") : null,
    env.HOME ? path.join(env.HOME, ".codex") : null,
  ].filter((value) => value && String(value).trim());
  for (const home of homes) {
    const candidate = path.join(home, "auth.json");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // next
    }
  }
  return null;
}

// { kind: "host" } or { kind: "docker", image, mountRoot, authJson,
// containerName, command }. A docker request that cannot be honoured falls
// back to the host with the reason recorded.
function resolveVenue({ env, config, repo, cwd, cycleId, runId }) {
  const kind = config.venue || (config.dockerImage ? "docker" : "host");
  if (kind !== "docker") return { kind: "host" };
  const fallback = (reason) => ({ kind: "host", fallback_reason: reason });
  if (!config.dockerImage) {
    return fallback("RESEARCHLAB_MAINTAINER_VENUE=docker but neither RESEARCHLAB_MAINTAINER_DOCKER_IMAGE nor RESEARCHLAB_SCOUT_DOCKER_IMAGE is set");
  }
  const authJson = codexAuthJson(env);
  // A missing file would be bind-mounted as an empty directory.
  if (!authJson) return fallback("no Codex auth.json under CODEX_HOME, USERPROFILE or HOME");
  const mountRoot = normalizeHostPath(config.dockerMount || repo.top);
  for (const needed of [worktreesRoot(repo), researchRoot(cwd)]) {
    if (!hostToContainer(mountRoot, needed)) return fallback(`${needed} is outside the docker mount ${mountRoot}`);
  }
  return {
    kind: "docker",
    image: config.dockerImage,
    mountRoot,
    authJson: normalizeHostPath(authJson),
    containerName: maintainerContainerName(cycleId, runId),
    command: config.dockerCmd || "docker",
  };
}

// `docker run ... <image> codex <codexArgs>`. The whole mount is read-only;
// the agent's worktree and the run directory (Codex writes its last message
// there) are mounted over it read-write. The only thing taken from the host
// Codex home is auth.json, so the user's config and plugins stay out.
function dockerRunArgs({ image, containerName, mountRoot, authJson, worktreeRoot, runDir, workdir, codexArgs: args }) {
  const inContainer = (hostPath) => {
    const mapped = hostToContainer(mountRoot, hostPath);
    if (!mapped) throw new Error(`${hostPath} is outside the docker mount ${mountRoot}`);
    return mapped;
  };
  const runDirInContainer = inContainer(runDir);
  return [
    "run",
    "--rm",
    "-i",
    "--name", containerName,
    // Without these bubblewrap cannot create its namespaces. They loosen the
    // container, not the Codex sandbox inside it.
    "--security-opt", "seccomp=unconfined",
    "--security-opt", "apparmor=unconfined",
    "-v", `${normalizeHostPath(mountRoot)}:${CONTAINER_ROOT}:ro`,
    "-v", `${normalizeHostPath(worktreeRoot)}:${inContainer(worktreeRoot)}`,
    "-v", `${normalizeHostPath(runDir)}:${runDirInContainer}`,
    "-v", `${normalizeHostPath(authJson)}:${CONTAINER_AUTH_PATH}`,
    "-w", inContainer(workdir),
    "-e", "PYTHONIOENCODING=utf-8",
    "-e", "PYTHONUTF8=1",
    "-e", `RESEARCHLAB_MAINTAINER_RUN_DIR=${runDirInContainer}`,
    image,
    "codex",
    ...args.map((arg) => translateHostPaths(mountRoot, arg)),
  ];
}

function containerPrompt(venue, prompt) {
  const windowsSpelling = venue.mountRoot.replace(/\//g, "\\");
  const note = [
    `This run is in a Linux container: the repository is at ${CONTAINER_ROOT} (read-only); host paths`,
    `${windowsSpelling}\\… are ${CONTAINER_ROOT}/…. The shell is bash, not PowerShell. node and python3 are installed;`,
    "cargo and pytest are NOT: you can edit Rust and Python, but you cannot run `cargo test` or `python3 -m pytest`",
    "here. The orchestrator's gate runs all three suites on the host after you finish; run the node tests you touch",
    "with `node --test tests/<file>.test.js`. git cannot read this worktree's metadata inside the container.",
  ].join(" ");
  return `${note}\n\n${translateHostPaths(venue.mountRoot, prompt)}`;
}

// `docker rm -f <name>`, errors ignored ("no such container" after --rm).
// Killing the docker client on a timeout does not stop the container; this
// does.
function removeDockerContainer(command, name, env = process.env) {
  const viaNode = /\.(?:c|m)?js$/i.test(command);
  const args = ["rm", "-f", name];
  const result = spawnSync(viaNode ? process.execPath : command, viaNode ? [command, ...args] : args, {
    env,
    stdio: "ignore",
    timeout: 120 * 1000,
    windowsHide: true,
  });
  return result.status === 0;
}

function defaultRunCodex({ cwd, runDir, prompt, config, env = process.env, venue = { kind: "host" }, targetDir = null }) {
  const schemaPath = path.join(runDir, "output-schema.json");
  const lastMessagePath = path.join(runDir, "last-message.json");
  writeJsonFile(schemaPath, OUTPUT_SCHEMA);
  const args = codexArgs({ model: config.model, lastMessagePath, schemaPath, cwd });
  let command;
  let commandArgs;
  let input = prompt;
  let childEnv;
  const docker = venue.kind === "docker";
  if (docker) {
    command = venue.command;
    commandArgs = dockerRunArgs({ ...venue, runDir, workdir: cwd, codexArgs: args });
    input = containerPrompt(venue, prompt);
    fs.writeFileSync(path.join(runDir, "prompt.container.md"), input, "utf8");
    writeJsonFile(path.join(runDir, "docker-argv.json"), [command, ...commandArgs]);
    // A container of the same name left by a crash would block --name.
    removeDockerContainer(command, venue.containerName, env);
    childEnv = { ...env };
  } else {
    command = codexCommand(env);
    commandArgs = args;
    childEnv = codexSubscriptionEnvironment({
      ...env,
      CARGO_TARGET_DIR: targetDir || maintainerTargetDir(cwd),
      CARGO_NET_OFFLINE: "true",
      PYTHONIOENCODING: "utf-8",
      RESEARCHLAB_MAINTAINER_RUN_DIR: runDir,
    });
  }
  delete childEnv.RESEARCHLAB_MAINTAINER;
  // A fake Codex (or docker) in tests is a node script.
  const viaNode = /\.(?:c|m)?js$/i.test(command);
  const stdoutFd = fs.openSync(path.join(runDir, "codex.stdout.jsonl"), "w");
  const stderrFd = fs.openSync(path.join(runDir, "codex.stderr.log"), "w");
  let result;
  let containerRemoved = null;
  try {
    result = spawnSync(viaNode ? process.execPath : command, viaNode ? [command, ...commandArgs] : commandArgs, {
      cwd,
      env: childEnv,
      input,
      stdio: ["pipe", stdoutFd, stderrFd],
      timeout: config.timeoutSeconds * 1000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    if (docker) containerRemoved = removeDockerContainer(command, venue.containerName, childEnv);
  }
  const timedOut = result.error?.code === "ETIMEDOUT" || (result.status === null && result.signal === "SIGKILL");
  return {
    command,
    venue: venue.kind,
    container_name: docker ? venue.containerName : null,
    container_removed: containerRemoved,
    exit_code: result.status,
    timed_out: timedOut,
    error: result.error ? String(result.error.message || result.error) : null,
    last_message_path: lastMessagePath,
    stdout_path: path.join(runDir, "codex.stdout.jsonl"),
  };
}

function parseAgentVerdict(codexResult) {
  let text = "";
  try {
    text = fs.readFileSync(codexResult.last_message_path, "utf8");
  } catch {
    text = "";
  }
  if (!text.trim() && codexResult.stdout_path) {
    const lines = tailLines(codexResult.stdout_path, 400, 512 * 1024);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]);
        if (event?.type === "item.completed" && event.item?.type === "agent_message") {
          text = String(event.item.text || "");
          break;
        }
      } catch {
        // not an event line
      }
    }
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { parsed = null; }
    }
  }
  if (!parsed || !VERDICTS.includes(parsed.verdict)) return null;
  return {
    verdict: parsed.verdict,
    summary: clip(parsed.summary || "", 4000),
    root_cause: clip(parsed.root_cause || "", 2000),
    files_changed: Array.isArray(parsed.files_changed) ? parsed.files_changed.map(String).slice(0, 50) : [],
    tests_added: Array.isArray(parsed.tests_added) ? parsed.tests_added.map(String).slice(0, 50) : [],
    clears_pause: parsed.clears_pause === true,
    commit_title: String(parsed.commit_title || "").split(/\r?\n/)[0].trim().slice(0, 120),
  };
}

const STALL_TRIGGER_KINDS = new Set(["no_milestone_progress", "lane_churn", "no_evidence"]);

// What a stall IS, said to the agent in the terms it has to diagnose it in.
// Without this the cheapest way to make the trigger stop firing is to raise the
// threshold or delete the check, which leaves the cycle exactly as stuck.
function stallGuidance(evidence, primary) {
  const progress = evidence.pipeline_progress;
  const waiting = (progress?.waiting_on || []).slice(0, 6);
  const churn = Object.entries(progress?.lanes_since_milestone?.by_action_type || {})
    .slice(0, 8)
    .map(([actionType, group]) => `  ${actionType}: ${group.total} finished (${group.completed} completed, ${group.failed} failed)`);
  return [
    "## This is a STALL, not a failure",
    "Nothing crashed. The cycle is running, lanes are finishing, and the pipeline is not moving. A stall is almost",
    "always a CONTRACT OR PLUMBING DEFECT: a state field read wrongly (a recorded flag taken for a live decision), a",
    "gate whose condition nothing in the system can satisfy, a wait that nobody can clear, an action the director keeps",
    "choosing because the state it reads never changes. Find which condition is never satisfiable and why.",
    "",
    `Current milestone: ${progress?.current_milestone || "(none)"} for ${progress?.minutes_in_milestone ?? "?"} minutes.`,
    `Next milestone: ${progress?.next_milestone || "(none)"} (${progress?.next_milestone_artifact || "?"}).`,
    "Waiting on:",
    ...(waiting.length ? waiting.map((item) => `- ${String(item).slice(0, 400)}`) : ["- (nothing recorded)"]),
    "",
    "Lanes finished since the milestone last advanced, by action_type:",
    ...(churn.length ? churn : ["  (none)"]),
    "",
    `Newest evidence artifact: ${progress?.last_evidence?.path || "(none)"} (${progress?.last_evidence?.minutes_ago ?? "?"} minutes ago).`,
    "",
    "THE FIX MUST MAKE THE CYCLE ABLE TO MOVE. Raising a threshold, widening a window, or removing the stall check is",
    "not a fix -- it deletes the only thing that noticed. Neither is making the harness dispatch more lanes: the lanes",
    `already ran. Your regression test must reproduce the stuck condition (the same state the ${primary.kind} trigger`,
    "read) and show that the pipeline can now advance past it.",
    "",
  ];
}

function healthGuidance(primary) {
  return [
    ...(primary.subtype === "analysis_contract_mismatch" || primary.subtype === "current_lead_validation_unbound" ? [
      "Analysis contract repair: use the authoritative hypothesis and analysis-contract-policy operational specification.",
      "The maintainer deterministically rebinds pending analyst plans before diagnosis; fix any remaining dispatch, handoff, or result-routing bug at its source.",
      "Regenerate mismatched analysis code and run a new immutable validation. Never stamp an old script as if it executed the corrected comparator or quantifier.",
      "A verified contract may carry a scientific pass, falsification, or inconclusive result. Preserve that scientific verdict and all approval thresholds.",
    ] : []),
    "## This is a HEALTH finding, not a blockage",
    "The cycle is running. The supervisor measured the harness wasting work or writing something false while it runs",
    `(${primary.subtype || "pipeline_health"}). That is a harness bug of the same classes listed below -- scheduling,`,
    "routing, stale state, a record that says something the run did not do -- and it costs the research every time it",
    "recurs. Find why the harness produces it and remove that cause.",
    "",
    "Recent fixes of this kind, for calibration (`git show <hash>`): ca30796 (lanes starved behind newer work of the same",
    "kind), 5410fa2 (a handoff that already had its runner got more), ba5b7da (the same execution under another",
    "handoff's name ran again), 274e5a5 (a runner read another bundle's file for a relative name), 68e156c (the gate",
    "read a stale researcher view).",
    "",
    "THE FIX MUST STOP THE MEASURED PATHOLOGY AT ITS SOURCE. Silencing the detector, raising its threshold, or editing",
    "the recorded artifacts is not a fix. Your regression test must reproduce the measured case -- the same records the",
    "finding read -- and show the harness no longer produces it. If what was measured is the research doing its job",
    "(a real scientific disagreement, a lane legitimately waiting), answer not_a_harness_bug and say why.",
    "",
  ];
}

function buildPrompt({ cycleId, runId, evidencePath, evidence, primary, cwd, mainCwd = cwd }) {
  const evidenceText = JSON.stringify(evidence, null, 2);
  const inline = evidenceText.length <= 60000
    ? evidenceText
    : `${evidenceText.slice(0, 60000)}\n... [evidence truncated here; read the full file]`;
  const today = new Date().toISOString().slice(0, 10);
  return [
    "# ResearchLab maintainer",
    "",
    ...(primary.kind === HEALTH_KIND
      ? [
        `You are the maintainer of the ResearchLab harness. The research cycle ${cycleId} is running, and the supervisor`,
        "measured a defect in how the harness runs it. Your job is to remove that defect from the harness code -- not to",
        "add features, and never to change the research.",
      ]
      : [
        `You are the maintainer of the ResearchLab harness. The research cycle ${cycleId} is blocked or`,
        "repeatedly failing, and the supervisor's lane-level self-healing has not moved it. Your job is to unblock clogged",
        "plumbing in the harness code -- not to improve the harness, and never to change the research.",
      ]),
    "",
    `You work in a private git worktree of the harness at ${cwd}, checked out at HEAD. Edit files only there.`,
    `The live tree at ${mainCwd} belongs to the running cycle and other agents: read the evidence from it, never`,
    "write to it. Your changes are exactly what differs in your worktree when you finish.",
    "",
    `Primary trigger: ${primary.kind} (${primary.signature})`,
    `Detail: ${primary.detail || "(none)"}`,
    "",
    `Full evidence bundle: ${evidencePath}. Lane directories, logs and events it names can be read for more detail.`,
    "",
    ...recurrenceGuidance(evidence, primary),
    ...(STALL_TRIGGER_KINDS.has(primary.kind) ? stallGuidance(evidence, primary) : []),
    ...(primary.kind === HEALTH_KIND ? healthGuidance(primary) : []),
    "## Decide first",
    "Classify the blocker, verifying against the actual files before you believe any label:",
    "- harness_bug_fixed: a bug in harness code -- a mis-detection (a classifier reading an agent's prose, a log tail cut",
    "  mid-line, a marker read mid-rewrite), scheduling/plumbing (a lane starved, queued behind work that cannot finish,",
    "  duplicated from a stale index), stale state handling, or wrong routing (a role or model assigned wrongly). You fixed it.",
    "- environment_block: a genuine environment problem (missing tool, broken sandbox install, credentials, disk, network).",
    "  Do not code around a real environment block; describe what a person must do in summary.",
    "- not_a_harness_bug: a scientific outcome or an agent doing its job (a falsified hypothesis, a failed gate, a scout",
    "  finding too little literature). The harness is behaving as designed.",
    "- could_not_fix: a harness bug you could not fix safely within the rules below.",
    "",
    "Recent fixes of exactly this class, for calibration (read them with `git show <hash>` if useful): 2224a9c (a",
    "watchdog read a mid-line log tail and paused the cycle as a setup failure), 8f99d52 (scouts pinned to a weak model),",
    "8089666 (an engineer lane starved by scheduling), 326857d (duplicate engineer lanes from a stale index), 67850c8 (a",
    "marker read mid-rewrite paused the cycle).",
    "",
    "## If it is a harness bug",
    "- Make the SMALLEST fix in harness code that removes the root cause, not the symptom.",
    "- Add a regression test that reproduces the measured case and fails without your fix. Put a comment on the fix and",
    `  the test in the repository's style: \"MEASURED ON ${cycleId}, ${today}\" followed by what was observed.`,
    "- Run the targeted tests you touched where the tool is available: `node --test tests/<file>.test.js`, `python -m pytest -q tests/<file>`, or",
    `  \`cargo test --manifest-path ${NATIVE_MANIFEST} <name> -- --test-threads=1\`. CARGO_TARGET_DIR is already set to a`,
    "  private build directory; never build into native/researchlab-harness/target and never pass --release.",
    "- Your change will be checked mechanically after you finish. It is rejected, and your worktree discarded, if it:",
    "  touches any path outside native/researchlab-harness/src/, src/, drivers/, scripts/, tests/; adds no new test;",
    "  lowers the number of tests in any file; skips or ignores a test; exceeds 400 changed lines; introduces a new",
    "  failure in the cargo, node or pytest suites; or breaks the release build.",
    "",
    "## Never",
    "- Weaken a safety or evidence rule. docs/incident-catalog.md lists hard invariants (\"NEVER change these to fix a",
    "  halt\"): the gate threshold and all-rubric conjunction, fail-closed soundness, no flooring or overriding of fresh",
    "  gatekeeper scores, followup caps and the exempt multiplier, the director owning pivots, append-only audit artifacts.",
    "  A pause that is CORRECT (a real Windows sandbox failure, a real quota) must stay a pause.",
    "- Delete, skip, ignore or loosen existing tests.",
    "- Touch .research-lab/ (cycle data, pause markers, termination codes), Cargo.toml, Cargo.lock, package.json,",
    "  package-lock.json, or the launcher. The orchestrator clears the pause itself if your fix is accepted.",
    "- Run git (no commit, stash, checkout, reset or push); the orchestrator commits what it accepts.",
    "- Use the network.",
    "- Leave scratch files behind. Any new file outside the allowed directories rejects the whole change, so delete",
    "  every throwaway script or output you created before you answer.",
    "",
    "## Answer",
    "Finish with the JSON object the output schema asks for:",
    "- verdict: one of harness_bug_fixed | not_a_harness_bug | environment_block | could_not_fix",
    "- summary: what you found and did, for the commit body and the researcher",
    "- root_cause: one or two sentences",
    "- files_changed / tests_added: repository-relative paths",
    "- clears_pause: true only if your fix removes the cause of the current pause or stop, so resuming the cycle is safe",
    "- commit_title: one line, in the style of the recent commit titles (a sentence saying what now behaves correctly)",
    "",
    `## Evidence (maintainer run ${runId})`,
    "```json",
    inline,
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// accept: commit in the worktree, fast-forward the main tree, push, resume

function commitMessage({ verdict, cycleId, runId }) {
  const title = verdict.commit_title || `Maintainer fix for ${cycleId}`;
  return {
    title,
    text: [
      title,
      "",
      verdict.summary,
      `Root cause: ${verdict.root_cause}`,
      `Maintainer-Run: ${cycleId}/${runId}`,
      "",
    ].join("\n"),
  };
}

// Commits exactly the staged candidate tree (whatever the suites wrote into
// the worktree since) on the worktree's detached HEAD.
function commitInWorktree({ worktree, tree, verdict, cycleId, runId, runDir }) {
  const { title, text } = commitMessage({ verdict, cycleId, runId });
  const messagePath = path.join(runDir, "commit-message.txt");
  fs.writeFileSync(messagePath, text, "utf8");
  const readTree = gitRun(worktree, ["read-tree", tree]);
  if (readTree.status !== 0) return { ok: false, reason: `git read-tree failed: ${clip(readTree.stderr, 800)}` };
  const commit = gitRun(worktree, ["commit", "-q", "-F", messagePath]);
  if (commit.status !== 0) {
    return { ok: false, reason: `git commit failed: ${clip(`${commit.stdout}\n${commit.stderr}`, 1200)}` };
  }
  return { ok: true, commit: gitText(worktree, ["rev-parse", "HEAD"]).trim(), title };
}

function mainTreeHead(repo) {
  return {
    head: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    branch: gitText(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  };
}

// Moves the main branch to exactly the worktree commit, which sits on the base
// the gate ran against. Refused -- with nothing in the main tree changed --
// when the branch or HEAD moved, or when any touched path has local changes
// there: those belong to someone else. A moved HEAD on the same branch is
// flagged (`head_moved`) so the caller can rebase and gate again.
function applyToMainTree({ repo, commit, base, paths }) {
  const { head, branch } = mainTreeHead(repo);
  // The branch first: a switched branch also moves HEAD, and is never rebased onto.
  if (branch !== repo.branch) return { ok: false, reason: `branch changed during the run (${repo.branch} -> ${branch})` };
  if (head !== base) return { ok: false, head_moved: true, head, reason: `HEAD moved during the run (${base} -> ${head})` };
  const dirty = dirtyPaths(repo, paths);
  if (dirty.length) return { ok: false, reason: `main tree has local changes in ${dirty.join(", ")}` };
  // --ff: the commit's parent is HEAD, so this is a fast-forward to that very
  // commit. git itself refuses rather than overwrite a local change, and
  // refuses outright while anything is staged.
  const pick = gitRun(repo, ["cherry-pick", "--ff", commit]);
  if (pick.status !== 0) {
    if (gitRun(repo, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]).status === 0) {
      gitRun(repo, ["cherry-pick", "--abort"]);
    }
    return { ok: false, reason: `git cherry-pick failed: ${clip(`${pick.stdout || ""}\n${pick.stderr || ""}`.trim(), 1200)}` };
  }
  const after = gitText(repo, ["rev-parse", "HEAD"]).trim();
  if (after !== commit) {
    return { ok: true, commit: after, fast_forward: false, worktree_commit: commit };
  }
  return { ok: true, commit: after, fast_forward: true };
}

// ---------------------------------------------------------------------------
// rebasing onto a moved HEAD
//
// MEASURED ON cycle-a-20260919, 2026-09-19 (run-01-20260919T144446Z):
// the maintainer fixed a real bug (verdict harness_bug_fixed; cargo, node and
// pytest gates passed with no new failures) and then threw the fix away with
// "HEAD moved during the run (7801be9 -> 83cb8c8)": a person had committed an
// unrelated change meanwhile, and had to cherry-pick the fix by hand. The
// branch gets commits all the time. A candidate whose base is no longer HEAD
// is now cherry-picked onto the new HEAD in a fresh worktree and gated again
// there, against that HEAD; only a conflict, or a HEAD that keeps moving past
// RESEARCHLAB_MAINTAINER_REBASE_ATTEMPTS, rejects it.

// One line per commit in from..to: the ones touching `paths`, or all of them
// when none does.
function commitsBetween(repo, from, to, paths = []) {
  const lines = (args) => gitText(repo, args).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const range = ["log", "--no-decorate", "--format=%h %s", `${from}..${to}`];
  const touching = paths.length ? lines(["--literal-pathspecs", ...range, "--", ...paths]) : [];
  return touching.length ? touching : lines(range);
}

// Cherry-picks the candidate (its staged tree on `from`) onto `onto` in a
// fresh worktree at `dir`, leaving the result staged there -- exactly the state
// the gate reads after the agent's run. Never touches the main tree.
function rebaseCandidate({ repo, tree, from, onto, dir }) {
  const pickable = gitRun(repo, ["commit-tree", tree, "-p", from, "-m", "maintainer candidate (rebase source)"]);
  if (pickable.status !== 0) {
    return { ok: false, error: `git commit-tree failed: ${clip(`${pickable.stdout || ""}\n${pickable.stderr || ""}`.trim(), 800)}` };
  }
  const source = String(pickable.stdout || "").trim();
  const worktree = createWorktree(repo, dir, onto);
  const pick = gitRun(worktree, ["cherry-pick", "--no-commit", source]);
  if (pick.status === 0) return { ok: true, worktree, source };
  const conflicts = gitText(worktree, ["diff", "--name-only", "--diff-filter=U"])
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  gitRun(worktree, ["cherry-pick", "--abort"]);
  return {
    ok: false,
    worktree,
    source,
    conflicts,
    output: clip(`${pick.stdout || ""}\n${pick.stderr || ""}`.trim(), 1200),
  };
}

function pushBranch({ repo }) {
  const result = gitRun(repo, ["push", "origin", repo.branch]);
  return {
    ok: result.status === 0,
    branch: repo.branch,
    output_tail: clipTail(`${result.stdout || ""}\n${result.stderr || ""}`, 2000),
  };
}

// The existing convention (state/*.json.resolved-<ms>.bak): the marker is kept
// beside the state it described, renamed so nothing reads it as live.
function resolvePauseMarkers({ cwd, cycleId, deps }) {
  const stamp = deps?.now ? deps.now() : Date.now();
  const resolved = [];
  for (const markerPath of pauseMarkerPaths({ cwd, cycleId })) {
    if (!fs.existsSync(markerPath)) continue;
    const target = `${markerPath}.resolved-${stamp}.bak`;
    fs.renameSync(markerPath, target);
    resolved.push(target);
  }
  return resolved;
}

// A JS fix only takes effect in a fresh process: the running orchestrator has
// the old modules loaded. Rust fixes are live as soon as the binary is rebuilt.
function changesNeedRestart(repo, changes) {
  return changes.some((change) => {
    const relative = packageRelative(repo, change.path) || "";
    return relative.startsWith("src/") && /\.(?:c|m)?js$/.test(relative);
  });
}

// ---------------------------------------------------------------------------
// crash recovery

// If the orchestrator died during a run, the agent's half-made change is in
// its worktree, not in the main tree, so nothing in the main tree is put back.
// The worktree (kept as a patch), a baseline worktree and a container are
// removed; so is anything else a crashed run of this cycle left under
// .maintainer-worktrees/<cycle>/.
function recoverInterruptedRun({ cwd, cycleId, env = process.env, deps = {} }) {
  const config = maintainerConfig(env);
  if (!config.enabled) return null;
  const ctx = { cwd, cycleId, deps };
  const state = safeReadJson(statePath({ cwd, cycleId }));
  const inProgress = state?.in_progress;
  const repo = openRepo(cwd);
  let outcome = null;
  if (inProgress) {
    outcome = { run_id: inProgress.run_id, recovered: false };
    if (!inProgress.worktree) {
      // A run from before the worktree design edited the main tree, which other
      // agents also write; its "changes" cannot be told from theirs.
      outcome.reason = "run predates the maintainer worktree; the main tree is left as is";
    } else if (!repo) {
      outcome.reason = "repository unavailable";
    } else {
      let keptPatch = null;
      if (fs.existsSync(inProgress.worktree)) {
        try {
          const worktree = worktreeView(repo, inProgress.worktree, inProgress.base || null);
          const changes = worktreeChanges(worktree);
          if (changes.length && inProgress.run_dir) {
            fs.mkdirSync(inProgress.run_dir, { recursive: true });
            gitRun(worktree, ["add", "-A"]);
            const diff = gitRun(worktree, ["diff", "--cached", "--binary", "HEAD"], { encoding: "buffer" });
            keptPatch = path.join(inProgress.run_dir, "interrupted.patch");
            fs.writeFileSync(keptPatch, diff.stdout || Buffer.alloc(0));
          }
        } catch {
          keptPatch = null;
        }
      }
      let containerRemoved = null;
      if (inProgress.container_name) {
        containerRemoved = removeDockerContainer(inProgress.docker_command || config.dockerCmd, inProgress.container_name, env);
      }
      const worktrees = [inProgress.worktree, inProgress.base_worktree, ...(Array.isArray(inProgress.extra_worktrees) ? inProgress.extra_worktrees : [])]
        .filter(Boolean)
        .map((dir) => removeWorktree(repo, dir));
      outcome = {
        ...outcome,
        recovered: true,
        kept_patch: keptPatch,
        container_name: inProgress.container_name || null,
        container_removed: containerRemoved,
        worktrees,
      };
    }
    state.runs = Array.isArray(state.runs) ? state.runs : [];
    const run = state.runs.find((item) => item.run_id === inProgress.run_id);
    if (run && !run.finished_at) {
      run.finished_at = nowIso(deps);
      run.outcome = "interrupted";
      run.reason = outcome.reason || "orchestrator stopped during the run; its worktree was discarded";
    }
    state.in_progress = null;
    saveState(ctx, state);
    logEvent(ctx, "maintainer_interrupted_run_recovered", outcome);
  }
  if (repo) {
    const swept = sweepStaleWorktrees(repo, cycleId);
    if (swept.length) logEvent(ctx, "maintainer_stale_worktrees_removed", { worktrees: swept });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// the run

// ---------------------------------------------------------------------------
// budget

/**
 * The two soft ceilings, and what happens at each.
 *
 * 80%: a warning event, once. The cycle keeps running; somebody reading the
 * event log can decide early.
 *
 * 100%: the cycle stops, and NO Codex run starts. A maintainer run here would
 * spend more of the exhausted budget to investigate the exhausted budget, and
 * there is nothing for it to fix -- an exhausted budget is not a harness bug.
 * So this writes the pause and the termination the orchestrator already uses
 * for a researcher stop, names the budget report in the reason, and leaves the
 * decision to the owner. The pause carries block_type `budget_exhausted`, which
 * WAITING_PAUSE_BLOCK_TYPES treats as a real wait, so no later pass mistakes it
 * for plumbing and tries to "fix" it.
 */
/// Stop the cycle and hand the decision to the owner: a pause the supervisor
/// itself will not diagnose, plus the termination code the orchestrator reads.
/// Written once; later passes return the same outcome without rewriting it.
function stopForOwner(ctx, { state, deps, stateKey, blockType, code, category, outcome, reason, progress, metadata = {}, event }) {
  const { cwd, cycleId } = ctx;
  if (state[stateKey]) {
    return { run_id: null, run_dir: null, outcome, verdict: null, reason, commit: null, resumed: false, restart_required: false };
  }
  const marker = {
    cycle_id: cycleId,
    paused_at: nowIso(deps),
    reason,
    source: "supervisor",
    block_type: blockType,
    manual_resume_required: true,
    milestone: progress?.current_milestone || null,
    waiting_on: progress?.waiting_on || [],
    ...metadata,
  };
  for (const markerPath of pauseMarkerPaths({ cwd, cycleId })) {
    try {
      writeJsonFile(markerPath, marker);
    } catch {
      // The termination code below is the one the orchestrator reads to stop.
    }
  }
  try {
    writeTerminationCode({
      cwd,
      cycleId,
      code,
      category,
      reason,
      source: "supervisor",
      shouldStop: true,
      metadata: { ...metadata, milestone: progress?.current_milestone || null },
    });
  } catch {
    // Reported through the event below regardless.
  }
  state[stateKey] = marker.paused_at;
  saveState(ctx, state);
  logEvent(ctx, event, { reason, ...metadata });
  return { run_id: null, run_dir: null, outcome, verdict: null, reason, commit: null, resumed: false, restart_required: false };
}

function enforceBudget({ ctx, cwd, cycleId, env, state, budget, progress, deps }) {
  const status = budget?.status || {};
  const limits = budget?.limits || {};
  if (!limits.token_budget && !limits.hours_budget) return null;

  if (status.exhausted !== true) {
    if (status.warned === true && state.budget_warned_at == null) {
      state.budget_warned_at = nowIso(deps);
      saveState(ctx, state);
      logEvent(ctx, "maintainer_budget_warning", {
        budget_path: budgetPath({ cwd, cycleId }),
        counted_tokens: budget.totals.counted_tokens,
        elapsed_hours: budget.wall_clock.elapsed_hours,
        limits,
        token_fraction: status.token_fraction,
        hours_fraction: status.hours_fraction,
        milestone: progress?.current_milestone || null,
      });
    }
    return null;
  }

  const reportPath = budgetPath({ cwd, cycleId });
  const reason = status.exhausted_by === "hours"
    ? `cycle wall-clock budget exhausted: ${budget.wall_clock.elapsed_hours} of ${limits.hours_budget} hours. Budget report: ${reportPath}`
    : `cycle token budget exhausted: ${budget.totals.counted_tokens} of ${limits.token_budget} counted tokens (billed input + output). Budget report: ${reportPath}`;

  if (state.budget_exhausted_at) {
    // Already stopped for this; do not rewrite the marker every pass.
    return { run_id: null, run_dir: null, outcome: "budget_exhausted", verdict: null, reason, commit: null, resumed: false, restart_required: false };
  }

  const marker = {
    cycle_id: cycleId,
    paused_at: nowIso(deps),
    reason,
    source: "supervisor",
    block_type: "budget_exhausted",
    manual_resume_required: true,
    budget_report_path: reportPath,
    milestone: progress?.current_milestone || null,
    waiting_on: progress?.waiting_on || [],
  };
  for (const markerPath of pauseMarkerPaths({ cwd, cycleId })) {
    try {
      writeJsonFile(markerPath, marker);
    } catch {
      // The termination code below is the one the orchestrator reads to stop.
    }
  }
  try {
    writeTerminationCode({
      cwd,
      cycleId,
      code: BUDGET_TERMINATION_CODE,
      category: "budget_exhausted",
      reason,
      source: "supervisor",
      shouldStop: true,
      metadata: {
        budget_report_path: reportPath,
        limits,
        counted_tokens: budget.totals.counted_tokens,
        elapsed_hours: budget.wall_clock.elapsed_hours,
        exhausted_by: status.exhausted_by,
        milestone: progress?.current_milestone || null,
      },
    });
  } catch {
    // Reported through the event below regardless.
  }

  state.budget_exhausted_at = marker.paused_at;
  saveState(ctx, state);
  logEvent(ctx, "maintainer_budget_exhausted", {
    budget_path: reportPath,
    reason,
    exhausted_by: status.exhausted_by,
    limits,
    counted_tokens: budget.totals.counted_tokens,
    elapsed_hours: budget.wall_clock.elapsed_hours,
    maintainer_run_started: false,
  });
  return {
    run_id: null,
    run_dir: null,
    outcome: "budget_exhausted",
    verdict: null,
    reason,
    commit: null,
    resumed: false,
    restart_required: false,
  };
}

// Runs that count against the cap. A run refused by a revoked Codex login
// diagnosed nothing and is given back; see codex_login.js.
function countedRuns(state) {
  return (state.runs || []).filter((run) => run.not_counted !== true).length;
}

// The runs inside the rolling window, and when the next attempt is available.
function windowRuns(state, nowMs) {
  return (state.runs || [])
    .filter((run) => run.not_counted !== true)
    // A run with no readable start counts as having just happened: unknown must
    // not read as free.
    .map((run) => (Number.isFinite(Date.parse(run.started_at)) ? Date.parse(run.started_at) : nowMs))
    .filter((ms) => nowMs - ms < MAX_RUNS_WINDOW_MS)
    .sort((a, b) => a - b);
}

// When the count falls below `cap`: the (n - cap + 1)th oldest run ages out.
function nextSlotAt(starts, cap) {
  if (starts.length < cap) return null;
  return new Date(starts[starts.length - cap] + MAX_RUNS_WINDOW_MS).toISOString();
}

function makeRunId(state, deps) {
  const index = String((state.runs || []).length + 1).padStart(2, "0");
  return `run-${index}-${nowIso(deps).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

// Returns null when nothing ran, else
// { run_id, outcome, verdict, resumed, restart_required, commit, reason }.
// The supervisor's turn at a crash that happens before it would run.
//
// MEASURED ON cycle-a-20260919, 2026-10-01 03:36Z: run-research threw
// "too many SQL variables" while recording its first control state, before any
// run-plan. maybeRunMaintainer is reached only after a run-plan returns, so the
// stack was printed, the process exited, Docker restarted it ten times into the
// same throw within seconds, and the cycle sat dead for two hours with the
// supervisor never consulted. The abort handler now hands the error here before
// exiting: one diagnosis per signature, as for any other crash, and a fix that
// lands is picked up by the restart that follows the exit.
//
// The error goes on as the object run-plan's own maintainer pass saw, not as
// its stack: a crash inside run-plan has already been diagnosed there, and
// the stack alone hashed to a second signature. MEASURED 2026-10-01 09:59Z:
// one EOF crash spent runs 26 and 27 a few seconds apart.
function maintainAfterAbort({ cwd, cycleId, error, env = process.env, deps = {} }) {
  if (!cycleId) return null;
  return maybeRunMaintainer({ cwd, cycleId, error: error || "run-research aborted", env, deps });
}

function maybeRunMaintainer({
  cwd,
  cycleId,
  error = null,
  staleSeconds = 1800,
  env = process.env,
  deps = {},
}) {
  const config = maintainerConfig(env);
  if (!config.enabled) return null;
  const ctx = { cwd, cycleId, deps };
  try {
    const repaired = repairQueuedAnalystContracts({ cwd, cycleId });
    if (repaired.length) logEvent(ctx, "maintainer_analysis_contracts_rebound", { lane_ids: repaired });
    return runMaintainer({ ...ctx, error, staleSeconds, env, config });
  } catch (internal) {
    // The maintainer exists to keep the cycle alive; its own failure must not
    // be what stops it.
    logEvent(ctx, "maintainer_internal_error", {
      error: clip(textOf(internal), 4000),
    });
    return { outcome: "internal_error", resumed: false, reason: String(internal?.message || internal) };
  }
}

function runMaintainer({ cwd, cycleId, error, staleSeconds, env, config, deps }) {
  const ctx = { cwd, cycleId, deps };
  // Before the state is loaded: recovery rewrites it.
  recoverInterruptedRun({ cwd, cycleId, env, deps });
  const state = loadState(ctx);
  const now = deps?.now ? deps.now() : Date.now();

  // Two measurements every pass, whether or not anything fires: where the
  // pipeline is, and what the cycle has spent. Both are cheap (the budget reads
  // only what was appended since the last pass) and both are what the owner
  // asked the supervisor to watch alongside errors.
  const { progress } = recordProgress({ cwd, cycleId, now });
  const { report: budget } = updateBudget({
    cwd,
    cycleId,
    env,
    now,
    maintainerRuns: countedRuns(state),
    milestoneOf: () => progress.current_milestone,
  });
  const budgetOutcome = enforceBudget({ ctx, cwd, cycleId, env, state, budget, progress, deps });
  if (budgetOutcome) return budgetOutcome;

  if (!state.health_watermark) {
    state.health_watermark = new Date(now).toISOString();
    saveState(ctx, state);
  }
  // Every agent, this one included, runs on the Codex login. While it is
  // revoked there is nothing to diagnose and no one to diagnose it: wait, said
  // once per outage, and let the owner's sign-in bring the cycle back.
  const loginRequired = readCodexLoginRequired({ cwd, cycleId });
  if (loginRequired) {
    if (state.login_wait_logged !== loginRequired.detected_at) {
      state.login_wait_logged = loginRequired.detected_at;
      saveState(ctx, state);
      logEvent(ctx, "maintainer_waiting_for_codex_login", { detected_at: loginRequired.detected_at, owner_action: loginRequired.owner_action });
    }
    return null;
  }
  const triggers = detectTriggers({ cwd, cycleId, error, state, progress, supervisor: supervisorConfig(env), now });
  // What the supervisor sees about the pipeline's own health, whether or not it
  // acts on it: for the owner and the director, who otherwise learn of these
  // only when someone reads the lanes by hand.
  writeHealthReport({ cwd, cycleId, findings: triggers.filter((item) => item.kind === HEALTH_KIND), now });
  if (triggers.length === 0) return null;
  const attempted = new Set(state.attempted_signatures);
  const primary = triggers.find((item) => !attempted.has(item.signature));
  if (!primary) {
    // Said once per signature; the loop comes back here every pass.
    const logged = new Set(Array.isArray(state.repeat_logged) ? state.repeat_logged : []);
    const fresh = triggers.map((item) => item.signature).filter((signature) => !logged.has(signature));
    if (fresh.length) {
      state.repeat_logged = [...logged, ...fresh];
      saveState(ctx, state);
      logEvent(ctx, "maintainer_trigger_already_attempted", { signatures: fresh });
    }
    return null;
  }
  const usedStarts = windowRuns(state, now);
  const used = usedStarts.length;
  const slotAt = nextSlotAt(usedStarts, config.maxRuns);
  // Attempts are back: what the cap had said and stopped on is released, so it
  // can say and stop again the next time it is spent.
  if (!slotAt && (state.cap_reached_logged || state.cap_stopped_at || (state.health_unattended_logged || []).length)) {
    state.cap_reached_logged = false;
    state.cap_stopped_at = null;
    state.health_unattended_logged = [];
    saveState(ctx, state);
    logEvent(ctx, "maintainer_cap_released", { runs_in_window: used, max_runs: config.maxRuns });
  }
  if (used >= config.maxRuns && primary.kind === HEALTH_KIND) {
    // Not a blocker: the cycle is moving. With no attempts left it is reported
    // (the health report above) and the cycle is never stopped for it.
    const logged = new Set(Array.isArray(state.health_unattended_logged) ? state.health_unattended_logged : []);
    if (!logged.has(primary.signature)) {
      state.health_unattended_logged = [...logged, primary.signature];
      saveState(ctx, state);
      logEvent(ctx, "maintainer_health_finding_unattended", { max_runs: config.maxRuns, runs_in_window: used, next_attempt_at: slotAt, finding: primary });
    }
    return null;
  }
  if (used >= config.maxRuns) {
    if (!state.cap_reached_logged) {
      state.cap_reached_logged = true;
      saveState(ctx, state);
      logEvent(ctx, "maintainer_cap_reached", { max_runs: config.maxRuns, runs_in_window: used, next_attempt_at: slotAt, pending_trigger: primary });
    }
    // Silence is the worst answer: the cycle keeps burning lanes on a blocker
    // nobody will fix.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21. The stall trigger
    // fired on a milestone that had not moved for hours, the cap was already
    // spent on earlier blockers, and the run was dropped with one log line; the
    // cycle spent the next day dispatching gate reviews of a lead with no data.
    return stopForOwner(ctx, {
      state,
      deps,
      stateKey: "cap_stopped_at",
      blockType: "supervisor_cap_reached",
      code: CAP_TERMINATION_CODE,
      category: "supervisor_cap_reached",
      outcome: "supervisor_cap_reached",
      reason: `the supervisor has no attempts left this week (${used} of ${config.maxRuns}; the next frees at ${slotAt}) and ${primary.kind} is still open: ${primary.detail || primary.signature}. Raise RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK or fix it by hand, then resume.`,
      progress,
      metadata: {
        max_runs: config.maxRuns,
        runs_used: used,
        next_attempt_at: slotAt,
        pending_trigger: primary,
      },
      event: "maintainer_cap_stop",
    });
  }

  const runId = makeRunId(state, deps);
  const runDir = path.join(researchRoot(cwd), "maintenance", cycleId, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const report = {
    cycle_id: cycleId,
    run_id: runId,
    started_at: nowIso(deps),
    trigger: primary,
    other_triggers: triggers.filter((item) => item !== primary),
    steps: [],
  };
  const step = (eventType, payload = {}) => {
    report.steps.push({ ts: nowIso(deps), step: eventType, ...payload });
    logEvent(ctx, eventType, { run_id: runId, ...payload });
    writeJsonFile(path.join(runDir, "report.json"), report);
  };
  const run = { run_id: runId, signature: primary.signature, trigger_kind: primary.kind, started_at: report.started_at };
  state.runs.push(run);
  state.attempted_signatures.push(primary.signature);
  saveState(ctx, state);

  const finish = (outcome, extra = {}) => {
    Object.assign(run, { finished_at: nowIso(deps), outcome, ...extra });
    // The watermark stays where the maintainer was enabled. Moving it here
    // dropped every group this run did not handle: two runners failing before
    // it and two after never reached the threshold. A handled signature is
    // already excluded by attempted_signatures.
    state.in_progress = null;
    saveState(ctx, state);
    report.finished_at = run.finished_at;
    report.outcome = outcome;
    Object.assign(report, extra);
    step("maintainer_run_finished", { outcome, ...extra });
    return {
      run_id: runId,
      run_dir: runDir,
      outcome,
      verdict: extra.verdict || null,
      reason: extra.reason || null,
      commit: extra.commit || null,
      resumed: extra.resumed === true,
      restart_required: extra.restart_required === true,
    };
  };

  step("maintainer_triggered", { trigger: primary, other_signatures: report.other_triggers.map((item) => item.signature) });

  const repo = openRepo(cwd);
  if (!repo || !repo.head) return finish("skipped", { reason: "not a git repository" });
  if (PROTECTED_BRANCHES.has(repo.branch)) {
    return finish("rejected", { reason: `refusing to maintain on protected branch ${repo.branch}` });
  }

  const evidence = buildEvidence({ cwd, cycleId, triggers, primary, state, repo, deps, progress, budget });
  const evidencePath = path.join(runDir, "evidence.json");
  writeJsonFile(evidencePath, evidence);
  step("maintainer_evidence_written", { evidence_path: evidencePath, lanes: evidence.lanes.map((lane) => lane.lane_id) });

  const guardedPaths = [...pauseMarkerPaths({ cwd, cycleId }), terminationPath({ cwd, cycleId })];
  const guarded = snapshotGuarded({ runDir, guardedPaths });
  const base = repo.head;
  const worktreeDir = path.join(cycleWorktreesDir(repo, cycleId), runId);
  const baselineDir = `${worktreeDir}-base`;
  const venue = resolveVenue({ env, config, repo, cwd, cycleId, runId });
  ensureWorktreesIgnored(repo);
  let worktree;
  try {
    worktree = createWorktree(repo, worktreeDir, base);
  } catch (worktreeError) {
    return finish("skipped", { reason: clip(`could not create the maintainer worktree: ${textOf(worktreeError)}`, 1500) });
  }
  if (venue.kind === "docker") venue.worktreeRoot = worktree.root;
  state.in_progress = {
    run_id: runId,
    run_dir: runDir,
    worktree: worktree.root,
    base_worktree: baselineDir,
    base,
    venue: venue.kind,
    container_name: venue.containerName || null,
    docker_command: venue.kind === "docker" ? venue.command : null,
    started_at: run.started_at,
  };
  saveState(ctx, state);
  step("maintainer_worktree_created", {
    worktree: worktree.root,
    base,
    venue: venue.kind,
    image: venue.image || null,
    container_name: venue.containerName || null,
    venue_fallback_reason: venue.fallback_reason || null,
  });

  const targetDir = maintainerTargetDir(cwd);
  // Rebased candidates' worktrees and their baselines (see rebaseCandidate).
  const extraDirs = [];
  let accepted = false;
  try {
    const prompt = buildPrompt({ cycleId, runId, evidencePath, evidence, primary, cwd: worktree.pkg, mainCwd: cwd });
    fs.writeFileSync(path.join(runDir, "prompt.md"), prompt, "utf8");
    step("maintainer_codex_started", { model: config.model, timeout_seconds: config.timeoutSeconds, venue: venue.kind });
    const codexResult = (deps.runCodex || defaultRunCodex)({
      cwd: worktree.pkg,
      runDir,
      prompt,
      config,
      env,
      venue,
      targetDir,
    });
    const verdict = parseAgentVerdict(codexResult);
    step("maintainer_codex_finished", {
      exit_code: codexResult.exit_code,
      timed_out: codexResult.timed_out === true,
      error: codexResult.error || null,
      container_removed: codexResult.container_removed ?? null,
      verdict,
    });

    const changes = worktreeChanges(worktree);
    const touchedGuarded = guardedChanges(guarded);
    const candidate = changes.length ? stageCandidate(worktree, changes, runDir) : null;
    step("maintainer_changes_computed", {
      files: changes.map((change) => ({ path: change.path, exists: change.exists, xy: change.xy })),
      patch_path: candidate?.patch_path || null,
      guarded_touched: touchedGuarded,
    });

    // Nothing in the main tree to put back: the agent never wrote there. Only
    // cycle state that disappeared is restored.
    const reject = (reason, extra = {}) => {
      const restored = restoreRemovedGuarded(guarded);
      if (restored.length) step("maintainer_guarded_restored", { restore: restored });
      return finish("rejected", { reason, verdict: verdict?.verdict || null, ...extra });
    };

    const removedGuarded = touchedGuarded.filter((item) => item.removed).map((item) => item.path);
    if (removedGuarded.length) return reject(`cycle state was removed during the run: ${removedGuarded.join(", ")}`);
    if (!verdict) {
      const codexOutput = [codexResult.stdout_path, path.join(runDir, "codex.stderr.log")]
        .map((file) => (file ? readTail(file, 64 * 1024) : ""))
        .join("\n");
      if (!codexResult.timed_out && codexLoginRevoked(codexOutput)) {
        // Refused before it could look: the signature and the attempt are
        // given back, and the cycle waits for the owner (codex_login.js).
        recordCodexLoginRequired({ cwd, cycleId, source: `maintainer ${runId}`, evidence: codexOutput.slice(-600), env });
        state.attempted_signatures = state.attempted_signatures.filter((signature) => signature !== primary.signature);
        run.not_counted = true;
        return finish("codex_login_required", { reason: "the Codex login was revoked; the owner must sign in again" });
      }
      return reject(codexResult.timed_out ? "codex timed out without a verdict" : "codex returned no valid verdict");
    }
    if (verdict.verdict !== "harness_bug_fixed") {
      if (changes.length) return reject(`verdict ${verdict.verdict} but files were changed`);
      return finish("no_fix", {
        verdict: verdict.verdict,
        reason: clip(verdict.summary || verdict.root_cause, 1000),
      });
    }

    // The candidate as the gate sees it: staged changes in a worktree whose
    // HEAD is `base`. A rebase replaces it with the same change cherry-picked
    // onto the moved HEAD, in a fresh worktree, and the whole gate runs again.
    let current = { worktree, base, changes, tree: candidate?.tree || null, baselineDir, patchPath: candidate?.patch_path || null };
    let rebases = 0;
    let committed = null;
    let applied = null;
    let nativeChanged = false;
    const buildRelease = deps.buildRelease || defaultBuildRelease;
    for (;;) {
      const main = mainTreeHead(repo);
      if (main.branch !== repo.branch) {
        return reject(`branch changed during the run (${repo.branch} -> ${main.branch})`, { worktree_commit: committed?.commit || null });
      }
      // With no change there is nothing to rebase; the shape check rejects it.
      if (main.head !== current.base && current.tree) {
        // Nothing here moves HEAD back: whoever moved it may be a person.
        if (rebases >= config.rebaseAttempts) {
          return reject(rebases === 0
            ? `HEAD moved during the run (${current.base} -> ${main.head})`
            : `HEAD kept moving: still moving after ${rebases} rebase attempt${rebases === 1 ? "" : "s"} (${current.base} -> ${main.head})`, {
            worktree_commit: committed?.commit || null,
            patch_path: current.patchPath,
            rebases,
          });
        }
        rebases += 1;
        const touchedBefore = current.changes.map((change) => change.path);
        const newCommits = commitsBetween(repo, current.base, main.head, touchedBefore);
        const dir = `${worktreeDir}-r${rebases}`;
        extraDirs.push(dir);
        state.in_progress.extra_worktrees = [...extraDirs];
        saveState(ctx, state);
        let rebased;
        try {
          rebased = rebaseCandidate({ repo, tree: current.tree, from: current.base, onto: main.head, dir });
        } catch (rebaseError) {
          rebased = { ok: false, error: clip(textOf(rebaseError), 1500) };
        }
        if (!rebased.ok) {
          step("maintainer_rebase_conflict", {
            attempt: rebases,
            from: current.base,
            onto: main.head,
            new_commits: newCommits,
            conflicts: rebased.conflicts || [],
            error: rebased.error || null,
            output: rebased.output || null,
            patch_path: current.patchPath,
          });
          const conflicted = Boolean(rebased.conflicts?.length) || !rebased.error;
          return reject(conflicted
            ? `conflicts with ${newCommits.join("; ") || main.head}`
            : `could not rebase onto ${main.head}: ${rebased.error}`, {
            patch_path: current.patchPath,
            conflicts: rebased.conflicts || [],
            rebases,
          });
        }
        const rebasedChanges = worktreeChanges(rebased.worktree);
        const rebasedCandidate = rebasedChanges.length
          ? stageCandidate(rebased.worktree, rebasedChanges, runDir, `candidate-rebase-${rebases}.patch`)
          : null;
        step("maintainer_rebased", {
          attempt: rebases,
          from: current.base,
          onto: main.head,
          new_commits: newCommits,
          worktree: rebased.worktree.root,
          files: rebasedChanges.map((change) => change.path),
          patch_path: rebasedCandidate?.patch_path || null,
        });
        current = {
          worktree: rebased.worktree,
          base: main.head,
          changes: rebasedChanges,
          tree: rebasedCandidate?.tree || null,
          baselineDir: `${dir}-base`,
          patchPath: rebasedCandidate?.patch_path || current.patchPath,
        };
        extraDirs.push(current.baselineDir);
        state.in_progress.extra_worktrees = [...extraDirs];
        saveState(ctx, state);
      }

      const gate = current;
      const shape = checkChangeShape({ repo: gate.worktree, changes: gate.changes, maxDiffLines: config.maxDiffLines });
      step("maintainer_shape_checked", rebases ? { ...shape, base: gate.base, rebase: rebases } : shape);
      if (!shape.ok) return reject(shape.reasons.join("; "));

      // Checked before the suites (they can take an hour) and again at the
      // cherry-pick, since other agents keep writing the main tree.
      const touched = gate.changes.map((change) => change.path);
      const dirty = dirtyPaths(repo, touched);
      if (dirty.length) return reject(`main tree has local changes in ${dirty.join(", ")}`);

      // The baseline is a clean worktree of the base this gate runs on: after
      // a rebase, the new HEAD.
      let baselineWorktree = null;
      const suites = runSuitesWithBaseline({
        cwd: gate.worktree.pkg,
        baselineCwd: () => {
          if (!baselineWorktree) {
            baselineWorktree = createWorktree(repo, gate.baselineDir, gate.base);
            step("maintainer_baseline_worktree_created", { worktree: baselineWorktree.root, base: gate.base });
          }
          return baselineWorktree.pkg;
        },
        targetDir,
        config,
        runTestSuite: deps.runTestSuite || defaultRunTestSuite,
        log: (eventType, payload) => step(eventType, payload),
      });
      writeJsonFile(path.join(runDir, rebases ? `test-report-rebase-${rebases}.json` : "test-report.json"), suites);
      if (!suites.ok) return reject(`new test failures: ${suites.new_failures.slice(0, 10).join("; ")}`, rebases ? { rebases } : {});

      nativeChanged = gate.changes.some((change) =>
        (packageRelative(repo, change.path) || "").startsWith("native/researchlab-harness/"));
      if (nativeChanged) {
        const build = buildRelease({ cwd: gate.worktree.pkg, targetDir });
        step("maintainer_release_build", { where: "worktree", ok: build.ok, exit_code: build.exit_code ?? null, output_tail: build.output_tail || null });
        if (!build.ok) return reject("release build failed");
      }

      committed = commitInWorktree({ worktree: gate.worktree, tree: gate.tree, verdict, cycleId, runId, runDir });
      step("maintainer_commit", committed);
      if (!committed.ok) return reject(committed.reason);
      applied = applyToMainTree({ repo, commit: committed.commit, base: gate.base, paths: touched });
      step("maintainer_cherry_pick", applied);
      if (applied.ok) break;
      // HEAD moved while the gate ran: back to the top, which rebases (or
      // gives up once the attempts are spent).
      if (!applied.head_moved) return reject(applied.reason, { worktree_commit: committed.commit });
    }
    const changesLanded = current.changes;
    accepted = true;

    let push = null;
    if (config.push) {
      push = (deps.pushBranch || pushBranch)({ repo });
      step("maintainer_push", push);
    }

    // The real binary, now that the main tree has the fix. It built in the
    // worktree; a failure here is the environment (a locked binary, say), and
    // the next native bootstrap rebuilds from the committed sources.
    let releaseBuildOk = null;
    if (nativeChanged) {
      const build = buildRelease({ cwd });
      releaseBuildOk = build.ok === true;
      step("maintainer_release_build", { where: "main", ok: build.ok, exit_code: build.exit_code ?? null, output_tail: build.output_tail || null });
    }

    let resumed = false;
    let resolvedMarkers = [];
    let healActions = [];
    if (verdict.clears_pause) {
      resolvedMarkers = resolvePauseMarkers({ cwd, cycleId, deps });
      clearTerminationCode({ cwd, cycleId });
      healActions = (deps.healCycleOnce || healCycleOnce)({
        cwd,
        cycleId,
        staleSeconds,
        error: `maintainer ${runId} fixed: ${verdict.commit_title}`,
      });
      resumed = true;
      step("maintainer_resumed", { resolved_markers: resolvedMarkers, heal_actions: healActions });
    }
    return finish("accepted", {
      verdict: verdict.verdict,
      commit: applied.commit,
      commit_title: committed.title,
      pushed: push ? push.ok : null,
      release_build_ok: releaseBuildOk,
      resumed,
      restart_required: changesNeedRestart(repo, changesLanded),
      reason: clip(verdict.root_cause, 1000),
    });
  } finally {
    // Every exit, an exception half-way through the gate included: the
    // container and both worktrees go; the patch stays in the run directory.
    const cleanup = {};
    try {
      if (venue.kind === "docker") cleanup.container_removed = removeDockerContainer(venue.command, venue.containerName, env);
      cleanup.worktrees = [worktree.root, baselineDir, ...extraDirs]
        .filter((dir) => dir === worktree.root || fs.existsSync(dir))
        .map((dir) => removeWorktree(repo, dir));
      if (!accepted) {
        const restored = restoreRemovedGuarded(guarded);
        if (restored.length) cleanup.guarded_restored = restored;
      }
    } catch (cleanupError) {
      cleanup.error = clip(textOf(cleanupError), 2000);
    }
    logEvent(ctx, "maintainer_worktree_removed", { run_id: runId, ...cleanup });
    report.cleanup = cleanup;
    try { writeJsonFile(path.join(runDir, "report.json"), report); } catch { /* the report is best effort */ }
    if (state.in_progress) {
      state.in_progress = null;
      saveState(ctx, state);
    }
  }
}

// After an accepted fix that changed orchestrator JS, the process has to be
// replaced for the fix to run -- but only when nothing is left paused: a fresh
// run-research clears the stop code, and a pause marker without one holds
// run-plan in its /resume wait indefinitely.
function maybeRestartAfterMaintenance({ cwd, cycleId, outcome, env = process.env }) {
  if (!outcome || outcome.outcome !== "accepted" || outcome.restart_required !== true) return false;
  if (readPauseMarker({ cwd, cycleId })) {
    logEvent({ cwd, cycleId }, "maintainer_restart_deferred", {
      run_id: outcome.run_id,
      reason: "a pause marker is still present; the fix runs on the next manual resume",
    });
    return false;
  }
  return restartOrchestrator({ cwd, cycleId, runId: outcome.run_id, env });
}

// Replace this orchestrator with a fresh one so an accepted JS fix is the code
// that runs. The child inherits the console and the environment (including the
// maintainer's persisted caps), and this process exits with its status.
function restartOrchestrator({ cwd, cycleId, runId, env = process.env }) {
  const depth = Number(env.RESEARCHLAB_MAINTAINER_RESTART_DEPTH || "0");
  const config = maintainerConfig(env);
  if (!config.restart || depth >= config.maxRuns) {
    logEvent({ cwd, cycleId }, "maintainer_restart_skipped", { run_id: runId, depth });
    return false;
  }
  const cliPath = path.join(__dirname, "..", "cli", "index.js");
  const mainFile = require.main?.filename || null;
  // Launched through a launcher script (it sets the environment and rewrites
  // argv, then requires the CLI): run the launcher again. Launched as the CLI
  // itself: run it again with the same arguments.
  const args = mainFile && path.resolve(mainFile) !== path.resolve(cliPath)
    ? [...process.execArgv, mainFile]
    : [...process.execArgv, ...process.argv.slice(1)];
  logEvent({ cwd, cycleId }, "maintainer_restart", { run_id: runId, depth: depth + 1, argv: args.map((arg) => clip(arg, 200)) });
  const child = spawnSync(process.execPath, args, {
    cwd,
    stdio: "inherit",
    env: { ...env, RESEARCHLAB_MAINTAINER_RESTART_DEPTH: String(depth + 1) },
    windowsHide: true,
  });
  process.exit(child.status ?? 1);
  return true;
}

module.exports = {
  maintainAfterAbort,
  maybeRestartAfterMaintenance,
  maybeRunMaintainer,
  recoverInterruptedRun,
  restartOrchestrator,
  maintainerConfig,
  __private: {
    BUDGET_TERMINATION_CODE,
    OUTPUT_SCHEMA,
    buildEvidence,
    buildPrompt,
    cargoTestFailures,
    enforceBudget,
    checkChangeShape,
    codexArgs,
    containerPrompt,
    defaultRunCodex,
    detectTriggers,
    dirtyPaths,
    dockerRunArgs,
    hostToContainer,
    infrastructureBugSignature,
    isAllowedPath,
    nodeTestFailures,
    normalizeErrorText,
    openRepo,
    parseAgentVerdict,
    pytestFailures,
    readTail,
    resolveVenue,
    skipCountOf,
    statePath,
    testCountOf,
    translateHostPaths,
    worktreesRoot,
  },
};
