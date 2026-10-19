"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  actionsContainCycleRuntimeBlock,
  hasRetryableCycleFailures,
  healCycleOnce,
  isRetryableText,
  isWindowsSetupBlock,
  readCycleRuntimeSetupBlock,
  __private,
} = require("../src/orchestrator/self_healing_cycle");
const { ensureDir, writeJson } = require("../src/shared/json");

function makeCycle(cycleId) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-self-heal-"));
  ensureDir(path.join(cwd, ".research-lab", "lanes", cycleId));
  ensureDir(path.join(cwd, ".research-lab", "events"));
  return cwd;
}

function laneDir(cwd, cycleId, laneId) {
  const dir = path.join(cwd, ".research-lab", "lanes", cycleId, laneId);
  ensureDir(dir);
  return dir;
}

function isoSecondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test("self-heal preserves live external scout lanes using process metadata", () => {
  const cycleId = "cycle-self-heal-live-external";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-scout-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-scout-001",
    role: "scout",
    runtime_class: "external-driver",
  });
  writeJson(path.join(dir, "run-state.json"), {
    lane_id: "followup-scout-001",
    role: "scout",
    runtime_class: "external-driver",
    status: "running",
    started_at: isoSecondsAgo(120),
  });
  writeJson(path.join(dir, "process.json"), {
    lane_id: "followup-scout-001",
    pid: process.pid,
    started_at: isoSecondsAgo(120),
  });

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.ok(fs.existsSync(path.join(dir, "run-state.json")), "live external scout run-state should remain");
  assert.equal(actions.some((action) => action.action === "clear_stale_running_state"), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal still clears stale generic running lanes", () => {
  const cycleId = "cycle-self-heal-stale-generic";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "analyst-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "analyst-001",
    role: "analyst",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), {
    lane_id: "analyst-001",
    role: "analyst",
    runtime_class: "codex-agent",
    status: "running",
    started_at: isoSecondsAgo(120),
  });
  writeJson(path.join(dir, "process.json"), {
    lane_id: "analyst-001",
    pid: process.pid,
    started_at: isoSecondsAgo(120),
  });

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.equal(fs.existsSync(path.join(dir, "run-state.json")), false, "stale generic run-state should be cleared");
  assert.equal(fs.existsSync(path.join(dir, "process.json")), false, "stale generic process metadata should be cleared");
  assert.ok(actions.some((action) => (
    action.action === "clear_stale_running_state" &&
    action.lane_id === "analyst-001" &&
    action.stale_seconds === 1
  )));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal clears orphan dead process metadata after run-state backup", () => {
  const cycleId = "cycle-self-heal-orphan-process";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "runner-orphan-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "runner-orphan-001",
    role: "lab-runner",
    runtime_class: "external-driver",
  });
  writeJson(path.join(dir, "process.json"), {
    lane_id: "runner-orphan-001",
    pid: 99999999,
    started_at: isoSecondsAgo(120),
  });

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.equal(fs.existsSync(path.join(dir, "process.json")), false, "orphan dead process metadata should be cleared");
  assert.ok(actions.some((action) => (
    action.action === "clear_stale_process_metadata" &&
    action.lane_id === "runner-orphan-001"
  )));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal reclaims an empty run-state after its process metadata is gone", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-04: self-healing cleared
  // followup-analyst-347's dead process metadata but left its zero-byte
  // run-state.json. Native supervision then failed on that file every pass, so
  // the completed analysis could never advance to a gate review.
  const cycleId = "cycle-a-20260919";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-analyst-347");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-analyst-347",
    role: "analyst",
    runtime_class: "codex-agent",
  });
  fs.writeFileSync(path.join(dir, "run-state.json"), "");

  const actions = healCycleOnce({ cwd, cycleId });

  assert.equal(
    fs.existsSync(path.join(dir, "run-state.json")),
    false,
    "the lane must return to a pending, redispatchable shape",
  );
  assert.ok(fs.existsSync(path.join(dir, "lane-contract.json")), "the pending contract must survive");
  assert.ok(actions.some((action) => (
    action.action === "clear_empty_orphaned_run_state" &&
    action.lane_id === "followup-analyst-347"
  )));
  assert.ok(
    fs.readdirSync(dir).some((entry) => entry.startsWith("run-state.json.self-heal-") && entry.endsWith(".bak")),
    "the malformed state remains available for diagnosis",
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal reads lane-contract.json when reporting retryable reset runtime", () => {
  const cycleId = "cycle-self-heal-contract";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "runner-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "runner-001",
    role: "lab-runner",
    runtime_class: "external-driver",
  });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "runner-001",
    status: "failed",
    error: "timeout while running external workflow",
  });

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.ok(actions.some((action) => (
    action.action === "reset_failed_lane" &&
    action.lane_id === "runner-001" &&
    action.runtime_class === "external-driver"
  )));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal treats codex output schema failures as retryable", () => {
  const cycleId = "cycle-self-heal-schema";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "analyst-schema-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "analyst-schema-001",
    role: "analyst",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "analyst-schema-001",
    status: "failed",
  });
  writeJson(path.join(dir, "result.json"), {
    status: "failed",
    error: "analyst output missing executable handoff_checks, validation_code_blueprints, or self_review contract",
  });
  fs.writeFileSync(
    path.join(dir, "stdout.log"),
    "Invalid schema for response_format 'codex_output_schema': invalid_json_schema at text.format.schema",
  );

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.ok(actions.some((action) => (
    action.action === "reset_failed_lane" &&
    action.lane_id === "analyst-schema-001" &&
    action.runtime_class === "codex-agent"
  )));
  assert.equal(fs.existsSync(path.join(dir, "result.json")), false, "retryable failed result should be backed up");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal does not reset failed lanes that already have recovery lanes", () => {
  const cycleId = "cycle-self-heal-existing-recovery";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "scout-001");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "scout-001",
    role: "scout",
    runtime_class: "external-driver",
  });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "scout-001",
    status: "failed",
    error: "python external driver timed out after 600s",
  });
  const recoveryDir = laneDir(cwd, cycleId, "scout-001-recovery-01");
  writeJson(path.join(recoveryDir, "lane-contract.json"), {
    lane_id: "scout-001-recovery-01",
    role: "scout",
    runtime_class: "external-driver",
  });
  writeJson(path.join(recoveryDir, "final-status.json"), {
    lane_id: "scout-001-recovery-01",
    status: "completed",
  });

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1, forceFailedRetry: true });

  assert.ok(fs.existsSync(path.join(dir, "final-status.json")), "original failed status should remain when recovery exists");
  assert.equal(actions.some((action) => action.action === "reset_failed_lane"), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal resets an old false-completed data scout that reported a runtime block", () => {
  const cycleId = "cycle-self-heal-runtime-block";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "scout-03");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "scout-03",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), { lane_id: "scout-03", status: "completed" });
  writeJson(path.join(dir, "final-status.json"), { lane_id: "scout-03", status: "completed" });
  writeJson(path.join(dir, "result.json"), {
    status: "completed",
    driver: "codex-agent-executor",
    extracted_json: {
      status: "blocked",
      candidate_count: 0,
      reason: "uv trampoline execution blocked: permission denied; result.json not created",
    },
  });

  const actions = healCycleOnce({ cwd, cycleId });

  assert.ok(actions.some((action) => (
    action.action === "reset_failed_lane" &&
    action.lane_id === "scout-03" &&
    action.reason === "model_reported_runtime_block"
  )));
  assert.equal(fs.existsSync(path.join(dir, "final-status.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "result.json")), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("self-heal preserves a truly completed empty data scout", () => {
  const cycleId = "cycle-self-heal-empty-data";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "scout-empty");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "scout-empty",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), { lane_id: "scout-empty", status: "completed" });
  writeJson(path.join(dir, "final-status.json"), { lane_id: "scout-empty", status: "completed" });
  writeJson(path.join(dir, "result.json"), {
    status: "completed",
    driver: "codex-agent-executor",
    extracted_json: { status: "completed", candidate_count: 0, dataset_candidates: [] },
  });

  const actions = healCycleOnce({ cwd, cycleId });

  assert.equal(actions.some((action) => action.action === "reset_failed_lane"), false);
  assert.ok(fs.existsSync(path.join(dir, "final-status.json")));
  assert.ok(fs.existsSync(path.join(dir, "result.json")));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("Windows sandbox setup cancellation pauses the cycle without resetting the failed lane", () => {
  // The Windows sandbox setup signature is Windows-only now, because on
  // 2026-09-12 it stopped a LINUX cycle: three ordinary English words in a
  // minified analyst report satisfied it. This test always meant a Windows
  // host; it just never had to say so while the check ran everywhere.
  const previousPlatform = process.env.RESEARCHLAB_RUNTIME_PLATFORM;
  process.env.RESEARCHLAB_RUNTIME_PLATFORM = "win32";
  try {
  const cycleId = "cycle-self-heal-windows-setup-canceled";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "scout-setup-001");
  const setupError = "orchestrator_helper_incomplete: setup helper exited successfully before setup completed";
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "scout-setup-001",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), { lane_id: "scout-setup-001", status: "failed" });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "scout-setup-001",
    status: "failed",
    error: setupError,
  });
  writeJson(path.join(dir, "result.json"), { status: "blocked", error: setupError });

  assert.equal(hasRetryableCycleFailures({ cwd, cycleId }), true, "unpaused blocked result must enter the circuit breaker");
  const actions = healCycleOnce({ cwd, cycleId, forceFailedRetry: true });
  const pause = JSON.parse(fs.readFileSync(
    path.join(cwd, ".research-lab", "state", `${cycleId}-labdirector-pause.json`),
    "utf8",
  ));
  const termination = JSON.parse(fs.readFileSync(
    path.join(cwd, ".research-lab", "state", `${cycleId}-termination-code.json`),
    "utf8",
  ));

  assert.equal(isWindowsSetupBlock(setupError), true);
  assert.equal(
    isWindowsSetupBlock("orchestrator_helper_launch_canceled: ShellExecuteExW failed with error 1223"),
    true,
  );
  assert.equal(isRetryableText(setupError), false);
  assert.ok(actions.some((action) => action.action === "cycle_runtime_setup_blocked"));
  assert.equal(actions.some((action) => action.action === "reset_failed_lane"), false);
  assert.ok(fs.existsSync(path.join(dir, "final-status.json")), "failure status must remain diagnostic evidence");
  assert.ok(fs.existsSync(path.join(dir, "result.json")), "runtime error payload must not be cleared for retry");
  assert.equal(pause.status, "blocked");
  assert.equal(pause.block_type, "windows_sandbox_setup");
  assert.equal(pause.manual_resume_required, true);
  assert.equal(termination.code, "RUNTIME_SETUP_BLOCKED");
  assert.equal(termination.should_stop, true);
  assert.equal(readCycleRuntimeSetupBlock({ cwd, cycleId }).action, "cycle_runtime_setup_blocked");
  assert.equal(hasRetryableCycleFailures({ cwd, cycleId }), false, "paused setup failure must not re-enter auto-heal");
  fs.rmSync(cwd, { recursive: true, force: true });
  } finally {
    if (previousPlatform === undefined) delete process.env.RESEARCHLAB_RUNTIME_PLATFORM;
    else process.env.RESEARCHLAB_RUNTIME_PLATFORM = previousPlatform;
  }
});

test("logs-only setup failure blocks before an unrelated stale lane is reset", () => {
  // The Windows sandbox setup signature is Windows-only now, because on
  // 2026-09-12 it stopped a LINUX cycle: three ordinary English words in a
  // minified analyst report satisfied it. This test always meant a Windows
  // host; it just never had to say so while the check ran everywhere.
  const previousPlatform = process.env.RESEARCHLAB_RUNTIME_PLATFORM;
  process.env.RESEARCHLAB_RUNTIME_PLATFORM = "win32";
  try {
  const cycleId = "cycle-self-heal-windows-setup-log-only";
  const cwd = makeCycle(cycleId);
  const setupDir = laneDir(cwd, cycleId, "scout-setup-log-001");
  writeJson(path.join(setupDir, "lane-contract.json"), {
    lane_id: "scout-setup-log-001",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(setupDir, "final-status.json"), {
    lane_id: "scout-setup-log-001",
    status: "failed",
  });
  fs.writeFileSync(
    path.join(setupDir, "stderr.log"),
    "orchestrator_helper_incomplete: setup helper exited successfully before setup completed\n",
  );

  const staleDir = laneDir(cwd, cycleId, "analyst-unrelated-stale");
  writeJson(path.join(staleDir, "lane-contract.json"), {
    lane_id: "analyst-unrelated-stale",
    role: "analyst",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(staleDir, "run-state.json"), {
    lane_id: "analyst-unrelated-stale",
    status: "running",
    started_at: isoSecondsAgo(7200),
    pid: 99999999,
  });
  writeJson(path.join(staleDir, "process.json"), {
    lane_id: "analyst-unrelated-stale",
    pid: 99999999,
    started_at: isoSecondsAgo(7200),
  });

  assert.equal(hasRetryableCycleFailures({ cwd, cycleId }), true, "stderr-only setup signature must be detected");
  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1, forceFailedRetry: true });

  assert.ok(actions.some((action) => (
    action.action === "cycle_runtime_setup_blocked" &&
    action.lane_id === "scout-setup-log-001" &&
    action.source === "stderr.log"
  )));
  assert.equal(actions.some((action) => action.action === "clear_stale_running_state"), false);
  assert.ok(fs.existsSync(path.join(setupDir, "final-status.json")), "setup failure status must remain");
  assert.ok(fs.existsSync(path.join(setupDir, "stderr.log")), "setup failure log must remain");
  assert.ok(fs.existsSync(path.join(staleDir, "run-state.json")), "unrelated checkpoint must not be reset");
  assert.ok(fs.existsSync(path.join(staleDir, "process.json")), "unrelated process metadata must not be reaped");
  fs.rmSync(cwd, { recursive: true, force: true });
  } finally {
    if (previousPlatform === undefined) delete process.env.RESEARCHLAB_RUNTIME_PLATFORM;
    else process.env.RESEARCHLAB_RUNTIME_PLATFORM = previousPlatform;
  }
});

test("self-heal parses Linux proc stat state after parenthesized command names", () => {
  assert.equal(__private.pidStateFromProcStatText("123 (python3) S 1 2 3"), "S");
  assert.equal(__private.pidStateFromProcStatText("456 (researchlab-har) Z 1 2 3"), "Z");
  assert.equal(__private.pidStateFromProcStatText("789 (name with spaces) R 1 2 3"), "R");
});

// A scout READS what providers say. That is not the runtime failing.
//
// MEASURED ON cycle-g-v91, 2026-09-14. followup-scout-18 finished its abstract
// review -- reviewed-literature-result.json, abstract-reviews.json and
// quarantine-resolution.json all written -- and the runtime recorded
// `status: failed, failure_category: adaptive_literature_search_incomplete`,
// the designed handoff, with stderr.log and launcher.stderr.log BOTH ZERO
// BYTES. Its transcript mentioned `quota` three times, `timeout` twice and
// `too many requests` once, all inside JSON transcript events, so the retry
// classifier renamed result.json, run-state.json and final-status.json away and
// sent the lane back to pending to redo the review. Four lanes lost completed
// work that way inside one hour and the corpus stopped growing at 192.
//
// Third instance of this hole here: a FILENAME containing "quota" halted
// cycle-g-v89 for four hours, and a minified report satisfied a Windows-sandbox
// signature on Linux.
test("a lane is not reset for words the agent merely read", () => {
  const cycleId = "cycle-self-heal-transcript";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-scout-18");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-scout-18",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "followup-scout-18",
    status: "failed",
    failure_category: "adaptive_literature_search_incomplete",
  });
  const reviewed = { status: "pending_review", reviews: 12 };
  writeJson(path.join(dir, "result.json"), reviewed);
  // The runtime said nothing. Both its streams are empty, exactly as measured.
  fs.writeFileSync(path.join(dir, "stderr.log"), "");
  fs.writeFileSync(path.join(dir, "launcher.stderr.log"), "");
  // The transcript, as the CLI writes it: one JSON event per line.
  fs.writeFileSync(
    path.join(dir, "stdout.log"),
    [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: "openalex rate limit reached; quota exhausted" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the arxiv request timed out and returned too many requests" } }),
      "",
    ].join(String.fromCharCode(10)),
  );

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.equal(
    actions.some((action) => action.action === "reset_failed_lane"),
    false,
    "a completed review was discarded because of text the agent read",
  );
  assert.equal(fs.existsSync(path.join(dir, "result.json")), true, "the finished result was taken away");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")), reviewed);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a bare line the CLI itself wrote still resets the lane", () => {
  // The other half of the same rule. A codex schema error is not inside a
  // transcript event, and a lane blocked by one must still be retried.
  const cycleId = "cycle-self-heal-bare-line";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-scout-19");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-scout-19",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "final-status.json"), { lane_id: "followup-scout-19", status: "failed" });
  writeJson(path.join(dir, "result.json"), { status: "failed" });
  fs.writeFileSync(
    path.join(dir, "stdout.log"),
    [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "nothing unusual" } }),
      "stream error: rate limit exceeded, retrying in 60s",
      "",
    ].join(String.fromCharCode(10)),
  );

  const actions = healCycleOnce({ cwd, cycleId, staleSeconds: 1 });

  assert.ok(
    actions.some((action) => action.action === "reset_failed_lane" && action.lane_id === "followup-scout-19"),
    "a real runtime block on stdout no longer reaches the classifier",
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a lane refused at launch by a since-resolved setup block runs again", () => {
  const cycleId = "cycle-self-heal-resolved-prelaunch-block";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-scout-04");
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-scout-04",
    role: "scout",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), { lane_id: "followup-scout-04", status: "blocked" });
  writeJson(path.join(dir, "final-status.json"), { lane_id: "followup-scout-04", status: "blocked" });
  writeJson(path.join(dir, "result.json"), {
    status: "blocked",
    block_type: "windows_sandbox_setup",
    manual_resume_required: true,
    evidence: "Scholarly proxy ports [3128] are occupied or unavailable; refusing CLI port fallback and repeated firewall setup",
  });

  // No pause marker: the setup block was resolved and the cycle explicitly resumed.
  const actions = healCycleOnce({ cwd, cycleId });

  assert.ok(
    actions.some((action) => action.lane_id === "followup-scout-04" && action.action === "reset_failed_lane"),
    `the refused lane stayed blocked: ${JSON.stringify(actions)}`,
  );
  assert.equal(fs.existsSync(path.join(dir, "result.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "final-status.json")), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a Windows setup signature in a lane's stdout does not block a Linux cycle", () => {
  // MEASURED on cycle-a-20260919, 2026-09-23 15:18. The cycle had
  // moved into a Linux container on 2026-09-22, and sixteen minutes after a
  // restart it killed itself with RUNTIME_SETUP_BLOCKED and
  // manual_resume_required, evidence "stdout.log contains a Windows sandbox
  // setup cancellation/incomplete signature". It stayed down four hours.
  //
  // The signature was real -- written by a lane that ran on the Windows host
  // before the move. That lane is finished and its stdout never changes, so off
  // Windows the match was permanent: every heal pass re-blocked the cycle on a
  // dead lane's transcript, over a sandbox that does not exist in the container.
  const previousPlatform = process.env.RESEARCHLAB_RUNTIME_PLATFORM;
  process.env.RESEARCHLAB_RUNTIME_PLATFORM = "linux";
  try {
    const cycleId = "cycle-self-heal-linux-ignores-windows-stdout";
    const cwd = makeCycle(cycleId);
    const dir = laneDir(cwd, cycleId, "scout-from-the-windows-era");
    writeJson(path.join(dir, "lane-contract.json"), {
      lane_id: "scout-from-the-windows-era",
      role: "scout",
      runtime_class: "codex-agent",
    });
    writeJson(path.join(dir, "run-state.json"), { lane_id: "scout-from-the-windows-era", status: "failed" });
    fs.writeFileSync(
      path.join(dir, "stdout.log"),
      "orchestrator_helper_launch_incomplete: setup helper exited before setup completed",
      "utf8",
    );

    const actions = healCycleOnce({ cwd, cycleId, forceFailedRetry: true });
    assert.equal(
      actions.some((action) => action.action === "cycle_runtime_setup_blocked"),
      false,
      "a Linux cycle must not block on a Windows sandbox signature",
    );
    assert.equal(
      fs.existsSync(path.join(cwd, ".research-lab", "state", `${cycleId}-labdirector-pause.json`)),
      false,
      "no pause marker demanding a manual resume for a sandbox that is not here",
    );
  } finally {
    if (previousPlatform === undefined) delete process.env.RESEARCHLAB_RUNTIME_PLATFORM;
    else process.env.RESEARCHLAB_RUNTIME_PLATFORM = previousPlatform;
  }
});

test("an exhausted provider quota is not something self-healing may clear", () => {
  // MEASURED on cycle-a-20260919, 2026-09-24 02:20. Codex answered
  // "You've hit your usage limit ... try again at Sep 28th, 2026 1:54 AM".
  // The lane runtime did the right thing -- provider_quota pause marker,
  // manual_resume_required, PROVIDER_QUOTA_EXHAUSTED termination code with
  // should_stop -- and six seconds later the self-healer reset the failed lane
  // and deleted that termination code, for a limit four days away.
  //
  // Only the pause marker saved the cycle, because that is the half of "stop"
  // is_cycle_paused obeys. The two halves must not disagree.
  const cycleId = "cycle-self-heal-provider-quota";
  const cwd = makeCycle(cycleId);
  const dir = laneDir(cwd, cycleId, "followup-lab-director-195");
  const quotaError = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
    + "to purchase more credits or try again at Sep 28th, 2026 1:54 AM.";
  writeJson(path.join(dir, "lane-contract.json"), {
    lane_id: "followup-lab-director-195",
    role: "lab-director",
    runtime_class: "codex-agent",
  });
  writeJson(path.join(dir, "run-state.json"), { lane_id: "followup-lab-director-195", status: "failed" });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: "followup-lab-director-195",
    status: "failed",
    error: quotaError,
  });
  writeJson(path.join(cwd, ".research-lab", "state", `${cycleId}-labdirector-pause.json`), {
    cycle_id: cycleId,
    block_type: "provider_quota",
    manual_resume_required: true,
    status: "blocked",
    retry_after_hint: "Sep 28th, 2026 1:54 AM",
  });
  const terminationPath = path.join(cwd, ".research-lab", "state", `${cycleId}-termination-code.json`);
  writeJson(terminationPath, {
    cycle_id: cycleId,
    code: "PROVIDER_QUOTA_EXHAUSTED",
    should_stop: true,
  });

  assert.equal(
    hasRetryableCycleFailures({ cwd, cycleId }),
    false,
    "nothing behind an exhausted quota is retryable, whatever the lane's error text says",
  );

  const actions = healCycleOnce({ cwd, cycleId, forceFailedRetry: true });
  assert.equal(actions.some((action) => action.action === "clear_termination_code"), false,
    "a four-day provider stop must not be cleared by healing");
  assert.equal(actions.some((action) => action.action === "reset_failed_lane"), false,
    "a lane that failed on quota must not be reset at an exhausted account");
  assert.ok(fs.existsSync(terminationPath), "the termination code must survive");
  assert.ok(actionsContainCycleRuntimeBlock(actions), "the quota block is a cycle-wide runtime block");
  fs.rmSync(cwd, { recursive: true, force: true });
});
