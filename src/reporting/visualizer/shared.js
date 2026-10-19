"use strict";

const fs = require("fs");
const path = require("path");
const { readJson } = require("../../shared/json");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findLatestVersionedJson(dirPath, prefix, suffix = ".json") {
  if (!fs.existsSync(dirPath)) return null;
  let best = null;
  let bestRevision = -1;

  for (const name of fs.readdirSync(dirPath)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const middle = name
      .slice(prefix.length, name.length - suffix.length)
      .replace(/^v/, "");
    const revision = Number(middle);
    if (!Number.isFinite(revision)) continue;
    if (revision > bestRevision) {
      bestRevision = revision;
      best = path.join(dirPath, name);
    }
  }

  return best;
}

function readJsonIfExists(filePath, maxBytes = null) {
  if (!fs.existsSync(filePath)) return null;
  if (maxBytes != null && Number.isFinite(Number(maxBytes))) {
    try {
      if (fs.statSync(filePath).size > Number(maxBytes)) return null;
    } catch {
      return null;
    }
  }
  return readJson(filePath);
}

function readJsonlIfExists(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Number(options.maxBytes)
    : 8 * 1024 * 1024;
  let content = "";
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
        content = buffer.toString("utf8");
        const firstNewline = content.indexOf("\n");
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(filePath, "utf8");
    }
  } catch {
    return [];
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function baseLaneId(laneId) {
  let current = String(laneId || "");
  while (current.includes("-recovery-")) {
    current = current.slice(0, current.lastIndexOf("-recovery-"));
  }
  return current;
}

function laneStatusPriority(laneId, status) {
  const recoveryBonus = String(laneId || "").includes("-recovery-") ? 100 : 0;
  const statusScore = ({
    completed: 40,
    running: 30,
    prepared: 20,
    pending: 10,
    failed: 0,
  })[String(status || "")] ?? 5;
  return recoveryBonus + statusScore;
}

function nonBlockingCycleRole(role) {
  return ["author", "gatekeeper", "illustrator"].includes(String(role || ""));
}

function reconcileCycleState(root, cycleId, cycleStateInput) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return cycleStateInput;

  const trustedLaneStatuses = Array.isArray(cycleStateInput?.lane_statuses)
    ? cycleStateInput.lane_statuses.filter((item) => item && typeof item === "object")
    : [];
  if (trustedLaneStatuses.length > 0 && process.env.RESEARCHLAB_RECONCILE_LANE_DIRS !== "1") {
    return reconcileCycleStateFromStatuses(root, cycleId, cycleStateInput, trustedLaneStatuses);
  }

  const entries = fs.readdirSync(lanesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const laneStatusesByBase = new Map();
  for (const entry of entries) {
    const laneId = entry.name;
    const laneRoot = path.join(lanesRoot, laneId);
    const hasRunState = fs.existsSync(path.join(laneRoot, "run-state.json"));
    const hasFinalStatus = fs.existsSync(path.join(laneRoot, "final-status.json"));
    const resultExists = fs.existsSync(path.join(laneRoot, "result.json"));
    const hasProcess = fs.existsSync(path.join(laneRoot, "process.json"));
    if (!hasRunState && !hasFinalStatus && !resultExists && !hasProcess) continue;

    const runState = readJsonIfExists(path.join(laneRoot, "run-state.json")) || {};
    const finalStatus = readJsonIfExists(path.join(laneRoot, "final-status.json")) || {};
    const rolePlan = readJsonIfExists(path.join(laneRoot, "role-plan.json"), 5 * 1024 * 1024) || {};
    const status =
      finalStatus.status ||
      (resultExists && runState.status === "running" ? "completed" : runState.status) ||
      "unknown";

    const laneStatus = {
      lane_id: laneId,
      status,
      role: runState.role || rolePlan.role || null,
      runtime_class: runState.runtime_class || rolePlan.runtime_class || null,
      updated_at: finalStatus.completed_at || runState.updated_at || runState.started_at || null,
      result_path: resultExists ? path.join(laneRoot, "result.json") : (runState.result_path || finalStatus.result_path || null),
    };
    const baseId = baseLaneId(laneId);
    const existing = laneStatusesByBase.get(baseId);
    if (!existing || laneStatusPriority(laneId, status) >= laneStatusPriority(existing.lane_id, existing.status)) {
      laneStatusesByBase.set(baseId, laneStatus);
    }
  }

  const laneStatuses = Array.from(laneStatusesByBase.values());

  if (!laneStatuses.length) return cycleStateInput;

  laneStatuses.sort((a, b) => String(a.lane_id || "").localeCompare(String(b.lane_id || "")));
  const counts = {
    total: laneStatuses.length,
    running: 0,
    pending: 0,
    completed: 0,
    aborted: 0,
    unknown: 0,
    failed: 0,
    failed_blocking: 0,
    failed_non_blocking: 0,
  };
  for (const item of laneStatuses) {
    if (item.status === "running") counts.running += 1;
    else if (item.status === "pending" || item.status === "prepared") counts.pending += 1;
    else if (item.status === "completed") counts.completed += 1;
    else if (item.status === "aborted") counts.aborted += 1;
    else if (item.status === "failed") {
      counts.failed += 1;
      if (nonBlockingCycleRole(item.role)) counts.failed_non_blocking += 1;
      else counts.failed_blocking += 1;
    } else counts.unknown += 1;
  }

  const stateRoot = path.join(root, "state");
  const gateReview = readJsonIfExists(path.join(stateRoot, `${cycleId}-gate-review.json`));
  const conclusionReview = readJsonIfExists(path.join(stateRoot, `${cycleId}-conclusion-review.json`));
  const strategyDecision = readJsonIfExists(path.join(stateRoot, `${cycleId}-strategy-decision.json`));
  const gateDeferred = Boolean(gateReview) && (
    gateReview.gate_passed !== true ||
    gateReview.conclusion_gate_eligible === false ||
    ["defer", "refine", "challenge", "reject"].includes(String(gateReview.mode || ""))
  );
  const conclusionIncomplete = Boolean(conclusionReview) && (
    conclusionReview.conclusion_gate_passed === false ||
    ["defer", "refine", "challenge", "reject"].includes(String(conclusionReview.mode || ""))
  );
  const strategyRequestsMoreWork = Boolean(strategyDecision) &&
    ["pivot", "refine", "challenge"].includes(String(strategyDecision.mode || ""));
  const inactiveButScientificallyOpen = counts.running === 0 && counts.pending === 0 && counts.failed === 0 &&
    (gateDeferred || conclusionIncomplete || strategyRequestsMoreWork);

  const recoveryNeeded = counts.failed_blocking > 0 || counts.failed_non_blocking > 0 || inactiveButScientificallyOpen;
  const status = counts.running > 0 || counts.pending > 0 || recoveryNeeded
    ? (inactiveButScientificallyOpen ? "blocked_no_active_lanes" : "running")
    : (counts.aborted > 0 || counts.unknown > 0 ? "completed_with_aborts" : "completed");

  const next = {
    ...cycleStateInput,
    status,
    completed_at: status === "completed" ? (cycleStateInput.completed_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
    lane_counts: counts,
    lane_statuses: laneStatuses,
    recovery_needed: recoveryNeeded,
    lab_director_attention_required: recoveryNeeded,
    open_scientific_state: {
      gate_deferred: gateDeferred,
      conclusion_incomplete: conclusionIncomplete,
      strategy_requests_more_work: strategyRequestsMoreWork,
      inactive_but_scientifically_open: inactiveButScientificallyOpen,
    },
  };

  const staleRunning = String(cycleStateInput.status || "") === "running" && counts.running === 0 && counts.pending === 0;
  const mismatchedCounts = JSON.stringify(cycleStateInput.lane_counts || {}) !== JSON.stringify(counts);
  const mismatchedStatuses = JSON.stringify(cycleStateInput.lane_statuses || []) !== JSON.stringify(laneStatuses);
  const mismatchedStatus = String(cycleStateInput.status || "") !== status;
  if (staleRunning || mismatchedCounts || mismatchedStatuses || mismatchedStatus) {
    const statePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
    fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return next;
}

function reconcileCycleStateFromStatuses(root, cycleId, cycleStateInput, laneStatusesInput) {
  const laneStatusesByBase = new Map();
  for (const laneStatus of laneStatusesInput) {
    const laneId = String(laneStatus?.lane_id || "");
    if (!laneId) continue;
    const baseId = baseLaneId(laneId);
    const existing = laneStatusesByBase.get(baseId);
    if (!existing || laneStatusPriority(laneId, laneStatus.status) >= laneStatusPriority(existing.lane_id, existing.status)) {
      laneStatusesByBase.set(baseId, laneStatus);
    }
  }
  const laneStatuses = Array.from(laneStatusesByBase.values());
  laneStatuses.sort((a, b) => String(a.lane_id || "").localeCompare(String(b.lane_id || "")));

  const counts = {
    total: laneStatuses.length,
    running: 0,
    pending: 0,
    completed: 0,
    aborted: 0,
    unknown: 0,
    failed: 0,
    failed_blocking: 0,
    failed_non_blocking: 0,
  };
  for (const item of laneStatuses) {
    if (item.status === "running") counts.running += 1;
    else if (item.status === "pending" || item.status === "prepared") counts.pending += 1;
    else if (item.status === "completed") counts.completed += 1;
    else if (item.status === "aborted") counts.aborted += 1;
    else if (item.status === "failed") {
      counts.failed += 1;
      if (nonBlockingCycleRole(item.role)) counts.failed_non_blocking += 1;
      else counts.failed_blocking += 1;
    } else counts.unknown += 1;
  }

  const stateRoot = path.join(root, "state");
  const gateReview = readJsonIfExists(path.join(stateRoot, `${cycleId}-gate-review.json`));
  const conclusionReview = readJsonIfExists(path.join(stateRoot, `${cycleId}-conclusion-review.json`));
  const strategyDecision = readJsonIfExists(path.join(stateRoot, `${cycleId}-strategy-decision.json`));
  const gateDeferred = Boolean(gateReview) && (
    gateReview.gate_passed !== true ||
    gateReview.conclusion_gate_eligible === false ||
    ["defer", "refine", "challenge", "reject"].includes(String(gateReview.mode || ""))
  );
  const conclusionIncomplete = Boolean(conclusionReview) && (
    conclusionReview.conclusion_gate_passed === false ||
    ["defer", "refine", "challenge", "reject"].includes(String(conclusionReview.mode || ""))
  );
  const strategyRequestsMoreWork = Boolean(strategyDecision) &&
    ["pivot", "refine", "challenge"].includes(String(strategyDecision.mode || ""));
  const inactiveButScientificallyOpen = counts.running === 0 && counts.pending === 0 && counts.failed === 0 &&
    (gateDeferred || conclusionIncomplete || strategyRequestsMoreWork);

  const recoveryNeeded = counts.failed_blocking > 0 || counts.failed_non_blocking > 0 || inactiveButScientificallyOpen;
  const status = counts.running > 0 || counts.pending > 0 || recoveryNeeded
    ? (inactiveButScientificallyOpen ? "blocked_no_active_lanes" : "running")
    : (counts.aborted > 0 || counts.unknown > 0 ? "completed_with_aborts" : "completed");

  const next = {
    ...cycleStateInput,
    status,
    completed_at: status === "completed" ? (cycleStateInput.completed_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
    lane_counts: {
      ...(cycleStateInput?.lane_counts || {}),
      ...counts,
    },
    lane_statuses: laneStatuses,
    recovery_needed: recoveryNeeded,
    lab_director_attention_required: recoveryNeeded,
    open_scientific_state: {
      gate_deferred: gateDeferred,
      conclusion_incomplete: conclusionIncomplete,
      strategy_requests_more_work: strategyRequestsMoreWork,
      inactive_but_scientifically_open: inactiveButScientificallyOpen,
    },
  };
  const staleRunning = String(cycleStateInput.status || "") === "running" && counts.running === 0 && counts.pending === 0;
  const mismatchedCounts = JSON.stringify(cycleStateInput.lane_counts || {}) !== JSON.stringify(next.lane_counts);
  const mismatchedStatuses = JSON.stringify(cycleStateInput.lane_statuses || []) !== JSON.stringify(laneStatuses);
  const mismatchedStatus = String(cycleStateInput.status || "") !== status;
  if (staleRunning || mismatchedCounts || mismatchedStatuses || mismatchedStatus) {
    const statePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
    fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return next;
}

function formatSigned(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(digits)}`;
}

function formatPlain(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(digits);
}

function formatPercent(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return `${(numeric * 100).toFixed(digits)}%`;
}

function outcomeTone(value) {
  return Number(value) >= 0 ? "#0f766e" : "#b91c1c";
}

module.exports = {
  escapeHtml,
  findLatestVersionedJson,
  readJsonIfExists,
  readJsonlIfExists,
  uniqueStrings,
  reconcileCycleState,
  formatSigned,
  formatPlain,
  formatPercent,
  outcomeTone,
};
