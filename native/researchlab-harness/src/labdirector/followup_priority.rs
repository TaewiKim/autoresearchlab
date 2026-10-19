use serde_json::Value;

fn value_text_contains_any(value: &Value, needles: &[&str]) -> bool {
    let text = serde_json::to_string(value)
        .unwrap_or_default()
        .to_ascii_lowercase();
    needles.iter().any(|needle| text.contains(needle))
}

fn explicit_gate_blocking_recovery_marker(value: &Value) -> bool {
    value
        .get("gate_blocking_recovery")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("planner_metadata")
            .and_then(|item| item.get("gate_blocking_recovery"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value
            .get("planner_metadata")
            .and_then(|item| item.get("review_action"))
            .and_then(|item| item.get("gate_blocking_recovery"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn action_type_from_value(value: &Value) -> &str {
    value
        .get("type")
        .or_else(|| value.get("action_type"))
        .or_else(|| value.get("task_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn target_rubric_from_value(value: &Value) -> &str {
    value
        .get("target_rubric")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("planner_metadata")
                .and_then(|item| item.get("target_rubric"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("planner_metadata")
                .and_then(|item| item.get("review_action"))
                .and_then(|item| item.get("target_rubric"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
}

pub(crate) fn gate_blocking_execution_recovery_action(value: &Value) -> bool {
    let action_type = action_type_from_value(value);
    let target_rubric = target_rubric_from_value(value);
    let recovery_type = matches!(
        action_type,
        "methods_followup"
            | "baseline_confounder_waiver_followup"
            | "runner_result_interpretation_followup"
            | "external_validation_analysis_followup"
    );
    if !recovery_type {
        return false;
    }
    let gate_rubric = matches!(
        target_rubric,
        "reproducibility" | "technical_quality" | "external_validity"
    );
    let repository_workflow_blocker = explicit_gate_blocking_recovery_marker(value)
        || value_text_contains_any(
            value,
            &[
                "mandatory omics/high-dimensional",
                "repository-native workflow",
                "repository-native workflow/skill/domain command",
                "open_source_repository_workflow_applied",
                "substantive_repository_workflow_applied",
                "repository_agent_required",
            ],
        );
    gate_rubric && repository_workflow_blocker
}

pub(crate) fn followup_action_sort_key(
    action: &Value,
    external_validation_required: bool,
    gate_closure_ready: bool,
) -> (usize, usize) {
    let brief_id = action.get("brief_id").and_then(Value::as_str).unwrap_or("");
    let action_type = action
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("followup_experiment");
    let target_rubric = action
        .get("target_rubric")
        .and_then(Value::as_str)
        .unwrap_or("");
    let priority = action
        .get("priority")
        .and_then(Value::as_str)
        .unwrap_or("medium");
    // A valid falsification makes replacement the live pipeline transition.
    // Evidence work for the retired method cannot outrank the director who is
    // solely authorised to choose its successor.
    if action
        .get("falsification_replacement_required")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return (0usize, 0usize);
    }
    if brief_id == "analyst-handoff"
        || brief_id == "analyst-handoff-artifact"
        || brief_id.starts_with("analyst-handoff-revision")
    {
        return (0usize, 0usize);
    }
    // The ordered experiment outranks every review of it. It is the only action
    // that can produce the cycle's evidence; a gate adjudicating a lead with no
    // data yet is reviewing an empty file.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21. The engineer action
    // for coverage_decay_planar_push_v1 sat in the queue behind 61 gate
    // restarts, 47 novelty follow-ups and 35 chronicle evidence requests, all
    // ranked ahead of it by target_rubric = gate_independence, so the ordered
    // simulation was never dispatched and the cycle spent a day reviewing a
    // hypothesis whose data nobody had produced.
    if action_type == crate::labdirector::SIMULATION_DATA_GENERATION_ACTION {
        return (0usize, 0usize);
    }
    // The audit of how a result was produced comes before anyone spends a lane
    // interpreting or gating that result: a review of a run that did not do what
    // it claimed is work thrown away, and worse, work that can be believed.
    if action_type == crate::labdirector::RUNNER_EXECUTION_AUDIT_ACTION {
        return (0usize, 0usize);
    }
    // The decision on the analysts' proposals is how a prerequisite no plan
    // contained becomes a lane. Below it in the queue were 124 gate restarts and
    // 54 novelty follow-ups, each a review of evidence that prerequisite would
    // produce.
    if action_type == crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION {
        return (0usize, 0usize);
    }
    // MEASURED ON cycle-a-20260919, 2026-10-02: at owner_selection
    // the latest director's bounded novelty prerequisite sat behind comparator
    // and gate-review work for already-demoted hypotheses. The prerequisite is
    // the edge that can select a lead; director-authored actions carry the
    // requery decision that generic novelty reviews do not.
    if action_type == "novelty_followup" && action.get("requery_decision").is_some() {
        return (0usize, 3usize);
    }
    // MEASURED ON cycle-a-20260919, 2026-10-03: five consecutive
    // gate_restart_followup lanes all returned defer_for_chronicle and named
    // the same bounded Chronicle evidence request, but the restart sort key
    // kept selecting the dependent decision before its prerequisite.
    if action_type == "chronicle_evidence_request_followup"
        && action.get("requery_decision").and_then(Value::as_str)
            == Some("defer_for_chronicle")
    {
        return (0usize, 0usize);
    }
    if gate_blocking_execution_recovery_action(action) {
        return (
            0usize,
            match priority {
                "critical" | "high" => 0usize,
                "medium" => 1usize,
                _ => 2usize,
            },
        );
    }
    if target_rubric == "gate_independence" {
        let gate_rank = match action_type {
            "gate_restart_followup" | "lab_director_requery_followup" => 0usize,
            "methods_followup" => 1usize,
            "novelty_followup" => 2usize,
            "independent_gate_review_followup" => 3usize,
            _ => 4usize,
        };
        return (gate_rank, 1usize);
    }
    if matches!(
        action_type,
        "gate_restart_followup" | "lab_director_requery_followup"
    ) {
        // The director requery is the cycle's DECISION step: every other role only
        // produces evidence for that decision. Ranked by the default path it sits
        // below the continuous scout/analyst/gatekeeper stream and starves forever
        // (observed on cycle-g-v55: five pending requery lanes, 1h+, zero executed)
        // so the hypothesis can never pivot. Rank it just below the
        // gate-independence variants (which return (0..3, 1) above) regardless of
        // target_rubric.
        return (0usize, 2usize);
    }
    if action_type == "labdirector_comparator_validation_followup" {
        return (1usize, 0usize);
    }
    if brief_id == "hypothesis-gate-literature-restart"
        && action_type == "data_acquisition_followup"
    {
        return (2usize, 0usize);
    }
    if action_type == "independent_gate_review_followup" && !target_rubric.is_empty() {
        return (
            1usize,
            match priority {
                "critical" => 0usize,
                "high" => 1usize,
                "medium" => 2usize,
                _ => 3usize,
            },
        );
    }
    if !external_validation_required && brief_id == "analyst-handoff-review" {
        return (0usize, 0usize);
    }
    let action_rank = if external_validation_required {
        if action_type == "labdirector_comparator_validation_followup" {
            0usize
        } else if action_type == "external_validation_followup" {
            1usize
        } else if action_type == "external_validation_analysis_followup" {
            2usize
        } else if action_type == "lab_director_requery_followup"
            && target_rubric == "external_validity"
        {
            2usize
        } else if gate_closure_ready && action_type == "independent_gate_review_followup" {
            3usize
        } else if action_type == "methods_followup" || action_type == "accuracy_followup" {
            4usize
        } else if action_type == "independent_gate_review_followup" {
            5usize
        } else if action_type.starts_with("hypothesis_regeneration") {
            6usize
        } else if action_type == "gate_restart_followup" || action_type == "hypothesis_followup" {
            7usize
        } else if action_type == "data_acquisition_followup" {
            8usize
        } else if action_type == "novelty_followup" {
            9usize
        } else {
            10usize
        }
    } else if brief_id == "hypothesis-gate-labdirector-requery"
        && action_type == "gate_restart_followup"
    {
        0usize
    } else if gate_closure_ready && action_type == "independent_gate_review_followup" {
        0usize
    } else if action_type == "chronicle_gate_deliberation_followup"
        || action_type == "chronicle_evidence_request_followup"
        || action_type == "labdirector_comparator_validation_followup"
    {
        0usize
    } else if gate_closure_ready && action_type.starts_with("hypothesis_regeneration") {
        1usize
    } else if action_type.starts_with("hypothesis_regeneration") {
        0usize
    } else if action_type == "lab_director_requery_followup" {
        1usize
    } else if action_type == "external_validation_followup" {
        2usize
    } else if action_type == "external_validation_analysis_followup" {
        3usize
    } else if action_type == "methods_followup" || action_type == "accuracy_followup" {
        4usize
    } else if action_type == "independent_gate_review_followup" {
        5usize
    } else if action_type == "gate_restart_followup" || action_type == "hypothesis_followup" {
        6usize
    } else if action_type == "data_acquisition_followup" {
        7usize
    } else if action_type == "novelty_followup" {
        8usize
    } else {
        9usize
    };
    let priority_rank = match priority {
        "high" => 0usize,
        "medium" => 1usize,
        _ => 2usize,
    };
    (action_rank + 2, priority_rank)
}

pub(crate) fn pending_lane_action_priority(
    role_plan: Option<&Value>,
    external_validation_required: bool,
) -> u8 {
    let Some(role_plan) = role_plan else {
        return 3;
    };
    let action_type = role_plan
        .get("action_type")
        .or_else(|| role_plan.get("task_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let planner_metadata = role_plan.get("planner_metadata").and_then(Value::as_object);
    let target_rubric = role_plan
        .get("target_rubric")
        .and_then(Value::as_str)
        .or_else(|| {
            planner_metadata
                .and_then(|item| item.get("target_rubric"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let review_action_type = planner_metadata
        .and_then(|item| item.get("review_action"))
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    // The engineer running a LabDirector simulation order is what every analyst
    // and runner in a simulator-sourced cycle is waiting on. MEASURED ON
    // cycle-b-20260918, 2026-09-18: with one worker slot, followup-engineer-01
    // sat `no-worker-slots` while lab-director and gatekeeper lanes took the slot.
    if action_type == crate::labdirector::lane_identity::SIMULATION_DATA_GENERATION_ACTION {
        return 0;
    }
    // The opening lead waits on the field landscape, so its scout is not queued
    // behind work nobody can use until a lead exists.
    if action_type == crate::labdirector::FIELD_LANDSCAPE_SCOUT_ACTION {
        return 0;
    }
    // And the frontier harvest the deep read waits for.
    if action_type == crate::labdirector::FRONTIER_HARVEST_ACTION {
        return 0;
    }
    // As does the SOTA deep read whose cards the selection starts from.
    if action_type == crate::labdirector::SOTA_DEEP_READ_ACTION {
        return 0;
    }
    // So do the expert-selection stages between the landscape and the lead.
    if crate::labdirector::is_expert_selection_action(action_type) {
        return 0;
    }
    let brief_id = role_plan
        .get("source_brief_id")
        .or_else(|| role_plan.get("brief_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            planner_metadata
                .and_then(|item| item.get("source_brief_id"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    if brief_id == "analyst-handoff"
        || brief_id == "analyst-handoff-artifact"
        || brief_id.starts_with("analyst-handoff-revision")
    {
        0
    } else if gate_blocking_execution_recovery_action(role_plan) {
        0
    } else if action_type == "external_validation_followup"
        || review_action_type == "external_validation_followup"
    {
        0
    } else if action_type == "external_validation_analysis_followup"
        || review_action_type == "external_validation_analysis_followup"
    {
        1
    } else if target_rubric == "external_validity" && external_validation_required {
        2
    } else if target_rubric == "gate_independence"
        && matches!(
            action_type,
            "gate_restart_followup" | "lab_director_requery_followup"
        )
    {
        0
    } else if action_type == "labdirector_comparator_validation_followup" {
        0
    } else if target_rubric == "gate_independence" && action_type == "methods_followup" {
        1
    } else if target_rubric == "gate_independence" && action_type == "novelty_followup" {
        2
    } else if action_type == "independent_gate_review_followup"
        || review_action_type == "independent_gate_review_followup"
    {
        // Keep REVIEWS in the same promoted tier as the director requery. The
        // director-requery promotion below moved starvation onto gatekeeper review
        // lanes (observed on cycle-g-v55: five independent_gate_review lanes pending
        // 2h, zero executed, so no honest score could ever land in the rubric while
        // the hypothesis kept refining). Rank 2 puts reviews in phase 0 with the
        // requery; role_rank (gatekeeper 4 < lab-director 5) then runs the review
        // BEFORE the decision that should consume it.
        2
    } else if matches!(
        action_type,
        "gate_restart_followup" | "lab_director_requery_followup"
    ) {
        // Run-order starvation guard: the director requery is the cycle's decision
        // step - every other role only produces evidence for it. Without this branch
        // a requery with any rubric other than gate_independence falls to the default
        // rank 3, and lane_priority_rank places lab-director last among science roles,
        // so pending requery lanes never enter the run window while scout/analyst/
        // gatekeeper lanes stream through (observed on cycle-g-v55: six pending, 90m,
        // zero executed; hypothesis frozen). Rank 2 also promotes phase_rank to 0 in
        // run_loop, placing the decision step ahead of the evidence stream but below
        // rank-0/1 recovery and gate-independence actions.
        2
    } else if action_type == "data_acquisition_followup" {
        6
    } else {
        3
    }
}

/// Direct Analyst handoff runners are the pipeline edge between a completed
/// design and published validation evidence. They must cross an accumulated
/// review backlog before the general starvation ordering is applied.
pub(crate) fn pending_lane_pipeline_unblock_rank(role_plan: Option<&Value>) -> u8 {
    let Some(role_plan) = role_plan else {
        return 1;
    };
    let role = role_plan.get("role").and_then(Value::as_str).unwrap_or("");
    let action_type = role_plan
        .get("action_type")
        .or_else(|| role_plan.get("task_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let brief_id = role_plan
        .get("source_brief_id")
        .or_else(|| role_plan.get("brief_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if role == "lab-runner"
        && action_type == "methods_followup"
        && (matches!(brief_id, "analyst-handoff" | "analyst-handoff-artifact")
            || brief_id.starts_with("analyst-handoff-revision"))
    {
        0
    // MEASURED ON cycle-a-20260919, 2026-10-02: at
    // experiment_data, three independent reviews finished while the selected
    // simulation bundle still had no post-bundle validation. The Analyst
    // hypothesis_followup creates the executable handoff consumed above, so it
    // is the preceding half of the same pipeline edge and must cross the review
    // backlog too.
    } else if role == "analyst" && action_type == "hypothesis_followup" {
        0
    } else {
        1
    }
}
