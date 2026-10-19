"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRolePlan } = require("../src/agents");
const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");
const { resolveProfile } = require("../src/agents/shared/derived_profile");

const objective = "Study robot manipulation in simulation with repeated trials and measured task outcomes";
const rendererAssumptions = /mitsuba|mi\.(?:render|load_dict|set_variant|register_integrator)|render_time_s|equal spp|equal ray count|36s of render/i;

test("robot director and analyst plans use domain-neutral instruments and comparisons", () => {
  const director = buildRolePlan({
    prompt: objective,
    cycleId: "neutral-prompt-test",
    lane: { lane_id: "lab-director-01", role: "lab-director" },
  });
  const analyst = buildAnalystQueryPlan({ prompt: objective, laneId: "analyst-01" });
  assert.doesNotMatch(JSON.stringify(director), rendererAssumptions);
  assert.doesNotMatch(JSON.stringify(analyst), rendererAssumptions);
  // There is no objective_domain any more. A compiler objective used to be
  // classified "generic", whose profile was the observational one, so it was
  // handed a statistician's framing and econometric design shifts. It now
  // carries what was MEASURED -- null until a probe has run, which is a state
  // the lane can act on.
  assert.equal(analyst.objective_domain, undefined);
  assert.equal(analyst.intervention_mode, null);
  assert.match(JSON.stringify(director), /verified instrument capabilities/i);
  assert.equal(analyst.compute_budget_contract.driver_wall_clock_seconds, 1500);
  assert.equal(analyst.compute_budget_contract.default_per_blueprint_seconds, 240);
  assert.equal(analyst.analyst_quality_standard_policy.canonical_resolution_target.target, 1);
  assert.equal(analyst.analyst_quality_standard_policy.recommended_standard_procedural.require_all_handoff_checks_resolved, true);
  assert.equal(analyst.analyst_quality_standard_policy.recommended_standard_procedural.allow_inconclusive_for_gate_review, false);
  assert.match(JSON.stringify(analyst.claim_coverage_contract), /not_covered/);
});

// The rule this used to guard is now unconditional.
//
// It asserted that the `cs` profile's blueprint rules mentioned Mitsuba only
// behind "Only when Mitsuba is explicitly selected", so a domain LABEL could not
// select a renderer. The profile is gone, so a label cannot select anything, and
// the rule that mattered -- implement the method you proposed and prove it runs
// before comparing against it -- now reaches every field instead of one.
test("no profile can name a toolkit, and the implement-it-first rule reaches every field", () => {
  const rules = resolveProfile({}).profile.blueprintRules;
  assert.ok(
    rules.some((rule) => /NEVER ASSUME IT EXISTS/.test(rule)),
    "a cycle can still propose a method that was never implemented and compare against nothing",
  );
  assert.doesNotMatch(
    rules.join("\n"),
    /mitsuba|pbrt|blender|embree|optix|omics_helpers|cs_helpers/i,
    "a blueprint rule names a toolkit, which is a field choosing itself",
  );
});
