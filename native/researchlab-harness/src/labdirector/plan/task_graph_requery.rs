#![allow(unused_imports)]
use super::*;

// Collect LabDirector requery follow-up actions and replacement hypotheses.
// Extracted verbatim from rewrite_task_graph (task_graph.rs) to keep that file
// under the line budget; included into the labdirector module so all shared
// helpers and types resolve unchanged.
pub(crate) fn collect_labdirector_requery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
    hypothesis_index: &mut HashMap<String, Value>,
) -> Result<()> {
    for (lane_id, payload) in completed_labdirector_requery_payloads(paths, cycle_id)? {
        let replacement_hypotheses = payload
            .get("replacement_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let requery_decision = payload.get("requery_decision").and_then(Value::as_str);
        let decision_status = payload.get("decision_status").and_then(Value::as_str);
        let chronicle_requests = payload
            .get("chronicle_requests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next_actions = payload
            .get("next_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let labdirector_deferred_for_chronicle =
            decision_status == Some("needs_chronicle_evidence")
                || requery_decision == Some("defer_for_chronicle");
        // MEASURED ON cycle-a-20260919, 2026-10-06: four Chronicle
        // requests ran before the preceding novelty action had finalized the
        // 76-record review bundle they needed, so every request could only
        // report that the bundle was missing. Preserve the director's explicit
        // next_actions order before promoting its structured Chronicle request.
        let chronicle_prerequisites_completed = next_actions
            .iter()
            .position(|action| {
                action.get("type").and_then(Value::as_str)
                    == Some("chronicle_evidence_request_followup")
            })
            .is_none_or(|chronicle_index| {
                next_actions[..chronicle_index].iter().all(|action| {
                    let Some(action_type) = action.get("type").and_then(Value::as_str) else {
                        return true;
                    };
                    let role = action
                        .get("preferred_role")
                        .and_then(Value::as_str)
                        .unwrap_or("lab-director");
                    completed_followup_action_from_source_exists(
                        paths,
                        cycle_id,
                        role,
                        action_type,
                        &lane_id,
                    ) || completed_followup_action_from_source_exists(
                        paths,
                        cycle_id,
                        role,
                        action_type,
                        &format!("labdirector-next-action-{lane_id}"),
                    )
                })
            });
        let selected_hypothesis = payload.get("selected_hypothesis").cloned().filter(|item| {
            item.get("statement")
                .and_then(Value::as_str)
                .map(|statement| !statement.trim().is_empty())
                .unwrap_or(false)
        });
        let selected_or_replacement_hypotheses =
            if matches!(requery_decision, Some("uphold")) && selected_hypothesis.is_some() {
                vec![selected_hypothesis.clone().unwrap()]
            } else if replacement_hypotheses.is_empty() {
                selected_hypothesis.clone().into_iter().collect::<Vec<_>>()
            } else {
                replacement_hypotheses.clone()
            };
        for hypothesis in replacement_hypotheses.iter() {
            let statement = hypothesis
                .get("statement")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if statement.is_empty() {
                continue;
            }
            let key = slugify(&statement);
            let entry = hypothesis_index.entry(key).or_insert_with(|| {
                json!({
                    "statement": statement,
                    "priority_score": 125,
                    "support_count": 1,
                    "source_brief_ids": [lane_id.clone()],
                    "support_basis": ["lab-director-requery"],
                    "evidence_roles": ["lab-director"],
                    "evidence_quality_score": 80,
                    "why_selected": hypothesis.get("why_selected").cloned().unwrap_or(Value::Null),
                })
            });
            let current_priority = entry
                .get("priority_score")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if current_priority < 125 {
                entry["priority_score"] = json!(125);
            }
            let mut source_brief_ids = entry
                .get("source_brief_ids")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !source_brief_ids
                .iter()
                .any(|item| item.as_str() == Some(lane_id.as_str()))
            {
                source_brief_ids.push(json!(lane_id.clone()));
            }
            entry["source_brief_ids"] = json!(source_brief_ids);
        }

        for action in next_actions.iter().cloned() {
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("follow up on LabDirector requery decision");
            let action_type = action
                .get("type")
                .cloned()
                .unwrap_or_else(|| json!("lab_director_requery_followup"));
            // The structured chronicle_requests block below is the canonical
            // prerequisite. Do not also flatten its next_actions summary into
            // a second request with a different source key.
            if labdirector_deferred_for_chronicle
                && !chronicle_requests.is_empty()
                && action_type.as_str() == Some("chronicle_evidence_request_followup")
            {
                continue;
            }
            let preferred_role = action
                .get("preferred_role")
                .cloned()
                .unwrap_or_else(|| json!("lab-director"));
            let target_rubric = action.get("target_rubric").cloned().unwrap_or_else(|| {
                match action_type.as_str().unwrap_or("") {
                    "novelty_followup" => json!("novelty"),
                    "methods_followup" => json!("technical_quality"),
                    "accuracy_followup" => json!("reproducibility"),
                    "gate_restart_followup" | "hypothesis_followup" => {
                        json!("hypothesis_strategy")
                    }
                    _ => Value::Null,
                }
            });
            let gate_requery_action_priority = match preferred_role.as_str().unwrap_or("") {
                "scout" => 238,
                "analyst" => 236,
                "lab-runner" => 234,
                "lab-director" => 232,
                _ => 230,
            };
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": description,
                "type": action_type,
                "priority_score": gate_requery_action_priority,
                "preferred_role": preferred_role,
                "target_rubric": target_rubric,
                "target_score": action.get("target_score").cloned().unwrap_or_else(|| json!(95)),
                "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                "blocker_reasons": payload.get("validation_changes").cloned().unwrap_or_else(|| json!([])),
                "candidate_hypotheses": selected_or_replacement_hypotheses.clone(),
                "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
                "requery_rationale": payload.get("rationale").cloned().unwrap_or(Value::Null),
            }));
        }

        let validation_changes = payload
            .get("validation_changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let lead_requires_validation = matches!(requery_decision, Some("replace") | Some("uphold"))
            || decision_status == Some("final");
        if lead_requires_validation
            && !selected_or_replacement_hypotheses.is_empty()
            && !validation_changes.is_empty()
            && !completed_followup_action_from_source_exists(
                paths,
                cycle_id,
                "analyst",
                "labdirector_comparator_validation_followup",
                &lane_id,
            )
        {
            let validation_summary = validation_changes
                .iter()
                .filter_map(Value::as_str)
                .take(8)
                .collect::<Vec<_>>()
                .join("; ");
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": format!(
                    "Convert LabDirector's replacement decision into a comparator-aware Analyst validation handoff. Use the selected replacement hypothesis, real materialized dataset variables, same-dataset baseline, rival comparators, confounders, falsification checks, and transportability plan before any runner or gate re-entry: {validation_summary}"
                ),
                "type": "labdirector_comparator_validation_followup",
                "priority": "high",
                "priority_score": 244,
                "preferred_role": "analyst",
                "target_rubric": "technical_quality",
                "target_score": 95,
                "current_score": Value::Null,
                "blocker_reasons": validation_changes,
                "candidate_hypotheses": selected_or_replacement_hypotheses.clone(),
                "analysis_request": {
                    "source": "lab-director-replacement-comparator-validation",
                    "source_lab_director_lane_id": lane_id,
                    "selected_replacement_hypothesis": selected_or_replacement_hypotheses.first().cloned().unwrap_or(Value::Null),
                    "replacement_hypotheses": replacement_hypotheses.clone(),
                    "validation_changes": payload.get("validation_changes").cloned().unwrap_or_else(|| json!([])),
                    "required_outputs": [
                        "analysis-design-memo.json with schema-backed variables only",
                        "same-dataset baseline comparator map",
                        "rival family comparator plan",
                        "covariate/confounder adjustment plan",
                        "negative-control/permutation/falsification checks",
                        "transportability or explicit external-validation blocker plan"
                    ],
                    "forbidden_validation_modes": [
                        "topic-token/path-token validation",
                        "fallback runtime-token validation",
                        "runner execution without an executable Analyst handoff"
                    ]
                },
                "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
                "requery_rationale": payload.get("rationale").cloned().unwrap_or(Value::Null),
            }));
        }

        if labdirector_deferred_for_chronicle
            && !chronicle_requests.is_empty()
            && chronicle_prerequisites_completed
            && !completed_chronicle_evidence_request_exists(paths, cycle_id, &lane_id)
        {
            let bounded_requests = chronicle_requests
                .iter()
                .take(4)
                .cloned()
                .collect::<Vec<_>>();
            let priority_score = bounded_requests
                .iter()
                .map(|request| {
                    match request
                        .get("priority")
                        .and_then(Value::as_str)
                        .unwrap_or("high")
                    {
                        "critical" => 242,
                        "high" => 239,
                        "medium" => 228,
                        _ => 220,
                    }
                })
                .max()
                .unwrap_or(239);
            let question_summary = bounded_requests
                .iter()
                .enumerate()
                .map(|(idx, request)| {
                    let question = request
                    .get("question")
                    .and_then(Value::as_str)
                    .or_else(|| request.get("description").and_then(Value::as_str))
                    .unwrap_or("answer LabDirector's targeted evidence request")
                    .trim();
                    let why_needed = request
                    .get("why_needed_for_decision")
                    .and_then(Value::as_str)
                    .unwrap_or("LabDirector marked this clue as decision-relevant before final adjudication")
                    .trim();
                    format!("Q{}: {question}. Why needed: {why_needed}", idx + 1)
                })
                .collect::<Vec<_>>()
                .join(" | ");
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": format!("LabDirector asks Chronicle for targeted decision clues: {question_summary}"),
                "type": "chronicle_evidence_request_followup",
                "priority": "high",
                "priority_score": priority_score,
                "preferred_role": "chronicle",
                "target_rubric": "hypothesis_strategy",
                "target_score": 95,
                "current_score": Value::Null,
                "lab_director_question": bounded_requests.first().cloned().unwrap_or(Value::Null),
                "lab_director_questions": bounded_requests,
                "source_lab_director_lane_id": lane_id,
                "candidate_hypotheses": replacement_hypotheses.clone(),
                "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
                "requery_rationale": payload.get("rationale").cloned().unwrap_or(Value::Null),
            }));
        }
        if labdirector_deferred_for_chronicle && !chronicle_requests.is_empty() {
            priority_actions.push(json!({
                "brief_id": format!("chronicle-evidence-response-{lane_id}"),
                "description": "After Chronicle answers LabDirector's targeted evidence request, adjudicate the answer and either ask one sharper Chronicle follow-up or issue the final keep/replace/restart decision.",
                "type": "lab_director_requery_followup",
                "priority": "high",
                "priority_score": 237,
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "requires_completed_chronicle_evidence_request_from": lane_id,
                "candidate_hypotheses": replacement_hypotheses.clone(),
                "source_lab_director_lane_id": lane_id,
                "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
                "requery_rationale": payload.get("rationale").cloned().unwrap_or(Value::Null),
            }));
        }

        let required_validations = payload
            .get("required_validation_before_promotion")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !required_validations.is_empty() {
            let validation_summary = required_validations
                .iter()
                .filter_map(Value::as_str)
                .take(6)
                .collect::<Vec<_>>()
                .join("; ");
            let description = if validation_summary.is_empty() {
                "convert LabDirector promotion requirements into an executable analyst handoff, then run the resulting validation before promotion".to_string()
            } else {
                format!(
                    "convert LabDirector promotion requirements into an executable analyst handoff, then run validation before promotion: {validation_summary}"
                )
            };
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": description,
                "type": "methods_followup",
                "priority": "high",
                "priority_score": 130,
                "preferred_role": "lab-runner",
                "target_rubric": "technical_quality",
                "target_score": 95,
                "current_score": Value::Null,
                "blocker_reasons": required_validations,
                "candidate_hypotheses": replacement_hypotheses.clone(),
                "analysis_request": {
                    "source": "lab-director-required-validation-before-promotion",
                    "required_validation_before_promotion": payload
                        .get("required_validation_before_promotion")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                    "selected_dataset": payload.get("selected_dataset").cloned().unwrap_or(Value::Null),
                    "identification_strategy": payload
                        .get("identification_strategy")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "replacement_hypotheses": replacement_hypotheses.clone(),
                },
                "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(())
}
