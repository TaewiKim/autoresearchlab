"use strict";

const fs = require("fs");
const path = require("path");

const [
  runtimeRootArg,
  cycleId,
  rawGateLagSeconds,
  rawScoutNoFamilyLimit,
  rawStaleFailedOrdinalGap,
] = process.argv.slice(2);

const runtimeRoot = runtimeRootArg || ".research-lab";
function parseIntWithDefault(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const gateLagSeconds = Math.max(0, parseIntWithDefault(rawGateLagSeconds, 600));
const scoutNoFamilyLimit = Math.max(1, parseIntWithDefault(rawScoutNoFamilyLimit, 3));
const staleFailedOrdinalGap = Math.max(1, parseIntWithDefault(rawStaleFailedOrdinalGap, 50));

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function fileMtimeSeconds(filePath) {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

function resolvePath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function laneOrdinal(laneId) {
  const match = String(laneId || "").match(/^followup-[a-z-]+-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : -1;
}

function runnerOrdinal(laneId) {
  const match = String(laneId || "").match(/^followup-runner-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : -1;
}

function resultPathForLane(lane) {
  const laneId = String(lane?.lane_id || "");
  return (
    resolvePath(lane?.result_path) ||
    path.join(runtimeRoot, "lanes", cycleId, laneId, "result.json") ||
    null
  );
}

function readLaneResult(lane) {
  const resultPath = resultPathForLane(lane);
  return { resultPath, result: resultPath ? readJson(resultPath) : null };
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function candidateFamilyCount(result) {
  return arrayLength(result?.candidate_primary_families) ||
    arrayLength(result?.frontier_catalog?.candidate_primary_families);
}

function paperCount(result) {
  return Number(result?.paper_count || arrayLength(result?.papers) || 0);
}

function topPaperTitles(result) {
  const papers = Array.isArray(result?.papers) ? result.papers : [];
  return papers.slice(0, 10).map((paper) => String(paper?.title || "").trim()).filter(Boolean);
}

function tokenize(text) {
  const stop = new Set([
    "the", "and", "with", "from", "that", "this", "through", "using", "into", "than",
    "vili", "aih", "gse", "geo", "geomx", "spatial", "transcriptomics", "liver",
    "cell", "cells", "interferon", "mitochondrial", "oxidative", "injury",
  ]);
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !stop.has(token)),
  );
}

function titleTopicalityScore(titles, focusText) {
  const focusTokens = tokenize(focusText);
  if (focusTokens.size === 0 || titles.length === 0) return null;
  let matchedTitles = 0;
  for (const title of titles) {
    const titleTokens = tokenize(title);
    const hasMatch = [...focusTokens].some((token) => titleTokens.has(token));
    if (hasMatch) matchedTitles += 1;
  }
  return matchedTitles / titles.length;
}

const statePath = path.join(runtimeRoot, "state", `${cycleId}-cycle-run-state.json`);
const gatePath = path.join(runtimeRoot, "state", `${cycleId}-gate-review.json`);
const digestPath = path.join(runtimeRoot, "state", `${cycleId}-agent-communication-digest.json`);
const state = readJson(statePath) || {};
const gate = readJson(gatePath) || {};
const digest = readJson(digestPath) || {};
const lanes = Array.isArray(state.lane_statuses) ? state.lane_statuses : [];
const anomalies = [];

const completedRunners = lanes
  .filter((lane) => lane?.role === "lab-runner" && lane?.status === "completed" && /^followup-runner-\d+$/.test(String(lane?.lane_id || "")))
  .map((lane) => {
    const resultPath = resultPathForLane(lane);
    return {
      lane_id: lane.lane_id,
      ordinal: runnerOrdinal(lane.lane_id),
      result_path: resultPath,
      mtime: fileMtimeSeconds(resultPath),
    };
  })
  .filter((lane) => lane.result_path)
  .sort((a, b) => b.ordinal - a.ordinal);

const latestRunner = completedRunners[0] || null;
const gateValidationId = String(gate.latest_validation_lane_id || gate.scientific_value_gate?.latest_validation_lane_id || "");
const gateRunnerOrdinal = runnerOrdinal(gateValidationId);
if (latestRunner && gateRunnerOrdinal >= 0 && latestRunner.ordinal > gateRunnerOrdinal) {
  const lagSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.max(fileMtimeSeconds(gatePath), latestRunner.mtime || 0));
  if (lagSeconds >= gateLagSeconds) {
    anomalies.push({
      code: "gate_refresh_lag_after_runner_completion",
      severity: "research_attention",
      owner_role: "lab-director",
      detail: `latest_runner=${latestRunner.lane_id} gate_latest_validation=${gateValidationId} lag_seconds=${lagSeconds}`,
      message: "Process anomaly: a newer completed LabRunner result exists than the validation recorded in gate-review. LabDirector/Gatekeeper must refresh or explain why the latest runner is not gate-eligible; supervisor is not changing the scientific verdict.",
    });
  }
}

const completedScouts = lanes
  .filter((lane) => lane?.role === "scout" && lane?.status === "completed" && /^followup-scout-[^/]+$/.test(String(lane?.lane_id || "")))
  .sort((a, b) => laneOrdinal(b?.lane_id) - laneOrdinal(a?.lane_id))
  .slice(0, Math.max(scoutNoFamilyLimit * 3, scoutNoFamilyLimit))
  .map((lane) => {
    const { resultPath, result } = readLaneResult(lane);
    return {
      lane_id: lane.lane_id,
      ordinal: laneOrdinal(lane.lane_id),
      result_path: resultPath,
      result,
    };
  })
  .filter((lane) => lane.result)
  .sort((a, b) => b.ordinal - a.ordinal)
  .slice(0, scoutNoFamilyLimit);

if (
  completedScouts.length >= scoutNoFamilyLimit &&
  completedScouts.every((lane) => paperCount(lane.result) > 0 && candidateFamilyCount(lane.result) === 0)
) {
  anomalies.push({
    code: "scout_no_candidate_families_stagnation",
    severity: "research_blocker",
    owner_role: "lab-director",
    detail: `latest_scout_lanes=${completedScouts.map((lane) => lane.lane_id).join(",")} repeated_lane_count=${completedScouts.length}`,
    message: "Process anomaly: repeated completed Scout lanes collected papers but produced zero candidate primary families. LabDirector must decide whether to reframe the scout query, demote this path, or assign a targeted acquisition/novelty follow-up; supervisor is not choosing the hypothesis.",
  });
}

const focusText = [
  digest?.current_focus?.lead_hypothesis,
  digest?.current_focus?.hypothesis_id,
  digest?.current_focus?.dataset,
].filter(Boolean).join(" ");
const topicalityWindow = completedScouts
  .filter((lane) => topPaperTitles(lane.result).length >= 5)
  .slice(0, Math.min(2, completedScouts.length));
if (topicalityWindow.length > 0 && focusText) {
  const topicality = topicalityWindow.map((lane) => ({
    lane_id: lane.lane_id,
    score: titleTopicalityScore(topPaperTitles(lane.result), focusText),
  })).filter((item) => item.score !== null);
  if (topicality.length > 0 && topicality.every((item) => item.score <= 0.1)) {
    anomalies.push({
      code: "scout_topicality_failure",
      severity: "research_attention",
      owner_role: "lab-director",
      detail: `latest_scout_lanes=${topicality.map((item) => `${item.lane_id}:score=${item.score.toFixed(2)}`).join(",")}`,
      message: "Process anomaly: recent Scout top papers weakly match the active hypothesis/dataset focus. LabDirector must inspect whether the scout is drifting off-topic before scheduling more discovery; supervisor is not judging the science claim.",
    });
  }
}

const failedBlocking = lanes.filter((lane) => lane?.status === "failed" || lane?.status === "failed_blocking");
const latestCompletedOrdinal = lanes
  .filter((lane) => lane?.status === "completed")
  .map((lane) => laneOrdinal(lane?.lane_id))
  .filter((ordinal) => ordinal >= 0)
  .sort((a, b) => b - a)[0] ?? -1;
const staleFailed = failedBlocking
  .map((lane) => ({ lane_id: lane.lane_id, ordinal: laneOrdinal(lane.lane_id), role: lane.role }))
  .filter((lane) => lane.ordinal >= 0 && latestCompletedOrdinal - lane.ordinal >= staleFailedOrdinalGap);
if (staleFailed.length > 0) {
  anomalies.push({
    code: "stale_failed_blocking_lanes_persist",
    severity: "research_attention",
    owner_role: "lab-director",
    detail: `stale_failed_lanes=${staleFailed.map((lane) => lane.lane_id).join(",")} latest_completed_ordinal=${latestCompletedOrdinal}`,
    message: "Process anomaly: old failed blocking lanes still mark the cycle as needing recovery after many newer lanes completed. LabDirector must either supersede, close, or keep them explicitly active; supervisor is not resolving the scientific blocker.",
  });
}

if (anomalies.length === 0) process.exit(0);
process.stdout.write(JSON.stringify({ anomaly_count: anomalies.length, anomalies }));
