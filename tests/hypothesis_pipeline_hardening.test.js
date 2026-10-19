"use strict";

// Unit tests for the hypothesis-pipeline hardening pass.
// Covers the six behaviours introduced by that change set:
//   1. Tournament elimination — ≥2 pairwise losses demotes the family
//   2. design_shifts required in next-cycle-plan when robustness failure > 0.5
//   3. identification_strategy stamped on derived hypothesis candidates
//   4. design_constraints append + read round-trip
//   5. Falsifier role plan emits adversarial review_goal
//   6. Gatekeeper review_mode="falsifier" flips the review_goal

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildFamilyPackageLedger } = require("../src/agents/chronicle/family_package_ledger");
const {
  generateDerivedHypotheses,
  IDENTIFICATION_STRATEGIES,
} = require("../src/agents/chronicle/hypothesis_generator");
const {
  appendDesignConstraint,
  readDesignConstraints,
  deriveConstraintsFromCycle,
  matchConstraintViolations,
} = require("../src/agents/chronicle/design_constraints");
const cycleStateArtifacts = require("../src/agents/chronicle/cycle_state_artifacts");
const { buildRolePlan } = require("../src/agents/index");
const { buildDynamicAgentPlan } = require("../src/agents/lab_director/agent_plan");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rl-hardening-"));
}

function withLiteratureNetworkPolicy(value, fn) {
  const previous = process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  if (value === null) delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  else process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
    else process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = previous;
  }
}

test("family_package_ledger: ≥2 pairwise losses force-demote family", () => {
  const cwd = makeTmp();
  const hypotheses = [
    { hypothesis_id: "h1", family_root: "dtp3_coverage", state: "contending", primary_exposure: "dtp3", y_variable: "neonatal" },
    { hypothesis_id: "h2", family_root: "zero_dose", state: "contending", primary_exposure: "zero_dose", y_variable: "neonatal" },
  ];
  const evidencePackets = {
    evidence_packets: [
      {
        family_root: "dtp3_coverage",
        family_implications: [{ family_id: "family:dtp3_coverage", delta_score: -4 }],
        tested_edges: [{
          robustness: {
            validation_outcomes: [
              { validation_type: "family_pairwise_contest", verdict: "falsified" },
              { validation_type: "family_pairwise_contest", verdict: "falsified" },
              { validation_type: "edge_robustness_test", verdict: "weakened" },
            ],
          },
        }],
      },
      {
        family_root: "zero_dose",
        family_implications: [{ family_id: "family:zero_dose", delta_score: 2 }],
        tested_edges: [{
          robustness: {
            validation_outcomes: [
              { validation_type: "family_pairwise_contest", verdict: "supported" },
            ],
          },
        }],
      },
    ],
  };
  const result = buildFamilyPackageLedger({
    cwd,
    cycleId: "cycle-test-001",
    hypotheses,
    evidencePackets,
    graphDiff: null,
  });
  const dtp3 = result.summary.family_packages.find((p) => p.family_root === "dtp3_coverage");
  const zd = result.summary.family_packages.find((p) => p.family_root === "zero_dose");
  assert.equal(dtp3.pairwise_loss_count, 2);
  assert.equal(dtp3.package_state, "demoted");
  assert.ok(dtp3.package_penalties.includes("pairwise_tournament_elimination"));
  assert.equal(zd.pairwise_loss_count, 0);
  assert.notEqual(zd.package_state, "demoted");
});

test("family_package_ledger: 1 pairwise loss flips candidate to challenged", () => {
  const cwd = makeTmp();
  const hypotheses = [
    { hypothesis_id: "h1", family_root: "coverage_measurement", state: "candidate" },
  ];
  const evidencePackets = {
    evidence_packets: [
      {
        family_root: "coverage_measurement",
        family_implications: [],
        tested_edges: [{
          robustness: {
            validation_outcomes: [
              { validation_type: "family_pairwise_contest", verdict: "falsified" },
            ],
          },
        }],
      },
    ],
  };
  const result = buildFamilyPackageLedger({
    cwd,
    cycleId: "cycle-test-002",
    hypotheses,
    evidencePackets,
    graphDiff: null,
  });
  const pkg = result.summary.family_packages[0];
  assert.equal(pkg.pairwise_loss_count, 1);
  assert.equal(pkg.package_state, "challenged");
  assert.ok(pkg.package_penalties.includes("pairwise_loss_warning"));
});

test("generateDerivedHypotheses: candidates carry identification_strategy", () => {
  const hypotheses = [
    { hypothesis_id: "A", x_variable: "dtp3", y_variable: "neonatal", condition: "africa" },
    { hypothesis_id: "B", x_variable: "dtp3", y_variable: "neonatal", condition: "europe" },
  ];
  const cands = generateDerivedHypotheses(hypotheses);
  assert.ok(cands.length >= 1);
  for (const c of cands) {
    assert.ok(c.identification_strategy);
    assert.ok(
      IDENTIFICATION_STRATEGIES.includes(c.identification_strategy),
      `unknown strategy: ${c.identification_strategy}`,
    );
  }
});

test("generateDerivedHypotheses: does not confuse rollout wording with an event-study design", () => {
  const hypotheses = [
    { hypothesis_id: "A", x_variable: "dtp3", y_variable: "neonatal", condition: "after policy rollout of Gavi" },
    { hypothesis_id: "B", x_variable: "dtp3", y_variable: "neonatal", condition: "before policy rollout" },
  ];
  const cands = generateDerivedHypotheses(hypotheses);
  assert.ok(cands.length >= 1);
  assert.equal(cands[0].source_identification_strategy, "unspecified");
  assert.equal(cands[0].identification_strategy, "paired_intervention");
});

test("design_constraints: append + read round-trip and violation match", () => {
  const cwd = makeTmp();
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  const row = appendDesignConstraint(cwd, {
    cycle_id: "cycle-x",
    pattern: { identification_strategy: "observational_panel" },
    lesson: "Observational panel exhausted; require design shift.",
  });
  const rows = readDesignConstraints(cwd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  const candidate = { identification_strategy: "observational_panel" };
  const violations = matchConstraintViolations(candidate, rows);
  assert.deepEqual(violations, [row.id]);
  const cleanCandidate = { identification_strategy: "diff_in_diff" };
  assert.deepEqual(matchConstraintViolations(cleanCandidate, rows), []);
});

test("deriveConstraintsFromCycle: emits panel-exhaustion constraint when robustness > 0.5", () => {
  const constraints = deriveConstraintsFromCycle({
    cycleId: "cycle-derive",
    summary: { design_block_reasons: ["composite_score_below_threshold"] },
    nextCyclePlan: {
      robustness_failure_ratio: 0.72,
      // A strategy-switch shift with domain-appropriate strategies (the planner
      // now carries these from the ③ registry rather than a hardcoded epi list).
      design_shifts: [
        {
          type: "switch_identification_strategy",
          suggested_strategies: ["within_unit_change", "difference_in_differences"],
        },
      ],
    },
  });
  assert.ok(constraints.length >= 2);
  // The constraint pattern is domain-neutral now ("current_cycle_approach"),
  // not the old hardcoded "observational_panel".
  assert.ok(constraints.some((c) => c.pattern.identification_strategy === "current_cycle_approach"));
});

test("deriveConstraintsFromCycle: empty when healthy cycle", () => {
  const constraints = deriveConstraintsFromCycle({
    cycleId: "cycle-healthy",
    summary: { design_block_reasons: [] },
    nextCyclePlan: { robustness_failure_ratio: 0.12, design_shifts: [] },
  });
  assert.equal(constraints.length, 0);
});

test("buildNextCyclePlan: design_shifts populated when robustness fails", () => {
  const plan = cycleStateArtifacts.__testHooks
    ? cycleStateArtifacts.__testHooks.buildNextCyclePlan
    : null;
  // cycle_state_artifacts doesn't currently expose buildNextCyclePlan —
  // exercise it via writeCycleStateArtifacts' call shape instead.
  const cwd = makeTmp();
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".research-lab", "runtime"), { recursive: true });
  const artifacts = cycleStateArtifacts.writeCycleStateArtifacts({
    cwd,
    cycleId: "cycle-shifts",
    familyNomination: [],
    // Every hypothesis has latest_status="weak" → every synthetic
    // validation becomes "completed_with_warning" → robustness_failure_ratio
    // is 1.0, so design_shifts must be non-empty.
    hypotheses: [
      {
        hypothesis_id: "h1",
        family_root: "panel_only",
        latest_status: "weak",
        support_count: 3,
        validation_protocol: { model: "ols" },
        analysis_results: [{ metrics: [{ metric: "r", value: -0.06 }] }],
      },
    ],
    validationPlan: {
      planned_validations: [
        {
          validation_id: "v1",
          validation_type: "edge_robustness_test",
          target_hypothesis_ids: ["h1"],
          target_family_ids: ["panel_only"],
        },
      ],
    },
    dataGraph: { nodes: [], edges: [] },
    graphDiff: { updates: [] },
    familyPackageLedger: {
      family_packages: [
        { family_root: "panel_only", pairwise_loss_count: 2, family_score: -3, top_hypothesis_score: 35, support_count: 1 },
      ],
      incumbent_family: "panel_only",
    },
  });
  const plan2 = artifacts.nextCyclePlanArtifact;
  assert.ok(Array.isArray(plan2.design_shifts));
  assert.ok(plan2.design_shifts.length > 0, "design_shifts must be non-empty when robustness fails");
  assert.ok(plan2.robustness_failure_ratio > 0.5);
  assert.ok(
    plan2.carry_forward_rules.some((r) => r.includes("design_shift")),
    "carry_forward_rules should mention design_shift when shifts are present",
  );
});

test("writeCycleStateArtifacts: claim traces tie claims to lanes, transforms, and validation outputs", () => {
  const cwd = makeTmp();
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".research-lab", "artifacts", "stats", "cycle-trace", "followup-scout-02"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".research-lab", "lanes", "cycle-trace", "followup-scout-02"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "artifacts", "stats", "cycle-trace", "followup-scout-02", "analysis-trace.json"),
    JSON.stringify({ stages: [{ stage: "LOOK" }] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "lanes", "cycle-trace", "followup-scout-02", "result.json"),
    JSON.stringify({ status: "completed" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "artifacts", "stats", "cycle-trace", "followup-scout-02", "validation-summary.json"),
    JSON.stringify({ checks: { sanity: true } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-validation-plan.json"),
    JSON.stringify({ planned_validations: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-evidence-packets.json"),
    JSON.stringify({ evidence_packets: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-graph-update-log.json"),
    JSON.stringify({ updates: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-data-graph.json"),
    JSON.stringify({ nodes: [], edges: [] }),
    "utf8",
  );

  const artifacts = cycleStateArtifacts.writeCycleStateArtifacts({
    cwd,
    cycleId: "cycle-trace",
    familyNomination: [],
    hypotheses: [
      {
        hypothesis_id: "h-trace",
        statement: "cells may affect disease differently under immune.",
        latest_status: "exploratory",
        validating_lanes: ["followup-scout-02"],
        source_graphs: ["literature"],
        validation_protocol: { dataset: "cycle-data-graph", model: "conditional graph-grounded validation model" },
        claims: [
          {
            claim_id: "claim:h-trace",
            statement: "cells may affect disease differently under immune.",
            supporting_papers: ["Paper A"],
            status: "candidate",
          },
        ],
      },
    ],
    validationPlan: {
      planned_validations: [
        {
          validation_id: "v-trace-1",
          validation_type: "edge_robustness_test",
          target_hypothesis_ids: ["h-trace"],
          target_family_ids: ["family:test"],
        },
      ],
    },
    dataGraph: { nodes: [], edges: [] },
    graphDiff: { updates: [] },
    familyPackageLedger: { family_packages: [] },
    evidencePackets: {
      evidence_packets: [
        {
          hypothesis_id: "h-trace",
          provenance: ["followup-scout-02"],
          graph_updates: [
            { operation: "weaken", target_type: "edge" },
          ],
        },
      ],
    },
  });

  const trace = artifacts.claimTraceArtifact.claim_traces[0];
  assert.equal(artifacts.claimTraceArtifact.claim_trace_count, 1);
  assert.equal(trace.claim_id, "claim:h-trace");
  assert.deepEqual(trace.supporting_hypothesis_ids, ["h-trace"]);
  assert.deepEqual(trace.source_lanes, ["followup-scout-02"]);
  assert.ok(trace.source_lane_artifact_paths.some((item) => item.endsWith("result.json")));
  assert.ok(trace.analysis_trace_paths.some((item) => item.endsWith("analysis-trace.json")));
  assert.ok(trace.validation_output_paths.some((item) => item.endsWith("validation-results.json")));
  assert.ok(trace.data_transform_steps.includes("normalize_validation_outcomes"));
  assert.ok(trace.data_transform_steps.includes("graph_update:weaken:edge"));
  assert.deepEqual(trace.trace_gaps, []);
  assert.equal(trace.trace_complete, true);
});

test("writeCycleStateArtifacts: claim traces stay incomplete when source-lane artifacts are missing", () => {
  const cwd = makeTmp();
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-missing-validation-plan.json"),
    JSON.stringify({ planned_validations: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-missing-evidence-packets.json"),
    JSON.stringify({ evidence_packets: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-missing-graph-update-log.json"),
    JSON.stringify({ updates: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", "cycle-trace-missing-data-graph.json"),
    JSON.stringify({ nodes: [], edges: [] }),
    "utf8",
  );

  const artifacts = cycleStateArtifacts.writeCycleStateArtifacts({
    cwd,
    cycleId: "cycle-trace-missing",
    familyNomination: [],
    hypotheses: [
      {
        hypothesis_id: "h-trace-missing",
        statement: "cells may affect disease differently under rejection.",
        latest_status: "exploratory",
        validating_lanes: ["followup-scout-03"],
        source_graphs: ["literature"],
        validation_protocol: { dataset: "cycle-data-graph", model: "conditional graph-grounded validation model" },
      },
    ],
    validationPlan: {
      planned_validations: [
        {
          validation_id: "v-trace-missing-1",
          validation_type: "edge_robustness_test",
          target_hypothesis_ids: ["h-trace-missing"],
          target_family_ids: ["family:test"],
        },
      ],
    },
    dataGraph: { nodes: [], edges: [] },
    graphDiff: { updates: [] },
    familyPackageLedger: { family_packages: [] },
    evidencePackets: {
      evidence_packets: [
        {
          hypothesis_id: "h-trace-missing",
          provenance: ["followup-scout-03"],
        },
      ],
    },
  });

  const trace = artifacts.claimTraceArtifact.claim_traces[0];
  assert.ok(trace.trace_gaps.includes("source_lane_artifacts"));
  assert.equal(trace.trace_complete, false);
});

test("buildRolePlan: falsifier role emits adversarial review_goal", () => {
  const plan = buildRolePlan({
    prompt: "review the cycle claim set",
    lane: { lane_id: "falsifier-01", role: "falsifier" },
    cycleId: "cycle-f",
    researchStage: "gate",
  });
  assert.equal(plan.role, "falsifier");
  assert.equal(plan.adversarial, true);
  assert.equal(plan.review_mode, "falsifier");
  assert.ok(/refute|break|falsif/i.test(plan.review_goal), "review_goal should be adversarial");
});

test("buildRolePlan: gatekeeper with review_mode=falsifier inverts goal", () => {
  const plan = buildRolePlan({
    prompt: "adversarial review",
    lane: { lane_id: "gk-adv-01", role: "gatekeeper", review_mode: "falsifier" },
    cycleId: "cycle-f2",
    researchStage: "gate",
  });
  assert.equal(plan.role, "gatekeeper");
  assert.equal(plan.adversarial, true);
  assert.equal(plan.review_mode, "falsifier");
  assert.ok(/refute|break|falsif/i.test(plan.review_goal));
});

test("buildRolePlan: gatekeeper default mode keeps canonical review_goal", () => {
  const plan = buildRolePlan({
    prompt: "standard gate review",
    lane: { lane_id: "gk-01", role: "gatekeeper" },
    cycleId: "cycle-f3",
    researchStage: "gate",
  });
  assert.equal(plan.adversarial, false);
  assert.equal(plan.review_mode, "gate");
  assert.ok(/gate criteria|blocker|approval/i.test(plan.review_goal));
});

test("buildRolePlan: gatekeeper receives previous reviews and Chronicle research context", () => {
  const plan = buildRolePlan({
    prompt: "standard gate review with context",
    lane: { lane_id: "gk-context-01", role: "gatekeeper" },
    cycleId: "cycle-gk-context",
    researchStage: "gate",
    cyclePlanningContext: {
      gate_review: {
        gate_reviewer_context: {
          previous_review_context: {
            source: "gate_review_memory",
            previous_gate_review_path: "/tmp/gate-review.json",
            review_comments: [
              {
                source: "previous_gate_review",
                rubric: "novelty",
                severity: "blocking",
                comment: "Prior novelty objection remains unresolved.",
              },
            ],
            unresolved_blockers: ["Prior novelty objection remains unresolved."],
          },
          chronicle_research_context: {
            source: "chronicle",
            latest_research_trends: ["spatial transcriptomics is now a crowded baseline"],
            latest_papers: [
              {
                title: "Recent Spatial Transcriptomics Baseline",
                year: 2025,
                doi: "10.1000/spatial-baseline",
              },
            ],
          },
        },
      },
    },
  });

  assert.equal(plan.previous_review_context.required_for_gatekeeper, true);
  assert.match(plan.previous_review_context.review_comments[0].comment, /Prior novelty objection/);
  assert.equal(plan.chronicle_research_context.latest_papers[0].title, "Recent Spatial Transcriptomics Baseline");
  assert.equal(plan.review_context_policy.must_read_previous_review_comments, true);
  assert.equal(plan.review_context_policy.must_use_chronicle_research_context, true);
  assert.match(plan.review_goal, /previous_review_context/);
  assert.match(plan.review_goal, /chronicle_research_context/);
});

test("buildRolePlan: lab-director applies impact-first mandate before lead selection", () => {
  const plan = buildRolePlan({
    prompt: "Find a strong omics hypothesis",
    lane: { lane_id: "lab-director-01", role: "lab-director" },
    cycleId: "cycle-impact-first",
    researchStage: "evidence",
  });
  assert.equal(plan.role, "lab-director");
  assert.equal(plan.action_type, "hypothesis_strategy_followup");
  assert.equal(plan.impact_first_hypothesis_mandate.active, true);
  assert.equal(plan.impact_first_hypothesis_mandate.policy_version, "typed-evidence-admission-v3");
  assert.equal(plan.impact_first_hypothesis_mandate.minimum_initial_scores.expected_impact_score, null);
  assert.deepEqual(plan.impact_first_hypothesis_mandate.evidence_routes, [
    "literature_frontier", "controlled_simulation", "physical_experiment",
    "human_study", "formal_proof", "observational_dataset", "benchmark",
  ]);
  assert.deepEqual(plan.impact_first_hypothesis_mandate.admission_states, [
    "exploration_candidate_selected", "validation_lead_ready",
  ]);
  assert.ok(plan.impact_first_hypothesis_mandate.required_candidate_fields.includes("state_of_art_delta"));
  assert.ok(plan.impact_first_hypothesis_mandate.required_candidate_fields.includes("validation_dataset_accession_or_bundle"));
  assert.ok(plan.impact_first_hypothesis_mandate.required_candidate_fields.includes("validation_variable_mapping"));
  assert.ok(plan.impact_first_hypothesis_mandate.required_candidate_fields.includes("why_not_merely_audit"));
  for (const field of [
    "research_question", "mechanism", "procedure_signature", "closest_prior_art",
    "prior_art_evidence_scope", "novelty_delta", "strongest_inversion", "boring_baseline",
    "primary_estimand", "smallest_useful_effect", "falsification_criteria", "null_contribution",
    "instrument_limitations",
  ]) assert.ok(plan.impact_first_hypothesis_mandate.required_candidate_fields.includes(field));
  assert.equal(plan.decision_policy.must_score_validation_data_availability, true);
  assert.match(plan.role_boundary.supervisor, /does not invent scientific hypotheses/i);
  assert.match(plan.role_boundary.lab_director, /Own research strategy/i);
  assert.equal(plan.supervisor_instruction_policy.must_direct_lab_director_on_stagnation, true);
  assert.ok(plan.supervisor_instruction_policy.supervisor_forbidden_actions.includes("invent_scientific_hypotheses"));
  assert.ok(plan.supervisor_instruction_policy.lab_director_required_response.includes("record_the_decision_and_rationale_in_research_notes"));
  assert.match(plan.impact_first_hypothesis_mandate.selection_rule, /typed evidence|procedure signature|mechanism/i);
  assert.ok(plan.required_output.some((item) => /impact-ranked candidate hypothesis table/i.test(item)));
  assert.ok(plan.required_output.some((item) => /validation-data availability ranking/i.test(item)));
});

test("buildRolePlan: initial scout-03 remains a data acquisition lane", () => {
  withLiteratureNetworkPolicy(null, () => {
    const plan = buildRolePlan({
      prompt: "Conduct a multi-omics data analysis",
      lane: { lane_id: "scout-03", role: "scout" },
      cycleId: "cycle-data-scout",
      researchStage: "evidence",
    });
    assert.equal(plan.role, "scout");
    assert.equal(plan.action_type, "reasoning_data_scout");
    assert.equal(plan.objective, "Conduct a multi-omics data analysis");
    assert.match(plan.followup_description, /DATA SCOUT PROTOCOL/);
    assert.match(plan.followup_description, /data_scout_browser\.py/);
    assert.ok(Array.isArray(plan.queries));
    assert.equal(plan.planner_metadata.forbid_hardcoded_domain_templates, true);
    assert.equal(plan.impact_first_hypothesis_mandate.active, true);
    assert.match(plan.planner_metadata.dataset_selection_priority, /validation-data availability/i);
  });
});

test("approved scholarly policy routes initial and data-followup Scouts to bounded literature evidence", () => {
  withLiteratureNetworkPolicy("approved-scholarly-metadata-v1", () => {
    const initial = buildRolePlan({
      prompt: "Evaluate robot clarification benchmarks and feasibility.",
      lane: { lane_id: "scout-03", role: "scout" }, cycleId: "cycle-approved", researchStage: "evidence",
    });
    const followup = buildRolePlan({
      prompt: "Evaluate robot clarification benchmarks and feasibility.",
      lane: { lane_id: "followup-scout-04", role: "scout", action_type: "data_acquisition_followup" }, cycleId: "cycle-approved", researchStage: "evidence",
    });
    for (const plan of [initial, followup]) {
      assert.equal(plan.action_type, "reasoning_literature_scout");
      assert.equal(plan.search_agent_contract.inquiry_focus.focus_id, "dataset_evaluation_feasibility_evidence");
      assert.equal(plan.search_agent_contract.inquiry_focus.allowed_evidence_scope, "approved scholarly metadata sources and the current cycle's local snapshot only");
      assert.doesNotMatch(plan.followup_description, /DATA SCOUT PROTOCOL/);
      assert.match(plan.followup_description, /do not invoke data_scout_browser\.py/i);
    }
    assert.equal(followup.requested_action_type, "data_acquisition_followup");
    const dynamic = buildDynamicAgentPlan({ prompt: "Evaluate robot clarification benchmarks.", catalogPath: "/tmp/catalog.json", researchStage: "evidence" });
    const dataScout = dynamic.agents.find((agent) => agent.agent_id === "scout-03");
    assert.match(dataScout.duty, /approved-scholarly data\/evaluation literature scout/i);
    assert.match(dataScout.duty, /do not download datasets/i);
  });
});

test("runner outputs normalize into validation results with provenance and block noisy topic edges", () => {
  const cwd = makeTmp();
  const cycleId = "cycle-runner-normalize";
  const laneId = "followup-runner-01";
  const laneDir = path.join(cwd, ".research-lab", "artifacts", "stats", cycleId, laneId);
  fs.mkdirSync(laneDir, { recursive: true });
  const resultPath = path.join(laneDir, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify({
    driver: "python-stats-driver",
    dataset_root: "/tmp/dataset",
    validation_summary_path: path.join(laneDir, "validation-summary.json"),
    analysis_trace_path: path.join(laneDir, "analysis-trace.json"),
    validation_summary: {
      mode: "blueprint-execution",
      overall_status: "inconclusive",
      primary_hypothesis_id: "h-noisy",
      checks_total: 2,
      checks_passed: 1,
      checks_failed: 1,
      failed_checks: ["primary_topic_detected"],
      method_appropriateness_score: 70,
      analysis_accuracy_score: 65,
    },
    selected_hypotheses: [{
      hypothesis_id: "h-noisy",
      family_root: "family-a",
      x_variable: "users_alice",
      y_variable: "topic_term_count",
      status: "exploratory",
    }],
  }), "utf8");

  const artifact = cycleStateArtifacts.buildValidationResultsArtifact({
    cwd,
    cycleId,
    hypotheses: [{ hypothesis_id: "h-noisy", family_root: "family-a", x_variable: "users_alice", y_variable: "topic_term_count" }],
    validationPlan: { planned_validations: [] },
  });

  const normalized = artifact.validation_results.find((item) => item.validation_id.includes(`validation:runner:${laneId}:h-noisy`));
  assert.ok(normalized, "runner validation should be materialized");
  assert.equal(normalized.provenance.lane_id, laneId);
  assert.equal(normalized.provenance.source_type, "runner_result");
  assert.equal(normalized.diagnostics.topic_extraction_quality.promotable, false);
  assert.deepEqual(normalized.target_edges, []);
});

test("runner normalization uses a promotable target when sibling targets are schema-blocked", () => {
  const cwd = makeTmp();
  const cycleId = "cycle-runner-mixed-targets";
  const laneId = "followup-runner-01";
  const laneDir = path.join(cwd, ".research-lab", "artifacts", "stats", cycleId, laneId);
  fs.mkdirSync(laneDir, { recursive: true });
  fs.writeFileSync(path.join(laneDir, "result.json"), JSON.stringify({
    driver: "python-stats-driver",
    dataset_root: "/tmp/dataset",
    validation_summary: {
      mode: "blueprint-execution",
      overall_status: "passed",
      primary_hypothesis_id: "h-mixed",
      checks_total: 2,
      checks_passed: 2,
      checks_failed: 0,
    },
    selected_hypotheses: [{
      hypothesis_id: "h-mixed",
      family_root: "family-a",
      x_variable: "marker_expression",
      y_variable: "survival_signal",
      status: "robust",
    }],
  }), "utf8");

  const artifact = cycleStateArtifacts.buildValidationResultsArtifact({
    cwd,
    cycleId,
    hypotheses: [{ hypothesis_id: "h-mixed", family_root: "family-a", x_variable: "marker_expression", y_variable: "survival_signal" }],
    validationPlan: { planned_validations: [
      {
        validation_id: "validation:h-mixed:blocked",
        target_hypothesis_ids: ["h-mixed"],
        target_edges: ["edge:blocked"],
        validation_target: { design_blocked: true, missing_requirements: ["entity_key"] },
      },
      {
        validation_id: "validation:h-mixed:ok",
        target_hypothesis_ids: ["h-mixed"],
        target_edges: ["edge:variable:marker-expression:variable:survival-signal:predicts"],
        validation_target: { design_blocked: false, selected_design_id: "adjusted_association_sensitivity" },
      },
    ] },
  });

  const normalized = artifact.validation_results.find((item) => item.validation_id.includes(`validation:runner:${laneId}:h-mixed`));
  assert.ok(normalized, "runner validation should be materialized");
  assert.equal(normalized.diagnostics.result_quality_gate.promotable, true);
  assert.equal(normalized.diagnostics.result_quality_gate.partial_design_block, true);
  assert.ok(normalized.target_edges.includes("edge:variable:marker-expression:variable:survival-signal:predicts"));
  assert.equal(normalized.target_edges.includes("edge:blocked"), false);
});

test("dataset profile drives generic validation design targets without domain hardcoding", () => {
  const { buildValidationPlan } = require("../src/agents/chronicle/data_graph_validation");
  const { buildDatasetProfile, selectValidationDesigns } = require("../src/agents/chronicle/dataset_design_selector");
  const profile = buildDatasetProfile({
    literature: {
      dataset_candidates: [{
        name: "candidate_bundle",
        files: [
          { path: "expression.csv", column_profiles: ["sample_id", "gene_expression_score", "batch"] },
          { path: "clinical.csv", column_profiles: ["sample_id", "survival_status", "age"] },
        ],
      }],
    },
  });
  const hypotheses = [{
    hypothesis_id: "h-schema",
    family_root: "family-schema",
    x_variable: "gene_expression_score",
    y_variable: "survival_status",
    state: "candidate",
  }];
  const designs = selectValidationDesigns(profile, hypotheses);
  const plan = buildValidationPlan({ hypotheses, datasetProfile: profile, validationDesignCandidates: designs });
  const first = plan.planned_validations[0];

  assert.equal(plan.dataset_profile.profile_quality, "structured");
  assert.ok(plan.validation_design_candidates.some((item) => item.design_id === "paired_concordance" && item.feasible));
  assert.equal(first.validation_target.design_blocked, false);
  assert.deepEqual(first.validation_target.required_pairing_or_join_keys, ["sample_id"]);
  assert.deepEqual(first.validation_target.candidate_exposure_variables, ["gene_expression_score"]);
  assert.deepEqual(first.validation_target.candidate_outcome_variables, ["survival_status"]);
  assert.ok(first.selected_design_id);
});

test("dataset profile reads materialized GEO expression and sample metadata", () => {
  const { buildValidationPlan } = require("../src/agents/chronicle/data_graph_validation");
  const { buildDatasetProfile, selectValidationDesigns } = require("../src/agents/chronicle/dataset_design_selector");
  const cwd = makeTmp();
  const cycleId = "cycle-geo-schema";
  const csvDir = path.join(cwd, ".research-lab", "datasets", cycleId, "gse-test", "csv");
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(path.join(csvDir, "gse-test-tpm.csv"), "gene_id,VGH001,VGH002,VGH003,VGH004,VGH005\nENSG1,1.0,2.0,3.0,4.0,5.0\n", "utf8");
  fs.writeFileSync(path.join(csvDir, "gse-test-series-matrix.geo-metadata.txt"), [
    '!Sample_geo_accession\t"GSM1"\t"GSM2"',
    '!Sample_characteristics_ch1\t"Sex: F"\t"Sex: M"',
    '!Sample_characteristics_ch1\t"disease state: P-MCI"\t"disease state: S-MCI"',
    '!Sample_characteristics_ch1\t"subject id: 1"\t"subject id: 2"',
    '!Sample_characteristics_ch1\t"age: 70y"\t"age: 72y"',
    '!Sample_description\t"Library name: VGH001"\t"Library name: VGH002"',
  ].join("\n"), "utf8");

  const profile = buildDatasetProfile({ cwd, cycleId });
  const hypotheses = [{
    hypothesis_id: "h-auto",
    family_root: "family-auto",
    x_variable: "auto_numeric_exposure",
    y_variable: "auto_numeric_outcome",
    state: "candidate",
  }];
  const designs = selectValidationDesigns(profile, hypotheses);
  const plan = buildValidationPlan({ hypotheses, datasetProfile: profile, validationDesignCandidates: designs });
  const target = plan.planned_validations[0].validation_target;

  assert.ok(profile.entity_keys.some((column) => column.name === "subject id"));
  assert.ok(profile.entity_keys.some((column) => column.name === "sample_id"));
  assert.ok(profile.outcome_candidates.some((column) => column.name === "disease state"));
  assert.ok(profile.exposure_candidates.some((column) => column.name === "tpm_matrix"));
  assert.ok(profile.numeric_columns.some((column) => column.name === "tpm_matrix"));
  assert.equal(target.design_blocked, false);
  assert.ok(target.mapping_warnings.includes("x_variable_unmapped_using_profile_exposure_candidates"));
  assert.ok(target.mapping_warnings.includes("y_variable_unmapped_using_profile_outcome_candidates"));
});

test("schema-blocked validation target prevents edge promotion", () => {
  const { buildValidationArtifacts } = require("../src/agents/chronicle/data_graph_validation");
  const cwd = makeTmp();
  const cycleId = "cycle-schema-blocked";
  fs.mkdirSync(path.join(cwd, ".research-lab", "plans"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".research-lab", "plans", `${cycleId}-lab-director-literature.json`), JSON.stringify({}), "utf8");

  const artifacts = buildValidationArtifacts({
    cwd,
    cycleId,
    hypotheses: [{
      hypothesis_id: "h-unmapped",
      statement: "unmapped feature predicts outcome",
      family_root: "family-unmapped",
      x_variable: "unmapped_feature",
      y_variable: "unmapped_outcome",
      latest_status: "robust",
      state: "candidate",
    }],
    familyStateSummary: [{ family_root: "family-unmapped", count: 1 }],
  });

  const planned = artifacts.validationPlan.planned_validations[0];
  assert.equal(planned.validation_target.design_blocked, true);
  assert.deepEqual(planned.target_edges, []);
  assert.ok(planned.validation_target.missing_requirements.includes("dataset_schema_or_manifest"));
  assert.equal(artifacts.graphUpdate.graph_diff.updates.some((item) => item.target_type === "edge"), false);
});

test("validation artifacts write separate reasoning graph and graph updates carry provenance", () => {
  const { buildValidationArtifacts } = require("../src/agents/chronicle/data_graph_validation");
  const cwd = makeTmp();
  const cycleId = "cycle-reasoning-graph";
  fs.mkdirSync(path.join(cwd, ".research-lab", "plans"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".research-lab", "plans", `${cycleId}-lab-director-literature.json`), JSON.stringify({
    dataset_candidates: [{
      name: "clean_bundle",
      files: [{ path: "clean.csv", column_profiles: ["sample_id", "marker_expression", "survival_signal"] }],
    }],
  }), "utf8");

  const artifacts = buildValidationArtifacts({
    cwd,
    cycleId,
    hypotheses: [{
      hypothesis_id: "h-clean",
      statement: "marker predicts outcome",
      family_root: "family-clean",
      x_variable: "marker_expression",
      y_variable: "survival_signal",
      latest_status: "robust",
      state: "candidate",
      validating_lanes: ["followup-runner-02"],
      claims: [{ claim_id: "claim:h-clean", statement: "marker predicts outcome" }],
    }],
    familyStateSummary: [{ family_root: "family-clean", count: 1, states: { candidate: 1 } }],
  });

  assert.ok(fs.existsSync(artifacts.paths.reasoning_graph));
  assert.ok(fs.existsSync(artifacts.paths.knowledge_graph));
  const update = artifacts.graphUpdate.graph_diff.updates.find((item) => item.target_type === "edge");
  assert.ok(update, "edge update should be generated for clean variables");
  assert.deepEqual(update.source_lane_ids, ["followup-runner-02"]);
  assert.equal(update.source_type, "validation_result");
  assert.ok(update.source_summary);
});
