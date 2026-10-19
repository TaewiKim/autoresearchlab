#![allow(unused_imports)]
use super::*;

pub(crate) fn collect_gate_review_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<(Vec<String>, Vec<String>)> {
    let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    let mut gate_objection_texts: Vec<String> = Vec::new();
    let mut gate_alternative_hypotheses: Vec<String> = Vec::new();
    if gate_review_path.exists() {
        let gate_review = read_json(&gate_review_path)?;
        gate_objection_texts = gate_review
            .get("major_objections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .chain(
                gate_review
                    .get("missing_validations")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            )
            .chain(
                gate_review
                    .get("challenge_questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            )
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        gate_alternative_hypotheses = gate_review
            .get("better_alternative_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                item.get("statement")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>();
        let mut gate_actions = gate_review
            .get("recommended_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        gate_actions.extend(
            gate_review
                .get("recommended_followup_actions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        let mut seen_gate_actions = Vec::new();
        for action in gate_actions {
            let action_type = action
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("gate_followup");
            let target_rubric = action
                .get("target_rubric")
                .and_then(Value::as_str)
                .unwrap_or("");
            let preferred_role = action
                .get("preferred_role")
                .and_then(Value::as_str)
                .unwrap_or("gatekeeper");
            let review_mode = action
                .get("review_mode")
                .and_then(Value::as_str)
                .unwrap_or("");
            let action_key =
                format!("{preferred_role}::{action_type}::{target_rubric}::{review_mode}");
            if seen_gate_actions.iter().any(|item| item == &action_key) {
                continue;
            }
            seen_gate_actions.push(action_key);
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("independent gate follow-up action");
            let priority_score = match action
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or("medium")
            {
                // Once the conclusion gate is eligible, an independent
                // gatekeeper review is the critical path. Keep it ahead of
                // generic pivot/regeneration followups so gate closure is
                // actually attempted instead of endlessly spawning side work.
                "high" => 145,
                "medium" => 118,
                _ => 86,
            };
            let focused_gatekeeper_review =
                action_type == "independent_gate_review_followup" && !target_rubric.is_empty();
            let gate_blocking_execution_recovery = gate_blocking_execution_recovery_action(&action);
            let priority_score = if gate_blocking_execution_recovery {
                320
            } else if focused_gatekeeper_review {
                246
            } else {
                priority_score
            };
            let priority = if focused_gatekeeper_review || gate_blocking_execution_recovery {
                json!("critical")
            } else {
                action
                    .get("priority")
                    .cloned()
                    .unwrap_or_else(|| json!("medium"))
            };
            let brief_id = if gate_blocking_execution_recovery {
                let rubric_slug = if target_rubric.is_empty() {
                    "execution-recovery".to_string()
                } else {
                    format!("{target_rubric}-execution-recovery")
                };
                format!("gate-review-{rubric_slug}")
            } else if focused_gatekeeper_review {
                format!("gate-review-{target_rubric}")
            } else {
                "gate-review".to_string()
            };
            priority_actions.push(json!({
                "brief_id": brief_id,
                "description": description,
                "type": action.get("type").cloned().unwrap_or_else(|| json!("gate_followup")),
                "priority": priority,
                "priority_score": priority_score,
                "preferred_role": action.get("preferred_role").cloned().unwrap_or_else(|| json!("gatekeeper")),
                "target_rubric": action.get("target_rubric").cloned().unwrap_or(Value::Null),
                // MEASURED ON cycle-a-20260919, 2026-10-04: the JS
                // gate stamped this key, but this copy dropped it, so reviews
                // of retired leads remained active after a director pivot.
                "gate_review_lead_key": action.get("gate_review_lead_key").cloned().unwrap_or(Value::Null),
                "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                "gate_closure_goal": action.get("gate_closure_goal").cloned().unwrap_or(Value::Null),
                "avoid_redundant_work": action.get("avoid_redundant_work").cloned().unwrap_or(Value::Null),
                "validation_results": action.get("validation_results").cloned().unwrap_or(Value::Null),
                "latest_validation_lane_id": action.get("latest_validation_lane_id").cloned().unwrap_or(Value::Null),
                "latest_validation_summary": action.get("latest_validation_summary").cloned().unwrap_or(Value::Null),
                "failed_runner_context": action.get("failed_runner_context").cloned().unwrap_or(Value::Null),
                "open_source_agent_requirement": action.get("open_source_agent_requirement").cloned().unwrap_or(Value::Null),
                "expected_artifacts": action.get("expected_artifacts").cloned().unwrap_or_else(|| json!([])),
                "repository_workflow_exhausted": action.get("repository_workflow_exhausted").cloned().unwrap_or(Value::Null),
                "repository_workflow_repetition": action.get("repository_workflow_repetition").cloned().unwrap_or(Value::Null),
                "recovery_protocol": action.get("recovery_protocol").cloned().unwrap_or(Value::Null),
                "review_standard": action.get("review_standard").cloned().unwrap_or(Value::Null),
                "reference_literature_summary": action.get("reference_literature_summary").cloned().unwrap_or(Value::Null),
                "previous_review_summary": action.get("previous_review_summary").cloned().unwrap_or(Value::Null),
                "review_mode": action.get("review_mode").cloned().unwrap_or(Value::Null),
                "lab_director_blocker_review_requests": action.get("lab_director_blocker_review_requests").cloned().unwrap_or_else(|| json!([])),
                "lab_director_response_lane_id": action.get("lab_director_response_lane_id").cloned().unwrap_or(Value::Null),
                "impact_first_hypothesis_mandate": action.get("impact_first_hypothesis_mandate").cloned().unwrap_or(Value::Null),
                "hypothesis_generation_policy": action.get("hypothesis_generation_policy").cloned().unwrap_or(Value::Null),
                "gate_blocking_recovery": gate_blocking_execution_recovery,
                "gate_blocking_recovery_reason": if gate_blocking_execution_recovery { json!("repository_native_workflow_or_waiver_missing") } else { Value::Null },
                "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                "candidate_hypotheses": action.get("candidate_hypotheses").cloned().unwrap_or_else(|| json!([])),
                "schema_quality": action.get("schema_quality").cloned().unwrap_or(Value::Null),
                "reasoning_graph": action.get("reasoning_graph").cloned().unwrap_or(Value::Null),
                "data_graph": action.get("data_graph").cloned().unwrap_or(Value::Null),
                "open_validation_gaps": action.get("open_validation_gaps").cloned().unwrap_or_else(|| json!([])),
                "challenge_questions": action.get("challenge_questions").cloned().unwrap_or_else(|| json!([])),
                "previous_review_context": action
                    .get("previous_review_context")
                    .cloned()
                    .or_else(|| gate_review.get("previous_review_context").cloned())
                    .or_else(|| {
                        gate_review
                            .get("gate_reviewer_context")
                            .and_then(|item| item.get("previous_review_context"))
                            .cloned()
                    })
                    .unwrap_or(Value::Null),
                "chronicle_research_context": action
                    .get("chronicle_research_context")
                    .cloned()
                    .or_else(|| gate_review.get("chronicle_research_context").cloned())
                    .or_else(|| {
                        gate_review
                            .get("gate_reviewer_context")
                            .and_then(|item| item.get("chronicle_research_context"))
                            .cloned()
                    })
                    .unwrap_or(Value::Null),
                "gate_reviewer_context": action
                    .get("gate_reviewer_context")
                    .cloned()
                    .or_else(|| gate_review.get("gate_reviewer_context").cloned())
                    .unwrap_or(Value::Null),
            }));
            gate_objection_texts.extend(
                action
                    .get("blocker_reasons")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string)),
            );
        }
    }
    gate_objection_texts.sort();
    gate_objection_texts.dedup();
    Ok((gate_objection_texts, gate_alternative_hypotheses))
}
