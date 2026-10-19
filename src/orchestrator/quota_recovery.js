"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Codex CLI surfaces a structured ``You've hit your usage limit. ...
// try again at <H:MM AM|PM>.`` message when the ChatGPT-plan token
// budget is exhausted. The reset time is rendered in the ChatGPT
// account's local timezone (matches what the user sees in the
// browser), with no date or zone — we always interpret it as the
// current host's local timezone, the same convention the lab-director
// uses everywhere else (state file timestamps, etc.).
const TRY_AGAIN_RE = /try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i;

// Files inside each lane directory that are likely to carry the Codex
// CLI quota error. result.json wraps stdout into a JSON-escaped blob
// that the regex still matches; stdout.log carries the raw stream.
const LANE_FILES_TO_SCAN = ["result.json", "stdout.log", "final-status.json"];

function parseQuotaResetTime(text, now = new Date()) {
  if (!text) return null;
  const m = TRY_AGAIN_RE.exec(text);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && hours !== 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  // The reset time has no date; if parsing places it in the past
  // (which it usually does because the cycle ran for a while before
  // hitting quota), roll forward to the next occurrence. We never
  // roll backward — a reset more than 24h in the future is safer to
  // sleep through than to misread.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function _safeReadText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function findCycleQuotaResetTime(cwd, cycleId, { now = new Date() } = {}) {
  if (!cycleId) return null;
  const lanesDir = path.join(cwd, ".research-lab", "lanes", cycleId);
  if (!fs.existsSync(lanesDir)) return null;
  let earliest = null;
  let lanes;
  try {
    lanes = fs.readdirSync(lanesDir);
  } catch {
    return null;
  }
  for (const lane of lanes) {
    for (const file of LANE_FILES_TO_SCAN) {
      const p = path.join(lanesDir, lane, file);
      if (!fs.existsSync(p)) continue;
      const reset = parseQuotaResetTime(_safeReadText(p), now);
      if (reset && (!earliest || reset.getTime() < earliest.getTime())) {
        earliest = reset;
      }
    }
  }
  return earliest;
}

function shouldAutoResume(cwd, cycleId) {
  if (!cycleId) return false;
  const stateDir = path.join(cwd, ".research-lab", "state");
  const termPath = path.join(stateDir, `${cycleId}-termination-code.json`);
  const aggrPath = path.join(stateDir, `${cycleId}-cycle-aggregate-metrics.json`);
  if (!fs.existsSync(termPath)) return false;
  let term, aggr;
  try {
    term = JSON.parse(fs.readFileSync(termPath, "utf8"));
  } catch {
    return false;
  }
  try {
    aggr = JSON.parse(fs.readFileSync(aggrPath, "utf8"));
  } catch {
    aggr = {};
  }
  // The native lane runner now stops the cycle itself the moment the provider
  // refuses, so that code is a quota signal on its own.
  if (term?.code === "PROVIDER_QUOTA_EXHAUSTED") return true;
  if (term?.code !== "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK") return false;
  if ((aggr?.quota_exceeded_lane_count || 0) <= 0) return false;
  return true;
}

// Block the calling process until *when* + ``bufferSeconds``. Uses
// child-process ``sleep`` so the wait is real-time without a busy
// loop, then returns synchronously. Capped at ``maxSeconds`` (default
// 4 hours) so a misparsed time can never freeze the CLI for a day.
function sleepUntilSync(when, { bufferSeconds = 60, maxSeconds = 4 * 3600 } = {}) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) return 0;
  const target = when.getTime() + bufferSeconds * 1000;
  const now = Date.now();
  let waitSeconds = Math.max(0, Math.floor((target - now) / 1000));
  waitSeconds = Math.min(waitSeconds, maxSeconds);
  if (waitSeconds <= 0) return 0;
  spawnSync("sleep", [String(waitSeconds)], { stdio: "ignore" });
  return waitSeconds;
}

// Snapshot of the cycle state used by the stall watchdog. Counts
// completed/finalised lanes (any lane with a final-status.json) so the
// watchdog can tell whether the supervisor is still making progress.
function _readCycleProgress(cwd, cycleId) {
  if (!cycleId) return { completed: 0, total: 0, quota: 0 };
  const lanesDir = path.join(cwd, ".research-lab", "lanes", cycleId);
  let completed = 0;
  let total = 0;
  if (fs.existsSync(lanesDir)) {
    let lanes;
    try { lanes = fs.readdirSync(lanesDir); } catch { lanes = []; }
    total = lanes.length;
    for (const lane of lanes) {
      if (fs.existsSync(path.join(lanesDir, lane, "final-status.json"))) completed += 1;
    }
  }
  const aggrPath = path.join(
    cwd, ".research-lab", "state", `${cycleId}-cycle-aggregate-metrics.json`,
  );
  let quota = 0;
  if (fs.existsSync(aggrPath)) {
    try {
      quota = JSON.parse(fs.readFileSync(aggrPath, "utf8"))
        ?.quota_exceeded_lane_count || 0;
    } catch { /* ignore */ }
  }
  return { completed, total, quota };
}

// Spawn ``childPid``-targeting watchdog. Returns a handle with
// ``stop()``. The watchdog polls every ``pollSeconds`` and sends
// SIGTERM to the supervisor process when:
//   1. at least one lane was flagged ``quota_exceeded`` in the cycle's
//      aggregate metrics, AND
//   2. no new lane has reached final-status for ``stallSeconds``.
//
// This rescues cycles where individual lane processes hang waiting
// for a Codex response that never arrives because the ChatGPT plan's
// per-window budget is exhausted — the supervisor itself is alive
// but the cycle is dead in the water and the ``--auto-resume-on-quota``
// loop in the CLI cannot fire until the supervisor exits with
// CONTINUATION_IMPOSSIBLE. SIGTERM lets the supervisor's normal
// teardown write the termination code and exit cleanly so the loop
// picks up.
function startQuotaStallWatchdog({
  childPid,
  cwd,
  cycleId,
  stallSeconds = 15 * 60,
  pollSeconds = 60,
  log = (msg) => process.stderr.write(`${msg}\n`),
}) {
  if (!childPid) return { stop: () => {} };
  let lastProgressAt = Date.now();
  let lastCompleted = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const snap = _readCycleProgress(cwd, cycleId);
    if (snap.completed > lastCompleted) {
      lastCompleted = snap.completed;
      lastProgressAt = Date.now();
    }
    const stalledSeconds = Math.floor((Date.now() - lastProgressAt) / 1000);
    if (snap.quota > 0 && stalledSeconds >= stallSeconds) {
      log(
        `auto-resume-on-quota: watchdog detected stall — ${snap.completed}/${snap.total} lanes finalised, ` +
          `${snap.quota} lane(s) quota_exceeded, no progress for ${stalledSeconds}s; ` +
          `sending SIGTERM to supervisor pid=${childPid} so the cycle can write its termination code and the auto-resume loop can take over.`,
      );
      try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ }
      stopped = true;
    }
  };
  const handle = setInterval(tick, pollSeconds * 1000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

module.exports = {
  parseQuotaResetTime,
  findCycleQuotaResetTime,
  shouldAutoResume,
  sleepUntilSync,
  startQuotaStallWatchdog,
  TRY_AGAIN_RE,
};
