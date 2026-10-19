#![allow(unused_imports)]
use super::*;

// Research spend is exhausted and the write-up still has budget of its own. The
// token guard writes this instead of halting, because a halt would leave the
// document pot unspent -- the outcome separating the pots existed to prevent.
//
// Fail-closed twice over: the record must declare itself with a reason, AND the
// document stage must still be authorised. A mode that stops every research lane
// in the cycle must not be reachable by a stray file.
fn document_only_mode(paths: &AppPaths, cycle_id: &str) -> bool {
    if !document_stage_authorized(paths, cycle_id) {
        return false;
    }
    let path = state_root(paths).join(format!("{cycle_id}-document-only.json"));
    let Ok(value) = read_json(&path) else {
        return false;
    };
    if value.get("document_only").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    value
        .get("reason")
        .and_then(Value::as_str)
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

fn is_document_action(action: &Value) -> bool {
    matches!(
        action.get("preferred_role").and_then(Value::as_str),
        Some("author") | Some("illustrator")
    )
}

pub fn dispatch_followup_lanes(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
) -> Result<Vec<Value>> {
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let plan_path = rewrite_task_graph(paths, cycle_id)?;
    let plan = read_json(&plan_path)?;
    let mut existing_signatures = existing_task_signatures(paths, cycle_id)?;
    let mut created = Vec::new();
    let existing_followup_counts = count_followup_lanes_by_role(paths, cycle_id)?;
    let existing_action_counts = count_followup_lanes_by_role_and_action(paths, cycle_id)?;
    let open_action_counts = count_open_followup_lanes_by_role_and_action(paths, cycle_id)?;
    let completed_action_counts =
        count_completed_followup_lanes_by_role_and_action(paths, cycle_id)?;
    let completed_source_keys = completed_followup_action_source_keys(paths, cycle_id)?;
    let existing_total_followups = total_followup_lane_count(paths, cycle_id)?;
    let stage_gate_blocks_pivot = stage_gate_blocks_pivot_for_plan(&plan);
    let mut ranked_actions = plan
        .get("priority_actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if ranked_actions.is_empty() {
        let mut gate_review_actions = Vec::new();
        collect_gate_review_actions(paths, cycle_id, &mut gate_review_actions)?;
        if !gate_review_actions.is_empty() {
            ranked_actions = gate_review_actions;
        }
    }
    // A blocking lane failure asks the director to plan a recovery, and until now
    // nothing opened the lane it was asking for: v90 and v91 both sat at
    // `running: 0` with blocking failures piling up and a live supervisor.
    // Appended rather than substituted -- a recovery request does not displace
    // work the plan already ranked, it joins it.
    collect_blocking_failure_recovery_actions(paths, cycle_id, &mut ranked_actions)?;
    collect_dependency_stall_recovery_actions(paths, cycle_id, &mut ranked_actions)?;
    // MEASURED ON cycle-a-20260919, 2026-09-30: completed engineer
    // diagnostics carried the terminal blocker, so neither recovery collector
    // above could see why the simulation order was unsatisfiable.
    collect_simulation_blocker_recovery_actions(paths, cycle_id, &mut ranked_actions)?;
    // Every dispatch path downstream works from this one list, so the research
    // stop belongs here rather than in any single branch that builds it.
    if document_only_mode(paths, cycle_id) {
        ranked_actions.retain(is_document_action);
    }
    let mut created_by_role: HashMap<String, usize> = HashMap::new();
    let mut created_by_action: HashMap<String, usize> = HashMap::new();
    // The cycle's one follow-up budget; when it is spent nothing more is
    // created, for any role. See budget_caps::total_followup_cap.
    let total_followup_cap = total_followup_cap();
    if existing_total_followups >= total_followup_cap {
        notice_followup_budget_spent(paths, cycle_id, existing_total_followups, total_followup_cap);
        return Ok(created);
    }

    let pass_budget_by_role = pass_followup_budget_by_role();
    let next_action_attempt =
        |role: &str, action_type: &str, created_by_action: &HashMap<String, usize>| -> usize {
            next_dispatch_action_attempt(
                role,
                action_type,
                &existing_action_counts,
                created_by_action,
            )
        };

    let selected_hypotheses = plan
        .get("selected_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ranked_hypotheses = if selected_hypotheses.is_empty() {
        plan.get("priority_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        selected_hypotheses.clone()
    };
    let plan_candidate_hypotheses = plan
        .get("derivable_hypothesis_candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let plan_schema_quality = plan.get("schema_quality").cloned().unwrap_or(Value::Null);
    let plan_reasoning_graph = plan.get("reasoning_graph").cloned().unwrap_or(Value::Null);
    let plan_data_graph = plan.get("data_graph").cloned().unwrap_or(Value::Null);
    let plan_open_validation_gaps = plan
        .get("open_validation_gaps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_completed_labdirector_requery =
        completed_labdirector_requery_payloads(paths, cycle_id)?
            .iter()
            .any(|(_, payload)| labdirector_requery_payload_has_hypothesis(payload));
    let has_completed_gate_labdirector_requery =
        completed_gate_labdirector_requery_exists(paths, cycle_id);
    let reasoning_gap_statements = reasoning_gap_hypothesis_statements(&plan_open_validation_gaps);
    let convergence_mode = plan
        .get("planner_summary")
        .and_then(|item| item.get("convergence_mode"))
        .and_then(Value::as_str)
        .unwrap_or("explore");
    let is_converging = convergence_mode == "focus" || convergence_mode == "converge";
    let has_pending_data_acquisition_action = ranked_actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("data_acquisition_followup")
            && action.get("preferred_role").and_then(Value::as_str) == Some("scout")
    });
    let external_validation_required = ranked_actions.iter().any(|action| {
        matches!(
            action.get("type").and_then(Value::as_str),
            Some("external_validation_followup") | Some("external_validation_analysis_followup")
        ) || action.get("target_rubric").and_then(Value::as_str) == Some("external_validity")
    });
    let gate_independence_required = ranked_actions.iter().any(|action| {
        action.get("target_rubric").and_then(Value::as_str) == Some("gate_independence")
    });
    let gate_closure_ready = hypothesis_gate_closure_ready(paths, cycle_id)?;
    let completed_chronicle_gate_deliberation =
        completed_chronicle_gate_deliberation_exists(paths, cycle_id);
    // The Chronicle deliberation this defers to cannot start until a data scout
    // has completed (dependency_gates_01: waiting-for-data-scout-before-kg), and
    // the data-acquisition action that would complete one is exactly what the
    // deferral drops.
    //
    // MEASURED ON cycle-b-20260918, 2026-09-18. The literature search finally
    // completed with 27 papers, and the cycle then sat with every core lane
    // pending: chronicle waiting for a data scout, lab-director waiting for
    // chronicle, analyst waiting for the hypothesis lab-director never wrote,
    // while the planner's data_acquisition_followup was dropped here every pass.
    let no_completed_data_scout = completed_data_scout_count(paths, cycle_id)? < 1;
    let gate_reject_requires_chronicle_first =
        explicit_hypothesis_gate_failed(paths, cycle_id)? && !completed_chronicle_gate_deliberation;
    inject_gate_reject_followup_actions(paths, cycle_id, &mut ranked_actions)?;
    inject_latest_executable_analyst_handoff_action(paths, cycle_id, &mut ranked_actions)?;
    let completed_labdirector_methods_handoff_present =
        append_completed_labdirector_next_actions(paths, cycle_id, &mut ranked_actions)?;
    let pending_chronicle_prerequisite =
        pending_labdirector_chronicle_prerequisite(paths, cycle_id)?;
    // MEASURED ON cycle-a-20260919, 2026-10-08: owner_selection had
    // accumulated 1,021 finished lanes. A live falsification release merely
    // relaxed old wait filters; it did not put the LabDirector replacement
    // decision in the queue, so a ready handoff and repeated reviews kept
    // running after the selected method was retired.
    let falsification_replacement =
        active_lead_falsification_replacement_action(paths, cycle_id);
    let falsification_replacement_required = falsification_replacement.is_some();
    if let Some(action) = falsification_replacement {
        ranked_actions.push(action);
    }
    push_runner_post_run_gate_actions(paths, cycle_id, &mut ranked_actions)?;
    if let Some(action) = active_conclusion_strategy_requery_action(paths, cycle_id)? {
        ranked_actions.push(action);
    }
    ranked_actions.sort_by(|a, b| {
        followup_action_sort_key(a, external_validation_required, gate_closure_ready)
            .cmp(&followup_action_sort_key(
                b,
                external_validation_required,
                gate_closure_ready,
            ))
            .then_with(|| {
                b.get("priority_score")
                    .and_then(Value::as_i64)
                    .cmp(&a.get("priority_score").and_then(Value::as_i64))
            })
    });
    let analyst_handoff_action_pending = ranked_actions.iter().any(|action| {
        matches!(
            action.get("brief_id").and_then(Value::as_str),
            Some("analyst-handoff")
                | Some("analyst-handoff-artifact")
                | Some("analyst-handoff-review")
                | Some("analyst-handoff-review-revision")
        ) || action
            .get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .starts_with("analyst-handoff-revision")
            || action
                .get("brief_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .starts_with("labdirector-runner-recovery")
    });
    let zero_candidate_data_attempts = zero_candidate_data_acquisition_attempts(paths, cycle_id);
    let data_acquisition_query_blocked = zero_candidate_data_attempts >= 12
        && cycle_fetched_data_bundles(paths, cycle_id).is_empty();
    let scout_materialization_recovery =
        latest_scout_discovery_without_materialization_summary(paths, cycle_id, 3);

    let role_availability = FollowupRoleAvailabilityContext {
        external_validation_required,
        gate_independence_required,
        data_acquisition_query_blocked,
        has_pending_data_acquisition_action,
        existing_followup_counts: &existing_followup_counts,
        existing_action_counts: &existing_action_counts,
        open_action_counts: &open_action_counts,
        existing_total_followups,
        total_followup_cap,
        pass_budget_by_role: &pass_budget_by_role,
        document_stage_authorized: document_stage_authorized(paths, cycle_id),
        latest_handoff_served: latest_executable_analyst_handoff_served(paths, cycle_id)?,
    };
    let role_available = |role: &str,
                          action_type: &str,
                          created_by_role: &HashMap<String, usize>,
                          created_by_action: &HashMap<String, usize>|
     -> bool {
        followup_role_available(
            &role_availability,
            role,
            action_type,
            created_by_role,
            created_by_action,
        )
    };
    let plan_ctx = DispatchPlanContext {
        objective: &objective,
        convergence_mode,
        candidate_hypotheses: &plan_candidate_hypotheses,
        schema_quality: &plan_schema_quality,
        reasoning_graph: &plan_reasoning_graph,
        data_graph: &plan_data_graph,
        open_validation_gaps: &plan_open_validation_gaps,
    };

    if !analyst_handoff_action_pending {
        // FIX-AD: when a forced data-materialization fail-closed pivot is active,
        // dispatch the pivot BEFORE runner-recovery. Otherwise the runner-recovery
        // requery lanes claim the single lab-director lane slot each pass and keep
        // upholding the unmaterializable lead, starving the forced pivot.
        let forced_failclosed_pivot_active = {
            let strategy_path =
                state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
            strategy_path.exists() && {
                let strategy = read_json(&strategy_path).unwrap_or(Value::Null);
                strategy.get("mode").and_then(Value::as_str) == Some("pivot")
                    && strategy.get("source").and_then(Value::as_str)
                        == Some("scout_materialization_failclosed")
            }
        };

        if forced_failclosed_pivot_active {
            dispatch_pivot_followups(
                paths,
                cycle_id,
                max_new_lanes,
                &plan_ctx,
                &role_availability,
                stage_gate_blocks_pivot,
                external_validation_required,
                analyst_handoff_action_pending,
                completed_labdirector_methods_handoff_present,
                &selected_hypotheses,
                &ranked_hypotheses,
                &reasoning_gap_statements,
                &scout_materialization_recovery,
                &existing_action_counts,
                &mut created,
                &mut existing_signatures,
                &mut created_by_role,
                &mut created_by_action,
            )?;
        }

        dispatch_recovery_followups(
            paths,
            cycle_id,
            max_new_lanes,
            &plan_ctx,
            &role_availability,
            external_validation_required,
            &completed_action_counts,
            &existing_action_counts,
            &mut created,
            &mut existing_signatures,
            &mut created_by_role,
            &mut created_by_action,
        )?;

        if !forced_failclosed_pivot_active {
            dispatch_pivot_followups(
                paths,
                cycle_id,
                max_new_lanes,
                &plan_ctx,
                &role_availability,
                stage_gate_blocks_pivot,
                external_validation_required,
                analyst_handoff_action_pending,
                completed_labdirector_methods_handoff_present,
                &selected_hypotheses,
                &ranked_hypotheses,
                &reasoning_gap_statements,
                &scout_materialization_recovery,
                &existing_action_counts,
                &mut created,
                &mut existing_signatures,
                &mut created_by_role,
                &mut created_by_action,
            )?;
        }

        if ranked_hypotheses.is_empty() && ranked_actions.is_empty() {
            return Ok(created);
        }

        dispatch_ranked_hypothesis_followups(
            paths,
            cycle_id,
            max_new_lanes,
            &plan_ctx,
            &role_availability,
            external_validation_required,
            &selected_hypotheses,
            &ranked_hypotheses,
            &mut created,
            &mut existing_signatures,
            &mut created_by_role,
            &mut created_by_action,
        )?;
    } else if ranked_actions.is_empty() {
        return Ok(created);
    }

    let current_hypothesis_accessions = current_hypothesis_geo_accessions(paths, cycle_id);
    let mut assigned_selected_hypotheses = if convergence_mode == "explore" {
        Vec::new()
    } else {
        selected_hypotheses
            .iter()
            .filter_map(|item| item.get("statement").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };
    for statement in reasoning_gap_statements.iter() {
        if !assigned_selected_hypotheses.contains(statement) {
            assigned_selected_hypotheses.push(statement.clone());
        }
    }
    assigned_selected_hypotheses.truncate(6);

    for action in ranked_actions {
        if created.len() >= max_new_lanes {
            break;
        }
        let brief_id = action
            .get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("brief");
        let description = action
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("follow up on Chronicle recommendation");
        let action_type = action
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("followup_experiment");
        // MEASURED ON cycle-a-20260919, 2026-10-03: the current
        // director explicitly deferred for Chronicle evidence, yet five gate
        // restart decisions ran first and reproduced the same defer decision.
        // A gate decision cannot consume evidence that has not run yet.
        // MEASURED ON cycle-a-20260919, 2026-10-07: Runner-188
        // validly retired the selected method, but that method's older
        // defer_for_chronicle request still filtered every LabDirector action.
        // Only the director can choose the required replacement, so a newer
        // typed falsification release supersedes prerequisites of the dead lead.
        if pending_chronicle_prerequisite.is_some()
            && !falsification_replacement_required
            && matches!(
                action_type,
                "gate_restart_followup"
                    | "lab_director_requery_followup"
                    | "independent_gate_review_followup"
                    | "hypothesis_followup"
            )
        {
            continue;
        }
        let direct_analyst_handoff_runner =
            action_type == "methods_followup" && brief_id.starts_with("analyst-handoff");
        let runner_recovery_action = action_type == "lab_director_requery_followup"
            && brief_id.starts_with("labdirector-runner-recovery-");
        if matches!(
            action_type,
            "analyst_handoff_review_followup"
                | "methods_followup"
                | "runner_scientific_recovery_followup"
                | "runner_result_interpretation_followup"
        ) && !direct_analyst_handoff_runner
            && !value_targets_current_geo(&action, &current_hypothesis_accessions)
        {
            continue;
        }
        if gate_reject_requires_chronicle_first
            && action
                .get("falsification_replacement_required")
                .and_then(Value::as_bool)
                != Some(true)
            && action_type != "chronicle_gate_deliberation_followup"
            // Data acquisition is what unblocks that deliberation, so deferring it
            // to the deliberation closes a loop nothing can leave.
            && !(action_type == "data_acquisition_followup" && no_completed_data_scout)
        {
            let recovery_reason = action
                .get("recovery_reason")
                .and_then(Value::as_str)
                .unwrap_or("");
            let is_gate_reject_recovery = brief_id.starts_with("hypothesis-gate-")
                || recovery_reason.starts_with("hypothesis_gate_failed")
                || action_type.starts_with("hypothesis_regeneration")
                || matches!(
                    action_type,
                    "gate_restart_followup"
                        | "lab_director_requery_followup"
                        | "methods_followup"
                        | "data_acquisition_followup"
                );
            if is_gate_reject_recovery && !direct_analyst_handoff_runner {
                continue;
            }
        }
        let target_rubric = action
            .get("target_rubric")
            .and_then(Value::as_str)
            .unwrap_or("");
        let requested_preferred_role = action
            .get("preferred_role")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (preferred_role, analyst_handoff_required) =
            effective_preferred_role_for_action(action_type, requested_preferred_role, &action);
        if action_type == "chronicle_gate_deliberation_followup"
            && completed_chronicle_gate_deliberation
        {
            continue;
        }
        if action_type == "novelty_followup"
            && ["scout", "analyst", "lab-runner"].iter().any(|role| {
                completed_followup_action_source_key_exists(
                    &completed_source_keys,
                    role,
                    action_type,
                    brief_id,
                )
            })
        {
            continue;
        }
        let completed_labdirector_gate_restart_for_source =
            completed_followup_action_source_key_exists(
                &completed_source_keys,
                "lab-director",
                "gate_restart_followup",
                brief_id,
            );
        let description_lower = description.to_ascii_lowercase();
        let labdirector_gate_restart_is_rival_bookkeeping = action_type == "gate_restart_followup"
            && preferred_role == "lab-director"
            && brief_id.starts_with("followup-lab-director-")
            && (description_lower.contains("reframed rival")
                || description_lower.contains("benchmark-only"));
        if action_type == "gate_restart_followup"
            && preferred_role == "lab-director"
            && (completed_labdirector_gate_restart_for_source
                || labdirector_gate_restart_is_rival_bookkeeping)
        {
            continue;
        }
        if has_completed_gate_labdirector_requery
            && brief_id == "hypothesis-gate-literature-restart"
        {
            continue;
        }
        if matches!(
            action_type,
            "lab_director_requery_followup" | "gate_restart_followup"
        ) && brief_id == "hypothesis-gate-labdirector-requery"
            && completed_followup_action_source_key_exists(
                &completed_source_keys,
                preferred_role,
                action_type,
                brief_id,
            )
        {
            continue;
        }
        if let Some(required_source) = action
            .get("requires_completed_chronicle_evidence_request_from")
            .and_then(Value::as_str)
        {
            if !completed_chronicle_evidence_request_exists(paths, cycle_id, required_source) {
                continue;
            }
        }
        if matches!(
            action_type,
            "lab_director_requery_followup" | "gate_restart_followup"
        ) && brief_id == "hypothesis-gate-labdirector-requery"
            && action
                .get("requires_completed_chronicle_gate_deliberation")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && !completed_chronicle_gate_deliberation
        {
            continue;
        }
        let unresolved_conclusion_strategy_requery = action_type == "lab_director_requery_followup"
            && preferred_role == "lab-director"
            && target_rubric == "hypothesis_strategy"
            && conclusion_needs_hypothesis_strategy(paths, cycle_id)?;
        if action_type == "lab_director_requery_followup"
            && target_rubric != "gate_independence"
            && brief_id != "zero-nonfallback-hypotheses"
            && brief_id != "hypothesis-gate-labdirector-requery"
            && action
                .get("falsification_replacement_required")
                .and_then(Value::as_bool)
                != Some(true)
            && !unresolved_conclusion_strategy_requery
            && !runner_recovery_action
            && !brief_id.starts_with("chronicle-evidence-response-")
            && action.get("recovery_reason").and_then(Value::as_str)
                != Some("hypothesis_gate_failed_labdirector_requery_required")
            && has_completed_labdirector_requery
        {
            continue;
        }
        let gate_labdirector_requery_pending = open_action_counts
            .get("lab-director::lab_director_requery_followup")
            .copied()
            .unwrap_or(0)
            + open_action_counts
                .get("lab-director::gate_restart_followup")
                .copied()
                .unwrap_or(0)
            + created_by_action
                .get("lab-director::lab_director_requery_followup")
                .copied()
                .unwrap_or(0)
            + created_by_action
                .get("lab-director::gate_restart_followup")
                .copied()
                .unwrap_or(0)
            > 0;
        if action_type == "data_acquisition_followup"
            && brief_id == "hypothesis-gate-literature-restart"
            && gate_labdirector_requery_pending
            // Those director lanes wait for Chronicle, Chronicle waits for a
            // completed data scout, and this is the action that completes one.
            && !no_completed_data_scout
        {
            continue;
        }
        let action_candidate_payload = action
            .get("candidate_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| plan_candidate_hypotheses.clone());
        let action_challenge_questions = action
            .get("challenge_questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let action_candidate_statements = if action_candidate_payload.is_empty() {
            reasoning_gap_statements.clone()
        } else {
            let mut statements = candidate_hypothesis_statements(
                &json!({ "candidate_hypotheses": action_candidate_payload.clone() }),
            );
            for gap in reasoning_gap_statements.iter() {
                if !statements.contains(gap) {
                    statements.push(gap.clone());
                }
            }
            statements.truncate(8);
            statements
        };
        let mut gate_challenge_scope = assigned_selected_hypotheses.clone();
        for question in action_challenge_questions.iter() {
            if !gate_challenge_scope.contains(question) {
                gate_challenge_scope.push(question.clone());
            }
        }
        if gate_challenge_scope.is_empty() {
            gate_challenge_scope = action_candidate_statements.clone();
        }
        gate_challenge_scope.truncate(8);

        if action_type.starts_with("hypothesis_regeneration") {
            if created.len() < max_new_lanes
                && role_available("scout", action_type, &created_by_role, &created_by_action)
            {
                let attempt = next_action_attempt("scout", action_type, &created_by_action);
                let scout_description = format!(
                    "{description} Use reasoning-graph gaps and current data-graph coverage to propose new, higher-impact, data-verifiable hypothesis families before broad literature expansion. [attempt {attempt}]"
                );
                let scout_task_body = followup_task_markdown(
                    cycle_id,
                    &objective,
                    "scout",
                    brief_id,
                    &scout_description,
                    &action_candidate_statements,
                );
                let scout_signature = followup_task_signature(&scout_task_body);
                if !existing_signatures.contains(&scout_signature) {
                    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
                    let contract_path = create_lane_contract(
                        paths,
                        cycle_id,
                        &lane_id,
                        "scout",
                        "external-driver",
                        "driver-exec",
                        &scout_task_body,
                    )?;
                    let role_plan_path = write_followup_role_plan(
                        paths,
                        cycle_id,
                        &lane_id,
                        "scout",
                        assigned_model_for_role("scout", "external-driver"),
                        &objective,
                        brief_id,
                        &scout_description,
                        action_type,
                        &action_candidate_statements,
                        &action_candidate_payload,
                        Some(&plan_schema_quality),
                        Some(&plan_reasoning_graph),
                        Some(&plan_data_graph),
                        &plan_open_validation_gaps,
                        json!({
                            "priority_source": "recommended_followup_action",
                            "preferred_role": "scout",
                            "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                            "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                            "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                            "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                            "novelty_mode": "regenerate-hypothesis-space",
                            "selection_scope": "open-regeneration",
                        }),
                    )?;
                    existing_signatures.insert(scout_signature);
                    *created_by_role.entry("scout".to_string()).or_insert(0) += 1;
                    *created_by_action
                        .entry(format!("{}::{}", "scout", action_type))
                        .or_insert(0) += 1;
                    created.push(json!({
                        "lane_id": lane_id,
                        "role": "scout",
                        "contract_path": contract_path,
                        "source_brief_id": brief_id,
                        "role_plan_path": role_plan_path,
                    }));
                }
            }
            if created.len() < max_new_lanes
                && role_available("analyst", action_type, &created_by_role, &created_by_action)
            {
                let attempt = next_action_attempt("analyst", action_type, &created_by_action);
                let analyst_description =
                    format!("synthesize replacement hypothesis families from reasoning-graph claims, open validation gaps, and data-graph coverage; rank them by impact and data-verifiability, and nominate one or two new lead hypotheses [attempt {attempt}]");
                let analyst_task_body = followup_task_markdown(
                    cycle_id,
                    &objective,
                    "analyst",
                    brief_id,
                    &analyst_description,
                    &action_candidate_statements,
                );
                let analyst_signature = followup_task_signature(&analyst_task_body);
                if !existing_signatures.contains(&analyst_signature) {
                    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-analyst-")?;
                    let contract_path = create_lane_contract(
                        paths,
                        cycle_id,
                        &lane_id,
                        "analyst",
                        "external-driver",
                        "driver-exec",
                        &analyst_task_body,
                    )?;
                    let role_plan_path = write_followup_role_plan(
                        paths,
                        cycle_id,
                        &lane_id,
                        "analyst",
                        assigned_model_for_role("analyst", "external-driver"),
                        &objective,
                        brief_id,
                        &analyst_description,
                        action_type,
                        &action_candidate_statements,
                        &action_candidate_payload,
                        Some(&plan_schema_quality),
                        Some(&plan_reasoning_graph),
                        Some(&plan_data_graph),
                        &plan_open_validation_gaps,
                        json!({
                            "priority_source": "recommended_followup_action",
                            "preferred_role": "analyst",
                            "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                            "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                            "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                            "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                            "novelty_mode": "regenerate-and-rerank-hypotheses",
                            "selection_scope": "open-regeneration",
                        }),
                    )?;
                    existing_signatures.insert(analyst_signature);
                    *created_by_role.entry("analyst".to_string()).or_insert(0) += 1;
                    *created_by_action
                        .entry(format!("{}::{}", "analyst", action_type))
                        .or_insert(0) += 1;
                    created.push(json!({
                        "lane_id": lane_id,
                        "role": "analyst",
                        "contract_path": contract_path,
                        "source_brief_id": brief_id,
                        "role_plan_path": role_plan_path,
                    }));
                }
            }
            continue;
        }

        // MEASURED ON cycle-a-20260919, 2026-09-30: eight
        // gate-restart actions explicitly asked for a gatekeeper, but this
        // branch consumed every one in the director/scout/analyst restart
        // fan-out. Let an independently assigned review reach the generic
        // gatekeeper dispatcher below.
        if action_type == "gate_restart_followup" && preferred_role != "gatekeeper" {
            let restart_scope = if action_candidate_statements.is_empty() {
                gate_challenge_scope.clone()
            } else {
                action_candidate_statements.clone()
            };
            dispatch_gate_restart_followups(
                paths,
                cycle_id,
                max_new_lanes,
                &plan_ctx,
                &role_availability,
                &existing_action_counts,
                &action,
                action_type,
                brief_id,
                description,
                target_rubric,
                requested_preferred_role,
                preferred_role,
                &restart_scope,
                &action_candidate_payload,
                &mut created,
                &mut existing_signatures,
                &mut created_by_role,
                &mut created_by_action,
            )?;
            continue;
        }

        if action_type == "data_acquisition_followup" {
            if created.len() < max_new_lanes
                && role_available("scout", action_type, &created_by_role, &created_by_action)
            {
                let attempt = next_action_attempt("scout", action_type, &created_by_action);
                let materialization_recovery = scout_materialization_recovery.clone();
                // Bound the materialization-recovery loop. When discovery keeps
                // succeeding but materialization never does (e.g. the data-graph
                // file is missing so the scout driver can't append), the
                // recovery signal stays Some forever and a new data_acquisition
                // followup is created every pass — which keeps `created_followups`
                // non-empty and prevents run_loop's terminal-stagnation bound
                // (which requires created_followups.is_empty()) from ever firing,
                // i.e. the cycle livelocks. After enough completed recovery
                // rounds with no materialization progress, stop creating recovery
                // fetch lanes so the cycle can terminate (or be re-bootstrapped)
                // instead of churning. Env-tunable; genuine progress resets the
                // signal to None upstream so the bound only bites a true stall.
                if materialization_recovery.is_some() {
                    let recovery_rounds = completed_action_counts
                        .get("scout::data_acquisition_followup")
                        .copied()
                        .unwrap_or(0);
                    let max_recovery_rounds =
                        std::env::var("RESEARCHLAB_MATERIALIZATION_RECOVERY_MAX_ROUNDS")
                            .ok()
                            .and_then(|raw| raw.trim().parse::<usize>().ok())
                            .filter(|value| *value > 0)
                            .unwrap_or(6);
                    if recovery_rounds >= max_recovery_rounds {
                        continue;
                    }
                }
                let action_requests_materialization = target_rubric
                    == "validation_materialization_gate"
                    || brief_id == "stage-gate-validation-materialization"
                    || action
                        .get("fetch_policy")
                        .and_then(Value::as_str)
                        .is_some_and(|policy| {
                            matches!(policy, "fetch" | "materialize" | "required")
                        });
                let materialization_fetch_required =
                    action_requests_materialization || materialization_recovery.is_some();
                let signature_description = if materialization_fetch_required {
                    format!(
                        "{description} Materialize/fetch the best open accession-bearing candidates into cycle-scoped dataset bundles; do not return another discovery-only pass when accession candidates already exist."
                    )
                } else {
                    format!(
                        "{description} Search for new open datasets that can extend or challenge the active hypothesis set, infer source capabilities, normalize the most promising bundle, and make it available for the next validation pass."
                    )
                };
                let scout_description = format!("{signature_description} [attempt {attempt}]");
                let scout_task_body = followup_task_markdown(
                    cycle_id,
                    &objective,
                    "scout",
                    brief_id,
                    &scout_description,
                    &assigned_selected_hypotheses,
                );
                let scout_signature = slugify(&followup_task_markdown(
                    cycle_id,
                    &objective,
                    "scout",
                    brief_id,
                    &signature_description,
                    &assigned_selected_hypotheses,
                ));
                if !existing_signatures.contains(&scout_signature) {
                    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
                    let contract_path = create_lane_contract(
                        paths,
                        cycle_id,
                        &lane_id,
                        "scout",
                        "external-driver",
                        "driver-exec",
                        &scout_task_body,
                    )?;
                    let role_plan_path = write_followup_role_plan(
                        paths,
                        cycle_id,
                        &lane_id,
                        "scout",
                        assigned_model_for_role("scout", "external-driver"),
                        &objective,
                        brief_id,
                        &scout_description,
                        action_type,
                        &assigned_selected_hypotheses,
                        &action_candidate_payload,
                        Some(&plan_schema_quality),
                        Some(&plan_reasoning_graph),
                        Some(&plan_data_graph),
                        &plan_open_validation_gaps,
                        json!({
                            "priority_source": "recommended_followup_action",
                            "preferred_role": "scout",
                            "target_rubric": if materialization_fetch_required { json!("validation_materialization_gate") } else if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                            "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                            "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                            "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                            "source_discovery_mode": if materialization_fetch_required { json!("validation-materialization-fetch") } else { json!("expand-open-data-search") },
                            "source_selection_strategy": if materialization_fetch_required { json!("validation-target-driven") } else { json!("semantic-target-driven") },
                            "fetch_policy": if materialization_fetch_required { json!("fetch") } else { action.get("fetch_policy").cloned().unwrap_or(Value::Null) },
                            "materialization_recovery": materialization_recovery.unwrap_or(Value::Null),
                            "dataset_discovery_contract": action.get("dataset_discovery_contract").cloned().unwrap_or_else(|| dataset_discovery_contract(&objective)),
                            "forbidden_dataset_terms": forbidden_dataset_terms_from_text(&objective),
                            "selection_scope": if materialization_fetch_required { json!("materialize-discovered-accessions") } else { json!("hypothesis-conditioned-data-search") },
                        }),
                    )?;
                    existing_signatures.insert(scout_signature);
                    *created_by_role.entry("scout".to_string()).or_insert(0) += 1;
                    *created_by_action
                        .entry(format!("{}::{}", "scout", action_type))
                        .or_insert(0) += 1;
                    created.push(json!({
                        "lane_id": lane_id,
                        "role": "scout",
                        "contract_path": contract_path,
                        "source_brief_id": brief_id,
                        "role_plan_path": role_plan_path,
                    }));
                }
            }
            continue;
        }

        // MEASURED ON cycle-a-20260919, 2026-09-30: the protected
        // lead waited at reproduction_anchor while repeated novelty actions
        // requested an independent gatekeeper adjudication. The novelty
        // fan-out silently replaced that role with scout/analyst work, so the
        // gate round needed to release the hold could never run.
        if preferred_role != "gatekeeper"
            && dispatch_novelty_followups(
                paths,
                cycle_id,
                max_new_lanes,
                &plan_ctx,
                &role_availability,
                &existing_action_counts,
                &action,
                action_type,
                brief_id,
                description,
                target_rubric,
                is_converging,
                &assigned_selected_hypotheses,
                &action_candidate_statements,
                &action_candidate_payload,
                &mut created,
                &mut existing_signatures,
                &mut created_by_role,
                &mut created_by_action,
            )?
        {
            continue;
        }

        let (preferred_dispatch_role, preferred_runtime_class, preferred_mode, preferred_prefix) =
            if preferred_role == "gatekeeper" {
                (
                    "gatekeeper",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-gatekeeper-",
                )
            } else if preferred_role == "lab-director" {
                (
                    "lab-director",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-lab-director-",
                )
            } else if preferred_role == "analyst"
                && action_type == "runner_result_interpretation_followup"
            {
                (
                    "analyst",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-analyst-",
                )
            } else if preferred_role == "scout"
                || preferred_role == "analyst"
                || should_route_to_literature_analyst(preferred_role, action_type, description)
            {
                (
                    if preferred_role == "scout" {
                        "scout"
                    } else {
                        "analyst"
                    },
                    // Followup SCOUTS and ANALYSTS are now reasoning codex-agents:
                    // scouts author their own literature/dataset queries and
                    // finalize via the driver; analysts design the validation
                    // handoff (dataset_profile / validation_targets / handoff_checks
                    // / validation_code_blueprints) by reasoning.
                    "codex-agent",
                    "read-write-scoped",
                    if preferred_role == "scout" {
                        "followup-scout-"
                    } else {
                        "followup-analyst-"
                    },
                )
            } else if preferred_role == "chronicle" {
                (
                    "chronicle",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-chronicle-",
                )
            } else if preferred_role == "author"
                // An engineer's brief may mention a report or a draft; the role
                // it asked for is not an author's.
                || (preferred_role != "engineer"
                    && (description.contains("report") || description.contains("draft")))
            {
                (
                    "author",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-author-",
                )
            } else if preferred_role == "engineer" {
                // Without this branch an engineer request falls through to the
                // final else and is dispatched as a lab-runner under an engineer
                // lane id -- the silent misroute this chain has produced before.
                // It is a codex-agent and not an external-driver because there is
                // no provisioning driver to run: reading a build failure and
                // deciding what prerequisite is missing is the work.
                (
                    "engineer",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-engineer-",
                )
            } else if preferred_role == "illustrator" || action_type.contains("visualization") {
                (
                    "illustrator",
                    "codex-agent",
                    "read-write-scoped",
                    "followup-illustrator-",
                )
            } else {
                (
                    "lab-runner",
                    "external-driver",
                    "driver-exec",
                    "followup-runner-",
                )
            };
        let analyst_methods_repair_must_stay_analyst = preferred_dispatch_role == "analyst"
            && requested_preferred_role == "analyst"
            && matches!(
                action_type,
                "methods_followup"
                    | "accuracy_followup"
                    | "external_validation_analysis_followup"
                    | "baseline_confounder_waiver_followup"
            )
            && !direct_analyst_handoff_runner;
        let analyst_repair_must_stay_analyst = gate_blocking_execution_recovery_action(&action)
            || analyst_methods_repair_must_stay_analyst;
        let analyst_budget_blocked = preferred_dispatch_role == "analyst"
            && !analyst_repair_must_stay_analyst
            && !role_available("analyst", action_type, &created_by_role, &created_by_action);
        if analyst_budget_blocked && (analyst_handoff_required || analyst_handoff_action_pending) {
            continue;
        }
        let (role, runtime_class, mode, prefix) = if analyst_budget_blocked {
            analyst_fallback_role(action_type, description)
        } else {
            (
                preferred_dispatch_role,
                preferred_runtime_class,
                preferred_mode,
                preferred_prefix,
            )
        };
        let direct_handoff_runner_action =
            matches!(brief_id, "analyst-handoff" | "analyst-handoff-artifact");
        if analyst_handoff_action_pending && role == "lab-runner" && !direct_handoff_runner_action {
            continue;
        }
        let selected_scope_hypotheses = if action_type == "lab_director_requery_followup"
            && brief_id.starts_with("labdirector-runner-recovery")
            && !action_candidate_statements.is_empty()
        {
            action_candidate_statements.clone()
        } else if action_type == "lab_director_requery_followup"
            || action_type == "independent_gate_review_followup"
            || action_type == "gate_restart_followup"
            || action_type == "labdirector_comparator_validation_followup"
        {
            gate_challenge_scope.clone()
        } else if action_type == "runner_scientific_recovery_followup"
            && !action_candidate_statements.is_empty()
        {
            action_candidate_statements.clone()
        } else if action_type.starts_with("hypothesis_regeneration") {
            action_candidate_statements.clone()
        } else {
            assigned_selected_hypotheses.clone()
        };
        if action_type == "chronicle_evidence_request_followup" {
            let action_statement_value = json!({
                "description": description,
                "candidate_hypotheses": action_candidate_statements.clone(),
            });
            if !value_mentions_current_geo(&action_statement_value, &current_hypothesis_accessions)
            {
                continue;
            }
        }
        // One engineer lane per simulation order while the order still needs
        // one. An open lane is caught by the role availability check, and a
        // finished lane that wrote the ordered outputs settles the order --
        // re-running it changes nothing. A finished lane that wrote nothing is
        // an attempt, and the order's own attempt accounting (which is what
        // collects this action at all) decides whether a successor goes out.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-01
        // ended `completed` with neither episodes.csv nor a blocker. The attempt
        // accounting asked for a second engineer, but this guard read the
        // finished lane as the order's answer and dropped the action on every
        // pass, so the cycle held the milestone `reproduction_anchor` for nine
        // hours with no data while 203 review actions ran against it.
        if action_type == SIMULATION_DATA_GENERATION_ACTION
            && action
                .get("simulation_order")
                .map(|order| simulation_order_outputs_current(paths, cycle_id, order))
                .unwrap_or(true)
            && completed_followup_action_source_key_exists(
                &completed_source_keys,
                role,
                action_type,
                brief_id,
            )
        {
            continue;
        }
        if action_type == "runner_scientific_recovery_followup"
            && completed_followup_action_source_key_exists(
                &completed_source_keys,
                role,
                action_type,
                brief_id,
            )
        {
            continue;
        }
        if role == "gatekeeper"
            && action_type == "independent_gate_review_followup"
            && open_independent_gate_review_for_rubric(paths, cycle_id, target_rubric)?
        {
            continue;
        }
        let gate_blocking_analyst_repair = role == "analyst"
            && action_type == "methods_followup"
            && gate_blocking_execution_recovery_action(&action);
        let analyst_repair_stays_analyst = role == "analyst" && analyst_repair_must_stay_analyst;
        let role_action_available = if analyst_repair_stays_analyst {
            let action_key = format!("{role}::{action_type}");
            open_action_counts.get(&action_key).copied().unwrap_or(0)
                + created_by_action.get(&action_key).copied().unwrap_or(0)
                == 0
        } else {
            role_available(role, action_type, &created_by_role, &created_by_action)
        };
        let attempt = next_action_attempt(role, action_type, &created_by_action);
        let description_with_attempt = format!("{description} [attempt {attempt}]");
        let task_body = followup_task_markdown(
            cycle_id,
            &objective,
            role,
            brief_id,
            &description_with_attempt,
            &selected_scope_hypotheses,
        );
        let signature = followup_task_signature(&task_body);
        let duplicate_signature =
            existing_signatures.contains(&signature) && !unresolved_conclusion_strategy_requery;
        let duplicate_is_retryable_direct_handoff_runner = duplicate_signature
            && direct_handoff_runner_action
            && direct_handoff_runner_retry_allowed(paths, cycle_id, &action)?;
        let duplicate_is_retryable_focused_gatekeeper = duplicate_signature
            && focused_gatekeeper_retry_allowed(paths, cycle_id, role, action_type, target_rubric)?;
        // A gate-required document blocker may be retried while it stands.
        //
        // The signature is role + brief + description, and a document blocker's
        // description IS the finding. While the manuscript changed every round
        // the descriptions changed with it and sixteen author lanes ran; once the
        // findings settled into the same three, every later pass produced an
        // identical signature and was skipped. The blockers stayed, the author was
        // never asked again, and the cycle halted with the paper frozen.
        //
        // Same exception the gatekeeper already has for a rubric still pending.
        // `role_action_available` stays in the condition, so this permits a RETRY,
        // never a second lane beside the first.
        let duplicate_is_retryable_document_blocker = duplicate_signature
            && matches!(role, "author" | "illustrator")
            && action
                .get("required_for_gate")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && role_action_available
            && document_stage_authorized(paths, cycle_id);
        // The ordered simulation may be attempted again while the order still
        // has no data. A task signature deliberately ignores its `[attempt N]`
        // marker, so every successor engineer for one order is a duplicate by
        // construction -- the same shape as the runner and gatekeeper retries
        // above, and `role_action_available` still permits only one open lane.
        // The order's attempt cap ends it.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-21. The attempt
        // accounting asked for a second engineer on every pass for nine hours
        // and this check discarded each one, so the approved experiment was
        // never run and the cycle reviewed a hypothesis with no data.
        let duplicate_is_retryable_simulation_order = duplicate_signature
            && action_type == SIMULATION_DATA_GENERATION_ACTION
            && role_action_available
            && !action
                .get("simulation_order")
                .map(|order| simulation_order_outputs_current(paths, cycle_id, order))
                .unwrap_or(true);
        if duplicate_signature
            && !duplicate_is_retryable_direct_handoff_runner
            && !duplicate_is_retryable_focused_gatekeeper
            && !duplicate_is_retryable_document_blocker
            && !duplicate_is_retryable_simulation_order
            || (!direct_handoff_runner_action && !runner_recovery_action && !role_action_available)
        {
            continue;
        }
        let lane_id = next_followup_lane_id(paths, cycle_id, prefix)?;
        let contract_path = create_lane_contract(
            paths,
            cycle_id,
            &lane_id,
            role,
            runtime_class,
            mode,
            &task_body,
        )?;
        let role_plan_path = write_followup_role_plan(
            paths,
            cycle_id,
            &lane_id,
            role,
            assigned_model_for_role(role, runtime_class),
            &objective,
            brief_id,
            &description_with_attempt,
            action_type,
            &selected_scope_hypotheses,
            &action_candidate_payload,
            Some(&plan_schema_quality),
            Some(&plan_reasoning_graph),
            Some(&plan_data_graph),
            &plan_open_validation_gaps,
            {
            let mut planner_metadata = json!({
                "priority_source": "recommended_followup_action",
                "preferred_role": preferred_role,
                "requested_preferred_role": requested_preferred_role,
                "effective_role": role,
                "analyst_handoff_required": analyst_handoff_required,
                "runner_handoff_required": analyst_handoff_required && requested_preferred_role == "lab-runner",
                "lab_director_action_rerouted_to_analyst": analyst_handoff_required && requested_preferred_role == "lab-director",
                "analyst_budget_blocked": analyst_budget_blocked,
                "gate_blocking_analyst_repair": gate_blocking_analyst_repair,
                "analyst_repair_stays_analyst": analyst_repair_stays_analyst,
                "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                "review_standard": action.get("review_standard").cloned().unwrap_or(Value::Null),
                "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                "impact_first_hypothesis_mandate": action.get("impact_first_hypothesis_mandate").cloned().unwrap_or(Value::Null),
                "hypothesis_generation_policy": action.get("hypothesis_generation_policy").cloned().unwrap_or(Value::Null),
                "blocker_reasons": if role == "gatekeeper" { json!([]) } else { action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])) },
                "review_action": if role == "gatekeeper" {
                    json!({
                        "type": action.get("type").cloned().unwrap_or(Value::Null),
                        "target_rubric": action.get("target_rubric").cloned().unwrap_or(Value::Null),
                        "candidate_hypotheses": action.get("candidate_hypotheses").cloned().unwrap_or_else(|| json!([])),
                        "validation_results": action.get("validation_results").cloned().unwrap_or(Value::Null),
                        "latest_validation_lane_id": action.get("latest_validation_lane_id").cloned().unwrap_or(Value::Null),
                        "latest_validation_summary": action.get("latest_validation_summary").cloned().unwrap_or(Value::Null),
                        "reference_literature_summary": action.get("reference_literature_summary").cloned().unwrap_or(Value::Null),
                        "previous_review_summary": action.get("previous_review_summary").cloned().unwrap_or(Value::Null),
                        "review_mode": action.get("review_mode").cloned().unwrap_or(Value::Null),
                        "lab_director_blocker_review_requests": action.get("lab_director_blocker_review_requests").cloned().unwrap_or_else(|| json!([])),
                        "lab_director_response_lane_id": action.get("lab_director_response_lane_id").cloned().unwrap_or(Value::Null),
                        "impact_first_hypothesis_mandate": action.get("impact_first_hypothesis_mandate").cloned().unwrap_or(Value::Null),
                        "hypothesis_generation_policy": action.get("hypothesis_generation_policy").cloned().unwrap_or(Value::Null),
                    })
                } else {
                    action.clone()
                },
                "validation_results": action.get("validation_results").cloned().unwrap_or(Value::Null),
                "latest_validation_lane_id": action.get("latest_validation_lane_id").cloned().unwrap_or(Value::Null),
                "latest_validation_summary": action.get("latest_validation_summary").cloned().unwrap_or(Value::Null),
                "failed_runner_context": action.get("failed_runner_context").cloned().unwrap_or(Value::Null),
                // The LabDirector's order an engineer lane runs -- see
                // simulation_execution_directive.
                "simulation_order": action.get("simulation_order").cloned().unwrap_or(Value::Null),
                "simulation_output_csv": action.get("simulation_output_csv").cloned().unwrap_or(Value::Null),
                "simulation_output_manifest": action.get("simulation_output_manifest").cloned().unwrap_or(Value::Null),
                // The lane whose result an audit lane was opened for -- see
                // engineer_execution_audit_directive. Without it the audit had
                // only the prose description to find its target in.
                "audit_target": action.get("audit_target").cloned().unwrap_or(Value::Null),
                "open_source_agent_requirement": action.get("open_source_agent_requirement").cloned().unwrap_or(Value::Null),
                "reference_literature_summary": action.get("reference_literature_summary").cloned().unwrap_or(Value::Null),
                "previous_review_summary": action.get("previous_review_summary").cloned().unwrap_or(Value::Null),
                "review_mode": action.get("review_mode").cloned().unwrap_or(Value::Null),
                "lab_director_blocker_review_requests": action.get("lab_director_blocker_review_requests").cloned().unwrap_or_else(|| json!([])),
                "lab_director_response_lane_id": action.get("lab_director_response_lane_id").cloned().unwrap_or(Value::Null),
                "analysis_request": action.get("analysis_request").cloned().unwrap_or(Value::Null),
                "reference_request": action.get("reference_request").cloned().unwrap_or(Value::Null),
                "figure_production_request": action.get("figure_production_request").cloned().unwrap_or(Value::Null),
                "validation_plan": action.get("validation_plan").cloned().unwrap_or(Value::Null),
                "validation_objective": action.get("validation_objective").cloned().unwrap_or(Value::Null),
                "challenge_questions": action.get("challenge_questions").cloned().unwrap_or_else(|| json!([])),
                "brainstorm_frame": action.get("brainstorm_frame").cloned().unwrap_or(Value::Null),
                "brainstorm_question": action.get("brainstorm_question").cloned().unwrap_or(Value::Null),
                "selection_scope": if action_type.starts_with("hypothesis_regeneration") {
                    "open-regeneration"
                } else if selected_scope_hypotheses.is_empty() {
                    "open"
                } else {
                    "selected_hypotheses_only"
                },
            });
            // What the analysts asked for, for the LabDirector lane opened to
            // decide on it -- see collect_analysis_proposal_decision_actions.
            // Set here rather than in the literal above: that literal is at
            // serde_json's macro recursion limit, and one more key stops the
            // crate compiling.
            planner_metadata["analysis_proposals"] =
                action.get("analysis_proposals").cloned().unwrap_or(Value::Null);
            // Preserve the dispatch-time lead identity for the JS gate
            // aggregator; without it prose overlap can revive stale reviews.
            // Set outside json!: that literal is at serde_json's recursion limit.
            planner_metadata["gate_review_lead_key"] =
                action.get("gate_review_lead_key").cloned().unwrap_or(Value::Null);
            planner_metadata["falsification_replacement_required"] = action
                .get("falsification_replacement_required")
                .cloned()
                .unwrap_or(json!(false));
            planner_metadata
            },
        )?;
        existing_signatures.insert(signature);
        *created_by_role.entry(role.to_string()).or_insert(0) += 1;
        *created_by_action
            .entry(format!("{role}::{action_type}"))
            .or_insert(0) += 1;
        created.push(json!({
            "lane_id": lane_id,
            "role": role,
            "contract_path": contract_path,
            "source_brief_id": brief_id,
            "role_plan_path": role_plan_path,
        }));
    }

    Ok(created)
}

#[cfg(test)]
mod failed_literature_recovery_dispatch_tests {
    use super::*;
    use tempfile::TempDir;

    fn test_paths(runtime_root: &Path) -> AppPaths {
        AppPaths {
            project_root: runtime_root.parent().unwrap_or(runtime_root).to_path_buf(),
            runtime_root: runtime_root.to_path_buf(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        }
    }

    fn assert_failed_literature_recovery_dispatch(action_type: &str, cycle_id: &str) {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle_id}-cycle-plan.json")),
            &json!({"objective": "Review literature evidence for a bounded hypothesis."}),
        )
        .unwrap();

        let source_lane_id = "analyst-literature-01";
        create_lane_contract(
            &paths,
            cycle_id,
            source_lane_id,
            "analyst",
            "external-driver",
            "driver-exec",
            "collect literature",
        )
        .unwrap();
        let source_dir = lane_root(&paths, cycle_id, source_lane_id);
        let source_role_plan = source_dir.join("role-plan.json");
        let review_queue = source_dir.join("abstract-review-queue.json");
        write_json(
            &source_dir.join("final-status.json"),
            &json!({"lane_id": source_lane_id, "status": "failed"}),
        )
        .unwrap();
        write_json(
            &source_dir.join("result.json"),
            &json!({
                "status": "pending_review",
                "failure_category": "literature_abstract_review_required",
                "recommended_actions": [{
                    "type": action_type,
                    "priority": "high",
                    "preferred_role": "scout",
                    "runtime_class": "codex-agent",
                    "source_lane_id": source_lane_id,
                    "literature_review_source_dir": source_dir,
                    "literature_review_role_plan_path": source_role_plan,
                    "literature_review_queue_path": review_queue,
                    "description": "Resume the saved abstract review queue."
                }]
            }),
        )
        .unwrap();

        let mut recovered_actions = Vec::new();
        collect_failed_literature_recovery_actions(&paths, cycle_id, &mut recovered_actions)
            .unwrap();
        assert_eq!(recovered_actions.len(), 1, "{recovered_actions:?}");
        let created = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        let recovery = created
            .iter()
            .find(|lane| {
                lane.get("role").and_then(Value::as_str) == Some("scout")
                    && lane.get("source_brief_id").and_then(Value::as_str)
                        == Some(source_lane_id)
            })
            .unwrap_or_else(|| {
                let plan = read_json(&labdirector_plan_path(&paths, cycle_id)).unwrap();
                panic!(
                    "failed literature action should dispatch a Scout; created={created:?}; actions={:?}",
                    plan["priority_actions"]
                )
            });
        let contract = read_json(Path::new(
            recovery
                .get("contract_path")
                .and_then(Value::as_str)
                .unwrap(),
        ))
        .unwrap();
        assert_eq!(contract["runtime_class"], "codex-agent");
        let role_plan = read_json(Path::new(
            recovery
                .get("role_plan_path")
                .and_then(Value::as_str)
                .unwrap(),
        ))
        .unwrap();
        assert_eq!(role_plan["action_type"], action_type);
        assert_eq!(
            role_plan["planner_metadata"]["review_action"]["source_lane_id"],
            source_lane_id
        );
        assert_eq!(
            role_plan["planner_metadata"]["review_action"]["literature_review_source_dir"],
            json!(source_dir)
        );

        let second = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        assert!(!second.iter().any(|lane| {
            lane.get("source_brief_id").and_then(Value::as_str) == Some(source_lane_id)
        }));
    }

    #[test]
    fn a_literature_resume_that_keeps_ending_the_same_way_is_not_offered_again() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "identical-resume-failures";
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        let write_resume = |lane_id: &str, paper_count: u64| {
            create_lane_contract(
                &paths, cycle_id, lane_id, "scout", "codex-agent", "read-write-scoped", "resume search",
            )
            .unwrap();
            let dir = lane_root(&paths, cycle_id, lane_id);
            write_json(&dir.join("role-plan.json"), &json!({"action_type": "adaptive_search_followup"})).unwrap();
            write_json(&dir.join("final-status.json"), &json!({"lane_id": lane_id, "status": "failed"})).unwrap();
            write_json(
                &dir.join("result.json"),
                &json!({
                    "status": "insufficient_corpus",
                    "failure_category": "adaptive_literature_search_incomplete",
                    "paper_count": paper_count,
                    "search_agent_assessment": {"errors": ["round_1_source_not_scalar", "journal_research_problem_mismatch"]},
                    "recommended_actions": [{
                        "type": "adaptive_search_followup",
                        "priority": "high",
                        "source_lane_id": lane_id,
                    }],
                }),
            )
            .unwrap();
        };

        write_resume("followup-scout-01", 3);
        write_resume("followup-scout-02", 3);
        let mut actions = Vec::new();
        collect_failed_literature_recovery_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 2, "two identical outcomes may still be retried");

        write_resume("followup-scout-03", 3);
        let mut actions = Vec::new();
        collect_failed_literature_recovery_actions(&paths, cycle_id, &mut actions).unwrap();
        assert!(actions.is_empty(), "the third identical outcome kept resuming: {actions:?}");

        // A resume that moved the corpus is progress, and is offered again.
        write_resume("followup-scout-04", 9);
        let mut actions = Vec::new();
        collect_failed_literature_recovery_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!(actions[0]["source_lane_id"], "followup-scout-04");
    }

    #[test]
    fn literature_recovery_uses_only_the_newest_checkpoint_in_a_lineage() {
        // MEASURED ON cycle-a-20260919, 2026-09-20. Three failed
        // Scouts replayed followup-scout-11 instead of continuing from the
        // newest failed recovery, so every pass started from stale evidence.
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "newest-literature-recovery-checkpoint";
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        let write_failure = |lane_id: &str,
                             action_type: &str,
                             source_brief_id: Option<&str>,
                             completed_at: &str| {
            create_lane_contract(
                &paths,
                cycle_id,
                lane_id,
                "scout",
                "codex-agent",
                "read-write-scoped",
                "resume search",
            )
            .unwrap();
            let dir = lane_root(&paths, cycle_id, lane_id);
            let mut role_plan = json!({"action_type": action_type});
            if let Some(source) = source_brief_id {
                role_plan["source_brief_id"] = json!(source);
            }
            write_json(&dir.join("role-plan.json"), &role_plan).unwrap();
            write_json(
                &dir.join("final-status.json"),
                &json!({
                    "lane_id": lane_id,
                    "status": "failed",
                    "completed_at": completed_at,
                }),
            )
            .unwrap();
            write_json(
                &dir.join("result.json"),
                &json!({
                    "status": "insufficient_corpus",
                    "failure_category": "adaptive_literature_search_incomplete",
                    "paper_count": 1,
                    "search_agent_assessment": {"errors": [format!("gap:{lane_id}")]},
                    "recommended_actions": [{
                        "type": "adaptive_search_followup",
                        "priority": "high",
                        "source_lane_id": lane_id,
                    }],
                }),
            )
            .unwrap();
        };

        write_failure(
            "followup-scout-11",
            "external_validation_followup",
            None,
            "2026-09-20T00:00:00Z",
        );
        for (lane_id, completed_at) in [
            ("followup-scout-16", "2026-09-20T00:10:00Z"),
            ("followup-scout-19", "2026-09-20T00:20:00Z"),
            ("followup-scout-22", "2026-09-20T00:30:00Z"),
        ] {
            write_failure(
                lane_id,
                "adaptive_search_followup",
                Some("followup-scout-11"),
                completed_at,
            );
        }

        let mut actions = Vec::new();
        collect_failed_literature_recovery_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "stale checkpoints were re-offered: {actions:?}");
        assert_eq!(actions[0]["source_lane_id"], "followup-scout-22");
    }

    #[test]
    fn failed_literature_recovery_reaches_a_source_bound_codex_scout_once() {
        for (action_type, cycle_id) in [
            (
                "adaptive_search_followup",
                "failed-adaptive-search-recovery-dispatch",
            ),
            (
                "abstract_review_followup",
                "failed-abstract-review-recovery-dispatch",
            ),
        ] {
            assert_failed_literature_recovery_dispatch(action_type, cycle_id);
        }
    }
    // cycle-b-20260918: the engineer who would run the simulator was never
    // dispatched. The LabDirector's simulation order now opens exactly one codex
    // engineer lane carrying the order.
    #[test]
    fn a_director_simulation_order_reaches_one_codex_engineer_lane() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "simulation-order-dispatch";
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle_id}-cycle-plan.json")),
            &json!({"objective": "Measure grasp success under friction in simulation."}),
        )
        .unwrap();
        let csv = format!(".research-lab/datasets/{cycle_id}/simulations/grasp_sweep/episodes.csv");
        record_lab_director_simulation_orders(
            &paths,
            cycle_id,
            "followup-lab-director-01",
            &json!({"simulation_orders": [{"request_id": "grasp_sweep", "simulator_backend": "mujoco", "output_path": csv}]}),
        )
        .unwrap();

        let created = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        let engineers: Vec<&Value> = created
            .iter()
            .filter(|lane| lane.get("role").and_then(Value::as_str) == Some("engineer"))
            .collect();
        assert_eq!(engineers.len(), 1, "created={created:?}");
        let lane = engineers[0];
        assert!(lane["lane_id"].as_str().unwrap().starts_with("followup-engineer-"));
        assert_eq!(lane["source_brief_id"], "simulation-grasp_sweep");
        let contract = read_json(Path::new(lane["contract_path"].as_str().unwrap())).unwrap();
        assert_eq!(contract["runtime_class"], "codex-agent");
        let role_plan = read_json(Path::new(lane["role_plan_path"].as_str().unwrap())).unwrap();
        assert_eq!(role_plan["action_type"], SIMULATION_DATA_GENERATION_ACTION);
        assert_eq!(role_plan["planner_metadata"]["simulation_order"]["request_id"], "grasp_sweep");

        let second = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        assert!(
            !second.iter().any(|lane| lane.get("role").and_then(Value::as_str) == Some("engineer")),
            "a second engineer for the same order: {second:?}"
        );
    }

    // cycle-a-20260919: followup-engineer-01 ended `completed` with
    // neither the ordered episodes.csv nor a blocker, and no engineer was ever
    // sent again. A finished lane that wrote nothing is an attempt; the order's
    // attempt cap, not the lane's status, ends the order.
    #[test]
    fn an_engineer_that_finished_without_the_ordered_data_gets_a_successor() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "simulation-order-retry";
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle_id}-cycle-plan.json")),
            &json!({"objective": "Measure grasp success under friction in simulation."}),
        )
        .unwrap();
        let csv = format!(".research-lab/datasets/{cycle_id}/simulations/grasp_sweep/episodes.csv");
        record_lab_director_simulation_orders(
            &paths,
            cycle_id,
            "followup-lab-director-01",
            &json!({"simulation_orders": [{"request_id": "grasp_sweep", "simulator_backend": "mujoco", "output_path": csv}]}),
        )
        .unwrap();

        let finish_without_data = |created: &[Value]| {
            let lane_id = created
                .iter()
                .find(|lane| lane.get("role").and_then(Value::as_str) == Some("engineer"))
                .and_then(|lane| lane.get("lane_id").and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| panic!("no engineer lane in {created:?}"));
            write_json(
                &lane_root(&paths, cycle_id, &lane_id).join("final-status.json"),
                &json!({"status": "completed"}),
            )
            .unwrap();
            lane_id
        };

        let first = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        let first_lane = finish_without_data(&first);
        let second = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        let second_lane = finish_without_data(&second);
        assert_ne!(first_lane, second_lane);

        // Two attempts are the cap: the blocker is the director's to answer.
        // An engineer may still be opened to AUDIT what those attempts produced;
        // what must not reappear is another attempt at the order itself.
        let third = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        assert!(
            !third.iter().any(|lane| {
                lane.get("source_brief_id").and_then(Value::as_str) == Some("simulation-grasp_sweep")
            }),
            "a third engineer past the attempt cap: {third:?}"
        );
    }

    // cycle-a-20260919: the self-healer returns a retryable failed
    // lane to pending by renaming its final-status.json aside. On a cycle large
    // enough to use the cached index, the index still said `failed` -- so
    // nothing re-ran the lane, while the order read the empty lane directory and
    // waited on it forever.
    #[test]
    fn a_lane_the_self_healer_emptied_is_read_from_the_cycle_index() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "simulation-order-self-healed";
        fs::create_dir_all(plans_root(&paths)).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle_id}-cycle-plan.json")),
            &json!({"objective": "Measure grasp success under friction in simulation."}),
        )
        .unwrap();
        let csv = format!(".research-lab/datasets/{cycle_id}/simulations/grasp_sweep/episodes.csv");
        record_lab_director_simulation_orders(
            &paths,
            cycle_id,
            "followup-lab-director-01",
            &json!({"simulation_orders": [{"request_id": "grasp_sweep", "simulator_backend": "mujoco", "output_path": csv}]}),
        )
        .unwrap();

        let first = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        let lane_id = first
            .iter()
            .find(|lane| lane.get("role").and_then(Value::as_str) == Some("engineer"))
            .and_then(|lane| lane.get("lane_id").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| panic!("no engineer lane in {first:?}"));
        // The self-healer leaves the lane directory with no status of its own.
        assert!(!lane_root(&paths, cycle_id, &lane_id).join("final-status.json").exists());
        // The index only takes over on a cycle large enough for it, which is
        // exactly the condition the incident needed: 414 lanes.
        let mut lane_statuses = vec![json!({"lane_id": lane_id, "role": "engineer", "status": "failed"})];
        for index in 0..40 {
            lane_statuses.push(json!({
                "lane_id": format!("followup-scout-{index:02}"),
                "role": "scout",
                "status": "completed",
            }));
        }
        write_json(
            &state_root(&paths).join(format!("{cycle_id}-cycle-run-state.json")),
            &json!({"cycle_id": cycle_id, "lane_statuses": lane_statuses}),
        )
        .unwrap();

        let second = dispatch_followup_lanes(&paths, cycle_id, 4).unwrap();
        assert!(
            second.iter().any(|lane| lane.get("role").and_then(Value::as_str) == Some("engineer")),
            "the order kept waiting on a lane the index says is finished: {second:?}"
        );
    }
}
