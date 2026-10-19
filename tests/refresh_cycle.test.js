"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { refreshCycleOutputs, refreshCycleContextOutputs } = require("../src/reporting/refresh_cycle");
const { ensureCycleMemory } = require("../src/reporting/cycle_memory");
const { ensureLabDirectorResearchNotes } = require("../src/reporting/lab_director_research_notes");
const { ensureAnalystResearchNotes } = require("../src/reporting/analyst_research_notes");

test("refresh preserves existing LabDirector research notebook", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-preserve-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-notes-preserve-0001";
  ensureDir(path.join(root, "state"));
  const jsonPath = path.join(root, "state", `${cycleId}-lab-director-research-notes.json`);
  const markdownPath = path.join(root, "state", `${cycleId}-lab-director-research-notes.md`);
  writeJson(jsonPath, {
    cycle_id: cycleId,
    updated_at: "2026-05-18T00:00:00Z",
    current_lead_hypothesis: { statement: "Preserve this scientific reasoning chain." },
    decision_log: [{ lane_id: "followup-lab-director-01", decision: "replace" }],
  });
  fs.writeFileSync(markdownPath, "# LabDirector Research Notes\n\nPreserve this scientific reasoning chain.\n", "utf8");
  writeJson(path.join(root, "state", `${cycleId}-gate-review.json`), {
    gate_passed: false,
    blockers: Array.from({ length: 20 }, (_, index) => `routine blocker ${index}`),
  });

  const result = ensureLabDirectorResearchNotes({ root, cycleId });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "preserved_existing_lab_director_notes");
  assert.match(fs.readFileSync(markdownPath, "utf8"), /Preserve this scientific reasoning chain/);
  const notes = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(notes.current_lead_hypothesis.statement, "Preserve this scientific reasoning chain.");
  assert.equal(notes.open_blockers, undefined);
});

test("analyst research notes flag stale GSE322943 memo after newer LabDirector GSE228779 decision", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-analyst-notes-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-analyst-notes-0001";
  const analystDir = path.join(root, "artifacts", "stats", cycleId, "followup-analyst-01");
  const labDir = path.join(root, "lanes", cycleId, "followup-lab-director-02");
  ensureDir(analystDir);
  ensureDir(labDir);
  writeJson(path.join(analystDir, "analysis-design-memo.json"), {
    artifact_type: "analysis-design-memo",
    phase: "exploratory_scientific_design_before_runner_handoff",
    primary_hypothesis_id: "hyp-gse322943",
    primary_family: "classified_tumor_microenvironment",
    hypothesis_statement: "In GSE322943, AP/IFN failure predicts TRM/TLS immune-landscape failure.",
    dataset_exploration: {
      selected_dataset_root: `.research-lab/datasets/${cycleId}/gse322943`,
    },
  });
  writeJson(path.join(analystDir, "handoff-validation-plan.json"), {
    status: "ready_for_runner",
    dataset_root: `.research-lab/datasets/${cycleId}/gse322943`,
  });
  writeJson(path.join(labDir, "result.json"), {
    status: "completed",
    extracted_json: {
      requery_decision: "replace",
      summary: "Replace GSE322943 with GSE228779 VILI-vs-AIH spatial compartment interaction.",
      replacement_hypotheses: [
        {
          statement: "In GSE228779, VILI is separated from AIH by spatial compartment interaction.",
        },
      ],
    },
  });
  const analystMemoTime = new Date("2026-05-18T10:00:00Z");
  const labTime = new Date("2026-05-18T11:00:00Z");
  fs.utimesSync(path.join(analystDir, "analysis-design-memo.json"), analystMemoTime, analystMemoTime);
  fs.utimesSync(path.join(analystDir, "handoff-validation-plan.json"), analystMemoTime, analystMemoTime);
  fs.utimesSync(path.join(labDir, "result.json"), labTime, labTime);

  const result = ensureAnalystResearchNotes({ root, cycleId, force: true });
  assert.equal(result.updated, true);
  assert.equal(result.note_status, "stale_against_latest_lab_director_decision");
  const notes = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));
  assert.equal(notes.mismatch_assessment.stale_against_lab_director, true);
  assert.match(notes.active_use_policy, /do_not_use_latest_analyst_memo/);
});

test("refresh preserves existing Analyst research notebook", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-analyst-notes-preserve-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-analyst-notes-preserve-0001";
  ensureDir(path.join(root, "state"));
  const jsonPath = path.join(root, "state", `${cycleId}-analyst-research-notes.json`);
  const markdownPath = path.join(root, "state", `${cycleId}-analyst-research-notes.md`);
  writeJson(jsonPath, {
    cycle_id: cycleId,
    note_status: "curated_by_analyst",
    active_use_policy: "preserve this analyst notebook",
  });
  fs.writeFileSync(markdownPath, "# Analyst Research Notes\n\nPreserve analyst handoff reasoning.\n", "utf8");

  const result = ensureAnalystResearchNotes({ root, cycleId, force: true });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "preserved_existing_analyst_notes_despite_force");
  assert.match(fs.readFileSync(markdownPath, "utf8"), /Preserve analyst handoff reasoning/);
});

test("refresh cycle re-aggregates lane state before building outputs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-refresh-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-refresh-0001";
  [
    "plans",
    "state",
    "reports",
    "viz",
    "researcher-views",
    `lanes/${cycleId}/author-02`,
    `lanes/${cycleId}/author-02-recovery-01`,
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "plans", `${cycleId}-cycle-plan.json`), {
    objective: "Refresh stale cycle state",
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

  let aggregateCalls = 0;
  let aggregateOptions = null;
  const aggregateRunner = (_argv, options) => {
    const { cwd: runnerCwd } = options;
    aggregateOptions = options;
    aggregateCalls += 1;
    writeJson(path.join(runnerCwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`), {
      status: "completed",
      lane_counts: {
        total: 2,
        running: 0,
        completed: 2,
        failed: 0,
        failed_blocking: 0,
        failed_non_blocking: 0,
      },
      lane_statuses: [
        { lane_id: "lab-runner-01", role: "lab-runner", status: "completed", runtime_class: "external-driver" },
        { lane_id: "author-02-recovery-01", role: "author", status: "completed", runtime_class: "codex-agent" },
      ],
    });
    return {
      status: 0,
      stdout: JSON.stringify({
        cycle_state: path.join(runnerCwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`),
      }),
      stderr: "",
    };
  };

  const output = refreshCycleOutputs({ cwd, cycleId, aggregateRunner });
  const refreshedCycleState = JSON.parse(
    fs.readFileSync(path.join(root, "state", `${cycleId}-cycle-run-state.json`), "utf8"),
  );
  assert.equal(aggregateCalls, 1);
  assert.deepEqual(aggregateOptions.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(aggregateOptions.encoding, undefined);
  assert.equal(output.researcher_view.summary.execution_completion, "completed");
  assert.equal(output.researcher_view.summary.cycle_status, "completed");
  assert.equal(refreshedCycleState.lane_counts.failed, 0);
  assert.equal(refreshedCycleState.lane_statuses.length, 2);
  assert.deepEqual(
    refreshedCycleState.lane_statuses.map((lane) => lane.lane_id).sort(),
    ["author-02-recovery-01", "lab-runner-01"],
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("refresh cycle defers expensive output build while followup evidence lanes are pending", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-refresh-pending-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-refresh-pending";
  ["plans", "state", "events", "runtime", `lanes/${cycleId}/followup-scout-01`, `lanes/${cycleId}/followup-lab-director-01`, `lanes/${cycleId}/followup-chronicle-01`].forEach((dir) => ensureDir(path.join(root, dir)));
  fs.writeFileSync(
    path.join(root, "lanes", cycleId, "followup-lab-director-01", "output-last-message.txt"),
    "LabDirector selected the next evidence task.",
  );
  writeJson(path.join(root, "lanes", cycleId, "followup-lab-director-01", "result.json"), {
    status: "completed",
    extracted_json: {
      requery_decision: "replace",
      replacement_hypotheses: [
        {
          statement: "In GSE282742, subject-aware validation should reduce the apparent P-MCI classifier effect.",
          dataset_or_accession: "GSE282742",
          why_selected: "The fetched bundle is already materialized.",
        },
      ],
      next_actions: [
        {
          description: "Build subject-grouped folds before rerunning the classifier.",
          preferred_role: "lab-runner",
          type: "methods_followup",
        },
      ],
    },
  });
  writeJson(path.join(root, "state", `${cycleId}-chronicle-dci-checkpoint.json`), {
    cycle_id: cycleId,
    lane_id: "followup-chronicle-01",
    updated_at: "2026-05-15T00:00:00Z",
    status: "checkpointed",
    summary: "Chronicle found that claim-traces remain stale while runner-01 is the live frontier.",
    reopen_questions: ["Should claim-traces be refreshed to absorb runner-01?"],
  });
  writeJson(path.join(root, "state", `${cycleId}-chronicle-dci-corpus-map.json`), {
    cycle_id: cycleId,
    manifest_check: {
      missing_expected_aliases: ["followup-analyst-01"],
    },
    trace_focus: {
      lead_executable_claim: {
        claim_id: "claim:hyp-gse282742",
        hypothesis_id: "hyp-gse282742",
        selected_family: "reproducibility_leakage_audit",
        source_chain: ["scout-01/result.json", "runner-01/result.json"],
      },
    },
  });
  writeJson(path.join(root, "state", `${cycleId}-chronicle-dci-evidence-ledger.json`), {
    cycle_id: cycleId,
    entries: [
      {
        evidence_role: "latest_validation_status",
        file_path: "/tmp/runner-01/validation-summary.json",
        local_context_summary: "runner-01 degraded validation remains active.",
        graph_edge_or_blocker: "degraded-validation-frontier",
      },
    ],
  });
  writeJson(path.join(root, "plans", `${cycleId}-cycle-plan.json`), {
    objective: "Partial gate refresh while evidence followups are open",
  });
  writeJson(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), {
    hypothesis_count: 1,
    hypotheses: [{ hypothesis_id: "hyp-refresh", statement: "testable claim" }],
  });
  writeJson(path.join(root, "state", `${cycleId}-hypothesis-ledger.json`), {
    hypothesis_count: 1,
    hypotheses: [{ hypothesis_id: "hyp-refresh", statement: "testable claim" }],
    focus_hypotheses: [{ hypothesis_id: "hyp-refresh", statement: "testable claim" }],
    knowledge_graph: {},
  });

  const aggregateRunner = (_argv, options) => {
    writeJson(path.join(options.cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`), {
      status: "running",
      // Defer only while a core lane is ACTIVELY running. Deferring while idle
      // (running == 0) with a merely-pending core lane is the deadlock the
      // liveness invariant must avoid (see refresh/state.js): it would skip the
      // synthesis that mints classifying hypotheses, which the fail-closed
      // dispatch gate needs to release the suppressed lanes. So the legitimate
      // defer case is an actively-running core lane.
      lane_counts: { total: 2, running: 1, pending: 0, completed: 1, failed: 0 },
      lane_statuses: [
        { lane_id: "lab-runner-01", role: "lab-runner", status: "completed", runtime_class: "external-driver" },
        { lane_id: "followup-scout-01", role: "scout", status: "running", runtime_class: "external-driver" },
      ],
    });
    return { status: 0, stdout: "", stderr: "" };
  };

  const output = refreshCycleOutputs({ cwd, cycleId, aggregateRunner });

  assert.equal(output.refresh_deferred, true);
  assert.equal(output.gate_refresh_applied, true);
  assert.equal(output.researcher_view.summary.evidence_readiness.running_core_lane_count, 1);
  assert.ok(
    output.researcher_view.summary.evidence_readiness.reasons.includes("wait for running core analysis lanes to finish"),
  );
  assert.ok(output.conclusion_review?.review, "deferred refresh should still update conclusion review");
  assert.ok(output.gate_review?.review, "deferred refresh should still update gate review");
  assert.ok(output.approval_review?.review, "deferred refresh should still update approval review");
  assert.equal(output.approval_review.review.approval_score_policy, "stage-gated-minimum");
  assert.ok(Array.isArray(output.approval_review.review.approval_stage_gates));
  assert.equal(
    fs.existsSync(path.join(root, "state", `${cycleId}-gate-review.json`)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "state", `${cycleId}-lab-director-research-notes.json`)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "state", `${cycleId}-lab-director-research-notes.md`)),
    true,
  );
  const notes = JSON.parse(
    fs.readFileSync(path.join(root, "state", `${cycleId}-lab-director-research-notes.json`), "utf8"),
  );
  assert.equal(notes.cycle_id, cycleId);
  assert.equal(notes.generated_by, "refresh-cycle-lab-director-research-notes");
  assert.ok(Array.isArray(notes.latest_lab_director_outputs));
  assert.equal(notes.latest_lab_director_outputs[0].lane_id, "followup-lab-director-01");
  assert.match(notes.current_lead_hypothesis.statement, /GSE282742/);
  assert.equal(notes.next_actions[0], "Build subject-grouped folds before rerunning the classifier.");
  assert.equal(
    fs.existsSync(path.join(root, "state", `${cycleId}-chronicle-research-notes.json`)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "state", `${cycleId}-agent-communication-digest.json`)),
    true,
  );
  const digest = JSON.parse(
    fs.readFileSync(path.join(root, "state", `${cycleId}-agent-communication-digest.json`), "utf8"),
  );
  assert.match(digest.current_focus.lead_hypothesis, /subject-aware validation/);
  assert.equal(digest.handoffs.chronicle.reopen_questions[0], "Should claim-traces be refreshed to absorb runner-01?");
  assert.equal(
    fs.existsSync(path.join(root, "memory", cycleId, "memory_summary.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "memory", cycleId, "MEMORY.md")),
    true,
  );
  assert.equal(output.cycle_memory.reason, "refreshed");
  assert.match(
    fs.readFileSync(path.join(root, "memory", cycleId, "memory_summary.md"), "utf8"),
    /read_policy: read this summary first/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "messages", cycleId, "bus-ledger.json")),
    true,
  );
  const ledger = JSON.parse(
    fs.readFileSync(path.join(root, "messages", cycleId, "bus-ledger.json"), "utf8"),
  );
  // Channels are registered rather than hardcoded, so the count is a property
  // of the registry and not of this function.
  assert.ok(ledger.channel_count >= 5);
  assert.ok(ledger.messages.some((message) => message.to_roles.includes("lab-director")));
  assert.equal(
    fs.existsSync(path.join(root, "messages", cycleId, "lab-director.jsonl")),
    true,
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("refresh cycle does not defer full refresh for pending document-only lanes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-refresh-doc-pending-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-refresh-any-pending";
  ensureDir(path.join(root, "state"));
  ensureDir(path.join(root, "lanes", cycleId));

  const aggregateRunner = (_argv, options) => {
    writeJson(path.join(options.cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`), {
      status: "running",
      lane_counts: { total: 2, running: 0, pending: 1, completed: 1, failed: 0 },
      lane_statuses: [
        { lane_id: "lab-runner-01", role: "lab-runner", status: "completed", runtime_class: "external-driver" },
        { lane_id: "followup-author-01", role: "author", status: "pending", runtime_class: "codex-agent" },
      ],
    });
    return { status: 0, stdout: "", stderr: "" };
  };

  const output = refreshCycleOutputs({ cwd, cycleId, aggregateRunner });

  assert.notEqual(output.refresh_deferred, true);
  assert.equal(output.researcher_view.summary.cycle_id, cycleId);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("context-only refresh updates memory and mailboxes without native aggregation", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-context-refresh-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-context-refresh";
  ensureDir(path.join(root, "state"));
  ensureDir(path.join(root, "lanes", cycleId, "followup-lab-director-01"));
  writeJson(path.join(root, "state", `${cycleId}-cycle-run-state.json`), {
    status: "running",
    lane_counts: { total: 1, running: 0, pending: 0, completed: 1, failed: 0 },
    lane_statuses: [
      { lane_id: "followup-lab-director-01", role: "lab-director", status: "completed" },
    ],
  });
  writeJson(path.join(root, "lanes", cycleId, "followup-lab-director-01", "result.json"), {
    status: "completed",
    extracted_json: {
      selected_hypothesis: {
        statement: "Subject-aware validation should improve traceability.",
        dataset_or_accession: "GSE282742",
      },
      next_actions: ["Refresh the evidence trace."],
    },
  });

  const output = refreshCycleContextOutputs({ cwd, cycleId });

  assert.equal(output.refresh_context_only, true);
  assert.equal(output.cycle_memory.reason, "refreshed");
  // The bus rebuilds every channel from its own source each pass, so there is
  // no stale-vs-fresh decision left to report. The mtime short-circuit that
  // used to make one is what let the director's mailbox go eight days unwritten.
  assert.equal(output.agent_mailboxes.reason, "bus_rebuilt");
  assert.equal(output.context_health.lead_hypothesis_present, true);
  assert.equal(output.context_health.stale_no_lead_message_count, 0);
  assert.equal(
    fs.existsSync(path.join(root, "messages", cycleId, "bus-ledger.json")),
    true,
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("cycle memory current focus prefers canonical LabDirector hypothesis over stale digest", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-memory-canonical-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-memory-canonical";
  ensureDir(path.join(root, "state"));
  writeJson(path.join(root, "state", `${cycleId}-agent-communication-digest.json`), {
    current_focus: {
      lead_hypothesis: "Stale baseline-only claim from an older digest.",
      dataset: "stale-dataset",
    },
  });
  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    statement: "Canonical reproducibility and leakage audit claim should lead memory.",
    primary_family: "reproducibility_audit",
    dataset_or_accession: "GSE282742",
    identification_strategy: {
      materialized_dataset: {
        bundle_path: "/tmp/gse282742",
      },
    },
  });

  const output = ensureCycleMemory({ root, cycleId, force: true });
  const index = JSON.parse(fs.readFileSync(output.index_path, "utf8"));
  const summary = fs.readFileSync(output.memory_summary_path, "utf8");

  assert.equal(index.current_focus.lead_hypothesis, "Canonical reproducibility and leakage audit claim should lead memory.");
  assert.equal(index.current_focus.primary_family, "reproducibility_audit");
  assert.equal(index.current_focus.focus_source, "lab_director_hypothesis");
  assert.match(summary, /Canonical reproducibility and leakage audit claim/);
  assert.doesNotMatch(summary, /Stale baseline-only claim/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("cycle memory does not attach stale materialized dataset to changed canonical lead", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-memory-dataset-change-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-memory-dataset-change";
  ensureDir(path.join(root, "state"));
  writeJson(path.join(root, "state", `${cycleId}-agent-communication-digest.json`), {
    current_focus: {
      lead_hypothesis: "Stale digest claim.",
      dataset: { bundle_path: "/tmp/stale" },
    },
  });
  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    statement: "Canonical GSE289864 immune-resistance lead should drive memory.",
    dataset_or_accession: "GSE289864",
    identification_strategy: {
      dataset_or_accession: "GSE289864",
      materialized_dataset: {
        bundle_path: "/tmp/researchlab/gse282742",
        candidate_url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
      },
    },
  });

  const output = ensureCycleMemory({ root, cycleId, force: true });
  const index = JSON.parse(fs.readFileSync(output.index_path, "utf8"));
  const summary = fs.readFileSync(output.memory_summary_path, "utf8");

  assert.equal(index.current_focus.lead_hypothesis, "Canonical GSE289864 immune-resistance lead should drive memory.");
  assert.equal(index.current_focus.dataset, "GSE289864");
  assert.match(summary, /GSE289864/);
  assert.doesNotMatch(summary, /gse282742/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lab-director notes preserve explicit GSE322943 forced pivot over stale ovarian uphold decisions", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-forced-gse-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-forced-gse";
  const state = path.join(root, "state");
  ensureDir(state);
  writeJson(path.join(state, `${cycleId}-strategy-decision.json`), {
    mode: "pivot",
    forced: true,
    decision_id: "manual-lab-director-user-selected-B-gse322943",
    reason: "explicit user selected option B / GSE322943 for end-to-end validation",
    trigger_signals: ["user_selected_B_gse322943"],
  });
  writeJson(path.join(state, `${cycleId}-data-bundles.json`), {
    bundles: [{
      bundle_path: ".research-lab/datasets/cycle-forced-gse/gse322943",
      manifest_path: ".research-lab/datasets/cycle-forced-gse/gse322943/manifest.json",
      provider: "ncbi_geo",
      status: "fetched",
      csv_count: 1,
      downloaded_count: 2,
      candidate_url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE322943",
      candidate_title: "Dissecting the cellular architecture of breast cancer brain metastases reveals prognostically distinct immune landscapes",
    }],
  });
  writeJson(path.join(state, `${cycleId}-hypothesis-ledger.json`), {
    focus_hypotheses: [{
      hypothesis_id: "hyp-example-materialized",
      statement: "In breast-cancer brain metastasis, latent immune microenvironment states predict prognosis better than pooled averages.",
      dataset_or_accession: "GSE322943",
      family_root: "classified_tumor_microenvironment",
    }],
  });
  writeJson(path.join(state, `${cycleId}-lab-director-hypothesis.json`), {
    statement: "Stale ovarian Zenodo lead should not overwrite explicit user pivot.",
    dataset_or_accession: "10.5281/zenodo.11206564",
    hypothesis_id: "hyp-ovarian-stale",
    identification_strategy: {
      dataset_or_accession: "10.5281/zenodo.11206564",
      validation_data_status: "needs_materialization",
      materialized_dataset: null,
    },
  });

  const output = ensureLabDirectorResearchNotes({ root, cycleId, force: true });
  const notes = JSON.parse(fs.readFileSync(output.json_path, "utf8"));
  const projected = JSON.parse(fs.readFileSync(output.hypothesis_projection_path, "utf8"));
  assert.equal(notes.current_lead_hypothesis.dataset_or_accession, "GSE322943");
  assert.equal(projected.dataset_or_accession, "GSE322943");
  assert.equal(projected.identification_strategy.dataset_or_accession, "GSE322943");
  assert.equal(projected.identification_strategy.validation_data_status, "materialized");
  assert.equal(projected.identification_strategy.materialized_dataset.accession, "GSE322943");
  assert.doesNotMatch(JSON.stringify(projected.identification_strategy), /zenodo\.11206564/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lab-director notes infer accession from current decision statement over stale artifact dataset", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-statement-accession-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-statement-accession";
  const state = path.join(root, "state");
  const lane = path.join(root, "lanes", cycleId, "followup-lab-director-01");
  ensureDir(state);
  ensureDir(lane);
  writeJson(path.join(state, `${cycleId}-lab-director-hypothesis.json`), {
    statement: "Old GSE322943 claim.",
    dataset_or_accession: "GSE322943",
    identification_strategy: { dataset_or_accession: "GSE322943" },
  });
  writeJson(path.join(lane, "final-status.json"), { status: "completed" });
  writeJson(path.join(lane, "result.json"), {
    status: "completed",
    extracted_json: {
      requery_decision: "replace",
      replacement_hypotheses: [{ statement: "In GSE228779 spatial transcriptomics, VILI separates from AIH after adjustment." }],
    },
  });

  const output = ensureLabDirectorResearchNotes({ root, cycleId, force: true });
  const notes = JSON.parse(fs.readFileSync(output.json_path, "utf8"));
  const projected = JSON.parse(fs.readFileSync(output.hypothesis_projection_path, "utf8"));
  assert.match(notes.current_lead_hypothesis.statement, /GSE228779/);
  assert.equal(notes.current_lead_hypothesis.dataset_or_accession, "GSE228779");
  assert.equal(projected.identification_strategy.dataset_or_accession, "GSE228779");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lab-director notes ignore superseded failed LabDirector decisions", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-superseded-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-superseded";
  const state = path.join(root, "state");
  const failedLane = path.join(root, "lanes", cycleId, "followup-lab-director-02");
  const goodLane = path.join(root, "lanes", cycleId, "followup-lab-director-01");
  ensureDir(state);
  ensureDir(failedLane);
  ensureDir(goodLane);
  writeJson(path.join(failedLane, "final-status.json"), { status: "failed", superseded_by_user_instruction: true });
  writeJson(path.join(failedLane, "result.json"), {
    status: "failed",
    superseded_by_user_instruction: true,
    extracted_json: {
      requery_decision: "replace",
      replacement_hypotheses: [{ statement: "Superseded hard-locked hypothesis should be ignored.", dataset_or_accession: "GSE322943" }],
    },
  });
  writeJson(path.join(goodLane, "final-status.json"), { status: "completed" });
  writeJson(path.join(goodLane, "result.json"), {
    status: "completed",
    extracted_json: {
      requery_decision: "replace",
      replacement_hypotheses: [{ statement: "Current non-superseded LabDirector decision.", dataset_or_accession: "GSE228779" }],
    },
  });

  const output = ensureLabDirectorResearchNotes({ root, cycleId, force: true });
  const notes = JSON.parse(fs.readFileSync(output.json_path, "utf8"));
  assert.equal(notes.latest_lab_director_decision.lane_id, "followup-lab-director-01");
  assert.match(notes.current_lead_hypothesis.statement, /Current non-superseded/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lab-director notes drop stale materialized dataset when lead accession changes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-dataset-change-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-dataset-change";
  const state = path.join(root, "state");
  const lane = path.join(root, "lanes", cycleId, "followup-lab-director-01");
  ensureDir(state);
  ensureDir(lane);
  writeJson(path.join(state, `${cycleId}-lab-director-hypothesis.json`), {
    statement: "Old GSE282742 audit claim.",
    dataset_or_accession: "GSE282742",
    identification_strategy: {
      dataset_or_accession: "GSE282742",
      validation_data_status: "materialized",
      materialized_dataset: {
        bundle_path: "/tmp/researchlab/gse282742",
        candidate_url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
      },
    },
  });
  writeJson(path.join(lane, "result.json"), {
    status: "completed",
    extracted_json: {
      requery_decision: "replace",
      selected_hypothesis: {
        statement: "In GSE289864, anti-PD1 glioblastoma tumors harbor a MAIT17/RORC-high suppressive circuit.",
        dataset_or_accession: "GSE289864",
        validation_data_status: "materialized",
        primary_family: "tumor_immune_resistance",
      },
      next_actions: [{
        type: "data_acquisition_followup",
        preferred_role: "scout",
        description: "Materialize GSE289864 single-cell assets before runner validation.",
      }],
    },
  });

  const output = ensureLabDirectorResearchNotes({ root, cycleId, force: true });
  const notes = JSON.parse(fs.readFileSync(output.json_path, "utf8"));
  const projected = JSON.parse(fs.readFileSync(output.hypothesis_projection_path, "utf8"));

  assert.equal(notes.current_lead_hypothesis.dataset_or_accession, "GSE289864");
  assert.equal(projected.dataset_or_accession, "GSE289864");
  assert.equal(projected.primary_family, "tumor_immune_resistance");
  assert.equal(projected.validation_data_status, "needs_materialization");
  assert.equal(projected.identification_strategy.dataset_or_accession, "GSE289864");
  assert.equal(projected.identification_strategy.materialized_dataset, undefined);
  assert.equal(projected.identification_strategy.validation_data_status, "needs_materialization");
  assert.doesNotMatch(JSON.stringify(projected.identification_strategy), /GSE282742|gse282742/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lab-director notes remove mismatched materialized dataset when strategy accession already matches lead", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-notes-stale-bundle-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-stale-bundle";
  const state = path.join(root, "state");
  ensureDir(state);
  writeJson(path.join(state, `${cycleId}-lab-director-hypothesis.json`), {
    statement: "In GSE289864, anti-PD1 glioblastoma tumors harbor a MAIT17/RORC-high suppressive circuit.",
    primary_family: "reproducibility_audit",
    dataset_or_accession: "GSE289864",
    identification_strategy: {
      dataset_or_accession: "GSE289864",
      validation_data_status: "materialized",
      materialized_dataset: {
        bundle_path: "/tmp/researchlab/gse282742",
        candidate_url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
      },
    },
  });

  const output = ensureLabDirectorResearchNotes({ root, cycleId, force: true });
  const projected = JSON.parse(fs.readFileSync(output.hypothesis_projection_path, "utf8"));

  assert.equal(projected.dataset_or_accession, "GSE289864");
  // The DECLARED family is preserved. This used to assert "tumor_immune_resistance":
  // the projection re-derived the family from keywords in the statement and
  // overrode whatever the lead declared. That guessing is what stamped
  // `tumor_immune_resistance` onto a Mitsuba rendering lead on cycle-g-v73 (the
  // marker "tan" matched inside "s-tan-dard control variates"), so the family is
  // now the LabDirector's declaration and nothing else re-derives it.
  assert.equal(projected.primary_family, "reproducibility_audit");
  assert.equal(projected.validation_data_status, "needs_materialization");
  assert.equal(projected.identification_strategy.dataset_or_accession, "GSE289864");
  assert.equal(projected.identification_strategy.materialized_dataset, undefined);
  assert.equal(projected.identification_strategy.validation_data_status, "needs_materialization");
  assert.doesNotMatch(JSON.stringify(projected.identification_strategy), /GSE282742|gse282742/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("pending refresh recomputes the stored view's primary evidence instead of reading a stale runner", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-refresh-stale-evidence-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-refresh-stale-evidence";
  ["plans", "state", "researcher-views"].forEach((dir) => ensureDir(path.join(root, dir)));
  const lanes = path.join(root, "lanes", cycleId);
  // runner-66 failed before inference: not evidence. runner-39 measured something.
  const failedPath = path.join(lanes, "followup-runner-66", "result.json");
  const validPath = path.join(lanes, "followup-runner-39", "result.json");
  ensureDir(path.dirname(failedPath));
  ensureDir(path.dirname(validPath));
  writeJson(validPath, {
    role: "lab-runner",
    status: "completed",
    validation_summary: { overall_status: "passed", blueprints_passed: 2, checks: { effect: true, control: true } },
    blueprint_executions: [{ blueprint_id: "bp-rh-replanning", metrics: { success_rate_delta: -0.002 } }],
  });
  writeJson(failedPath, {
    role: "lab-runner",
    status: "failed",
    validation_summary: {
      overall_status: "degraded",
      blueprints_passed: 0,
      checks: { effect: false, control: false },
      handoff_check_resolutions: [{ check: "effect", valid_falsification_result: false }],
    },
  });
  const older = new Date("2026-09-29T00:00:00Z");
  fs.utimesSync(validPath, older, older);
  // The view as the old code wrote it: bound to the newest, failed runner.
  const viewPath = path.join(root, "researcher-views", `${cycleId}-researcher-view.json`);
  writeJson(viewPath, {
    cycle_id: cycleId,
    cycle_status: "running",
    primary_evidence: { lane_id: "followup-runner-66", source_result_path: failedPath },
    source_paths: {},
  });

  const aggregateRunner = (_argv, options) => {
    writeJson(path.join(options.cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`), {
      status: "running",
      lane_counts: { total: 2, running: 1, pending: 0, completed: 1, failed: 0 },
      lane_statuses: [
        { lane_id: "followup-runner-39", role: "lab-runner", status: "completed", runtime_class: "external-driver" },
        { lane_id: "followup-analyst-01", role: "analyst", status: "running", runtime_class: "codex-agent" },
      ],
    });
    return { status: 0, stdout: "", stderr: "" };
  };

  const output = refreshCycleOutputs({ cwd, cycleId, aggregateRunner });

  assert.equal(output.refresh_deferred, true, "the pending shortcut is the path under test");
  assert.equal(output.researcher_view.summary.primary_evidence.lane_id, "followup-runner-39");
  assert.equal(output.researcher_view.summary.primary_evidence.source_result_path, validPath);
  const stored = JSON.parse(fs.readFileSync(viewPath, "utf8"));
  assert.equal(stored.primary_evidence.lane_id, "followup-runner-39", "the director reads the file too");
  assert.ok(stored.primary_evidence_refreshed_at);
  assert.equal(stored.partial_gate_refresh, undefined, "in-memory pending flags stay out of the file");
  assert.equal(stored.evidence_readiness, undefined);
  fs.rmSync(cwd, { recursive: true, force: true });
});
