#![allow(unused_imports)]
use super::*;

pub(crate) fn existing_recovery_lane_for_origin(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    root_lane_id: &str,
    recovery_reason: &str,
) -> Result<Option<String>> {
    let recovery_prefix = format!("{root_lane_id}-recovery-");
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)?
        .into_iter()
        .filter(|(lane_id, _)| lane_id.starts_with(&recovery_prefix))
    {
        let role_plan_path = lane_dir.join("role-plan.json");
        if !role_plan_path.exists() {
            return Ok(Some(lane_id));
        }
        let metadata = fs::metadata(&role_plan_path)?;
        if metadata.len() > 64_000 {
            let window = json_file_window_text(&role_plan_path, 64_000)?;
            if window.contains("recovery_followup")
                && window.contains(role)
                && window.contains(root_lane_id)
                && window.contains(recovery_reason)
            {
                return Ok(Some(lane_id));
            }
            continue;
        }
        let role_plan = read_json(&role_plan_path)?;
        if role_plan.get("role").and_then(Value::as_str) != Some(role) {
            continue;
        }
        if role_plan.get("action_type").and_then(Value::as_str) != Some("recovery_followup") {
            continue;
        }
        let metadata = role_plan
            .get("planner_metadata")
            .or_else(|| role_plan.get("metadata"))
            .cloned()
            .unwrap_or(Value::Null);
        let existing_root = metadata
            .get("root_lane_id")
            .and_then(Value::as_str)
            .or_else(|| metadata.get("original_lane_id").and_then(Value::as_str))
            .unwrap_or("");
        let existing_root = dependency_base_lane_id(existing_root);
        let existing_reason = metadata
            .get("recovery_reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        if existing_root == root_lane_id && existing_reason == recovery_reason {
            return Ok(Some(lane_id));
        }
    }
    Ok(None)
}

pub(crate) fn recovery_lane_count_for_origin(
    paths: &AppPaths,
    cycle_id: &str,
    _role: &str,
    root_lane_id: &str,
) -> Result<usize> {
    let recovery_prefix = format!("{root_lane_id}-recovery-");
    let count = lane_dirs_from_contract_index(paths, cycle_id)?
        .into_iter()
        .filter(|(lane_id, _)| lane_id.starts_with(&recovery_prefix))
        .count();
    if count > 0 {
        return Ok(count);
    }

    Ok(0)
}

pub(crate) fn enforce_stage_gate_recovery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
    objective: &str,
) -> Result<Value> {
    let gate_state = research_stage_gate_state(paths, cycle_id)?;
    let gates = gate_state
        .get("gates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // If an expert gatekeeper has already rejected the hypothesis, that
    // scientific failure is the controlling recovery target even when an
    // earlier advisory artifact gate (for example a stale KG/trend digest) is
    // also marked incomplete.  Otherwise the dispatcher can keep spawning
    // generic analyst/runner repairs and never answer the gate review.
    let failed_stage = gates
        .iter()
        .find(|gate| {
            gate.get("stage").and_then(Value::as_str) == Some("hypothesis_generation")
                && gate.get("passed").and_then(Value::as_bool) != Some(true)
                && gate
                    .get("explicit_hypothesis_gate_failed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .or_else(|| {
            gates
                .iter()
                .find(|gate| gate.get("passed").and_then(Value::as_bool) != Some(true))
        });
    let Some(failed_stage) = failed_stage else {
        return Ok(gate_state);
    };
    let stage = failed_stage
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("");
    let retry_from_stage = failed_stage
        .get("retry_from_stage")
        .and_then(Value::as_str)
        .unwrap_or(stage);

    // The recovery filter below keeps only the actions that can answer a failed
    // hypothesis gate. That is right while the cycle is still trying to pass it,
    // and wrong the moment the owner has authorised writing the paper anyway:
    // every document action -- the author and illustrator work the document
    // reviews ask for -- is dropped on the floor, so a manuscript can be blocked
    // by the paper gate and unfixable at the same time.
    //
    // cycle-g-v89 spent a full day in that state. The paper review emitted three
    // author-owned blockers, the plan carried six document actions into this
    // function, 797 actions came out with none of them, no author lane was ever
    // opened, and the run halted on stagnation with the manuscript byte-identical
    // to the one it started with.
    //
    // Same shape as the note in dependency_gates_01: the authorisation exempted
    // the lane gate and the traffic moved to the door still bolted.
    let document_stage_released = document_stage_authorized(paths, cycle_id);
    match (stage, retry_from_stage) {
        ("hypothesis_generation", "literature_data_search") => {
            priority_actions.retain(|action| {
                let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
                let brief_id = action.get("brief_id").and_then(Value::as_str).unwrap_or("");
                let direct_analyst_handoff_runner =
                    action_type == "methods_followup" && brief_id.starts_with("analyst-handoff");
                // Role was the wrong test. An owner-adopted experiment is
                // ANALYST work and a figure claim is verified by the GATEKEEPER
                // on purpose, so both were dropped here while the manuscript
                // waited on them. What makes an action document work is that a
                // document review raised it and the document gate will not pass
                // without it.
                let from_document_review =
                    brief_id == "paper-review" || brief_id == "report-review";
                let gate_required_document_action = document_stage_released
                    && from_document_review
                    && action
                        .get("required_for_gate")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                let authorised_document_work = gate_required_document_action
                    || (document_stage_released
                        && matches!(
                            action.get("preferred_role").and_then(Value::as_str),
                            Some("author") | Some("illustrator")
                        ));
                authorised_document_work
                    || (action_type == "data_acquisition_followup"
                    && (brief_id == "hypothesis-gate-literature-restart"
                        || brief_id == "stage-gate-search-retry"))
                    || direct_analyst_handoff_runner
                    || action_type.starts_with("hypothesis_regeneration")
                    || matches!(
                        action_type,
                        "gate_restart_followup"
                            | "lab_director_requery_followup"
                            | "analyst_handoff_review_followup"
                            | "runner_scientific_recovery_followup"
                            | "chronicle_gate_deliberation_followup"
                            | "chronicle_evidence_request_followup"
                            | "labdirector_comparator_validation_followup"
                            | "independent_gate_review_followup"
                            | "novelty_followup"
                    )
            });
            let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
            if gate_review_path.exists() {
                let gate_review = read_json(&gate_review_path)?;
                for rubric in gate_review
                    .get("gatekeeper_pending_rubrics")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
                    .filter(|item| !item.is_empty())
                {
                    if priority_actions.iter().any(|action| {
                        action.get("type").and_then(Value::as_str)
                            == Some("independent_gate_review_followup")
                            && action.get("target_rubric").and_then(Value::as_str)
                                == Some(rubric.as_str())
                    }) {
                        continue;
                    }
                    priority_actions.push(json!({
                        "brief_id": "gate-review",
                        "type": "independent_gate_review_followup",
                        "preferred_role": "gatekeeper",
                        "target_rubric": rubric,
                        "priority": "critical",
                        "priority_score": 246,
                        "target_score": 95,
                        "description": "Close the missing current-hypothesis independent gatekeeper rubric before opening more recovery side work.",
                        "recovery_reason": "gatekeeper_pending_rubric_review_required",
                    }));
                }
            }
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-chronicle-deliberation")
            }) {
                priority_actions.push(json!({
                    "brief_id": "hypothesis-gate-chronicle-deliberation",
                    "type": "chronicle_gate_deliberation_followup",
                    "preferred_role": "chronicle",
                    "target_rubric": "hypothesis_strategy",
                    "priority": "critical",
                    "priority_score": 240,
                    "description": "Hypothesis gate failed. Before LabDirector chooses a new plan, conduct a deep Chronicle deliberation over the Gatekeeper review: reconstruct the criticism, debate at least three mechanism-level hypothesis families for the current lead/dataset context, identify the same-dataset baseline and missing evidence, and produce decision-ready options for LabDirector rather than a direct validation patch.",
                    "candidate_hypotheses": [],
                    "recovery_reason": "hypothesis_gate_failed_chronicle_deliberation_required",
                    "deliberation_contract": {
                        "participants": ["chronicle", "lab-director"],
                        "chronicle_role": "scientific evidence curator and adversarial debate partner",
                        "lab_director_role": "final research-wide decision maker after reading the deliberation memo",
                        "must_compare_families": [
                            "antigen-presentation / interferon-response failure",
                            "myeloid-exclusion / stromal-barrier program",
                            "incumbent latent immune microenvironment state"
                        ],
                        "must_output": [
                            "gatekeeper_critique_reconstruction",
                            "three_family_debate_table",
                            "same_dataset_baseline_map_for_current_lead",
                            "variables_and_confounders_needed",
                            "recommended_decision_options_for_lab_director"
                        ]
                    }
                }));
            }
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-literature-restart")
                    && action.get("type").and_then(Value::as_str)
                        == Some("data_acquisition_followup")
            }) {
                priority_actions.push(json!({
                    "brief_id": "hypothesis-gate-literature-restart",
                    "type": "data_acquisition_followup",
                    "preferred_role": "scout",
                    "target_rubric": "hypothesis_gate",
                    "priority": "high",
                    "priority_score": 220,
                    "description": "Hypothesis gate failed. Restart from literature/data search: find fresh high-impact literature and named public datasets or benchmarks from the objective's own field before regenerating KG and hypotheses. Do not proceed directly to validation patches.",
                    "candidate_hypotheses": [],
                    "recovery_reason": "hypothesis_gate_failed_restart_from_literature_search",
                    "dataset_discovery_contract": dataset_discovery_contract(objective),
                }));
            }
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-literature-restart")
                    && action.get("type").and_then(Value::as_str)
                        == Some("hypothesis_regeneration_from_literature_search")
            }) {
                priority_actions.push(json!({
                    "brief_id": "hypothesis-gate-literature-restart",
                    "type": "hypothesis_regeneration_from_literature_search",
                    "preferred_role": "scout",
                    "target_rubric": "hypothesis_gate",
                    "priority": "high",
                    "priority_score": 215,
                    "description": "Hypothesis gate failed. Reopen literature search first, identify stronger mechanism/dataset families, then let Chronicle rebuild KG before LabDirector selects a new lead.",
                    "candidate_hypotheses": [],
                    "recovery_reason": "hypothesis_gate_failed_restart_from_literature_search",
                }));
            }
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-labdirector-requery")
            }) {
                priority_actions.push(json!({
                    "brief_id": "hypothesis-gate-labdirector-requery",
                    "type": "gate_restart_followup",
                    "preferred_role": "lab-director",
                    "target_rubric": "hypothesis_strategy",
                    "priority": "high",
                    "priority_score": 230,
                    "description": "Hypothesis gate failed. After reading Chronicle's gate-deliberation memo, make the research-wide decision for the current lead/dataset path: rerank at least three mechanism-level hypothesis families, state why the current family should be kept or replaced, and bind the selected family to a same-dataset baseline, explicit variables, confounders, comparators, and transportability plan.",
                    "candidate_hypotheses": [],
                    "recovery_reason": "hypothesis_gate_failed_labdirector_requery_required",
                    "requires_completed_chronicle_gate_deliberation": true,
                }));
            }
        }
        ("literature_data_search", _) => {
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str) == Some("stage-gate-search-retry")
            }) {
                priority_actions.push(json!({
                    "brief_id": "stage-gate-search-retry",
                    "type": "data_acquisition_followup",
                    "preferred_role": "scout",
                    "target_rubric": "literature_data_search_gate",
                    "priority": "high",
                    "priority_score": 210,
                    "description": "Stage gate failed before KG generation: rerun literature/data scout search and return named public accessions plus literature support.",
                    "dataset_discovery_contract": dataset_discovery_contract(objective),
                }));
            }
        }
        ("kg_generation", _) => {
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str) == Some("stage-gate-kg-retry")
            }) {
                priority_actions.push(json!({
                    "brief_id": "stage-gate-kg-retry",
                    "type": "logic_trace_followup",
                    "preferred_role": "chronicle",
                    "target_rubric": "kg_generation_gate",
                    "priority": "high",
                    "priority_score": 205,
                    "description": "Stage gate failed at KG generation: rebuild literature_graph, data_graph, and trend_summary from completed scout outputs before LabDirector hypothesis generation.",
                }));
            }
        }
        ("validation_materialization_analysis", _) => {
            if !priority_actions.iter().any(|action| {
                action.get("brief_id").and_then(Value::as_str)
                    == Some("stage-gate-validation-materialization")
            }) {
                priority_actions.push(json!({
                    "brief_id": "stage-gate-validation-materialization",
                    "type": "data_acquisition_followup",
                    "preferred_role": "scout",
                    "target_rubric": "validation_materialization_gate",
                    "priority": "high",
                    "priority_score": 200,
                    "description": "Validation gate failed: materialize the selected hypothesis dataset and its same-dataset baseline context before analyst/lab-runner/gate analysis.",
                    "dataset_discovery_contract": dataset_discovery_contract(objective),
                }));
            }
        }
        _ => {}
    }
    priority_actions.sort_by(|a, b| {
        b["priority_score"]
            .as_i64()
            .cmp(&a["priority_score"].as_i64())
    });
    Ok(gate_state)
}
