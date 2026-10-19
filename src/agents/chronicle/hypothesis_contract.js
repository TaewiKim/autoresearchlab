"use strict";

// These checks establish contract completeness, not scientific truth. In
// particular, neither wording, citation counts nor model self-scores establish
// novelty. Semantic judgments and verified evidence stay explicit inputs.
const PROCEDURE_AXES = Object.freeze([
  "intervention", "data_construction", "measured_quantity", "analysis_design",
]);
const CLAIM_SCOPES = Object.freeze([
  "simulation", "physical_experiment", "human_hci", "formal", "observational",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value) {
  return text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function nonemptyList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => text(item));
}

function completeProcedure(procedure) {
  return PROCEDURE_AXES.every((axis) => text(procedure?.[axis]));
}

function procedureSignature(procedure) {
  if (!completeProcedure(procedure)) return null;
  // Labels, family names and hypothesis prose deliberately do not participate.
  return JSON.stringify(PROCEDURE_AXES.map((axis) => normalize(procedure[axis])));
}

function validateHypothesisCandidate(candidate) {
  const contract = candidate?.scientific_contract || {};
  const blockers = [];
  const requiredText = (value, name) => {
    if (!text(value)) blockers.push(`missing:${name}`);
  };
  requiredText(contract.research_question, "research_question");
  requiredText(contract.mechanism, "mechanism");
  if (!nonemptyList(contract.boundary_conditions)) blockers.push("missing:boundary_conditions");
  for (const field of ["name", "why_strong", "wins_if"]) {
    requiredText(contract.boring_baseline?.[field], `boring_baseline.${field}`);
  }
  for (const field of ["statement", "plausible_because"]) {
    requiredText(contract.strongest_inversion?.[field], `strongest_inversion.${field}`);
  }
  for (const field of ["if_supported", "if_refuted"]) {
    requiredText(contract.outcome_value?.[field], `outcome_value.${field}`);
  }
  if (text(contract.outcome_value?.if_supported)
      && normalize(contract.outcome_value.if_supported) === normalize(contract.outcome_value?.if_refuted)) {
    blockers.push("outcome_value:indistinguishable_conclusions");
  }
  for (const field of ["procedure", "rejection_criterion", "primary_estimand", "analysis_plan_ref"]) {
    requiredText(contract.kill_test?.[field], `kill_test.${field}`);
  }
  const effect = contract.kill_test?.smallest_useful_effect;
  if (typeof effect !== "number" || !Number.isFinite(effect) || effect <= 0) {
    blockers.push("missing:kill_test.positive_smallest_useful_effect");
  }
  const budget = contract.kill_test?.budget;
  if (![budget?.max_trials, budget?.max_runtime_seconds].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  )) blockers.push("missing:kill_test.bounded_budget");
  if (!nonemptyList(contract.kill_test?.instrument_evidence_refs)) {
    blockers.push("missing:kill_test.instrument_evidence_refs");
  }
  if (!completeProcedure(contract.procedure)) blockers.push("missing:executable_procedure");

  const priorArt = Array.isArray(contract.closest_prior_art) ? contract.closest_prior_art : [];
  if (!priorArt.length) blockers.push("missing:closest_prior_art");
  const priorDeltas = priorArt.map((prior, index) => {
    for (const field of ["source_id", "title", "url", "verified_claim", "exact_novelty_delta"]) {
      requiredText(prior?.[field], `closest_prior_art.${index}.${field}`);
    }
    if (prior?.verification_status !== "verified_primary") {
      blockers.push(`prior_art:${index}:primary_source_unverified`);
    }
    if (!completeProcedure(prior?.procedure)) {
      blockers.push(`prior_art:${index}:procedure_unknown`);
      return { source_id: prior?.source_id || null, changed_axes: [] };
    }
    const changed = completeProcedure(contract.procedure)
      ? PROCEDURE_AXES.filter((axis) => normalize(contract.procedure[axis]) !== normalize(prior.procedure[axis]))
      : [];
    if (!changed.length) blockers.push(`rename_test:${index}:same_executed_procedure`);
    return { source_id: prior.source_id, changed_axes: changed };
  });

  // Structural differences alone cannot distinguish a synonym from a method
  // change. Require an attributable semantic review, never auto-pass on words.
  const rename = contract.rename_test || {};
  const renameReviewed = rename.verdict === "substantive_procedure_change"
    && text(rename.plain_procedure) && text(rename.rationale)
    && text(rename.reviewer_id) && text(rename.review_ref)
    && rename.candidate_id === candidate?.candidate_id
    && completeProcedure(contract.procedure)
    && rename.procedure_signature === procedureSignature(contract.procedure);
  if (!renameReviewed) blockers.push("rename_test:independent_review_required");

  if (!CLAIM_SCOPES.includes(contract.claim_scope)) blockers.push("missing:claim_scope");
  // This is a conservative claim-scope check, never a merit score. Merely
  // labelling a trust/workload claim "simulation" must not bypass the human
  // evidence boundary. A detected claim is sent for explicit scope repair.
  const humanClaimText = [candidate?.statement, contract.research_question, contract.kill_test?.primary_estimand]
    .filter((value) => typeof value === "string").join(" ");
  const humanOutcomeMentioned = /\b(trust|workload|usability|user satisfaction|perceived safety|appropriate reliance|human preferences?|nasa[- ]tlx)\b/i.test(humanClaimText);
  const human = contract.claim_scope === "human_hci" || humanOutcomeMentioned;
  if (humanOutcomeMentioned && contract.claim_scope !== "human_hci") {
    blockers.push("human_claim:explicit_scope_required");
  }
  const humanPlan = contract.human_study_plan || {};
  if (human) {
    for (const field of ["design", "primary_outcome", "sampling_plan", "analysis_plan_ref"]) {
      requiredText(humanPlan[field], `human_study_plan.${field}`);
    }
  }
  const humanEvidence = (Array.isArray(contract.evidence) ? contract.evidence : []).filter((item) =>
    item?.kind === "human_study"
      && item.verification_status === "verified_primary"
      && text(item.artifact_ref)
      && Number.isInteger(item.participants) && item.participants > 0
      && Array.isArray(item.measured_outcomes)
      && text(humanPlan.primary_outcome)
      && item.measured_outcomes.some((outcome) => normalize(outcome) === normalize(humanPlan.primary_outcome)),
  );
  // An LLM judge, simulated person or robot rollout cannot establish HCI
  // outcomes. A concrete future human study can still be an exploration plan.
  const humanAllowed = human && humanEvidence.length > 0;
  if (human && contract.empirical_claim_status === "supported" && !humanAllowed) {
    blockers.push("human_claim:real_participant_evidence_required");
  }
  return {
    ready_for_kill_test: blockers.length === 0,
    blockers: [...new Set(blockers)],
    procedure_signature: procedureSignature(contract.procedure),
    rename_test: {
      status: renameReviewed && priorArt.length > 0
        && priorDeltas.every((item) => item.changed_axes.length > 0)
        && !blockers.some((item) => item.startsWith("prior_art:"))
        ? "reviewed" : "unresolved",
      prior_art_deltas: priorDeltas,
    },
    human_claim_gate: {
      status: human ? (humanAllowed ? "verified_participant_evidence_supplied" : "human_data_required") : "not_a_human_claim",
      empirical_human_claim_allowed: humanAllowed,
      simulation_scope: human ? "instrument_feasibility_only" : "declared_claim_scope",
    },
    // Contract readiness is deliberately not a claim-support/novelty score.
    novelty_delta_score: null,
    scientific_merit_status: "requires_independent_assessment",
  };
}

function validateHypothesisFrontier(candidates, { minimumDistinctProcedures = 5 } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const minimum = Number.isInteger(minimumDistinctProcedures) && minimumDistinctProcedures >= 5
    ? minimumDistinctProcedures : 5;
  const results = rows.map((candidate) => ({
    candidate_id: candidate?.candidate_id || null,
    validation: validateHypothesisCandidate(candidate),
  }));
  const signatures = new Map();
  for (const item of results) {
    const signature = item.validation.procedure_signature;
    if (!signature) continue;
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature).push(item.candidate_id);
  }
  const readySignatures = new Set(results
    .filter((item) => item.validation.ready_for_kill_test)
    .map((item) => item.validation.procedure_signature));
  const ids = rows.map((candidate) => candidate?.candidate_id);
  const uniqueIds = ids.every((id) => text(id)) && new Set(ids).size === ids.length;
  return {
    ready_for_selection: uniqueIds && readySignatures.size >= minimum,
    minimum_distinct_procedures: minimum,
    distinct_procedure_count: signatures.size,
    ready_distinct_procedure_count: readySignatures.size,
    duplicate_procedure_groups: [...signatures.values()].filter((group) => group.length > 1),
    candidate_ids_unique: uniqueIds,
    candidates: results,
  };
}

module.exports = {
  CLAIM_SCOPES,
  PROCEDURE_AXES,
  procedureSignature,
  validateHypothesisCandidate,
  validateHypothesisFrontier,
};
