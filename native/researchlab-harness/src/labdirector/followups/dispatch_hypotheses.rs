#![allow(unused_imports)]
use super::*;

pub(crate) fn dispatch_ranked_hypothesis_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    external_validation_required: bool,
    selected_hypotheses: &[Value],
    ranked_hypotheses: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let mut hypothesis_chunk: Vec<(String, String)> = Vec::new();
    if external_validation_required {
        return Ok(());
    }
    for item in ranked_hypotheses {
        if created.len() >= max_new_lanes {
            break;
        }
        let brief_id = item
            .get("source_brief_ids")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("source_briefs")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
            })
            .unwrap_or("brief")
            .to_string();
        let statement = item
            .get("statement")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if statement.is_empty() {
            continue;
        }
        hypothesis_chunk.push((brief_id, statement));
        if hypothesis_chunk.len() >= 1 {
            dispatch_hypothesis_chunk(
                paths,
                cycle_id,
                plan_ctx,
                role_availability,
                selected_hypotheses,
                &mut hypothesis_chunk,
                created,
                existing_signatures,
                created_by_role,
                created_by_action,
            )?;
        }
    }
    if !hypothesis_chunk.is_empty() && created.len() < max_new_lanes {
        dispatch_hypothesis_chunk(
            paths,
            cycle_id,
            plan_ctx,
            role_availability,
            selected_hypotheses,
            &mut hypothesis_chunk,
            created,
            existing_signatures,
            created_by_role,
            created_by_action,
        )?;
    }
    Ok(())
}

pub(crate) fn dispatch_hypothesis_chunk(
    paths: &AppPaths,
    cycle_id: &str,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    selected_hypotheses: &[Value],
    hypothesis_chunk: &mut Vec<(String, String)>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let source_brief_id = hypothesis_chunk
        .first()
        .map(|item| item.0.as_str())
        .unwrap_or("brief");
    let statements = hypothesis_chunk
        .iter()
        .map(|item| item.1.clone())
        .collect::<Vec<_>>();
    let description =
        format!("evaluate and update prioritized hypotheses from Chronicle plan {source_brief_id}");
    let task_body = followup_task_markdown(
        cycle_id,
        plan_ctx.objective,
        "lab-runner",
        source_brief_id,
        &description,
        &statements,
    );
    let signature = followup_task_signature(&task_body);
    if !existing_signatures.contains(&signature)
        && followup_role_available(
            role_availability,
            "lab-runner",
            "hypothesis_followup",
            created_by_role,
            created_by_action,
        )
    {
        let lane_id = next_followup_lane_id(paths, cycle_id, "followup-runner-")?;
        let contract_path = create_lane_contract(
            paths,
            cycle_id,
            &lane_id,
            "lab-runner",
            "external-driver",
            "driver-exec",
            &task_body,
        )?;
        let role_plan_path = write_followup_role_plan(
            paths,
            cycle_id,
            &lane_id,
            "lab-runner",
            assigned_model_for_role("lab-runner", "external-driver"),
            plan_ctx.objective,
            source_brief_id,
            &description,
            "hypothesis_followup",
            &statements,
            &[],
            Some(plan_ctx.schema_quality),
            Some(plan_ctx.reasoning_graph),
            Some(plan_ctx.data_graph),
            plan_ctx.open_validation_gaps,
            json!({
                "priority_source": "chronicle-plan",
                "chunk_size": statements.len(),
                "narrowing_mode": if selected_hypotheses.is_empty() {
                    "top-supported-hypotheses"
                } else {
                    "selected-top-hypotheses"
                },
            }),
        )?;
        existing_signatures.insert(signature);
        *created_by_role.entry("lab-runner".to_string()).or_insert(0) += 1;
        created.push(json!({
            "lane_id": lane_id,
            "role": "lab-runner",
            "contract_path": contract_path,
            "source_brief_id": source_brief_id,
            "role_plan_path": role_plan_path,
        }));
    }
    hypothesis_chunk.clear();
    Ok(())
}
