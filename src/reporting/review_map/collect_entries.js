"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_MAX_TERMINAL_LANES,
  PRIMARY_ARTIFACT_NAMES,
  PRIMARY_LANE_FILE_NAMES,
  STAGE_BY_ROLE,
} = require("./constants");
const {
  extractJsonStringFieldPrefix,
  readJsonIfExistsBounded,
  statInfo,
} = require("./fs_helpers");

function stageFor({ role, artifactKind }) {
  if (artifactKind && /review|gate/.test(artifactKind)) return "06-independent-gate";
  if (artifactKind && /report|paper|manuscript|document/.test(artifactKind)) return "07-document-authoring";
  if (artifactKind && /figure|visual|deck|ppt/.test(artifactKind)) return "08-figures";
  return STAGE_BY_ROLE[role] || "09-monitoring-and-state";
}

function artifactKindFromPath(filePath) {
  const base = path.basename(filePath);
  const parent = path.basename(path.dirname(filePath));
  if (base === "result.json") return "result";
  if (base === "role-plan.json") return "role-plan";
  if (base === "task.md") return "task";
  if (base === "final-status.json") return "final-status";
  if (base === "run-state.json") return "run-state";
  if (base.endsWith(".log")) return base.replace(/\.log$/, "-log");
  if (base === "external_repository_workflow_result.json") return "external-repository-workflow";
  if (base === "external_repository_agent_summary.json") return "external-repository-summary";
  if (parent === "state") return base.replace(/\.json$/, "");
  return base.replace(/\.[^.]+$/, "");
}

function addEntry(entries, root, entry) {
  if (!entry.source_path || !fs.existsSync(entry.source_path)) return;
  const info = statInfo(entry.source_path);
  const artifactKind = entry.artifact_kind || artifactKindFromPath(entry.source_path);
  const role = entry.role || "state";
  entries.push({
    cycle_id: entry.cycle_id,
    stage: entry.stage || stageFor({ role, artifactKind }),
    role,
    lane_id: entry.lane_id || null,
    action_type: entry.action_type || null,
    status: entry.status || null,
    artifact_kind: artifactKind,
    source_path: entry.source_path,
    source_path_relative: path.relative(root, entry.source_path),
    size_bytes: info.size_bytes,
    updated_at: info.updated_at,
    mtime_ms: info.mtime_ms,
  });
}

function listNamedFiles(dir, allowedNames) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && allowedNames.has(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch {
    return files;
  }
  return files;
}

function listPrimaryArtifactFiles(dir, maxChildDirs = 64) {
  const files = listNamedFiles(dir, PRIMARY_ARTIFACT_NAMES);
  if (!fs.existsSync(dir)) return files;
  let children = [];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of children.filter((item) => item.isDirectory()).slice(0, maxChildDirs)) {
    files.push(...listNamedFiles(path.join(dir, entry.name), PRIMARY_ARTIFACT_NAMES));
  }
  return files;
}

function selectLaneIdsForReviewMap({ laneIds, statusByLane, maxTerminalLanes = DEFAULT_MAX_TERMINAL_LANES }) {
  const active = [];
  const terminal = [];
  const rank = (laneId) => {
    const status = statusByLane.get(laneId) || {};
    return `${status.updated_at || status.completed_at || ""} ${laneId}`;
  };
  for (const laneId of laneIds) {
    const status = statusByLane.get(laneId) || {};
    if (!statusByLane.has(laneId)) continue;
    const laneStatus = status.status || "unknown";
    if (["pending", "prepared", "running", "failed", "unknown"].includes(laneStatus)) {
      active.push(laneId);
    } else {
      terminal.push(laneId);
    }
  }
  const selected = new Set(active);
  for (const laneId of terminal.sort((a, b) => rank(a).localeCompare(rank(b))).slice(-maxTerminalLanes)) {
    selected.add(laneId);
  }
  return laneIds.filter((laneId) => selected.has(laneId));
}

function collectReviewMapEntries({ root, cycleId, cycleState, maxTerminalLanes = DEFAULT_MAX_TERMINAL_LANES }) {
  const entries = [];
  const lanesRoot = path.join(root, "lanes", cycleId);
  const artifactsRoot = path.join(root, "artifacts", "stats", cycleId);
  const statusByLane = new Map(
    (Array.isArray(cycleState?.lane_statuses) ? cycleState.lane_statuses : [])
      .filter((item) => item?.lane_id)
      .map((item) => [item.lane_id, item]),
  );
  if (fs.existsSync(lanesRoot)) {
    const laneIds = fs.readdirSync(lanesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const laneId of selectLaneIdsForReviewMap({ laneIds, statusByLane, maxTerminalLanes })) {
      const laneDir = path.join(lanesRoot, laneId);
      if (!fs.existsSync(path.join(laneDir, "lane-contract.json"))) continue;
      const status = statusByLane.get(laneId) || {};
      const contract = readJsonIfExistsBounded(path.join(laneDir, "lane-contract.json")) || {};
      const rolePlanPath = path.join(laneDir, "role-plan.json");
      const role = status.role || contract.role || extractJsonStringFieldPrefix(rolePlanPath, "role") || "unknown";
      const actionType = status.action_type || extractJsonStringFieldPrefix(rolePlanPath, "action_type") || null;
      const laneStatus = status.status || readJsonIfExistsBounded(path.join(laneDir, "final-status.json"))?.status || "pending";
      for (const laneFilePath of listNamedFiles(laneDir, PRIMARY_LANE_FILE_NAMES)) {
        addEntry(entries, root, {
          cycle_id: cycleId,
          role,
          lane_id: laneId,
          action_type: actionType,
          status: laneStatus,
          source_path: laneFilePath,
        });
      }
      const artifactDir = path.join(artifactsRoot, laneId);
      for (const artifactPath of listPrimaryArtifactFiles(artifactDir)) {
        addEntry(entries, root, {
          cycle_id: cycleId,
          role,
          lane_id: laneId,
          action_type: actionType,
          status: laneStatus,
          source_path: artifactPath,
        });
      }
    }
  }
  const stateDir = path.join(root, "state");
  if (fs.existsSync(stateDir)) {
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(`${cycleId}-`)) continue;
      if (!/\.(json|md|txt)$/.test(name)) continue;
      addEntry(entries, root, {
        cycle_id: cycleId,
        role: "state",
        status: "materialized",
        source_path: path.join(stateDir, name),
        stage: "09-monitoring-and-state",
      });
    }
  }
  for (const dirName of ["reports", "papers", "figures", "researcher-views"]) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.includes(cycleId)) continue;
      const full = path.join(dir, name);
      const stat = statInfo(full);
      if (!stat.exists) continue;
      addEntry(entries, root, {
        cycle_id: cycleId,
        role: dirName === "figures" ? "illustrator" : "author",
        status: "materialized",
        source_path: full,
        stage: dirName === "figures" ? "08-figures" : "07-document-authoring",
      });
    }
  }
  return entries;
}

module.exports = {
  artifactKindFromPath,
  collectReviewMapEntries,
  listNamedFiles,
  listPrimaryArtifactFiles,
  selectLaneIdsForReviewMap,
  stageFor,
};
