"use strict";

const fs = require("fs");
const path = require("path");

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasActiveLanes({ cwd = process.cwd(), cycleId }) {
  if (!cycleId) return false;
  const statePath = path.join(cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`);
  const state = readJsonIfExists(statePath) || {};
  const laneStatuses = Array.isArray(state.lane_statuses) ? state.lane_statuses : [];
  return laneStatuses.some((lane) => ["pending", "prepared", "running"].includes(lane?.status));
}

function shouldUseContextRefreshAfterRun({ cwd = process.cwd(), cycleId, env = process.env }) {
  const mode = String(env.RESEARCHLAB_RUN_REFRESH_MODE || "").trim().toLowerCase();
  if (mode === "full") return false;
  if (mode === "context" || mode === "context-only") return true;
  return hasActiveLanes({ cwd, cycleId });
}

module.exports = {
  hasActiveLanes,
  shouldUseContextRefreshAfterRun,
};
