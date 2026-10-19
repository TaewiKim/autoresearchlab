"use strict";

// The billing truth was on disk the whole time.
//
// The token budget guard estimates spend as `sum(prompt.txt) / 4`, and says so
// itself: "a floor, not billing truth". On cycle-g-v89 that floor read 121.41 MB
// of 140 and reported 74 gate rounds of headroom while the account died. The
// floor was not wrong about what it measured; it measured the wrong thing.
//
// What a lane actually costs is the agent LOOP, not the first message. Every
// command it runs and every byte it reads is re-sent on the next turn, and the
// runtime reports the result at the end of each one:
//
//   {"type":"turn.completed","usage":{"input_tokens":939105,
//    "cached_input_tokens":857344,"output_tokens":12259,
//    "reasoning_output_tokens":1506}}
//
// followup-author-137, one turn, 939,105 input tokens against a 125 KB prompt.
// Measured across 2026-09-10: prompt.txt totalled 12.17 MB while the agents'
// own transcripts totalled 29.53 MB, and the transcript is what gets re-sent.
//
// This reads those events. No estimate, no ratio, no chars-per-token.

const fs = require("fs");
const path = require("path");

// A turn envelope is small; a command result carrying a megabyte of output is
// not. Skipping the big lines keeps this cheap on a corpus of a thousand lanes.
const MAX_EVENT_LINE = 8192;

function laneRoot(root, cycleId) {
  return path.join(root, "lanes", cycleId);
}

function readTurns(stdoutPath) {
  const turns = [];
  let text;
  try {
    text = fs.readFileSync(stdoutPath, "utf8");
  } catch {
    return turns;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > MAX_EVENT_LINE || !trimmed.startsWith("{")) continue;
    if (!trimmed.includes("turn.completed")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "turn.completed") continue;
    const usage = event.usage || {};
    turns.push({
      input_tokens: Number(usage.input_tokens || 0),
      cached_input_tokens: Number(usage.cached_input_tokens || 0),
      cache_write_input_tokens: Number(usage.cache_write_input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0),
    });
  }
  return turns;
}

function emptyTotals() {
  return {
    turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function addTurn(totals, turn) {
  totals.turns += 1;
  totals.input_tokens += turn.input_tokens;
  totals.cached_input_tokens += turn.cached_input_tokens;
  totals.cache_write_input_tokens += turn.cache_write_input_tokens;
  totals.output_tokens += turn.output_tokens;
  totals.reasoning_output_tokens += turn.reasoning_output_tokens;
}

function roleOf(root, cycleId, laneId) {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(laneRoot(root, cycleId), laneId, "run-state.json"), "utf8"),
    );
    return String(state.role || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * What this cycle has actually spent, per the runtime's own accounting.
 *
 * `billed_input_tokens` is the number that matters: input the provider did not
 * serve from cache. Reporting the cached share beside it keeps the distinction
 * visible instead of collapsing it — on cycle-g-v89 more than 90% of a large
 * author turn was cache hits, so a raw input_tokens total badly overstates cost
 * while the prompt-byte floor badly understates it.
 */
function measureCodexUsage({ root, cycleId, sinceMs = 0 }) {
  const lanesDir = laneRoot(root, cycleId);
  const totals = emptyTotals();
  const byRole = {};
  const perLane = [];
  let lanes = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir);
  } catch {
    return { cycle_id: cycleId, lanes: 0, ...totals, billed_input_tokens: 0, by_role: {}, lanes_measured: [] };
  }

  for (const laneId of entries) {
    const stdoutPath = path.join(lanesDir, laneId, "stdout.log");
    let stat;
    try {
      stat = fs.statSync(stdoutPath);
    } catch {
      continue;
    }
    if (sinceMs && stat.mtimeMs < sinceMs) continue;
    const turns = readTurns(stdoutPath);
    if (!turns.length) continue;
    lanes += 1;
    const laneTotals = emptyTotals();
    for (const turn of turns) {
      addTurn(totals, turn);
      addTurn(laneTotals, turn);
    }
    const role = roleOf(root, cycleId, laneId) || "unknown";
    byRole[role] = byRole[role] || emptyTotals();
    for (const turn of turns) addTurn(byRole[role], turn);
    perLane.push({
      lane_id: laneId,
      role,
      ...laneTotals,
      billed_input_tokens: laneTotals.input_tokens - laneTotals.cached_input_tokens,
    });
  }

  perLane.sort((a, b) => b.billed_input_tokens - a.billed_input_tokens);
  const billed = totals.input_tokens - totals.cached_input_tokens;
  return {
    cycle_id: cycleId,
    measured_at: new Date().toISOString(),
    source: "codex turn.completed usage events",
    lanes,
    ...totals,
    // Input the provider actually had to read. This is the cost signal.
    billed_input_tokens: billed,
    cache_hit_ratio: totals.input_tokens ? Number((totals.cached_input_tokens / totals.input_tokens).toFixed(4)) : 0,
    by_role: Object.fromEntries(
      Object.entries(byRole).map(([role, value]) => [
        role,
        { ...value, billed_input_tokens: value.input_tokens - value.cached_input_tokens },
      ]),
    ),
    lanes_measured: perLane,
  };
}

module.exports = { measureCodexUsage, readTurns };
