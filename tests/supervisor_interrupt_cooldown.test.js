"use strict";

// MEASURED ON cycle-a-20260919, 2026-11-15: a decision-latency interrupt
// per stagnant supervisor pass, and passes in pairs minutes apart, so a second
// director was woken four to six minutes after the first had answered.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { __private } = require("../src/orchestrator/run_research");
const { claimLatencyInterrupt } = __private;

test("a decision-latency interrupt is not raised again within the cooldown", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-interrupt-"));
  const cycleId = "c";
  const at = (iso) => Date.parse(iso);
  const env = {};
  assert.equal(claimLatencyInterrupt({ cwd, cycleId, nowMs: at("2026-11-15T22:02:00Z"), env }), true, "the first is raised");
  assert.equal(claimLatencyInterrupt({ cwd, cycleId, nowMs: at("2026-11-15T22:06:00Z"), env }), false, "the next pass, four minutes later, is not");
  assert.equal(claimLatencyInterrupt({ cwd, cycleId, nowMs: at("2026-11-15T23:03:00Z"), env }), true, "after the hour it is raised again");
  // The setting can turn the cooldown off.
  assert.equal(claimLatencyInterrupt({ cwd, cycleId, nowMs: at("2026-11-15T23:04:00Z"), env: { RESEARCHLAB_SUPERVISOR_INTERRUPT_COOLDOWN_MINUTES: "0" } }), true);
  fs.rmSync(cwd, { recursive: true, force: true });
});
