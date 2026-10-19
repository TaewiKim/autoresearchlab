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
