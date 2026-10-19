"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDynamicAgentPlan } = require("../src/agents/lab_director/agent_plan");
const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");
const { buildLabRunnerAnalysisPlan } = require("../src/agents/lab_runner/analysis_plan");

test("agent plan emits stage activation metadata", () => {
  const plan = buildDynamicAgentPlan({
    prompt: "Analyze WHO data and produce a report with visuals",
    catalogPath: "/tmp/catalog.json",
    researchStage: "evidence",
  });

  assert.equal(plan.initial_research_stage, "evidence");
  assert.ok(Array.isArray(plan.active_roles_for_initial_stage));
  assert.ok(plan.active_roles_for_initial_stage.includes("scout"));
  assert.ok(!plan.active_roles_for_initial_stage.includes("author"));

  const author = plan.agents.find((agent) => agent.role === "author");
  const gatekeeper = plan.agents.find((agent) => agent.role === "gatekeeper");
  const labDirector = plan.agents.find((agent) => agent.role === "lab-director");
  assert.deepEqual(author.activation_stages, ["document"]);
  assert.deepEqual(gatekeeper.activation_stages, ["gate"]);
  assert.match(plan.supervisor_role_contract.role_boundary.supervisor, /completion pressure/i);
  assert.equal(plan.supervisor_role_contract.escalation_policy.must_direct_lab_director_on_stagnation, true);
  assert.match(labDirector.role_boundary.lab_director, /scientific corrective direction/i);
  assert.ok(labDirector.supervisor_instruction_policy.lab_director_required_response.includes("assign_the_next_role_with_a_concrete_dataset_artifact_or_validation_target"));
  assert.match(labDirector.duty, /minimum valid time\/token spend/i);
  assert.match(labDirector.duty, /literature triage policy/i);
  assert.equal(labDirector.literature_triage_policy.sufficient_evidence_thresholds.abstract_only_allowed, true);
  assert.equal(labDirector.literature_triage_policy.budget.max_scout_lanes_before_labdirector_decision, 2);
  assert.ok(
    labDirector.literature_triage_policy.when_to_stop.some((rule) =>
      /next blocker is a gatekeeper rubric review/i.test(rule)
    ),
  );
  assert.equal(
    labDirector.hypothesis_gate_efficiency_mandate.primary_goal,
    "pass the independent hypothesis gate with the minimum valid time and token spend",
  );
  assert.ok(
    labDirector.hypothesis_gate_efficiency_mandate.anti_repetition_rules.some((rule) =>
      /redundant LabDirector requery lanes/i.test(rule)
    ),
  );
  assert.equal(
    plan.hypothesis_gate_efficiency_mandate.primary_goal,
    labDirector.hypothesis_gate_efficiency_mandate.primary_goal,
  );
  assert.equal(
    plan.lab_director_literature_triage_policy.primary_goal,
    labDirector.literature_triage_policy.primary_goal,
  );
});

test("planning-only scope keeps Codex analysis design but omits every LabRunner", () => {
  const plan = buildDynamicAgentPlan({
    prompt: "Review literature, compare hypotheses, and design a later experiment",
    catalogPath: "/tmp/catalog.json",
    researchStage: "evidence",
    researchScope: "planning-only",
  });

  assert.equal(plan.research_scope, "planning-only");
  assert.ok(plan.agents.some((agent) => agent.role === "analyst" && agent.runtime_class === "codex-agent"));
  assert.equal(plan.agents.some((agent) => agent.role === "lab-runner"), false);
});

test("analyst and lab-runner plans require pre-validation master table gate", () => {
  const analyst = buildAnalystQueryPlan({
    prompt: "Validate the GSE228779 liver-cell hypothesis",
    laneId: "followup-analyst-001",
  });
  const runner = buildLabRunnerAnalysisPlan({
    prompt: "Run the analyst handoff",
    laneId: "followup-runner-001",
  });

  assert.equal(analyst.pre_validation_master_table_gate.required, true);
  assert.equal(analyst.pre_validation_master_table_gate.gate_id, "analysis_master_table_gate");
  assert.ok(analyst.required_output.includes("analysis_master_table contract with row grain, join keys, required columns, group label construction, covariates, exclusion rules, output path, and quality checks"));
  assert.match(analyst.code_generation_protocol.blueprint_rules.join("\n"), /master-table blueprint/i);
  // The stage that used to be "workflow-compatibility". Choosing the workflow is
  // still the analyst's; making it run moved to the engineer, so the stage now
  // states a requirement and explicitly does not repair a command. See
  // src/agents/engineer/environment_plan.js.
  const capabilityStage = analyst.analysis_loop.find((stage) => stage.stage === "capability-requirement");
  assert.ok(capabilityStage, "the analyst no longer states what the design needs in order to run");
  assert.equal(capabilityStage.hand_to, "engineer");
  assert.match(capabilityStage.deliverables.join("\n"), /capability_requirements/);
  assert.match(capabilityStage.not_this_stage.join("\n"), /Repairing a failed command/i);
  // The mandate no longer comes from a per-field table, so it no longer carries
  // that table's wording. What it must still carry is the duty: state the
  // capability the design needs, and judge whether the METHOD survives when a
  // runner fails on it -- the repair itself belongs to the engineer.
  assert.match(analyst.statistical_mandate.primary_tasks.join("\n"), /capability the design needs/i);
  assert.match(analyst.required_output.join("\n"), /repository-native workflow compatibility decision/i);

  assert.equal(runner.pre_validation_master_table_gate.required, true);
  assert.equal(runner.analysis_loop[1].gate, "analysis_master_table_gate");
  assert.match(runner.validation_checks.join("\n"), /analysis_master_table_created=true/);
});

test("analyst plan applies self-service data-analytics sources-of-truth discipline", () => {
  const analyst = buildAnalystQueryPlan({
    prompt: "Validate the GSE228779 liver-cell hypothesis",
    laneId: "followup-analyst-002",
  });

  // Trust-ordered sources of truth, semantic definitions consulted first.
  const tiers = analyst.sources_of_truth_policy.consult_in_trust_order.map((t) => t.tier);
  assert.deepEqual(tiers, [
    "semantic_definitions",
    "lineage_and_grain",
    "curated_reference",
    "library_documentation",
  ]);
  assert.match(
    analyst.sources_of_truth_policy.anti_patterns.join("\n"),
    /broad raw retrieval/i,
  );

  // Concept-to-entity resolution: one canonical column per concept, before the master table.
  assert.match(analyst.concept_resolution_protocol.requirement, /exactly one canonical column/i);
  assert.ok(analyst.analysis_loop.some((stage) => stage.stage === "resolve"));

  // Provenance footers and adversarial review of the weakest resolution.
  assert.ok(analyst.provenance_policy.footer_fields.includes("source_tier"));
  assert.match(analyst.required_output.join("\n"), /canonical variable resolution table/i);
  assert.match(analyst.required_output.join("\n"), /provenance footers/i);
  const selfReview = analyst.analysis_loop.find((stage) => stage.stage === "self-review");
  assert.match(selfReview.question, /adversarially challenge/i);
  assert.ok(
    analyst.critique_protocol.structured_critique_dimensions.includes("concept-to-column resolution"),
  );
});

test("analyst plan declares an offline-eval-style quality standard and freshness self-check", () => {
  const analyst = buildAnalystQueryPlan({
    prompt: "Validate the GSE228779 liver-cell hypothesis",
    laneId: "followup-analyst-003",
  });

  // Quality-standard baseline keys must match what the blueprint driver gate reads.
  //
  // There is no single `recommended_standard` any more, and that is the point:
  // one standard demanded tabular metrics that render and simulation blueprints
  // never emit, so 113 of 123 validations auto-degraded and prose in
  // required_validation_checks phantom-failed. Both modality standards are
  // asserted so neither can quietly lose the parts the driver gate reads.
  const standard = analyst.analyst_quality_standard_policy.recommended_standard_tabular;
  assert.equal(standard.require_no_blueprint_failures, true);
  assert.equal(standard.require_all_handoff_checks_resolved, true);
  assert.equal(standard.allow_inconclusive_for_gate_review, false);
  assert.ok(standard.required_validation_checks.includes("analysis_master_table_created"));
  const procedural = analyst.analyst_quality_standard_policy.recommended_standard_procedural;
  assert.equal(procedural.minimum_analysis_accuracy_score, null);
  assert.equal(procedural.minimum_method_appropriateness_score, null);
  assert.equal(procedural.require_no_blueprint_failures, true);

  // ~100% canonical (semantic-tier) resolution target.
  assert.equal(analyst.analyst_quality_standard_policy.canonical_resolution_target.target, 1.0);

  // Data-quality + freshness self-check (online-validation slice).
  assert.match(
    analyst.data_quality_freshness_policy.checks.join("\n"),
    /pin the dataset snapshot/i,
  );

  // The analyst must actually emit these in its handoff.
  assert.match(analyst.required_output.join("\n"), /declared analyst_quality_standard/i);
  assert.match(analyst.required_output.join("\n"), /canonical_resolution_rate/i);
});

test("analyst plan attaches falsification battery + method-rigor score to target gate blockers", () => {
  const analyst = buildAnalystQueryPlan({ prompt: "Validate the SLE severity hypothesis", laneId: "l" });
  // Iteration #1 improvement: directly target measured gate blockers (0% promotion;
  // falsification/method-rigor blockers) by forcing per-hypothesis falsification tests.
  assert.match(analyst.statistical_mandate.primary_tasks.join("\n"), /at least two explicit, executable falsification tests/i);
  assert.match(analyst.statistical_mandate.primary_tasks.join("\n"), /methodological_rigor self-score/i);
  assert.match(analyst.required_output.join("\n"), /falsification battery/i);
});
