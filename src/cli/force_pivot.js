"use strict";

const fs = require("fs");
const path = require("path");
const { writeJson } = require("../shared/json");
const { clearTerminationCode } = require("../reporting/termination_code");
const { safeReadJson } = require("./output");

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function appendCycleEvent({ cwd, cycleId, eventType, payload }) {
  const eventsDir = path.join(cwd, ".research-lab", "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.appendFileSync(
    path.join(eventsDir, `${cycleId}-cycle-events.jsonl`),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event_type: eventType,
      payload: payload || {},
    })}\n`,
    "utf8",
  );
}

function forcePivotCycle(cwd, args) {
  const cycleId = readFlag(args, "--cycle-id");
  if (!cycleId) throw new Error("--cycle-id is required");
  const reason = readFlag(args, "--reason") || "forced pivot requested from CLI";
  const note = readFlag(args, "--note") || null;
  const actor = process.env.SUDO_USER || process.env.USER || "cli";
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const strategyPath = path.join(stateDir, `${cycleId}-strategy-decision.json`);
  const previous = safeReadJson(strategyPath);
  const forcedAt = new Date().toISOString();
  const payload = {
    approved_actions: [],
    cycle_id: cycleId,
    decision_id: `forced-pivot-${Date.now().toString(36)}`,
    deferred_actions: [],
    mode: "pivot",
    reason,
    trigger_signals: [
      "forced_by_cli=true",
      "source=force-pivot",
      ...(note ? [`note=${note}`] : []),
    ],
    source: "forced_pivot_cli",
    forced: true,
    forced_at: forcedAt,
    forced_by: actor,
    note,
    previous_decision: previous
      ? {
          mode: previous.mode || null,
          reason: previous.reason || null,
          decision_id: previous.decision_id || null,
          source: previous.source || null,
        }
      : null,
  };
  writeJson(strategyPath, payload);

  let clearedTerminationCodePath = null;
  if (!args.includes("--keep-termination-code")) {
    clearedTerminationCodePath = clearTerminationCode({ cwd, cycleId });
  }

  appendCycleEvent({
    cwd,
    cycleId,
    eventType: "forced_pivot_cli_requested",
    payload: {
      cycle_id: cycleId,
      reason,
      note,
      strategy_decision_path: strategyPath,
      cleared_termination_code_path: clearedTerminationCodePath,
      previous_decision_mode: previous?.mode || null,
    },
  });

  return {
    status: "forced-pivot-written",
    cycle_id: cycleId,
    mode: "pivot",
    reason,
    note,
    strategy_decision_path: strategyPath,
    cleared_termination_code_path: clearedTerminationCodePath,
    next_step: "Run `researchlab resume-cycle --cycle-id <id>` or wait for the watchdog to dispatch the pivot recovery followups.",
  };
}

module.exports = { forcePivotCycle };
