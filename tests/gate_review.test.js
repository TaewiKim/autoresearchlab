"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, readJson, writeJson } = require("../src/shared/json");
const { buildGateReview } = require("../src/reporting/gate_review");
const { screenedPaper } = require("./helpers/screened_paper");

test("gate review exposes unified defer semantics before conclusion eligibility", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-defer-"));
  const root = path.join(cwd, ".research-lab");
  ["state", "runtime", "events"].forEach((dir) => ensureDir(path.join(root, dir)));

  const output = buildGateReview({
    cwd,
    cycleId: "cycle-gate-defer-0001",
    researcherView: {
      jsonPath: path.join(root, "researcher-views", "cycle-gate-defer-0001-researcher-view.json"),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        objective: "Minimal gate defer case",
        evidence_readiness: { ready: false, reasons: ["waiting on evidence"] },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: false,
        conclusion_score: 72,
        conclusion_blockers: [
          "Reproducibility: method validation still looks too weak for reliable repetition",
        ],
        conclusion_rubric: [
          {
            name: "reproducibility",
            score: 72,
            reasons: [
              "Reproducibility: method validation still looks too weak for reliable repetition",
            ],
            applicable: true,
          },
        ],
        recommended_followup_actions: [
          {
            type: "accuracy_followup",
            preferred_role: "lab-runner",
            target_rubric: "reproducibility",
            description: "repeat analysis with stricter validation checks",
          },
        ],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: false,
      },
    },
  });

  assert.equal(output.review.mode, "defer");
  assert.equal(output.review.pass, false);
  // With ``buildFinalClaimPackage`` deleted, ``decision_mode`` now mirrors
  // the gate-review ``mode`` directly instead of applying a legacy
  // package-level status mapping.
  assert.equal(output.review.decision_mode, "defer");
  assert.ok(Array.isArray(output.review.blockers));
  assert.match(output.review.blockers.join("\n"), /method validation/);
  assert.match(output.review.scientific_gate_comments[0].comment, /method validation/);
  assert.equal(output.review.recommended_followup_actions.some((item) => item.type === "accuracy_followup"), true);
  assert.equal(output.review.final_claim_package_path, null);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review marks repeated repository workflow blockers as exhausted before runner repeat", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-repo-exhausted-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-repo-exhausted-0001";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

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

  for (const laneId of ["followup-runner-001", "followup-runner-002"]) {
    const runnerDir = path.join(root, "lanes", cycleId, laneId);
    const runnerExternalDir = path.join(
      root,
      "artifacts",
      "stats",
      cycleId,
      laneId,
      "external-agents",
      "fixture-omics-repo",
    );
    ensureDir(runnerDir);
    ensureDir(runnerExternalDir);
    writeJson(path.join(runnerDir, "role-plan.json"), {
      role: "lab-runner",
      action_type: "methods_followup",
    });
    writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
    writeJson(path.join(runnerExternalDir, "external_repository_agent_summary.json"), {
      status: "completed",
      substantive_repository_workflow_applied: false,
      substantive_workflow_blockers: [
        "no CSV matched a repository-native differential feature workflow input contract",
      ],
      repo_workflow_runs: [
        {
          workflow_name: "fixture diff workflow",
          status: "blocked",
          substantive: false,
          reason: "no CSV matched a repository-native differential feature workflow input contract",
        },
      ],
    });
    writeJson(path.join(runnerDir, "result.json"), {
      validation_summary: {
        overall_status: "inconclusive",
        open_source_agent_requirements: {
          repository_agent_required: true,
          repository_agent_applied: true,
          repository_agent_application_completed: true,
          substantive_repository_workflow_applied: false,
          real_repository_agent_names: ["fixture/omics-repo"],
          external_agent_workflow_summaries: [
            {
              agent_name: "fixture/omics-repo",
              stage: "application",
              status: "completed",
              output_dir: runnerExternalDir,
              substantive_repository_workflow_applied: false,
              substantive_workflow_blockers: [
                "no CSV matched a repository-native differential feature workflow input contract",
              ],
            },
          ],
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
  }

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "A high-dimensional omics signature is internally validated.",
        objective: "Repeated omics repository workflow blocker case",
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
      review: { approval_gate_passed: true },
    },
  });

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.open_source_agent_gate_review.repository_workflow_exhausted, true);
  assert.equal(
    output.review.open_source_agent_gate_review.repository_workflow_repetition.repeated_count,
    2,
  );
  const recoveryAction = output.review.recommended_followup_actions.find((item) =>
    item.open_source_agent_requirement?.repository_workflow_exhausted === true
  );
  assert.equal(recoveryAction?.preferred_role, "analyst");
  assert.equal(recoveryAction?.repository_workflow_exhausted, true);
  assert.match(
    recoveryAction?.failed_runner_context?.recovery_instruction || "",
    /must not issue another handoff that reuses this workflow unchanged/,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review exposes unified pass semantics when a gatekeeper approve review is parsed", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-pass-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-pass-0001";
  const laneDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(root, "state", `${cycleId}-strategy-decision.json`), {
    cycle_id: cycleId,
    mode: "hold",
    reason: "initial signal is stable enough for reporting",
  });
  writeJson(path.join(laneDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(laneDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(laneDir, "result.json"), {
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

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        lead_outcome: "primary",
        lead_outcome_label: "Primary Outcome",
        strongest_claim_summary: "The primary outcome remains the lead signal.",
        objective: "Gate approval case",
        evidence_readiness: { ready: true, reasons: [] },
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

  const stored = readJson(path.join(root, "state", `${cycleId}-gate-review.json`));
  assert.equal(output.review.gate_passed, true);
  assert.equal(output.review.pass, true);
  assert.equal(output.review.score, 96);
  // ``decision_mode`` now mirrors the gatekeeper verdict (``approve``) rather
  // than the former ``buildFinalClaimPackage``-level ``approved`` label.
  assert.equal(output.review.decision_mode, "approve");
  assert.equal(stored.pass, true);
  assert.equal(output.review.final_claim_package_path, null);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review can pass hypothesis gate before document approval gate", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-before-doc-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-before-doc-0001";
  const laneDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(laneDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(laneDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(laneDir, "result.json"), {
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
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        objective: "Hypothesis gate before document gate",
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
        approval_gate_passed: false,
      },
    },
  });

  assert.equal(output.review.conclusion_gate_passed, true);
  assert.equal(output.review.approval_gate_passed, false);
  assert.equal(output.review.gate_passed, true);
  assert.equal(output.review.pass, true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("missing technical and STROBE rubrics become critical targeted gatekeeper actions", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-critical-rubrics-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-critical-rubrics";
  ["state", "runtime", "events"].forEach((dir) => ensureDir(path.join(root, dir)));

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        // STROBE is an observational-epidemiology reporting standard, and the
        // gate only carries it for a BIOMEDICAL objective -- a rendering study
        // asked to fill in observational-study reporting elements holds a
        // blocker it can never satisfy. This test is about scheduling the STROBE
        // rubric, so the objective has to be one the rubric applies to.
        objective: "Observational transcriptomic cohort: differential expression across liver-cell segments",
        evidence_readiness: { ready: true, reasons: [] },
        // A gatekeeper round is only scheduled when there is something to score.
        // cycle-g-v86 dispatched five reviewers against a package holding zero
        // hypotheses and zero validation results; they correctly answered that
        // there was nothing to assess, scored 0-12, and those zeros then pinned
        // the aggregate for four and a half hours. So an empty summary now holds
        // the rubric pending instead, and this fixture carries the evidence a
        // cycle at this point would actually have.
        focus_hypotheses: [
          { statement: "Liver-cell segments show higher oxidative stress in VILI than in AIH." },
        ],
        validation_results: [
          { summary: "Differential expression contrast computed across the liver-cell segments." },
        ],
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
    approvalReview: {
      review: {
        approval_gate_passed: false,
      },
    },
  });

  const actions = output.review.recommended_followup_actions.filter((item) =>
    item.type === "independent_gate_review_followup",
  );
  assert.equal(actions.length, 2);
  assert.equal(actions.every((item) => item.priority === "critical"), true);
  assert.equal(actions.every((item) => item.priority_score === 10000), true);
  assert.equal(actions.every((item) => item.avoid_redundant_work === true), true);
  assert.deepEqual(actions.map((item) => item.target_rubric).sort(), [
    "strobe_reporting_completeness",
    "technical_quality",
  ]);

  fs.rmSync(cwd, { recursive: true, force: true });
});

// The objective the paper below was reviewed against. The gate binds a
// receipt to it by hash, so the fixture and the cycle have to name the same
// one -- a paper screened for another question is not evidence for this one.
const GATE_CONTEXT_OBJECTIVE = "Gate context case";

test("gate review carries previous comments and Chronicle research context into gatekeeper followups", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-context-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-context-0001";
  ["state", "runtime", "events", "plans"].forEach((dir) => ensureDir(path.join(root, dir)));

  writeJson(path.join(root, "state", `${cycleId}-gate-review.json`), {
    scientific_gate_comments: [
      {
        source: "previous_gate_review",
        rubric: "novelty",
        severity: "blocking",
        comment: "Prior novelty objection remains unresolved against the latest baseline.",
      },
    ],
    blockers: ["novelty: incumbent family still looks crowded"],
    recommended_followup_actions: [
      {
        type: "independent_gate_review_followup",
        preferred_role: "gatekeeper",
        target_rubric: "novelty",
        blocker_reasons: ["compare against current NK-cell migration literature"],
      },
    ],
  });
  writeJson(path.join(root, "state", `${cycleId}-trend-summary.json`), {
    what_changed_since_previous_pass: ["A 2025 NK migration paper shifted the novelty baseline."],
    dominant_mechanisms: ["SAP-dependent NK migration"],
    latest_high_signal_lane_ids: ["scout-2025-nk"],
    open_gaps: ["independent cohort validation remains missing"],
  });
  writeJson(path.join(root, "state", `${cycleId}-research-trend-analysis.json`), {
    dominant_clusters: ["NK-cell migration and immune evasion"],
    rising_methods: ["single-cell spatial transcriptomics"],
    underexplored_gaps: ["tissue-specific ECM migration tests"],
  });
  // Screened, because `latest_papers` is screened evidence and nothing else:
  // a paper with no review receipt does not reach the rubric reviewer at all,
  // which is the whole point of the gate and was silently failing this test.
  writeJson(path.join(root, "plans", `${cycleId}-lab-director-literature.json`), {
    lanes: [
      {
        lane_id: "scout-2025-nk",
        papers: [
          screenedPaper(GATE_CONTEXT_OBJECTIVE, {
            title: "Recent NK Migration Paper",
            doi: "10.1000/nk-migration",
            journal: "Nature Immunology",
            venue: "Nature Immunology",
          }),
        ],
      },
    ],
  });
  writeJson(path.join(root, "state", `${cycleId}-literature-graph.json`), {
    nodes: [{ node_id: "n1", label: "NK migration", type: "mechanism" }],
    edges: [{ source: "n1", target: "n2", relation: "supports", paper_ids: ["10.1000/nk-migration"] }],
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      chronicle_reporting: {
        what_changed_since_previous_pass: ["Chronicle reports a shifted baseline."],
      },
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        objective: "Gate context case",
        evidence_readiness: { ready: true, reasons: [] },
        // A conclusion-ready cycle has something for the rubric reviewer to
        // read. Rubric reviews are no longer opened over an empty package —
        // see buildGateFollowupActions.
        validation_results: [
          { lane_id: "lab-runner-01", hypothesis_id: "h1", verdict: "passed", score: 91 },
        ],
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 97,
        conclusion_rubric: [
          { name: "novelty", score: 96, reasons: [], applicable: true },
          { name: "technical_quality", score: 96, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: {
      review: {
        approval_gate_passed: true,
      },
    },
  });

  assert.equal(output.review.gate_reviewer_context.required_for_gatekeeper, true);
  assert.match(
    output.review.gate_reviewer_context.previous_review_context.review_comments.map((item) => item.comment).join("\n"),
    /Prior novelty objection/,
  );
  assert.equal(
    output.review.gate_reviewer_context.chronicle_research_context.latest_papers.some((item) => item.title === "Recent NK Migration Paper"),
    true,
  );
  const followup = output.review.recommended_followup_actions.find((item) => item.preferred_role === "gatekeeper");
  assert.ok(followup);
  assert.equal(followup.previous_review_context.required_for_gatekeeper, true);
  assert.equal(followup.chronicle_research_context.required_for_gatekeeper, true);
  assert.match(followup.reviewer_must_read_context.join("\n"), /chronicle_research_context/);
  assert.equal(followup.impact_first_hypothesis_mandate.active, true);
  assert.equal(followup.planner_metadata.impact_first_hypothesis_mandate.active, true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("LabDirector blocker review requests become targeted gatekeeper followups", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-blocker-request-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-blocker-request-0001";
  const directorLane = path.join(root, "lanes", cycleId, "followup-lab-director-01");
  ["state", "runtime", "events", directorLane].forEach((dir) => ensureDir(dir));

  writeJson(path.join(directorLane, "role-plan.json"), {
    role: "lab-director",
    action_type: "lab_director_requery_followup",
  });
  writeJson(path.join(directorLane, "final-status.json"), { status: "completed" });
  writeJson(path.join(directorLane, "result.json"), {
    output_last_message: JSON.stringify({
      requery_decision: "uphold",
      summary: "New validation resolved the stale technical-quality objection.",
      rationale: "The latest runner now has a materialized master table and sensitivity artifacts.",
      replacement_hypotheses: [],
      validation_changes: [],
      gate_blocker_review_requests: [
        {
          request_id: "remove-stale-methods-blocker",
          blocker: "Technical quality: methodological validation is still not strong enough",
          target_rubric: "technical_quality",
          requested_action: "remove",
          rationale: "followup-runner-204 supplied the missing validation artifacts.",
          evidence_refs: ["followup-runner-204/validation-summary.json"],
          replacement_blocker: null,
        },
      ],
      next_actions: [],
    }),
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        objective: "Gate blocker review request case",
        latest_validation_lane_id: "followup-runner-204",
        latest_validation_summary: { overall_status: "completed", checks_passed: 8, checks_total: 9 },
        evidence_readiness: { ready: true, reasons: [] },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: false,
        conclusion_score: 78,
        conclusion_blockers: [
          "Technical quality: methodological validation is still not strong enough",
        ],
        conclusion_rubric: [
          { name: "technical_quality", score: 78, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: { review: { approval_gate_passed: false } },
  });

  const followup = output.review.recommended_followup_actions.find(
    (item) =>
      item.type === "independent_gate_review_followup" &&
      item.target_rubric === "technical_quality" &&
      item.review_mode === "lab_director_blocker_adjudication",
  );
  assert.ok(followup);
  assert.equal(followup.preferred_role, "gatekeeper");
  assert.equal(followup.lab_director_blocker_review_requests[0].requested_action, "remove");
  assert.match(followup.gate_reviewer_instructions.join("\n"), /adjudicate each challenged blocker/i);
  assert.equal(output.review.lab_director_blocker_review_requests.length, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gatekeeper blocker adjudications remove only independently resolved blockers", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-blocker-adjudication-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-blocker-adjudication-0001";
  const gatekeeperLane = path.join(root, "lanes", cycleId, "gatekeeper-technical-quality");
  ["state", "runtime", "events", gatekeeperLane].forEach((dir) => ensureDir(dir));

  const staleBlocker = "Technical quality: methodological validation is still not strong enough";
  const activeBlocker = "Technical quality: too few explicit falsification tests are attached to hypotheses";
  writeJson(path.join(gatekeeperLane, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "technical_quality",
  });
  writeJson(path.join(gatekeeperLane, "final-status.json"), { status: "completed" });
  writeJson(path.join(gatekeeperLane, "result.json"), {
    output_last_message: JSON.stringify({
      reviewer_id: "technical-quality-reviewer",
      reviewer_focus_rubric: "technical_quality",
      reviewer_standard: "research",
      verdict: "approve",
      summary: "The stale method-validation blocker is resolved, but falsification depth still matters.",
      rubric: [
        {
          name: "technical_quality",
          score: 94,
          reasons: ["Latest validation artifacts are adequate for the narrowed claim."],
          applicable: true,
        },
      ],
      major_objections: [],
      missing_validations: [],
      blocker_adjudications: [
        {
          blocker: staleBlocker,
          decision: "resolved",
          rationale: "Latest validation artifact directly resolves this exact objection.",
          target_rubric: "technical_quality",
          evidence_refs: ["followup-runner-204/validation-summary.json"],
        },
        {
          blocker: activeBlocker,
          decision: "uphold",
          rationale: "Falsification tests remain insufficient.",
          target_rubric: "technical_quality",
          evidence_refs: [],
        },
      ],
      required_response_from_lab_director: [],
      restart_recommended: false,
      recommended_actions: [],
    }),
  });

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        objective: "Gate blocker adjudication case",
        evidence_readiness: { ready: true, reasons: [] },
      },
    },
    conclusionReview: {
      review: {
        conclusion_gate_passed: true,
        conclusion_score: 91,
        conclusion_blockers: [staleBlocker, activeBlocker],
        conclusion_rubric: [
          { name: "technical_quality", score: 91, reasons: [], applicable: true },
        ],
      },
    },
    approvalReview: { review: { approval_gate_passed: true } },
  });

  assert.equal(output.review.raw_gate_scientific_blockers.includes(staleBlocker), true);
  assert.equal(output.review.gate_scientific_blockers.includes(staleBlocker), false);
  assert.equal(output.review.gate_scientific_blockers.includes(activeBlocker), true);
  assert.equal(output.review.gate_blocker_adjudication_resolution.removed_blockers.length, 1);
  assert.equal(output.review.gate_blocker_adjudication_resolution.upheld_blockers.length, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review requires generic external validation before closing single-source high-score claims", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-external-required-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-external-required-0001";
  const laneDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );

  writeJson(path.join(laneDir, "role-plan.json"), {
    role: "gatekeeper",
    action_type: "independent_gate_review_followup",
    target_rubric: "novelty",
  });
  writeJson(path.join(laneDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(laneDir, "result.json"), {
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

  const output = buildGateReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        cycle_status: "completed",
        execution_completion: "completed",
        strongest_claim_summary: "Dataset-internal signal from a single public slice remains internally reproducible.",
        objective: "External validation required case",
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

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.mode, "challenge");
  assert.equal(output.review.external_validation_review.required_for_gate, true);
  assert.equal(output.review.external_validation_review.needs_external_validation, true);
  assert.equal(
    output.review.recommended_followup_actions.some((item) => item.type === "external_validation_followup"),
    true,
  );
  assert.match(output.review.blockers.join("\n"), /additional validation/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review blocks mandatory omics analysis when only generic adapter ran", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-open-source-agent-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-open-source-agent-0001";
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
  writeJson(path.join(runnerDir, "role-plan.json"), {
    role: "lab-runner",
    action_type: "methods_followup",
  });
  writeJson(path.join(runnerDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(runnerDir, "result.json"), {
    validation_summary: {
      overall_status: "degraded",
      open_source_agent_requirements: {
        repository_agent_required: true,
        repository_agent_applied: false,
        generic_adapter_agent_names: ["python-open-source-workflow-adapter"],
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
              name: "python-open-source-workflow-adapter",
              url: "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
            },
          },
          selected_open_source_analysis_agent: {
            name: "python-open-source-workflow-adapter",
            url: "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
          },
        },
      },
    },
    external_agent_runs: [
      {
        agent_name: "python-open-source-workflow-adapter",
        stage: "application",
        status: "completed",
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
        objective: "Omics open-source agent gate case",
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

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.mode, "challenge");
  assert.equal(output.review.open_source_agent_gate_review.required_for_gate, true);
  assert.match(output.review.blockers.join("\n"), /real external repository/);
  assert.equal(
    output.review.recommended_followup_actions.some((item) =>
      item.preferred_role === "analyst" &&
      item.open_source_agent_requirement?.repository_agent_required === true
    ),
    true,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review blocks mandatory omics analysis when real repo only profiles CSVs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-gate-repo-profile-only-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-gate-repo-profile-only-0001";
  const gatekeeperDir = path.join(root, "lanes", cycleId, "gatekeeper-001");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  const runnerExternalDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-001", "external-agents", "fixture-omics-repo");
  ["state", "runtime", "events", path.join("lanes", cycleId, "gatekeeper-001"), path.join("lanes", cycleId, "followup-runner-001")].forEach((dir) =>
    ensureDir(path.join(root, dir)),
  );
  ensureDir(runnerExternalDir);

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
  writeJson(path.join(runnerDir, "role-plan.json"), {
    role: "lab-runner",
    action_type: "methods_followup",
  });
  writeJson(path.join(runnerDir, "final-status.json"), {
    status: "completed",
  });
  writeJson(path.join(runnerExternalDir, "external_repository_agent_summary.json"), {
    status: "completed",
    substantive_repository_workflow_applied: false,
    repo_workflow_runs: [
      {
        workflow_name: "profile-only",
        status: "completed",
        substantive: false,
      },
    ],
  });
  writeJson(path.join(runnerDir, "result.json"), {
    validation_summary: {
      overall_status: "inconclusive",
      open_source_agent_requirements: {
        repository_agent_required: true,
        repository_agent_applied: true,
        repository_agent_application_completed: true,
        substantive_repository_workflow_applied: false,
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
        objective: "Omics profile-only repo gate case",
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

  assert.equal(output.review.gate_passed, false);
  assert.equal(output.review.open_source_agent_gate_review.required_for_gate, true);
  assert.match(output.review.blockers.join("\n"), /repository-native workflow/);
  const recoveryAction = output.review.recommended_followup_actions.find((item) =>
    item.open_source_agent_requirement?.repository_agent_required === true
  );
  assert.equal(recoveryAction?.type, "methods_followup");
  assert.equal(recoveryAction?.preferred_role, "analyst");
  assert.equal(recoveryAction?.failed_runner_context?.lane_id, "followup-runner-001");
  assert.match(
    recoveryAction?.failed_runner_context?.recovery_instruction || "",
    /Analyst must resolve/,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});
