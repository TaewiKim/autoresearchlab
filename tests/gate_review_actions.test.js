"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { compactGateValidationResults, pregateReportingRole } = require("../src/reporting/reviews/gate/actions");

test("pregate reporting roles re-route post-gate illustrator/author to pre-gate executors", () => {
  assert.equal(pregateReportingRole("illustrator", "visualization_followup"), "lab-runner");
  assert.equal(pregateReportingRole("author", "clarity_figure_followup"), "lab-runner");
  assert.equal(pregateReportingRole("author", "reporting_followup"), "analyst");
  assert.equal(pregateReportingRole("lab-runner", "accuracy_followup"), "lab-runner");
  assert.equal(pregateReportingRole("chronicle", "logic_trace_followup"), "chronicle");
  assert.equal(pregateReportingRole("lab-director", "gate_restart_followup"), "lab-director");
});

test("pregate reroute (FIX-AC) covers conclusion-review reporting/clarity action types", () => {
  // The conclusion review emits these with POST-gate roles; FIX-AC's final pass in
  // authoritativeGateFollowupActions must remap them to pre-gate executors so the
  // clarity/STROBE close-out work runs BEFORE the gate (it otherwise deadlocks:
  // post-gate illustrator/author never run until the gate passes, but the gate
  // can't pass until clarity/STROBE improve).
  assert.equal(pregateReportingRole("illustrator", "visualization_followup"), "lab-runner");
  assert.equal(pregateReportingRole("author", "logic_followup"), "analyst");
  assert.equal(pregateReportingRole("author", "reporting_followup"), "analyst");
  assert.equal(pregateReportingRole("analyst", "impact_followup"), "analyst");
  assert.equal(pregateReportingRole("lab-runner", "robustness_display_addendum_followup"), "lab-runner");
});

test("gate followup validation context falls back to latest runner summary when summary results are empty", () => {
  const context = compactGateValidationResults({
    validation_results: [
      { lane_id: null, verdict: null, score: null, summary: null },
      null,
    ],
    latest_validation_lane_id: "followup-runner-624",
    latest_validation_summary: {
      overall_status: "degraded",
      primary_hypothesis_id: "hyp-director-gse228779",
      checks_passed: 21,
      checks_failed: 14,
      checks_total: 35,
      blueprints_passed: 5,
      blueprints_failed: 0,
      external_agent_runs_passed: 2,
      external_agent_runs_total: 2,
      analysis_accuracy_score: 80,
      method_appropriateness_score: 82,
      failed_checks: [
        "hyp_director_gse228779_reference_baseline_audit_01",
        "hyp_director_gse228779_same_dataset_baseline_reproduction_01",
      ],
    },
  });

  assert.equal(context.validation_results.length, 1);
  assert.equal(context.validation_results[0].lane_id, "followup-runner-624");
  assert.equal(context.validation_results[0].hypothesis_id, "hyp-director-gse228779");
  assert.equal(context.validation_results[0].verdict, "degraded");
  assert.equal(context.validation_results[0].metrics.checks_passed, 21);
  assert.match(context.validation_results[0].summary, /failed_checks=/);
});
