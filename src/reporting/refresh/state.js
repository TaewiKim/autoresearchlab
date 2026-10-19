"use strict";

const fs = require("fs");
const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { runNative } = require("../../runtime/native_runtime");
const { stageForSummary } = require("../../policy/stage_policy");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function summarizeCycleState({ cwd, cycleId }) {
  const root = runtimeRoot(cwd);
  const cycleStatePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const cycleState = readJsonIfExists(cycleStatePath) || {};
  const laneStatuses = Array.isArray(cycleState.lane_statuses) ? cycleState.lane_statuses : [];
  const isPrimaryEvidenceLane = (item) => {
    return ["scout", "analyst", "lab-runner"].includes(item?.role);
  };
  const runningLaneCount = laneStatuses.filter((item) => item?.status === "running").length;
  const pendingLaneCount = laneStatuses.filter((item) => item?.status === "pending").length;
  const runningCoreLaneCount = laneStatuses.filter((item) => {
    return isPrimaryEvidenceLane(item) && item?.status === "running";
  }).length;
  const pendingCoreLaneCount = laneStatuses.filter((item) => {
    return isPrimaryEvidenceLane(item) && item?.status === "pending";
  }).length;
  const completedLabRunnerCount = laneStatuses.filter((item) => {
    return item?.role === "lab-runner" && item?.status === "completed";
  }).length;
  return {
    root,
    cycleStatePath,
    cycleState,
    laneStatuses,
    runningLaneCount,
    pendingLaneCount,
    runningCoreLaneCount,
    pendingCoreLaneCount,
    completedLabRunnerCount,
    // Liveness invariant for validity-gated governance (FIX-N). The fail-closed
    // CONSUMPTION gate (dependency_gates_01: zero classified hypotheses -> suppress
    // analyst/lab-runner dispatch) and this refresh guard could deadlock each other:
    // suppressed core lanes stay `pending`, this guard then skips the synthesis that
    // would MINT the classifying hypotheses, and 0 hypotheses persist forever. The
    // decision-PRODUCING/recovery path must stay live independent of the
    // consumption gate. So block the full refresh only while lanes are ACTIVELY
    // executing (runningLaneCount > 0). When nothing is running, pending-but-stuck
    // core lanes must NOT block synthesis/ledger/gate — producing and evaluating
    // from the completed lanes is exactly the recovery that unblocks dispatch. The
    // early-cycle case stays protected by completedLabRunnerCount < 1, so this only
    // relaxes once the cycle is mature and idle. The consumption-side gate is
    // unchanged and still fail-closed (no stale-invalid downstream use).
    pendingCoreAnalysis: runningLaneCount > 0 || runningCoreLaneCount > 0 || completedLabRunnerCount < 1,
  };
}

function pendingEvidenceReadiness(cycleSummary) {
  return {
    ready: false,
    completed_core_lane_count: cycleSummary.laneStatuses.filter((item) => {
      return ["scout", "analyst", "lab-runner"].includes(item?.role) && item?.status === "completed";
    }).length,
    pending_lane_count: cycleSummary.pendingLaneCount,
    running_core_lane_count: cycleSummary.runningCoreLaneCount,
    pending_core_lane_count: cycleSummary.pendingCoreLaneCount,
    reasons: pendingRefreshReasons(cycleSummary),
  };
}

function pendingRefreshReasons(cycleSummary) {
  return [
    cycleSummary.completedLabRunnerCount < 1
      ? "wait for at least one completed lab-runner lane"
      : "",
    cycleSummary.pendingCoreLaneCount > 0
      ? "wait for pending core analysis lanes to finish"
      : "",
    cycleSummary.pendingLaneCount > 0
      ? "wait for pending lanes to finish before expensive full refresh"
      : "",
    cycleSummary.runningLaneCount > 0
      ? "wait for running lanes to finish before expensive full refresh"
      : "",
    cycleSummary.runningCoreLaneCount > 0
      ? "wait for running core analysis lanes to finish"
      : "",
  ].filter(Boolean);
}

function inferRefreshStage({ root, cycleId }) {
  const summary = {
    conclusion_review: {
      review: readJsonIfExists(path.join(root, "state", `${cycleId}-conclusion-review.json`)),
    },
    gate_review: {
      review: readJsonIfExists(path.join(root, "state", `${cycleId}-gate-review.json`)),
    },
    report_review: {
      review: readJsonIfExists(path.join(root, "state", `${cycleId}-report-review.json`)),
    },
    paper_review: {
      review: readJsonIfExists(path.join(root, "state", `${cycleId}-paper-review.json`)),
    },
  };
  return stageForSummary(summary);
}

function refreshCycleState({ cwd, cycleId, aggregateRunner = runNative }) {
  const root = runtimeRoot(cwd);
  const lanesDir = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesDir)) return null;
  // aggregate-cycle persists the authoritative cycle-run-state to disk. On
  // large long-running cycles its JSON stdout can exceed Node's maximum string
  // size when spawnSync decodes a pipe, so native stdout/stderr stay ignored.
  const result = aggregateRunner(["aggregate-cycle", "--cycle-id", cycleId], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result?.status !== 0) {
    throw new Error(result?.stderr || `aggregate-cycle failed for ${cycleId}`);
  }
  try {
    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    if (stdout.trim()) return JSON.parse(stdout.trim());
  } catch {
    // Ignore malformed optional stdout; the persisted state is authoritative.
  }
  return readJsonIfExists(path.join(root, "state", `${cycleId}-cycle-run-state.json`));
}

module.exports = {
  inferRefreshStage,
  pendingEvidenceReadiness,
  pendingRefreshReasons,
  readJsonIfExists,
  refreshCycleState,
  summarizeCycleState,
};
