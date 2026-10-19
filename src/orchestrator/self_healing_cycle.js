"use strict";

const fs = require("fs");
const path = require("path");
const NEWLINE = String.fromCharCode(10);
const { spawnSync } = require("child_process");
const { clearTerminationCode, writeTerminationCode } = require("../reporting/termination_code");

const WINDOWS_SETUP_BLOCK_ACTION = "cycle_runtime_setup_blocked";
const PROVIDER_QUOTA_BLOCK_ACTION = "cycle_provider_quota_blocked";

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendCycleEvent({ cwd, cycleId, eventType, payload }) {
  const eventsDir = path.join(cwd, ".research-lab", "events");
  ensureDir(eventsDir);
  fs.appendFileSync(
    path.join(eventsDir, `${cycleId}-cycle-events.jsonl`),
    `${JSON.stringify({ ts: new Date().toISOString(), event_type: eventType, payload })}\n`,
  );
}

function textOf(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

// A correct analyst report stopped the whole cycle.
//
// This detects one specific runtime failure: the Windows sandbox setup helper
// being cancelled or left incomplete. When it fires the cycle writes
// RUNTIME_SETUP_BLOCKED with `should_stop: true` and
// `manual_resume_required: true`, and the launch wrapper refuses to relaunch.
// It is the heaviest verdict this self-healer can reach, so it has to be right.
//
// MEASURED ON cycle-g-v91, 2026-09-12 23:16 KST, on a LINUX container. The
// loosest branch was
//
//     (?:sandbox|setup)[^\r\n]*(?:helper|installation)[^\r\n]*(?:cancel|incomplete)
//
// where `[^\r\n]*` was meant to hold the three tokens inside ONE LINE, that is
// inside one log message. A minified JSON document has no newlines at all, so
// the gap spanned the whole file. followup-analyst-02 wrote a careful report
// saying it had inspected three renderers, that "selection stopped before
// cloning, INSTALLATION, or execution as required by the lane contract", that
// its SETUP_commands were provisional, and that "the INCOMPLETE novelty audit
// prevents a defensible novelty claim". Three ordinary English words, thousands
// of characters apart, in a document that never mentions Windows.
//
// The cycle stopped and demanded a human to resume it. This is the third time a
// substring classifier reading an agent's own prose has taken the harness down;
// v89 halted for four hours on a FILENAME containing "quota".
//
// Two guards, because either alone leaves the other hole open:
//   - the gaps are bounded, so the tokens must actually be near one another
//     rather than merely present somewhere in the same file;
//   - the signature is Windows-only, so it cannot be reached on a host where
//     the thing it describes does not exist.
const WINDOWS_SETUP_GAP = "[^\\r\\n]{0,80}";
const WINDOWS_SETUP_SIGNATURE = new RegExp(
  [
    // A token the helper emits itself. Specific enough to stand unbounded.
    "orchestrator_helper_(?:launch_)?(?:canceled|incomplete)",
    "ShellExecuteExW" + WINDOWS_SETUP_GAP + "(?:1223|cancel)",
    "(?:win32|windows)" + WINDOWS_SETUP_GAP + "(?:error\\s*)?1223",
    "(?:sandbox|setup)" + WINDOWS_SETUP_GAP + "(?:helper|installation)"
      + WINDOWS_SETUP_GAP + "(?:cancel(?:ed|led)|incomplete)",
  ].join("|"),
  "i",
);

function hostIsWindows() {
  // Overridable, for tests and for an orchestrator driving a Windows host from
  // elsewhere. The default is the platform this process is actually running on.
  const declared = String(process.env.RESEARCHLAB_RUNTIME_PLATFORM || "").trim().toLowerCase();
  if (declared) return declared === "win32" || declared === "windows";
  return process.platform === "win32";
}

function isWindowsSetupBlock(value) {
  if (!hostIsWindows()) return false;
  return WINDOWS_SETUP_SIGNATURE.test(textOf(value));
}

function isWindowsSetupStdoutBlock(value) {
  // The one classifier of the four that did not ask where it was running.
  //
  // MEASURED on cycle-a-20260919, 2026-09-23 15:18: the cycle killed
  // itself inside a Linux container with RUNTIME_SETUP_BLOCKED and
  // `manual_resume_required: true`, evidence "stdout.log contains a Windows
  // sandbox setup cancellation/incomplete signature", and stayed down four
  // hours. final-status, result and stderr are classified by
  // isWindowsSetupBlock, which is guarded by hostIsWindows(); stdout came here,
  // and the `orchestrator_helper_*` branch below returned true on any platform.
  // Off Windows that text is history -- written by a lane that ran on the host
  // before 2026-09-22, finished and immutable -- so the match was permanent.
  if (!hostIsWindows()) return false;
  const text = textOf(value);
  if (/orchestrator_helper_(?:launch_)?(?:canceled|incomplete)/i.test(text)) return true;
  return /runtime_execution_blocked|\b(?:error|failed|failure|blocked|exception|stderr)\b/i.test(text)
    && isWindowsSetupBlock(text);
}

function isRetryableText(value) {
  if (isWindowsSetupBlock(value)) return false;
  const text = textOf(value);
  return /context_length_exceeded|maximum context length|input exceeds the maximum length|maximum length of 1048576|prompt is too long|too many tokens|context window|requires a newer version of Codex|unsupported model|model .* is not supported|invalid_json_schema|Invalid schema for response_format|text\.format\.schema|EOF while parsing a value|expected value at line 1 column 1|Unexpected end of JSON input|rate limit|rate_limit|too many requests|quota|usage limit|timeout|timed out|no last agent message|uv trampoline|permission denied|operation not permitted|execution (?:was )?blocked|failed to (?:launch|execute|spawn)|result\.json.*not ?created/i.test(text);
}

function resultReportsRetryableRuntimeBlock(resultPath) {
  const result = safeReadJson(resultPath);
  const reported = result && result.extracted_json;
  if (String((reported && reported.status) || "").toLowerCase() !== "blocked") return false;
  return isRetryableText({
    reported,
    output_last_message: result.output_last_message,
    stderr: result.stderr,
  });
}

// A lane the native admission check refused before any agent started. It did no
// work and its failure was the environment's, so once that setup block has been
// resolved (the pause marker is gone -- healCycleOnce returns before reaching
// lanes while it stands) the lane is simply runnable again.
//
// MEASURED ON cycle-b-20260917d, 2026-09-17. Three lanes refused while the
// scholarly proxy ports were unregistered, then held, stayed `blocked` after the
// setup was fixed and the cycle resumed. Nothing re-ran them and their open
// actions kept the planner from creating replacements: zero running lanes.
function resultReportsPrelaunchSetupBlock(resultPath) {
  const result = safeReadJson(resultPath);
  return String(result?.status || "").toLowerCase() === "blocked"
    && result?.block_type === "windows_sandbox_setup";
}

function fileContainsClassifiedText(filePath, classifier, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return false;
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const windows = [0];
    if (stat.size > maxBytes) windows.push(Math.max(0, stat.size - maxBytes));
    const seen = new Set();
    for (const start of windows) {
      if (seen.has(start)) continue;
      seen.add(start);
      let position = start;
      const end = Math.min(stat.size, start + maxBytes);
      while (position < end) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(chunkSize, end - position), position);
        if (bytesRead <= 0) break;
        if (classifier(buffer.subarray(0, bytesRead).toString("utf8"))) return true;
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

function fileContainsRetryableText(filePath, options) {
  return fileContainsClassifiedText(filePath, isRetryableText, options);
}

function cyclePauseMarkerPath({ cwd, cycleId }) {
  return path.join(cwd, ".research-lab", "state", `${cycleId}-labdirector-pause.json`);
}

function readWindowsSetupPause({ cwd, cycleId }) {
  // A Windows sandbox pause describes a Windows runtime. Nothing off Windows
  // has one, and nothing off Windows can resolve one.
  //
  // MEASURED 2026-09-22: the cycle moved into a Linux container carrying this
  // marker in its copied state, and every pass stopped on
  // `existing_windows_sandbox_setup_pause` -- a manual resume demanded for a
  // sandbox that does not exist in here. The orchestrator and the harness both
  // sat idle for four and a half hours with no lane touched.
  //
  // Through hostIsWindows(), not process.platform directly: every other Windows
  // check in this file honours RESEARCHLAB_RUNTIME_PLATFORM, and this one did
  // not, so the pause test could only pass on a Windows host -- red in the
  // container from the day the suite started running in here. Production
  // behaviour is unchanged: with no override, hostIsWindows() is
  // process.platform === "win32".
  if (!hostIsWindows()) return null;
  const marker = safeReadJson(cyclePauseMarkerPath({ cwd, cycleId }));
  return marker?.block_type === "windows_sandbox_setup" && marker?.manual_resume_required === true
    ? marker
    : null;
}

// A pause the provider set, which no amount of healing reaches.
//
// MEASURED on cycle-a-20260919, 2026-09-24 02:20. Codex answered
// "You've hit your usage limit ... try again at Sep 28th, 2026 1:54 AM".
// codex_lane.rs did the right thing: a provider_quota pause marker,
// manual_resume_required, and a PROVIDER_QUOTA_EXHAUSTED termination code with
// should_stop. Six seconds later the self-healer ran, saw "run-plan completed
// with retryable failed lanes", reset the failed lanes and DELETED that
// termination code -- for a limit that does not lift for four days.
//
// Only the pause marker saved it, because the marker is the thing is_cycle_paused
// obeys (b9e4435) and healing never removed it. So the two halves of "stop"
// disagreed, and the cycle survived on the half that happened to be authoritative.
// Had the order been the other way it would have thrown lanes at an exhausted
// account until Sep 28.
//
// Quota is not a failure this process can heal. It is cleared by
// clearProviderQuotaPause, on an explicit resume, which is what the marker's own
// resume_condition asks for.
function readProviderQuotaPause({ cwd, cycleId }) {
  const marker = safeReadJson(cyclePauseMarkerPath({ cwd, cycleId }));
  return marker?.block_type === "provider_quota" && marker?.manual_resume_required === true
    ? marker
    : null;
}

function readCycleRuntimeSetupBlock({ cwd, cycleId }) {
  const marker = readWindowsSetupPause({ cwd, cycleId });
  if (!marker) return null;
  return {
    action: WINDOWS_SETUP_BLOCK_ACTION,
    reason: marker.reason,
    pause_marker_path: cyclePauseMarkerPath({ cwd, cycleId }),
    manual_resume_required: true,
    evidence: marker.evidence || null,
  };
}

function findCycleWindowsSetupBlock({ cwd, cycleId, error = null }) {
  // The detector for a Windows condition, off Windows, reading history.
  //
  // MEASURED on cycle-a-20260919, 2026-09-23 15:18. Sixteen minutes
  // after a restart the container exited 0 with RUNTIME_SETUP_BLOCKED,
  // `manual_resume_required: true`, evidence "stdout.log contains a Windows
  // sandbox setup cancellation/incomplete signature" -- inside a Linux
  // container, and it stayed down four hours because a manual resume was
  // demanded for a sandbox that does not exist in here.
  //
  // This scan reads final-status, result, stdout and stderr of EVERY lane in
  // the cycle: 637 of them, including the ones that ran on Windows before
  // 2026-09-22. Those lanes really do carry the signature, and they are
  // finished and immutable, so off Windows this match is permanent -- every
  // heal pass would re-block the cycle on the same dead lane's transcript.
  //
  // readWindowsSetupPause already refuses to honour such a marker off Windows
  // (2026-09-22). This is the writer of that marker, and it needs the same
  // answer: no Windows sandbox here, so no Windows sandbox block. Skipping the
  // scan outright also spares a 637-lane, four-files-each sweep on every heal.
  if (!hostIsWindows()) return null;
  if (isWindowsSetupBlock(error)) {
    return { lane_id: null, source: "supervisor_error", evidence: textOf(error).slice(0, 2000) };
  }
  const lanesRoot = path.join(cwd, ".research-lab", "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return null;
  for (const laneId of fs.readdirSync(lanesRoot)) {
    const laneDir = path.join(lanesRoot, laneId);
    let isDirectory = false;
    try { isDirectory = fs.statSync(laneDir).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) continue;
    const sources = [
      ["final-status.json", path.join(laneDir, "final-status.json"), isWindowsSetupBlock],
      ["result.json", path.join(laneDir, "result.json"), isWindowsSetupBlock],
      ["stdout.log", path.join(laneDir, "stdout.log"), isWindowsSetupStdoutBlock],
      ["stderr.log", path.join(laneDir, "stderr.log"), isWindowsSetupBlock],
    ];
    for (const [source, filePath, classifier] of sources) {
      if (fileContainsClassifiedText(filePath, classifier)) {
        return {
          lane_id: laneId,
          source,
          evidence: `${source} contains a Windows sandbox setup cancellation/incomplete signature`,
        };
      }
    }
  }
  return null;
}

function writeWindowsSetupPause({ cwd, cycleId, evidence }) {
  const markerPath = cyclePauseMarkerPath({ cwd, cycleId });
  ensureDir(path.dirname(markerPath));
  const marker = {
    cycle_id: cycleId,
    paused_at: new Date().toISOString(),
    reason: "Windows sandbox setup helper was canceled or incomplete; automatic retry is disabled.",
    block_type: "windows_sandbox_setup",
    status: "blocked",
    manual_resume_required: true,
    resume_condition: "Resolve the Windows sandbox setup helper, then explicitly resume the cycle.",
    evidence: String(evidence || "").slice(0, 2000),
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  writeTerminationCode({
    cwd,
    cycleId,
    code: "RUNTIME_SETUP_BLOCKED",
    category: "runtime_environment",
    reason: marker.reason,
    source: "orchestrator-self-healing",
    shouldStop: true,
    metadata: {
      block_type: marker.block_type,
      manual_resume_required: true,
      pause_marker_path: markerPath,
      evidence: marker.evidence,
    },
  });
  return { markerPath, marker };
}

function actionsContainCycleRuntimeBlock(actions) {
  return Array.isArray(actions)
    && actions.some((action) => action?.action === WINDOWS_SETUP_BLOCK_ACTION
      || action?.action === PROVIDER_QUOTA_BLOCK_ACTION);
}

function readResultStatusShallow(resultPath) {
  if (!fs.existsSync(resultPath)) return null;
  let fd = null;
  try {
    fd = fs.openSync(resultPath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /"status"\s*:\s*"([^"]+)"/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function readResultStatus(resultPath) {
  return readResultStatusShallow(resultPath) || (safeReadJson(resultPath) || {}).status || null;
}

function pidStateFromProcStatText(text) {
  if (typeof text !== "string") return null;
  const closeParen = text.lastIndexOf(")");
  if (closeParen < 0 || closeParen + 2 >= text.length) return null;
  return text.slice(closeParen + 2).trim().split(/\s+/, 1)[0] || null;
}

function isPidZombie(pid) {
  const numeric = Number(pid);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    const state = pidStateFromProcStatText(fs.readFileSync(`/proc/${numeric}/stat`, "utf8"));
    return state === "Z";
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    if (isPidZombie(numeric)) return false;
    return true;
  } catch {
    return false;
  }
}

function backupRemove(filePath, stamp) {
  if (!fs.existsSync(filePath)) return false;
  fs.renameSync(filePath, `${filePath}.self-heal-${stamp}.bak`);
  return true;
}

function readLaneContract(laneDir) {
  return (
    safeReadJson(path.join(laneDir, "lane-contract.json")) ||
    safeReadJson(path.join(laneDir, "contract.json")) ||
    {}
  );
}

// Age-based reaping is a backstop for lanes whose PID we cannot positively
// verify as dead (e.g. after a restart, when the OS may have recycled the pid),
// and for genuinely detached/hung codex lanes. It MUST sit above the runtime's
// own per-lane timeout, or a lane that is legitimately still running gets reaped
// mid-work. Two codex-agent roles carry budgets ABOVE the 1800s default in
// codex_policy.rs — chronicle (2400s) and lab-director (up to 3000s) — so the
// flat 1800s default would age-reap a HEALTHY chronicle at ~30min even though
// the harness allows it 40min (a real cause of chronicle churn in long runs).
// We give only those long-budget roles a higher floor. We deliberately do NOT
// mirror the exact per-role Rust timeout seconds here (that would be a new
// binding to keep in sync); a single floor above the largest codex budget is
// safe and drift-free — a truly hung lane is still reaped once past the floor.
// scout is now a reasoning codex-agent that runs several network-bound
// literature probe rounds (rate-limited) plus a finalize driver call, so it
// legitimately runs for minutes; give it the same high stale floor so the
// watchdog does not reap a healthy scout mid-search.
const LONG_BUDGET_CODEX_ROLES = new Set(["chronicle", "lab-director", "scout"]);

function longBudgetStaleFloorSeconds() {
  const raw = Number(process.env.RESEARCHLAB_CODEX_AGENT_STALE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

// The ordered experiment builds its scene, demonstrations and policy arms and
// then runs every condition x seed x episode of the design. codex_policy.rs
// gives it RESEARCHLAB_SIMULATION_TIMEOUT_SECONDS (2h by default) -- the largest
// budget in the harness -- and the engineer role is not in
// LONG_BUDGET_CODEX_ROLES, so the flat floor would reap a HEALTHY one at 30
// minutes and the budget would be a number nobody could spend. Same drift the
// comment above warns about, one role further on.
function simulationLaneStaleFloorSeconds() {
  const raw = Number(process.env.RESEARCHLAB_SIMULATION_TIMEOUT_SECONDS);
  const budget = Number.isFinite(raw) && raw > 0 ? raw : 7200;
  return budget + 600;
}

function laneRunsASimulationOrder(laneDir) {
  const rolePlan = safeReadJson(path.join(laneDir, "role-plan.json"));
  if (!rolePlan) return false;
  return String(rolePlan.action_type || "") === "simulation_data_generation_followup";
}

function staleThresholdForLane({ contract, runState, defaultStaleSeconds, laneDir }) {
  const role = String(contract.role || runState.role || "");
  const runtimeClass = String(contract.runtime_class || runState.runtime_class || "");
  if (laneDir && laneRunsASimulationOrder(laneDir)) {
    return Math.max(defaultStaleSeconds, simulationLaneStaleFloorSeconds());
  }
  if (role === "scout" && runtimeClass === "external-driver") {
    return Math.max(defaultStaleSeconds, 6 * 60 * 60);
  }
  if (role === "lab-runner" && runtimeClass === "external-driver") {
    return Math.max(defaultStaleSeconds, 2 * 60 * 60);
  }
  if (runtimeClass === "codex-agent" && LONG_BUDGET_CODEX_ROLES.has(role)) {
    return Math.max(defaultStaleSeconds, longBudgetStaleFloorSeconds());
  }
  return defaultStaleSeconds;
}

function recoveryLaneExists(laneDir, laneId) {
  const parent = path.dirname(laneDir);
  const prefix = `${laneId}-recovery-`;
  try {
    return fs.readdirSync(parent).some((entry) => {
      if (!entry.startsWith(prefix)) return false;
      const recoveryDir = path.join(parent, entry);
      if (!fs.statSync(recoveryDir).isDirectory()) return false;
      return (
        fs.existsSync(path.join(recoveryDir, "final-status.json")) ||
        fs.existsSync(path.join(recoveryDir, "run-state.json")) ||
        fs.existsSync(path.join(recoveryDir, "lane-contract.json"))
      );
    });
  } catch {
    return false;
  }
}

// The agent's transcript arrives on stdout as one JSON event per line; anything
// the CLI itself has to say arrives as a bare line beside it. Only the second
// kind is the runtime speaking.
//
// MEASURED ON cycle-g-v91, 2026-09-14: in followup-scout-15, -18 and -20 every
// single match for "quota", "timeout" and "too many requests" sat INSIDE a JSON
// event -- 6, 10 and 3 of them -- and not one of those files had a bare line at
// all. The codex CLI's own schema error ("Invalid schema for response_format")
// is a bare line, so it still reaches the classifier.
function runtimeEmittedLines(filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return [];
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const windows = stat.size > maxBytes ? [0, stat.size - maxBytes] : [0];
    const lines = [];
    for (const start of windows) {
      const length = Math.min(maxBytes, stat.size - start);
      if (length <= 0) continue;
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const parts = text.split(NEWLINE);
      // A window that starts mid-file starts mid-line; drop that fragment
      // rather than classify half a line.
      if (start > 0) parts.shift();
      lines.push(...parts);
    }
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function isStructuredTranscriptLine(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function fileContainsRuntimeEmittedRetryableText(filePath) {
  for (const line of runtimeEmittedLines(filePath)) {
    if (!line.trim()) continue;
    if (isStructuredTranscriptLine(line)) continue;
    if (isRetryableText(line)) return true;
  }
  return false;
}

function healLaneDirectory({ laneDir, laneId, nowMs, staleSeconds, stamp, forceFailedRetry }) {
  const actions = [];
  const finalStatusPath = path.join(laneDir, "final-status.json");
  const runStatePath = path.join(laneDir, "run-state.json");
  const processPath = path.join(laneDir, "process.json");
  const resultPath = path.join(laneDir, "result.json");
  const stderrPath = path.join(laneDir, "stderr.log");
  const stdoutPath = path.join(laneDir, "stdout.log");
  // Written by the launcher, not by the agent: a spawn that never reached the
  // model leaves its reason here and nowhere else.
  const launcherStderrPath = path.join(laneDir, "launcher.stderr.log");
  const finalStatus = safeReadJson(finalStatusPath) || {};
  const parsedRunState = safeReadJson(runStatePath);
  const runState = parsedRunState || {};
  const processInfo = safeReadJson(processPath) || {};
  const contract = readLaneContract(laneDir);
  const resultStatus = readResultStatus(resultPath);

  // MEASURED ON cycle-a-20260919, 2026-10-04: followup-analyst-347
  // left a zero-byte run-state.json after its launcher died. Self-healing had
  // already removed process.json, so every later native supervision pass died
  // parsing the empty state while no branch here could reclaim it. An empty
  // state with no live process contains no checkpoint; back it up so the
  // surviving contract returns to the scheduler's pending shape.
  const emptyOrphanedRunState = parsedRunState === null
    && fs.existsSync(runStatePath)
    && fs.statSync(runStatePath).size === 0
    && !fs.existsSync(finalStatusPath)
    && !isPidAlive(processInfo.pid || processInfo.process_id);
  if (emptyOrphanedRunState) {
    backupRemove(runStatePath, stamp);
    backupRemove(processPath, stamp);
    actions.push({
      lane_id: laneId,
      action: "clear_empty_orphaned_run_state",
      runtime_class: contract.runtime_class || processInfo.runtime_class || null,
    });
  }

  // Older harnesses trusted CLI exit 0 even when the agent's structured output
  // reported a runtime-level block. Detect that saved false completion so the
  // fixed runtime can retry it instead of leaving the lane permanently done.
  const reportedRuntimeBlock = resultReportsRetryableRuntimeBlock(resultPath);
  const prelaunchSetupBlock = resultReportsPrelaunchSetupBlock(resultPath);
  const failed = String(finalStatus.status || resultStatus || "") === "failed"
    || reportedRuntimeBlock
    || prelaunchSetupBlock;
  // Only what the RUNTIME reported. A literature scout READS provider
  // responses, so "quota", "timeout" and "too many requests" appear in its
  // transcript as observations; stdout is still read, but only the bare lines
  // the CLI itself wrote (see fileContainsRuntimeEmittedRetryableText).
  // result.json is the agent's own output for the same reason, and the one part
  // of it the runtime vouches for is a `blocked` status, which
  // resultReportsRetryableRuntimeBlock already checks.
  //
  // MEASURED ON cycle-g-v91, 2026-09-14. followup-scout-18 finished its abstract
  // review -- reviewed-literature-result.json, abstract-reviews.json and
  // quarantine-resolution.json all written -- and the runtime recorded
  // `status: failed, failure_category: adaptive_literature_search_incomplete`,
  // which is the designed handoff, with stderr.log and launcher.stderr.log both
  // ZERO BYTES. Its transcript mentioned `quota` three times, `timeout` twice
  // and `too many requests` once, so this branch renamed result.json,
  // run-state.json and final-status.json away and returned the lane to pending
  // to do the whole review again. Four lanes lost completed work that way in one
  // hour, and the corpus stopped growing at 192 admitted papers.
  //
  // Third instance of the same hole in this repository: a FILENAME containing
  // "quota" halted cycle-g-v89 for four hours, and a minified report satisfied a
  // Windows-sandbox signature on Linux. Diagnose from what the runtime reported,
  // never from what the agent read.
  const retryableFailure = failed &&
    !recoveryLaneExists(laneDir, laneId) &&
    (forceFailedRetry ||
      isRetryableText(finalStatus) ||
      fileContainsRetryableText(stderrPath) ||
      fileContainsRetryableText(launcherStderrPath) ||
      fileContainsRuntimeEmittedRetryableText(stdoutPath) ||
      reportedRuntimeBlock ||
      prelaunchSetupBlock);
  if (retryableFailure) {
    backupRemove(finalStatusPath, stamp);
    backupRemove(runStatePath, stamp);
    backupRemove(resultPath, stamp);
    actions.push({
      lane_id: laneId,
      action: "reset_failed_lane",
      reason: reportedRuntimeBlock
        ? "model_reported_runtime_block"
        : prelaunchSetupBlock ? "resolved_prelaunch_setup_block" : null,
      runtime_class: contract.runtime_class || null,
    });
  }

  if (String(runState.status || "") === "running") {
    const pid = runState.pid || runState.process_id || processInfo.pid || processInfo.process_id;
    const updatedAt = Date.parse(
      runState.updated_at ||
      processInfo.updated_at ||
      processInfo.started_at ||
      runState.started_at ||
      "",
    );
    const ageSeconds = Number.isFinite(updatedAt) ? Math.max(0, Math.floor((nowMs - updatedAt) / 1000)) : null;
    const laneStaleSeconds = staleThresholdForLane({ contract, runState, defaultStaleSeconds: Number(staleSeconds) || 1800, laneDir });
    const pidDead = !isPidAlive(pid);
    const exceededBudget = ageSeconds !== null && ageSeconds > laneStaleSeconds;
    if (pidDead || exceededBudget) {
      backupRemove(runStatePath, stamp);
      backupRemove(processPath, stamp);
      // Clearing run-state.json returns the lane to a pending shape (its
      // contract + role-plan survive), so the supervisor re-dispatches it on
      // the next pass — i.e. the orphaned in-flight lane is reclaimed, not left
      // wedged as perpetually "running".
      actions.push({
        lane_id: laneId,
        action: "clear_stale_running_state",
        reason: pidDead ? "dead_pid" : "exceeded_stale_budget",
        pid: pid || null,
        age_seconds: ageSeconds,
        stale_seconds: laneStaleSeconds,
        runtime_class: contract.runtime_class || runState.runtime_class || null,
      });
    }
  } else if (!emptyOrphanedRunState && fs.existsSync(processPath)) {
    const pid = processInfo.pid || processInfo.process_id;
    if (pid && !isPidAlive(pid)) {
      backupRemove(processPath, stamp);
      actions.push({
        lane_id: laneId,
        action: "clear_stale_process_metadata",
        pid,
        runtime_class: contract.runtime_class || processInfo.runtime_class || null,
      });
    }
  }
  return actions;
}

function healCycleOnce({ cwd, cycleId, error = null, staleSeconds = 1800, forceFailedRetry = false }) {
  const actions = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const existingSetupPause = readWindowsSetupPause({ cwd, cycleId });
  if (existingSetupPause) {
    const preserved = [{
      action: WINDOWS_SETUP_BLOCK_ACTION,
      reason: "existing_windows_sandbox_setup_pause",
      pause_marker_path: cyclePauseMarkerPath({ cwd, cycleId }),
      manual_resume_required: true,
    }];
    appendCycleEvent({
      cwd,
      cycleId,
      eventType: "cycle_self_heal_blocked",
      payload: { error_preview: error ? textOf(error).slice(0, 2000) : null, actions: preserved },
    });
    return preserved;
  }

  const quotaPause = readProviderQuotaPause({ cwd, cycleId });
  if (quotaPause) {
    const preserved = [{
      action: PROVIDER_QUOTA_BLOCK_ACTION,
      reason: "provider_quota_exhausted",
      pause_marker_path: cyclePauseMarkerPath({ cwd, cycleId }),
      retry_after_hint: quotaPause.retry_after_hint || null,
      manual_resume_required: true,
    }];
    appendCycleEvent({
      cwd,
      cycleId,
      eventType: "cycle_self_heal_blocked",
      payload: { error_preview: error ? textOf(error).slice(0, 2000) : null, actions: preserved },
    });
    return preserved;
  }

  const lanesRoot = path.join(cwd, ".research-lab", "lanes", cycleId);
  // Setup-helper cancellation is a cycle-wide environment block. Detect it
  // before resetting or reaping any lane so every failure/checkpoint remains
  // available and no unrelated pending work is made runnable by this heal.
  const setupBlock = findCycleWindowsSetupBlock({ cwd, cycleId, error });
  if (setupBlock) {
    const pause = writeWindowsSetupPause({ cwd, cycleId, evidence: setupBlock.evidence });
    const blocked = [{
      lane_id: setupBlock.lane_id,
      action: WINDOWS_SETUP_BLOCK_ACTION,
      reason: "windows_sandbox_setup_canceled_or_incomplete",
      source: setupBlock.source,
      pause_marker_path: pause.markerPath,
      manual_resume_required: true,
    }];
    appendCycleEvent({
      cwd,
      cycleId,
      eventType: "cycle_self_heal_blocked",
      payload: { error_preview: error ? textOf(error).slice(0, 2000) : null, actions: blocked },
    });
    return blocked;
  }

  if (fs.existsSync(lanesRoot)) {
    for (const laneId of fs.readdirSync(lanesRoot)) {
      const laneDir = path.join(lanesRoot, laneId);
      if (!fs.statSync(laneDir).isDirectory()) continue;
      actions.push(...healLaneDirectory({ laneDir, laneId, nowMs: Date.now(), staleSeconds, stamp, forceFailedRetry }));
    }
  }

  clearTerminationCode({ cwd, cycleId });
  actions.push({ action: "clear_termination_code" });

  if (/Cargo\.toml|native command failed|No such file|not found|binary|build/i.test(textOf(error))) {
    const build = spawnSync(process.execPath, [path.join(cwd, "scripts", "build-native.mjs")], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    actions.push({
      action: "rebuild_native",
      status: build.status,
      stderr_preview: (build.stderr || "").slice(0, 1200),
    });
  }

  appendCycleEvent({
    cwd,
    cycleId,
    eventType: "cycle_self_heal_attempt",
    payload: {
      error_preview: error ? textOf(error).slice(0, 2000) : null,
      actions,
    },
  });
  return actions;
}

function hasRetryableCycleFailures({ cwd, cycleId }) {
  if (readWindowsSetupPause({ cwd, cycleId })) return false;
  // Nothing behind an exhausted quota is retryable, whatever the lane's own
  // error text says. On 2026-09-24 the quota lane's transcript read "usage
  // limit ... try again at Sep 28th", which isRetryableText matches on "limit"
  // and "quota" -- so every heal pass called it retryable and reset it.
  if (readProviderQuotaPause({ cwd, cycleId })) return false;
  if (findCycleWindowsSetupBlock({ cwd, cycleId })) return true;
  const lanesRoot = path.join(cwd, ".research-lab", "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return false;
  for (const laneId of fs.readdirSync(lanesRoot)) {
    const laneDir = path.join(lanesRoot, laneId);
    if (!fs.statSync(laneDir).isDirectory()) continue;
    const finalStatus = safeReadJson(path.join(laneDir, "final-status.json")) || {};
    const resultPath = path.join(laneDir, "result.json");
    const resultStatus = readResultStatus(resultPath);
    const reportedRuntimeBlock = resultReportsRetryableRuntimeBlock(resultPath);
    if ((String(finalStatus.status || resultStatus || "") === "failed" || reportedRuntimeBlock) &&
        (reportedRuntimeBlock || isRetryableText(finalStatus) || fileContainsRetryableText(resultPath))) {
      return true;
    }
  }
  return false;
}

module.exports = {
  actionsContainCycleRuntimeBlock,
  healCycleOnce,
  hasRetryableCycleFailures,
  isWindowsSetupBlock,
  isRetryableText,
  readCycleRuntimeSetupBlock,
  __private: {
    pidStateFromProcStatText,
    resultReportsRetryableRuntimeBlock,
  },
};
