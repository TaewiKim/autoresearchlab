"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateDerivedHypotheses,
  inferIdentificationStrategy,
  validateHypothesisCandidate,
  validateHypothesisFrontier,
} = require("../src/agents/chronicle/hypothesis_generator");
const { procedureSignature } = require("../src/agents/chronicle/hypothesis_contract");

const source = { hypothesis_id: "h1", x_variable: "applied_input", y_variable: "measured_output" };

function concreteCandidate(id = "candidate-a") {
  const procedure = {
    intervention: "Disable the intermediate process while holding the input constant",
    data_construction: "Paired seeded cases with an independently measured reference",
    measured_quantity: "Paired output difference in calibrated units",
    analysis_design: "Blocked contrast against the unchanged reference process",
  };
  return {
    candidate_id: id,
    statement: "The effect requires the intermediate process in the specified regime.",
    scientific_contract: {
      research_question: "Which of the two mechanisms carries the input effect?",
      mechanism: "The intermediate process transmits the applied input to the measured output.",
      boundary_conditions: ["Below the independently measured saturation limit"],
      boring_baseline: {
        name: "Calibrated reference process",
        why_strong: "It receives the same inputs and observations under the same budget.",
        wins_if: "Disabling the proposed mechanism preserves the output difference.",
      },
      strongest_inversion: {
        statement: "The reference process alone explains the output difference.",
        plausible_because: "The input also reaches the reference pathway.",
      },
      outcome_value: {
        if_supported: "Intervene on the intermediate process to change the output.",
        if_refuted: "Use the simpler reference process and abandon the extra mechanism.",
      },
      kill_test: {
        procedure: "Run paired enabled and disabled conditions on the same seeded cases.",
        rejection_criterion: "The held-out contrast excludes the smallest useful effect.",
        primary_estimand: "Mean paired output difference",
        smallest_useful_effect: 0.2,
        budget: { max_trials: 20 },
        analysis_plan_ref: "plans/paired-contrast.md",
        instrument_evidence_refs: ["probes/calibrated-reference.json"],
      },
      closest_prior_art: [{
        source_id: "source-a", title: "Reference process study",
        url: "https://example.org/primary-study",
        verification_status: "verified_primary",
        verified_claim: "The reported procedure changes the input but does not disable the intermediate process.",
        exact_novelty_delta: "Disable the process to distinguish it from the rival while matching inputs.",
        procedure: { ...procedure, intervention: "Change the input with both pathways intact" },
      }],
      procedure,
      rename_test: {
        verdict: "substantive_procedure_change",
        candidate_id: id,
        plain_procedure: "Hold input fixed and disable one pathway rather than varying input.",
        rationale: "The actual intervention separates the two mechanisms.",
        reviewer_id: "independent-reviewer", review_ref: "reviews/procedure-comparison.json",
        procedure_signature: procedureSignature(procedure),
      },
      claim_scope: "simulation",
      empirical_claim_status: "untested",
      evidence: [],
    },
  };
}

test("one grounded question yields six distinct procedural lenses, not six claimed discoveries", () => {
  const candidates = generateDerivedHypotheses([source]);
  assert.equal(candidates.length, 6);
  assert.equal(new Set(candidates.map((item) => item.procedure_family)).size, 6);
  assert.equal(new Set(candidates.map((item) => item.identification_strategy)).size, 6);
  assert.equal(new Set(candidates.map((item) => item.generation_guidance.proposed_procedure)).size, 6);
  for (const candidate of candidates) {
    assert.deepEqual(candidate.source_hypotheses, ["h1"]);
    assert.equal(candidate.readiness, "needs_scientific_contract");
    assert.equal(candidate.novelty_delta_score, null);
    assert.ok(candidate.scientific_contract_validation.blockers.includes("missing:closest_prior_art"));
    for (const field of ["mechanism", "boundary_conditions", "boring_baseline", "strongest_inversion",
      "informative_if_supported", "informative_if_refuted", "cheapest_kill_test", "rename_test", "human_hci_gate"]) {
      assert.ok(candidate.generation_guidance[field]);
    }
  }
  assert.equal(validateHypothesisFrontier(candidates).ready_for_selection, false);
});

test("duplicates, citation counts and scientific buzzwords cannot improve readiness or novelty", () => {
  const inflated = { ...source, statement: "novel causal threshold mechanism confound breakthrough",
    support_count: 10000, novelty_delta_score: 100, expected_impact_score: 100,
    paper_examples: Array(100).fill("same source") };
  assert.deepEqual(generateDerivedHypotheses([inflated, inflated]), generateDerivedHypotheses([source]));
});

test("explicit strategies are retained only as source metadata; unknown designs are not guessed", () => {
  assert.equal(inferIdentificationStrategy({ statement: "shock rollout policy change" }, null), "unspecified");
  assert.equal(inferIdentificationStrategy({ identification_strategy: "unspecified" },
    { identification_strategy: "event_study" }), "event_study");
  const candidates = generateDerivedHypotheses([{ ...source, identification_strategy: "observational_panel" }], {
    designConstraints: [{ id: "avoid-pair", pattern: { identification_strategy: "paired_intervention" } }],
  });
  assert.equal(candidates[0].source_identification_strategy, "observational_panel");
  assert.deepEqual(candidates[0].design_constraint_violations, ["avoid-pair"]);
  assert.deepEqual(candidates[1].design_constraint_violations, []);
});

test("declared cycle provenance is never crossed and question expansion is bounded", () => {
  const input = ["a", "b", "c", "d"].map((cycle_id) => ({ ...source, cycle_id, hypothesis_id: cycle_id }));
  const candidates = generateDerivedHypotheses(input);
  assert.equal(candidates.length, 18);
  assert.ok(candidates.every((item) => item.source_hypotheses.length === 1));
  assert.equal(generateDerivedHypotheses(input, { maxProblems: 1 }).length, 6);
  assert.deepEqual(generateDerivedHypotheses(null), []);
  assert.deepEqual(generateDerivedHypotheses([{ hypothesis_id: "missing-variables" }]), []);
});

test("concrete reviewed contract is ready for a kill test, with no automatic merit score", () => {
  const candidate = concreteCandidate();
  const result = validateHypothesisCandidate(candidate);
  assert.equal(result.ready_for_kill_test, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.novelty_delta_score, null);
  assert.equal(result.scientific_merit_status, "requires_independent_assessment");
  assert.equal(result.human_claim_gate.empirical_human_claim_allowed, false);
});

test("renaming a method does not change the executed procedure or pass the rename test", () => {
  const candidate = concreteCandidate();
  candidate.statement = "A revolutionary cross-domain mechanism";
  candidate.scientific_contract.closest_prior_art[0].procedure = { ...candidate.scientific_contract.procedure };
  candidate.scientific_contract.closest_prior_art[0].exact_novelty_delta = "A radically different name";
  const result = validateHypothesisCandidate(candidate);
  assert.equal(result.ready_for_kill_test, false);
  assert.ok(result.blockers.includes("rename_test:0:same_executed_procedure"));
});

test("changing a procedure invalidates a stale semantic review", () => {
  const candidate = concreteCandidate();
  candidate.scientific_contract.procedure.intervention = "A different intervention";
  assert.ok(validateHypothesisCandidate(candidate).blockers.includes("rename_test:independent_review_required"));
});

test("missing primary-source verification, kill budget and distinct null conclusion block readiness", () => {
  const candidate = concreteCandidate();
  candidate.scientific_contract.closest_prior_art[0].verification_status = "model_generated";
  candidate.scientific_contract.kill_test.budget = { max_trials: Infinity };
  candidate.scientific_contract.outcome_value.if_refuted = candidate.scientific_contract.outcome_value.if_supported;
  const result = validateHypothesisCandidate(candidate);
  assert.ok(result.blockers.includes("prior_art:0:primary_source_unverified"));
  assert.ok(result.blockers.includes("missing:kill_test.bounded_budget"));
  assert.ok(result.blockers.includes("outcome_value:indistinguishable_conclusions"));
});

test("simulated people and model judges cannot support human/HCI claims", () => {
  const candidate = concreteCandidate();
  const contract = candidate.scientific_contract;
  contract.claim_scope = "human_hci";
  contract.empirical_claim_status = "supported";
  contract.human_study_plan = {
    design: "Randomized participant comparison", primary_outcome: "appropriate intervention rate",
    sampling_plan: "Pilot-informed precision target", analysis_plan_ref: "plans/human-study.md",
  };
  contract.evidence = [
    { kind: "simulated_user", verification_status: "verified_primary", participants: 100,
      artifact_ref: "sim.json", measured_outcomes: ["appropriate intervention rate"] },
    { kind: "model_judge", verification_status: "verified_primary", participants: 100,
      artifact_ref: "judge.json", measured_outcomes: ["appropriate intervention rate"] },
  ];
  let result = validateHypothesisCandidate(candidate);
  assert.equal(result.human_claim_gate.empirical_human_claim_allowed, false);
  assert.ok(result.blockers.includes("human_claim:real_participant_evidence_required"));
  contract.empirical_claim_status = "untested";
  result = validateHypothesisCandidate(candidate);
  assert.equal(result.ready_for_kill_test, true);
  assert.equal(result.human_claim_gate.simulation_scope, "instrument_feasibility_only");
  contract.evidence.push({ kind: "human_study", verification_status: "verified_primary", participants: 24,
    artifact_ref: "participants/results.json", measured_outcomes: ["satisfaction"] });
  assert.equal(validateHypothesisCandidate(candidate).human_claim_gate.empirical_human_claim_allowed, false);
  contract.evidence.at(-1).measured_outcomes = ["appropriate intervention rate"];
  assert.equal(validateHypothesisCandidate(candidate).human_claim_gate.empirical_human_claim_allowed, true);
});

test("human outcome wording cannot bypass the HCI boundary through a simulation scope label", () => {
  const candidate = concreteCandidate();
  candidate.statement = "This interface improves appropriate reliance and user trust.";
  const result = validateHypothesisCandidate(candidate);
  assert.equal(result.ready_for_kill_test, false);
  assert.ok(result.blockers.includes("human_claim:explicit_scope_required"));
  assert.equal(result.human_claim_gate.empirical_human_claim_allowed, false);
});

test("frontier diversity ignores family labels and rejects five copies of one procedure", () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({
    ...concreteCandidate("candidate-" + index), procedure_family: "family-" + index,
  }));
  let result = validateHypothesisFrontier(candidates);
  assert.equal(result.ready_for_selection, false);
  assert.equal(result.distinct_procedure_count, 1);
  assert.equal(result.duplicate_procedure_groups[0].length, 5);
  const interventions = ["Disable mediator", "Change acquisition cost", "Swap observation channel",
    "Construct indistinguishable worlds", "Hold out crossed causal contexts"];
  candidates.forEach((candidate, index) => {
    candidate.scientific_contract.procedure.intervention = interventions[index];
    candidate.scientific_contract.rename_test.procedure_signature = procedureSignature(candidate.scientific_contract.procedure);
  });
  result = validateHypothesisFrontier(candidates);
  assert.equal(result.ready_for_selection, true);
  assert.equal(result.ready_distinct_procedure_count, 5);
  assert.equal(validateHypothesisFrontier(candidates.slice(0, 1), { minimumDistinctProcedures: 1 }).ready_for_selection, false);
});

test("concrete contracts bind to exact candidate IDs and are cloned without mutating callers", () => {
  const base = generateDerivedHypotheses([source]);
  const concrete = concreteCandidate(base[0].candidate_id);
  const before = JSON.stringify(concrete);
  const enriched = generateDerivedHypotheses([source], { candidateContracts: [concrete] });
  assert.equal(enriched[0].readiness, "ready_for_kill_test");
  assert.ok(enriched.slice(1).every((item) => item.readiness === "needs_scientific_contract"));
  enriched[0].scientific_contract.mechanism = "modified output";
  assert.equal(JSON.stringify(concrete), before);
  const ambiguous = generateDerivedHypotheses([source], { candidateContracts: [concrete, concrete] });
  assert.equal(ambiguous[0].readiness, "needs_scientific_contract");
  assert.ok(ambiguous[0].scientific_contract_validation.blockers.includes("ambiguous:candidate_contracts"));
});
