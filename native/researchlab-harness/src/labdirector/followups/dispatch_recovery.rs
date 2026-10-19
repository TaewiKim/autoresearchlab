#![allow(unused_imports)]
use super::*;

pub(crate) fn dispatch_recovery_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    external_validation_required: bool,
    completed_action_counts: &HashMap<String, usize>,
    existing_action_counts: &HashMap<String, usize>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let lab_director_hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let needs_lab_director_hypothesis_recovery =
        !lab_director_hypothesis_is_usable(paths, cycle_id, &lab_director_hypothesis_path);
    let completed_data_acquisition = completed_action_counts
        .get("scout::data_acquisition_followup")
        .copied()
        .unwrap_or(0);
    let hypothesis_recovery_budget = completed_data_acquisition.saturating_div(5).max(1).min(16);
    let completed_hypothesis_recoveries = completed_action_counts
        .get("lab-director::hypothesis_generation_recovery")
        .copied()
        .unwrap_or(0);
    if (created.len() < max_new_lanes || needs_lab_director_hypothesis_recovery)
        && !external_validation_required
        && needs_lab_director_hypothesis_recovery
        && completed_hypothesis_recoveries < hypothesis_recovery_budget
        && followup_role_available(
            role_availability,
            "lab-director",
            "hypothesis_generation_recovery",
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "lab-director",
            "hypothesis_generation_recovery",
            existing_action_counts,
            created_by_action,
        );
        let recovery_description = format!(
            "Recover the missing LabDirector hypothesis artifact from Chronicle's literature_graph + data_graph. Do not scan broad directories. Read only current-cycle scoped graph artifacts, trend analysis, candidate dataset nodes, materialized_dataset_context/candidate_datasets when present, and same-dataset/reference-paper context. Select the best falsifiable, data-verifiable hypothesis first; if the validation bundle is not fetched yet, mark validation_data_status=needs_materialization and emit a concrete data_acquisition_followup instead of returning another empty restart. [attempt {attempt}]"
        );
        let task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-director",
            "missing_lab_director_hypothesis",
            &recovery_description,
            &[],
        );
        let signature = followup_task_signature(&task_body);
        if !existing_signatures.contains(&signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-lab-director-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                "codex-agent",
                "read-write-scoped",
                &task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                assigned_model_for_role("lab-director", "codex-agent"),
                plan_ctx.objective,
                "missing_lab_director_hypothesis",
                &recovery_description,
                "hypothesis_generation_recovery",
                &[],
                plan_ctx.candidate_hypotheses,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "missing_lab_director_hypothesis_recovery",
                    "preferred_role": "lab-director",
                    "effective_role": "lab-director",
                    "must_write_lab_director_hypothesis_artifact": true,
                    "hypothesis_artifact_path": lab_director_hypothesis_path,
                    "must_find_same_dataset_reference_papers_before_validation": true,
                    "must_extract_reference_analysis_methods_before_validation": true,
                    "hypothesis_generation_order": "literature_and_data_search -> KG generation -> hypothesis generation -> validation materialization/analysis",
                    "directory_scan_policy": "Do not list broad .research-lab/state directories; read only current-cycle scoped artifacts and role_plan context_refs.",
                }),
            )?;
            existing_signatures.insert(signature);
            *created_by_role
                .entry("lab-director".to_string())
                .or_insert(0) += 1;
            *created_by_action
                .entry("lab-director::hypothesis_generation_recovery".to_string())
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "lab-director",
                "contract_path": contract_path,
                "source_brief_id": "missing_lab_director_hypothesis",
                "role_plan_path": role_plan_path,
            }));
        }
    }

    if created.len() >= max_new_lanes
        || external_validation_required
        || !followup_role_available(
            role_availability,
            "analyst",
            "runner_failure_recovery_followup",
            created_by_role,
            created_by_action,
        )
    {
        return Ok(());
    }
    if let Some(runner_failure) = latest_failed_lab_runner_context(paths, cycle_id)? {
        let failed_lane_id = runner_failure
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or("lab-runner");
        let reason = runner_failure
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("validation code execution failed");
        let failure_description = format!(
            "inspect why lab-runner lane `{failed_lane_id}` failed, read failed_runner_context plus any selected open-source tool metadata, repair the validation specification, config, dependency, command, or code plan, and issue one revised analyst handoff that enables a successful rerun"
        );
        let failure_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "analyst",
            failed_lane_id,
            &failure_description,
            &[],
        );
        let failure_signature = followup_task_signature(&failure_task_body);
        if !existing_signatures.contains(&failure_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-analyst-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "analyst",
                "external-driver",
                "driver-exec",
                &failure_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "analyst",
                assigned_model_for_role("analyst", "external-driver"),
                plan_ctx.objective,
                failed_lane_id,
                &format!("{failure_description} (root cause: {reason})"),
                "runner_failure_recovery_followup",
                &[],
                &[],
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "failed_lab_runner",
                    "preferred_role": "analyst",
                    "effective_role": "analyst",
                    "failed_runner_context": runner_failure,
                    "runner_failure_debug_contract": {
                        "must_read_failed_runner_context": true,
                        "must_read_selected_open_source_tool_metadata": true,
                        "repair_order": [
                            "path_or_local_path",
                            "config_file",
                            "dependency_or_import",
                            "environment_variable",
                            "command_flag",
                            "dataset_schema_or_column_mapping",
                            "fallback_self_contained_blueprint"
                        ],
                        "must_record_debug_attempts": true,
                        "must_issue_revised_handoff": true,
                        "must_preserve_or_scientifically_reject_selected_open_source_agent": true
                    },
                }),
            )?;
            existing_signatures.insert(failure_signature);
            *created_by_role.entry("analyst".to_string()).or_insert(0) += 1;
            *created_by_action
                .entry("analyst::runner_failure_recovery_followup".to_string())
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "analyst",
                "contract_path": contract_path,
                "source_brief_id": failed_lane_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }
    Ok(())
}
