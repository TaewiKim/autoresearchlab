"use strict";

const fs = require("fs");
const path = require("path");

const [runtimeRoot, cycleId, rawLimit] = process.argv.slice(2);
const limit = Math.max(1, Number.parseInt(rawLimit || "4", 10) || 4);
const byLane = new Map();

function laneOrdinal(laneId) {
  const match = String(laneId || "").match(/^followup-scout-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : -1;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolvePath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function remember(laneId, resultPath, orderKey) {
  if (!/^followup-scout-[^/]+$/.test(laneId || "") || !resultPath) return;
  const result = safeReadJson(resultPath);
  if (!result) return;
  const existing = byLane.get(laneId);
  if (!existing || orderKey > existing.orderKey) {
    byLane.set(laneId, { laneId, path: resultPath, orderKey, result });
  }
}

function collectFromState() {
  const statePath = path.join(runtimeRoot, "state", `${cycleId}-cycle-run-state.json`);
  const state = safeReadJson(statePath);
  const laneStatuses = Array.isArray(state?.lane_statuses) ? state.lane_statuses : [];
  const scouts = laneStatuses
    .filter((lane) => /^followup-scout-[^/]+$/.test(lane?.lane_id || ""))
    .sort((a, b) => laneOrdinal(b.lane_id) - laneOrdinal(a.lane_id))
    .slice(0, Math.max(limit * 3, limit));
  for (const lane of scouts) {
    const laneId = lane.lane_id;
    const resultPath = resolvePath(lane.result_path) || path.join(runtimeRoot, "lanes", cycleId, laneId, "result.json");
    remember(laneId, resultPath, laneOrdinal(laneId));
  }
}

function collectFallbackFromLaneRoot() {
  const root = path.join(runtimeRoot, "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries
    .filter((entry) => entry.isDirectory() && /^followup-scout-[^/]+$/.test(entry.name))
    .sort((a, b) => laneOrdinal(b.name) - laneOrdinal(a.name))
    .slice(0, Math.max(limit * 3, limit))
    .forEach((entry) => {
      const laneId = entry.name;
      remember(laneId, path.join(root, laneId, "result.json"), laneOrdinal(laneId));
    });
}

collectFromState();
if (byLane.size < limit) collectFallbackFromLaneRoot();

const latest = [...byLane.values()]
  .sort((a, b) => b.orderKey - a.orderKey)
  .slice(0, limit)
  .map((item) => {
    const result = item.result || {};
    return {
      lane_id: item.laneId,
      result_path: item.path,
      status: result.status || null,
      candidate_count: Number(result.candidate_count || 0),
      open_candidate_count: Number(result.open_candidate_count || 0),
      candidates_with_accession: Number(result.candidates_with_accession || 0),
      fetched_bundle_count: Number(result.fetched_bundle_count || 0),
      data_graph_appended: result.data_graph_appended === true,
      data_graph_update_path: result.data_graph_update_path || null,
    };
  });

if (latest.length < limit) process.exit(0);

const stagnating = latest.every((item) =>
  item.status === "completed" &&
  item.candidate_count > 0 &&
  item.candidates_with_accession > 0 &&
  item.data_graph_appended !== true &&
  !item.data_graph_update_path
);

if (!stagnating) process.exit(0);

const totals = latest.reduce((acc, item) => {
  acc.candidate_count += item.candidate_count;
  acc.open_candidate_count += item.open_candidate_count;
  acc.candidates_with_accession += item.candidates_with_accession;
  acc.fetched_bundle_count += item.fetched_bundle_count;
  if (item.data_graph_appended || item.data_graph_update_path) acc.data_graph_update_count += 1;
  return acc;
}, {
  candidate_count: 0,
  open_candidate_count: 0,
  candidates_with_accession: 0,
  fetched_bundle_count: 0,
  data_graph_update_count: 0,
});

process.stdout.write(JSON.stringify({
  repeated_lane_count: latest.length,
  lane_ids: latest.map((item) => item.lane_id),
  result_paths: latest.map((item) => item.result_path),
  totals,
}));
