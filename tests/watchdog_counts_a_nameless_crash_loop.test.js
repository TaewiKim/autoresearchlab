"use strict";

// R5 fires at three aborts. cycle-g-v90 had 1,650 and R5 never evaluated.
//
// The rule was right and the counter feeding it was starved. `abortsForCycle`
// read every .log under the runtime root and skipped any whose text did not
// contain the cycle id:
//
//     if (!text.includes(cycleId)) continue;
//
// A supervisor that dies inside runResearch writes a wrapper line, an error and
// a stack trace of absolute source paths. None of it names the cycle. v90's log
// was 1.43 MB of pure crash loop and mentioned `cycle-g-v90-20260911` exactly
// ZERO times, so the watchdog skipped the file, R5 saw abort_count 0, and the
// cycle sat dead for three hours with no halt written.
//
// That is the shape of the failure R5 exists for -- a run that dies before it
// can say what it was working on -- so requiring it to say so first is requiring
// the evidence the failure destroys.
//
// The guard still has a job: a log belonging to a DIFFERENT cycle must not be
// counted toward this one. That distinction is what these tests pin.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { abortsForCycle } = require("../src/cli/progress_watchdog.js");

const CYCLE = "cycle-g-v90-20260911";

const ABORT_BLOCK = [
  "[wrapper] heap-bounded relaunch resume",
  "[wrapper] policy: mode=explore stall_rounds=default",
  "run-research aborted: Error: UNIQUE constraint failed: tasks.task_id",
  "    at syncCycleMetadata (/opt/researchlab/src/storage/metadata_store.js:451:18)",
  "    at runResearch (/opt/researchlab/src/orchestrator/run_research.js:530:3)",
].join("\n");

function runtimeRoot({ logs = {}, withLaneDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-watchdog-"));
  if (withLaneDir) fs.mkdirSync(path.join(root, "lanes", CYCLE), { recursive: true });
  for (const [name, text] of Object.entries(logs)) {
    fs.writeFileSync(path.join(root, name), text, "utf8");
  }
  return root;
}

test("a crash loop that never names the cycle is still counted", () => {
  // Verbatim shape of v90's log: no cycle id anywhere in it.
  const text = Array.from({ length: 5 }, () => ABORT_BLOCK).join("\n");
  assert.ok(!text.includes(CYCLE), "the fixture must not name the cycle, or it tests nothing");

  const root = runtimeRoot({ logs: { "cg-v90.log": text } });
  const { abort_count: count, latest_abort: latest } = abortsForCycle(root, CYCLE);

  assert.equal(count, 5, "the aborts that killed the cycle were not counted");
  assert.match(latest, /UNIQUE constraint failed/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a log naming a different cycle is still not counted toward this one", () => {
  // The guard's real job, and it has to survive the fix.
  const other = `run-research aborted: Error: boom\ncycle cycle-g-v88-20260829 relaunching\n`;
  const root = runtimeRoot({ logs: { "cg-v88.log": other } });

  assert.equal(abortsForCycle(root, CYCLE).abort_count, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a log naming this cycle is counted however old the file is", () => {
  const text = `${ABORT_BLOCK}\nlane ${CYCLE}/scout-01 completed\n`;
  const root = runtimeRoot({ logs: { "whatever.log": text }, withLaneDir: false });

  assert.equal(abortsForCycle(root, CYCLE).abort_count, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a nameless log written before this cycle started is not counted", () => {
  // A previous cycle's launcher log that happens to name nothing must not be
  // attributed here just because it is nameless.
  const root = runtimeRoot({ logs: { "stale.log": ABORT_BLOCK } });
  const laneDir = path.join(root, "lanes", CYCLE);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, "stale.log"), future, new Date(Date.now() - 86_400_000));
  // Make the cycle look like it started after that log was last written.
  fs.utimesSync(laneDir, future, future);

  assert.equal(abortsForCycle(root, CYCLE).abort_count, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test("no logs at all is zero, not a throw", () => {
  const root = runtimeRoot();
  assert.deepEqual(abortsForCycle(root, CYCLE), { abort_count: 0, latest_abort: null });
  fs.rmSync(root, { recursive: true, force: true });
});
