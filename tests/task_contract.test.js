"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRolePlan } = require("../src/agents");

test("role plans include a versioned task contract and provenance", () => {
  const plan = buildRolePlan({
    prompt: "Find literature and produce a report",
    cycleId: "cycle-contract-0001",
    researchStage: "document",
    lane: {
      lane_id: "author-01",
      role: "author",
      model: "gpt-5.4",
      agent_id: "author-01",
      activation_stages: ["document"],
    },
    cyclePlanningContext: {
      data_graph_digest: {
        incumbent_family: "immunization_coverage",
      },
    },
  });

  assert.equal(plan.contract_version, "1.0");
  assert.equal(plan.task_id, "author-01");
  assert.equal(plan.cycle_id, "cycle-contract-0001");
  assert.equal(plan.research_stage, "document");
  assert.equal(plan.control_state, "DISPATCH");
  assert.equal(plan.provenance.decision_id, "decision:cycle-contract-0001:document:author");
  assert.equal(plan.team_id, "team:cycle-contract-0001:document");
  assert.equal(plan.expected_output_schema_ref, "schema:document-artifact");
  assert.equal(plan.constraints.max_retries, 1);
  assert.deepEqual(plan.completion_requirements, [
    "document artifact",
    "claim-evidence map",
    "review-comment response map",
    "review-driven analysis artifact when requested",
    "revision summary",
  ]);
});

test("analyst role plans require a validation blueprint and self-review", () => {
  const plan = buildRolePlan({
    prompt: "Analyze the WHO panel and design the next decisive validation",
    cycleId: "cycle-contract-0002",
    researchStage: "evidence",
    lane: {
      lane_id: "analyst-01",
      role: "analyst",
      model: "gpt-5.4",
      agent_id: "analyst-01",
      activation_stages: ["evidence"],
    },
    cyclePlanningContext: {
      next_cycle_plan: {
        prioritized_families: [
          { family_root: "zero_dose_burden", action: "pairwise_contest" },
        ],
      },
    },
  });

  assert.equal(plan.analysis_execution_mode, "design-plus-validation-code-blueprint");
  assert.ok(Array.isArray(plan.analysis_loop));
  assert.equal(plan.analysis_loop.at(-1)?.stage, "self-review");
  assert.match(plan.code_generation_protocol.requirement, /validation-code blueprint/i);
  assert.ok(plan.required_output.includes("validation code blueprint with execution notes"));
  assert.deepEqual(plan.completion_requirements, [
    "analyst brief",
    "executable validation blueprint",
    "self-review verdict",
  ]);
});
