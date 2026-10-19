"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "src", "cli", "index.js");
const cwd = path.join(__dirname, "..");

test("CLI help exposes force-pivot command", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /force-pivot --cycle-id <id>/);
});

test("force-pivot writes a durable strategy decision and clears termination code", () => {
  const cycleId = `cycle-force-pivot-test-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const strategyPath = path.join(stateDir, `${cycleId}-strategy-decision.json`);
  const terminationPath = path.join(stateDir, `${cycleId}-termination-code.json`);
  const eventsPath = path.join(eventsDir, `${cycleId}-cycle-events.jsonl`);

  const cleanup = () => {
    fs.rmSync(strategyPath, { force: true });
    fs.rmSync(terminationPath, { force: true });
    fs.rmSync(eventsPath, { force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      strategyPath,
      `${JSON.stringify({ mode: "refine", reason: "old decision", decision_id: "old-1" })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      terminationPath,
      `${JSON.stringify({ code: "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK" })}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [
      cliPath,
      "force-pivot",
      "--cycle-id",
      cycleId,
      "--reason",
      "manual regression recovery",
      "--note",
      "avoid stale validation loop",
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, USER: "test-user" },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "forced-pivot-written");
    assert.equal(stdout.cycle_id, cycleId);
    assert.equal(stdout.mode, "pivot");
    assert.equal(fs.existsSync(terminationPath), false);

    const decision = JSON.parse(fs.readFileSync(strategyPath, "utf8"));
    assert.equal(decision.mode, "pivot");
    assert.equal(decision.source, "forced_pivot_cli");
    assert.equal(decision.forced, true);
    assert.equal(decision.reason, "manual regression recovery");
    assert.equal(decision.note, "avoid stale validation loop");
    assert.equal(decision.previous_decision.mode, "refine");
    assert.equal(decision.trigger_signals.includes("forced_by_cli=true"), true);

    const events = fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.at(-1).event_type, "forced_pivot_cli_requested");
    assert.equal(events.at(-1).payload.previous_decision_mode, "refine");
  } finally {
    cleanup();
  }
});
