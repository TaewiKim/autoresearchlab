"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const { ensureDir, writeJson } = require("../src/shared/json");
const { ensureMetadataStore, metadataDbPath, syncCycleMetadata } = require("../src/storage/metadata_store");
const { buildGraphSnapshot } = require("../src/graph/graph_snapshot");

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

test("metadata store indexes cycle runtime state", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-metadata-"));
  const cycleId = "cycle-test-0001";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "scout-01");
  ensureDir(laneRoot);
  ensureDir(path.join(root, "events"));
  ensureDir(path.join(root, "state"));

  writeJson(path.join(laneRoot, "lane-contract.json"), {
    runtime_class: "external-driver",
    lane_mode: "driver-exec",
    created_at: "2026-04-10T00:00:00.000Z",
  });
  writeJson(path.join(laneRoot, "role-plan.json"), {
    role: "scout",
    agent_id: "scout-01",
    task_id: "task-scout-01",
    action_type: "literature-search",
    team_id: "team:cycle-test-0001:evidence",
    team_goal: "advance the evidence stage",
  });
  writeJson(path.join(laneRoot, "run-state.json"), {
    status: "running",
    started_at: "2026-04-10T00:01:00.000Z",
  });
  writeJson(path.join(laneRoot, "final-status.json"), {
    status: "completed",
    completed_at: "2026-04-10T00:02:00.000Z",
  });
  writeJson(path.join(laneRoot, "result.json"), {
    ok: true,
  });
  writeJson(path.join(laneRoot, "artifacts.json"), {
    artifacts: [path.join(root, "reports", "artifact.md")],
  });
  writeJsonl(path.join(laneRoot, "events.jsonl"), [
    {
      event_id: "lane-event-1",
      type: "lane-completed",
      created_at: "2026-04-10T00:02:00.000Z",
    },
  ]);
  writeJsonl(path.join(root, "events", `${cycleId}-controller.jsonl`), [
    {
      event_id: "controller-event-1",
      event_type: "supervisor-pass-recorded",
      created_at: "2026-04-10T00:03:00.000Z",
      severity: "info",
    },
  ]);

  const summary = {
    researcher_view: {
      summary: {
        cycle_status: "running",
        claim_count: 2,
        approval_readiness_score: 88,
        approval_blockers: ["need stronger evidence"],
      },
      outputPath: path.join(root, "researcher-views", `${cycleId}.json`),
    },
    hypothesis_ledger: {
      outputPath: path.join(root, "state", `${cycleId}-hypothesis-ledger.json`),
      summary: {
        hypothesis_count: 1,
        focus_hypotheses: [
          {
            hypothesis_id: "h-1",
            statement: "Vaccination coverage increases life expectancy",
            family_root: "vaccination",
            latest_status: "supported",
            unresolved_gaps: [],
          },
        ],
      },
    },
    approval_review: {
      reviewPath: path.join(root, "state", `${cycleId}-approval-review.json`),
      review: {
        mode: "wait",
        approval_readiness_score: 88,
      },
    },
    gate_review: {
      reviewPath: path.join(root, "state", `${cycleId}-gate-review.json`),
      review: {
        gate_score: 75,
      },
    },
    report_review: {
      reviewPath: path.join(root, "state", `${cycleId}-report-review.json`),
      review: {
        communication_gate_passed: false,
      },
    },
    paper_review: {
      reviewPath: path.join(root, "state", `${cycleId}-paper-review.json`),
      review: {
        submission_gate_passed: false,
      },
    },
  };

  const graphSnapshot = buildGraphSnapshot({
    cycleId,
    prompt: "test prompt",
    summary,
    supervisorHistory: [{ pass: 1, stage: "evidence" }],
  });

  ensureMetadataStore({ cwd });
  syncCycleMetadata({
    cwd,
    cycleId,
    prompt: "test prompt",
    controlState: "REVIEW",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });

  const db = new DatabaseSync(metadataDbPath(cwd));
  try {
    const cycle = db.prepare("SELECT cycle_id, research_stage, control_state FROM cycles WHERE cycle_id = ?").get(cycleId);
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE cycle_id = ?").get(cycleId);
    const artifactCount = db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE cycle_id = ?").get(cycleId);
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events WHERE cycle_id = ?").get(cycleId);
    const nodeCount = db.prepare("SELECT COUNT(*) AS count FROM graph_nodes WHERE cycle_id = ?").get(cycleId);
    const teamCount = db.prepare("SELECT COUNT(*) AS count FROM teams WHERE cycle_id = ?").get(cycleId);
    assert.equal(cycle.cycle_id, cycleId);
    assert.equal(cycle.research_stage, "evidence");
    assert.equal(cycle.control_state, "REVIEW");
    assert.equal(taskCount.count, 1);
    assert.equal(teamCount.count, 1);
    assert.equal(artifactCount.count, 2);
    assert.equal(eventCount.count, 2);
    assert.ok(nodeCount.count >= 2);
  } finally {
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("metadata store upserts shared teams across multiple lanes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-metadata-team-"));
  const cycleId = "cycle-test-team-0001";
  const root = path.join(cwd, ".research-lab");
  const laneIds = ["scout-01", "analyst-01"];
  ensureDir(path.join(root, "events"));
  ensureDir(path.join(root, "state"));

  for (const laneId of laneIds) {
    const laneRoot = path.join(root, "lanes", cycleId, laneId);
    ensureDir(laneRoot);
    writeJson(path.join(laneRoot, "lane-contract.json"), {
      runtime_class: "external-driver",
      lane_mode: "driver-exec",
      created_at: "2026-04-10T00:00:00.000Z",
    });
    writeJson(path.join(laneRoot, "role-plan.json"), {
      role: laneId.startsWith("scout") ? "scout" : "analyst",
      agent_id: laneId,
      task_id: `task-${laneId}`,
      action_type: "lane-execution",
      team_id: `team:${cycleId}:evidence`,
      team_goal: "shared evidence team",
    });
    writeJson(path.join(laneRoot, "run-state.json"), {
      status: "completed",
      started_at: "2026-04-10T00:01:00.000Z",
    });
    writeJson(path.join(laneRoot, "final-status.json"), {
      status: "completed",
      completed_at: "2026-04-10T00:02:00.000Z",
    });
    writeJson(path.join(laneRoot, "result.json"), {
      ok: true,
    });
    writeJson(path.join(laneRoot, "artifacts.json"), {
      artifacts: [],
    });
  }

  const graphSnapshot = {
    nodes: [],
    edges: [],
  };

  ensureMetadataStore({ cwd });
  syncCycleMetadata({
    cwd,
    cycleId,
    prompt: "test prompt",
    controlState: "REVIEW",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });

  const db = new DatabaseSync(metadataDbPath(cwd));
  try {
    const teamCount = db.prepare("SELECT COUNT(*) AS count FROM teams WHERE cycle_id = ?").get(cycleId);
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE cycle_id = ?").get(cycleId);
    assert.equal(teamCount.count, 1);
    assert.equal(taskCount.count, 2);
  } finally {
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("metadata store tolerates duplicate artifact ids within one sync batch", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-metadata-dupartifact-"));
  const cycleId = "cycle-test-dupartifact-0001";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "lab-runner-01");
  ensureDir(laneRoot);
  ensureDir(path.join(root, "events"));
  ensureDir(path.join(root, "state"));

  writeJson(path.join(laneRoot, "lane-contract.json"), {
    runtime_class: "external-driver",
    lane_mode: "driver-exec",
    created_at: "2026-04-10T00:00:00.000Z",
  });
  writeJson(path.join(laneRoot, "role-plan.json"), {
    role: "lab-runner",
    agent_id: "lab-runner-01",
    task_id: "task-lab-runner-01",
    action_type: "validation",
    team_id: `team:${cycleId}:validation`,
    team_goal: "validate the lead",
  });
  writeJson(path.join(laneRoot, "run-state.json"), {
    status: "completed",
    started_at: "2026-04-10T00:01:00.000Z",
  });
  writeJson(path.join(laneRoot, "final-status.json"), {
    status: "completed",
    completed_at: "2026-04-10T00:02:00.000Z",
  });
  writeJson(path.join(laneRoot, "result.json"), {
    ok: true,
  });
  // A manifest that lists the same artifact path twice yields two records with an
  // identical stableId artifact_id; the sync must collapse them, not crash on the
  // artifacts.artifact_id UNIQUE constraint.
  const dupPath = path.join(root, "reports", "figure.png");
  writeJson(path.join(laneRoot, "artifacts.json"), {
    artifacts: [dupPath, dupPath],
  });

  const graphSnapshot = { nodes: [], edges: [] };

  ensureMetadataStore({ cwd });
  assert.doesNotThrow(() => {
    syncCycleMetadata({
      cwd,
      cycleId,
      prompt: "test prompt",
      controlState: "REVIEW",
      researchStage: "validation",
      status: "running",
      graphSnapshot,
    });
  });

  const db = new DatabaseSync(metadataDbPath(cwd));
  try {
    const artifactCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE cycle_id = ?")
      .get(cycleId);
    // result.json + the deduped manifest path = 2 distinct artifact ids.
    assert.equal(artifactCount.count, 2);
  } finally {
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("metadata store can resync the same cycle without foreign key failures", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-metadata-resync-"));
  const cycleId = "cycle-test-resync-0001";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "scout-01");
  ensureDir(laneRoot);
  ensureDir(path.join(root, "events"));
  ensureDir(path.join(root, "state"));

  writeJson(path.join(laneRoot, "lane-contract.json"), {
    runtime_class: "external-driver",
    lane_mode: "driver-exec",
    created_at: "2026-04-10T00:00:00.000Z",
  });
  writeJson(path.join(laneRoot, "role-plan.json"), {
    role: "scout",
    agent_id: "scout-01",
    task_id: "task-scout-01",
    action_type: "literature-search",
    team_id: `team:${cycleId}:evidence`,
    team_goal: "advance the evidence stage",
  });
  writeJson(path.join(laneRoot, "run-state.json"), {
    status: "completed",
    started_at: "2026-04-10T00:01:00.000Z",
  });
  writeJson(path.join(laneRoot, "final-status.json"), {
    status: "completed",
    completed_at: "2026-04-10T00:02:00.000Z",
  });
  writeJson(path.join(laneRoot, "result.json"), {
    ok: true,
  });
  writeJson(path.join(laneRoot, "artifacts.json"), {
    artifacts: [path.join(root, "reports", "artifact.md")],
  });
  writeJsonl(path.join(laneRoot, "events.jsonl"), [
    {
      event_id: "lane-event-1",
      type: "lane-completed",
      created_at: "2026-04-10T00:02:00.000Z",
    },
  ]);

  const graphSnapshot = {
    nodes: [
      {
        node_id: "cycle:test",
        node_type: "Cycle",
        label: cycleId,
        state_json: {},
        metadata_json: {},
        provenance_json: {},
      },
    ],
    edges: [],
  };

  ensureMetadataStore({ cwd });
  syncCycleMetadata({
    cwd,
    cycleId,
    prompt: "test prompt",
    controlState: "REVIEW",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });
  syncCycleMetadata({
    cwd,
    cycleId,
    prompt: "test prompt",
    controlState: "UPDATE",
    researchStage: "conclusion",
    status: "running",
    graphSnapshot,
  });

  const db = new DatabaseSync(metadataDbPath(cwd));
  try {
    const cycle = db.prepare("SELECT research_stage, control_state FROM cycles WHERE cycle_id = ?").get(cycleId);
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE cycle_id = ?").get(cycleId);
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events WHERE cycle_id = ?").get(cycleId);
    assert.equal(cycle.research_stage, "conclusion");
    assert.equal(cycle.control_state, "UPDATE");
    assert.equal(taskCount.count, 1);
    assert.equal(eventCount.count, 1);
  } finally {
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("metadata store scopes graph node ids per cycle", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-metadata-graphscope-"));
  const graphSnapshot = {
    nodes: [
      {
        node_id: "worker:external-driver:driver-exec",
        node_type: "Worker",
        label: "shared-worker",
        state_json: {},
        metadata_json: {},
        provenance_json: {},
      },
    ],
    edges: [],
  };

  ensureMetadataStore({ cwd });
  syncCycleMetadata({
    cwd,
    cycleId: "cycle-a",
    prompt: "prompt-a",
    controlState: "REVIEW",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });
  syncCycleMetadata({
    cwd,
    cycleId: "cycle-b",
    prompt: "prompt-b",
    controlState: "REVIEW",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });

  const db = new DatabaseSync(metadataDbPath(cwd));
  try {
    const rows = db.prepare("SELECT node_id, cycle_id FROM graph_nodes ORDER BY cycle_id").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].node_id, "cycle-a:worker:external-driver:driver-exec");
    assert.equal(rows[1].node_id, "cycle-b:worker:external-driver:driver-exec");
  } finally {
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
