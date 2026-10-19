"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { buildGraphSnapshot } = require("../src/graph/graph_snapshot");

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

test("graph snapshot includes claims, evidence, tasks, artifacts, and execution lineage", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-graph-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-graph-0001";
  const laneRoot = path.join(root, "lanes", cycleId, "scout-01");
  ensureDir(laneRoot);
  ensureDir(path.join(root, "reports"));
  ensureDir(path.join(root, "state"));
  ensureDir(path.join(root, "events"));

  const reportPath = path.join(root, "reports", `${cycleId}-research-report-v0001.json`);
  writeJson(reportPath, {
    primary_claims: [
      {
        claim_id: "claim-1",
        statement: "Coverage remains positively associated with life expectancy.",
        status: "supported",
        evidence_quality_score: 92,
        supporting_hypotheses: ["h-1"],
        supporting_lanes: ["scout-01"],
        supporting_papers: ["Coverage and Survival"],
      },
    ],
    supporting_claims: [
      {
        claim_id: "claim-2",
        statement: "A single pooled effect is not stable across all regions.",
        status: "refuted",
        evidence_quality_score: 64,
        supporting_hypotheses: ["h-1"],
        supporting_lanes: ["scout-01"],
        supporting_papers: ["Regional Heterogeneity Note"],
      },
      {
        claim_id: "claim-3",
        statement: "Neonatal mortality improvements may depend on lag structure.",
        status: "inconclusive",
        evidence_quality_score: 51,
        supporting_hypotheses: ["h-1"],
        supporting_lanes: ["scout-01"],
        supporting_papers: ["Lag Structure Review"],
      },
    ],
    top_papers: [{ title: "Coverage and Survival", year: 2024 }],
  });

  writeJson(path.join(laneRoot, "lane-contract.json"), {
    runtime_class: "external-driver",
    lane_mode: "driver-exec",
    created_at: "2026-04-10T00:00:00.000Z",
  });
  writeJson(path.join(laneRoot, "role-plan.json"), {
    contract_version: "1.0",
    role: "scout",
    agent_id: "scout:scout-01",
    task_id: "task-scout-01",
    action_type: "literature-search",
    team_id: "team:cycle-graph-0001:evidence",
    provenance: {
      decision_id: "decision:cycle-graph-0001:evidence:scout",
      parent_task_id: null,
    },
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
    artifacts: [reportPath],
  });
  writeJsonl(path.join(laneRoot, "events.jsonl"), [
    {
      event_id: "lane-event-1",
      type: "lane-completed",
      created_at: "2026-04-10T00:02:00.000Z",
    },
    {
      event_id: "lane-event-2",
      type: "lane-timeout",
      severity: "error",
      message: "retrieval step exceeded timeout",
      claim_ids: ["claim-1"],
      created_at: "2026-04-10T00:02:30.000Z",
    },
  ]);

  const summary = {
    research_outcome: "refine",
    decision_mode: "refine",
    researcher_view: {
      outputPath: path.join(root, "researcher-views", `${cycleId}.json`),
      summary: {
        cycle_status: "running",
        execution_completion: "completed",
        research_outcome: "refine",
        decision_mode: "refine",
        claim_count: 1,
        approval_blockers: [],
        final_claim_package_path: path.join(root, "state", `${cycleId}-final-claim-package.json`),
        source_paths: {
          report: reportPath,
        },
      },
    },
    hypothesis_ledger: {
      outputPath: path.join(root, "state", `${cycleId}-hypothesis-ledger.json`),
      summary: {
        hypothesis_count: 1,
        focus_hypotheses: [
          {
            hypothesis_id: "h-1",
            statement: "Coverage increases life expectancy.",
            family_root: "immunization_coverage",
            latest_status: "supported",
            unresolved_gaps: [],
          },
        ],
      },
    },
    report_review: {
      reviewPath: path.join(root, "state", `${cycleId}-report-review.json`),
      review: {
        score: 96,
        pass: true,
        decision_mode: "refine",
        blockers: [],
      },
    },
    paper_review: {
      reviewPath: path.join(root, "state", `${cycleId}-paper-review.json`),
      review: {
        score: 96,
        pass: true,
        decision_mode: "refine",
        blockers: [],
      },
    },
    approval_review: {
      reviewPath: path.join(root, "state", `${cycleId}-approval-review.json`),
      review: {
        score: 88,
        pass: false,
        blockers: ["need stronger evidence"],
        decision_mode: "refine",
      },
    },
    gate_review: {
      reviewPath: path.join(root, "state", `${cycleId}-gate-review.json`),
      review: {
        score: 81,
        pass: false,
        blockers: ["pending gate rubric: novelty"],
        decision_mode: "pivot",
      },
    },
  };

  const snapshot = buildGraphSnapshot({
    cwd,
    cycleId,
    prompt: "test prompt",
    summary,
    researchStage: "evidence",
    controlState: "REVIEW",
    supervisorHistory: [{ pass: 1, stage: "evidence" }],
  });

  const nodeTypes = new Set(snapshot.nodes.map((node) => node.node_type));
  const relations = new Set(snapshot.edges.map((edge) => edge.relation));
  const scopedTaskId = `${cycleId}:task-scout-01`;

  assert.ok(nodeTypes.has("Claim"));
  assert.ok(nodeTypes.has("Evidence"));
  assert.ok(nodeTypes.has("Task"));
  assert.ok(nodeTypes.has("Artifact"));
  assert.ok(nodeTypes.has("Worker"));
  assert.ok(nodeTypes.has("SubAgent"));
  assert.ok(relations.has("SUPPORTS"));
  assert.ok(relations.has("REFUTES"));
  assert.ok(relations.has("INCONCLUSIVE_FOR"));
  assert.ok(relations.has("PRODUCES"));
  assert.ok(relations.has("RUNS_ON"));
  assert.ok(relations.has("BELONGS_TO"));
  assert.ok(relations.has("TRIGGERED_BY"));
  assert.ok(relations.has("BLOCKED_BY"));

  const artifactClaimEdge = snapshot.edges.find((edge) =>
    edge.source_node_id.startsWith("artifact:") &&
    edge.target_node_id === "claim:claim-1" &&
    edge.relation === "SUPPORTS",
  );
  assert.ok(artifactClaimEdge);

  const blockedEdge = snapshot.edges.find((edge) =>
    edge.source_node_id === `task:${scopedTaskId}` &&
    edge.relation === "BLOCKED_BY",
  );
  assert.ok(blockedEdge);

  const cycleNode = snapshot.nodes.find((node) => node.node_id === `cycle:${cycleId}`);
  assert.equal(cycleNode.state_json.execution_completion, "completed");
  assert.equal(cycleNode.state_json.research_outcome, "refine");

  const gateDecisionNode = snapshot.nodes.find((node) => node.node_id === `decision:${cycleId}:gate`);
  assert.equal(gateDecisionNode.state_json.score, 81);
  assert.equal(gateDecisionNode.state_json.decision_mode, "pivot");
  assert.deepEqual(gateDecisionNode.metadata_json.blockers, ["pending gate rubric: novelty"]);

  const eventClaimEdge = snapshot.edges.find((edge) =>
    edge.source_node_id === "event:lane-event-2" &&
    edge.target_node_id === "claim:claim-1" &&
    edge.relation === "AFFECTS",
  );
  assert.ok(eventClaimEdge);

  fs.rmSync(cwd, { recursive: true, force: true });
});
