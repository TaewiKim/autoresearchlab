"use strict";

const SUPERVISOR_LAB_DIRECTOR_ROLE_BOUNDARY = Object.freeze({
  supervisor:
    "Own process health and completion pressure: detect stalls, enforce role handoffs, restart or refresh operationally, and require LabDirector adjudication when execution patterns stop advancing evidence. The supervisor does not invent scientific hypotheses and must not author concrete research, dataset, or analysis instructions.",
  lab_director:
    "Own research strategy, hypothesis selection, evidence interpretation, and scientific corrective direction. LabDirector must author the concrete research decision, research-note update, and next-role assignment after supervisor escalation.",
});

const SUPERVISOR_ESCALATION_POLICY = Object.freeze({
  issue_owner: "supervisor",
  scientific_owner: "lab-director",
  must_direct_lab_director_on_stagnation: true,
  supervisor_forbidden_actions: [
    "invent_scientific_hypotheses",
    "select_or_pivot_the_lead_without_lab_director",
    "author_concrete_research_or_analysis_instructions",
    "rewrite_scientific_conclusions",
  ],
  lab_director_required_response: [
    "acknowledge_the_supervisor_instruction",
    "identify_the_stalled_evidence_link",
    "choose_a_scientific_corrective_decision",
    "author_the_next_research_instruction",
    "assign_the_next_role_with_a_concrete_dataset_artifact_or_validation_target",
    "record_the_decision_and_rationale_in_research_notes",
  ],
});

function supervisorLabDirectorRoleBoundary() {
  return { ...SUPERVISOR_LAB_DIRECTOR_ROLE_BOUNDARY };
}

function supervisorEscalationPolicy() {
  return {
    ...SUPERVISOR_ESCALATION_POLICY,
    supervisor_forbidden_actions: [...SUPERVISOR_ESCALATION_POLICY.supervisor_forbidden_actions],
    lab_director_required_response: [...SUPERVISOR_ESCALATION_POLICY.lab_director_required_response],
  };
}

module.exports = {
  supervisorLabDirectorRoleBoundary,
  supervisorEscalationPolicy,
};
