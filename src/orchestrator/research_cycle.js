"use strict";

const { runNativeCapture } = require("../runtime/native_client");
const { writeAgentPlan } = require("../agents/lab_director/agent_plan");
const { injectLabDirectorQueries } = require("./query_injection");
const { codexLoginNotice, readCodexLoginRequired } = require("./codex_login");
const {
  actionsContainCycleRuntimeBlock,
  healCycleOnce,
  hasRetryableCycleFailures,
  readCycleRuntimeSetupBlock,
} = require("./self_healing_cycle");

function materializeResearchCycle({ cwd, cycleId, agentPlanPath }) {
  const argv = ["materialize-long-run-plan", "--cycle-id", cycleId];
  if (agentPlanPath) {
    argv.push("--agent-plan", agentPlanPath);
  }
  return runNativeCapture(
    argv,
    { cwd },
  );
}

function executeResearchCycle({
  cwd,
  cycleId,
  maxPasses,
  sleepSeconds,
  maxConcurrency,
  staleSeconds,
}) {
  const argv = [
    "run-plan",
    "--cycle-id",
    cycleId,
    "--max-passes",
    String(maxPasses),
    "--sleep-seconds",
    String(sleepSeconds),
    "--max-concurrency",
    String(maxConcurrency),
    "--stale-seconds",
    String(staleSeconds),
  ];
  const maxSelfHealAttempts = Number(process.env.RESEARCHLAB_SELF_HEAL_ATTEMPTS || "3");
  let lastPayload = null;
  let lastError = null;

  for (let attempt = 0; attempt <= maxSelfHealAttempts; attempt += 1) {
    try {
      lastPayload = runNativeCapture(argv, { cwd });
      lastError = null;
      // The lanes wait on a revoked login by themselves; only the owner can end
      // it, so the owner is told on every pass (see codex_login.js).
      const loginRequired = readCodexLoginRequired({ cwd, cycleId });
      if (loginRequired) process.stderr.write(`${codexLoginNotice(loginRequired)}\n`);
      const nativeRuntimeSetupBlock = readCycleRuntimeSetupBlock({ cwd, cycleId });
      if (nativeRuntimeSetupBlock) {
        return {
          ...(lastPayload || {}),
          status: "blocked",
          runtime_setup_block: nativeRuntimeSetupBlock,
        };
      }
      // run-plan can exit 0 while one or more lanes finalized as retryable
      // failures. Treat that as an outer-loop error: heal lane state and run
      // the cycle again instead of returning a stalled summary to callers.
      if (attempt < maxSelfHealAttempts && hasRetryableCycleFailures({ cwd, cycleId })) {
        const actions = healCycleOnce({
          cwd,
          cycleId,
          staleSeconds,
          error: "run-plan completed with retryable failed lanes",
        });
        if (actionsContainCycleRuntimeBlock(actions)) {
          return {
            ...(lastPayload || {}),
            status: "blocked",
            runtime_setup_block: actions.find((action) => action.action === "cycle_runtime_setup_blocked"),
          };
        }
        if (actions.length > 0) continue;
      }
      return lastPayload;
    } catch (error) {
      lastError = error;
      if (attempt >= maxSelfHealAttempts) break;
      const actions = healCycleOnce({
        cwd,
        cycleId,
        staleSeconds,
        error,
        // If the native supervisor itself aborted, the safest self-heal is to
        // make any failed lane runnable again. The attempt cap prevents an
        // infinite loop when the underlying bug is deterministic.
        forceFailedRetry: true,
      });
      if (actionsContainCycleRuntimeBlock(actions)) break;
    }
  }

  if (lastError) {
    throw lastError;
  }
  return lastPayload;
}

function prepareResearchCycle({ cwd, cycleId, prompt, modelCatalogPath, researchStage = "evidence", runtime = null }) {
  const agentPlan = writeAgentPlan({
    cwd,
    cycleId,
    prompt,
    catalogPath: modelCatalogPath,
    researchStage,
    runtime,
  });
  const materialized = materializeResearchCycle({ cwd, cycleId, agentPlanPath: agentPlan.outputPath });
  const queryPlanPath = injectLabDirectorQueries({
    cwd,
    cycleId,
    prompt,
    laneManifestPath: materialized.lane_manifest_path,
    researchStage,
  });

  return {
    agentPlanPath: agentPlan.outputPath,
    materialized,
    queryPlanPath,
  };
}

module.exports = {
  materializeResearchCycle,
  executeResearchCycle,
  prepareResearchCycle,
};
