"use strict";

// FIX (a): lane-reclaim-after-restart reaper. Verifies that healCycleOnce
//   - reclaims a running lane whose PID is dead (orphaned in-flight lane),
//   - does NOT age-reap a codex-agent lane that is still alive but has been
//     running longer than the flat default (the chronicle false-positive bug:
//     chronicle's own timeout is 2400s, so 1800s must not reap it), and
//   - DOES age-reap a codex-agent lane past the codex-agent stale floor
//     (the detached/hung-chronicle backstop).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { healCycleOnce } = require("../src/orchestrator/self_healing_cycle");

const ALIVE_PID = process.pid; // guaranteed live for the duration of the test
const DEAD_PID = 99999999; // not a real process

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function makeLane({ root, cycleId, laneId, role, runtimeClass, pid, ageSeconds }) {
  const laneDir = path.join(root, ".research-lab", "lanes", cycleId, laneId);
  const startedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  writeJson(path.join(laneDir, "lane-contract.json"), { role, runtime_class: runtimeClass });
  writeJson(path.join(laneDir, "run-state.json"), {
    status: "running",
    role,
    runtime_class: runtimeClass,
    pid,
    started_at: startedAt,
    updated_at: startedAt,
  });
  writeJson(path.join(laneDir, "process.json"), { pid, started_at: startedAt });
  return laneDir;
}

function laneAction(actions, laneId) {
  return actions.find((a) => a.lane_id === laneId && a.action === "clear_stale_running_state") || null;
}

function withTmp(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-reaper-"));
  try {
    fn(cwd);
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* Windows may hold a temp handle briefly; ignore */
    }
  }
}

test("reclaims a running lane whose PID is dead (orphaned in-flight lane)", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-dead";
    makeLane({ root: cwd, cycleId, laneId: "lab-runner-01", role: "lab-runner", runtimeClass: "external-driver", pid: DEAD_PID, ageSeconds: 60 });
    const actions = healCycleOnce({ cwd, cycleId });
    const action = laneAction(actions, "lab-runner-01");
    assert.ok(action, "dead-PID running lane should be reclaimed");
    assert.equal(action.reason, "dead_pid");
    // run-state.json cleared -> lane returns to a re-dispatchable shape.
    assert.equal(
      fs.existsSync(path.join(cwd, ".research-lab", "lanes", cycleId, "lab-runner-01", "run-state.json")),
      false,
    );
    // contract survives so the supervisor can re-plan it.
    assert.ok(
      fs.existsSync(path.join(cwd, ".research-lab", "lanes", cycleId, "lab-runner-01", "lane-contract.json")),
    );
  });
});

test("does NOT age-reap a live codex-agent chronicle lane below the codex-agent floor", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-healthy";
    // 2000s > the flat 1800s default but < chronicle's 2400s timeout and the
    // 3600s codex-agent floor. The old flat-1800 threshold would have killed
    // this healthy lane mid-work.
    makeLane({ root: cwd, cycleId, laneId: "chronicle-01", role: "chronicle", runtimeClass: "codex-agent", pid: ALIVE_PID, ageSeconds: 2000 });
    const actions = healCycleOnce({ cwd, cycleId });
    assert.equal(laneAction(actions, "chronicle-01"), null, "healthy long-running chronicle must not be reaped");
    assert.ok(
      fs.existsSync(path.join(cwd, ".research-lab", "lanes", cycleId, "chronicle-01", "run-state.json")),
      "run-state.json should be preserved for a healthy lane",
    );
  });
});

test("age-reaps a live codex-agent lane past the codex-agent stale floor (hang backstop)", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-hung";
    // Alive PID but 4000s > 3600s floor: a genuinely detached/hung codex lane.
    makeLane({ root: cwd, cycleId, laneId: "chronicle-01", role: "chronicle", runtimeClass: "codex-agent", pid: ALIVE_PID, ageSeconds: 4000 });
    const actions = healCycleOnce({ cwd, cycleId });
    const action = laneAction(actions, "chronicle-01");
    assert.ok(action, "a hung codex lane past the floor should be reaped");
    assert.equal(action.reason, "exceeded_stale_budget");
  });
});

test("honors RESEARCHLAB_CODEX_AGENT_STALE_SECONDS override", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-env";
    const prev = process.env.RESEARCHLAB_CODEX_AGENT_STALE_SECONDS;
    // Lower the floor from its 3600 default to 2500. At age 3000s the lane is
    // spared under the default floor but reaped under the override — proving
    // the knob changes the threshold. (The floor is max(defaultStaleSeconds,
    // override), so it can be raised above 1800 or lowered toward it, but not
    // below the base default.)
    process.env.RESEARCHLAB_CODEX_AGENT_STALE_SECONDS = "2500";
    try {
      makeLane({ root: cwd, cycleId, laneId: "chronicle-01", role: "chronicle", runtimeClass: "codex-agent", pid: ALIVE_PID, ageSeconds: 3000 });
      const actions = healCycleOnce({ cwd, cycleId });
      const action = laneAction(actions, "chronicle-01");
      assert.ok(action, "override to 2500 should reap a 3000s lane that the 3600 default would spare");
      assert.equal(action.reason, "exceeded_stale_budget");
    } finally {
      if (prev === undefined) delete process.env.RESEARCHLAB_CODEX_AGENT_STALE_SECONDS;
      else process.env.RESEARCHLAB_CODEX_AGENT_STALE_SECONDS = prev;
    }
  });
});

// cycle-a-20260919: the ordered experiment builds its scene,
// demonstrations and policy arms and then runs every condition x seed x episode.
// codex_policy.rs gives it 2h; the engineer role is in no long-budget list, so
// the flat floor would have reaped a healthy one at 30 minutes.
test("does not age-reap a healthy engineer running the ordered simulation", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-simulation";
    const laneDir = makeLane({
      root: cwd,
      cycleId,
      laneId: "followup-engineer-03",
      role: "engineer",
      runtimeClass: "codex-agent",
      pid: ALIVE_PID,
      ageSeconds: 5000, // past every other floor, inside the simulation budget
    });
    writeJson(path.join(laneDir, "role-plan.json"), {
      role: "engineer",
      action_type: "simulation_data_generation_followup",
    });
    const actions = healCycleOnce({ cwd, cycleId });
    assert.equal(
      laneAction(actions, "followup-engineer-03"),
      null,
      "a healthy simulation lane inside its own budget must not be reaped",
    );
  });
});

test("still reaps a simulation lane past its own budget", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-reaper-simulation-hung";
    const laneDir = makeLane({
      root: cwd,
      cycleId,
      laneId: "followup-engineer-03",
      role: "engineer",
      runtimeClass: "codex-agent",
      pid: ALIVE_PID,
      ageSeconds: 7200 + 600 + 60,
    });
    writeJson(path.join(laneDir, "role-plan.json"), {
      role: "engineer",
      action_type: "simulation_data_generation_followup",
    });
    const actions = healCycleOnce({ cwd, cycleId });
    const action = laneAction(actions, "followup-engineer-03");
    assert.ok(action, "a hung simulation lane past its own budget is still reaped");
    assert.equal(action.reason, "exceeded_stale_budget");
  });
});

// cycle-a-20260919 moved into a Linux container carrying a Windows
// sandbox pause in its copied state. Every pass stopped on
// `existing_windows_sandbox_setup_pause`: a manual resume demanded for a sandbox
// that does not exist in there, and nothing in there could ever resolve it.
test("a Windows sandbox pause does not hold a cycle that is not on Windows", () => {
  withTmp((cwd) => {
    const cycleId = "cycle-migrated";
    writeJson(path.join(cwd, ".research-lab", "state", `${cycleId}-labdirector-pause.json`), {
      cycle_id: cycleId,
      status: "blocked",
      block_type: "windows_sandbox_setup",
      manual_resume_required: true,
      reason: "Windows sandbox configuration conflict or setup failure blocked the launch",
    });
    // A lane the move left behind, with a pid from the machine it came from.
    makeLane({
      root: cwd,
      cycleId,
      laneId: "followup-scout-135",
      role: "scout",
      runtimeClass: "codex-agent",
      pid: DEAD_PID,
      ageSeconds: 60,
    });

    const actions = healCycleOnce({ cwd, cycleId });
    const blocked = actions.filter((a) => a.reason === "existing_windows_sandbox_setup_pause");
    if (process.platform === "win32") {
      assert.equal(blocked.length, 1, "on Windows the pause still holds the cycle");
    } else {
      assert.equal(blocked.length, 0, `the pause held a Linux cycle: ${JSON.stringify(actions)}`);
      assert.ok(
        laneAction(actions, "followup-scout-135"),
        "and the lane the move left running is reclaimed instead",
      );
    }
  });
});
