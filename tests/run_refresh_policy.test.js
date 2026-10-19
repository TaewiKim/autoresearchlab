"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  hasActiveLanes,
  shouldUseContextRefreshAfterRun,
} = require("../src/runtime/refresh_policy");

function withState(state, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-refresh-policy-"));
  const cycleId = "cycle-refresh-policy";
  const stateDir = path.join(cwd, ".research-lab", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${cycleId}-cycle-run-state.json`),
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
  try {
    fn({ cwd, cycleId });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("run refresh policy uses context refresh while active lanes remain", () => {
  withState({
    lane_statuses: [
      { lane_id: "followup-lab-director-107", role: "lab-director", status: "pending" },
    ],
  }, ({ cwd, cycleId }) => {
    assert.equal(hasActiveLanes({ cwd, cycleId }), true);
    assert.equal(shouldUseContextRefreshAfterRun({ cwd, cycleId, env: {} }), true);
  });
});

test("run refresh policy allows full refresh when no active lanes remain", () => {
  withState({
    lane_statuses: [
      { lane_id: "followup-runner-223", role: "lab-runner", status: "completed" },
    ],
  }, ({ cwd, cycleId }) => {
    assert.equal(hasActiveLanes({ cwd, cycleId }), false);
    assert.equal(shouldUseContextRefreshAfterRun({ cwd, cycleId, env: {} }), false);
  });
});

test("run refresh policy honors explicit refresh mode override", () => {
  withState({
    lane_statuses: [
      { lane_id: "followup-lab-director-107", role: "lab-director", status: "pending" },
    ],
  }, ({ cwd, cycleId }) => {
    assert.equal(shouldUseContextRefreshAfterRun({
      cwd,
      cycleId,
      env: { RESEARCHLAB_RUN_REFRESH_MODE: "full" },
    }), false);
    assert.equal(shouldUseContextRefreshAfterRun({
      cwd,
      cycleId,
      env: { RESEARCHLAB_RUN_REFRESH_MODE: "context-only" },
    }), true);
  });
});
