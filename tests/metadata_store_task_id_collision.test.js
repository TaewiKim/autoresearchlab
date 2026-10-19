"use strict";

// One stray directory must not be able to abort every supervisor pass.
//
// MEASURED ON cycle-g-v90-20260911. An agent created an EMPTY directory called
// " scout-02" -- a leading space -- beside the real `scout-02`. A lane id is the
// directory name, and `scopeTaskId` trims it, so both scoped to
// `cycle-g-v90-20260911:scout-02`. Both rows went into one INSERT after the
// cycle's tasks were deleted, the primary key rejected the second, and
// `syncCycleMetadata` threw:
//
//     run-research aborted: Error: UNIQUE constraint failed: tasks.task_id
//         at syncCycleMetadata (src/storage/metadata_store.js:451)
//         at syncControllerState (src/orchestrator/run_research.js:199)
//
// The wrapper relaunched, it threw again: 1,587 aborts over three hours with
// ZERO lanes dispatched. The watchdog reported nothing the whole time, because
// from the outside a cycle that cannot START is indistinguishable from a quiet
// one -- the same signature v85 died of, and the second time a single stray
// filesystem entry has taken the harness down.
//
// It also cost a wrong diagnosis: the cycle showed `failed_blocking: 1` from an
// unrelated scout, and that was blamed for the stall for over an hour, because
// the supervisor's log was empty and the crash was invisible.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { collectLaneRecords } = require("../src/storage/metadata_store");

const CYCLE = "cycle-g-v90-test";
const SPLIT_LINES = new RegExp("\r?\n");

function cycleWithLanes(laneNames) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-taskid-"));
  for (const name of laneNames) {
    const dir = path.join(cwd, ".research-lab", "lanes", CYCLE, name);
    fs.mkdirSync(dir, { recursive: true });
  }
  return cwd;
}

function collect(cwd) {
  return collectLaneRecords({ cwd, cycleId: CYCLE, researchStage: null, controlState: null });
}

test("a lane directory whose name only differs by whitespace does not collide", () => {
  const cwd = cycleWithLanes(["scout-02", " scout-02"]);
  const records = collect(cwd);

  const ids = records.tasks.map((task) => task.task_id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `two tasks share a primary key, which is what aborted the supervisor: ${ids.join(", ")}`,
  );

  // The real lane survives; the stray one is recorded rather than vanishing.
  assert.ok(ids.includes(`${CYCLE}:scout-02`), "the real lane lost its task row");
  assert.equal(records.skipped_lanes.length, 1);
  assert.equal(records.skipped_lanes[0].lane_id, " scout-02");
  assert.equal(records.skipped_lanes[0].task_id, `${CYCLE}:scout-02`);
  assert.equal(records.skipped_lanes[0].already_claimed_by, "scout-02");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("ordinary lanes are unaffected and nothing is skipped", () => {
  const cwd = cycleWithLanes(["scout-01", "scout-02", "gatekeeper-01", "lab-director-01"]);
  const records = collect(cwd);

  assert.equal(records.tasks.length, 4);
  assert.deepEqual(records.skipped_lanes, []);
  const ids = records.tasks.map((task) => task.task_id).sort();
  assert.deepEqual(ids, [
    `${CYCLE}:gatekeeper-01`,
    `${CYCLE}:lab-director-01`,
    `${CYCLE}:scout-01`,
    `${CYCLE}:scout-02`,
  ]);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("an explicit task_id in a role plan can collide too, and is skipped the same way", () => {
  // The collision is not only a whitespace accident: two lanes may name the same
  // task_id in their role plans, and the insert must survive that as well.
  const cwd = cycleWithLanes(["followup-runner-07", "followup-runner-08"]);
  const lanes = path.join(cwd, ".research-lab", "lanes", CYCLE);
  for (const lane of ["followup-runner-07", "followup-runner-08"]) {
    fs.writeFileSync(
      path.join(lanes, lane, "role-plan.json"),
      JSON.stringify({ role: "lab-runner", task_id: "shared-task" }),
      "utf8",
    );
  }
  const records = collect(cwd);

  const ids = records.tasks.map((task) => task.task_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(records.tasks.length, 1);
  assert.equal(records.skipped_lanes.length, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a stray directory records the evidence that would name its creator", () => {
  // Asked "who created ' scout-02'", the answer was that nobody knew -- and the
  // reason was not that the system is unobservable. The collision has been
  // DETECTED since 3e96e3e and written into `skipped_lanes`, which nothing
  // reads. The audit log could not help either: it records control-state
  // transitions, supervisor passes and role dialogues, and has no event for a
  // directory appearing. So the one component that saw the stray said nothing,
  // and the evidence decayed.
  const cwd = cycleWithLanes([" scout-02", "scout-02", "analyst-01"]);
  const lanes = path.join(cwd, ".research-lab", "lanes", CYCLE);
  // analyst-01 is executing; it is the kind of thing that should end up on the
  // suspect list.
  fs.writeFileSync(
    path.join(lanes, "analyst-01", "run-state.json"),
    JSON.stringify({ status: "running", pid: 1234 }),
    "utf8",
  );

  const records = collect(cwd);
  assert.equal(records.skipped_lanes.length, 1);

  const eventsPath = path.join(
    cwd, ".research-lab", "events", `${CYCLE}-cycle-events.jsonl`,
  );
  assert.ok(fs.existsSync(eventsPath), "the stray directory was skipped in silence again");
  const events = fs.readFileSync(eventsPath, "utf8")
    .trim().split(SPLIT_LINES).map((line) => JSON.parse(line));
  const stray = events.filter((event) => event.event_type === "stray-lane-directory-skipped");
  assert.equal(stray.length, 1);
  const payload = stray[0].payload;
  assert.equal(payload.lane_id, " scout-02");
  assert.equal(payload.task_id, `${CYCLE}:scout-02`);
  assert.equal(payload.entry_count, 0, "an empty stray is the shape that has appeared twice");
  assert.ok(payload.appeared_at, "without a time there is nothing to correlate against");
  assert.ok(typeof payload.mode === "string", "the mode is the strongest fingerprint available");
  assert.deepEqual(payload.lanes_executing_near_that_time, ["analyst-01"]);

  // Once per stray per cycle: the sync runs every supervisor pass, and a line
  // per pass would bury the first sighting, which is the only one whose timing
  // means anything.
  collect(cwd);
  const after = fs.readFileSync(eventsPath, "utf8")
    .trim().split(SPLIT_LINES).map((line) => JSON.parse(line))
    .filter((event) => event.event_type === "stray-lane-directory-skipped");
  assert.equal(after.length, 1, "the sighting was logged again on the next pass");

  fs.rmSync(cwd, { recursive: true, force: true });
});
