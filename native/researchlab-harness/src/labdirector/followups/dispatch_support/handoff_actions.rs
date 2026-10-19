#![allow(unused_imports)]
use super::*;

pub(crate) fn inject_latest_executable_analyst_handoff_action(
    paths: &AppPaths,
    cycle_id: &str,
    ranked_actions: &mut Vec<Value>,
) -> Result<()> {
    let Some(handoff_signal) = latest_analyst_handoff_signal(paths, cycle_id)? else {
        return Ok(());
    };
    let handoff_path = handoff_signal
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("latest analyst handoff")
        .to_string();
    let handoff_payload = handoff_signal
        .get("payload")
        .cloned()
        .unwrap_or(Value::Null);
    if !analyst_handoff_is_executable(&handoff_payload) {
        return Ok(());
    }
    let handoff_key = normalized_path_key(&handoff_path);
    if ranked_actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff")
            && direct_handoff_action_path(action)
                .map(normalized_path_key)
                .map(|path| path == handoff_key)
                .unwrap_or(false)
    }) {
        return Ok(());
    }
    ranked_actions
        .retain(|action| action.get("brief_id").and_then(Value::as_str) != Some("analyst-handoff"));
    push_analyst_handoff_followup_action(
        paths,
        cycle_id,
        ranked_actions,
        "analyst-handoff",
        "latest-executable-analyst-handoff",
        handoff_path,
        handoff_payload,
        285,
        "latest executable analyst handoff has not been converted into a lab-runner validation pass",
    )
}

pub(crate) fn direct_handoff_action_path(action: &Value) -> Option<&str> {
    [
        "/analysis_request/handoff_path",
        "/analysis_request/analyst_handoff_path",
        "/planner_metadata/analysis_request/handoff_path",
        "/planner_metadata/analysis_request/analyst_handoff_path",
        "/planner_metadata/analyst_handoff_path",
        "/handoff_path",
    ]
    .iter()
    .filter_map(|pointer| action.pointer(pointer))
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty())
}

pub(crate) fn direct_handoff_runner_retry_allowed(
    paths: &AppPaths,
    cycle_id: &str,
    action: &Value,
) -> Result<bool> {
    let Some(handoff_path) = direct_handoff_action_path(action) else {
        return Ok(false);
    };
    if !latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)? {
        return Ok(false);
    }
    Ok(open_lab_runner_lane_for_handoff(paths, cycle_id, handoff_path)?.is_none())
}

pub(crate) fn pending_gatekeeper_rubric_review_required(
    paths: &AppPaths,
    cycle_id: &str,
    target_rubric: &str,
) -> Result<bool> {
    let target_rubric = target_rubric.trim();
    if target_rubric.is_empty() {
        return Ok(false);
    }
    let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !gate_review_path.exists() {
        return Ok(false);
    }
    let gate_review = read_json(&gate_review_path)?;
    Ok(gate_review
        .get("gatekeeper_pending_rubrics")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .map(|value| value.trim() == target_rubric)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false))
}

pub(crate) fn focused_gatekeeper_retry_allowed(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    target_rubric: &str,
) -> Result<bool> {
    if role != "gatekeeper" || action_type != "independent_gate_review_followup" {
        return Ok(false);
    }
    if !pending_gatekeeper_rubric_review_required(paths, cycle_id, target_rubric)? {
        return Ok(false);
    }
    Ok(!open_independent_gate_review_for_rubric(
        paths,
        cycle_id,
        target_rubric,
    )?)
}

pub(crate) fn completed_followup_action_source_key_exists(
    completed_source_keys: &HashSet<String>,
    role: &str,
    action_type: &str,
    source_brief_id: &str,
) -> bool {
    completed_source_keys.contains(&completed_followup_source_key(
        role,
        action_type,
        source_brief_id,
    ))
}
