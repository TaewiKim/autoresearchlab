"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const [runtimeRoot, cycleId, rawStaleSeconds] = process.argv.slice(2);
const defaultStaleSeconds = Math.max(1, Number.parseInt(rawStaleSeconds || "1800", 10) || 1800);
const statePath = path.join(runtimeRoot, "state", `${cycleId}-cycle-run-state.json`);
const lanesRoot = path.join(runtimeRoot, "lanes", cycleId);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function laneStaleSeconds(role, runtimeClass) {
  if (role === "scout" && runtimeClass === "external-driver") {
    return Math.max(defaultStaleSeconds, 6 * 60 * 60);
  }
  if (role === "lab-runner" && runtimeClass === "external-driver") {
    return Math.max(defaultStaleSeconds, 2 * 60 * 60);
  }
  return defaultStaleSeconds;
}

function pidStatus(pid) {
  const numeric = Number(pid);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { live: false, status: "missing_pid", ps_stat: null };
  }
  const ps = spawnSync("ps", ["-p", String(numeric), "-o", "stat="], { encoding: "utf8" });
  const stat = ps.status === 0 ? String(ps.stdout || "").trim().split(/\s+/, 1)[0] : "";
  if (!stat) return { live: false, status: "dead_pid", ps_stat: null };
  if (/^Z/.test(stat)) return { live: false, status: "zombie_pid", ps_stat: stat };
  try {
    process.kill(numeric, 0);
  } catch {
    return { live: false, status: "dead_pid", ps_stat: stat };
  }
  return { live: true, status: "live_pid", ps_stat: stat };
}

const state = readJson(statePath) || {};
const stateLanes = Array.isArray(state.lane_statuses) ? state.lane_statuses : [];
const stateLaneById = new Map();
for (const lane of stateLanes) {
  const laneId = String(lane?.lane_id || "");
  if (laneId) stateLaneById.set(laneId, lane);
}
const runningByLaneId = new Map();
for (const lane of stateLanes) {
  if (String(lane?.status || "") !== "running") continue;
  const laneId = String(lane?.lane_id || "");
  if (laneId) runningByLaneId.set(laneId, lane);
}
try {
  for (const entry of fs.readdirSync(lanesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const laneId = entry.name;
    const laneDir = path.join(lanesRoot, laneId);
    const runState = readJson(path.join(laneDir, "run-state.json")) || {};
    if (String(runState.status || "") !== "running") continue;
    const stateLane = stateLaneById.get(laneId) || {};
    runningByLaneId.set(laneId, {
      ...stateLane,
      ...runState,
      lane_id: laneId,
      role: stateLane.role || runState.role,
      runtime_class: stateLane.runtime_class || runState.runtime_class,
    });
  }
} catch {
  // Missing lanes root is handled naturally by the empty state-derived set.
}
const running = Array.from(runningByLaneId.values());
const problems = [];

for (const lane of running) {
  const laneId = String(lane?.lane_id || "");
  if (!laneId) continue;
  const laneDir = path.join(lanesRoot, laneId);
  const runStatePath = path.join(laneDir, "run-state.json");
  const processPath = path.join(laneDir, "process.json");
  const finalStatusPath = path.join(laneDir, "final-status.json");
  const resultPath = path.join(laneDir, "result.json");
  const runState = readJson(runStatePath) || {};
  const processInfo = readJson(processPath) || {};
  const finalStatus = readJson(finalStatusPath) || {};
  const result = readJson(resultPath) || {};
  const role = String(lane.role || runState.role || processInfo.role || "");
  const runtimeClass = String(lane.runtime_class || runState.runtime_class || processInfo.runtime_class || "");
  const pid = runState.pid || runState.process_id || processInfo.pid || processInfo.process_id || null;
  const status = pidStatus(pid);
  const startedAt = Date.parse(
    runState.updated_at ||
    processInfo.updated_at ||
    processInfo.started_at ||
    runState.started_at ||
    "",
  );
  const ageSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : null;
  const threshold = laneStaleSeconds(role, runtimeClass);
  const finalized = finalStatus.status || result.status || null;
  const reasons = [];
  if (!status.live) reasons.push(status.status);
  if (ageSeconds !== null && ageSeconds > threshold) reasons.push("age_exceeded");
  if (finalized && !["running", "pending"].includes(String(finalized))) reasons.push("finalized_but_state_running");
  if (reasons.length === 0) continue;
  problems.push({
    lane_id: laneId,
    role,
    runtime_class: runtimeClass,
    pid,
    pid_status: status.status,
    ps_stat: status.ps_stat,
    age_seconds: ageSeconds,
    stale_seconds: threshold,
    reasons,
    run_state_path: fs.existsSync(runStatePath) ? runStatePath : null,
    process_path: fs.existsSync(processPath) ? processPath : null,
    finalized_status: finalized,
  });
}

if (problems.length === 0) process.exit(0);
process.stdout.write(JSON.stringify({
  problem_count: problems.length,
  lane_ids: problems.map((item) => item.lane_id),
  problems,
}));
