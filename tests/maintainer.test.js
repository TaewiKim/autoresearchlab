"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const { readCodexLoginRequired } = require("../src/orchestrator/codex_login");
const {
  maintainAfterAbort,
  maybeRunMaintainer,
  maintainerConfig,
  recoverInterruptedRun,
  __private,
} = require("../src/orchestrator/maintainer");

const CYCLE = "maint-cycle";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// A repository whose package lives in a subdirectory, as this one does
// (researchlab/ inside the git top level), with the kind of state the real
// tree has: an untracked file a lane left behind and an uncommitted edit.
function makeFixture({ branch = "fix/plumbing" } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "rl-maintainer-"));
  const cwd = path.join(top, "pkg");
  git(top, ["init", "-q", "-b", branch]);
  git(top, ["config", "user.name", "Maintainer Test"]);
  git(top, ["config", "user.email", "maintainer@example.invalid"]);
  git(top, ["config", "core.autocrlf", "false"]);
  git(top, ["config", "commit.gpgsign", "false"]);
  write(path.join(cwd, ".gitignore"), ".research-lab\n");
  write(path.join(cwd, "src", "lib.js"), "\"use strict\";\nmodule.exports = { answer: () => 41 };\n");
  write(path.join(cwd, "tests", "lib.test.js"), "const test = require(\"node:test\");\ntest(\"answer\", () => {});\n");
  write(path.join(cwd, "README.md"), "# pkg\n");
  write(path.join(cwd, "package.json"), "{\"name\":\"pkg\"}\n");
  git(top, ["add", "-A"]);
  git(top, ["commit", "-q", "-m", "initial"]);
  // Pre-existing dirt the maintainer must neither commit nor disturb.
  write(path.join(cwd, "lane_scratch.py"), "print('left by a lane')\n");
  write(path.join(cwd, "README.md"), "# pkg\n\nan uncommitted edit\n");
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  return { top, cwd };
}

function writePause(cwd, marker = {}) {
  const markerPath = path.join(cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`);
  writeJson(markerPath, {
    cycle_id: CYCLE,
    status: "blocked",
    block_type: "windows_sandbox_setup",
    manual_resume_required: true,
    reason: "Windows sandbox setup helper was canceled or incomplete",
    source: "native-codex-watchdog",
    phase: "running",
    lane_id: "followup-analyst-24",
    evidence: "tool execution setup installation incomplete",
    blocked_at: "2026-09-18T12:00:00Z",
    ...marker,
  });
  writeJson(path.join(cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`), {
    cycle_id: CYCLE,
    code: "RUNTIME_SETUP_BLOCKED",
    category: "runtime_environment",
    reason: marker.reason || "Windows sandbox setup helper was canceled or incomplete",
    should_stop: true,
    metadata: { block_type: marker.block_type || "windows_sandbox_setup" },
  });
  return markerPath;
}

function writeLane(cwd, laneId, { role = "scout", status = "failed", category = "some_failure", error = null, completedAt } = {}) {
  const dir = path.join(cwd, ".research-lab", "lanes", CYCLE, laneId);
  writeJson(path.join(dir, "lane-contract.json"), { lane_id: laneId, role, runtime_class: "codex-agent" });
  writeJson(path.join(dir, "final-status.json"), {
    lane_id: laneId,
    status,
    failure_category: category,
    ...(error ? { error } : {}),
    completed_at: completedAt || new Date().toISOString(),
  });
  writeJson(path.join(dir, "result.json"), { status, failure_category: category, stderr: "" });
  return dir;
}

// A stand-in for `codex exec`: applies the edits a scenario file describes to
// the --cd directory and writes the scenario's verdict as the last message.
const FAKE_CODEX = `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
try { fs.readFileSync(0); } catch {}
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_MAINTAINER_SCENARIO, "utf8"));
const root = at("--cd");
fs.appendFileSync(process.env.FAKE_MAINTAINER_SCENARIO + ".calls", JSON.stringify(args) + "\\n");
for (const [rel, content] of Object.entries(scenario.writes || {})) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
for (const rel of scenario.deletes || []) fs.rmSync(path.join(root, rel), { force: true });
// Another agent writing the main tree while the maintainer runs.
for (const [absolute, content] of Object.entries(scenario.external_writes || {})) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
// A person committing on the branch while the maintainer runs.
for (const commit of scenario.external_commits || []) {
  const target = path.join(commit.top, ...commit.path.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, commit.content);
  for (const gitArgs of [["add", "--", commit.path], ["commit", "-q", "-m", commit.message, "--", commit.path]]) {
    const result = require("child_process").spawnSync("git", gitArgs, { cwd: commit.top, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}
if (scenario.probe_main) {
  fs.writeFileSync(process.env.FAKE_MAINTAINER_SCENARIO + ".probe", fs.readFileSync(scenario.probe_main));
}
if (scenario.verdict) fs.writeFileSync(at("--output-last-message"), JSON.stringify(scenario.verdict));
if (scenario.stdout) process.stdout.write(scenario.stdout);
if (scenario.exit_code) process.exit(scenario.exit_code);
`;

function fakeCodexEnv(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-fake-codex-"));
  const command = path.join(dir, "codex.js");
  fs.writeFileSync(command, FAKE_CODEX, "utf8");
  const scenarioPath = path.join(dir, "scenario.json");
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  return {
    scenarioPath,
    env: {
      ...process.env,
      RESEARCHLAB_MAINTAINER: "1",
      // The fake runs on the host; a launcher's scout image must not move it.
      RESEARCHLAB_MAINTAINER_VENUE: "host",
      RESEARCHLAB_MAINTAINER_CODEX_CMD: command,
      FAKE_MAINTAINER_SCENARIO: scenarioPath,
    },
  };
}

function verdict(overrides = {}) {
  return {
    verdict: "harness_bug_fixed",
    summary: "The watchdog read a log tail that began mid-line.",
    root_cause: "A partial first line lost its event prefix.",
    files_changed: ["src/lib.js"],
    tests_added: ["tests/lib.test.js"],
    clears_pause: true,
    commit_title: "A log tail cut mid-line no longer pauses the cycle",
    ...overrides,
  };
}

const GOOD_FIX = {
  "src/lib.js": "\"use strict\";\nmodule.exports = { answer: () => 42 };\n",
  "tests/lib.test.js": "const test = require(\"node:test\");\ntest(\"answer\", () => {});\n// MEASURED ON maint-cycle\ntest(\"answer is 42\", () => {});\n",
};

function passingSuites() {
  const calls = [];
  return {
    calls,
    runTestSuite: (suite, { only }) => {
      calls.push({ suite, only });
      return { status: "passed", failures: [] };
    },
  };
}

function treeFingerprint(repoTop) {
  const status = git(repoTop, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = {};
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const rel = line.slice(3);
    const absolute = path.join(repoTop, rel);
    files[rel] = fs.existsSync(absolute)
      ? crypto.createHash("sha1").update(fs.readFileSync(absolute)).digest("hex")
      : null;
  }
  for (const rel of ["pkg/src/lib.js", "pkg/tests/lib.test.js"]) {
    files[rel] = crypto.createHash("sha1").update(fs.readFileSync(path.join(repoTop, rel))).digest("hex");
  }
  return { status, files, head: git(repoTop, ["rev-parse", "HEAD"]).trim() };
}

function run(fixture, scenario, deps = {}, extraEnv = {}) {
  const fake = fakeCodexEnv(scenario);
  const outcome = maybeRunMaintainer({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    env: { ...fake.env, ...extraEnv },
    deps: {
      runTestSuite: passingSuites().runTestSuite,
      buildRelease: () => ({ ok: true }),
      healCycleOnce: () => [{ action: "clear_termination_code" }],
      ...deps,
    },
  });
  const callsPath = `${fake.scenarioPath}.calls`;
  const codexCalls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const probePath = `${fake.scenarioPath}.probe`;
  const probe = fs.existsSync(probePath) ? fs.readFileSync(probePath, "utf8") : null;
  return { outcome, codexCalls, probe };
}

function cycleWorktreesDir(fixture) {
  return path.join(fixture.top, ".maintainer-worktrees", CYCLE);
}

// No maintainer worktree is left, on disk or registered with git.
function assertNoWorktreesLeft(fixture) {
  const listed = git(fixture.top, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "));
  assert.equal(listed.length, 1, `only the main worktree remains: ${listed.join(", ")}`);
  const dir = cycleWorktreesDir(fixture);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
}

// ---------------------------------------------------------------------------
// triggers

test("maintainer is off unless RESEARCHLAB_MAINTAINER=1", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const outcome = maybeRunMaintainer({ cwd: fixture.cwd, cycleId: CYCLE, env: { ...process.env, RESEARCHLAB_MAINTAINER: "" } });
  assert.equal(outcome, null);
  assert.equal(fs.existsSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE })), false);
});

test("a plumbing pause triggers, and its stop code is folded into it", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const triggers = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: { lane_watermark: new Date().toISOString() } });
  assert.deepEqual(triggers.map((item) => item.kind), ["pause"]);
  assert.match(triggers[0].signature, /^pause:windows_sandbox_setup:running:/);
  assert.deepEqual(triggers[0].lane_ids, ["followup-analyst-24"]);
});

test("a native exception triggers; with a pause standing, the pause is diagnosed first", () => {
  const fixture = makeFixture();
  const error = new Error("thread 'main' panicked at src/labdirector/plan/run_loop.rs:288:9\nnative command failed: run-plan");
  const alone = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, error, state: {} });
  assert.deepEqual(alone.map((item) => item.kind), ["native_exception"]);
  // Line numbers and paths differ between two hits of the same panic.
  const other = new Error("thread 'main' panicked at src/labdirector/plan/run_loop.rs:301:13\nnative command failed: run-plan");
  assert.equal(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, error: other, state: {} })[0].signature, alone[0].signature);

  writePause(fixture.cwd);
  const both = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, error, state: {} });
  assert.deepEqual(both.map((item) => item.kind), ["pause", "native_exception"]);
});

test("a provider-quota pause and a researcher /pause are waits, not plumbing", () => {
  const quota = makeFixture();
  writePause(quota.cwd, { block_type: "provider_quota", reason: "Codex usage limit reached" });
  writeJson(path.join(quota.cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`), {
    code: "PROVIDER_QUOTA_EXHAUSTED", category: "provider_quota", should_stop: true,
  });
  assert.deepEqual(__private.detectTriggers({ cwd: quota.cwd, cycleId: CYCLE, state: {} }), []);

  const researcher = makeFixture();
  writeJson(path.join(researcher.cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`), {
    cycle_id: CYCLE, paused_at: "2026-09-18T00:00:00Z", reason: "lunch", source: "researcher",
  });
  assert.deepEqual(__private.detectTriggers({ cwd: researcher.cwd, cycleId: CYCLE, state: {} }), []);
});

test("an owner-selection pause waits for the owner and is never diagnosed as plumbing", () => {
  // labdirector::problem_selection pauses lead selection on the owner's pick of
  // the expert-selected candidates. It writes no stop code: run-plan waits and
  // lifts the pause itself once <cycle>-owner-selection.json appears.
  const fixture = makeFixture();
  writeJson(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`), {
    cycle_id: CYCLE,
    status: "blocked",
    block_type: "owner_selection",
    manual_resume_required: false,
    reason: "Lead selection is waiting for the owner to choose among the expert-selected candidates",
    source: "expert-selection",
    paused_at: "2026-09-19T12:00:00Z",
  });
  assert.deepEqual(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: {} }), []);
  // The same marker with any other block type is still plumbing.
  writePause(fixture.cwd, { block_type: "some_new_block" });
  assert.deepEqual(
    __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: {} }).map((item) => item.kind),
    ["pause"],
  );
});

test("a harness stop triggers; approval and scientific stops do not", () => {
  const fixture = makeFixture();
  const terminationPath = path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`);
  writeJson(terminationPath, {
    code: "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK",
    category: "continuation_impossible",
    reason: "no running or pending lanes remain",
    should_stop: true,
    metadata: { lane_failure_diagnostics: [{ lane_id: "followup-engineer-01" }] },
  });
  const triggers = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: {} });
  assert.deepEqual(triggers.map((item) => item.kind), ["termination"]);
  assert.deepEqual(triggers[0].lane_ids, ["followup-engineer-01"]);

  writeJson(terminationPath, { code: "APPROVAL_GATE_PASSED", category: "gate_passed", should_stop: true });
  assert.deepEqual(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: {} }), []);
});

test("three lanes failing the same way since the watermark trigger; two, or older ones, do not", () => {
  const fixture = makeFixture();
  const watermark = "2026-09-18T10:00:00Z";
  for (const id of ["followup-scout-01", "followup-scout-02"]) {
    writeLane(fixture.cwd, id, { category: "adaptive_literature_search_incomplete", error: "search driver exited 1", completedAt: "2026-09-18T11:00:00Z" });
  }
  // Before the maintainer was switched on: history.
  writeLane(fixture.cwd, "followup-scout-00", { category: "adaptive_literature_search_incomplete", error: "search driver exited 1", completedAt: "2026-09-18T09:00:00Z" });
  // Same role, different failure: its own group.
  writeLane(fixture.cwd, "followup-scout-05", { category: "literature_retrieval_throttled", error: "search driver exited 1", completedAt: "2026-09-18T11:00:00Z" });
  assert.deepEqual(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: { lane_watermark: watermark } }), []);

  writeLane(fixture.cwd, "followup-scout-03", { category: "adaptive_literature_search_incomplete", error: "search driver exited 1", completedAt: "2026-09-18T11:30:00Z" });
  const triggers = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: { lane_watermark: watermark } });
  assert.deepEqual(triggers.map((item) => item.kind), ["repeated_failure"]);
  assert.match(triggers[0].signature, /^repeated_failure:scout\|adaptive_literature_search_incomplete\|/);
  assert.deepEqual(triggers[0].lane_ids.sort(), ["followup-scout-01", "followup-scout-02", "followup-scout-03"]);
});

test("runners that finish completed with the same execution error are a clog", () => {
  const fixture = makeFixture();
  // MEASURED ON cycle-b-20260918, 2026-09-19: followup-runner-70..76
  // finished `completed`, each with this error in its execution report.
  const error = "ValueError: handoff check requires a non-empty column_mapping";
  const runner = (id, executionError) => {
    const dir = writeLane(fixture.cwd, id, { role: "lab-runner", status: "completed", category: null, completedAt: "2026-09-19T00:30:00Z" });
    writeJson(path.join(dir, "result.json"), {
      status: "completed",
      blueprint_executions: [{ blueprint_id: "CHK-01", error: executionError, pip_install: { error: null } }],
      analysis_trace: { blueprints: [{ error: executionError }] },
    });
  };
  runner("followup-runner-70", error);
  runner("followup-runner-71", error);
  const state = { lane_watermark: "2026-09-18T17:00:00Z" };
  assert.deepEqual(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state }), []);

  runner("followup-runner-72", error);
  // A clean completion is not part of it.
  runner("followup-runner-73", null);
  const triggers = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state });
  assert.deepEqual(triggers.map((item) => item.kind), ["repeated_failure"]);
  assert.match(triggers[0].signature, /^repeated_failure:lab-runner\|completed_with_execution_error\|/);
  assert.deepEqual(triggers[0].lane_ids.sort(), ["followup-runner-70", "followup-runner-71", "followup-runner-72"]);
});

test("a later evidence-producing runner retires an old execution-error cluster", () => {
  const fixture = makeFixture();
  // MEASURED ON cycle-a-20260919, 2026-09-30: runners 67-70 kept
  // triggering after the dataset-routing fix and many later successful runs.
  const error = "ValueError: required manifest or sidecar missing beside the wrong episodes.csv";
  for (const id of ["followup-runner-67", "followup-runner-68", "followup-runner-69", "followup-runner-70"]) {
    const dir = writeLane(fixture.cwd, id, {
      role: "lab-runner",
      status: "completed",
      category: null,
      completedAt: "2026-09-29T07:57:41Z",
    });
    writeJson(path.join(dir, "result.json"), {
      status: "failed",
      blueprint_executions: [{ check_id: "coverage-decay-axis-equivalence-v5", status: "failed", error }],
    });
  }
  const recovered = writeLane(fixture.cwd, "followup-runner-79", {
    role: "lab-runner",
    status: "completed",
    category: null,
    completedAt: "2026-09-29T08:22:19Z",
  });
  writeJson(path.join(recovered, "result.json"), {
    status: "completed",
    blueprint_executions: [{ check_id: "topology_interaction_joint_max_t_v1", status: "completed", error: null }],
  });

  const triggers = __private.detectTriggers({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    state: { lane_watermark: "2026-09-18T17:00:00Z" },
  });

  assert.deepEqual(triggers, []);
});

test("literature review handoffs without a runtime error are not repeated failures", () => {
  const fixture = makeFixture();
  const category = "literature_abstract_review_required";
  // MEASURED ON cycle-b-20260918, 2026-09-18: lanes 69, 72 and 79
  // were pending_review handoffs with no runtime-reported error.
  for (const id of ["followup-scout-69", "followup-scout-72", "followup-scout-79"]) {
    const dir = writeLane(fixture.cwd, id, { category, completedAt: "2026-09-18T19:37:44Z" });
    writeJson(path.join(dir, "result.json"), { status: "pending_review", failure_category: category, degraded: true });
  }

  const triggers = __private.detectTriggers({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    state: { lane_watermark: "2026-09-18T17:00:00Z" },
  });
  assert.deepEqual(triggers, []);
});

test("successful scout telemetry is not a repeated runtime failure", () => {
  const fixture = makeFixture();
  // MEASURED ON cycle-a-20260919, 2026-09-20. Four scouts that
  // returned 0 without timing out or stalling produced error hash 17e62842b617.
  for (const id of ["scout-02", "scout-03", "followup-scout-32", "followup-scout-33"]) {
    const dir = writeLane(fixture.cwd, id, {
      category: "literature_retrieval_throttled",
      completedAt: "2026-09-20T03:11:51Z",
    });
    writeJson(path.join(dir, "result.json"), {
      status: "insufficient_corpus",
      failure_category: "literature_retrieval_throttled",
      returncode: 0,
      timed_out: false,
      stalled_stream: false,
      stderr: "",
    });
  }

  const triggers = __private.detectTriggers({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    state: { lane_watermark: "2026-09-19T00:00:00Z" },
  });
  assert.deepEqual(triggers, []);
});

test("a recovered scout tool rejection on a clean exit is not a repeated runtime failure", () => {
  const fixture = makeFixture();
  // MEASURED ON cycle-a-20260919, 2026-10-17: followup-scout-314,
  // -461, and -514 returned 0 without timing out or stalling after recovering
  // from the same apply_patch rejection retained in result.stderr. Their
  // literature assessments differed, so that diagnostic was not their cause.
  for (const id of ["followup-scout-314", "followup-scout-461", "followup-scout-514"]) {
    const dir = writeLane(fixture.cwd, id, {
      category: "adaptive_literature_search_incomplete",
      completedAt: "2026-10-16T23:33:53Z",
    });
    writeJson(path.join(dir, "result.json"), {
      status: "insufficient_corpus",
      failure_category: "adaptive_literature_search_incomplete",
      returncode: 0,
      timed_out: false,
      stalled_stream: false,
      stderr: "apply_patch verification failed: invalid patch: multiple operations target search-agent-journal.json",
    });
  }

  const triggers = __private.detectTriggers({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    state: { lane_watermark: "2026-10-16T00:00:00Z" },
  });
  assert.deepEqual(triggers, []);
});

test("a recovery lane that failed on an infrastructure signature with no further recovery triggers", () => {
  const fixture = makeFixture();
  writeLane(fixture.cwd, "followup-gatekeeper-11", { role: "gatekeeper", completedAt: "2026-09-18T11:00:00Z" });
  writeLane(fixture.cwd, "followup-gatekeeper-11-recovery-01", {
    role: "gatekeeper",
    completedAt: "2026-09-18T11:10:00Z",
    error: "thread 'main' panicked at src/labdirector/plan/run_loop.rs:288",
  });
  const triggers = __private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: { lane_watermark: "2026-09-18T10:00:00Z" } });
  assert.deepEqual(triggers.map((item) => item.kind), ["recovery_exhausted"]);
  assert.equal(triggers[0].signature, "recovery_exhausted:gatekeeper:runtime-panic");
});

test("an agent's prose about schemas is not an infrastructure signature; the runtime's error is", () => {
  const fixture = makeFixture();
  const dir = writeLane(fixture.cwd, "followup-scout-07-recovery-01", { completedAt: "2026-09-18T11:10:00Z" });
  writeJson(path.join(dir, "result.json"), {
    status: "failed",
    output_last_message: "The schema lists additionalProperties false; thread 'x' panicked in the paper's code",
  });
  assert.deepEqual(__private.detectTriggers({ cwd: fixture.cwd, cycleId: CYCLE, state: { lane_watermark: "2026-09-18T10:00:00Z" } }), []);
  assert.equal(__private.infrastructureBugSignature("invalid_json_schema: additionalProperties must be false"), "schema-contract-error");
});

test("one attempt per signature and a per-week run cap", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const notABug = { verdict: verdict({ verdict: "environment_block", clears_pause: false }) };
  const first = run(fixture, notABug, {}, { RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "1" });
  assert.equal(first.outcome.outcome, "no_fix");
  assert.equal(first.codexCalls.length, 1);

  const again = run(fixture, notABug, {}, { RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "1" });
  assert.equal(again.outcome, null, "the same pause is not diagnosed twice");
  assert.equal(again.codexCalls.length, 0);

  // A different blocker, but the cycle's budget is spent.
  writePause(fixture.cwd, { evidence: "a different setup failure", phase: "prelaunch" });
  const capped = run(fixture, notABug, {}, { RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "1" });
  assert.equal(capped.codexCalls.length, 0);
  // MEASURED ON cycle-a-20260919, 2026-09-21: a spent cap dropped an
  // open blocker with one log line and the cycle kept burning lanes on it.
  assert.equal(capped.outcome.outcome, "supervisor_cap_reached");
  assert.match(capped.outcome.reason, /no attempts left/);
  const stop = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`), "utf8"));
  assert.equal(stop.code, "SUPERVISOR_RUNS_EXHAUSTED");
  assert.equal(stop.should_stop, true);
  const capMarker = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`), "utf8"));
  assert.equal(capMarker.block_type, "supervisor_cap_reached");
  // The supervisor never diagnoses its own stop as plumbing: another pass sees
  // the cap marker and raises no pause trigger from it.
  const afterStop = run(fixture, notABug, {}, { RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "1" });
  assert.equal(afterStop.codexCalls.length, 0);
  const state = JSON.parse(fs.readFileSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), "utf8"));
  assert.equal(state.runs.length, 1);
  assert.equal(state.cap_reached_logged, true);
  // A run does not move the watermark past groups it did not handle.
  assert.ok(Date.parse(state.lane_watermark) <= Date.parse(state.runs[0].started_at));
  assert.ok(fs.existsSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`)), "pause stays");
});

// ---------------------------------------------------------------------------
// codex invocation

test("codex runs once in its own worktree, workspace-write, no network, sol at high effort", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const { codexCalls, outcome } = run(fixture, { verdict: verdict({ verdict: "not_a_harness_bug", clears_pause: false }) });
  assert.equal(outcome.outcome, "no_fix");
  assert.equal(codexCalls.length, 1);
  const args = codexCalls[0];
  for (const expected of [
    ["--sandbox", "workspace-write"],
    ["--model", "gpt-5.6-sol"],
    ["--cd", path.join(cycleWorktreesDir(fixture), outcome.run_id, "pkg")],
  ]) {
    assert.equal(path.resolve(args[args.indexOf(expected[0]) + 1]), path.resolve(expected[1]));
  }
  assertNoWorktreesLeft(fixture);
  assert.ok(args.includes("exec") && args.includes("--json") && args.includes("--ephemeral"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("--output-schema"));
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  const evidence = JSON.parse(fs.readFileSync(path.join(runDir, "evidence.json"), "utf8"));
  assert.equal(evidence.primary_trigger.kind, "pause");
  assert.equal(evidence.pause_marker.marker.block_type, "windows_sandbox_setup");
  assert.equal(evidence.termination_code.code.code, "RUNTIME_SETUP_BLOCKED");
  assert.ok(evidence.git_log.some((line) => /initial/.test(line)));
  assert.ok(fs.existsSync(path.join(runDir, "report.json")));
  const events = fs.readFileSync(path.join(fixture.cwd, ".research-lab", "events", `${CYCLE}-maintainer.jsonl`), "utf8");
  assert.match(events, /maintainer_triggered/);
  assert.match(events, /maintainer_run_finished/);
});

// ---------------------------------------------------------------------------
// the gate

function assertRejectedAndRestored(fixture, scenario, pattern, deps = {}) {
  writePause(fixture.cwd);
  const before = treeFingerprint(fixture.top);
  const { outcome } = run(fixture, scenario, deps);
  assert.equal(outcome.outcome, "rejected", JSON.stringify(outcome));
  assert.match(outcome.reason, pattern);
  assert.deepEqual(treeFingerprint(fixture.top), before, "the tree is exactly as the agent found it");
  assert.ok(fs.existsSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-labdirector-pause.json`)), "pause stays");
  assert.ok(fs.existsSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`)), "stop stays");
  assertNoWorktreesLeft(fixture);
  return outcome;
}

test("gate rejects a change outside the allow-list and restores the tree", () => {
  const fixture = makeFixture();
  assertRejectedAndRestored(fixture, {
    writes: { ...GOOD_FIX, "package.json": "{\"name\":\"pkg\",\"version\":\"2\"}\n", "notes/debug.txt": "scratch\n" },
    verdict: verdict(),
  }, /outside the maintainer's allow-list: pkg\/(?:notes\/debug\.txt|package\.json)/);
  assert.equal(fs.existsSync(path.join(fixture.cwd, "notes")), false, "the directory the agent created is gone too");
});

test("gate rejects a fix without a regression test", () => {
  const fixture = makeFixture();
  assertRejectedAndRestored(fixture, {
    writes: { "src/lib.js": GOOD_FIX["src/lib.js"] },
    verdict: verdict(),
  }, /no regression test was added/);
});

test("gate rejects a change that removes or skips a test, even with a new one elsewhere", () => {
  const fixture = makeFixture();
  assertRejectedAndRestored(fixture, {
    writes: {
      ...GOOD_FIX,
      "tests/lib.test.js": "const test = require(\"node:test\");\n",
      "tests/other.test.js": "const test = require(\"node:test\");\ntest(\"a\", () => {});\ntest(\"b\", () => {});\n",
    },
    verdict: verdict(),
  }, /test count fell in pkg\/tests\/lib\.test\.js/);

  const skipped = makeFixture();
  assertRejectedAndRestored(skipped, {
    writes: {
      ...GOOD_FIX,
      "tests/lib.test.js": "const test = require(\"node:test\");\ntest.skip(\"answer\", () => {});\ntest(\"answer\", () => {});\ntest(\"new\", () => {});\n",
    },
    verdict: verdict(),
  }, /skipped or ignored/);
});

test("a file the agent writes at a path another writer left untracked is its own, and rejected by the allow-list", () => {
  const fixture = makeFixture();
  // lane_scratch.py is untracked in the main tree and absent from the
  // worktree; the agent's file there is new, and nothing touches the lane's.
  assertRejectedAndRestored(fixture, {
    writes: { ...GOOD_FIX, "lane_scratch.py": "print('rewritten')\n" },
    verdict: verdict(),
  }, /outside the maintainer's allow-list: pkg\/lane_scratch\.py/);
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "lane_scratch.py"), "utf8"), "print('left by a lane')\n");
});

test("accept is refused when the main tree has local edits in a path the fix touches", () => {
  const fixture = makeFixture();
  const localEdit = "\"use strict\";\nmodule.exports = { answer: () => 40 }; // someone else's work\n";
  write(path.join(fixture.cwd, "src", "lib.js"), localEdit);
  const suites = passingSuites();
  const outcome = assertRejectedAndRestored(
    fixture,
    { writes: GOOD_FIX, verdict: verdict() },
    /^main tree has local changes in pkg\/src\/lib\.js$/,
    { runTestSuite: suites.runTestSuite },
  );
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8"), localEdit);
  assert.deepEqual(suites.calls, [], "refused before an hour of suites");
  // The candidate is kept as a patch.
  const patch = fs.readFileSync(path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id, "candidate.patch"), "utf8");
  assert.match(patch, /answer: \(\) => 42/);
});

test("accept is refused when another writer edits a touched path while the gate runs", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const concurrent = "\"use strict\";\n// written by another agent during the gate\n";
  const { outcome } = run(fixture, { writes: GOOD_FIX, verdict: verdict() }, {
    runTestSuite: (suite) => {
      if (suite === "pytest") write(path.join(fixture.cwd, "src", "lib.js"), concurrent);
      return { status: "passed", failures: [] };
    },
  });
  assert.equal(outcome.outcome, "rejected", JSON.stringify(outcome));
  assert.equal(outcome.reason, "main tree has local changes in pkg/src/lib.js");
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8"), concurrent);
  assert.equal(git(fixture.top, ["log", "-1", "--format=%s"]).trim(), "initial");
  assertNoWorktreesLeft(fixture);
});

test("gate rejects a new failing test and keeps failures that also fail at HEAD as baseline", () => {
  const fixture = makeFixture();
  const seen = [];
  const newFailure = (suite, { only, cwd }) => {
    // Both runs are in worktrees: the candidate's, then a clean one of HEAD.
    assert.ok(path.resolve(cwd).startsWith(path.resolve(cycleWorktreesDir(fixture))), cwd);
    const candidate = fs.readFileSync(path.join(cwd, "src", "lib.js"), "utf8").includes("42");
    seen.push({ suite, only, candidate, cwd });
    if (suite !== "node") return { status: "passed", failures: [] };
    // With the change: the new test fails, and so does an old flaky one.
    if (candidate) return { status: "failed", failures: ["tests/lib.test.js::answer is 42", "tests/old.test.js::flaky"] };
    // At HEAD, only the old one fails.
    return { status: "failed", failures: only.filter((id) => id.endsWith("flaky")) };
  };
  const outcome = assertRejectedAndRestored(fixture, { writes: GOOD_FIX, verdict: verdict() }, /new test failures: node: tests\/lib\.test\.js::answer is 42/, { runTestSuite: newFailure });
  const baselineRun = seen.find((call) => call.suite === "node" && !call.candidate);
  assert.deepEqual(baselineRun.only, ["tests/lib.test.js::answer is 42", "tests/old.test.js::flaky"]);
  assert.match(baselineRun.cwd, /-base[\\/]pkg$/);
  const report = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id, "test-report.json"), "utf8"));
  const node = report.suites.find((entry) => entry.suite === "node");
  assert.deepEqual(node.baseline_failures, ["tests/old.test.js::flaky"]);
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8").includes("41"), true);
});

test("gate rejects when the release build fails after a native change", () => {
  const fixture = makeFixture();
  assertRejectedAndRestored(fixture, {
    writes: {
      "native/researchlab-harness/src/lib.rs": "pub fn f() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn measured() {}\n}\n",
    },
    verdict: verdict(),
  }, /^release build failed$/, { buildRelease: () => ({ ok: false, exit_code: 101 }) });
});

test("a verdict that is not a fix never keeps edits", () => {
  const fixture = makeFixture();
  assertRejectedAndRestored(fixture, {
    writes: GOOD_FIX,
    verdict: verdict({ verdict: "could_not_fix", clears_pause: false }),
  }, /verdict could_not_fix but files were changed/);
});

test("the maintainer refuses to work on main", () => {
  const fixture = makeFixture({ branch: "main" });
  writePause(fixture.cwd);
  const { outcome, codexCalls } = run(fixture, { writes: GOOD_FIX, verdict: verdict() });
  assert.equal(outcome.outcome, "rejected");
  assert.match(outcome.reason, /protected branch main/);
  assert.equal(codexCalls.length, 0);
});

// ---------------------------------------------------------------------------
// accept

test("an accepted fix is committed alone, the pause is resolved and the cycle resumes", () => {
  const fixture = makeFixture();
  const markerPath = writePause(fixture.cwd);
  const headBefore = git(fixture.top, ["rev-parse", "HEAD"]).trim();
  const suites = passingSuites();
  let healed = 0;
  const { outcome } = run(fixture, { writes: GOOD_FIX, verdict: verdict() }, {
    runTestSuite: suites.runTestSuite,
    healCycleOnce: () => { healed += 1; return []; },
    buildRelease: () => { throw new Error("no native change, no release build"); },
  });
  assert.equal(outcome.outcome, "accepted", JSON.stringify(outcome));
  assert.equal(outcome.resumed, true);
  assert.equal(outcome.restart_required, true, "a src/ JS fix needs a fresh orchestrator");
  assert.deepEqual(suites.calls.map((call) => call.suite), ["cargo", "node", "pytest"]);
  assert.equal(healed, 1);

  // Exactly the maintainer's files, on top of the old HEAD.
  assert.equal(git(fixture.top, ["rev-parse", "HEAD~1"]).trim(), headBefore);
  const committed = git(fixture.top, ["show", "--name-only", "--format=", "HEAD"]).trim().split(/\r?\n/).sort();
  assert.deepEqual(committed, ["pkg/src/lib.js", "pkg/tests/lib.test.js"]);
  const message = git(fixture.top, ["log", "-1", "--format=%B"]);
  assert.match(message, /^A log tail cut mid-line no longer pauses the cycle\n\nThe watchdog read/);
  assert.match(message, /Root cause: A partial first line lost its event prefix\./);
  assert.match(message, new RegExp(`Maintainer-Run: ${CYCLE}/${outcome.run_id}`));
  // The pre-existing dirt is still dirt.
  const status = git(fixture.top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.match(status, / M pkg\/README\.md/);
  assert.match(status, /\?\? pkg\/lane_scratch\.py/);
  assert.doesNotMatch(status, /src\/lib\.js|tests\/lib\.test\.js/);

  // Pause renamed by the existing convention; stop code cleared.
  assert.equal(fs.existsSync(markerPath), false);
  const resolved = fs.readdirSync(path.dirname(markerPath)).filter((name) => /labdirector-pause\.json\.resolved-\d+\.bak$/.test(name));
  assert.equal(resolved.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".research-lab", "state", `${CYCLE}-termination-code.json`)), false);
  const state = JSON.parse(fs.readFileSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), "utf8"));
  assert.equal(state.runs[0].outcome, "accepted");
  assert.equal(state.runs[0].commit, git(fixture.top, ["rev-parse", "HEAD"]).trim());
  assert.equal(state.in_progress, null);

  // The commit made in the worktree is the one the main branch now ends with.
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  const worktreeCommit = report.steps.find((item) => item.step === "maintainer_commit").commit;
  const pick = report.steps.find((item) => item.step === "maintainer_cherry_pick");
  assert.equal(worktreeCommit, outcome.commit);
  assert.equal(pick.fast_forward, true);
  assert.equal(git(fixture.top, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "fix/plumbing");
  assert.match(fs.readFileSync(path.join(runDir, "candidate.patch"), "utf8"), /answer is 42/);
  assertNoWorktreesLeft(fixture);
});

test("the agent's edits land only in its worktree; the main tree is never written", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const before = treeFingerprint(fixture.top);
  const { outcome, codexCalls, probe } = run(fixture, {
    writes: GOOD_FIX,
    probe_main: path.join(fixture.cwd, "src", "lib.js"),
    verdict: verdict({ verdict: "could_not_fix", clears_pause: false }),
  });
  assert.equal(outcome.outcome, "rejected");
  const cd = codexCalls[0][codexCalls[0].indexOf("--cd") + 1];
  assert.ok(path.resolve(cd).startsWith(path.resolve(cycleWorktreesDir(fixture))), cd);
  // Right after the agent wrote its fix, the main tree still had the old code.
  assert.match(probe, /answer: \(\) => 41/);
  assert.deepEqual(treeFingerprint(fixture.top), before);
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  assert.match(fs.readFileSync(path.join(runDir, "candidate.patch"), "utf8"), /answer: \(\) => 42/);
  assertNoWorktreesLeft(fixture);
});

// MEASURED ON cycle-b-20260919, 2026-09-19: two other agents edited the
// tree during a maintainer run; when it timed out it "restored" six files that
// were not its own (reverting http_client.py, deleting new Rust files and
// fulltext.py). Whatever another writer does to the main tree during a run
// survives both a rejection and an accept.
function concurrentWriterScenario(fixture, verdictValue) {
  return {
    writes: GOOD_FIX,
    external_writes: {
      [path.join(fixture.cwd, "drivers", "literature", "search_lib", "fulltext.py")]: "def fetch(): ...\n",
      [path.join(fixture.cwd, "native", "researchlab-harness", "src", "runtime", "new_module.rs")]: "pub fn f() {}\n",
      [path.join(fixture.cwd, "README.md")]: "# pkg\n\nanother agent's edit\n",
      [path.join(fixture.cwd, "package.json")]: "{\"name\":\"pkg\",\"private\":true}\n",
    },
    verdict: verdictValue,
  };
}

function assertConcurrentWritesIntact(fixture) {
  const read = (...parts) => fs.readFileSync(path.join(fixture.cwd, ...parts), "utf8");
  assert.equal(read("drivers", "literature", "search_lib", "fulltext.py"), "def fetch(): ...\n");
  assert.equal(read("native", "researchlab-harness", "src", "runtime", "new_module.rs"), "pub fn f() {}\n");
  assert.equal(read("README.md"), "# pkg\n\nanother agent's edit\n");
  assert.equal(read("package.json"), "{\"name\":\"pkg\",\"private\":true}\n");
  assert.equal(read("lane_scratch.py"), "print('left by a lane')\n");
}

test("a concurrent writer's changes to the main tree survive a rejected run", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const { outcome } = run(fixture, concurrentWriterScenario(fixture, verdict({ verdict: "could_not_fix", clears_pause: false })));
  assert.equal(outcome.outcome, "rejected");
  assert.match(outcome.reason, /verdict could_not_fix but files were changed/);
  assertConcurrentWritesIntact(fixture);
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8").includes("41"), true);
  assert.equal(git(fixture.top, ["log", "-1", "--format=%s"]).trim(), "initial");
  assertNoWorktreesLeft(fixture);
});

test("a concurrent writer's changes to the main tree survive an accepted run and are not committed", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const { outcome } = run(fixture, concurrentWriterScenario(fixture, verdict()));
  assert.equal(outcome.outcome, "accepted", JSON.stringify(outcome));
  assertConcurrentWritesIntact(fixture);
  const committed = git(fixture.top, ["show", "--name-only", "--format=", "HEAD"]).trim().split(/\r?\n/).sort();
  assert.deepEqual(committed, ["pkg/src/lib.js", "pkg/tests/lib.test.js"]);
  const status = git(fixture.top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.match(status, /\?\? pkg\/drivers\/literature\/search_lib\/fulltext\.py/);
  assert.match(status, / M pkg\/package\.json/);
  assert.doesNotMatch(status, /maintainer-worktrees/);
  assertNoWorktreesLeft(fixture);
});

test("an accepted fix that does not clear the pause is committed and the pause stays", () => {
  const fixture = makeFixture();
  const markerPath = writePause(fixture.cwd);
  const pushes = [];
  const { outcome } = run(fixture, { writes: GOOD_FIX, verdict: verdict({ clears_pause: false }) }, {
    pushBranch: ({ repo }) => { pushes.push(repo.branch); return { ok: true }; },
  }, { RESEARCHLAB_MAINTAINER_PUSH: "1" });
  assert.equal(outcome.outcome, "accepted");
  assert.equal(outcome.resumed, false);
  assert.deepEqual(pushes, ["fix/plumbing"]);
  assert.ok(fs.existsSync(markerPath));
});

// ---------------------------------------------------------------------------
// HEAD moved during the run
//
// MEASURED ON cycle-a-20260919, 2026-09-19 (run-01-20260919T144446Z):
// a fix that passed every gate was thrown away with "HEAD moved during the run
// (7801be9 -> 83cb8c8)" because a person committed an unrelated change
// meanwhile. The candidate is now rebased onto the new HEAD and gated again.

// A person's commit on the branch, of only `rel` (package-relative): the
// fixture's other dirt stays uncommitted.
function humanCommit(fixture, rel, content, message) {
  write(path.join(fixture.cwd, ...rel.split("/")), content);
  git(fixture.top, ["add", "--", `pkg/${rel}`]);
  git(fixture.top, ["commit", "-q", "-m", message, "--", `pkg/${rel}`]);
  return git(fixture.top, ["rev-parse", "HEAD"]).trim();
}

function reportOf(fixture, outcome) {
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  return JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
}

function eventTypes(fixture) {
  const file = path.join(fixture.cwd, ".research-lab", "events", `${CYCLE}-maintainer.jsonl`);
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).event_type);
}

test("HEAD moved by an unrelated commit during the gate: the fix is rebased, gated again against the new HEAD, and lands", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const otherModule = "\"use strict\";\nmodule.exports = { other: true };\n";
  let human = null;
  const calls = [];
  const { outcome } = run(fixture, { writes: GOOD_FIX, verdict: verdict() }, {
    runTestSuite: (suite, { cwd, only }) => {
      const hasHumanFile = fs.existsSync(path.join(cwd, "src", "other.js"));
      const candidate = fs.readFileSync(path.join(cwd, "src", "lib.js"), "utf8").includes("42");
      calls.push({ suite, cwd, only, hasHumanFile, candidate });
      // The person commits while the first gate is on its last suite.
      if (suite === "pytest" && !human) human = humanCommit(fixture, "src/other.js", otherModule, "human: other module");
      // A test that fails wherever the person's module is -- at the new HEAD
      // too, so it is baseline there, and only there.
      if (suite === "node" && hasHumanFile) return { status: "failed", failures: ["tests/other.test.js::flaky"] };
      return { status: "passed", failures: [] };
    },
  });
  assert.equal(outcome.outcome, "accepted", JSON.stringify(outcome));
  assert.equal(outcome.resumed, true);

  // The fix sits on the person's commit, which is untouched.
  assert.equal(git(fixture.top, ["rev-parse", "HEAD~1"]).trim(), human);
  assert.equal(outcome.commit, git(fixture.top, ["rev-parse", "HEAD"]).trim());
  const committed = git(fixture.top, ["show", "--name-only", "--format=", "HEAD"]).trim().split(/\r?\n/).sort();
  assert.deepEqual(committed, ["pkg/src/lib.js", "pkg/tests/lib.test.js"]);
  assert.match(git(fixture.top, ["log", "-1", "--format=%B"]), new RegExp(`Maintainer-Run: ${CYCLE}/${outcome.run_id}`));
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "other.js"), "utf8"), otherModule);
  assert.match(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8"), /=> 42/);
  const status = git(fixture.top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.match(status, / M pkg\/README\.md/);
  assert.match(status, /\?\? pkg\/lane_scratch\.py/);

  // First gate on the old base; the second, whole, in a fresh worktree of the
  // new HEAD, with its baseline a clean worktree of that HEAD.
  const first = calls.filter((call) => !/-r1([\\/]|-base)/.test(call.cwd));
  const second = calls.filter((call) => /-r1[\\/]pkg$/.test(call.cwd));
  const baseline = calls.filter((call) => /-r1-base[\\/]pkg$/.test(call.cwd));
  assert.deepEqual(first.map((call) => call.suite), ["cargo", "node", "pytest"]);
  assert.deepEqual(second.map((call) => call.suite), ["cargo", "node", "pytest"]);
  assert.ok(second.every((call) => call.candidate && call.hasHumanFile));
  assert.deepEqual(baseline.map((call) => [call.suite, call.only, call.candidate, call.hasHumanFile]),
    [["node", ["tests/other.test.js::flaky"], false, true]]);

  const report = reportOf(fixture, outcome);
  const rebased = report.steps.filter((item) => item.step === "maintainer_rebased");
  assert.equal(rebased.length, 1);
  assert.equal(rebased[0].onto, human);
  assert.equal(rebased[0].attempt, 1);
  assert.match(rebased[0].new_commits.join("\n"), /human: other module/);
  const picks = report.steps.filter((item) => item.step === "maintainer_cherry_pick");
  assert.equal(picks.length, 2);
  assert.equal(picks[0].head_moved, true);
  assert.equal(picks[1].fast_forward, true);
  assert.ok(eventTypes(fixture).includes("maintainer_rebased"));
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  assert.match(fs.readFileSync(path.join(runDir, "candidate-rebase-1.patch"), "utf8"), /answer is 42/);
  assertNoWorktreesLeft(fixture);
});

test("HEAD moved while the agent worked: the candidate is rebased before the gate, which runs once, on the new HEAD", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const calls = [];
  const { outcome } = run(fixture, {
    writes: GOOD_FIX,
    external_commits: [{ top: fixture.top, path: "pkg/src/other.js", content: "module.exports = 1;\n", message: "human: during codex" }],
    verdict: verdict(),
  }, {
    runTestSuite: (suite, { cwd }) => {
      calls.push({ suite, cwd });
      return { status: "passed", failures: [] };
    },
  });
  assert.equal(outcome.outcome, "accepted", JSON.stringify(outcome));
  assert.equal(git(fixture.top, ["log", "-1", "--format=%s", "HEAD~1"]).trim(), "human: during codex");
  assert.deepEqual(calls.map((call) => call.suite), ["cargo", "node", "pytest"]);
  assert.ok(calls.every((call) => /-r1[\\/]pkg$/.test(call.cwd)), JSON.stringify(calls));
  assertNoWorktreesLeft(fixture);
});

test("a commit that conflicts with the fix rejects it with the conflicting commit named; the main tree is untouched and the patch kept", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const humanLib = "\"use strict\";\nmodule.exports = { answer: () => 43 };\n";
  const suites = passingSuites();
  const { outcome } = run(fixture, {
    writes: GOOD_FIX,
    external_commits: [{ top: fixture.top, path: "pkg/src/lib.js", content: humanLib, message: "human: answer is 43" }],
    verdict: verdict(),
  }, { runTestSuite: suites.runTestSuite });
  assert.equal(outcome.outcome, "rejected", JSON.stringify(outcome));
  const human = git(fixture.top, ["rev-parse", "HEAD"]).trim();
  assert.equal(git(fixture.top, ["log", "-1", "--format=%s"]).trim(), "human: answer is 43");
  const short = git(fixture.top, ["rev-parse", "--short", "HEAD"]).trim();
  assert.equal(outcome.reason, `conflicts with ${short} human: answer is 43`);
  assert.deepEqual(suites.calls, [], "no gate for a candidate that does not apply");

  // Nothing of the fix reached the main tree; the person's commit is as made.
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8"), humanLib);
  const status = git(fixture.top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(status.split(/\r?\n/).filter(Boolean).sort().join("\n"), " M pkg/README.md\n?? pkg/lane_scratch.py");
  assert.equal(fs.existsSync(path.join(fixture.top, ".git", "CHERRY_PICK_HEAD")), false);

  const report = reportOf(fixture, outcome);
  const conflict = report.steps.find((item) => item.step === "maintainer_rebase_conflict");
  assert.ok(conflict, "conflict logged");
  assert.deepEqual(conflict.conflicts, ["pkg/src/lib.js"]);
  assert.equal(conflict.onto, human);
  assert.ok(eventTypes(fixture).includes("maintainer_rebase_conflict"));
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  assert.match(fs.readFileSync(path.join(runDir, "candidate.patch"), "utf8"), /answer: \(\) => 42/);
  assertNoWorktreesLeft(fixture);
});

test("a HEAD that keeps moving past RESEARCHLAB_MAINTAINER_REBASE_ATTEMPTS rejects the fix; 0 keeps the old refusal", () => {
  const moving = (fixture, calls) => (suite, { cwd }) => {
    calls.push({ suite, cwd });
    if (suite === "pytest") humanCommit(fixture, `src/human-${calls.length}.js`, "module.exports = 0;\n", `human: commit ${calls.length}`);
    return { status: "passed", failures: [] };
  };

  const fixture = makeFixture();
  writePause(fixture.cwd);
  const calls = [];
  const { outcome } = run(fixture, { writes: GOOD_FIX, verdict: verdict() }, { runTestSuite: moving(fixture, calls) });
  assert.equal(outcome.outcome, "rejected", JSON.stringify(outcome));
  assert.match(outcome.reason, /^HEAD kept moving: still moving after 2 rebase attempts \([0-9a-f]{40} -> [0-9a-f]{40}\)$/);
  // Three full gates: the original base and two rebases (default 2).
  assert.equal(calls.length, 9);
  assert.equal(calls.filter((call) => /-r2[\\/]pkg$/.test(call.cwd)).length, 3);
  // The branch ends with the people's commits and none of the maintainer's.
  assert.equal(git(fixture.top, ["log", "-1", "--format=%s"]).trim(), "human: commit 9");
  assert.doesNotMatch(git(fixture.top, ["log", "--format=%B"]), /Maintainer-Run/);
  assert.match(fs.readFileSync(path.join(fixture.cwd, "src", "lib.js"), "utf8"), /=> 41/);
  const report = reportOf(fixture, outcome);
  assert.equal(report.steps.filter((item) => item.step === "maintainer_rebased").length, 2);
  assertNoWorktreesLeft(fixture);

  const off = makeFixture();
  writePause(off.cwd);
  const offCalls = [];
  const { outcome: refused } = run(off, { writes: GOOD_FIX, verdict: verdict() }, { runTestSuite: moving(off, offCalls) }, {
    RESEARCHLAB_MAINTAINER_REBASE_ATTEMPTS: "0",
  });
  assert.equal(refused.outcome, "rejected");
  assert.match(refused.reason, /^HEAD moved during the run \([0-9a-f]{40} -> [0-9a-f]{40}\)$/);
  assert.equal(offCalls.length, 3);
  assertNoWorktreesLeft(off);
});

// ---------------------------------------------------------------------------
// crash recovery

function interruptedRunState(fixture, inProgress) {
  writeJson(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), {
    cycle_id: CYCLE,
    lane_watermark: new Date().toISOString(),
    runs: [{ run_id: "run-01", signature: "pause:x", started_at: new Date().toISOString() }],
    attempted_signatures: ["pause:x"],
    in_progress: inProgress,
  });
}

test("a run cut off mid-edit loses only its worktree; the main tree, other writers included, is left alone", () => {
  const fixture = makeFixture();
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, "run-01");
  fs.mkdirSync(runDir, { recursive: true });
  const worktree = path.join(cycleWorktreesDir(fixture), "run-01");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  // As the maintainer itself arranges before its first worktree.
  fs.appendFileSync(path.join(fixture.top, ".git", "info", "exclude"), "/.maintainer-worktrees/\n");
  git(fixture.top, ["worktree", "add", "--detach", "--quiet", worktree, "HEAD"]);
  // A baseline worktree and a bare leftover directory from an older crash.
  git(fixture.top, ["worktree", "add", "--detach", "--quiet", `${worktree}-base`, "HEAD"]);
  write(path.join(cycleWorktreesDir(fixture), "run-00", "pkg", "stray.txt"), "left by a crash\n");
  interruptedRunState(fixture, {
    run_id: "run-01",
    run_dir: runDir,
    worktree,
    base_worktree: `${worktree}-base`,
    venue: "host",
    container_name: null,
  });
  write(path.join(worktree, "pkg", "src", "lib.js"), "half an edit");
  write(path.join(worktree, "pkg", "src", "new_module.js"), "also half");
  // Another agent's work in the main tree, in the same files.
  write(path.join(fixture.cwd, "src", "new_module.js"), "another agent's module\n");
  const before = treeFingerprint(fixture.top);

  const outcome = recoverInterruptedRun({ cwd: fixture.cwd, cycleId: CYCLE, env: { RESEARCHLAB_MAINTAINER: "1" } });
  assert.equal(outcome.recovered, true, JSON.stringify(outcome));
  assert.deepEqual(treeFingerprint(fixture.top), before);
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "src", "new_module.js"), "utf8"), "another agent's module\n");
  const patch = fs.readFileSync(outcome.kept_patch, "utf8");
  assert.match(patch, /half an edit/);
  assert.match(patch, /also half/);
  assertNoWorktreesLeft(fixture);
  const state = JSON.parse(fs.readFileSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), "utf8"));
  assert.equal(state.in_progress, null);
  assert.equal(state.runs[0].outcome, "interrupted");
});

test("a run interrupted before the worktree design leaves the main tree exactly as it is", () => {
  const fixture = makeFixture();
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, "run-01");
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, "snapshot.json"), { head: "x", pre: {}, guarded: {} });
  interruptedRunState(fixture, { run_id: "run-01", run_dir: runDir, snapshot_path: path.join(runDir, "snapshot.json") });
  write(path.join(fixture.cwd, "src", "lib.js"), "someone's edit");
  const before = treeFingerprint(fixture.top);
  const outcome = recoverInterruptedRun({ cwd: fixture.cwd, cycleId: CYCLE, env: { RESEARCHLAB_MAINTAINER: "1" } });
  assert.equal(outcome.recovered, false);
  assert.match(outcome.reason, /predates the maintainer worktree/);
  assert.deepEqual(treeFingerprint(fixture.top), before);
  const state = JSON.parse(fs.readFileSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), "utf8"));
  assert.equal(state.runs[0].outcome, "interrupted");
});

// ---------------------------------------------------------------------------
// docker venue

const FAKE_DOCKER = `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run") {
  try { fs.readFileSync(0); } catch {}
  // The agent edits its worktree (the second -v, host side), then hangs.
  const mounts = args.flatMap((arg, index) => (args[index - 1] === "-v" ? [arg] : []));
  const worktreeHost = mounts[1].replace(/:\\/work\\/.*$/, "");
  fs.mkdirSync(path.join(worktreeHost, "pkg", "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreeHost, "pkg", "src", "lib.js"), "in the container\\n");
  setTimeout(() => {}, 120000);
}
`;

function dockerEnv(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-fake-docker-"));
  const command = path.join(dir, "docker.js");
  fs.writeFileSync(command, FAKE_DOCKER, "utf8");
  const codexHome = path.join(dir, "codex-home");
  write(path.join(codexHome, "auth.json"), "{}");
  write(path.join(codexHome, "config.toml"), "[plugins]\n");
  const log = path.join(dir, "docker.log");
  return {
    log,
    env: {
      RESEARCHLAB_MAINTAINER_VENUE: "",
      RESEARCHLAB_MAINTAINER_DOCKER_IMAGE: "researchlab:local",
      RESEARCHLAB_MAINTAINER_DOCKER_CMD: command,
      RESEARCHLAB_MAINTAINER_DOCKER_MOUNT: "",
      CODEX_HOME: codexHome,
      FAKE_DOCKER_LOG: log,
    },
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    fixture,
  };
}

test("a timed-out docker run has its container force-removed and its worktree discarded", () => {
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const docker = dockerEnv(fixture);
  const before = treeFingerprint(fixture.top);
  const started = Date.now();
  const { outcome } = run(fixture, { verdict: verdict() }, {}, { ...docker.env, RESEARCHLAB_MAINTAINER_TIMEOUT_SECONDS: "2" });
  assert.ok(Date.now() - started < 60000, "the hung docker client was killed at the timeout");
  assert.equal(outcome.outcome, "rejected", JSON.stringify(outcome));
  assert.equal(outcome.reason, "codex timed out without a verdict");
  const calls = docker.calls();
  const container = `rl-maint-${CYCLE}-${outcome.run_id}`.toLowerCase();
  const runIndex = calls.findIndex((args) => args[0] === "run");
  assert.ok(runIndex >= 0);
  assert.equal(calls[runIndex][calls[runIndex].indexOf("--name") + 1], container);
  assert.ok(
    calls.slice(runIndex + 1).some((args) => args.join(" ") === `rm -f ${container}`),
    `docker rm -f after the run: ${JSON.stringify(calls)}`,
  );
  assert.deepEqual(treeFingerprint(fixture.top), before);
  assertNoWorktreesLeft(fixture);
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, outcome.run_id);
  assert.match(fs.readFileSync(path.join(runDir, "candidate.patch"), "utf8"), /in the container/);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  assert.equal(report.cleanup.container_removed, true);
  const state = JSON.parse(fs.readFileSync(__private.statePath({ cwd: fixture.cwd, cycleId: CYCLE }), "utf8"));
  assert.equal(state.in_progress, null);
});

test("an interrupted docker run's container is removed at the next start", () => {
  const fixture = makeFixture();
  const docker = dockerEnv(fixture);
  const runDir = path.join(fixture.cwd, ".research-lab", "maintenance", CYCLE, "run-01");
  fs.mkdirSync(runDir, { recursive: true });
  interruptedRunState(fixture, {
    run_id: "run-01",
    run_dir: runDir,
    worktree: path.join(cycleWorktreesDir(fixture), "run-01"),
    venue: "docker",
    container_name: "rl-maint-maint-cycle-run-01",
    docker_command: docker.env.RESEARCHLAB_MAINTAINER_DOCKER_CMD,
  });
  const outcome = recoverInterruptedRun({ cwd: fixture.cwd, cycleId: CYCLE, env: { RESEARCHLAB_MAINTAINER: "1", ...docker.env } });
  assert.equal(outcome.container_removed, true);
  assert.deepEqual(docker.calls(), [["rm", "-f", "rl-maint-maint-cycle-run-01"]]);
});

test("docker argv: repository read-only, only the worktree and run dir writable, only auth.json from the Codex home", () => {
  const mountRoot = "D:/projects/researchlab";
  const worktreeRoot = "D:\\projects\\researchlab\\.maintainer-worktrees\\cycle-b-20260919\\run-02-x";
  const runDir = "D:\\projects\\researchlab\\researchlab\\.research-lab\\maintenance\\cycle-b-20260919\\run-02-x";
  const workdir = `${worktreeRoot}\\researchlab`;
  const codexArgs = __private.codexArgs({
    model: "gpt-5.6-sol",
    lastMessagePath: `${runDir}\\last-message.json`,
    schemaPath: `${runDir}\\output-schema.json`,
    cwd: workdir,
  });
  const args = __private.dockerRunArgs({
    image: "researchlab:local",
    containerName: "rl-maint-cycle-b-20260919-run-02-x",
    mountRoot,
    authJson: "C:/Users/user/.codex/auth.json",
    worktreeRoot,
    runDir,
    workdir,
    codexArgs,
  });
  const containerRun = "/work/researchlab/.research-lab/maintenance/cycle-b-20260919/run-02-x";
  const containerWorktree = "/work/.maintainer-worktrees/cycle-b-20260919/run-02-x";
  assert.deepEqual(args.slice(0, args.indexOf("researchlab:local") + 2), [
    "run", "--rm", "-i",
    "--name", "rl-maint-cycle-b-20260919-run-02-x",
    "--security-opt", "seccomp=unconfined",
    "--security-opt", "apparmor=unconfined",
    "-v", "D:/projects/researchlab:/work:ro",
    "-v", `D:/projects/researchlab/.maintainer-worktrees/cycle-b-20260919/run-02-x:${containerWorktree}`,
    "-v", `D:/projects/researchlab/researchlab/.research-lab/maintenance/cycle-b-20260919/run-02-x:${containerRun}`,
    "-v", "C:/Users/user/.codex/auth.json:/root/.codex/auth.json",
    "-w", `${containerWorktree}/researchlab`,
    "-e", "PYTHONIOENCODING=utf-8",
    "-e", "PYTHONUTF8=1",
    "-e", `RESEARCHLAB_MAINTAINER_RUN_DIR=${containerRun}`,
    "researchlab:local",
    "codex",
  ]);
  // No other mount into the Codex home (config.toml, plugins) and no CODEX_HOME.
  const mounts = args.filter((_, index) => args[index - 1] === "-v");
  assert.deepEqual(mounts.filter((mount) => mount.includes("/root/.codex")), ["C:/Users/user/.codex/auth.json:/root/.codex/auth.json"]);
  assert.ok(!args.some((arg) => /CODEX_HOME|config\.toml/.test(arg)));
  const codex = args.slice(args.indexOf("codex") + 1);
  assert.equal(codex[codex.indexOf("--cd") + 1], `${containerWorktree}/researchlab`);
  assert.equal(codex[codex.indexOf("--output-last-message") + 1], `${containerRun}/last-message.json`);
  assert.equal(codex[codex.indexOf("--output-schema") + 1], `${containerRun}/output-schema.json`);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(codex.includes("sandbox_workspace_write.network_access=false"));
});

test("venue: docker when an image is configured, host otherwise or when asked, host when auth is missing", () => {
  const fixture = makeFixture();
  const repo = __private.openRepo(fixture.cwd);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-codex-home-"));
  write(path.join(home, "auth.json"), "{}");
  const venue = (env) => __private.resolveVenue({
    env,
    config: require("../src/orchestrator/maintainer").maintainerConfig(env),
    repo,
    cwd: fixture.cwd,
    cycleId: CYCLE,
    runId: "run-01-X",
  });
  assert.equal(venue({ CODEX_HOME: home }).kind, "host");
  const scout = venue({ CODEX_HOME: home, RESEARCHLAB_SCOUT_DOCKER_IMAGE: "researchlab:local" });
  assert.equal(scout.kind, "docker");
  assert.equal(scout.image, "researchlab:local");
  assert.equal(scout.containerName, "rl-maint-maint-cycle-run-01-x");
  assert.equal(scout.mountRoot, repo.top.replace(/\\/g, "/"));
  assert.equal(venue({ CODEX_HOME: home, RESEARCHLAB_MAINTAINER_DOCKER_IMAGE: "img:1", RESEARCHLAB_SCOUT_DOCKER_IMAGE: "img:2" }).image, "img:1");
  assert.equal(venue({ CODEX_HOME: home, RESEARCHLAB_SCOUT_DOCKER_IMAGE: "img", RESEARCHLAB_MAINTAINER_VENUE: "host" }).kind, "host");
  const noAuth = venue({ CODEX_HOME: path.join(home, "missing"), RESEARCHLAB_SCOUT_DOCKER_IMAGE: "img" });
  assert.equal(noAuth.kind, "host");
  assert.match(noAuth.fallback_reason, /auth\.json/);
  const noImage = venue({ CODEX_HOME: home, RESEARCHLAB_MAINTAINER_VENUE: "docker" });
  assert.equal(noImage.kind, "host");
  assert.match(noImage.fallback_reason, /IMAGE/);
});

test("host paths in the prompt become container paths in every spelling (port of docker_scout.rs)", () => {
  const mount = "D:/projects/researchlab";
  const text = [
    "Read D:\\projects\\researchlab\\researchlab\\.research-lab\\lanes\\c\\l\\role-plan.json now.",
    "{\"journal\":\"D:\\\\projects\\\\researchlab\\\\researchlab\\\\runtime\\\\j.json\",\"x\":1}",
    "Also d:/projects/researchlab/researchlab/drivers/literature/search.py, then D:/projects/researchlab\\researchlab\\notes.md",
  ].join("\n");
  assert.equal(__private.translateHostPaths(mount, text), [
    "Read /work/researchlab/.research-lab/lanes/c/l/role-plan.json now.",
    "{\"journal\":\"/work/researchlab/runtime/j.json\",\"x\":1}",
    "Also /work/researchlab/drivers/literature/search.py, then /work/researchlab/notes.md",
  ].join("\n"));
  const escaped = "\"see D:\\\\projects\\\\researchlab\\\\a\\\\b.json\\nnext \\\"D:\\\\projects\\\\researchlab\\\"\"";
  assert.equal(__private.translateHostPaths(mount, escaped), "\"see /work/a/b.json\\nnext \\\"/work\\\"\"");
  const outside = "C:\\Users\\user\\.codex\\auth.json and D:\\projects\\researchlab-other\\x and XD:\\projects\\researchlab\\z and D:\\projects";
  assert.equal(__private.translateHostPaths(mount, outside), outside);
  assert.equal(__private.hostToContainer("D:\\projects\\researchlab\\", "\\\\?\\D:\\projects\\researchlab\\x"), "/work/x");
  assert.equal(__private.hostToContainer(mount, "D:\\projects\\researchlab-other\\x"), null);
  const prompt = __private.containerPrompt({ mountRoot: mount }, "cd D:\\projects\\researchlab\\.maintainer-worktrees\\c\\r\\researchlab");
  const [note, body] = prompt.split("\n\n");
  assert.match(note, /Linux container/);
  assert.match(note, /cargo and pytest are NOT/);
  assert.equal(body, "cd /work/.maintainer-worktrees/c/r/researchlab");
});

// ---------------------------------------------------------------------------
// suite output parsing

test("suite failures are read from each runner's own report format", () => {
  const nodeOutput = [
    "ℹ tests 829",
    "ℹ fail 2",
    "",
    "✖ failing tests:",
    "",
    "test at tests\\cli_watch_cycle.test.js:93:1",
    "✖ watch-cycle does not immediately restart a resume-cycle it just started (1729.4002ms)",
    "  AssertionError [ERR_ASSERTION]: 1 !== 0",
    "",
    "test at tests\\figure_deck_pptx.test.js:12:1",
    "✖ figure deck builder creates a python-pptx file PowerPoint can parse (4378.6469ms)",
  ].join("\r\n");
  assert.deepEqual(__private.nodeTestFailures(nodeOutput), [
    "tests/cli_watch_cycle.test.js::watch-cycle does not immediately restart a resume-cycle it just started",
    "tests/figure_deck_pptx.test.js::figure deck builder creates a python-pptx file PowerPoint can parse",
  ]);
  assert.deepEqual(__private.cargoTestFailures([
    "test labdirector::plan::tests::a_selected_hypothesis_sends_a_scout_after_its_own_prior_art ... FAILED",
    "test runtime::codex_lane::tests::ok ... ok",
  ].join("\n")), ["labdirector::plan::tests::a_selected_hypothesis_sends_a_scout_after_its_own_prior_art"]);
  assert.deepEqual(__private.pytestFailures([
    "=========================== short test summary info ===========================",
    "FAILED tests/data_scout_browser_test.py::DataScoutRelevanceTest::test_forbidden_accession - AssertionError",
    "ERROR tests/x_test.py::test_y",
    "7 failed, 331 passed, 1 skipped in 15.42s",
  ].join("\n")), [
    "tests/data_scout_browser_test.py::DataScoutRelevanceTest::test_forbidden_accession",
    "tests/x_test.py::test_y",
  ]);
});

test("test and skip counting covers the three languages", () => {
  assert.equal(__private.testCountOf("tests/a.test.js", "test(\"a\", () => {});\nit('b', () => {});\n/x/.test(s);\nsubmit(1);\n"), 2);
  assert.equal(__private.testCountOf("src/a.rs", "#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n"), 2);
  assert.equal(__private.testCountOf("tests/a_test.py", "    def test_a(self):\n    def helper(self):\n    async def test_b(self):\n"), 2);
  assert.equal(__private.skipCountOf("tests/a.test.js", "test.skip(\"a\", () => {});\ntest(\"b\", { skip: true }, () => {});\n"), 2);
  assert.equal(__private.skipCountOf("src/a.rs", "#[test]\n#[ignore]\nfn a() {}\n"), 1);
  assert.equal(__private.skipCountOf("tests/a_test.py", "@unittest.skipIf(True, 'x')\n@pytest.mark.skip\n"), 2);
});

test("a log tail starts at a line boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-maintainer-tail-"));
  const filePath = path.join(dir, "stdout.log");
  fs.writeFileSync(filePath, `${"x".repeat(100)}{"type":"item.completed"}\nsecond line\n`);
  assert.equal(__private.readTail(filePath, 20), "second line\n");
});

// ---------------------------------------------------------------------------
// wiring into the run-research loop

function loadRunResearchWith({ execute, maintain, refresh = () => null }) {
  const researchCyclePath = require.resolve("../src/orchestrator/research_cycle");
  const maintainerPath = require.resolve("../src/orchestrator/maintainer");
  const refreshPath = require.resolve("../src/reporting/refresh_cycle");
  const runResearchPath = require.resolve("../src/orchestrator/run_research");
  const saved = [researchCyclePath, maintainerPath, refreshPath, runResearchPath].map((key) => [key, require.cache[key]]);
  const stub = (key, exports) => {
    require.cache[key] = { id: key, filename: key, loaded: true, exports };
  };
  try {
    stub(researchCyclePath, { executeResearchCycle: execute, prepareResearchCycle: () => ({}) });
    stub(maintainerPath, {
      maybeRunMaintainer: maintain,
      maybeRestartAfterMaintenance: () => false,
      recoverInterruptedRun: () => null,
    });
    stub(refreshPath, { refreshCycleOutputs: refresh });
    delete require.cache[runResearchPath];
    return require(runResearchPath).__private.executeResearchCycleWithMaintainer;
  } finally {
    for (const [key, entry] of saved) {
      if (entry) require.cache[key] = entry;
      else delete require.cache[key];
    }
  }
}

test("run-plan publishes derived gate state before the maintainer measures progress", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-21: gate_review was
  // reported stuck for 1208 minutes with conclusion-review still unpublished.
  const calls = [];
  let conclusionPublished = false;
  const run = loadRunResearchWith({
    execute: () => {
      calls.push("run-plan");
      return { status: "ok" };
    },
    refresh: () => {
      calls.push("refresh");
      conclusionPublished = true;
    },
    maintain: () => {
      calls.push("maintainer");
      assert.equal(conclusionPublished, true, "maintainer must see the conclusion review published by refresh");
      return null;
    },
  });

  assert.deepEqual(run({ cwd: "/unused", cycleId: CYCLE, staleSeconds: 60 }), { status: "ok" });
  assert.deepEqual(calls, ["run-plan", "refresh", "maintainer"]);
});

test("run-plan goes again after a maintainer fix that clears the blocker; otherwise the error stands", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-maintainer-loop-"));
  let calls = 0;
  const seenErrors = [];
  const execute = () => {
    calls += 1;
    if (calls === 1) throw new Error("native command failed: run-plan");
    return { status: "ok", call: calls };
  };
  const resumeOnce = loadRunResearchWith({
    execute,
    maintain: ({ error }) => {
      seenErrors.push(error ? error.message : null);
      return error ? { outcome: "accepted", resumed: true, run_id: "run-01" } : null;
    },
  });
  const result = resumeOnce({ cwd, cycleId: CYCLE, staleSeconds: 60 });
  assert.deepEqual(result, { status: "ok", call: 2 });
  assert.deepEqual(seenErrors, ["native command failed: run-plan", null]);

  calls = 0;
  const noFix = loadRunResearchWith({ execute, maintain: () => ({ outcome: "rejected", resumed: false }) });
  assert.throws(() => noFix({ cwd, cycleId: CYCLE, staleSeconds: 60 }), /native command failed/);
  assert.equal(calls, 1);

  // Disabled maintainer: exactly the old behaviour.
  calls = 1;
  const off = loadRunResearchWith({ execute, maintain: () => null });
  assert.deepEqual(off({ cwd, cycleId: CYCLE, staleSeconds: 60 }), { status: "ok", call: 2 });
});

test("a crash before the first run-plan is handed to the maintainer", () => {
  // cycle-a-20260919, 2026-10-01 03:36Z: run-research threw while
  // recording its first control state, exited, and was restarted ten times into
  // the same throw without the supervisor ever seeing it.
  const fixture = makeFixture();
  const fake = fakeCodexEnv({ verdict: verdict({ verdict: "could_not_fix", clears_pause: false }) });
  const error = new Error("too many SQL variables");
  error.stack = "Error: too many SQL variables\n    at pruneMissing (src/storage/metadata_store.js:537:24)";
  const outcome = maintainAfterAbort({
    cwd: fixture.cwd,
    cycleId: CYCLE,
    error,
    env: fake.env,
    deps: {
      runTestSuite: passingSuites().runTestSuite,
      buildRelease: () => ({ ok: true }),
      healCycleOnce: () => [],
    },
  });
  assert.ok(outcome, "the maintainer did not run");
  const report = JSON.parse(fs.readFileSync(path.join(outcome.run_dir, "report.json"), "utf8"));
  assert.equal(report.trigger.kind, "native_exception");
  assert.match(report.trigger.detail, /too many SQL variables/);
  const calls = fs.readFileSync(`${fake.scenarioPath}.calls`, "utf8").split("\n").filter(Boolean);
  assert.equal(calls.length, 1, "one diagnosis");

  // The restart that follows reaches the same throw: the same signature is not
  // diagnosed again.
  const again = maintainAfterAbort({ cwd: fixture.cwd, cycleId: CYCLE, error, env: fake.env, deps: {} });
  assert.equal(again, null);
  assert.equal(fs.readFileSync(`${fake.scenarioPath}.calls`, "utf8").split("\n").filter(Boolean).length, 1);
});

test("a run-plan crash already diagnosed is not diagnosed again when run-research aborts on it", () => {
  // 2026-10-01 09:59Z: run-plan's own maintainer pass took the EOF crash as
  // run-26, the abort handler hashed its stack to another signature and spent
  // run-27 on the same crash.
  const fixture = makeFixture();
  const fake = fakeCodexEnv({ verdict: verdict({ verdict: "could_not_fix", clears_pause: false }) });
  const error = new Error("[researchlab-harness] EOF while parsing a value at line 1 column 0");
  error.stack = `Error: ${error.message}\n    at runNativeCapture (src/runtime/native_client.js:48:11)\n    at executeResearchCycle (src/orchestrator/research_cycle.js:51:21)`;
  const deps = { runTestSuite: passingSuites().runTestSuite, buildRelease: () => ({ ok: true }), healCycleOnce: () => [] };
  const first = maybeRunMaintainer({ cwd: fixture.cwd, cycleId: CYCLE, error, env: fake.env, deps });
  assert.ok(first, "run-plan's pass diagnoses it");
  assert.equal(maintainAfterAbort({ cwd: fixture.cwd, cycleId: CYCLE, error, env: fake.env, deps }), null);
  assert.equal(fs.readFileSync(`${fake.scenarioPath}.calls`, "utf8").split("\n").filter(Boolean).length, 1);
});

test("an abort without a cycle id asks nothing of the maintainer", () => {
  assert.equal(maintainAfterAbort({ cwd: process.cwd(), cycleId: null, error: new Error("x") }), null);
});

const REVOKED_STDOUT = `${JSON.stringify({ type: "error", message: "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again." })}\n`;

test("a maintainer refused by a revoked Codex login gives the attempt back and waits for the owner", () => {
  // cycle-a-20260919, 2026-10-01: runs 25-28 each died in a second on
  // token_revoked, and each one used up a signature and an attempt.
  const fixture = makeFixture();
  const fake = fakeCodexEnv({ stdout: REVOKED_STDOUT, exit_code: 1 });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rl-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{\"auth_mode\":\"chatgpt\"}");
  const env = { ...fake.env, CODEX_HOME: codexHome };
  const error = new Error("EOF while parsing a value at line 1 column 0");
  const deps = { runTestSuite: passingSuites().runTestSuite, buildRelease: () => ({ ok: true }), healCycleOnce: () => [] };

  const outcome = maintainAfterAbort({ cwd: fixture.cwd, cycleId: CYCLE, error, env, deps });
  assert.equal(outcome.outcome, "codex_login_required");
  const marker = readCodexLoginRequired({ cwd: fixture.cwd, cycleId: CYCLE });
  assert.ok(marker, "the owner is told");
  assert.match(marker.owner_action, /codex login/);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".research-lab", "runtime", `${CYCLE}-maintainer.json`), "utf8"));
  assert.deepEqual(state.attempted_signatures, [], "the signature is given back");
  assert.equal(state.runs[0].not_counted, true);

  // While the login is unchanged nothing runs.
  assert.equal(maintainAfterAbort({ cwd: fixture.cwd, cycleId: CYCLE, error, env, deps }), null);
  const calls = () => fs.readFileSync(`${fake.scenarioPath}.calls`, "utf8").split("\n").filter(Boolean).length;
  assert.equal(calls(), 1);

  // The owner signs in: the same crash is diagnosed, as a first attempt.
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{\"auth_mode\":\"chatgpt\",\"tokens\":{}}");
  fs.writeFileSync(fake.scenarioPath, JSON.stringify({ verdict: verdict({ verdict: "could_not_fix", clears_pause: false }) }));
  const after = maintainAfterAbort({ cwd: fixture.cwd, cycleId: CYCLE, error, env, deps });
  assert.equal(after.outcome, "no_fix");
  assert.equal(calls(), 2);
});

test("a reload owes the maintainer the pass it skipped, made first on the new source", () => {
  // cycle-a-20260919, 2026-10-18/19: three reloads, no maintainer
  // pass for four and a half hours.
  const { noteMaintainerCatchUp, catchUpPath } = require("../src/orchestrator/maintainer_catch_up");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-maintainer-catch-up-"));
  const calls = [];
  const run = loadRunResearchWith({
    execute: () => { calls.push("run-plan"); return { status: "ok" }; },
    refresh: () => calls.push("refresh"),
    maintain: () => { calls.push("maintainer"); return null; },
  });
  noteMaintainerCatchUp({ cwd, cycleId: CYCLE, reason: "harness source changed" });
  assert.ok(fs.existsSync(catchUpPath(cwd, CYCLE)));
  run({ cwd, cycleId: CYCLE, staleSeconds: 60 });
  assert.deepEqual(calls, ["maintainer", "run-plan", "refresh", "maintainer"]);
  assert.ok(!fs.existsSync(catchUpPath(cwd, CYCLE)), "owed once");
  calls.length = 0;
  run({ cwd, cycleId: CYCLE, staleSeconds: 60 });
  assert.deepEqual(calls, ["run-plan", "refresh", "maintainer"]);
});

test("the run cap is per week: older runs free attempts, and what the cap said is released", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-26: a cap on the cycle's whole
  // life, spent on 2026-10-19, left every later finding unattended.
  const fixture = makeFixture();
  writePause(fixture.cwd);
  const notABug = { verdict: verdict({ verdict: "environment_block", clears_pause: false }) };
  const env = { RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "1" };
  const statePath = __private.statePath({ cwd: fixture.cwd, cycleId: CYCLE });
  const first = run(fixture, notABug, {}, env);
  assert.equal(first.outcome.outcome, "no_fix");

  // A different blocker while that run is inside the week: capped, and it says when attempts return.
  writePause(fixture.cwd, { evidence: "a different setup failure", phase: "prelaunch" });
  const capped = run(fixture, notABug, {}, env);
  assert.equal(capped.codexCalls.length, 0);
  assert.equal(capped.outcome.outcome, "supervisor_cap_reached");
  assert.match(capped.outcome.reason, /no attempts left this week \(1 of 1; the next frees at \d{4}-\d{2}-\d{2}T/);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.cap_reached_logged, true);
  assert.ok(state.cap_stopped_at);

  // Eight days later the run has aged out of the window: the cap is released, and
  // the blocker is diagnosed.
  state.runs[0].started_at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state));
  const events = path.join(fixture.cwd, ".research-lab", "events", `${CYCLE}-maintainer.jsonl`);
  writePause(fixture.cwd, { evidence: "yet another setup failure", phase: "prelaunch" });
  const again = run(fixture, notABug, {}, env);
  assert.equal(again.codexCalls.length, 1, "attempts are back");
  const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(after.cap_reached_logged, false);
  assert.equal(after.cap_stopped_at, null);
  assert.match(fs.readFileSync(events, "utf8"), /maintainer_cap_released/);

  // The retired lifetime variable is not read: 100 of them would have meant no cap at all.
  assert.equal(maintainerConfig({ RESEARCHLAB_MAINTAINER: "1", RESEARCHLAB_MAINTAINER_MAX_RUNS: "100" }).maxRuns, 30);
  assert.equal(maintainerConfig({ RESEARCHLAB_MAINTAINER: "1", RESEARCHLAB_MAINTAINER_MAX_RUNS_PER_WEEK: "12" }).maxRuns, 12);
});
