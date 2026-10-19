pub(crate) fn infer_followup_role_from_lane_id(lane_id: &str) -> String {
    let trimmed = lane_id.strip_prefix("followup-").unwrap_or(lane_id);
    for role in [
        "lab-director",
        "lab-runner",
        "gatekeeper",
        "chronicle",
        "illustrator",
        "analyst",
        "engineer",
        "scout",
        "author",
    ] {
        if trimmed == role || trimmed.starts_with(&format!("{role}-")) {
            return role.to_string();
        }
    }
    "unknown".to_string()
}

pub(crate) fn lane_id_looks_like_analyst(lane_id: &str) -> bool {
    let trimmed = lane_id.strip_prefix("followup-").unwrap_or(lane_id);
    trimmed == "analyst" || trimmed.starts_with("analyst-")
}

pub(crate) fn lane_id_looks_like_lab_runner(lane_id: &str) -> bool {
    let trimmed = lane_id.strip_prefix("followup-").unwrap_or(lane_id);
    trimmed == "lab-runner"
        || trimmed.starts_with("lab-runner-")
        || trimmed == "runner"
        || trimmed.starts_with("runner-")
}

/// The engineer's second duty: run one of the LabDirector's `simulation_orders` and
/// write the episodes.csv + manifest.json an analyst then analyses. Engineer work,
/// never an analyst's or a lab-runner's: they analyse data, they do not decide how
/// it is produced.
pub(crate) const SIMULATION_DATA_GENERATION_ACTION: &str = "simulation_data_generation_followup";

/// The engineer's third duty: audit how a lab-runner's result was PRODUCED.
///
/// The analyst already reviews what a runner's numbers mean
/// (`runner_result_interpretation_followup`), and the engineer already repairs a
/// runner that failed. Nobody asked whether a run that SUCCEEDED did what it
/// claimed -- whether the tool, version, config and checkpoint the handoff named
/// are the ones that actually ran, whether something fell back silently, whether
/// the wall time is possible for the work reported. That is engineer knowledge,
/// and it is a different question from the analyst's.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. A lane reported 4500
/// episodes over three policy arms it had "trained" in 15 milliseconds. The
/// numbers were reviewable and an analyst could have drawn a curve through them;
/// what was wrong was upstream of the numbers, in how they were produced.
pub(crate) const RUNNER_EXECUTION_AUDIT_ACTION: &str = "runner_execution_audit_followup";

/// The LabDirector decides what to do about the lanes the analysts asked for.
///
/// MEASURED ON cycle-a-20260919, 2026-09-27. After a four-day quota
/// pause the cycle resumed into a closed loop and stayed there: eight planner
/// passes, 252 priority actions, `created_followups: []`, `launched: []`. Every
/// one of the 252 was a review-class action already run dozens of times
/// (gate_restart 124, novelty 54, chronicle_evidence_request 35), so the
/// duplicate guard suppressed all of them. Every pending lane waited on another:
/// seven gatekeepers on a runner, four runners on an analyst handoff, and all
/// 125 analyst handoffs said `ready_for_runner: false` -- correctly, because the
/// bundle's snapshot identity was unproven and no official Push-T anchor
/// existed. Those two are exactly what the analysts had proposed, 349 times, in
/// a field nothing read.
///
/// The one action that is not a duplicate of anything is "here is what the
/// analysts asked for; decide". It is the director's, not the harness's: the
/// harness asks, the director chooses what runs.
pub(crate) const ANALYSIS_PROPOSAL_DECISION_ACTION: &str = "analysis_proposal_decision_followup";

/// The role that owns a follow-up action type, where the type alone decides it.
pub(crate) fn followup_role_for_action(action_type: &str) -> Option<&'static str> {
    match action_type {
        SIMULATION_DATA_GENERATION_ACTION => Some("engineer"),
        RUNNER_EXECUTION_AUDIT_ACTION => Some("engineer"),
        ANALYSIS_PROPOSAL_DECISION_ACTION => Some("lab-director"),
        _ => None,
    }
}

pub(crate) fn default_followup_action_for_role(role: &str) -> &'static str {
    match role {
        "scout" => "data_acquisition_followup",
        "analyst" => "pivot_followup",
        "gatekeeper" => "independent_gate_review_followup",
        "lab-director" => "lab_director_requery_followup",
        "lab-runner" => "methods_followup",
        "chronicle" => "logic_trace_followup",
        "author" => "logic_followup",
        "illustrator" => "visualization_followup",
        // What an engineer lane is opened for by default: something the design
        // needs does not run here yet.
        "engineer" => "capability_provisioning_followup",
        _ => "followup_experiment",
    }
}
