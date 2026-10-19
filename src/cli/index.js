#!/usr/bin/env node
"use strict";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = function emitResearchLabWarning(warning, type, code, ctor) {
  const message = typeof warning === "string" ? warning : (warning && warning.message) || "";
  const warningType = typeof type === "string"
    ? type
    : (type && type.type) || (warning && warning.name) || "";
  if (
    warningType === "ExperimentalWarning" &&
    /SQLite is an experimental feature/i.test(message)
  ) {
    return;
  }
  return originalEmitWarning(warning, type, code, ctor);
};

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { clearProviderQuotaPause, clearTerminationCode } = require("../reporting/termination_code");
const { ensureNativeBuilt, runNative } = require("../runtime/native_runtime");
const { shouldUseContextRefreshAfterRun } = require("../runtime/refresh_policy");
const { writeJson } = require("../shared/json");
const { compactRefreshPayload, compactResumePayload, safeReadJson, stringifyCliPayload } = require("./output");
const { forcePivotCycle } = require("./force_pivot");
const { bootstrap, doctor, importClaudeAuthInline, pathWithVenv } = require("./bootstrap");

// The operator's API keys (~/.researchlab/.env, written by `researchlab keys`
// and `researchlab setup`) fill in what the shell did not set, for this
// process and every driver and harness process it starts.
require("./keys").loadKeysIntoEnv();
// A source that needs a key is on only with it; its host leaves the agents'
// network allowlist otherwise (src/policy/key_gates.js).
require("../policy/key_gates").applyKeyGates();

// Output piped into `head` and the like: a closed pipe ends the command quietly.
process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

function loadInitResearchLab() {
  return require("../bootstrap/init").initResearchLab;
}

function loadRunResearch() {
  return require("../orchestrator/run_research").runResearch;
}

function loadRefreshCycleOutputs() {
  return require("../reporting/refresh_cycle").refreshCycleOutputs;
}

function loadRefreshCycleContextOutputs() {
  return require("../reporting/refresh_cycle").refreshCycleContextOutputs;
}

function loadRefreshGateOutputs() {
  return require("../reporting/refresh/gate_fast").refreshGateOutputs;
}

// The live view (a local web UI) is optional: a distribution may leave it
// out, and every command below works without it (see \`follow\`).
const LIVE_VIEW_AVAILABLE = require("fs").existsSync(require("path").join(__dirname, "..", "reporting", "live_view_server.js"));

function liveViewUnavailable(command) {
  process.stderr.write(`${command}: the live view is not part of this distribution; use \`researchlab follow --cycle-id <id>\` and \`researchlab status --cycle-id <id>\`
`);
  process.exit(2);
}

function loadServeLiveView() {
  return require("../reporting/live_view_server").serveLiveView;
}

function loadMaintainer() {
  return require("../orchestrator/maintainer");
}

function loadProcessCleanup() {
  return require("../runtime/process_cleanup");
}

function refreshOutputsAfterRun({ cwd, cycleId }) {
  if (shouldUseContextRefreshAfterRun({ cwd, cycleId })) {
    return loadRefreshCycleContextOutputs()({ cwd, cycleId });
  }
  return loadRefreshCycleOutputs()({ cwd, cycleId });
}

function loadSelfHealingCycle() {
  return require("../orchestrator/self_healing_cycle");
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}


function containsCodexContextLengthError(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return /context_length_exceeded|maximum context length|input exceeds the maximum length|maximum length of 1048576|prompt is too long|too many tokens|context window/i.test(text);
}

function containsCodexUnsupportedModelError(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return /requires a newer version of Codex|unsupported model|model .* is not supported/i.test(text);
}

function fileContainsTextPattern(filePath, pattern, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return false;
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const readWindows = [0];
    if (stat.size > maxBytes) readWindows.push(Math.max(0, stat.size - maxBytes));
    const seen = new Set();
    for (const start of readWindows) {
      if (seen.has(start)) continue;
      seen.add(start);
      let position = start;
      const end = Math.min(stat.size, start + maxBytes);
      while (position < end) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(chunkSize, end - position), position);
        if (bytesRead <= 0) break;
        if (pattern.test(buffer.subarray(0, bytesRead).toString("utf8"))) return true;
        position += bytesRead;
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
  return false;
}

function resetRetryableContextLengthFailures({ cwd, cycleId }) {
  const lanesRoot = path.join(cwd, ".research-lab", "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  const reset = [];
  for (const laneId of fs.readdirSync(lanesRoot)) {
    const laneDir = path.join(lanesRoot, laneId);
    if (!fs.statSync(laneDir).isDirectory()) continue;
    const finalStatusPath = path.join(laneDir, "final-status.json");
    const resultPath = path.join(laneDir, "result.json");
    if (!fs.existsSync(finalStatusPath)) continue;
    const finalStatus = safeReadJson(finalStatusPath) || {};
    const failed = String(finalStatus.status || "") === "failed";
    if (!failed) continue;
    const isContextLength =
      containsCodexContextLengthError(finalStatus) ||
      fileContainsTextPattern(resultPath, /context_length_exceeded|maximum context length|input exceeds the maximum length|maximum length of 1048576|prompt is too long|too many tokens|context window/i);
    const isUnsupportedModel =
      containsCodexUnsupportedModelError(finalStatus) ||
      fileContainsTextPattern(resultPath, /requires a newer version of Codex|unsupported model|model .* is not supported/i);
    if (!isContextLength && !isUnsupportedModel) continue;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const name of ["final-status.json", "run-state.json"]) {
      const source = path.join(laneDir, name);
      if (fs.existsSync(source)) {
        fs.renameSync(source, path.join(laneDir, `${name}.context-length-reset-${stamp}.bak`));
      }
    }
    reset.push({
      lane_id: laneId,
      reason: isContextLength ? "codex_context_length_retryable" : "codex_unsupported_model_retryable",
    });
  }
  if (reset.length > 0) {
    const eventsDir = path.join(cwd, ".research-lab", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event_type: "retryable_context_length_failures_reset",
      payload: { cycle_id: cycleId, reset },
    });
    fs.appendFileSync(path.join(eventsDir, `${cycleId}-cycle-events.jsonl`), `${line}\n`);
  }
  return reset;
}


// The research process in the terminal while run-research works: the
// \`follow\` command in a child process (run-research blocks its own thread in
// the native run-plan). It only reads, and it goes when this process goes.
function startProgressFollower(cycleId) {
  if (!cycleId) return null;
  try {
    // No signal handlers here: this thread is blocked in the native run-plan
    // (spawnSync), so a JS handler would only delay a SIGTERM until it
    // returns. The follower watches this process instead (--parent-pid) and
    // stops when it is gone, however it went.
    const child = require("child_process").spawn(
      process.execPath,
      [__filename, "follow", "--cycle-id", cycleId, "--parent-pid", String(process.pid)],
      { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] },
    );
    process.on("exit", () => {
      try { child.kill(); } catch { /* already gone */ }
    });
    return child;
  } catch {
    return null;
  }
}

function printJsHelp() {
  process.stdout.write(
    `Usage: researchlab <command> [options]

JS Commands:
  init
  native-build
  doctor [--json]
  bootstrap [--json]
  resume-cycle --cycle-id <id> [--max-passes <n>] [--sleep-seconds <n>]
               [--max-concurrency <n>] [--stale-seconds <n>] [--continuous]
  force-pivot --cycle-id <id> [--reason <text>] [--note <text>]
              [--keep-termination-code]
  run-research (--prompt <text> | --prompt-file <path>) [--cycle-id <id>] [--quiet]
               [--max-passes <n>] [--sleep-seconds <n>]
               [--max-concurrency <n>] [--stale-seconds <n>]
               [--max-supervisor-passes <n>] [--max-evidence-passes <n>]
               [--max-approval-passes <n>] [--max-document-passes <n>]
               [--break-on-stagnation|--no-break-on-stagnation]
               [--auto-resume-on-quota]
               [--agent-runtime codex|claude]
  refresh-cycle --cycle-id <id> [--context-only]
  refresh-gate --cycle-id <id>
  setup        the Codex log-in step and every optional API key, one question each
  keys [list|set <name> [--stdin]|unset <name>|path]
               the optional API keys, kept in ~/.researchlab/.env (never in the repository)
  follow --cycle-id <id> [--history <n>] [--interval <s>] [--once]
               print the research process as it happens: lanes, results, lead,
               gate scores, harness notices, maintainer fixes
  status --cycle-id <id> [--json]
               one line per stage of the cycle; exits 1 when one needs attention
  candidates --cycle-id <id> [--json]
               the expert-selected candidate problems waiting for your choice
  select --cycle-id <id> --candidate <candidate-id|release> [--note <why>]
               choose the problem the cycle pursues (the owner checkpoint)
  tell --cycle-id <id> (--message <text> | --message-file <path>)
               send the LabDirector of a running cycle a message
  watch-cycle --cycle-id <id> [--interval-seconds <n>] [--once] [--daemon]
${LIVE_VIEW_AVAILABLE ? "  live-view --cycle-id <id> [--port <n>]\n" : ""}
Native Commands:
  demo-lane
  run-lane
  build-brief
  aggregate-cycle
  build-viz
  build-report
  lane-status
  abort-lane
  decide
  demo-flow
  print-long-run-blueprint
  materialize-long-run-plan
  run-plan
  import-codex-auth
  import-claude-auth
  auth-status
  demo-codex-lane

Notes:
  --max-supervisor-passes defaults to 12 when not set.
  Set --max-supervisor-passes 0 to allow unbounded supervisor looping.
  --sleep-seconds 0 uses adaptive Codex pacing instead of a fixed pass delay.
  run-research prints the research process (as \`follow\` does) while it runs;
    --quiet, or RESEARCHLAB_FOLLOW=0, prints only the final summary.
  --agent-runtime selects which CLI executes codex-agent lanes (default codex).
    codex  : use the Codex CLI (codex exec --json --ephemeral ...).
    claude : use the Claude Code CLI (claude -p --output-format json ...).
  RESEARCHLAB_RESEARCH_SCOPE=planning-only keeps analysis design enabled but blocks all LabRunner execution.
    Equivalent env var: RESEARCHLAB_AGENT_RUNTIME=codex|claude.
  Before the approval gate passes, mid-cycle stagnation triggers a pivot
  follow-up instead of termination. After gate approval, stagnation controls
  still use RESEARCHLAB_STAGNATION_REPEAT_LIMIT (default 3) and
  RESEARCHLAB_STAGNATION_PENDING_SILENCE_SECONDS (default 1200).
  Native command help remains available via: node ./src/cli/index.js <native-command> --help
`,
  );
}

function printWatchCycleHelp() {
  process.stdout.write(`Usage: researchlab watch-cycle --cycle-id <id> [options]

Options:
  --interval-seconds <n>  watchdog check interval, default 600
  --once                  run one watchdog check and exit
  --daemon                start the watchdog in the background and print its pid/log

Environment:
  RESEARCHLAB_WATCH_MAX_PASSES
  RESEARCHLAB_WATCH_MAX_CONCURRENCY
  RESEARCHLAB_WATCH_STALE_SECONDS
  RESEARCHLAB_WATCH_SLEEP_SECONDS
  RESEARCHLAB_WATCH_NO_PROGRESS_SECONDS
  RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS
  RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS
`);
}

function runWatchCycleCommand({ cwd = process.cwd(), args = process.argv.slice(3) }) {
  if (args.includes("--help") || args.includes("-h")) {
    printWatchCycleHelp();
    return;
  }
  const cycleId = readFlag(args, "--cycle-id");
  if (!cycleId) throw new Error("--cycle-id is required");
  const intervalValue = readFlag(args, "--interval-seconds") || "600";
  const intervalSeconds = Number(intervalValue);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("--interval-seconds must be a positive integer");
  }
  const packageRoot = path.resolve(__dirname, "..", "..");
  const scriptPath = path.join(packageRoot, "scripts", "watch_cycle_long_run.sh");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`watchdog script not found: ${scriptPath}`);
  }
  const mode = args.includes("--once") ? "--once" : "";
  if (args.includes("--daemon")) {
    const runLogs = path.join(cwd, ".research-lab", "run-logs");
    fs.mkdirSync(runLogs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
    const logPath = path.join(runLogs, `${cycleId}-watchdog-${stamp}.log`);
    const out = fs.openSync(logPath, "a");
    const err = fs.openSync(logPath, "a");
    const child = spawn("bash", [scriptPath, cycleId, String(intervalSeconds), mode].filter(Boolean), {
      cwd,
      detached: true,
      stdio: ["ignore", out, err],
      env: process.env,
    });
    child.unref();
    process.stdout.write(`${JSON.stringify({
      status: "watch-cycle-started",
      cycle_id: cycleId,
      pid: child.pid,
      interval_seconds: intervalSeconds,
      log_path: logPath,
      mode: mode || "continuous",
    }, null, 2)}\n`);
    return;
  }
  const result = spawnSync("bash", [scriptPath, cycleId, String(intervalSeconds), mode].filter(Boolean), {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

function resumeCycleOnce(cwd, args) {
  const cycleId = readFlag(args, "--cycle-id");
  if (!cycleId) {
    throw new Error("--cycle-id is required");
  }
  require("../runtime/source_revision").assertHarnessSourceCurrent({ cwd });
  // Before bootstrap's native build: see recoverInterruptedRun.
  loadMaintainer().recoverInterruptedRun({ cwd, cycleId });

  const maxPasses = readFlag(args, "--max-passes") || "1";
  const sleepSeconds = readFlag(args, "--sleep-seconds") || "0";
  const maxConcurrency = readFlag(args, "--max-concurrency") || "4";
  const staleSeconds = readFlag(args, "--stale-seconds") || "1800";

  const boot = bootstrap(cwd, { skipPythonProbe: true });
  if (!boot.doctor?.ready_for_run_plan) {
    return {
      status: "blocked",
      bootstrap: boot,
      message: "bootstrap did not reach a run-plan-ready state",
    };
  }

  const env = { PATH: pathWithVenv(cwd) };
  const { cleanupOrphanNativeRunPlans } = loadProcessCleanup();
  const {
    actionsContainCycleRuntimeBlock,
    healCycleOnce,
    hasRetryableCycleFailures,
    readCycleRuntimeSetupBlock,
  } = loadSelfHealingCycle();
  const { resumeRunPlanStdio } = require("../runtime/run_plan_stdio");
  const orphanNativeRunPlansCleaned = cleanupOrphanNativeRunPlans({ cwd, cycleId });
  clearTerminationCode({ cwd, cycleId });
  clearProviderQuotaPause({ cwd, cycleId });
  const retryableContextFailuresReset = resetRetryableContextLengthFailures({ cwd, cycleId });
  const runPlanArgv = [
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
  const captureRunPlanStdout = process.env.RESEARCHLAB_CAPTURE_RUN_PLAN_STDOUT === "1";
  let result = null;
  const selfHealActions = [];
  for (let attempt = 0; attempt <= maxSelfHealAttempts; attempt += 1) {
    result = runNative(runPlanArgv, {
      cwd,
      stdio: resumeRunPlanStdio({ captureRunPlanStdout }),
      encoding: captureRunPlanStdout ? "utf8" : undefined,
      env,
    });

    if (result.status === 0) {
      if (attempt < maxSelfHealAttempts && hasRetryableCycleFailures({ cwd, cycleId })) {
        const healActions = healCycleOnce({
          cwd,
          cycleId,
          staleSeconds: Number(staleSeconds),
          error: "run-plan completed with retryable failed lanes",
        });
        selfHealActions.push(...healActions);
        if (actionsContainCycleRuntimeBlock(healActions)) break;
        continue;
      }
      break;
    }

    if (attempt >= maxSelfHealAttempts) {
      throw new Error(result.stderr || `run-plan failed for ${cycleId}`);
    }
    const healActions = healCycleOnce({
      cwd,
      cycleId,
      staleSeconds: Number(staleSeconds),
      error: result.stderr || result.stdout || `run-plan failed for ${cycleId}`,
      forceFailedRetry: true,
    });
    selfHealActions.push(...healActions);
    if (actionsContainCycleRuntimeBlock(healActions)) break;
  }

  // The native binary's stdout can reach tens of megabytes (it serialises
  // the full run-summary plus nested lane payloads). In rare pathological
  // cases we've observed JSON.parse failures at positions > 20MB — likely
  // a single malformed string inside one lane's captured stdout/stderr
  // preview corrupting the surrounding JSON boundary. Rather than crashing
  // the entire CLI, capture the parse error, salvage a stdout snippet
  // around the failure so the researcher can diagnose, and continue with
  // refreshCycleOutputs so the post-processing artifacts still land.
  const rawStdout = result.stdout || "";
  let payload = {};
  let payload_parse_error = null;
  if (!captureRunPlanStdout) {
    payload_parse_error = {
      message: "native run-plan stdout capture disabled; using refreshed cycle outputs",
      stdout_bytes: null,
      error_position: null,
      context_before: null,
      context_after: null,
    };
  } else {
    try {
      payload = JSON.parse(rawStdout.trim() || "null") || {};
    } catch (error) {
      const pos = Number((/position (\d+)/.exec(error.message || "") || [])[1]);
      const contextRadius = 240;
      const contextStart = Number.isFinite(pos) ? Math.max(0, pos - contextRadius) : 0;
      const contextEnd = Number.isFinite(pos) ? Math.min(rawStdout.length, pos + contextRadius) : contextRadius;
      payload_parse_error = {
        message: String(error.message || error),
        stdout_bytes: rawStdout.length,
        error_position: Number.isFinite(pos) ? pos : null,
        context_before: Number.isFinite(pos) ? rawStdout.slice(contextStart, pos) : null,
        context_after: Number.isFinite(pos) ? rawStdout.slice(pos, contextEnd) : null,
      };
    }
  }
  const refreshed = refreshOutputsAfterRun({ cwd, cycleId });
  const runtimeSetupBlock = readCycleRuntimeSetupBlock({ cwd, cycleId })
    || selfHealActions.find((action) => action.action === "cycle_runtime_setup_blocked")
    || null;
  return {
    ...payload,
    ...(runtimeSetupBlock ? {
      status: "blocked",
      runtime_setup_block: runtimeSetupBlock,
    } : {}),
    refreshed_outputs: refreshed,
    bootstrap: boot,
    orphan_native_runplans_cleaned: orphanNativeRunPlansCleaned,
    retryable_context_failures_reset: retryableContextFailuresReset,
    self_heal_actions: selfHealActions,
    // Only present when the native binary's stdout could not be parsed.
    // Consumers treat this field as authoritative for diagnosing CLI exit
    // issues that would otherwise surface as a bare "Expected ..." error.
    payload_parse_error,
  };
}

function resumeCycle(cwd, args) {
  const continuous = args.includes("--continuous");
  const filteredArgs = args.filter((arg) => arg !== "--continuous");
  if (!continuous) return resumeCycleOnce(cwd, filteredArgs);

  const cycleId = readFlag(filteredArgs, "--cycle-id");
  if (!cycleId) throw new Error("--cycle-id is required");
  const idleSeconds = Number(readFlag(filteredArgs, "--continuous-idle-seconds") || "5");
  const filteredForOnce = filteredArgs.filter((arg, index) => {
    if (arg === "--continuous-idle-seconds") return false;
    if (filteredArgs[index - 1] === "--continuous-idle-seconds") return false;
    return true;
  });
  const startedAt = new Date().toISOString();
  const batches = [];
  // Keep resume-cycle itself resident: each batch still goes through
  // resumeCycleOnce(), including bootstrap, retryable failure reset,
  // run-plan execution, output refresh, and self-healing retries.
  // The loop exits only when a terminal termination-code asks it to stop.
  while (true) {
    const batchStartedAt = new Date().toISOString();
    let payload = {};
    let batchError = null;
    try {
      payload = resumeCycleOnce(cwd, filteredForOnce);
    } catch (error) {
      const { isHarnessSourceChangedError } = require("../runtime/source_revision");
      if (isHarnessSourceChangedError(error)) {
        const { restartOrchestrator } = loadMaintainer();
        const restarted = restartOrchestrator({
          cwd,
          cycleId,
          runId: `source-change-${String(error.current_revision || "unknown").slice(0, 12)}`,
        });
        if (!restarted) throw error;
      }
      batchError = {
        message: String(error?.message || error),
        stack: error?.stack ? String(error.stack).slice(0, 8000) : null,
      };
    }
    // The maintainer (RESEARCHLAB_MAINTAINER=1) looks at what the batch left
    // behind before the stop decision below; a fix that clears the blocker
    // also clears the termination code, so the loop simply goes on.
    const { maybeRestartAfterMaintenance, maybeRunMaintainer } = loadMaintainer();
    const maintenance = maybeRunMaintainer({
      cwd,
      cycleId,
      error: batchError ? batchError.message : null,
      staleSeconds: Number(readFlag(filteredForOnce, "--stale-seconds") || "1800"),
    });
    if (maintenance) maybeRestartAfterMaintenance({ cwd, cycleId, outcome: maintenance });
    const termination = safeReadJson(path.join(cwd, ".research-lab", "state", `${cycleId}-termination-code.json`));
    const compactPayload = compactResumePayload(payload, cycleId);
    const summary = {
      batch: batches.length + 1,
      started_at: batchStartedAt,
      finished_at: new Date().toISOString(),
      passes_completed: payload.passes_completed ?? payload.pass_summaries?.length ?? null,
      self_heal_actions: payload.self_heal_actions || [],
      payload_parse_error: payload.payload_parse_error || null,
      batch_error: batchError,
      maintenance: maintenance || null,
      lane_counts: compactPayload.lane_counts || null,
      termination_code: termination,
    };
    batches.push(summary);
    process.stdout.write(`${JSON.stringify({
      status: "continuous-batch-complete",
      cycle_id: cycleId,
      started_at: startedAt,
      ...summary,
    }, null, 2)}\n`);
    if (termination?.should_stop === true) {
      return {
        status: "continuous-stopped",
        cycle_id: cycleId,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        batches,
        termination_code: termination,
      };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, idleSeconds) * 1000);
  }
}

function main() {
  if (
    process.argv.length <= 2 ||
    process.argv[2] === "--help" ||
    process.argv[2] === "-h" ||
    process.argv[2] === "help"
  ) {
    printJsHelp();
    return;
  }

  if (process.argv[2] === "init") {
    try {
      ensureNativeBuilt();
      const payload = loadInitResearchLab()({ cwd: process.cwd() });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "native-build") {
    ensureNativeBuilt();
    return;
  }

  if (process.argv[2] === "keys" || process.argv[2] === "setup") {
    const keys = require("./keys");
    const run = process.argv[2] === "setup" ? keys.runSetup() : keys.runKeysCommand(process.argv.slice(3));
    Promise.resolve(run).catch((error) => {
      process.stderr.write(`${process.argv[2]}: ${error.message}\n`);
      process.exit(1);
    });
    return;
  }

  if (process.argv[2] === "candidates" || process.argv[2] === "select") {
    try {
      const owner = require("./select");
      if (process.argv[2] === "candidates") owner.runCandidatesCommand(process.argv.slice(3));
      else owner.runSelectCommand(process.argv.slice(3));
    } catch (error) {
      process.stderr.write(`${process.argv[2]}: ${error.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (process.argv[2] === "follow") {
    require("./follow").runFollowCommand(process.argv.slice(3)).catch((error) => {
      process.stderr.write(`follow: ${error.message}
`);
      process.exit(1);
    });
    return;
  }

  if (process.argv[2] === "status") {
    // cycle_status.js is a script over process.argv.
    process.argv = [process.argv[0], require("path").join(__dirname, "cycle_status.js"), ...process.argv.slice(3)];
    require("./cycle_status");
    return;
  }

  if (process.argv[2] === "tell") {
    try {
      require("./tell").runTellCommand(process.argv.slice(3));
    } catch (error) {
      process.stderr.write(`tell: ${error.message}
`);
      process.exit(1);
    }
    return;
  }

  if (process.argv[2] === "doctor") {
    try {
      const payload = doctor(process.cwd());
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "bootstrap") {
    try {
      const payload = bootstrap(process.cwd());
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "resume-cycle") {
    try {
      const payload = resumeCycle(process.cwd(), process.argv.slice(3));
      const cycleId = readFlag(process.argv.slice(3), "--cycle-id");
      process.stdout.write(`${stringifyCliPayload(payload, compactResumePayload(payload, cycleId))}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "force-pivot") {
    try {
      const payload = forcePivotCycle(process.cwd(), process.argv.slice(3));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "run-research") {
    try {
      // Optional ``--auto-resume-on-quota`` flag: when the cycle exits
      // with CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK and at least one
      // lane was quota_exceeded, parse the Codex CLI ``try again at
      // <H:MM AM|PM>`` message from any lane's stdout, sleep until
      // that time + 60 s, and call resume-cycle. Loops until the
      // cycle terminates without a quota signal or the per-process
      // attempt cap is reached. Off by default so the CLI's existing
      // exit-on-completion behaviour is unchanged for short / single
      // runs.
      const rawArgs = process.argv.slice(3);
      const autoResumeIdx = rawArgs.indexOf("--auto-resume-on-quota");
      const autoResume = autoResumeIdx >= 0;
      let args = autoResume
        ? rawArgs.filter((_, i) => i !== autoResumeIdx)
        : rawArgs;
      // --quiet: no live progress, only the final summary.
      const quiet = args.includes("--quiet") || process.env.RESEARCHLAB_FOLLOW === "0";
      args = args.filter((token) => token !== "--quiet");
      // One spelling of the request and the cycle id for everything below:
      // --prompt-file becomes --prompt, and the derived default id is made
      // explicit so the progress follower watches the cycle that runs.
      {
        const parsed = require("../orchestrator/args").parseRunResearchArgs(args);
        const fileIndex = args.indexOf("--prompt-file");
        if (fileIndex >= 0) args = [...args.slice(0, fileIndex), "--prompt", parsed.prompt, ...args.slice(fileIndex + 2)];
        if (!args.includes("--cycle-id")) args = [...args, "--cycle-id", parsed.cycleId];
      }
      if (!quiet) startProgressFollower(readFlag(args, "--cycle-id"));
      // Handler-scoped so the final payload write (compactResumePayload below)
      // can reference it whether or not --auto-resume-on-quota was passed.
      // Previously cycleId was only defined inside the autoResume branch, so a
      // plain `run-research` aborted at the end with "cycleId is not defined".
      const cycleId = readFlag(args, "--cycle-id");
      // When auto-resume is on, also start a watchdog Worker that
      // SIGTERMs the run-plan supervisor if the cycle has at least
      // one quota_exceeded lane and stops making progress for 15
      // minutes. spawnSync inside runResearch blocks the main thread,
      // so the watchdog has to live in a Worker.
      let watchdog = null;
      if (autoResume) {
        try {
          const { Worker } = require("worker_threads");
          watchdog = new Worker(
            require("path").join(__dirname, "..", "orchestrator", "quota_stall_watchdog_worker.js"),
            {
              workerData: {
                cwd: process.cwd(),
                cycleId,
                parentPid: process.pid,
              },
            },
          );
          watchdog.on("message", (m) => {
            if (m?.kind === "triggered") {
              process.stderr.write(
                `auto-resume-on-quota: watchdog triggered — ${m.data.completed}/${m.data.total} lanes finalised, ${m.data.quota} quota_exceeded, stalled ${m.data.stalledSeconds}s; signalling supervisor.\n`,
              );
            }
          });
          watchdog.on("error", () => { /* swallow — watchdog is best-effort */ });
        } catch {
          watchdog = null;
        }
      }
      // Capture errors from runResearch so the auto-resume loop can
      // still take over when the supervisor was SIGTERMed by the
      // watchdog (or aborted on a transient native error) without
      // first writing a clean termination_code.json. Without this,
      // any non-zero exit from run-plan would skip the resume path
      // even though the lanes carry a valid Codex ``try again at''
      // signal.
      let payload;
      let initialError = null;
      try {
        const runResearch = loadRunResearch();
        payload = runResearch(args, { cwd: process.cwd() });
      } catch (e) {
        initialError = e;
        payload = null;
      }
      if (watchdog) {
        try { watchdog.terminate(); } catch { /* ignore */ }
      }
      if (autoResume) {
        const {
          findCycleQuotaResetTime,
          shouldAutoResume,
          sleepUntilSync,
        } = require("../orchestrator/quota_recovery");
        const cwd = process.cwd();
        const cycleId = readFlag(args, "--cycle-id") || payload?.cycle_id;
        // Permissive resume condition: if the normal
        // shouldAutoResume gate (termination_code + quota>0) fails
        // BUT we can still find a Codex ``try again at`` reset time
        // in any lane's stdout, treat the cycle as quota-stalled
        // and proceed. This rescues the SIGTERM-from-watchdog case
        // where the supervisor never got a chance to write the
        // termination code.
        const lookForResume = () =>
          shouldAutoResume(cwd, cycleId) ||
          (initialError && cycleId && !!findCycleQuotaResetTime(cwd, cycleId));
        const maxAttempts = 8;
        let attempts = 0;
        while (cycleId && lookForResume() && attempts < maxAttempts) {
          const resetAt = findCycleQuotaResetTime(cwd, cycleId);
          if (!resetAt) break;
          const slept = sleepUntilSync(resetAt);
          process.stderr.write(
            `auto-resume-on-quota: cycle ${cycleId} hit quota; reset at ${resetAt.toISOString()}, slept ${slept}s, resuming (attempt ${attempts + 1}/${maxAttempts})\n`,
          );
          const resumeArgs = [
            "--cycle-id",
            cycleId,
            "--max-passes",
            readFlag(args, "--max-passes") || "12",
            "--sleep-seconds",
            readFlag(args, "--sleep-seconds") || "0",
            "--max-concurrency",
            readFlag(args, "--max-concurrency") || "2",
          ];
          const stale = readFlag(args, "--stale-seconds");
          if (stale) resumeArgs.push("--stale-seconds", stale);
          // Re-arm the watchdog around each resume invocation so a
          // chained quota window (cycle resumes → hits quota again
          // before the supervisor exits → stalls) still gets caught.
          let resumeWatchdog = null;
          try {
            const { Worker } = require("worker_threads");
            resumeWatchdog = new Worker(
              require("path").join(__dirname, "..", "orchestrator", "quota_stall_watchdog_worker.js"),
              { workerData: { cwd, cycleId, parentPid: process.pid } },
            );
            resumeWatchdog.on("message", (m) => {
              if (m?.kind === "triggered") {
                process.stderr.write(
                  `auto-resume-on-quota: resume-watchdog triggered — stalled ${m.data.stalledSeconds}s; signalling supervisor.\n`,
                );
              }
            });
            resumeWatchdog.on("error", () => {});
          } catch { resumeWatchdog = null; }
          payload = resumeCycle(cwd, resumeArgs);
          if (resumeWatchdog) { try { resumeWatchdog.terminate(); } catch {} }
          // Once a resume completed normally, drop the initial-error
          // permissive gate — subsequent iterations should require
          // the strict CONTINUATION_IMPOSSIBLE + quota signal.
          initialError = null;
          attempts += 1;
        }
      }
      // After the resume loop, if the FIRST run threw and we never
      // entered the loop (no quota evidence), surface the original
      // error instead of silently writing a null payload.
      if (payload === null && initialError) throw initialError;
      process.stdout.write(`${stringifyCliPayload(payload, compactResumePayload(payload, cycleId))}\n`);
      return;
    } catch (error) {
      // Print the full stack so an overnight cycle that aborts mid-run
      // leaves a diagnosable trail. Without this, a single
      // ``Unexpected end of JSON input`` from somewhere in the agent
      // chain produces a one-line log with no clue where it came from.
      // The harness source moved under this resident process
      // (runtime/source_revision.js). That is not a crash to diagnose: exit so
      // the container's restart policy starts the cycle again on the new
      // source. It happens between run-plans, with no lane running.
      if (require("../runtime/source_revision").isHarnessSourceChangedError(error)) {
        process.stderr.write(`run-research reloading: ${error.message}\n`);
        // The maintainer's pass after this run-plan did not happen; the next
        // process makes it first (orchestrator/maintainer_catch_up.js).
        require("../orchestrator/maintainer_catch_up").noteMaintainerCatchUp({
          cwd: process.cwd(),
          cycleId: readFlag(process.argv.slice(3), "--cycle-id"),
          reason: error.message,
        });
        process.exit(75);
      }
      const message = error?.stack || error?.message || String(error);
      process.stderr.write(`run-research aborted: ${message}\n`);
      // The supervisor sees the crash before the process goes; see
      // maintainAfterAbort. Its own failure never replaces the abort.
      try {
        const maintenance = loadMaintainer().maintainAfterAbort({
          cwd: process.cwd(),
          cycleId: readFlag(process.argv.slice(3), "--cycle-id"),
          error,
        });
        if (maintenance) {
          process.stderr.write(
            `run-research aborted; maintainer ${maintenance.run_id || ""}: ${maintenance.outcome}`
              + `${maintenance.commit ? ` ${maintenance.commit}` : ""}${maintenance.reason ? ` (${String(maintenance.reason).slice(0, 300)})` : ""}\n`,
          );
        }
      } catch (maintainerError) {
        process.stderr.write(`run-research aborted; maintainer could not run: ${maintainerError?.message || maintainerError}\n`);
      }
      process.exit(1);
    }
  }

  if (process.argv[2] === "refresh-cycle") {
    try {
      const refreshArgs = process.argv.slice(3);
      const cycleId = readFlag(refreshArgs, "--cycle-id");
      if (!cycleId) {
        throw new Error("--cycle-id is required");
      }
      const payload = refreshArgs.includes("--context-only")
        ? loadRefreshCycleContextOutputs()({ cwd: process.cwd(), cycleId })
        : loadRefreshCycleOutputs()({ cwd: process.cwd(), cycleId });
      process.stdout.write(`${stringifyCliPayload(payload, compactRefreshPayload(payload, cycleId))}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "watch-cycle") {
    try {
      runWatchCycleCommand({ cwd: process.cwd(), args: process.argv.slice(3) });
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "auth") {
    if (!LIVE_VIEW_AVAILABLE) liveViewUnavailable("auth");
    try {
      const args = process.argv.slice(3);
      const subcommand = args.shift();
      const { createAuthModule } = require("../reporting/live_view/auth");
      const auth = createAuthModule({ cwd: process.cwd() });
      const actor = process.env.SUDO_USER || process.env.USER || "cli";
      const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      if (!subcommand || subcommand === "help") {
        process.stdout.write(`researchlab auth commands:
  set-provider --client-id X --client-secret Y --redirect-uri URL
                [--authorize-url URL] [--token-url URL] [--userinfo-url URL]
                [--scopes "openid profile email"] [--provider-label "ChatGPT"]
                [--cookie-secure] [--session-ttl-seconds N]
  enable                           turn auth on (requires provider settings)
  disable                          turn auth off
  allowlist-mode <open|allowlist|closed>
  allow-email <email> [--role admin|member]
  revoke-email <email>
  grant <email> <role>
  suspend <email>
  reinstate <email>
  revoke-sessions <email>
  list-users        list all provisioned users
  list-allowed      list allow-listed emails
  list-audit [--limit N]  show recent audit events
  show-config       print the live auth configuration (secret redacted)
`);
        return;
      }
      if (subcommand === "set-provider") {
        const patch = {
          enabled: true,
          client_id: readFlag(args, "--client-id"),
          client_secret: readFlag(args, "--client-secret"),
          redirect_uri: readFlag(args, "--redirect-uri"),
        };
        const optional = {
          authorize_url: readFlag(args, "--authorize-url"),
          token_url: readFlag(args, "--token-url"),
          userinfo_url: readFlag(args, "--userinfo-url"),
          scopes: readFlag(args, "--scopes"),
          provider_label: readFlag(args, "--provider-label"),
          session_ttl_seconds: readFlag(args, "--session-ttl-seconds"),
        };
        for (const k of Object.keys(optional)) { if (optional[k] != null) patch[k] = optional[k]; }
        if (args.includes("--cookie-secure")) patch.cookie_secure = true;
        if (!patch.client_id || !patch.client_secret || !patch.redirect_uri) {
          throw new Error("--client-id, --client-secret, --redirect-uri are required");
        }
        out(auth.admin.saveConfig(patch, actor));
        return;
      }
      if (subcommand === "enable") { out(auth.admin.saveConfig({ enabled: true }, actor)); return; }
      if (subcommand === "disable") { out(auth.admin.saveConfig({ enabled: false }, actor)); return; }
      if (subcommand === "allowlist-mode") {
        const mode = args.shift();
        if (!["open", "allowlist", "closed"].includes(mode)) throw new Error("mode must be open|allowlist|closed");
        out(auth.admin.saveConfig({ allowlist_mode: mode }, actor));
        return;
      }
      if (subcommand === "allow-email") {
        const email = args.shift();
        if (!email) throw new Error("usage: auth allow-email <email>");
        const role = readFlag(args, "--role") || "member";
        auth.admin.addAllowed(email, role, actor);
        out({ ok: true, email, role });
        return;
      }
      if (subcommand === "revoke-email") {
        const email = args.shift();
        if (!email) throw new Error("usage: auth revoke-email <email>");
        auth.admin.removeAllowed(email, actor);
        out({ ok: true, email });
        return;
      }
      if (subcommand === "grant") {
        const email = args.shift();
        const role = args.shift();
        if (!email || !role) throw new Error("usage: auth grant <email> <role>");
        auth.admin.grantRole(email, role, actor);
        out({ ok: true, email, role });
        return;
      }
      if (subcommand === "suspend") {
        const email = args.shift();
        if (!email) throw new Error("usage: auth suspend <email>");
        auth.admin.suspend(email, actor);
        out({ ok: true, email, status: "suspended" });
        return;
      }
      if (subcommand === "reinstate") {
        const email = args.shift();
        if (!email) throw new Error("usage: auth reinstate <email>");
        auth.admin.reinstate(email, actor);
        out({ ok: true, email, status: "active" });
        return;
      }
      if (subcommand === "revoke-sessions") {
        const email = args.shift();
        if (!email) throw new Error("usage: auth revoke-sessions <email>");
        auth.admin.revokeSessions(email, actor);
        out({ ok: true, email });
        return;
      }
      if (subcommand === "list-users") { out(auth.admin.listUsers()); return; }
      if (subcommand === "list-allowed") { out(auth.admin.listAllowed()); return; }
      if (subcommand === "list-audit") {
        const limit = Number(readFlag(args, "--limit") || 50);
        out(auth.admin.listAudit({ limit }));
        return;
      }
      if (subcommand === "show-config") {
        const cfg = auth.admin.getConfig();
        const redacted = { ...cfg, client_secret: cfg.client_secret ? "***redacted***" : null };
        out(redacted);
        return;
      }
      throw new Error(`unknown subcommand: ${subcommand}. Run 'auth help' for usage.`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "refresh-gate") {
    try {
      const refreshArgs = process.argv.slice(3);
      const cycleId = readFlag(refreshArgs, "--cycle-id");
      if (!cycleId) {
        throw new Error("--cycle-id is required");
      }
      const payload = loadRefreshGateOutputs()({ cwd: process.cwd(), cycleId });
      process.stdout.write(`${stringifyCliPayload(payload, compactRefreshPayload(payload, cycleId))}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.stack || error.message || String(error)}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "live-view") {
    if (!LIVE_VIEW_AVAILABLE) liveViewUnavailable("live-view");
    try {
      const args = process.argv.slice(3);
      const cycleId = readFlag(args, "--cycle-id");
      const portValue = readFlag(args, "--port");
      if (!cycleId) {
        throw new Error("--cycle-id is required");
      }
      const port = Number(portValue || 8010);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error("--port must be a positive integer");
      }
      loadServeLiveView()({ cwd: process.cwd(), cycleId, port });
      process.stdout.write(`${JSON.stringify({ cycle_id: cycleId, port, url: `http://localhost:${port}/live` }, null, 2)}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "run-plan") {
    try {
      const argv = process.argv.slice(2);
      const cycleId = readFlag(argv.slice(1), "--cycle-id");
      const result = runNative(argv, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      if (result.status !== 0) {
        process.stderr.write(result.stderr || "");
        process.exit(result.status || 1);
      }
      const payload = JSON.parse((result.stdout || "null").trim() || "null");
      const refreshed = cycleId
        ? refreshOutputsAfterRun({ cwd: process.cwd(), cycleId })
        : null;
      process.stdout.write(
        `${JSON.stringify(
          refreshed ? { ...payload, refreshed_outputs: refreshed } : payload,
          null,
          2,
        )}\n`,
      );
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv[2] === "import-claude-auth") {
    try {
      const result = importClaudeAuthInline(process.cwd());
      if (result.status !== 0) {
        process.stderr.write(`${result.stderr || "import-claude-auth failed"}\n`);
        process.exit(1);
      }
      process.stdout.write(`${result.stdout}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  runNative(process.argv.slice(2));
}

main();
