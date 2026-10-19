"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, readJson, writeJson } = require("../src/shared/json");
const { buildGateReview } = require("../src/reporting/gate_review");

test("deferred gate review keeps staged conclusion score instead of zeroing pending gate rubrics", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-deferred-score-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-deferred-score";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-328");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001"), path.join("lanes", cycleId, "followup-runner-328")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    selected_hypothesis: {
      statement:
        "In GSE228779 GeoMx spatial transcriptomics, VILI liver-cell mitochondrial/oxidative programs are high while interferon programs are low versus AIH.",
      dataset_or_accession: "GSE228779",
    },
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [{ name: "novelty", score: 10, reasons: ["old objection"], applicable: true }],
      major_objections: ["old objection before the current conclusion package is gate-eligible"],
    }),
  });
  const runnerResultPath = path.join(runnerDir, "result.json");
  writeJson(runnerResultPath, {
    validation_summary: {
      overall_status: "passed",
      primary_hypothesis_id: "hyp-director-gse228779",
      checks_passed: 10,
      checks_failed: 0,
      failed_checks: [],
    },
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        strongest_claim_summary:
          "GSE228779 VILI liver-cell mitochondrial/oxidative-high plus interferon-low signal is current.",
        data_acquisition: { selected_accession: "GSE228779" },
        primary_evidence: {
          lane_id: "followup-runner-328",
          source_result_path: runnerResultPath,
        },
        validation_results: [{ lane_id: "followup-runner-328", status: "passed" }],
      },
    },
    conclusionReview: {
      review: {
        mode: "nudge",
        conclusion_gate_passed: false,
        conclusion_score: 91,
        conclusion_rubric: [
          { name: "novelty", score: 88, reasons: ["needs broader hypotheses"], applicable: true },
          { name: "technical_quality", score: 100, reasons: [], applicable: true },
          // reproducibility below the gate bar (80) keeps the conclusion NOT-yet-
          // eligible so the gate stays deferred (the case under test). It is a HARD
          // (non-relaxed) rubric, unlike clarity/impact which never block advance.
          // Was 93; lowered under the owner's 90 -> 80 threshold move so a genuine
          // blocking-weak rubric remains.
          { name: "reproducibility", score: 72, reasons: ["needs stronger confidence"], applicable: true },
          { name: "clarity", score: 82, reasons: ["needs clearer figures"], applicable: true },
          { name: "impact", score: 80, reasons: ["needs stronger impact"], applicable: true },
          { name: "strobe_reporting_completeness", score: 95, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: { review: { approval_gate_passed: false, approval_readiness_score: 0 } },
  });

  assert.equal(output.review.mode, "defer");
  assert.equal(output.review.gatekeeper_review_status, "deferred");
  assert.equal(output.review.gatekeeper_pending_rubrics.length, 0);
  assert.equal(output.review.pending_rubric_blockers.length, 0);
  assert.equal(output.review.score, 86);
  assert.equal(output.review.rubric.find((item) => item.name === "novelty").score, 88);
  assert.equal(output.review.validation_matches_current_lead, true);
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-328");
  assert.doesNotMatch(output.review.blockers.join("\n"), /pending gate rubric|old objection/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review supersedes stale open-source runner blockers after newer repository workflow succeeds", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-open-source-superseded-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-open-source-superseded-0001";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const oldRunnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  const newRunnerDir = path.join(root, "lanes", cycleId, "followup-runner-002");
  [
    "state",
    "runtime",
    "events",
    path.join("lanes", cycleId, "gatekeeper-001"),
    path.join("lanes", cycleId, "followup-runner-001"),
    path.join("lanes", cycleId, "followup-runner-002"),
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "approve",
      reviewer_focus_rubric: "novelty",
      rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      major_objections: [],
      missing_validations: [],
    }),
  });
  for (const runnerDir of [oldRunnerDir, newRunnerDir]) {
    writeJson(path.join(runnerDir, "role-plan.json"), {
      role: "lab-runner",
      action_type: "methods_followup",
    });
    writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
  }
  writeJson(path.join(oldRunnerDir, "result.json"), {
    validation_summary: {
      overall_status: "degraded",
      open_source_agent_requirements: {
        repository_agent_required: true,
        repository_agent_applied: false,
        repository_agent_application_completed: false,
        substantive_repository_workflow_applied: false,
        real_repository_agent_names: ["fixture/omics-repo"],
      },
      failed_checks: ["open_source_repository_agent_applied"],
    },
    role_plan: {
      planner_metadata: {
        analyst_handoff: {
          open_source_agent_discovery: {
            mandatory: true,
            repository_agent_required: true,
            selected_agent: {
              name: "fixture/omics-repo",
              url: "https://example.invalid/fixture-omics-repo",
            },
          },
          selected_open_source_analysis_agent: {
            name: "fixture/omics-repo",
            url: "https://example.invalid/fixture-omics-repo",
          },
        },
      },
    },
  });
  writeJson(path.join(newRunnerDir, "result.json"), {
    validation_summary: {
      overall_status: "inconclusive",
      open_source_agent_requirements: {
        repository_agent_required: true,
        repository_agent_applied: true,
        repository_agent_application_completed: true,
        substantive_repository_workflow_applied: true,
        real_repository_agent_names: ["fixture/omics-repo"],
      },
      failed_checks: [],
    },
    role_plan: {
      planner_metadata: {
        analyst_handoff: {
          open_source_agent_discovery: {
            mandatory: true,
            repository_agent_required: true,
            selected_agent: {
              name: "fixture/omics-repo",
              url: "https://example.invalid/fixture-omics-repo",
            },
          },
          selected_open_source_analysis_agent: {
            name: "fixture/omics-repo",
            url: "https://example.invalid/fixture-omics-repo",
          },
        },
      },
    },
    external_agent_runs: [
      {
        agent_name: "fixture/omics-repo",
        stage: "application",
        status: "completed",
        cwd: "/tmp/fixture-omics-repo",
      },
    ],
  });
  const oldTime = new Date(Date.now() - 10_000);
  const newTime = new Date();
  fs.utimesSync(path.join(oldRunnerDir, "result.json"), oldTime, oldTime);
  fs.utimesSync(path.join(newRunnerDir, "result.json"), newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "A high-dimensional omics signature is internally validated.",
        objective: "Omics superseded open-source runner gate case",
        evidence_readiness: { ready: true, reasons: [] },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: true,
      },
    },
  });

  assert.equal(output.review.open_source_agent_gate_review.required_for_gate, false);
  assert.equal(output.review.open_source_agent_gate_review.blocker, null);
  assert.equal(
    output.review.open_source_agent_gate_review.superseded_blocking_runner_requirements.length,
    1,
  );
  assert.equal(output.review.gate_passed, true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review falls back to compact artifact result when lane runner result is too large", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-large-runner-result-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-large-runner-result-0001";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  const artifactDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-001");
  const runnerExternalDir = path.join(artifactDir, "external-agents", "fixture-omics-repo");
  [
    "state",
    "runtime",
    "events",
    path.join("lanes", cycleId, "gatekeeper-001"),
    path.join("lanes", cycleId, "followup-runner-001"),
  ].forEach((dir) => ensureDir(path.join(root, dir)));
  ensureDir(runnerExternalDir);

  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "reproducibility",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "approve",
      reviewer_focus_rubric: "reproducibility",
      rubric: [{ name: "reproducibility", score: 96, reasons: [], applicable: true }],
      major_objections: [],
      missing_validations: [],
    }),
  });
  writeJson(path.join(runnerDir, "role-plan.json"), {
    role: "lab-runner",
    action_type: "methods_followup",
  });
  writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(runnerDir, "result.json"), {
    oversized_payload: "x".repeat(11 * 1024 * 1024),
  });
  writeJson(path.join(runnerExternalDir, "external_repository_workflow_result.json"), {
    status: "completed",
    substantive_repository_workflow_applied: false,
    repo_workflow_runs: [
      {
        workflow_name: "profile-only",
        status: "blocked",
        substantive: false,
        reason: "selected dataset lacks differential-expression columns",
      },
    ],
    substantive_workflow_blockers: [
      "selected dataset lacks differential-expression columns",
    ],
  });
  writeJson(path.join(artifactDir, "result.json"), {
    validation_summary: {
      overall_status: "inconclusive",
      open_source_agent_requirements: {
        repository_agent_required: true,
        repository_agent_applied: false,
        repository_agent_application_completed: true,
        substantive_repository_workflow_applied: false,
        real_repository_agent_names: ["fixture/omics-repo"],
        external_agent_workflow_summaries: [
          {
            agent_name: "fixture/omics-repo",
            stage: "application",
            status: "completed",
            output_dir: runnerExternalDir,
            workflow_result_path: path.join(runnerExternalDir, "external_repository_workflow_result.json"),
            substantive_repository_workflow_applied: false,
            substantive_workflow_blockers: [
              "selected dataset lacks differential-expression columns",
            ],
          },
        ],
      },
      failed_checks: [],
    },
    role_plan: {
      planner_metadata: {
        analyst_handoff: {
          open_source_agent_discovery: {
            mandatory: true,
            repository_agent_required: true,
            selected_agent: {
              name: "fixture/omics-repo",
              url: "https://example.invalid/fixture-omics-repo",
            },
          },
          selected_open_source_analysis_agent: {
            name: "fixture/omics-repo",
            url: "https://example.invalid/fixture-omics-repo",
          },
        },
      },
    },
    external_agent_runs: [
      {
        agent_name: "fixture/omics-repo",
        stage: "application",
        status: "completed",
        cwd: "/tmp/fixture-omics-repo",
        output_dir: runnerExternalDir,
      },
    ],
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "A high-dimensional omics signature is internally validated.",
        objective: "Omics large runner result gate case",
        evidence_readiness: { ready: true, reasons: [] },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [{ name: "reproducibility", score: 96, reasons: [], applicable: true }],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: true,
      },
    },
  });

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.open_source_agent_gate_review.required_for_gate, true);
  const recoveryAction = output.review.recommended_followup_actions.find((item) =>
    item.type === "methods_followup"
  );
  assert.equal(recoveryAction?.preferred_role, "analyst");
  assert.equal(
    recoveryAction?.failed_runner_context?.result_path,
    path.join(artifactDir, "result.json"),
  );
  assert.match(
    recoveryAction?.failed_runner_context?.workflow_blockers?.join("\n") || "",
    /differential-expression columns/,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review accepts documented generic external validation attempts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-external-attempted-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-external-attempted-0001";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const scoutDir = path.join(root, "lanes", cycleId, "scout-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001"), path.join("lanes", cycleId, "scout-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "approve",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 96,
          reasons: [],
          applicable: true,
        },
      ],
      major_objections: [],
      missing_validations: [],
    }),
  });
  writeJson(path.join(scoutDir, "role-plan.json"), {
    role: "scout",
    action_type: "external_validation_followup",
    target_rubric: "external_validity",
  });
  writeJson(path.join(scoutDir, "final-status.json"), {
    status: "completed",
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "Dataset-internal signal from a single public slice remains internally reproducible.",
        objective: "External validation attempted case",
        evidence_readiness: { ready: true, reasons: [] },
        open_validation_gaps: ["external validation or confound control remains unresolved"],
        focus_hypotheses: [
          {
            statement: "A single-source dataset-internal signal predicts the target outcome.",
            primary_exposure: "source feature",
            y_variable: "target outcome",
            family_root: "dataset-internal signal",
            mechanisms: ["missing metadata", "confounding"],
          },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [
          {
            name: "novelty",
            score: 96,
            reasons: [],
            applicable: true,
          },
        ],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: true,
      },
    },
  });

  assert.equal(output.review.gate_passed, true);
  assert.equal(output.review.external_validation_review.required_for_gate, false);
  assert.equal(output.review.external_validation_review.needs_external_validation, true);
  assert.equal(output.review.external_validation_review.attempts.length > 0, true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review accepts negative-control fallback when external validation is unavailable", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-negative-control-fallback-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-negative-control-fallback";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-negative-control-results.json`), {
    artifact_type: "negative-control-results",
    validation_type: "external-validation-unavailable-fallback",
    status: "completed",
    rationale:
      "No mappable external public cohort was available; stricter negative-control and sensitivity checks were run instead.",
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "approve",
      reviewer_focus_rubric: "novelty",
      rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      major_objections: [],
      missing_validations: [],
    }),
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "Dataset-internal signal from a single public slice remains internally reproducible.",
        objective: "External validation fallback case",
        evidence_readiness: { ready: true, reasons: [] },
        open_validation_gaps: ["external validation or confound control remains unresolved"],
        focus_hypotheses: [
          {
            statement: "A single-source dataset-internal signal predicts the target outcome.",
            primary_exposure: "source feature",
            y_variable: "target outcome",
            family_root: "dataset-internal signal",
            mechanisms: ["missing metadata", "confounding"],
          },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: true,
      },
    },
  });

  assert.equal(output.review.external_validation_review.required_for_gate, false);
  assert.equal(
    output.review.external_validation_review.attempts.some((item) => item.source === "fallback_validation_artifact"),
    true,
  );
  assert.equal(output.review.external_validation_review.needs_external_validation, true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review supersedes stale setup gatekeepers after lead and validation evidence exist", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-superseded-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-superseded-0001";
  const staleDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const currentDir = path.join(root, "lanes", cycleId, "gatekeeper-002");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001"), path.join("lanes", cycleId, "gatekeeper-002")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(staleDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(staleDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(staleDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 0,
          reasons: [
            "No candidate hypotheses were provided, so no claim can be shown to exceed the state-of-the-art baseline.",
            "No same-dataset reference baseline has been extracted.",
          ],
          applicable: true,
        },
        {
          name: "technical_quality",
          score: 0,
          reasons: ["No identification strategy, model, covariate plan, endpoint definition, preprocessing approach, or confound handling is present."],
          applicable: true,
        },
      ],
      major_objections: [
        "No lead hypothesis is present, so there is nothing scientifically falsifiable to approve.",
        "No validation evidence exists: there are zero evidence packets, focus hypotheses, graph updates, validation artifacts, or validation results.",
        "The dataset mandate is unresolved: the work has not selected an executable fetched bundle.",
      ],
      missing_validations: [
        "Select at least one fetched GEO bundle and document usable data matrices.",
        "Define one or more falsifiable lead hypotheses with expected direction.",
      ],
    }),
  });

  writeJson(path.join(currentDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "technical_quality",
  });
  writeJson(path.join(currentDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(currentDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "technical_quality",
      rubric: [
        {
          name: "novelty",
          score: 42,
          reasons: ["The selected same-dataset baseline makes the claim testable but still not clearly novel."],
          applicable: true,
        },
        {
          name: "technical_quality",
          score: 32,
          reasons: ["The current LOOCV analysis exists but still does not test the declared model faithfully."],
          applicable: true,
        },
      ],
      major_objections: [
        "The claim-faithful model has not yet been tested against the selected GSE123456 baseline.",
      ],
      missing_validations: [
        "Run subject-grouped nested cross-validation with calibration and permutation testing.",
      ],
    }),
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        lead_outcome: "primary_signal",
        lead_outcome_label: "Primary Signal",
        strongest_claim_summary: "A selected GSE123456 expression signal is now under validation.",
        objective: "Superseded gatekeeper case",
        evidence_readiness: { ready: true, reasons: [] },
        data_acquisition: {
          selected_accession: "GSE123456",
          fetched_bundle_path: "/tmp/GSE123456",
        },
        focus_hypotheses: [
          {
            statement: "GSE123456 expression features predict the target outcome after subject grouping.",
            family_root: "expression prediction",
          },
        ],
        validation_results: [
          {
            lane_id: "runner-001",
            verdict: "challenged",
            summary: "LOOCV AUC 0.68 on GSE123456; claim-faithful model still pending.",
          },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [
          { name: "novelty", score: 50, reasons: [], applicable: true },
          { name: "technical_quality", score: 50, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: false,
      },
    },
  });

  assert.equal(output.review.superseded_gatekeeper_reviews.length, 1);
  assert.equal(output.review.superseded_gatekeeper_reviews[0].lane_id, "gatekeeper-001");
  assert.equal(output.review.gatekeeper_pending_rubrics.includes("novelty"), true);
  assert.equal(output.review.score, 37);
  assert.equal(output.review.rubric.find((item) => item.name === "novelty").evidence_source, "cross_rubric_gatekeeper_review");
  assert.doesNotMatch(output.review.major_objections.join("\n"), /No lead hypothesis|No validation evidence|dataset mandate is unresolved/i);
  assert.doesNotMatch(output.review.blockers.join("\n"), /No lead hypothesis|No validation evidence|dataset mandate is unresolved/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review supersedes gatekeeper reviews bound to a previous GEO accession", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-foreign-accession-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-foreign-accession";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    selected_hypothesis: {
      statement: "In GSE228779 GeoMx spatial transcriptomics, vaccine-associated liver injury is distinguished from autoimmune hepatitis by interferon and antigen-presentation programs.",
    },
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 12,
          reasons: ["The claim does not beat the published GSE322943 breast-cancer brain-metastasis baseline."],
          applicable: true,
        },
      ],
      major_objections: [
        "Same-dataset comparator analysis against the published GSE322943 immune-landscape baseline is absent.",
      ],
      missing_validations: [
        "Reproduce the GSE322943 immune-landscape baseline before approval.",
      ],
    }),
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "GSE228779 vaccine-associated liver injury signal is under validation.",
        data_acquisition: { selected_accession: "GSE228779" },
        focus_hypotheses: [
          { statement: "GSE228779 interferon/antigen-presentation program distinguishes VALI from AIH." },
        ],
        validation_results: [{ summary: "Exploratory validation artifact exists for GSE228779." }],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 90,
        conclusion_rubric: [{ name: "novelty", score: 80, reasons: [], applicable: true }],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  assert.equal(output.review.superseded_gatekeeper_reviews.length, 1);
  assert.equal(output.review.superseded_gatekeeper_reviews[0].superseded_kind, "superseded_foreign_accession_review");
  assert.doesNotMatch(output.review.major_objections.join("\n"), /GSE322943|breast-cancer brain-metastasis/i);
  assert.doesNotMatch(output.review.blockers.join("\n"), /GSE322943|breast-cancer brain-metastasis/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review supersedes gatekeeper reviews older than the current LabDirector hypothesis", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-current-hypothesis-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-current-hypothesis";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  const resultPath = path.join(gatekeeperDir, "result.json");
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(resultPath, {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 14,
          reasons: ["The previous GSE228779 claim was only an obvious AIH versus VILI contrast."],
          applicable: true,
        },
      ],
      major_objections: [
        "The previous GSE228779 claim does not justify a high-impact gate score.",
      ],
      missing_validations: [
        "Revise the GSE228779 hypothesis before the next gate review.",
      ],
    }),
  });
  const oldTime = new Date(Date.now() - 20_000);
  fs.utimesSync(resultPath, oldTime, oldTime);

  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  writeJson(hypothesisPath, {
    statement:
      "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through spatial compartment decoupling in liver-cell versus immune-enriched segments.",
    dataset_or_accession: "GSE228779",
    primary_family: "classified_spatial_liver_injury_compartment_decoupling",
  });
  const newTime = new Date(Date.now() + 20_000);
  fs.utimesSync(hypothesisPath, newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "GSE228779 compartment decoupling is the current lead.",
        data_acquisition: { selected_accession: "GSE228779" },
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            statement:
              "GSE228779 compartment decoupling separates VILI oxidative injury from AIH interferon/plasma-cell patterns.",
          },
        ],
        validation_results: [{ summary: "Exploratory validation artifact exists for GSE228779." }],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 90,
        conclusion_rubric: [{ name: "novelty", score: 90, reasons: [], applicable: true }],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  assert.equal(output.review.superseded_gatekeeper_reviews.length, 1);
  assert.equal(output.review.superseded_gatekeeper_reviews[0].superseded_kind, "superseded_current_hypothesis_review");
  assert.equal(output.review.gatekeeper_reviews_normalized.length, 0);
  assert.equal(output.review.gatekeeper_pending_rubrics.includes("novelty"), true);
  assert.equal(output.review.score, 0);
  assert.doesNotMatch(output.review.major_objections.join("\n"), /previous GSE228779 claim|high-impact gate score/i);
  assert.equal(output.review.validation_matches_current_lead, true);
  assert.equal(output.review.latest_validation_lane_id, null);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review keeps older gatekeeper rejects when LabDirector only upheld the same current hypothesis", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-uphold-same-hypothesis-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-uphold-same-hypothesis";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  const resultPath = path.join(gatekeeperDir, "result.json");
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "technical_quality",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(resultPath, {
    extracted_json: {
      verdict: "reject",
      reviewer_focus_rubric: "technical_quality",
      rubric: [
        {
          name: "technical_quality",
          score: 42,
          reasons: [
            "GSE228779 VILI AIH liver-cell injury interferon decoupling still lacks a stable patient-aware estimand.",
          ],
          applicable: true,
        },
      ],
      major_objections: [
        "GSE228779 VILI AIH liver-cell injury interferon decoupling still lacks a stable patient-aware estimand.",
      ],
    },
  });
  const oldTime = new Date(Date.now() - 20_000);
  fs.utimesSync(resultPath, oldTime, oldTime);

  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  writeJson(hypothesisPath, {
    requery_decision: "uphold",
    statement:
      "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell injury/interferon decoupling.",
    dataset_or_accession: "GSE228779",
    primary_family: "classified_spatial_liver_injury_interferon_decoupling",
  });
  const newTime = new Date(Date.now() + 20_000);
  fs.utimesSync(hypothesisPath, newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary:
          "GSE228779 VILI versus AIH liver-cell injury/interferon decoupling remains the current lead.",
        data_acquisition: { selected_accession: "GSE228779" },
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            statement:
              "GSE228779 VILI differs from AIH through liver-cell injury/interferon decoupling.",
          },
        ],
        validation_results: [{ summary: "Exploratory validation artifact exists for GSE228779." }],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 90,
        conclusion_rubric: [{ name: "technical_quality", score: 90, reasons: [], applicable: true }],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  assert.equal(output.review.superseded_gatekeeper_reviews.length, 0);
  assert.equal(output.review.gatekeeper_reviews_normalized.length, 1);
  assert.equal(output.review.gatekeeper_reviews_normalized[0].verdict, "reject");
  assert.equal(output.review.gatekeeper_pending_rubrics.includes("technical_quality"), false);
  assert.match(output.review.major_objections.join("\n"), /patient-aware estimand/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review keeps gatekeeper verdict when newer validation only re-confirms (passing) evidence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-newer-validation-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-newer-validation";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "followup-gatekeeper-01");
  const runnerDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-693");
  ["state", "runtime", "events", path.join("lanes", cycleId, "followup-gatekeeper-01"), path.join("artifacts", "stats", cycleId, "followup-runner-693")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    selected_hypothesis: {
      statement:
        "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell oxidative stress and interferon decoupling.",
      dataset_or_accession: "GSE228779",
    },
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    planner_metadata: { target_rubric: "novelty" },
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 28,
          reasons: [
            "In GSE228779, the VILI versus AIH liver-cell oxidative stress and interferon decoupling claim does not yet exceed the same-dataset baseline.",
          ],
          applicable: true,
        },
      ],
      major_objections: [
        "The GSE228779 VILI versus AIH liver-cell oxidative stress and interferon decoupling novelty is not established over the same-dataset baseline.",
      ],
    }),
  });
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(gatekeeperDir, "result.json"), oldTime, oldTime);

  const runnerResultPath = path.join(runnerDir, "result.json");
  writeJson(runnerResultPath, {
    validation_summary: {
      overall_status: "passed",
      primary_hypothesis_id: "hyp-director-gse228779",
      checks_passed: 17,
      checks_failed: 0,
      checks_total: 17,
      failed_checks: [],
      analysis_accuracy_score: 89,
      method_appropriateness_score: 91,
    },
  });
  const newTime = new Date(Date.now() + 60_000);
  fs.utimesSync(runnerResultPath, newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        strongest_claim_summary:
          "GSE228779 VILI liver-cell mitochondrial/oxidative-high plus interferon-low signal is current.",
        data_acquisition: { selected_accession: "GSE228779" },
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            statement:
              "GSE228779 VILI differs from AIH through liver-cell oxidative stress and interferon decoupling.",
          },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 96,
        conclusion_rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  // Convergence fix: a newer PASSING validation (overall_status=passed, no failed
  // checks) must NOT supersede the gatekeeper verdict on mtime alone — that pure
  // time race was the gate-convergence churn. The novelty reject is retained
  // (not pending, not superseded-by-validation), so the gate stays closed on its
  // real merits rather than resetting to a perpetual "pending re-review".
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-693");
  assert.equal(
    output.review.superseded_gatekeeper_reviews.filter(
      (item) => item.superseded_kind === "superseded_validation_evidence_review",
    ).length,
    0,
  );
  assert.equal(output.review.gatekeeper_review_status !== "superseded", true);
  assert.equal(output.review.gatekeeper_pending_rubrics.includes("novelty"), false);
  assert.equal(output.review.gate_passed, false);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review still supersedes gatekeeper review when newer validation is materially negative", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-newer-validation-negative-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-newer-validation-negative";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "followup-gatekeeper-01");
  const runnerDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-700");
  ["state", "runtime", "events", path.join("lanes", cycleId, "followup-gatekeeper-01"), path.join("artifacts", "stats", cycleId, "followup-runner-700")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    selected_hypothesis: {
      statement:
        "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell oxidative stress and interferon decoupling.",
      dataset_or_accession: "GSE228779",
    },
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    planner_metadata: { target_rubric: "novelty" },
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "approve",
      reviewer_focus_rubric: "novelty",
      rubric: [{ name: "novelty", score: 96, reasons: ["approved before the newest failing runner"], applicable: true }],
      major_objections: [],
    }),
  });
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(gatekeeperDir, "result.json"), oldTime, oldTime);

  const runnerResultPath = path.join(runnerDir, "result.json");
  writeJson(runnerResultPath, {
    validation_summary: {
      overall_status: "failed",
      primary_hypothesis_id: "hyp-director-gse228779",
      checks_passed: 9,
      checks_failed: 4,
      checks_total: 13,
      failed_checks: ["same_dataset_baseline_reproduction_01", "reference_baseline_audit_01"],
    },
  });
  const newTime = new Date(Date.now() + 60_000);
  fs.utimesSync(runnerResultPath, newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        strongest_claim_summary:
          "GSE228779 VILI liver-cell mitochondrial/oxidative-high plus interferon-low signal is current.",
        data_acquisition: { selected_accession: "GSE228779" },
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            statement:
              "GSE228779 VILI differs from AIH through liver-cell oxidative stress and interferon decoupling.",
          },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 96,
        conclusion_rubric: [{ name: "novelty", score: 96, reasons: [], applicable: true }],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  // Fail-closed preserved: a newer FAILING validation still supersedes the older
  // approve, forcing a fresh review instead of passing on stale evidence.
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-700");
  assert.equal(
    output.review.superseded_gatekeeper_reviews.some(
      (item) => item.superseded_kind === "superseded_validation_evidence_review",
    ),
    true,
  );
  assert.equal(output.review.gate_passed, false);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review gives partial credit to older reviews aligned with the current hypothesis", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-partial-current-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-partial-current";
  const technicalDir = path.join(root, "lanes", cycleId, "gatekeeper-technical");
  const strobeDir = path.join(root, "lanes", cycleId, "gatekeeper-strobe");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-technical"), path.join("lanes", cycleId, "gatekeeper-strobe")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  for (const [laneDir, targetRubric] of [
    [technicalDir, "technical_quality"],
    [strobeDir, "strobe_reporting_completeness"],
  ]) {
    const resultPath = path.join(laneDir, "result.json");
    writeJson(path.join(laneDir, "role-plan.json"), {
      role: "gatekeeper",
      action_type: "independent_gate_review_followup",
      target_rubric: targetRubric,
    });
    writeJson(path.join(laneDir, "final-status.json"), { status: "completed" });
    writeJson(resultPath, {
      output_last_message: JSON.stringify({
        verdict: "approve",
        reviewer_focus_rubric: targetRubric,
        rubric: [
          {
            name: targetRubric,
            score: 97,
            reasons: [
              "The GSE228779 VILI versus AIH liver-cell oxidative stress and interferon direction is technically reviewable.",
            ],
            applicable: true,
          },
        ],
        major_objections: [],
        missing_validations: [],
      }),
    });
    const oldTime = new Date(Date.now() - 20_000);
    fs.utimesSync(resultPath, oldTime, oldTime);
  }

  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  writeJson(hypothesisPath, {
    statement:
      "In GSE228779 GeoMx liver-cell segments, VILI has higher oxidative stress and lower interferon response than AIH.",
    dataset_or_accession: "GSE228779",
    primary_family: "spatial_liver_cell_oxidative_interferon_contrast",
  });
  const newTime = new Date(Date.now() + 20_000);
  fs.utimesSync(hypothesisPath, newTime, newTime);

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "GSE228779 VILI versus AIH liver-cell oxidative stress and interferon contrast.",
        // The STROBE rubric this test asserts on is kept only for a biomedical
        // objective; without one the gate drops it and the assertion reads as a
        // missing score rather than as a dropped rubric.
        objective: "GSE228779 GeoMx single-cell gene expression contrast between VILI and AIH liver segments",
        data_acquisition: { selected_accession: "GSE228779" },
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            statement:
              "GSE228779 VILI liver-cell oxidative stress is higher while interferon response is lower than AIH.",
          },
        ],
        validation_results: [{ summary: "Validation artifact exists for GSE228779 oxidative/interferon contrast." }],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 96,
        conclusion_rubric: [
          { name: "technical_quality", score: 96, reasons: [], applicable: true },
          { name: "strobe_reporting_completeness", score: 96, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  assert.equal(output.review.superseded_gatekeeper_reviews.length, 0);
  assert.equal(output.review.gatekeeper_pending_rubrics.length, 0);
  assert.equal(output.review.gatekeeper_review.partial_current_hypothesis_credit, true);
  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.mode, "challenge");
  assert.equal(output.review.rubric.find((item) => item.name === "technical_quality").score, 90);
  assert.equal(
    output.review.rubric.find((item) => item.name === "technical_quality").evidence_source,
    "partial_current_hypothesis_gatekeeper_review",
  );
  assert.equal(output.review.rubric.find((item) => item.name === "strobe_reporting_completeness").score, 90);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review supersedes stale 8-gene claim reviews but pivots low-impact audit leads", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-stale-8gene-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-stale-8gene";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001"), path.join("lanes", cycleId, "followup-runner-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  const gatekeeperResultPath = path.join(gatekeeperDir, "result.json");
  writeJson(gatekeeperResultPath, {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 12,
          reasons: [
            "No exact 8-gene benchmark has been run, so the same-dataset baseline is not challenged.",
          ],
          applicable: true,
        },
        {
          name: "technical_quality",
          score: 18,
          reasons: [
            "The sex-by-diagnosis DESeq2, pathway scoring, and immune deconvolution superiority claim remains untested.",
          ],
          applicable: true,
        },
      ],
      major_objections: [
        "LOOCV AUC 0.682 versus 0.712 for the covariate-only baseline weakens the old superiority claim.",
        "The package still asks for a sex-aware pathway/deconvolution nested-CV model rather than a reproducibility audit.",
      ],
      missing_validations: [
        "Exact reproduction of the published 8-gene P-MCI versus S-MCI benchmark.",
      ],
    }),
  });
  fs.utimesSync(gatekeeperResultPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

  writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
  const runnerResultPath = path.join(runnerDir, "result.json");
  writeJson(runnerResultPath, {
    validation_summary: {
      primary_hypothesis_id: "hyp-director-gse282742",
      method_appropriateness_score: 96,
      analysis_accuracy_score: 94,
      checks: {
        exact_8gene_panel_mapped: true,
        panel_cv_computed: true,
        material_drop_from_published_auc: true,
        age_sex_baseline_computed: true,
      },
      failed_checks: ["not_better_than_age_sex_baseline"],
    },
  });
  fs.utimesSync(runnerResultPath, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        objective: "Stale 8-gene gate review case",
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            hypothesis_id: "hyp-director-gse282742",
            statement: "Reframe GSE282742 as a same-dataset reproducibility audit of the published 8-gene result.",
            family_root: "reproducibility_audit",
            dataset_or_accession: "GSE282742",
          },
        ],
        primary_evidence: {
          lane_id: "followup-runner-001",
          method_appropriateness_score: 96,
          analysis_accuracy_score: 94,
          source_result_path: runnerResultPath,
        },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: false,
        conclusion_score: 98,
        mode: "nudge",
        conclusion_rubric: [
          { name: "novelty", score: 98, reasons: [], applicable: true },
          { name: "technical_quality", score: 98, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: false,
        approval_readiness_score: 98,
        approval_rubric: [
          { name: "novelty", score: 98, reasons: [], applicable: true },
          { name: "technical_quality", score: 98, reasons: [], applicable: true },
        ],
      },
    },
  });

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.mode, "reject");
  assert.equal(output.review.decision_mode, "pivot");
  assert.equal(output.review.scientific_value_gate.required_for_gate, true);
  assert.equal(output.review.scientific_value_gate.weak_reproducibility_audit, true);
  assert.equal(output.review.staged_gate_fallback.applied, false);
  assert.equal(output.review.staged_gate_fallback.blocked_by_scientific_value_gate, true);
  assert.equal(output.review.superseded_gatekeeper_reviews[0].superseded_kind, "superseded_claim_review");
  assert.equal(output.review.superseded_gatekeeper_reviews[0].superseded_by_lane_id, "followup-runner-001");
  assert.equal(output.review.gatekeeper_reviews_normalized.length, 0);
  assert.equal(output.review.gatekeeper_pending_rubrics.length, 0);
  assert.equal(output.review.rubric.every((item) => item.evidence_source === "scientific_value_gate"), true);
  assert.ok(output.review.score < 80);
  assert.ok(output.review.recommended_followup_actions.some((item) => item.type === "gate_restart_followup" && item.target_rubric === "scientific_value"));
  assert.ok(output.review.recommended_followup_actions.some((item) => item.type === "hypothesis_regeneration_followup"));
  const impactFirstActions = output.review.recommended_followup_actions.filter((item) =>
    [
      "gate_restart_followup",
      "hypothesis_regeneration_followup",
      "hypothesis_regeneration_synthesis_followup",
    ].includes(item.type)
  );
  assert.ok(impactFirstActions.length >= 3);
  for (const action of impactFirstActions) {
    assert.equal(action.impact_first_hypothesis_mandate.active, true);
    assert.equal(action.hypothesis_generation_policy.mode, "impact-first");
    assert.equal(action.planner_metadata.impact_first_hypothesis_mandate.active, true);
    assert.equal(action.planner_metadata.hypothesis_generation_policy.mode, "impact-first");
    assert.ok(action.impact_first_hypothesis_mandate.required_candidate_fields.includes("expected_impact_score"));
    assert.ok(action.impact_first_hypothesis_mandate.required_candidate_fields.includes("validation_data_availability_score"));
    assert.ok(action.impact_first_hypothesis_mandate.required_candidate_fields.includes("validation_dataset_accession_or_bundle"));
    assert.ok(action.impact_first_hypothesis_mandate.required_candidate_fields.includes("why_not_merely_audit"));
  }
  assert.equal(
    output.review.scientific_value_gate.recommended_actions.every((item) =>
      item.impact_first_hypothesis_mandate?.active === true
    ),
    true,
  );
  assert.match(output.review.blockers.join("\n"), /scientific value gate failed|force pivot/i);
  assert.doesNotMatch(output.review.blockers.join("\n"), /No exact 8-gene|0\.682 versus 0\.712|sex-by-diagnosis/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review scopes stale audit blockers away after LabDirector pivots current lead accession", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-current-lead-scope-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-current-lead-scope-0001";
  const state = path.join(root, "state");
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  [
    "state",
    "runtime",
    "events",
    path.join("lanes", cycleId, "gatekeeper-001"),
    path.join("lanes", cycleId, "followup-runner-001"),
  ].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(state, `${cycleId}-lab-director-hypothesis.json`), {
    statement:
      "In GSE289864, recurrent anti-PD1-treated glioblastoma harbors a patient-level MAIT17 or RORC-high suppressive circuit.",
    dataset_or_accession: "GSE289864",
    selected_hypothesis: {
      statement:
        "In GSE289864, recurrent anti-PD1-treated glioblastoma harbors a patient-level MAIT17 or RORC-high suppressive circuit.",
      dataset_or_accession: "GSE289864",
      primary_family: "tumor_immune_resistance",
    },
    identification_strategy: {
      dataset_or_accession: "GSE289864",
      materialized_dataset: {
        bundle_path: "/tmp/researchlab/gse282742",
        candidate_url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
      },
    },
  });
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [
        {
          name: "novelty",
          score: 24,
          reasons: [
            "GSE282742 does not exceed the same-dataset 8-gene baseline and should remain an audit.",
            "Cross-family pivots have clearer upside: GSE289864 targets anti-PD1 tumor-immune resistance.",
          ],
          applicable: true,
        },
      ],
      major_objections: [
        "GSE282742 8-gene result underperforms the age/sex baseline and lacks sex-by-diagnosis DESeq2.",
      ],
      missing_validations: ["No exact 8-gene grouped benchmark was run for GSE282742."],
      required_response_from_lab_director: [
        "If the LabDirector pivots to GSE289864, define the exact same-dataset baseline and falsification trigger.",
      ],
    }),
  });
  const runnerResultPath = path.join(runnerDir, "result.json");
  writeJson(path.join(runnerDir, "role-plan.json"), {
    role: "lab-runner",
    action_type: "methods_followup",
  });
  writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
  writeJson(runnerResultPath, {
    validation_summary: {
      primary_hypothesis_id: "hyp-director-gse282742",
      checks: {
        exact_8gene_panel_mapped: true,
        panel_cv_computed: true,
        material_drop_from_published_auc: true,
      },
      failed_checks: ["not_better_than_age_sex_baseline"],
    },
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        objective: "Current lead pivot should not inherit stale audit blockers",
        evidence_readiness: { ready: true, reasons: [] },
        focus_hypotheses: [
          {
            hypothesis_id: "hyp-director-gse282742",
            statement: "Reframe GSE282742 as a same-dataset reproducibility audit of the published 8-gene result.",
            family_root: "reproducibility_audit",
            dataset_or_accession: "GSE282742",
          },
        ],
        primary_evidence: {
          lane_id: "followup-runner-001",
          source_result_path: runnerResultPath,
        },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: false,
        conclusion_score: 98,
        mode: "nudge",
        conclusion_rubric: [{ name: "novelty", score: 98, reasons: [], applicable: true }],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: false,
        approval_readiness_score: 98,
        approval_rubric: [{ name: "novelty", score: 98, reasons: [], applicable: true }],
      },
    },
  });

  assert.equal(output.review.scientific_value_gate.validation_matches_current_lead, false);
  assert.equal(output.review.scientific_value_gate.required_for_gate, false);
  assert.equal(output.review.scientific_value_gate.published_8gene_audit, false);
  assert.deepEqual(output.review.scientific_value_gate.current_lead_accessions, ["GSE289864"]);
  assert.deepEqual(output.review.scientific_value_gate.ignored_stale_dataset_accessions, ["GSE282742"]);
  assert.deepEqual(output.review.current_hypothesis_identity.accessions, ["GSE289864"]);
  assert.equal(output.review.superseded_gatekeeper_reviews.length, 1);
  assert.equal(output.review.superseded_gatekeeper_reviews[0].superseded_kind, "superseded_foreign_accession_review");
  assert.deepEqual(output.review.superseded_gatekeeper_reviews[0].current_accessions, ["GSE289864"]);
  assert.ok(output.review.superseded_gatekeeper_reviews[0].stale_current_lead_patterns.length >= 1);
  assert.equal(output.review.gatekeeper_reviews_normalized.length, 0);
  assert.equal(output.review.staged_gate_fallback.blocked_by_current_lead_validation_mismatch, true);
  assert.doesNotMatch(output.review.blockers.join("\n"), /GSE282742|8-gene|sex-by-diagnosis|age\/sex/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});

function gateWithNewerRunner(tag, newerRunner) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `researchlab-gate-${tag}-`));
  const root = path.join(cwd, ".research-lab");
  const cycleId = `cycle-gate-${tag}`;
  const gatekeeperDir = path.join(root, "lanes", cycleId, "followup-gatekeeper-29");
  const passedDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-29");
  const newerDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-66");
  [path.join(root, "state"), gatekeeperDir, passedDir, newerDir].forEach((dir) => ensureDir(dir));
  writeJson(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), {
    selected_hypothesis: { statement: "Receding-horizon replanning preserves Diffusion Policy success under local-support removal." },
  });
  const at = (offsetMs) => new Date(Date.now() + offsetMs);
  // 1. A completed, passing runner.
  // Both runners carry the lead's statement, as the live runners do: that sends
  // selection down the scored path, where the newest matching run wins.
  const lead = "Receding-horizon replanning preserves Diffusion Policy success under local-support removal.";
  writeJson(path.join(passedDir, "result.json"), {
    assigned_hypotheses: [lead],
    status: "completed",
    validation_summary: { overall_status: "passed", blueprints_passed: 13, blueprints_failed: 0, checks_passed: 13, checks_total: 13, failed_checks: [] },
  });
  fs.utimesSync(path.join(passedDir, "result.json"), at(-120_000), at(-120_000));
  // 2. A gatekeeper that reviewed it.
  writeJson(path.join(gatekeeperDir, "role-plan.json"), {
    role: "gatekeeper", action_type: "independent_gate_review_followup", planner_metadata: { target_rubric: "novelty" },
  });
  writeJson(path.join(gatekeeperDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperDir, "result.json"), {
    output_last_message: JSON.stringify({
      verdict: "reject",
      reviewer_focus_rubric: "novelty",
      rubric: [{ name: "novelty", score: 64, reasons: ["Receding-horizon replanning novelty is not established over prior lookup work."], applicable: true }],
      major_objections: ["Receding-horizon replanning and Diffusion Policy novelty is not established over prior lookup work."],
    }),
  });
  fs.utimesSync(path.join(gatekeeperDir, "result.json"), at(-60_000), at(-60_000));
  // 3. A newer runner.
  writeJson(path.join(newerDir, "result.json"), { assigned_hypotheses: [lead], ...newerRunner });
  fs.utimesSync(path.join(newerDir, "result.json"), at(60_000), at(60_000));
  return buildGateReview({
    cwd,
    cycleId,
    researcherView: { summary: { evidence_readiness: { ready: true, reasons: [] }, focus_hypotheses: [{ statement: "Receding-horizon replanning preserves Diffusion Policy success." }] } },
    conclusionReview: { review: { conclusion_gate_passed: true, conclusion_score: 80, conclusion_rubric: [] } },
    approvalReview: { review: { approval_gate_passed: false } },
  });
}

const supersededByValidation = (output) => output.review.superseded_gatekeeper_reviews.filter(
  (item) => item.superseded_kind === "superseded_validation_evidence_review",
).length;

test("a runner that failed before measuring anything does not discard the gatekeeper reviews", () => {
  // MEASURED ON cycle-a-20260919, 2026-09-29: every gatekeeper review
  // was superseded by followup-runner-66, which failed before inference (0 of 2
  // blueprints passed, no valid falsification), and the gate projected 0 on
  // every rubric while gatekeepers had scored the lead.
  const output = gateWithNewerRunner("failed-execution", {
    status: "failed",
    validation_summary: {
      overall_status: "degraded", blueprints_total: 2, blueprints_passed: 0, blueprints_failed: 2,
      handoff_check_resolutions: [
        { check_id: "a", status: "failed", valid_falsification_result: false },
        { check_id: "b", status: "failed", valid_falsification_result: false },
      ],
    },
  });
  assert.equal(supersededByValidation(output), 0, "an execution failure erased a real review");
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-29");
});

test("a newer run whose executions measured nothing leaves the reviews standing, as the dispatcher reads it", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-01 18:39Z: followup-runner-104
  // (a power analysis, produced_evidence false) superseded every review while
  // the dispatcher held the re-reviews for lack of new evidence; the gate sat at 0.
  const degradedNoOutcome = {
    status: "completed",
    blueprint_executions: [{ status: "completed", produced_evidence: false, metrics: { pass_fail: "pass", notes: "power analysis; no outcomes" } }],
    validation_summary: { overall_status: "degraded", blueprints_total: 1, blueprints_passed: 1, blueprints_failed: 0 },
  };
  const output = gateWithNewerRunner("power-analysis", degradedNoOutcome);
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-66", "the run is still shown to reviewers");
  assert.equal(supersededByValidation(output), 0, "a run that measured nothing erased the reviews");

  // The same degraded run with a measured execution is new evidence.
  const measured = { ...degradedNoOutcome, blueprint_executions: [{ ...degradedNoOutcome.blueprint_executions[0], produced_evidence: true }] };
  assert.equal(supersededByValidation(gateWithNewerRunner("power-analysis-measured", measured)), 1);
});

test("a newer run that validly falsified the lead still forces a fresh review", () => {
  const output = gateWithNewerRunner("valid-falsification", {
    status: "failed",
    validation_summary: {
      overall_status: "failed", blueprints_total: 1, blueprints_passed: 0, blueprints_failed: 1,
      failed_checks: ["preregistered-endpoint"],
      handoff_check_resolutions: [{ check_id: "preregistered-endpoint", status: "failed", valid_falsification_result: true }],
    },
  });
  assert.equal(output.review.latest_validation_lane_id, "followup-runner-66");
  assert.equal(supersededByValidation(output), 1, "a genuine falsification no longer supersedes the stale review");
});
