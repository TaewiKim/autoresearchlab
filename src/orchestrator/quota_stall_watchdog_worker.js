"use strict";

// Quota-stall watchdog worker thread. Runs alongside a synchronous
// runResearch() invocation in the main CLI thread; the main thread is
// blocked on spawnSync(run-plan) so we cannot poll from there.
//
// The worker reads the lane state periodically, and when the cycle
// has at least one quota_exceeded lane plus no new lane completion
// for ``stallSeconds``, it shells out to ``pkill -TERM -P <parentPid>
// -f run-plan`` so the Rust supervisor's normal teardown writes the
// CONTINUATION_IMPOSSIBLE termination code. The CLI's
// ``--auto-resume-on-quota`` loop then detects that exit and
// schedules the resume.

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { workerData, parentPort } = require("worker_threads");

const {
  cwd,
  cycleId,
  parentPid,
  stallSeconds = 15 * 60,
  pollSeconds = 60,
} = workerData || {};

function readProgress() {
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

let lastCompleted = 0;
let lastProgressAt = Date.now();
let triggered = false;

const post = (kind, data) => {
  try { parentPort?.postMessage({ kind, data }); } catch { /* ignore */ }
};

function tick() {
  if (triggered) return;
  const snap = readProgress();
  if (snap.completed > lastCompleted) {
    lastCompleted = snap.completed;
    lastProgressAt = Date.now();
  }
  const stalledSeconds = Math.floor((Date.now() - lastProgressAt) / 1000);
  if (snap.quota > 0 && stalledSeconds >= stallSeconds) {
    triggered = true;
    // Kill the whole subprocess tree under the CLI — the supervisor
    // (run-plan), any codex CLI or python driver children it spawned,
    // and their grandchildren. SIGTERM to just the supervisor often
    // does not propagate to a hung codex subprocess that owns its own
    // process group; the broader sweep ensures the cycle actually
    // exits so the auto-resume loop can take over. We chain a few
    // pkill invocations rather than trust a single one because
    // process-group ownership varies between distros.
    const cmds = [
      `pkill -TERM -P ${parentPid}`,                    // direct children of node
      `pkill -TERM -f "run-plan --cycle-id ${cycleId}"`, // supervisor by argv
      `pkill -TERM -f "researchlab-harness"`,            // any harness binary
      `pkill -TERM -f "codex"`,                           // codex CLI subprocesses
      `pkill -TERM -f "data_scout_browser"`,              // hung scout drivers
    ];
    post("triggered", {
      cycleId, parentPid, stalledSeconds,
      completed: snap.completed, total: snap.total, quota: snap.quota,
      cmds,
    });
    for (const cmd of cmds) {
      exec(cmd, () => { /* best-effort */ });
    }
  }
}

setInterval(tick, pollSeconds * 1000);
post("started", { cycleId, parentPid, stallSeconds, pollSeconds });
