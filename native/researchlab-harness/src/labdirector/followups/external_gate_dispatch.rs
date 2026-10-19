#![allow(unused_imports)]
use super::*;

pub fn next_followup_lane_id(paths: &AppPaths, cycle_id: &str, prefix: &str) -> Result<String> {
    let mut next_index = 1usize;
    for (name, _) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if let Some(suffix) = name.strip_prefix(prefix) {
            if let Ok(value) = suffix.parse::<usize>() {
                next_index = next_index.max(value + 1);
            }
        }
    }
    if let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(suffix) = name.strip_prefix(prefix) {
                if let Ok(value) = suffix.parse::<usize>() {
                    next_index = next_index.max(value + 1);
                }
            }
        }
    }
    Ok(format!("{prefix}{next_index:02}"))
}

pub(crate) fn candidate_statements_from_action(action: &Value) -> Vec<String> {
    let mut statements = candidate_hypothesis_statements(action);
    if let Some(items) = action.get("candidate_hypotheses").and_then(Value::as_array) {
        for item in items {
            if let Some(statement) = item.get("statement").and_then(Value::as_str) {
                if !statements.iter().any(|existing| existing == statement) {
                    statements.push(statement.to_string());
                }
            }
        }
    }
    statements.truncate(8);
    statements
}

pub(crate) fn dispatch_external_validation_gate_lanes(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
) -> Result<Vec<Value>> {
    if max_new_lanes == 0 {
        return Ok(Vec::new());
    }
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !review_path.exists() {
        return Ok(Vec::new());
    }
    let gate_review = read_json(&review_path)?;
    let required = gate_review
        .get("external_validation_review")
        .and_then(|item| item.get("required_for_gate"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !required {
        return Ok(Vec::new());
    }

    let cycle_plan_path = plans_root(paths).join(format!("{cycle_id}-cycle-plan.json"));
    let objective = if cycle_plan_path.exists() {
        read_json(&cycle_plan_path)?
            .get("objective")
            .and_then(Value::as_str)
            .unwrap_or("Continue the active research cycle.")
            .to_string()
    } else {
        "Continue the active research cycle.".to_string()
    };
    let mut existing_signatures = existing_task_signatures(paths, cycle_id)?;
    let open_action_counts = count_open_followup_lanes_by_role_and_action(paths, cycle_id)?;
    let validation_plan = gate_review
        .get("external_validation_review")
        .and_then(|item| item.get("validation_plan"))
        .cloned()
        .unwrap_or(Value::Null);

    let mut created = Vec::new();
    for action in external_validation_gate_actions(&gate_review) {
        if created.len() >= max_new_lanes {
            break;
        }
        let action_type = action
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("external_validation_followup");
        let role = match action_type {
            "external_validation_analysis_followup" => "analyst",
            "external_validation_followup" => "scout",
            _ => match action.get("preferred_role").and_then(Value::as_str) {
                Some("analyst") => "analyst",
                _ => "scout",
            },
        };
        let canonical_action_type = if role == "analyst" {
            "external_validation_analysis_followup"
        } else {
            "external_validation_followup"
        };
        let action_key = format!("{role}::{canonical_action_type}");
        if open_action_counts.get(&action_key).copied().unwrap_or(0) > 0 {
            continue;
        }
        let brief_id = action
            .get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("external_validation_gate");
        let description = action
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or(if role == "analyst" {
                "design an executable external-validation or fallback sensitivity analysis before hypothesis gate closure"
            } else {
                "search for and materialize an external validation source or write a concrete failed-attempt artifact before hypothesis gate closure"
            });
        let assigned_hypotheses = candidate_statements_from_action(&action);
        let task_body = followup_task_markdown(
            cycle_id,
            &objective,
            role,
            brief_id,
            description,
            &assigned_hypotheses,
        );
        let signature = followup_task_signature(&task_body);
        if existing_signatures.contains(&signature) {
            continue;
        }

        let (runtime_class, mode, prefix) = if role == "analyst" {
            ("external-driver", "driver-exec", "followup-analyst-")
        } else {
            ("external-driver", "driver-exec", "followup-scout-")
        };
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
            description,
            canonical_action_type,
            &assigned_hypotheses,
            action
                .get("candidate_hypotheses")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            None,
            None,
            None,
            &[],
            json!({
                "priority_source": "external_validation_gate_pre_dispatch",
                "preferred_role": role,
                "effective_role": role,
                "target_rubric": "external_validity",
                "gate_required": true,
                "gate_review_path": review_path,
                "review_action": action,
                "validation_plan": action
                    .get("validation_plan")
                    .cloned()
                    .unwrap_or_else(|| validation_plan.clone()),
                "expected_artifacts": action
                    .get("expected_artifacts")
                    .cloned()
                    .unwrap_or_else(|| {
                        if role == "analyst" {
                            json!([
                                "external_validation_feasibility.json",
                                "external_validation_analysis_plan.md",
                                "hypothesis_demote_or_refine_criteria.json"
                            ])
                        } else {
                            json!([
                                "external_validation_dataset_manifest.json",
                                "external_validation_feasibility.json",
                                "external_validation_analysis_plan.md",
                                "external_validation_failed_attempt.md"
                            ])
                        }
                    }),
            }),
        )?;
        existing_signatures.insert(signature);
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

pub(crate) fn hypothesis_gate_closure_ready(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    if hypothesis_gate_passed(paths, cycle_id)? {
        return Ok(false);
    }
    let lead_path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let lead = read_json(&lead_path).unwrap_or(Value::Null);
    let selected = lead.get("status").and_then(Value::as_str) == Some("selected")
        && lead
            .get("statement")
            .or_else(|| lead.get("selected_hypothesis"))
            .is_some_and(|value| {
                value.as_str().is_some_and(|text| !text.trim().is_empty())
                    || value
                        .get("statement")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
            });
    // MEASURED ON cycle-a-20260919, 2026-10-02: a conclusion review
    // from a demoted lead kept gate-closure scheduling active while the current
    // LabDirector artifact had selected_hypothesis=null. Reviews cannot close a
    // lead that does not exist, and they starved the evidence action that could
    // select its replacement.
    if !selected {
        return Ok(false);
    }
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if review_path.exists() {
        if json_top_level_bool_window(&review_path, "conclusion_gate_passed")?.unwrap_or(false)
            || json_top_level_bool_window(&review_path, "conclusion_gate_eligible")?
                .unwrap_or(false)
        {
            return Ok(true);
        }
    }
    let conclusion_review_path =
        state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
    if conclusion_review_path.exists() {
        return Ok(read_json(&conclusion_review_path)?
            .get("conclusion_gate_passed")
            .and_then(Value::as_bool)
            .unwrap_or(false));
    }
    Ok(false)
}

pub(crate) fn analyst_fallback_role(
    action_type: &str,
    description: &str,
) -> (&'static str, &'static str, &'static str, &'static str) {
    if action_type.starts_with("hypothesis_regeneration")
        || action_type == "gate_restart_followup"
        || action_type == "data_acquisition_followup"
        || action_type.contains("literature")
        || description.contains("paper")
        || description.contains("literature")
    {
        ("scout", "external-driver", "driver-exec", "followup-scout-")
    } else {
        (
            "lab-runner",
            "external-driver",
            "driver-exec",
            "followup-runner-",
        )
    }
}

pub(crate) fn should_route_to_literature_analyst(
    preferred_role: &str,
    action_type: &str,
    description: &str,
) -> bool {
    preferred_role != "lab-runner"
        && (action_type.contains("literature") || description.contains("paper"))
}

pub(crate) fn planner_convergence_mode(paths: &AppPaths, cycle_id: &str) -> String {
    let history_path = paths
        .runtime_root
        .join("runtime")
        .join(format!("{cycle_id}-supervisor-history.json"));
    let history = read_json(&history_path).ok();
    let passes = history
        .as_ref()
        .and_then(|value| value.get("passes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pass_count = passes.len();
    let latest = passes.last().cloned().unwrap_or_else(|| json!({}));
    let conclusion_score = latest
        .get("conclusion_score")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let conclusion_gate_passed = latest
        .get("conclusion_gate_passed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if conclusion_gate_passed || conclusion_score >= 95 || pass_count >= 4 {
        "converge".to_string()
    } else if pass_count >= 2 || conclusion_score >= 85 {
        "focus".to_string()
    } else {
        "explore".to_string()
    }
}
