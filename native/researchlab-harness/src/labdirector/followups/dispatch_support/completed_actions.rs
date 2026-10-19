#![allow(unused_imports)]
use super::*;

pub(crate) fn insert_completed_followup_source_keys_for_role_plan(
    paths: &AppPaths,
    cycle_id: &str,
    role_plan_path: &Path,
    keys: &mut HashSet<String>,
) -> Result<()> {
    let Some(index_fields) = read_role_plan_index_fields(role_plan_path)? else {
        return Ok(());
    };
    let (Some(role), Some(action_type), Some(source_brief_id)) = (
        index_fields.role.as_deref(),
        index_fields.action_type.as_deref(),
        index_fields.source_brief_id.as_deref(),
    ) else {
        return Ok(());
    };
    keys.insert(completed_followup_source_key(
        role,
        action_type,
        source_brief_id,
    ));

    if action_type == "recovery_followup" {
        let role_plan = read_json(role_plan_path).unwrap_or_else(|_| json!({}));
        if let Some(original_lane_id) = role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("original_lane_id"))
            .and_then(Value::as_str)
        {
            let original_role_plan_path = lane_role_plan_path(paths, cycle_id, original_lane_id);
            if original_role_plan_path.exists() {
                if let Some(original_fields) =
                    read_role_plan_index_fields(&original_role_plan_path)?
                {
                    if let (
                        Some(original_role),
                        Some(original_action_type),
                        Some(original_source_brief_id),
                    ) = (
                        original_fields.role.as_deref(),
                        original_fields.action_type.as_deref(),
                        original_fields.source_brief_id.as_deref(),
                    ) {
                        keys.insert(completed_followup_source_key(
                            original_role,
                            original_action_type,
                            original_source_brief_id,
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn completed_followup_action_source_keys(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashSet<String>> {
    let mut keys = HashSet::new();
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if !lane_id.starts_with("followup-")
                || lane.get("status").and_then(Value::as_str) != Some("completed")
            {
                continue;
            }
            let role_plan_path = lane_root(paths, cycle_id, lane_id).join("role-plan.json");
            insert_completed_followup_source_keys_for_role_plan(
                paths,
                cycle_id,
                &role_plan_path,
                &mut keys,
            )?;
        }
        return Ok(keys);
    }

    let entries = match fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        Ok(entries) => entries,
        Err(_) => return Ok(keys),
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() {
            continue;
        }
        let final_status_text = fs::read_to_string(&final_status_path).unwrap_or_default();
        if !final_status_text.contains("\"status\": \"completed\"")
            && !final_status_text.contains("\"status\":\"completed\"")
        {
            continue;
        }
        insert_completed_followup_source_keys_for_role_plan(
            paths,
            cycle_id,
            &role_plan_path,
            &mut keys,
        )?;
    }
    Ok(keys)
}

pub(crate) fn append_completed_labdirector_next_actions(
    paths: &AppPaths,
    cycle_id: &str,
    ranked_actions: &mut Vec<Value>,
) -> Result<bool> {
    let mut completed_labdirector_methods_handoff_present = false;
    let completed_source_keys = completed_followup_action_source_keys(paths, cycle_id)?;
    let executable_handoff_waiting_for_runner =
        latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)?;
    for (labdirector_lane_id, payload) in completed_labdirector_requery_payloads(paths, cycle_id)? {
        let Some(next_actions) = payload.get("next_actions").and_then(Value::as_array) else {
            continue;
        };
        // The director's answers to the gate's objections, dispatched like any
        // next action; see rebuttal_targets (role_plan_refresh_01).
        let next_actions: Vec<Value> = next_actions
            .iter()
            .cloned()
            .chain(rebuttal_experiment_actions(&payload))
            .collect();
        let replacement_hypotheses = payload
            .get("replacement_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let selected_hypothesis = payload.get("selected_hypothesis").cloned().filter(|item| {
            item.get("statement")
                .and_then(Value::as_str)
                .map(|statement| !statement.trim().is_empty())
                .unwrap_or(false)
        });
        let selected_or_replacement_hypotheses =
            if payload.get("requery_decision").and_then(Value::as_str) == Some("uphold")
                && selected_hypothesis.is_some()
            {
                vec![selected_hypothesis.unwrap()]
            } else if replacement_hypotheses.is_empty() {
                selected_hypothesis.into_iter().collect::<Vec<_>>()
            } else {
                replacement_hypotheses
            };
        let source_brief_id = format!("labdirector-next-action-{labdirector_lane_id}");
        for (action_index, action) in next_actions.iter().enumerate() {
            let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
            let preferred_role = action
                .get("preferred_role")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !matches!(
                (preferred_role, action_type),
                ("analyst", "methods_followup")
                    | ("lab-runner", "methods_followup")
                    | ("chronicle", "chronicle_evidence_request_followup")
                    | ("scout", "data_acquisition_followup")
                    | ("scout", "novelty_followup")
                    // MEASURED ON cycle-a-20260919, 2026-09-30:
                    // completed directors repeatedly requested independent
                    // procedure adjudication, but this allowlist discarded
                    // both gatekeeper action shapes before dispatch.
                    | ("gatekeeper", "novelty_followup")
                    | ("gatekeeper", "gate_restart_followup")
                    | ("analyst", "impact_followup")
            ) {
                continue;
            }
            // MEASURED ON cycle-a-20260919, 2026-10-06: the direct
            // next-action collector bypassed the requery graph's ordering and
            // dispatched Chronicle before its preceding review-bundle action.
            if action_type == "chronicle_evidence_request_followup"
                && !next_actions[..action_index].iter().all(|prerequisite| {
                    let Some(prerequisite_type) =
                        prerequisite.get("type").and_then(Value::as_str)
                    else {
                        return true;
                    };
                    let prerequisite_role = prerequisite
                        .get("preferred_role")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let effective_type = if prerequisite_role == "analyst"
                        && prerequisite_type == "methods_followup"
                    {
                        "labdirector_comparator_validation_followup"
                    } else {
                        prerequisite_type
                    };
                    completed_source_keys.contains(&completed_followup_source_key(
                        prerequisite_role,
                        effective_type,
                        &source_brief_id,
                    ))
                })
            {
                continue;
            }
            if action_type == "chronicle_evidence_request_followup"
                && completed_chronicle_evidence_request_exists(
                    paths,
                    cycle_id,
                    &labdirector_lane_id,
                )
            {
                continue;
            }
            if action_type == "chronicle_evidence_request_followup"
                && ranked_actions.iter().any(|existing| {
                    existing.get("type").and_then(Value::as_str)
                        == Some("chronicle_evidence_request_followup")
                        && existing
                            .get("source_lab_director_lane_id")
                            .and_then(Value::as_str)
                            == Some(labdirector_lane_id.as_str())
                })
            {
                continue;
            }
            if action_type == "methods_followup"
                && matches!(preferred_role, "analyst" | "lab-runner")
            {
                completed_labdirector_methods_handoff_present = true;
            }
            if executable_handoff_waiting_for_runner
                && action_type == "methods_followup"
                && matches!(preferred_role, "analyst" | "lab-runner")
            {
                continue;
            }
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if description.is_empty() {
                continue;
            }
            let already_present = ranked_actions.iter().any(|existing| {
                existing.get("type").and_then(Value::as_str) == Some(action_type)
                    && existing.get("preferred_role").and_then(Value::as_str)
                        == Some(preferred_role)
                    && existing
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|item| item.trim() == description)
                        .unwrap_or(false)
            });
            if already_present {
                continue;
            }
            let mut queued_action = action.clone();
            queued_action["brief_id"] = json!(source_brief_id.clone());
            if !selected_or_replacement_hypotheses.is_empty()
                && queued_action.get("candidate_hypotheses").is_none()
            {
                queued_action["candidate_hypotheses"] =
                    Value::Array(selected_or_replacement_hypotheses.clone());
            }
            if let Some(first_hypothesis) = selected_or_replacement_hypotheses.first() {
                queued_action["selected_hypothesis"] = first_hypothesis.clone();
            }
            queued_action["requery_decision"] = payload
                .get("requery_decision")
                .cloned()
                .unwrap_or(Value::Null);
            queued_action["requery_rationale"] =
                payload.get("rationale").cloned().unwrap_or(Value::Null);
            let effective_action_type =
                if preferred_role == "analyst" && action_type == "methods_followup" {
                    "labdirector_comparator_validation_followup"
                } else {
                    action_type
                };
            if completed_source_keys.contains(&completed_followup_source_key(
                preferred_role,
                effective_action_type,
                &source_brief_id,
            )) {
                continue;
            }
            if preferred_role == "analyst" && action_type == "methods_followup" {
                queued_action["type"] = json!("labdirector_comparator_validation_followup");
                queued_action["analysis_request"] = json!({
                    "source": "lab-director-next-action-comparator-validation",
                    "source_lab_director_lane_id": labdirector_lane_id,
                    "lab_director_next_action": action,
                    "selected_hypothesis": selected_or_replacement_hypotheses.first().cloned().unwrap_or(Value::Null),
                    "candidate_hypotheses": selected_or_replacement_hypotheses.clone(),
                    "validation_changes": payload.get("validation_changes").cloned().unwrap_or_else(|| json!([])),
                    "required_outputs": [
                        "analysis-design-memo.json with schema-backed variables only",
                        "same-dataset baseline comparator map",
                        "covariate/confounder adjustment plan",
                        "negative-control/permutation/falsification checks",
                        "executable handoff-validation-plan.json for LabRunner"
                    ],
                    "forbidden_validation_modes": [
                        "topic-token/path-token validation",
                        "fallback runtime-token validation",
                        "runner execution without an executable Analyst handoff"
                    ]
                });
            }
            queued_action["priority"] = queued_action
                .get("priority")
                .cloned()
                .unwrap_or_else(|| json!("critical"));
            queued_action["priority_score"] = queued_action
                .get("priority_score")
                .cloned()
                .unwrap_or_else(|| json!(275));
            queued_action["source_lab_director_lane_id"] = json!(labdirector_lane_id.clone());
            queued_action["blocker_reasons"] = queued_action
                .get("blocker_reasons")
                .cloned()
                .unwrap_or_else(|| {
                    json!([
                        "LabDirector selected a replacement lead and requested Analyst-to-LabRunner validation handoff"
                    ])
                });
            ranked_actions.push(queued_action);
        }
    }
    Ok(completed_labdirector_methods_handoff_present)
}

pub(crate) fn pending_labdirector_chronicle_prerequisite(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<String>> {
    for (lane_id, payload) in completed_labdirector_requery_payloads(paths, cycle_id)? {
        let deferred = payload.get("decision_status").and_then(Value::as_str)
            == Some("needs_chronicle_evidence")
            || payload.get("requery_decision").and_then(Value::as_str)
                == Some("defer_for_chronicle");
        let requested = payload
            .get("chronicle_requests")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        if deferred
            && requested
            && !completed_chronicle_evidence_request_exists(paths, cycle_id, &lane_id)
        {
            return Ok(Some(lane_id));
        }
    }
    Ok(None)
}

pub(crate) fn active_lead_falsification_release(paths: &AppPaths, cycle_id: &str) -> bool {
    active_lead_falsification_replacement_action(paths, cycle_id).is_some()
}

pub(crate) fn active_lead_falsification_replacement_action(
    paths: &AppPaths,
    cycle_id: &str,
) -> Option<Value> {
    let protection_path = state_root(paths).join(format!("{cycle_id}-lead-protection.json"));
    let Ok(protection) = read_json(&protection_path) else {
        return None;
    };
    if protection.get("decision").and_then(Value::as_str) != Some("allow")
        || protection.get("reason").and_then(Value::as_str)
            != Some("lead_falsified_by_completed_run")
    {
        return None;
    }
    let Some(released_at_raw) = protection.get("ts").and_then(Value::as_str) else {
        return None;
    };
    let Some(released_at) = chrono::DateTime::parse_from_rfc3339(released_at_raw)
        .ok()
        .map(|stamp| stamp.timestamp_millis())
    else {
        return None;
    };
    let lead_path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let selected_at = read_json(&lead_path)
        .ok()
        .and_then(|lead| {
            lead.get("selected_at_epoch_ms")
                .and_then(Value::as_i64)
                .or_else(|| {
                    lead.get("selected_at")
                        .and_then(Value::as_str)
                        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
                        .map(|stamp| stamp.timestamp_millis())
                })
                .or_else(|| {
                    lead.get("updated_at")
                        .and_then(Value::as_str)
                        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
                        .map(|stamp| stamp.timestamp_millis())
                })
        })
        .unwrap_or(0);
    if released_at <= selected_at {
        return None;
    }

    let lead = protection
        .get("lead")
        .and_then(Value::as_str)
        .unwrap_or("selected-lead");
    let source = format!(
        "lead-falsification-replacement-{}",
        slugify(&format!("{lead}-{released_at_raw}"))
    );
    let directive = protection
        .get("directive")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(
            "The selected method was validly falsified. Select and record a replacement method for the surviving research question.",
        );
    Some(json!({
        "brief_id": source,
        "description": directive,
        "type": "lab_director_requery_followup",
        "priority": "critical",
        "priority_score": 1_000_000,
        "preferred_role": "lab-director",
        "target_rubric": "hypothesis_strategy",
        "falsification_replacement_required": true,
        "released_lead": lead,
        "released_at": released_at_raw,
        "blocker_reasons": [directive]
    }))
}

/// `rebuttal_experiments` of a director decision as next actions.
///
/// OWNER DECISION 2026-10-06, after ScientistTwo (arXiv 2609.19644): an
/// objection from the gate is answered with an experiment aimed at it before the
/// lead is replaced. Each entry becomes a methods follow-up (a scout's becomes a
/// novelty follow-up) whose description quotes the objection it answers.
pub(crate) fn rebuttal_experiment_actions(payload: &Value) -> Vec<Value> {
    payload
        .get("rebuttal_experiments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let experiment = entry.get("experiment").and_then(Value::as_str)?.trim();
            if experiment.is_empty() {
                return None;
            }
            let objection = entry
                .get("answers_objection")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let rubric = entry
                .get("target_rubric")
                .and_then(Value::as_str)
                .unwrap_or("binding rubric");
            let preferred_role = match entry.get("preferred_role").and_then(Value::as_str) {
                Some("scout") => "scout",
                Some("analyst") => "analyst",
                _ => "lab-runner",
            };
            let action_type = if preferred_role == "scout" { "novelty_followup" } else { "methods_followup" };
            Some(json!({
                "type": action_type,
                "preferred_role": preferred_role,
                "description": format!(
                    "REBUTTAL ({rubric}): answers the gate objection \"{objection}\" -- {experiment}"
                ),
                "answers_objection": objection,
                "target_rubric": rubric,
            }))
        })
        .collect()
}

#[cfg(test)]
mod rebuttal_experiment_tests {
    use super::*;

    #[test]
    fn rebuttal_experiments_become_next_actions_that_quote_the_objection() {
        let payload = json!({
            "requery_decision": "uphold",
            "rebuttal_experiments": [
                {"answers_objection": "no held-out seed confirms the slope", "target_rubric": "reproducibility",
                 "experiment": "re-run the slope on 5 held-out seeds; the sign must hold in 4", "preferred_role": "lab-runner"},
                {"answers_objection": "adjacent to ALT", "target_rubric": "novelty", "experiment": "procedure-level prior-art audit of ALT", "preferred_role": "scout"},
                {"experiment": "   "}
            ]
        });
        let actions = rebuttal_experiment_actions(&payload);
        assert_eq!(actions.len(), 2, "{actions:?}");
        assert_eq!(actions[0]["type"], json!("methods_followup"));
        assert_eq!(actions[0]["preferred_role"], json!("lab-runner"));
        assert!(actions[0]["description"].as_str().unwrap().starts_with("REBUTTAL (reproducibility): answers the gate objection \"no held-out seed confirms the slope\" -- re-run"));
        assert_eq!(actions[1]["type"], json!("novelty_followup"));
        assert_eq!(actions[1]["preferred_role"], json!("scout"));
        assert!(rebuttal_experiment_actions(&json!({})).is_empty());
    }
}
