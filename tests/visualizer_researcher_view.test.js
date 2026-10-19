"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { buildResearcherView } = require("../src/reporting/visualizer/researcher_view");
const { readJsonlIfExists } = require("../src/reporting/visualizer/shared");

test("visualizer JSONL reader tails oversized runtime logs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-jsonl-tail-"));
  const filePath = path.join(cwd, "events.jsonl");
  fs.writeFileSync(filePath, `${JSON.stringify({ event_type: "old" })}\n`);
  fs.appendFileSync(filePath, `${"x".repeat(64)}\n`);
  fs.appendFileSync(filePath, `${JSON.stringify({ event_type: "new" })}\n`);

  const rows = readJsonlIfExists(filePath, { maxBytes: 48 });
  assert.deepEqual(rows, [{ event_type: "new" }]);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view builds from minimal runtime state", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-"));
  const root = path.join(cwd, ".research-lab");
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    "lanes/cycle-view-0001",
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", "cycle-view-0001-cycle-plan.json"), {
    objective: "Minimal cycle",
  });
  writeJson(path.join(root, "state", "cycle-view-0001-cycle-run-state.json"), {
    status: "completed",
    lane_counts: { total: 0, running: 0, completed: 0, failed: 0 },
    lane_statuses: [],
  });
  writeJson(path.join(root, "plans", "cycle-view-0001-lab-director-literature.json"), {});
  writeJson(path.join(root, "state", "cycle-view-0001-hypothesis-ledger.json"), {
    hypotheses: [],
    focus_hypotheses: [],
    knowledge_graph: {},
  });

  const output = buildResearcherView({ cwd, cycleId: "cycle-view-0001" });
  assert.ok(output.htmlPath.endsWith(".html"));
  assert.ok(output.jsonPath.endsWith(".json"));
  assert.equal(fs.existsSync(output.htmlPath), true);
  assert.equal(fs.existsSync(output.jsonPath), true);
  assert.equal(output.summary.cycle_id, "cycle-view-0001");
  assert.ok(Array.isArray(output.summary.visual_execution_packets));
  assert.equal(output.summary.execution_completion, "completed");
  // ``research_outcome`` used to come from ``buildFinalClaimPackage`` and was
  // always one of a fixed set of WHO-decision labels; after that module was
  // deleted the researcher view leaves the field null until a replacement
  // pipeline (illustrator HTML + author narrative) populates it.
  assert.equal(output.summary.research_outcome, null);
  assert.equal(output.summary.final_claim_package_path, null);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view uses validation-summary fallback for oversized latest runner result", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-large-runner-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-view-large-runner";
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    `lanes/${cycleId}/lab-runner-01`,
    `lanes/${cycleId}/followup-runner-99`,
    `artifacts/stats/${cycleId}/followup-runner-99`,
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", `${cycleId}-cycle-plan.json`), { objective: "Large runner" });
  writeJson(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), {});
  writeJson(path.join(root, "state", `${cycleId}-hypothesis-ledger.json`), {
    hypotheses: [],
    focus_hypotheses: [],
    knowledge_graph: {},
  });
  writeJson(path.join(root, "state", `${cycleId}-cycle-run-state.json`), {
    status: "running",
    lane_counts: { total: 2, running: 0, completed: 2, failed: 0 },
    lane_statuses: [
      {
        lane_id: "lab-runner-01",
        role: "lab-runner",
        status: "completed",
        result_path: path.join(root, "lanes", cycleId, "lab-runner-01", "result.json"),
      },
      {
        lane_id: "followup-runner-99",
        role: "lab-runner",
        status: "completed",
        result_path: path.join(root, "lanes", cycleId, "followup-runner-99", "result.json"),
      },
    ],
  });
  writeJson(path.join(root, "lanes", cycleId, "lab-runner-01", "result.json"), {
    role: "lab-runner",
    validation_summary: {
      checks: { stale: true },
      checks_passed: 1,
      checks_total: 1,
      overall_status: "degraded",
    },
  });
  fs.writeFileSync(
    path.join(root, "lanes", cycleId, "followup-runner-99", "result.json"),
    JSON.stringify({
      role: "lab-runner",
      driver: "python-stats-driver",
      filler: "x".repeat(10 * 1024 * 1024 + 1),
    }),
  );
  writeJson(path.join(root, "artifacts", "stats", cycleId, "followup-runner-99", "validation-summary.json"), {
    analysis_accuracy_score: 88,
    checks: { current: true, second: true },
    checks_passed: 2,
    checks_total: 2,
    method_appropriateness_score: 92,
    overall_status: "passed",
  });
  const oldTime = new Date("2026-01-01T00:00:00Z");
  const newTime = new Date("2026-01-02T00:00:00Z");
  fs.utimesSync(path.join(root, "lanes", cycleId, "lab-runner-01", "result.json"), oldTime, oldTime);
  fs.utimesSync(
    path.join(root, "artifacts", "stats", cycleId, "followup-runner-99", "validation-summary.json"),
    newTime,
    newTime,
  );

  const output = buildResearcherView({ cwd, cycleId });

  assert.equal(output.summary.primary_evidence.lane_id, "followup-runner-99");
  assert.equal(output.summary.primary_evidence.checks_passed_count, 2);
  assert.match(output.summary.primary_evidence.source_result_path, /validation-summary\.json$/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view prefers canonical LabDirector hypothesis over stale ledger focus", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-canonical-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-view-canonical";
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    `lanes/${cycleId}`,
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", `${cycleId}-cycle-plan.json`), { objective: "Canonical focus" });
  writeJson(path.join(root, "state", `${cycleId}-cycle-run-state.json`), {
    status: "completed",
    lane_counts: { total: 0, running: 0, completed: 0, failed: 0 },
    lane_statuses: [],
  });
  writeJson(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), {});
  writeJson(path.join(root, "state", `${cycleId}-hypothesis-ledger.json`), {
    hypotheses: [],
    focus_hypotheses: [
      {
        hypothesis_id: "hyp-director-gse282742",
        statement: "Old sex-aware superiority claim that should not remain the active focus.",
        dataset_or_accession: "GSE282742",
      },
      {
        hypothesis_id: "hyp-fallback-unclassified",
        statement: "Select family `unclassified_family` and issue one executable validation handoff.",
        family_root: "unclassified_family",
      },
    ],
    knowledge_graph: {},
  });
  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    hypothesis_id: "hyp-director-gse282742",
    primary_family: "reproducibility_audit",
    dataset_or_accession: "GSE282742",
    statement:
      "Reframe GSE282742 as a same-dataset reproducibility and leakage audit of the published 8-gene P-MCI versus S-MCI result.",
    status: "selected",
  });

  const output = buildResearcherView({ cwd, cycleId });

  assert.equal(output.summary.focus_hypotheses[0].source, "lab_director_hypothesis");
  assert.equal(output.summary.focus_hypotheses[0].primary_family, "reproducibility_audit");
  assert.equal(output.summary.focus_hypotheses.length, 1);
  assert.match(output.summary.focus_hypotheses[0].statement, /same-dataset reproducibility/i);
  assert.doesNotMatch(
    output.summary.focus_hypotheses.map((item) => item.statement).join("\n"),
    /Old sex-aware superiority/i,
  );
  assert.doesNotMatch(
    output.summary.focus_hypotheses.map((item) => item.hypothesis_id).join("\n"),
    /hyp-fallback-unclassified/i,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view prefers illustrator-authored visual execution packets when available", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-illustrator-"));
  const root = path.join(cwd, ".research-lab");
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    "lanes/cycle-view-0002/illustrator-01",
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", "cycle-view-0002-cycle-plan.json"), {
    objective: "Illustrator packet precedence",
  });
  writeJson(path.join(root, "state", "cycle-view-0002-cycle-run-state.json"), {
    status: "completed",
    lane_counts: { total: 1, running: 0, completed: 1, failed: 0 },
    lane_statuses: [{ lane_id: "illustrator-01", role: "illustrator", status: "completed" }],
  });
  writeJson(path.join(root, "plans", "cycle-view-0002-lab-director-literature.json"), {
    writing_loop: {
      mode: "paper_orchestra_inspired",
      section_packets: [
        {
          section_id: "motivation-gap",
          title: "Research Gap and Motivation",
          objective: "Explain the gap.",
          citation_packets: [],
          unresolved_gaps: [],
        },
      ],
      evidence_matrix: [],
    },
  });
  writeJson(path.join(root, "state", "cycle-view-0002-hypothesis-ledger.json"), {
    hypotheses: [],
    focus_hypotheses: [],
    knowledge_graph: {},
  });
  writeJson(path.join(root, "lanes", "cycle-view-0002", "illustrator-01", "result.json"), {
    role: "illustrator",
    visual_execution_packets: [
      {
        execution_id: "visual-exec-authored-1",
        figure_id: "illustrator-authored-figure",
        figure_title: "Illustrator Authored Figure",
        priority: "highest",
        paired_takeaway: "Lead with the illustrator-authored figure.",
        chart_type: "bar",
        evidence_links: ["claim-1"],
      },
    ],
    visual_refinement_brief: {
      mode: "illustrator_authored_execution_packets",
    },
  });

  const output = buildResearcherView({ cwd, cycleId: "cycle-view-0002" });
  assert.equal(output.summary.visual_execution_mode, "illustrator_authored_execution_packets");
  assert.equal(output.summary.visual_execution_packets[0].figure_id, "illustrator-authored-figure");
  assert.ok(output.summary.visual_qa);
  assert.equal(output.summary.visual_qa.preferred_mode, "illustrator_authored_execution_packets");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view falls back when illustrator-authored packets fail visual QA", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-qa-"));
  const root = path.join(cwd, ".research-lab");
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    "lanes/cycle-view-0003/illustrator-01",
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", "cycle-view-0003-cycle-plan.json"), {
    objective: "Visual QA fallback",
  });
  writeJson(path.join(root, "state", "cycle-view-0003-cycle-run-state.json"), {
    status: "completed",
    lane_counts: { total: 1, running: 0, completed: 1, failed: 0 },
    lane_statuses: [{ lane_id: "illustrator-01", role: "illustrator", status: "completed" }],
  });
  writeJson(path.join(root, "plans", "cycle-view-0003-lab-director-literature.json"), {
    writing_loop: {
      mode: "paper_orchestra_inspired",
      section_packets: [
        {
          section_id: "motivation-gap",
          title: "Research Gap and Motivation",
          objective: "Explain the gap.",
          citation_packets: [],
          unresolved_gaps: [],
        },
      ],
      evidence_matrix: [],
    },
  });
  writeJson(path.join(root, "state", "cycle-view-0003-hypothesis-ledger.json"), {
    hypotheses: [],
    focus_hypotheses: [],
    knowledge_graph: {},
  });
  writeJson(path.join(root, "lanes", "cycle-view-0003", "illustrator-01", "result.json"), {
    role: "illustrator",
    visual_execution_packets: [
      {
        figure_id: "weak-authored-figure",
      },
    ],
  });

  const output = buildResearcherView({ cwd, cycleId: "cycle-view-0003" });
  assert.equal(output.summary.visual_execution_mode, "deterministic_baseline_plus_illustrator_refinement");
  assert.equal(output.summary.visual_qa.preferred_mode, "deterministic_baseline_plus_illustrator_refinement");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("researcher view collapses recovered lanes into completed cycle state", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-view-recovery-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-view-0004";
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    `lanes/${cycleId}/lab-runner-01`,
    `lanes/${cycleId}/author-02`,
    `lanes/${cycleId}/author-02-recovery-01`,
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", `${cycleId}-cycle-plan.json`), {
    objective: "Recovered lane collapse",
  });
  writeJson(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), {});
  writeJson(path.join(root, "state", `${cycleId}-hypothesis-ledger.json`), {
    hypotheses: [],
    focus_hypotheses: [],
    knowledge_graph: {},
  });
  writeJson(path.join(root, "state", `${cycleId}-cycle-run-state.json`), {
    status: "failed",
    lane_counts: { total: 3, running: 0, completed: 2, failed: 1 },
    lane_statuses: [
      { lane_id: "lab-runner-01", role: "lab-runner", status: "completed" },
      { lane_id: "author-02", role: "author", status: "failed" },
      { lane_id: "author-02-recovery-01", role: "author", status: "completed" },
    ],
  });

  writeJson(path.join(root, "lanes", cycleId, "lab-runner-01", "run-state.json"), {
    lane_id: "lab-runner-01",
    role: "lab-runner",
    runtime_class: "external-driver",
    status: "completed",
  });
  writeJson(path.join(root, "lanes", cycleId, "lab-runner-01", "final-status.json"), {
    lane_id: "lab-runner-01",
    status: "completed",
    completed_at: "2026-04-15T00:00:00Z",
  });
  writeJson(path.join(root, "lanes", cycleId, "lab-runner-01", "result.json"), { ok: true });

  writeJson(path.join(root, "lanes", cycleId, "author-02", "run-state.json"), {
    lane_id: "author-02",
    role: "author",
    runtime_class: "codex-agent",
    status: "failed",
  });
  writeJson(path.join(root, "lanes", cycleId, "author-02", "final-status.json"), {
    lane_id: "author-02",
    status: "failed",
    completed_at: "2026-04-15T00:01:00Z",
  });
  writeJson(path.join(root, "lanes", cycleId, "author-02", "result.json"), { status: "failed" });

  writeJson(path.join(root, "lanes", cycleId, "author-02-recovery-01", "run-state.json"), {
    lane_id: "author-02-recovery-01",
    role: "author",
    runtime_class: "codex-agent",
    status: "completed",
  });
  writeJson(path.join(root, "lanes", cycleId, "author-02-recovery-01", "final-status.json"), {
    lane_id: "author-02-recovery-01",
    status: "completed",
    completed_at: "2026-04-15T00:02:00Z",
  });
  writeJson(path.join(root, "lanes", cycleId, "author-02-recovery-01", "result.json"), { status: "completed" });

  const output = buildResearcherView({ cwd, cycleId });
  const cycleState = JSON.parse(
    fs.readFileSync(path.join(root, "state", `${cycleId}-cycle-run-state.json`), "utf8"),
  );

  assert.equal(output.summary.execution_completion, "completed");
  assert.equal(output.summary.cycle_status, "completed");
  assert.equal(cycleState.status, "completed");
  assert.equal(cycleState.lane_counts.failed, 0);
  assert.equal(cycleState.lane_statuses.length, 2);
  assert.equal(cycleState.lane_statuses[0].lane_id, "author-02-recovery-01");

  fs.rmSync(cwd, { recursive: true, force: true });
});
