"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "src", "cli", "index.js");
const cwd = path.join(__dirname, "..");

function stopCycleProcesses(cycleId) {
  const currentPid = process.pid;
  let candidates = [];
  const collect = () => {
    const result = spawnSync("ps", ["-eo", "pid=,command="], {
      encoding: "utf8",
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean)
      .filter(({ pid, command }) => (
        pid !== currentPid &&
        command.includes(cycleId) &&
        /researchlab-harness|watch_cycle_long_run|resume-cycle|run-plan|run-lane|refresh-cycle|data_scout_browser/.test(command)
      ));
  };

  for (const signal of ["SIGTERM", "SIGKILL"]) {
    candidates = collect();
    for (const { pid } of candidates) {
      try {
        process.kill(pid, signal);
      } catch (_) {
        // Process already exited.
      }
    }
    spawnSync("sleep", [signal === "SIGTERM" ? "0.2" : "0.05"]);
  }
}

function rmSyncRetry(filePath, options) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(filePath, options);
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code) || attempt === 5) {
        throw error;
      }
      spawnSync("sleep", ["0.1"]);
    }
  }
}

test("CLI help exposes watch-cycle command", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /watch-cycle --cycle-id <id>/);
  assert.match(result.stdout, /refresh-gate --cycle-id <id>/);
});

test("watch-cycle help documents daemon and once modes", () => {
  const result = spawnSync(process.execPath, [cliPath, "watch-cycle", "--help"], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--daemon/);
  assert.match(result.stdout, /--once/);
  assert.match(result.stdout, /--interval-seconds <n>/);
});

test("watch-cycle watchdog starts resume-cycle through the CLI entrypoint file", () => {
  const script = fs.readFileSync(path.join(cwd, "scripts", "watchdog", "open_source_agent_path.sh"), "utf8");
  assert.match(script, /node \.\/src\/cli\/index\.js resume-cycle/);
  assert.match(script, /node \.\/src\/cli\/index\.js refresh-cycle/);
  assert.doesNotMatch(script, /node \.\/src\/cli resume-cycle/);
  assert.doesNotMatch(script, /node \.\/src\/cli refresh-cycle/);
});

test("watch-cycle does not immediately restart a resume-cycle it just started", () => {
  const cycleId = `cycle-watch-resume-start-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const laneRoot = path.join(root, "lanes", cycleId);
  const laneDir = path.join(laneRoot, "followup-lab-director-01");
  const eventsDir = path.join(root, "events");
  const runLogs = path.join(root, "run-logs");
  const runtimeDir = path.join(root, "runtime");
  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(laneRoot, { recursive: true, force: true });
    rmSyncRetry(path.join(stateDir, `${cycleId}-cycle-run-state.json`), { force: true });
    rmSyncRetry(path.join(eventsDir, `${cycleId}-cycle-events.jsonl`), { force: true });
    rmSyncRetry(path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`), { force: true });
    rmSyncRetry(path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`), { force: true });
    rmSyncRetry(path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`), { force: true });
    rmSyncRetry(path.join(runLogs, `${cycleId}-watchdog-10min.pid`), { force: true });
    rmSyncRetry(path.join(runLogs, `${cycleId}-watchdog-last-restart.epoch`), { force: true });
    for (const entry of fs.existsSync(runLogs) ? fs.readdirSync(runLogs) : []) {
      if (entry.startsWith(`${cycleId}-resume-continuous-watchdog-`)) {
        rmSyncRetry(path.join(runLogs, entry), { force: true });
      }
    }
  };

  cleanup();
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 1, running: 0, completed: 0, failed: 0, total: 1 },
        lane_statuses: [{ lane_id: "followup-lab-director-01", role: "lab-director", status: "pending" }],
      })}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_NO_PROGRESS_SECONDS: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /issue=resume_cycle_not_running/);
    assert.match(result.stdout, /action=start_resume_cycle/);
    assert.doesNotMatch(result.stdout, /action=restart_resume_cycle/);
    assert.doesNotMatch(result.stdout, /action=stop_resume_cycle/);
  } finally {
    cleanup();
  }
});

test("watch-cycle reports to supervisor and escalates research issues to lab-director", () => {
  const cycleId = `cycle-watch-test-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const statsDir = path.join(root, "artifacts", "stats", cycleId, "followup-analyst-001");
  const runningLaneDir = path.join(root, "lanes", cycleId, "lab-runner-01");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(runningLaneDir, { recursive: true });

  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "artifacts", "stats", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-context-refresh.epoch`),
      path.join(root, "run-logs", `${cycleId}-watchdog-context-refresh.pid`),
      path.join(root, "run-logs", "labdirector-instructions", `${cycleId}-latest_analyst_handoff_missing_selected_open_source_agent.epoch`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(statsDir, { recursive: true });
    fs.mkdirSync(runningLaneDir, { recursive: true });
    fs.writeFileSync(
      path.join(runningLaneDir, "run-state.json"),
      `${JSON.stringify({
        lane_id: "lab-runner-01",
        role: "lab-runner",
        runtime_class: "external-driver",
        status: "running",
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(runningLaneDir, "process.json"),
      `${JSON.stringify({
        lane_id: "lab-runner-01",
        role: "lab-runner",
        runtime_class: "external-driver",
        pid: process.pid,
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 0, running: 1, completed: 0, failed: 0, total: 1 },
        lane_statuses: [{ lane_id: "lab-runner-01", role: "lab-runner", status: "running" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(statsDir, "handoff-validation-plan.json"),
      `${JSON.stringify({ validation_plan: [] })}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reportLines = fs.readFileSync(
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/);
    const report = JSON.parse(reportLines[reportLines.length - 1]);
    assert.equal(report.to_role, "supervisor");
    assert.equal(report.from_role, "watch-cycle");
    assert.equal(report.report_scope, "process_progress_only");
    assert.equal(report.issue_count, 1);
    assert.equal(report.issue_owner_counts["lab-director"], 1);
    assert.equal(report.issues, undefined);
    assert.equal(report.role_boundary, undefined);
    assert.equal(report.lab_director_instruction_count, 1);
    assert.equal(report.lab_director_instructions, undefined);
    const researcherReport = JSON.parse(fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      "utf8",
    ));
    assert.equal(researcherReport.to_role, "researcher");
    assert.equal(researcherReport.status, "watchdog_researcher_report");
    assert.equal(researcherReport.report_scope, "process_progress_only");
    assert.match(researcherReport.message, /Watchdog process/);
    assert.equal(researcherReport.issue_count, 1);
    assert.equal(researcherReport.issues, undefined);
    assert.equal(researcherReport.role_boundary, undefined);
    assert.doesNotMatch(researcherReport.message, /latest_analyst_handoff_missing_selected_open_source_agent/);
    assert.equal(researcherReport.lab_director_instruction_count, 1);

    const inboxLines = fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/);
    const inbox = JSON.parse(inboxLines[inboxLines.length - 1]);
    assert.equal(inbox.type, "supervisor_instruction");
    assert.equal(inbox.payload.author, "supervisor");
    assert.equal(inbox.payload.source, "watch-cycle");
    assert.equal(inbox.payload.issue_code, "latest_analyst_handoff_missing_selected_open_source_agent");
    assert.equal(inbox.payload.requested_action.supervisor_scope, "process_escalation_only");
    assert.equal(inbox.payload.requested_action.lab_director_must_author_research_instruction, true);
    assert.match(inbox.payload.message, /LabDirector must author/);
    assert.doesNotMatch(inbox.payload.message, /Revise the research handoff/);
    // The watchdog RAISES onto the bus; it no longer writes a role's mailbox.
    // Those files are the bus's projection, rebuilt from the registry on every
    // refresh, so anything written into them directly is overwritten -- and the
    // bus, not the producer, owns identity, capacity and delivery.
    const raisedPath = path.join(root, "messages", cycleId, "raised.jsonl");
    assert.equal(fs.existsSync(raisedPath), true, "the watchdog raised nothing onto the bus");
    const raised = fs.readFileSync(raisedPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const toDirector = raised.filter((entry) => (entry.to_roles || []).includes("lab-director"));
    assert.ok(toDirector.length > 0, "nothing the watchdog raised is addressed to the director");
    assert.ok(
      toDirector.some((entry) => entry.payload?.issue_code === "latest_analyst_handoff_missing_selected_open_source_agent"),
      "the issue the watchdog found did not reach the director",
    );
    const toSupervisor = raised.filter((entry) => (entry.to_roles || []).includes("supervisor"));
    assert.ok(toSupervisor.length > 0, "the supervisor was told nothing");
    assert.ok(
      toSupervisor.some((entry) => entry.payload?.report_scope === "process_progress_only"),
      "the watchdog's report to the supervisor lost its scope",
    );
    // Nobody owes the supervisor an answer for a status report, so it is raised
    // without an `asks_for` -- which is what makes it a standing message on the
    // bus rather than an open request nothing will ever close.
    assert.ok(toSupervisor.every((entry) => !entry.asks_for), "a status report was raised as a question");

    const dialogue = fs.readFileSync(
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      "utf8",
    );
    assert.match(dialogue, /supervisor_to_labdirector_instruction/);
    assert.doesNotMatch(dialogue, /watchdog_researcher_report/);
  } finally {
    cleanup();
  }
});

test("watch-cycle supervisor escalates repeated scout discovery without materialization", () => {
  const cycleId = `cycle-watch-scout-stagnation-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const lanesDir = path.join(root, "lanes", cycleId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(lanesDir, { recursive: true });

  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "artifacts", "stats", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-context-refresh.epoch`),
      path.join(root, "run-logs", `${cycleId}-watchdog-context-refresh.pid`),
      path.join(root, "run-logs", "labdirector-instructions", `${cycleId}-scout_discovery_without_materialization_stagnation.epoch`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(lanesDir, { recursive: true });
    const laneStatuses = [];
    for (let index = 1; index <= 3; index += 1) {
      const laneId = `followup-scout-00${index}`;
      const laneDir = path.join(lanesDir, laneId);
      fs.mkdirSync(laneDir, { recursive: true });
      fs.writeFileSync(
        path.join(laneDir, "result.json"),
        `${JSON.stringify({
          status: "completed",
          candidate_count: 36,
          open_candidate_count: 36,
          candidates_with_accession: 36,
          fetched_bundle_count: 0,
        })}\n`,
        "utf8",
      );
      laneStatuses.push({ lane_id: laneId, role: "scout", status: "completed" });
    }
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 0, running: 0, completed: 3, failed: 0, total: 3 },
        lane_statuses: laneStatuses,
      })}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_SCOUT_MATERIALIZATION_STAGNATION_LIMIT: "3",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reportLines = fs.readFileSync(
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/);
    const report = JSON.parse(reportLines[reportLines.length - 1]);
    assert.equal(report.report_scope, "process_progress_only");
    assert.ok(report.issue_count >= 1);
    assert.ok(report.issue_owner_counts["lab-director"] >= 1);
    assert.equal(report.issues, undefined);
    assert.ok(report.lab_director_instruction_count >= 1);
    const researcherReport = JSON.parse(fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      "utf8",
    ));
    assert.equal(researcherReport.to_role, "researcher");
    assert.equal(researcherReport.report_scope, "process_progress_only");
    assert.ok(researcherReport.issue_count >= 1);
    assert.equal(researcherReport.issues, undefined);
    assert.doesNotMatch(researcherReport.message, /scout_discovery_without_materialization_stagnation/);

    const inboxLines = fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/);
    const inbox = JSON.parse(inboxLines[inboxLines.length - 1]);
    assert.equal(inbox.payload.issue_code, "scout_discovery_without_materialization_stagnation");
    assert.equal(inbox.payload.requested_action.supervisor_scope, "process_escalation_only");
    assert.match(inbox.payload.message, /LabDirector must author/);
    assert.match(inbox.payload.message, /Supervisor is not choosing/);
    assert.doesNotMatch(inbox.payload.message, /Stop scheduling another generic scout loop/);
  } finally {
    cleanup();
  }
});

test("scout materialization stagnation reads bounded cycle-state result paths", () => {
  const cycleId = `cycle-watch-scout-state-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const resultDir = path.join(root, "tmp", cycleId);
  const scriptPath = path.join(cwd, "scripts", "watchdog", "scout_materialization_stagnation.js");
  const cleanup = () => {
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    rmSyncRetry(resultDir, { recursive: true, force: true });
    rmSyncRetry(path.join(stateDir, `${cycleId}-cycle-run-state.json`), { force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const lane_statuses = [];
    for (const id of [198, 199, 200]) {
      const laneId = `followup-scout-${id}`;
      const resultPath = path.join(resultDir, `${laneId}.json`);
      fs.writeFileSync(
        resultPath,
        `${JSON.stringify({
          status: "completed",
          candidate_count: 12,
          open_candidate_count: 12,
          candidates_with_accession: 12,
          fetched_bundle_count: 0,
        })}\n`,
        "utf8",
      );
      lane_statuses.push({ lane_id: laneId, role: "scout", status: "completed", result_path: resultPath });
    }
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({ status: "running", lane_statuses })}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [scriptPath, root, cycleId, "3"], {
      cwd,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.lane_ids, ["followup-scout-200", "followup-scout-199", "followup-scout-198"]);
    assert.equal(summary.totals.fetched_bundle_count, 0);
    assert.equal(summary.totals.candidates_with_accession, 36);
  } finally {
    cleanup();
  }
});

test("scout materialization stagnation catches fetched bundles without data graph updates", () => {
  const cycleId = `cycle-watch-scout-graph-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const resultDir = path.join(root, "tmp", cycleId);
  const scriptPath = path.join(cwd, "scripts", "watchdog", "scout_materialization_stagnation.js");
  const cleanup = () => {
    rmSyncRetry(resultDir, { recursive: true, force: true });
    rmSyncRetry(path.join(stateDir, `${cycleId}-cycle-run-state.json`), { force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const lane_statuses = [];
    for (const id of [301, 302, 303]) {
      const laneId = `followup-scout-${id}`;
      const resultPath = path.join(resultDir, `${laneId}.json`);
      fs.writeFileSync(
        resultPath,
        `${JSON.stringify({
          status: "completed",
          candidate_count: 34,
          open_candidate_count: 34,
          candidates_with_accession: 34,
          fetched_bundle_count: 4,
          data_graph_update_path: null,
        })}\n`,
        "utf8",
      );
      lane_statuses.push({ lane_id: laneId, role: "scout", status: "completed", result_path: resultPath });
    }
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({ status: "running", lane_statuses })}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [scriptPath, root, cycleId, "3"], {
      cwd,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.lane_ids, ["followup-scout-303", "followup-scout-302", "followup-scout-301"]);
    assert.equal(summary.totals.fetched_bundle_count, 12);
    assert.equal(summary.totals.data_graph_update_count, 0);
  } finally {
    cleanup();
  }
});

test("watch-cycle escalates repeated unchanged gate score", () => {
  const cycleId = `cycle-watch-gate-score-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const laneDir = path.join(root, "lanes", cycleId, "followup-runner-active");
  const scriptPath = path.join(cwd, "scripts", "watchdog", "gate_score_stagnation.js");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(laneDir, { recursive: true });

  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(stateDir, `${cycleId}-gate-review.json`),
      path.join(stateDir, `${cycleId}-approval-review.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-context-refresh.epoch`),
      path.join(root, "run-logs", `${cycleId}-watchdog-context-refresh.pid`),
      path.join(root, "run-logs", `${cycleId}-gate-score-stagnation-history.json`),
      path.join(root, "run-logs", "labdirector-instructions", `${cycleId}-gate_score_stagnation.epoch`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(
      path.join(laneDir, "run-state.json"),
      `${JSON.stringify({
        lane_id: "followup-runner-active",
        role: "lab-runner",
        runtime_class: "external-driver",
        status: "running",
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(laneDir, "process.json"),
      `${JSON.stringify({
        lane_id: "followup-runner-active",
        role: "lab-runner",
        runtime_class: "external-driver",
        pid: process.pid,
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 0, running: 1, completed: 12, failed: 0, total: 13 },
        lane_statuses: [{ lane_id: "followup-runner-active", role: "lab-runner", status: "running" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-gate-review.json`),
      `${JSON.stringify({
        score: 63,
        gate_passed: false,
        gatekeeper_review_status: "superseded",
        lab_director_response_status: "current",
        gatekeeper_pending_rubrics: ["technical_quality", "strobe_reporting_completeness"],
        blockers: ["missing current-hypothesis independent gatekeeper rubric"],
        recommended_followup_actions: [{ type: "independent_gate_review_followup" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-approval-review.json`),
      `${JSON.stringify({
        approval_gate_passed: false,
        approval_readiness_score: 63,
        approval_stage_summary: {
          score_limiting_stage: { name: "hypothesis", score: 63 },
        },
      })}\n`,
      "utf8",
    );

    for (let index = 0; index < 2; index += 1) {
      const result = spawnSync(process.execPath, [scriptPath, root, cycleId, "3"], {
        cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_WINDOW: "3",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /issue=gate_score_stagnation/);
    assert.match(result.stdout, /action=refresh_gate_outputs cycle_id=.* mode=gate_fast/);
    assert.match(result.stdout, /gate-refresh-summary:/);
    assert.match(result.stdout, /action=start_resume_cycle/);
    const inboxLines = fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const stagnation = inboxLines.find((line) => line.payload.issue_code === "gate_score_stagnation");
    assert.ok(stagnation);
    assert.equal(stagnation.payload.severity, "research_blocker");
    assert.match(stagnation.payload.detail, /gate_score=63/);
    assert.match(stagnation.payload.detail, /score_limiting_stage=hypothesis/);
    assert.match(stagnation.payload.message, /stop broad repeated discovery/);

    const history = JSON.parse(fs.readFileSync(
      path.join(root, "run-logs", `${cycleId}-gate-score-stagnation-history.json`),
      "utf8",
    ));
    assert.equal(history.snapshots.length, 3);
  } finally {
    cleanup();
  }
});

test("watch-cycle restarts live supervisor when gate stagnation leaves pending lanes idle", () => {
  const cycleId = `cycle-watch-gate-deadlock-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const laneDir = path.join(root, "lanes", cycleId, "followup-gatekeeper-01");
  const scriptPath = path.join(cwd, "scripts", "watchdog", "gate_score_stagnation.js");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(laneDir, { recursive: true });

  let dummyResume = null;
  const cleanup = () => {
    if (dummyResume && !dummyResume.killed) {
      try {
        dummyResume.kill("SIGKILL");
      } catch (_) {
        // Process already exited.
      }
    }
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(stateDir, `${cycleId}-gate-review.json`),
      path.join(stateDir, `${cycleId}-approval-review.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-restart.epoch`),
      path.join(root, "run-logs", `${cycleId}-gate-score-stagnation-history.json`),
      path.join(root, "run-logs", "labdirector-instructions", `${cycleId}-gate_score_stagnation.epoch`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(
      path.join(laneDir, "lane-contract.json"),
      `${JSON.stringify({
        cycle_id: cycleId,
        lane_id: "followup-gatekeeper-01",
        role: "gatekeeper",
        runtime_class: "codex-agent",
        task_file: path.join(laneDir, "task.md"),
        output_artifact: path.join(laneDir, "result.json"),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(laneDir, "task.md"), "Review gate.\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 1, running: 0, completed: 10, failed: 0, total: 11 },
        lane_statuses: [{ lane_id: "followup-gatekeeper-01", role: "gatekeeper", runtime_class: "codex-agent", status: "pending" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-gate-review.json`),
      `${JSON.stringify({
        score: 63,
        gate_passed: false,
        gatekeeper_review_status: "superseded",
        lab_director_response_status: "current",
        gatekeeper_pending_rubrics: ["technical_quality"],
        blockers: ["pending gate rubric: technical_quality"],
        recommended_followup_actions: [{ type: "independent_gate_review_followup", target_rubric: "technical_quality" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-approval-review.json`),
      `${JSON.stringify({
        approval_gate_passed: false,
        approval_readiness_score: 63,
        approval_stage_summary: {
          score_limiting_stage: { name: "hypothesis", score: 63 },
        },
      })}\n`,
      "utf8",
    );
    for (let index = 0; index < 2; index += 1) {
      const result = spawnSync(process.execPath, [scriptPath, root, cycleId, "3"], {
        cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    dummyResume = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "resume-cycle",
      "--cycle-id",
      cycleId,
    ], {
      cwd,
      stdio: "ignore",
      detached: true,
    });
    spawnSync("sleep", ["0.2"]);
    fs.mkdirSync(path.join(root, "run-logs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "run-logs", `${cycleId}-watchdog-last-restart.epoch`),
      `${Math.floor(Date.now() / 1000)}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_WINDOW: "3",
        RESEARCHLAB_WATCH_NO_PROGRESS_SECONDS: "0",
        RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS: "600",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /issue=gate_score_stagnation/);
    assert.match(result.stdout, /issue=pending_lanes_without_progress_under_gate_stagnation/);
    assert.match(result.stdout, /action=restart_resume_cycle reason=pending_lanes_without_progress_under_gate_stagnation/);
    assert.doesNotMatch(result.stdout, /action=restart_skipped reason=pending_lanes_without_progress_under_gate_stagnation/);
    assert.doesNotMatch(result.stdout, /action=start_resume_cycle_skipped reason=supervisor_already_running/);
  } finally {
    cleanup();
  }
});

test("watch-cycle does not restart after gate refresh finds running lanes", () => {
  const cycleId = `cycle-watch-gate-running-refresh-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const laneDir = path.join(root, "lanes", cycleId, "followup-gatekeeper-01");
  const scriptPath = path.join(cwd, "scripts", "watchdog", "gate_score_stagnation.js");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(laneDir, { recursive: true });

  let dummyResume = null;
  const cleanup = () => {
    if (dummyResume && !dummyResume.killed) {
      try {
        dummyResume.kill("SIGKILL");
      } catch (_) {
        // Process already exited.
      }
    }
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(stateDir, `${cycleId}-gate-review.json`),
      path.join(stateDir, `${cycleId}-approval-review.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-restart.epoch`),
      path.join(root, "run-logs", `${cycleId}-gate-score-stagnation-history.json`),
      path.join(root, "run-logs", "labdirector-instructions", `${cycleId}-gate_score_stagnation.epoch`),
      path.join(runtimeDir, `${cycleId}-refresh-gate-stub.json`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(
      path.join(laneDir, "lane-contract.json"),
      `${JSON.stringify({
        cycle_id: cycleId,
        lane_id: "followup-gatekeeper-01",
        role: "gatekeeper",
        runtime_class: "codex-agent",
        task_file: path.join(laneDir, "task.md"),
        output_artifact: path.join(laneDir, "result.json"),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(laneDir, "task.md"), "Review gate.\n", "utf8");
    fs.writeFileSync(
      path.join(laneDir, "run-state.json"),
      `${JSON.stringify({
        lane_id: "followup-gatekeeper-01",
        role: "gatekeeper",
        status: "running",
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 1, running: 0, completed: 10, failed: 0, total: 11 },
        lane_statuses: [{ lane_id: "followup-gatekeeper-01", role: "gatekeeper", runtime_class: "codex-agent", status: "pending" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-gate-review.json`),
      `${JSON.stringify({
        score: 63,
        gate_passed: false,
        gatekeeper_review_status: "superseded",
        lab_director_response_status: "current",
        gatekeeper_pending_rubrics: ["technical_quality"],
        blockers: ["pending gate rubric: technical_quality"],
        recommended_followup_actions: [{ type: "independent_gate_review_followup", target_rubric: "technical_quality" }],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-approval-review.json`),
      `${JSON.stringify({
        approval_gate_passed: false,
        approval_readiness_score: 63,
        approval_stage_summary: {
          score_limiting_stage: { name: "hypothesis", score: 63 },
        },
      })}\n`,
      "utf8",
    );
    for (let index = 0; index < 2; index += 1) {
      const result = spawnSync(process.execPath, [scriptPath, root, cycleId, "3"], {
        cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const refreshGateStubPath = path.join(runtimeDir, `${cycleId}-refresh-gate-stub.json`);
    fs.writeFileSync(
      refreshGateStubPath,
      `${JSON.stringify({
        cycle_id: cycleId,
        refresh_gate_fast: true,
        cycle_state: {
          lane_counts: { pending: 0, running: 1, completed: 10, failed: 0, total: 11 },
        },
        approval_review: {
          approval_readiness_score: 63,
          approval_stage_summary: { score_limiting_stage: { name: "hypothesis", score: 63 } },
        },
        gate_review: {
          score: 63,
          gatekeeper_review_status: "superseded",
          pending_rubrics: ["technical_quality"],
          recommended_followup_actions: [{ type: "independent_gate_review_followup", target_rubric: "technical_quality" }],
        },
      })}\n`,
      "utf8",
    );

    dummyResume = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "resume-cycle",
      "--cycle-id",
      cycleId,
    ], {
      cwd,
      stdio: "ignore",
      detached: true,
    });
    spawnSync("sleep", ["0.2"]);
    fs.mkdirSync(path.join(root, "run-logs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "run-logs", `${cycleId}-watchdog-last-restart.epoch`),
      `${Math.floor(Date.now() / 1000)}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_WINDOW: "3",
        RESEARCHLAB_WATCH_NO_PROGRESS_SECONDS: "0",
        RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS: "600",
        RESEARCHLAB_WATCH_REFRESH_GATE_STUB: refreshGateStubPath,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /issue=gate_score_stagnation/);
    assert.match(result.stdout, /gate-refresh-summary: .*"running":1/);
    assert.doesNotMatch(result.stdout, /issue=pending_lanes_without_progress_under_gate_stagnation/);
    assert.doesNotMatch(result.stdout, /action=restart_resume_cycle reason=pending_lanes_without_progress_under_gate_stagnation/);
    assert.match(result.stdout, /action=start_resume_cycle_skipped reason=supervisor_already_running/);
  } finally {
    cleanup();
  }
});

test("watch-cycle supervisor escalates evidence-flow quality anomalies", () => {
  const cycleId = `cycle-watch-quality-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const lanesDir = path.join(root, "lanes", cycleId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(lanesDir, { recursive: true });

  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "artifacts", "stats", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(stateDir, `${cycleId}-gate-review.json`),
      path.join(stateDir, `${cycleId}-agent-communication-digest.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-context-refresh.epoch`),
      path.join(root, "run-logs", `${cycleId}-watchdog-context-refresh.pid`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    const laneStatuses = [
      { lane_id: "followup-lab-director-001", role: "lab-director", status: "failed" },
      { lane_id: "followup-runner-100", role: "lab-runner", status: "completed" },
      { lane_id: "followup-runner-102", role: "lab-runner", status: "completed" },
      { lane_id: "followup-scout-201", role: "scout", status: "completed" },
      { lane_id: "followup-scout-202", role: "scout", status: "completed" },
    ];
    for (const lane of laneStatuses) {
      const laneDir = path.join(lanesDir, lane.lane_id);
      fs.mkdirSync(laneDir, { recursive: true });
      const result = lane.role === "scout"
        ? {
          status: "completed",
          paper_count: 12,
          candidate_primary_families: [],
          papers: [
            { title: "Concrete decarbonization policy options" },
            { title: "Artificial intelligence in electrocardiography" },
            { title: "Tumor initiation molecular mechanisms" },
            { title: "Deep learning interpretability survey" },
            { title: "Building automation analytics review" },
          ],
        }
        : { status: "completed", validation_summary: { overall_status: "passed" } };
      fs.writeFileSync(path.join(laneDir, "result.json"), `${JSON.stringify(result)}\n`, "utf8");
    }
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 0, running: 0, completed: 4, failed: 1, total: 5 },
        lane_statuses: laneStatuses,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-gate-review.json`),
      `${JSON.stringify({ latest_validation_lane_id: "followup-runner-100", gate_passed: false })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-agent-communication-digest.json`),
      `${JSON.stringify({
        current_focus: {
          lead_hypothesis: "GSE228779 GeoMx VILI AIH liver-cell mitochondrial oxidative interferon decoupling",
          dataset: "GSE228779",
        },
      })}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS: "0",
        RESEARCHLAB_WATCH_GATE_LAG_SECONDS: "0",
        RESEARCHLAB_WATCH_SCOUT_NO_FAMILY_LIMIT: "2",
        RESEARCHLAB_WATCH_STALE_FAILED_ORDINAL_GAP: "50",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const inboxLines = fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const issueCodes = new Set(inboxLines.map((line) => line.payload.issue_code));
    assert.equal(issueCodes.has("gate_refresh_lag_after_runner_completion"), true);
    assert.equal(issueCodes.has("scout_no_candidate_families_stagnation"), true);
    assert.equal(issueCodes.has("scout_topicality_failure"), true);
    assert.equal(issueCodes.has("stale_failed_blocking_lanes_persist"), true);
    assert.equal(inboxLines.every((line) => line.payload.requested_action.supervisor_scope === "process_escalation_only"), true);
    assert.equal(inboxLines.every((line) => line.payload.requested_action.supervisor_must_not_author_analysis_plan === true), true);

    const report = JSON.parse(fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      "utf8",
    ));
    assert.ok(report.issue_count >= 4);
    assert.ok(report.issue_owner_counts["lab-director"] >= 4);
    assert.equal(report.issues, undefined);
  } finally {
    cleanup();
  }
});

test("watch-cycle detects and heals stale or dead running lane processes", () => {
  const cycleId = `cycle-watch-stale-running-${process.pid}-${Date.now()}`;
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(root, "events");
  const runtimeDir = path.join(root, "runtime");
  const laneId = "followup-scout-stale-001";
  const lanesDir = path.join(root, "lanes", cycleId);
  const laneDir = path.join(lanesDir, laneId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(laneDir, { recursive: true });

  const cleanup = () => {
    stopCycleProcesses(cycleId);
    rmSyncRetry(path.join(root, "artifacts", "stats", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "lanes", cycleId), { recursive: true, force: true });
    [
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-researcher-watchdog-reports.jsonl`),
      path.join(eventsDir, `${cycleId}-supervisor-actions.jsonl`),
      path.join(eventsDir, `${cycleId}-labdirector-dialogue.jsonl`),
      path.join(runtimeDir, `${cycleId}-labdirector-inbox.jsonl`),
      path.join(runtimeDir, `${cycleId}-supervisor-watchdog-report.json`),
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      path.join(root, "run-logs", `${cycleId}-watchdog-10min.pid`),
      path.join(root, "run-logs", `${cycleId}-watchdog-last-context-refresh.epoch`),
      path.join(root, "run-logs", `${cycleId}-watchdog-context-refresh.pid`),
    ].forEach((filePath) => rmSyncRetry(filePath, { force: true }));
    rmSyncRetry(path.join(root, "memory", cycleId), { recursive: true, force: true });
    rmSyncRetry(path.join(root, "messages", cycleId), { recursive: true, force: true });
  };

  cleanup();
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    const startedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(laneDir, "run-state.json"),
      `${JSON.stringify({
        lane_id: laneId,
        role: "scout",
        runtime_class: "external-driver",
        status: "running",
        started_at: startedAt,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(laneDir, "process.json"),
      `${JSON.stringify({
        lane_id: laneId,
        role: "scout",
        runtime_class: "external-driver",
        pid: 99999999,
        started_at: startedAt,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-run-state.json`),
      `${JSON.stringify({
        status: "running",
        lane_counts: { pending: 0, running: 1, completed: 0, failed: 0, total: 1 },
        lane_statuses: [{ lane_id: laneId, role: "scout", runtime_class: "external-driver", status: "running" }],
      })}\n`,
      "utf8",
    );

    const result = spawnSync("bash", ["scripts/watch_cycle_long_run.sh", cycleId, "1", "--once"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND: "0",
        RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reportLines = fs.readFileSync(
      path.join(eventsDir, `${cycleId}-supervisor-watchdog-reports.jsonl`),
      "utf8",
    ).trim().split(/\r?\n/);
    const report = JSON.parse(reportLines[reportLines.length - 1]);
    assert.equal(report.report_scope, "process_progress_only");
    assert.equal(report.issue_count, 1);
    assert.equal(report.issue_owner_counts.supervisor, 1);
    assert.equal(report.issues, undefined);
    assert.equal(fs.existsSync(path.join(laneDir, "run-state.json")), false);
    assert.equal(
      fs.readdirSync(laneDir).some((entry) => entry.startsWith("run-state.json.self-heal-") && entry.endsWith(".bak")),
      true,
    );

    const researcherReport = JSON.parse(fs.readFileSync(
      path.join(runtimeDir, `${cycleId}-researcher-watchdog-report.json`),
      "utf8",
    ));
    assert.equal(researcherReport.report_scope, "process_progress_only");
    assert.equal(researcherReport.issue_count, 1);
    assert.doesNotMatch(researcherReport.message, /stale_or_zombie_running_lanes/);
  } finally {
    cleanup();
  }
});
