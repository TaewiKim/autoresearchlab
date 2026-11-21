"use strict";

// cycle-a-20260919, 2026-10-02: followup-lab-director-335 wrote an
// "immutable lead manifest" into state/, and the directors after it upheld the
// manifest's lead while the harness's lead file named another.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { quarantineAgentStateFiles } = require("../src/orchestrator/state_boundary");

const CYCLE = "boundary-cycle";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-state-boundary-"));
  const root = path.join(cwd, ".research-lab");
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  const lane = (id, finished) => {
    const dir = path.join(root, "lanes", CYCLE, id);
    fs.mkdirSync(dir, { recursive: true });
    if (finished) fs.writeFileSync(path.join(dir, "final-status.json"), '{"status":"completed"}');
    return dir;
  };
  const write = (kind, value) => {
    const file = path.join(state, `${CYCLE}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  return { cwd, root, state, lane, write };
}

test("a state file a finished lane wrote for itself is moved into that lane", () => {
  const fx = fixture();
  const director = fx.lane("followup-lab-director-335", true);
  fx.lane("followup-chronicle-160", false);
  const manifest = fx.write("lead-manifest", { issued_by: "followup-lab-director-335", hypothesis_id: "H-SCD-V3" });
  // The harness's own lead file names its writer too, and is a registered kind.
  const lead = fx.write("lab-director-hypothesis", { generated_by: "followup-lab-director-335", statement: "x" });
  // A running lane may still be writing its file; a file naming no lane is not attributed.
  const running = fx.write("chronicle-followup-160", { lane_id: "followup-chronicle-160" });
  const anonymous = fx.write("failed-lane-dispositions", { dispositions: [] });

  const moved = quarantineAgentStateFiles({ cwd: fx.cwd, cycleId: CYCLE });

  assert.deepEqual(moved.map((item) => item.file), [`${CYCLE}-lead-manifest.json`]);
  assert.equal(fs.existsSync(manifest), false, "the agent's manifest is still in state/");
  const kept = JSON.parse(fs.readFileSync(path.join(director, "agent-state", `${CYCLE}-lead-manifest.json`), "utf8"));
  assert.equal(kept.hypothesis_id, "H-SCD-V3", "the agent's record was not kept");
  for (const file of [lead, running, anonymous]) assert.equal(fs.existsSync(file), true, `${path.basename(file)} was moved`);
  const events = fs.readFileSync(path.join(fx.root, "events", `${CYCLE}-harness-notices.jsonl`), "utf8");
  assert.match(events, /agent_state_files_moved_to_lane/);

  // Nothing left to move the second time.
  assert.deepEqual(quarantineAgentStateFiles({ cwd: fx.cwd, cycleId: CYCLE }), []);
  fs.rmSync(fx.cwd, { recursive: true, force: true });
});

// MEASURED ON cycle-a-20260919: the GPU job ledger (2026-11-11) and the
// decision ledger (2026-11-21) are append-only records whose FIRST line names a
// finished lane, and neither kind was registered -- so each was moved into that
// lane's directory as if the lane had written it.
test("a ledger the harness keeps is not taken for a lane's file because its first record names one", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-boundary-ledger-"));
  const cycleId = "c";
  const state = path.join(cwd, ".research-lab", "state");
  const lane = path.join(cwd, ".research-lab", "lanes", cycleId, "followup-lab-director-01");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(lane, { recursive: true });
  fs.writeFileSync(path.join(lane, "final-status.json"), JSON.stringify({ status: "completed" }));
  const record = `${JSON.stringify({ lane_id: "followup-lab-director-01", at: "2026-11-21T00:00:00Z" })}\n`;
  for (const kind of ["decision-ledger", "gpu-jobs"]) {
    fs.writeFileSync(path.join(state, `${cycleId}-${kind}.jsonl`), record);
  }
  // An unregistered file of the same shape is still what the boundary is for.
  fs.writeFileSync(path.join(state, `${cycleId}-lead-manifest.json`), JSON.stringify({ generated_by: "followup-lab-director-01" }));

  const moved = quarantineAgentStateFiles({ cwd, cycleId }).map((item) => item.file);
  assert.deepEqual(moved, [`${cycleId}-lead-manifest.json`]);
  assert.ok(fs.existsSync(path.join(state, `${cycleId}-decision-ledger.jsonl`)), "the decision ledger was moved out of state");
  assert.ok(fs.existsSync(path.join(state, `${cycleId}-gpu-jobs.jsonl`)), "the GPU ledger was moved out of state");
  fs.rmSync(cwd, { recursive: true, force: true });
});
