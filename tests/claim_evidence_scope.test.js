"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { authoritativeGateFollowupActions } = require("../src/reporting/reviews/gate/actions");

// The v74 shape: a completed run established a NARROW result cleanly (matched-spp
// adaptive vs uniform, with a scene where the method loses — a real falsification
// boundary), while the lead claimed something several sizes larger. The gatekeeper
// rejected it and its missing_validations list WAS the distance between the two.
function v74LikeSummary() {
  return {
    approval_readiness_score: 41,
    derivable_hypothesis_candidates: [{ statement: "variance-guided allocation under matched budgets" }],
    open_validation_gaps: [],
    latest_validation_lane_id: "lab-runner-04",
    latest_validation_summary: {
      overall_status: "completed",
      primary_hypothesis_id: "hyp-scene-conditioned-transport",
      checks_passed: 13,
      checks_total: 13,
      analysis_accuracy_score: 94,
      // What the driver now carries up out of the blueprint (previously this
      // stopped at the artifact directory and the gate saw "13/13" only).
      measured_quantities: [
        {
          check_id: "render_quality_convergence_01",
          quantities: {
            summary: [
              { scene: "glossy_sphere", adaptive_gain_psnr_mean: 0.8414, adaptive_wins: true },
              { scene: "diffuse_sphere", adaptive_gain_psnr_mean: -0.1911, adaptive_wins: false },
            ],
            matched_budget_spp: 24,
            reference_spp: 256,
          },
          reported_checks: { adaptive_beats_uniform: true, falsification_boundary_held: true },
        },
      ],
    },
  };
}

function overScopedReview() {
  return {
    verdict: "challenge",
    missing_validations: [
      "Matched-time comparison against ReSTIR-style reuse, path-guiding reuse, and MARS-style allocation.",
      "Seed-level bootstrap intervals for crossover locations and performance deltas.",
      "Prospective calibration and held-out evaluation of ESS/overlap gates.",
    ],
    major_objections: ["the supplied validation does not establish the claimed advance"],
  };
}

test("an over-scoped lead gets the claim-evidence proportionality rule, and the evidence to scope against", () => {
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: overScopedReview(),
    labDirectorResponse: null,
    leadSupersession: null,
  });

  const requery = actions.find((action) => action.type === "lab_director_requery_followup");
  assert.ok(requery, "a reject/challenge round must produce a requery action");

  // The rule fires, and names the measured distance rather than a generic scold.
  assert.match(requery.description, /CLAIM-EVIDENCE PROPORTIONALITY/);
  assert.match(requery.description, /3 missing validation\(s\)/);
  assert.match(requery.description, /SCOPE signal, not only as a work order/);

  // Both directions are offered — narrowing is not the only move.
  assert.match(requery.description, /feasible here and simply not yet run/);
  assert.match(requery.description, /NARROW the claim/);
  assert.match(requery.description, /do NOT shrink a claim you can afford/);

  // The novelty bar is protected: only generality may be cut.
  assert.match(requery.description, /NEVER the mechanism/);

  // A failure boundary is a result, not a defect to hide.
  assert.match(requery.description, /demonstrably FAILS is part of the result/);

  // ...and the director can now SEE what the runs established. Without this the
  // round that decides the scope is the one round with no evidence attached.
  assert.ok(Array.isArray(requery.validation_results?.validation_results));
  const established = requery.validation_results.validation_results[0];
  assert.equal(established.lane_id, "lab-runner-04");
  // The workflow counters survive...
  assert.equal(established.metrics.checks_passed, 13);
  // ...and so do the actual measurements, which is the whole point: a director
  // asked to scope a claim to its evidence must be able to see the evidence.
  const quantities = established.measured_quantities[0].quantities;
  assert.equal(quantities.summary[0].adaptive_gain_psnr_mean, 0.8414);
  assert.equal(quantities.summary[1].adaptive_gain_psnr_mean, -0.1911);
  assert.equal(quantities.summary[1].adaptive_wins, false);
});

test("no missing validations means no scope rule — the claim is not second-guessed for free", () => {
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: {
      verdict: "challenge",
      missing_validations: [],
      major_objections: ["novelty delta versus the named prior art is not argued"],
    },
    labDirectorResponse: null,
    leadSupersession: null,
  });

  const requery = actions.find((action) => action.type === "lab_director_requery_followup");
  assert.ok(requery);
  assert.doesNotMatch(requery.description, /CLAIM-EVIDENCE PROPORTIONALITY/);
  // The evidence still rides along — it is useful in every requery, not only
  // when the reviewer complained about coverage.
  assert.ok(Array.isArray(requery.validation_results?.validation_results));
});

test("a restart is scoped against what already worked instead of re-authoring an unrunnable claim", () => {
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: { ...overScopedReview(), verdict: "reject", restart_recommended: true },
    labDirectorResponse: null,
    leadSupersession: null, // no ledger protection -> the restart path is open
  });

  const restart = actions.find((action) => action.type === "gate_restart_followup");
  assert.ok(restart, "an unprotected reject must still be able to restart");
  assert.match(restart.description, /Scope the new lead to evidence this cycle can actually produce/);
  assert.equal(restart.validation_results.validation_results[0].lane_id, "lab-runner-04");
});

test("the ledger's anti-churn protection still comes first in the requery text", () => {
  // Ordering matters: the lead identity and the keep-refining rule must be read
  // before the scope rule, or "narrow the claim" can be misread as "pick a
  // different, smaller lead" — which is the churn the ledger exists to stop.
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: overScopedReview(),
    labDirectorResponse: null,
    leadSupersession: {
      decision: "deny",
      reason: "still_improving",
      lead: "hyp:54495e",
      lead_statement: "scene-conditioned sequential transport under scene edits",
      binding_rubric: { name: "novelty" },
    },
  });

  const requery = actions.find((action) => action.type === "lab_director_requery_followup");
  const leadAt = requery.description.indexOf("THE LEAD YOU MUST KEEP REFINING IS");
  const scopeAt = requery.description.indexOf("CLAIM-EVIDENCE PROPORTIONALITY");
  assert.ok(leadAt >= 0 && scopeAt >= 0);
  assert.ok(leadAt < scopeAt, "lead identity and anti-churn must precede the scope rule");
});

test("the evidence producer outranks the evidence reviewer in dispatch order", () => {
  // cycle-g-v74: 67 runner lanes were superseded WITHOUT EVER LAUNCHING because
  // lab-runner sat below gatekeeper against a 3-slot concurrency budget, and the
  // gate emits gatekeeper work on every rejection. Reproducibility stayed at
  // 14-25 across 158 reviews while novelty reached 55.
  const { gateActionPriorityScore } = require("../src/reporting/reviews/gate/actions");
  const runner = gateActionPriorityScore({ preferred_role: "lab-runner" });
  const gatekeeper = gateActionPriorityScore({ type: "independent_gate_review_followup", preferred_role: "gatekeeper" });
  const director = gateActionPriorityScore({ type: "lab_director_requery_followup" });
  const analyst = gateActionPriorityScore({ preferred_role: "analyst" });

  assert.ok(runner > gatekeeper, "a runner that creates evidence must outrank a review of existing evidence");
  assert.ok(director > runner, "the director still decides which lead is being validated");
  // Analyst churn is what makes runners stale; promoting it would feed the loop.
  assert.ok(analyst < gatekeeper);
});

test("a requery the gatekeeper proposes carries the same lead protection as ours", () => {
  // cycle-g-v75: the ledger denied a pivot 59 consecutive times and the director
  // changed lead anyway, three times in forty minutes. The deny was not ignored --
  // it never arrived. followup-lab-director-30 was a lab_director_requery_followup
  // built from the gatekeeper's own `recommended_actions`, and that path composed
  // its action from the reviewer's description alone: no lead_supersession, none
  // of the anti-churn text. Two ways to ask for a requery, one of them protected.
  const denied = {
    decision: "deny",
    reason: "critical_memory_suppression_blocked_lead_still_improving",
    lead: "hyp:f199ba088eab2ebf",
    lead_statement: "primary_family=failure_boundary_modeling: fit overlap/ESS diagnostics on edit pairs",
    binding_rubric: { name: "reproducibility" },
  };
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: {
      verdict: "challenge",
      missing_validations: [],
      recommended_actions: [
        {
          type: "lab_director_requery_followup",
          preferred_role: "lab-director",
          description: "Requery only after producing an exact prior-art procedure matrix.",
        },
      ],
    },
    labDirectorResponse: null,
    leadSupersession: denied,
  });

  const proposed = actions.filter(
    (a) => a.preferred_role === "lab-director" && /prior-art procedure matrix/.test(a.description || ""),
  );
  assert.equal(proposed.length, 1, "the reviewer's recommended requery must still be dispatched");
  const action = proposed[0];
  assert.match(action.description, /THE LEAD YOU MUST KEEP REFINING IS/);
  assert.match(action.description, /failure_boundary_modeling/);
  assert.match(action.description, /ANTI-THRASH/);
  // the reviewer's own instruction survives, after the protection
  assert.match(action.description, /prior-art procedure matrix/);
  assert.equal(action.lead_supersession.lead, "hyp:f199ba088eab2ebf");
  assert.ok(Array.isArray(action.validation_results?.validation_results));
});

test("with no deny, a proposed requery is passed through untouched", () => {
  const actions = authoritativeGateFollowupActions({
    summary: v74LikeSummary(),
    aggregateReview: {
      verdict: "challenge",
      missing_validations: [],
      recommended_actions: [
        {
          type: "lab_director_requery_followup",
          preferred_role: "lab-director",
          description: "Requery with a sharper contribution framing.",
        },
      ],
    },
    labDirectorResponse: null,
    leadSupersession: { decision: "allow", reason: "no_active_lead_to_protect", lead: null },
  });
  const action = actions.find((a) => /sharper contribution framing/.test(a.description || ""));
  assert.ok(action);
  assert.doesNotMatch(action.description, /ANTI-THRASH|KEEP REFINING/);
});
