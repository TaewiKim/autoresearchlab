"use strict";

const { createHash } = require("crypto");
const { matchConstraintViolations } = require("./design_constraints");
const {
  validateHypothesisCandidate, validateHypothesisFrontier,
} = require("./hypothesis_contract");

const IDENTIFICATION_STRATEGIES = Object.freeze([
  "observational_panel", "within_unit_change", "diff_in_diff", "event_study",
  "instrumental_variable", "synthetic_control", "rct_meta",
  "paired_intervention", "factorial_boundary_test", "partial_identification",
  "transport_invariance", "measurement_intervention", "sequential_decision_test",
  "unspecified",
]);

// Lenses specify different operations, constructions, quantities or designs.
// They are prompts for scientific work, not evidence that a mechanism exists.
const PROCEDURE_FAMILIES = Object.freeze([
  Object.freeze({
    id: "mechanism_intervention", strategy: "paired_intervention",
    question: "Does the proposed mechanism carry the effect, or does a rival produce the same outcome?",
    procedure: "Change the proposed mediator while matching the exposure and rival pathways; estimate the paired outcome contrast.",
    mechanism: "Name an intermediate process and an intervention that disables it without changing the rival pathway.",
    boundary: "Specify when disabling the process removes the effect and when a rival preserves it.",
    baseline: "A matched intervention on the strongest rival mechanism with the same data and budget.",
    inversion: "The effect persists when the proposed mechanism is disabled.",
    supported: "Identify which intervention changes the outcome and why that changes a practical decision.",
    refuted: "Identify a sufficient rival pathway or a limit on the proposed causal explanation.",
    kill: "Run the smallest matched mechanism-disable contrast before a broad benchmark.",
  }),
  Object.freeze({
    id: "boundary_crossover", strategy: "factorial_boundary_test",
    question: "Under which independently varied conditions does the preferred explanation or procedure reverse?",
    procedure: "Cross two mechanism-relevant conditions, fit a prespecified interaction, and test its sign reversal on held-out blocks.",
    mechanism: "State the competing processes whose relative contribution changes across the boundary.",
    boundary: "Give measurable crossover coordinates and a region where reversal should not occur.",
    baseline: "The strongest fixed rule or contextual model tuned under the identical budget.",
    inversion: "A single rule remains sufficient across the proposed boundary.",
    supported: "Identify a transportable decision boundary rather than another average method ranking.",
    refuted: "Establish where the simpler rule is sufficient and bound the proposed interaction.",
    kill: "Test paired points on both sides of the proposed boundary and an untouched context block.",
  }),
  Object.freeze({
    id: "identifiability_limit", strategy: "partial_identification",
    question: "Can distinct underlying explanations remain indistinguishable with the information actually observed?",
    procedure: "Construct two latent worlds with matched observable distributions, compute the identified set, then add one admissible distinguishing observation.",
    mechanism: "Name the observation or selection process that hides the distinction between rival latent causes.",
    boundary: "State when the worlds are observationally equivalent and when an available measurement separates them.",
    baseline: "A correctly specified learner given all routinely available observations and intervention logs.",
    inversion: "Routine observations already identify the latent quantity without a new method.",
    supported: "Derive the missing-information condition and the cheapest observation that resolves it.",
    refuted: "Provide a sufficient observation contract and avoid unnecessary new instrumentation.",
    kill: "Try to construct one indistinguishable pair against the full-information baseline before training models.",
  }),
  Object.freeze({
    id: "transport_invariance", strategy: "transport_invariance",
    question: "Which learned relation transfers when causal context changes, and when does transfer become harmful?",
    procedure: "Vary causal context and nuisance appearance independently; hold out their combinations and compare transport with relearning.",
    mechanism: "Name the relation expected to remain invariant and the context that invalidates it.",
    boundary: "Specify a context change that preserves the rule and one that reverses its benefit.",
    baseline: "A contextual model or explicit scoped rule with the same observations and correction budget.",
    inversion: "Forgetting or using an explicit local rule outperforms automatic transfer.",
    supported: "Identify a validity condition for reuse across contexts.",
    refuted: "Establish when relearning or explicit scope is preferable to generalization.",
    kill: "Compare one causal reversal with one nuisance-only change on held-out contexts.",
  }),
  Object.freeze({
    id: "measurement_artifact", strategy: "measurement_intervention",
    question: "Does the claimed effect survive an independent change in the measurement process?",
    procedure: "Keep the underlying process fixed, perturb the observation channel, and compare the effect with an independently calibrated reference.",
    mechanism: "Name an observation, sampling or aggregation process that could create the apparent effect.",
    boundary: "State the measurement conditions under which the artifact appears or vanishes.",
    baseline: "A calibrated reference measurement and a standard measurement-error correction.",
    inversion: "The effect survives independent calibration and cannot be explained by the proposed artifact.",
    supported: "Identify a reusable correction or a decision-changing limit on existing evidence.",
    refuted: "Strengthen the effect's interpretation and bound the tested measurement artifact.",
    kill: "Test one fixed underlying case through two independently characterized observation channels.",
  }),
  Object.freeze({
    id: "decision_value", strategy: "sequential_decision_test",
    question: "When does collecting more information change the best action enough to justify its cost?",
    procedure: "Randomize information source and acquisition cost on matched decision states; estimate downstream decision loss rather than entropy alone.",
    mechanism: "Specify which uncertainty changes the next decision and how delay or burden erases information value.",
    boundary: "Give the cost or delay regime in which the preferred information action reverses.",
    baseline: "One fixed information query or conservative action with the same action and observation budget.",
    inversion: "The simplest fixed acquisition policy remains preferable after all costs are counted.",
    supported: "Identify when an information source is worth acquiring for a decision.",
    refuted: "Establish that the simpler interaction policy is sufficient within the tested regime.",
    kill: "Test matched decisions with informative but costly versus less informative inexpensive observations.",
  }),
]);

function nonempty(value) {
  return typeof value === "string" ? value.trim() : "";
}

// "Rollout" may describe a simulator, not a policy event. Keep this API but
// infer only from an explicit strategy; missing evidence stays unspecified.
function inferIdentificationStrategy(left, right) {
  for (const item of [left, right]) {
    const strategy = nonempty(item?.identification_strategy);
    if (strategy !== "unspecified" && IDENTIFICATION_STRATEGIES.includes(strategy)) return strategy;
  }
  return "unspecified";
}

function emptyContract(lens, group) {
  return {
    research_question: lens.question + " Exposure: " + group.x + "; outcome: " + group.y + ".",
    mechanism: null,
    boundary_conditions: [],
    boring_baseline: { name: null, why_strong: null, wins_if: null },
    strongest_inversion: { statement: null, plausible_because: null },
    outcome_value: { if_supported: null, if_refuted: null },
    kill_test: {
      procedure: null, rejection_criterion: null, primary_estimand: null,
      smallest_useful_effect: null, budget: null, analysis_plan_ref: null,
      instrument_evidence_refs: [],
    },
    closest_prior_art: [],
    procedure: { intervention: null, data_construction: null, measured_quantity: null, analysis_design: null },
    rename_test: { verdict: "not_reviewed", plain_procedure: null, rationale: null, review_ref: null, reviewer_id: null },
    claim_scope: "unspecified",
    empirical_claim_status: "untested",
    evidence: [],
  };
}

function generateDerivedHypotheses(hypotheses, options = {}) {
  const constraints = Array.isArray(options?.designConstraints) ? options.designConstraints : [];
  const groups = new Map();
  for (const source of Array.isArray(hypotheses) ? hypotheses : []) {
    const id = nonempty(source?.hypothesis_id);
    const x = nonempty(source?.x_variable);
    const y = nonempty(source?.y_variable);
    if (!id || !x || !y) continue;
    // Do not join declared different cycles/objectives by shared variable names.
    const key = JSON.stringify([source.cycle_id || null, source.objective_id || null, x, y]);
    if (!groups.has(key)) groups.set(key, { key, x, y, sources: new Map() });
    if (!groups.get(key).sources.has(id)) groups.get(key).sources.set(id, source);
  }
  const supplied = Array.isArray(options?.candidateContracts) ? options.candidateContracts : [];
  // Bound by questions, keeping all lenses per question. Neither support counts
  // nor duplicated references affect this deterministic, unranked frontier.
  const maxProblems = Number.isInteger(options?.maxProblems) && options.maxProblems > 0
    ? options.maxProblems : 3;
  const candidates = [];
  const orderedGroups = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const group of orderedGroups.slice(0, maxProblems)) {
    const sources = [...group.sources.values()].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id));
    const groupId = createHash("sha256").update(group.key).digest("hex").slice(0, 16);
    for (const lens of PROCEDURE_FAMILIES) {
      const candidateId = "cand:" + groupId + ":" + lens.id;
      // Bind evidence to an exact candidate; family-wide overrides can leak
      // one problem's prior art into another problem.
      const matching = supplied.filter((item) => item?.candidate_id === candidateId);
      const concrete = matching.length === 1 ? matching[0] : null;
      const contract = concrete?.scientific_contract
        ? JSON.parse(JSON.stringify(concrete.scientific_contract)) : emptyContract(lens, group);
      const candidate = {
        candidate_id: candidateId,
        derivation_type: "procedure_frontier",
        procedure_family: lens.id,
        source_hypotheses: sources.map((source) => source.hypothesis_id),
        x_variable: group.x,
        y_variable: group.y,
        statement: nonempty(concrete?.statement) || "Untested research question: " + (contract.research_question || lens.question),
        priority: 0,
        priority_basis: "unranked_scientific_frontier",
        identification_strategy: lens.strategy,
        source_identification_strategy: inferIdentificationStrategy(sources[0], sources[1]),
        generation_scope: {
          available_problem_count: orderedGroups.length,
          included_problem_count: Math.min(orderedGroups.length, maxProblems),
          truncated: orderedGroups.length > maxProblems,
        },
        novelty_delta_score: null,
        expected_impact_score: null,
        scientific_contract: contract,
        generation_guidance: {
          proposed_procedure: lens.procedure,
          mechanism: lens.mechanism,
          boundary_conditions: lens.boundary,
          boring_baseline: lens.baseline,
          strongest_inversion: lens.inversion,
          informative_if_supported: lens.supported,
          informative_if_refuted: lens.refuted,
          cheapest_kill_test: lens.kill,
          prior_art: "Verify the closest primary source for the executed procedure and state the exact delta; unknown blocks readiness.",
          rename_test: "Remove method and domain labels; an attributable review must establish a substantive change in executable operations.",
          human_hci_gate: "Simulation or model judges cannot establish human trust, workload, usability or preference claims; validate actual participant evidence.",
        },
      };
      candidate.scientific_contract_validation = validateHypothesisCandidate(candidate);
      if (matching.length > 1) {
        candidate.scientific_contract_validation.blockers.push("ambiguous:candidate_contracts");
        candidate.scientific_contract_validation.ready_for_kill_test = false;
      }
      candidate.readiness = candidate.scientific_contract_validation.ready_for_kill_test
        ? "ready_for_kill_test" : "needs_scientific_contract";
      candidate.design_constraint_violations = matchConstraintViolations(candidate, constraints);
      candidates.push(candidate);
    }
  }
  return candidates;
}

module.exports = {
  IDENTIFICATION_STRATEGIES,
  PROCEDURE_FAMILIES,
  generateDerivedHypotheses,
  inferIdentificationStrategy,
  validateHypothesisCandidate,
  validateHypothesisFrontier,
};
