"use strict";

// What the cycle has actually spent, and the two ceilings the supervisor holds.
//
// The owner's complaint on cycle-a-20260919: the supervisor watches
// errors and nothing else. A cycle can burn a day and a provider account
// without a single failed lane -- five and a half hours of requery, novelty,
// gate-restart and comparator lanes on that cycle cost real tokens and real
// wall-clock and produced no milestone.
//
// The billing truth is already on disk. Every Codex lane's stdout is JSONL and
// each turn ends with its own usage:
//
//   {"type":"turn.completed","usage":{"input_tokens":601636,
//    "cached_input_tokens":571904,"cache_write_input_tokens":0,
//    "output_tokens":8668,"reasoning_output_tokens":1687}}
//
// src/cli/codex_usage.js reads those for the token-budget guard, one full
// re-read of every lane log per call. A supervisor that runs between every
// run-plan pass cannot afford that: cycle-a-20260919 has 199 lane
// directories and its logs are hundreds of megabytes. So this keeps a cursor
// per file -- byte offset, size and mtime -- and reads only what was appended
// since the last pass. A log that shrank or whose mtime went backwards is
// re-read from zero; a trailing partial line is left unconsumed, so the turn it
// belongs to is counted once, when it is complete.
//
// The ceilings are soft and OFF by default (unset = no limit). At 80% the
// supervisor writes a warning event. At 100% it does NOT start a maintainer
// Codex run -- spending more of the budget to investigate the budget is the one
// action that cannot be right -- it writes the same pause and termination the
// orchestrator already uses for a researcher stop, names the budget report in
// the message, and leaves the decision to the owner.

const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const { writeJson } = require("../shared/json");

// A turn envelope is small; a command result carrying a megabyte of tool output
// is not. Skipping the long lines keeps this cheap (codex_usage.js draws the
// same line, for the same reason).
const MAX_EVENT_LINE = 8192;
const READ_CHUNK = 8 * 1024 * 1024;

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

function emptyTotals() {
  return {
    turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    wall_clock_seconds: 0,
  };
}

function addUsage(totals, usage) {
  totals.turns += 1;
  for (const field of USAGE_FIELDS) totals[field] += usage[field];
}

/** Billed input (what the provider did not serve from cache) plus output. */
function countedTokens(totals) {
  return Math.max(0, totals.input_tokens - totals.cached_input_tokens) + totals.output_tokens;
}

function withDerived(totals) {
  const billed = Math.max(0, totals.input_tokens - totals.cached_input_tokens);
  return {
    ...totals,
    billed_input_tokens: billed,
    counted_tokens: billed + totals.output_tokens,
  };
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function parseMs(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Append-only read of a JSONL log from `cursor.offset`.
 *
 * Returns the turns it could parse WHOLE and the new cursor. The last line is
 * only consumed up to the final newline: a log being written while this reads
 * ends mid-object, and counting that object now and again when it is finished
 * would double it. A file that shrank below the cursor, or whose mtime moved
 * backwards, was rewritten -- start over.
 */
function readTurnsIncremental(filePath, cursor = null) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { turns: [], cursor: cursor || { offset: 0, size: 0, mtime_ms: 0 }, changed: false };
  }
  let offset = Number(cursor?.offset || 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (stat.size < offset || (cursor?.mtime_ms && stat.mtimeMs < cursor.mtime_ms)) offset = 0;
  if (stat.size === offset && cursor && stat.mtimeMs === cursor.mtime_ms) {
    return { turns: [], cursor: { offset, size: stat.size, mtime_ms: stat.mtimeMs }, changed: false };
  }

  let text = "";
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    // StringDecoder, not Buffer.toString per chunk: a multi-byte character
    // straddling a chunk boundary would otherwise decode as two replacement
    // characters and corrupt the line it sits in.
    const decoder = new StringDecoder("utf8");
    let position = offset;
    while (position < stat.size) {
      const length = Math.min(READ_CHUNK, stat.size - position);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      text += decoder.write(buffer.subarray(0, read));
      position += read;
    }
    text += decoder.end();
  } catch {
    return { turns: [], cursor: cursor || { offset: 0, size: 0, mtime_ms: 0 }, changed: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to do; the cursor below is still correct.
      }
    }
  }

  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline) : "";
  const consumed = lastNewline >= 0 ? Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8") : 0;

  const turns = [];
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > MAX_EVENT_LINE || !trimmed.startsWith("{")) continue;
    if (!trimmed.includes("turn.completed")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "turn.completed") continue;
    const usage = event.usage || {};
    turns.push(Object.fromEntries(USAGE_FIELDS.map((field) => [field, Number(usage[field] || 0)])));
  }

  return {
    turns,
    cursor: { offset: offset + consumed, size: stat.size, mtime_ms: stat.mtimeMs },
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// what a lane is, for accounting

function laneActionType(laneDir, laneId) {
  const plan = readJsonOrNull(path.join(laneDir, "role-plan.json"));
  const declared = plan && (plan.action_type || plan.requested_action_type);
  if (declared) return String(declared);
  const match = /^(?:followup-)?([a-z]+(?:-[a-z]+)*?)-\d+$/.exec(laneId);
  return match ? `${match[1]}:unspecified` : "unknown";
}

function laneRole(laneDir, laneId) {
  const state = readJsonOrNull(path.join(laneDir, "run-state.json"));
  if (state?.role) return String(state.role);
  const contract = readJsonOrNull(path.join(laneDir, "lane-contract.json"))
    || readJsonOrNull(path.join(laneDir, "contract.json"));
  if (contract?.role) return String(contract.role);
  const plan = readJsonOrNull(path.join(laneDir, "role-plan.json"));
  if (plan?.role) return String(plan.role);
  const match = /^(?:followup-)?([a-z]+(?:-[a-z]+)*?)-\d+$/.exec(laneId);
  return match ? match[1] : "unknown";
}

/**
 * A lane's wall clock, from the process's own timestamps.
 *
 * events.jsonl records lane_spawned / lane_started and lane_completed; the
 * final status records completed_at. A lane still running is measured to now,
 * so an hour spent inside one lane is visible before it ends.
 */
function laneWallClock(laneDir, nowMs) {
  let startMs = 0;
  let endMs = 0;
  let text = "";
  try {
    text = fs.readFileSync(path.join(laneDir, "events.jsonl"), "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ms = parseMs(row?.ts);
    if (!ms) continue;
    const type = String(row?.event_type || "");
    if ((type === "lane_spawned" || type === "lane_started") && (!startMs || ms < startMs)) startMs = ms;
    if (ms > endMs) endMs = ms;
  }
  const finalStatus = readJsonOrNull(path.join(laneDir, "final-status.json"));
  const finished = parseMs(finalStatus?.completed_at || finalStatus?.finished_at);
  if (finished > endMs) endMs = finished;
  if (!startMs) {
    try {
      startMs = fs.statSync(path.join(laneDir, "invocation.json")).mtimeMs;
    } catch {
      startMs = 0;
    }
  }
  if (!startMs) return { started_at: null, ended_at: null, seconds: 0, running: false };
  const running = !finalStatus;
  const end = running ? nowMs : (endMs || nowMs);
  return {
    started_at: new Date(startMs).toISOString(),
    ended_at: running ? null : new Date(end).toISOString(),
    seconds: Math.max(0, Math.round((end - startMs) / 1000)),
    running,
  };
}

// ---------------------------------------------------------------------------
// limits

function budgetLimits(env = process.env) {
  const optional = (raw) => {
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    token_budget: optional(env.RESEARCHLAB_CYCLE_TOKEN_BUDGET),
    hours_budget: optional(env.RESEARCHLAB_CYCLE_HOURS_BUDGET),
  };
}

function budgetPath({ cwd, cycleId }) {
  return path.join(cwd, ".research-lab", "state", `${cycleId}-budget.json`);
}

function fractionOf(used, limit) {
  if (!limit) return null;
  return Math.round((used / limit) * 10000) / 10000;
}

// ---------------------------------------------------------------------------

/**
 * Aggregate everything spent so far, per lane / role / action_type / milestone.
 *
 * `milestone` is the milestone the cycle was at when the lane finished; the
 * caller passes the progress model's history so a lane can be attributed to the
 * stage it was dispatched against rather than to the stage the cycle is in now.
 */
function updateBudget({ cwd, cycleId, env = process.env, now = Date.now(), milestoneOf = null, maintainerRuns = null }) {
  const filePath = budgetPath({ cwd, cycleId });
  const previous = readJsonOrNull(filePath) || {};
  const cursors = (previous.cursors && typeof previous.cursors === "object") ? { ...previous.cursors } : {};
  const byLane = (previous.by_lane && typeof previous.by_lane === "object") ? { ...previous.by_lane } : {};

  const root = path.join(cwd, ".research-lab");
  const lanesDir = path.join(root, "lanes", cycleId);
  const sources = [];
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir);
  } catch {
    entries = [];
  }
  for (const laneId of entries) {
    sources.push({ key: laneId, dir: path.join(lanesDir, laneId), stdout: path.join(lanesDir, laneId, "stdout.log"), kind: "lane" });
  }

  // The maintainer's own Codex runs. They are not lanes and never appeared in
  // any usage total, which is how a supervisor could spend the budget it was
  // supposed to be holding.
  const maintenanceDir = path.join(root, "maintenance", cycleId);
  let runDirs = [];
  try {
    runDirs = fs.readdirSync(maintenanceDir);
  } catch {
    runDirs = [];
  }
  for (const runId of runDirs) {
    sources.push({
      key: `maintainer/${runId}`,
      dir: path.join(maintenanceDir, runId),
      stdout: path.join(maintenanceDir, runId, "codex.stdout.jsonl"),
      kind: "maintainer",
    });
  }

  for (const source of sources) {
    const { turns, cursor, changed } = readTurnsIncremental(source.stdout, cursors[source.key]);
    cursors[source.key] = cursor;
    const existing = byLane[source.key];
    const totals = emptyTotals();
    if (existing) {
      totals.turns = Number(existing.turns || 0);
      for (const field of USAGE_FIELDS) totals[field] = Number(existing[field] || 0);
    }
    for (const usage of turns) addUsage(totals, usage);
    const wall = source.kind === "lane"
      ? laneWallClock(source.dir, now)
      : { started_at: existing?.started_at || null, ended_at: existing?.ended_at || null, seconds: existing?.wall_clock_seconds || 0, running: false };
    totals.wall_clock_seconds = wall.seconds;
    if (!totals.turns && !changed && !existing) continue;
    byLane[source.key] = {
      kind: source.kind,
      role: source.kind === "lane" ? laneRole(source.dir, source.key) : "maintainer",
      action_type: source.kind === "lane" ? laneActionType(source.dir, source.key) : "maintainer_run",
      milestone: existing?.milestone || (typeof milestoneOf === "function" ? milestoneOf(source.key) : null) || null,
      started_at: wall.started_at,
      ended_at: wall.ended_at,
      running: wall.running === true,
      ...withDerived(totals),
    };
  }

  const totals = emptyTotals();
  const byRole = {};
  const byAction = {};
  const byMilestone = {};
  let earliestStart = 0;
  let latestEnd = 0;
  let maintainerRunCount = 0;

  const accumulate = (table, key, lane) => {
    if (!key) return;
    if (!table[key]) table[key] = { ...emptyTotals(), lanes: 0 };
    const bucket = table[key];
    bucket.lanes += 1;
    bucket.turns += lane.turns;
    for (const field of USAGE_FIELDS) bucket[field] += lane[field];
    bucket.wall_clock_seconds += lane.wall_clock_seconds;
  };

  for (const [key, lane] of Object.entries(byLane)) {
    totals.turns += lane.turns;
    for (const field of USAGE_FIELDS) totals[field] += lane[field];
    totals.wall_clock_seconds += lane.wall_clock_seconds;
    if (lane.kind === "maintainer") maintainerRunCount += 1;
    accumulate(byRole, lane.role, lane);
    accumulate(byAction, lane.action_type, lane);
    accumulate(byMilestone, lane.milestone || "unattributed", lane);
    const startMs = parseMs(lane.started_at);
    const endMs = parseMs(lane.ended_at) || (lane.running ? now : 0);
    if (startMs && (!earliestStart || startMs < earliestStart)) earliestStart = startMs;
    if (endMs > latestEnd) latestEnd = endMs;
    void key;
  }

  // cycle-run-state.started_at is rewritten by each run-plan pass (on
  // cycle-a-20260919 it read 12:17Z for a cycle that began the
  // previous day), so the earliest lane the cycle ever started is the honest
  // floor and the one an hours budget has to be measured against.
  const runState = readJsonOrNull(path.join(root, "state", `${cycleId}-cycle-run-state.json`));
  const declaredStart = parseMs(runState?.started_at);
  const cycleStartMs = earliestStart && declaredStart
    ? Math.min(earliestStart, declaredStart)
    : (earliestStart || declaredStart);
  const elapsedHours = cycleStartMs ? Math.round(((now - cycleStartMs) / 3600000) * 1000) / 1000 : 0;

  const limits = budgetLimits(env);
  const counted = countedTokens(totals);
  const tokenFraction = fractionOf(counted, limits.token_budget);
  const hoursFraction = fractionOf(elapsedHours, limits.hours_budget);
  const worst = Math.max(tokenFraction ?? 0, hoursFraction ?? 0);

  const report = {
    cycle_id: cycleId,
    updated_at: new Date(now).toISOString(),
    source: "codex turn.completed usage events, lane process timestamps",
    counting_rule: "counted_tokens = (input_tokens - cached_input_tokens) + output_tokens",
    totals: withDerived(totals),
    lanes_measured: Object.keys(byLane).length,
    maintainer_runs: maintainerRuns === null ? maintainerRunCount : Number(maintainerRuns),
    maintainer_codex_runs: maintainerRunCount,
    wall_clock: {
      cycle_started_at: cycleStartMs ? new Date(cycleStartMs).toISOString() : null,
      last_activity_at: latestEnd ? new Date(latestEnd).toISOString() : null,
      elapsed_hours: elapsedHours,
      lane_seconds_total: totals.wall_clock_seconds,
    },
    limits,
    status: {
      token_fraction: tokenFraction,
      hours_fraction: hoursFraction,
      worst_fraction: (limits.token_budget || limits.hours_budget) ? Math.round(worst * 10000) / 10000 : null,
      warned: worst >= 0.8 && worst < 1,
      exhausted: (limits.token_budget || limits.hours_budget) ? worst >= 1 : false,
      exhausted_by: worst >= 1
        ? ((tokenFraction ?? 0) >= 1 ? "tokens" : "hours")
        : null,
    },
    by_role: Object.fromEntries(Object.entries(byRole).map(([key, value]) => [key, withDerived(value)])),
    by_action_type: Object.fromEntries(
      Object.entries(byAction)
        .map(([key, value]) => [key, withDerived(value)])
        .sort((a, b) => b[1].counted_tokens - a[1].counted_tokens),
    ),
    by_milestone: Object.fromEntries(Object.entries(byMilestone).map(([key, value]) => [key, withDerived(value)])),
    by_lane: byLane,
    cursors,
  };

  try {
    writeJson(filePath, report);
  } catch {
    // Observing must never be the thing that stops a cycle.
  }
  return { path: filePath, report };
}

module.exports = {
  budgetLimits,
  budgetPath,
  countedTokens,
  readTurnsIncremental,
  updateBudget,
  __private: { laneWallClock, laneActionType, laneRole, emptyTotals, withDerived },
};
