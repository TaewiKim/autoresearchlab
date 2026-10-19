#![allow(unused_imports)]
use super::*;

pub(crate) fn dispatch_gate_restart_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    existing_action_counts: &HashMap<String, usize>,
    action: &Value,
    action_type: &str,
    brief_id: &str,
    description: &str,
    target_rubric: &str,
    requested_preferred_role: &str,
    preferred_role: &str,
    restart_scope: &[String],
    action_candidate_payload: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    if preferred_role == "lab-director"
        && created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "lab-director",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "lab-director",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        // Ledger gate (owner option D): every restart lane — whether the action
        // came from the JS gate review or was synthesized by the Rust
        // hypothesis-gate flow — is created HERE, so this is the one choke
        // point where a ledger DENY can actually stop the "restart from
        // scratch" instruction from reaching a director.
        let ledger_deny = ledger_denies_pivot(paths, cycle_id);
        let director_description = match ledger_deny.as_deref() {
            Some(deny_reason) => format!(
                "A gate restart was requested, but the progress ledger DENIES a pivot this round.{clause} Treat the gate objections in the scope list as the binding constraints to close ON THE PROTECTED LEAD, and write the exact validation handoff that closes them. [attempt {attempt}]",
                clause = ledger_keep_refining_clause(deny_reason)
            ),
            None => format!(
                "{description} Make the restart decision directly as LabDirector: select one promotable family, demote literature-only claims, and write the exact validation handoff required before any document-stage work resumes. [attempt {attempt}]"
            ),
        };
        let director_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-director",
            brief_id,
            &director_description,
            restart_scope,
        );
        let director_signature = followup_task_signature(&director_task_body);
        if !existing_signatures.contains(&director_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-lab-director-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                "codex-agent",
                "read-write-scoped",
                &director_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                assigned_model_for_role("lab-director", "codex-agent"),
                plan_ctx.objective,
                brief_id,
                &director_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "lab-director",
                    "requested_preferred_role": requested_preferred_role,
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    // Under a ledger deny the lane refines the protected lead in
                    // place; the restart-mode mandates would contradict that.
                    "restart_mode": if ledger_deny.is_some() { "lab-director-keep-refining" } else { "lab-director-gate-restart" },
                    "ledger_pivot_deny": match &ledger_deny { Some(reason) => json!(reason), None => Value::Null },
                    "must_select_one_promotable_family": ledger_deny.is_none(),
                    "must_demote_literature_only_claims": ledger_deny.is_none(),
                    "must_emit_validation_handoff_before_document_stage": true,
                    "selection_scope": "gatekeeper-objection-conditioned",
                }),
            )?;
            existing_signatures.insert(director_signature);
            *created_by_role
                .entry("lab-director".to_string())
                .or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "lab-director", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "lab-director",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    if created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "scout",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "scout",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        // In explore mode the role plan carries NO lead -- dispatch.rs empties
        // assigned_selected_hypotheses there on purpose, because explore means do
        // not pin the search to the incumbent. Telling this scout to "overturn the
        // current lead" therefore names something it was never given: v85 ran 112
        // explore passes, 21 of 45 scout lanes had no hypotheses at all, and the
        // same gate-restart action was redispatched up to attempt 26.
        let scout_description = if plan_ctx.convergence_mode == "explore" {
            format!(
                "{description} Search the problem space WIDE, not the incumbent: look for hypothesis families this cycle has not tried, measurement designs its instruments can support, and results that would make a different family the obvious lead. Do not anchor on the current lead -- you are not given it, and that is deliberate. [attempt {attempt}]"
            )
        } else {
            format!(
                "{description} Restart from the gatekeeper's objections by searching for stronger competing hypothesis families, sharper falsification targets, and literature that can overturn the current lead. [attempt {attempt}]"
            )
        };
        let scout_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "scout",
            brief_id,
            &scout_description,
            restart_scope,
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
                plan_ctx.objective,
                brief_id,
                &scout_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "scout",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "novelty_mode": "gate-restart-regeneration",
                    "selection_scope": "gate-restart-open-search",
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
        && followup_role_available(
            role_availability,
            "analyst",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "analyst",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let analyst_description = format!(
            "restart the hypothesis set from the gatekeeper critique, synthesize replacement lead hypotheses, and rank them by novelty, falsifiability, and data-verifiability [attempt {attempt}]"
        );
        let analyst_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "analyst",
            brief_id,
            &analyst_description,
            restart_scope,
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
                plan_ctx.objective,
                brief_id,
                &analyst_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "analyst",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "novelty_mode": "gate-restart-rerank",
                    "selection_scope": "gatekeeper-objection-conditioned",
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

    if created.len() < max_new_lanes
        && !explicit_hypothesis_gate_failed(paths, cycle_id)?
        && followup_role_available(
            role_availability,
            "lab-runner",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "lab-runner",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let runner_description = format!(
            "run a fresh validation pass on replacement hypotheses implied by the gatekeeper critique, emphasizing stronger confound control, rival tests, and falsification checks [attempt {attempt}]"
        );
        let runner_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-runner",
            brief_id,
            &runner_description,
            restart_scope,
        );
        let runner_signature = followup_task_signature(&runner_task_body);
        if !existing_signatures.contains(&runner_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-runner-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "lab-runner",
                "external-driver",
                "driver-exec",
                &runner_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "lab-runner",
                assigned_model_for_role("lab-runner", "external-driver"),
                plan_ctx.objective,
                brief_id,
                &runner_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "lab-runner",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "validation_mode": "gate-restart-fresh-pass",
                    "selection_scope": "replacement-hypothesis-validation",
                }),
            )?;
            existing_signatures.insert(runner_signature);
            *created_by_role.entry("lab-runner".to_string()).or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "lab-runner", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "lab-runner",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    Ok(())
}
