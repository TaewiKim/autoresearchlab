#![allow(unused_imports)]
use super::*;

pub(crate) fn completed_chronicle_evidence_request_exists(
    paths: &AppPaths,
    cycle_id: &str,
    source_brief_id: &str,
) -> bool {
    if let Some(exists) = completed_followup_action_from_sqlite_queue(
        paths,
        cycle_id,
        "chronicle",
        "chronicle_evidence_request_followup",
        source_brief_id,
    ) {
        return exists;
    }
    if source_brief_id.trim().is_empty() {
        return false;
    }
    if let Ok(Some(exists)) = completed_followup_action_from_state_exists(
        paths,
        cycle_id,
        "chronicle",
        "chronicle_evidence_request_followup",
        source_brief_id,
    ) {
        return exists;
    }
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return false;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() || !result_path.is_file() {
            continue;
        }
        let Ok(role_plan) = read_json(&role_plan_path) else {
            continue;
        };
        if role_plan.get("role").and_then(Value::as_str) != Some("chronicle")
            || role_plan.get("action_type").and_then(Value::as_str)
                != Some("chronicle_evidence_request_followup")
            || role_plan.get("source_brief_id").and_then(Value::as_str) != Some(source_brief_id)
        {
            continue;
        }
        let Ok(final_status) = read_json(&final_status_path) else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) == Some("completed") {
            return true;
        }
    }
    false
}

pub(crate) fn completed_followup_action_from_source_exists(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    source_brief_id: &str,
) -> bool {
    if let Some(exists) = completed_followup_action_from_sqlite_queue(
        paths,
        cycle_id,
        role,
        action_type,
        source_brief_id,
    ) {
        if exists {
            return true;
        }
    }
    if role == "analyst" && action_type == "labdirector_comparator_validation_followup" {
        let db_path = paths.runtime_root.join("queues").join("pipeline.sqlite");
        if db_path.is_file() {
            if let Ok(conn) = rusqlite::Connection::open(db_path) {
                let cycle_rows: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pipeline_queue WHERE cycle_id = ?1",
                        rusqlite::params![cycle_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if cycle_rows > 0 {
                    return false;
                }
            }
        }
    }
    if source_brief_id.trim().is_empty() {
        return false;
    }
    if let Ok(Some(exists)) = completed_followup_action_from_state_exists(
        paths,
        cycle_id,
        role,
        action_type,
        source_brief_id,
    ) {
        return exists;
    }
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return false;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() {
            continue;
        }
        let Ok(role_plan) = read_json(&role_plan_path) else {
            continue;
        };
        if role_plan.get("role").and_then(Value::as_str) != Some(role)
            || role_plan.get("action_type").and_then(Value::as_str) != Some(action_type)
            || role_plan.get("source_brief_id").and_then(Value::as_str) != Some(source_brief_id)
        {
            continue;
        }
        let Ok(final_status) = read_json(&final_status_path) else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) == Some("completed") {
            return true;
        }
    }
    false
}

pub(crate) fn completed_chronicle_evidence_context(paths: &AppPaths, cycle_id: &str) -> Value {
    if let Ok(Some(lanes)) =
        completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, "chronicle")
    {
        let mut responses: Vec<(DateTime<Utc>, Value)> = Vec::new();
        for lane in lanes {
            let role_plan_path = lane.lane_dir.join("role-plan.json");
            let result_path = lane
                .result_path
                .clone()
                .unwrap_or_else(|| lane.lane_dir.join("result.json"));
            if !role_plan_path.is_file() || !result_path.is_file() {
                continue;
            }
            let Ok(role_plan) = read_json(&role_plan_path) else {
                continue;
            };
            if role_plan.get("role").and_then(Value::as_str) != Some("chronicle")
                || role_plan.get("action_type").and_then(Value::as_str)
                    != Some("chronicle_evidence_request_followup")
            {
                continue;
            }
            let Ok(result) = read_json(&result_path) else {
                continue;
            };
            let modified = lane
                .completed_at
                .or_else(|| {
                    result_path
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .map(DateTime::<Utc>::from)
                })
                .unwrap_or_else(|| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH));
            responses.push((
                modified,
                json!({
                    "source_brief_id": role_plan.get("source_brief_id").cloned().unwrap_or(Value::Null),
                    "description": role_plan.get("followup_description").or_else(|| role_plan.get("description")).cloned().unwrap_or(Value::Null),
                    "role_plan_path": role_plan_path,
                    "result_path": result_path,
                    "answer_summary": compact_json_context(&result, 12_000),
                }),
            ));
        }
        responses.sort_by(|a, b| b.0.cmp(&a.0));
        return Value::Array(
            responses
                .into_iter()
                .take(6)
                .map(|(_, value)| value)
                .collect(),
        );
    }
    let mut responses: Vec<(std::time::SystemTime, Value)> = Vec::new();
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return json!([]);
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() || !result_path.is_file() {
            continue;
        }
        let Ok(role_plan) = read_json(&role_plan_path) else {
            continue;
        };
        if role_plan.get("role").and_then(Value::as_str) != Some("chronicle")
            || role_plan.get("action_type").and_then(Value::as_str)
                != Some("chronicle_evidence_request_followup")
        {
            continue;
        }
        let Ok(final_status) = read_json(&final_status_path) else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let Ok(result) = read_json(&result_path) else {
            continue;
        };
        let modified = result_path
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        responses.push((
            modified,
            json!({
                "source_brief_id": role_plan.get("source_brief_id").cloned().unwrap_or(Value::Null),
                "description": role_plan.get("followup_description").or_else(|| role_plan.get("description")).cloned().unwrap_or(Value::Null),
                "role_plan_path": role_plan_path,
                "result_path": result_path,
                "answer_summary": compact_json_context(&result, 12_000),
            }),
        ));
    }
    responses.sort_by(|a, b| b.0.cmp(&a.0));
    Value::Array(
        responses
            .into_iter()
            .take(6)
            .map(|(_, value)| value)
            .collect(),
    )
}

pub(crate) fn strategy_decision_timestamp(
    strategy_path: &Path,
    strategy: &Value,
) -> Option<DateTime<Utc>> {
    for key in ["decided_at", "generated_at", "reviewed_at", "created_at"] {
        if let Some(parsed) = strategy
            .get(key)
            .and_then(Value::as_str)
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        {
            return Some(parsed.with_timezone(&Utc));
        }
    }
    fs::metadata(strategy_path)
        .and_then(|meta| meta.modified())
        .ok()
        .map(DateTime::<Utc>::from)
}

pub(crate) fn completed_labdirector_requery_at_or_after(
    paths: &AppPaths,
    cycle_id: &str,
    min_completed_at: Option<DateTime<Utc>>,
) -> Result<bool> {
    if let Some(lanes) =
        completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, "lab-director")?
    {
        for lane in lanes {
            let role_plan_path = lane.lane_dir.join("role-plan.json");
            if !role_plan_path.exists() {
                continue;
            }
            let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
                continue;
            };
            if role_plan.role.as_deref() != Some("lab-director") {
                continue;
            }
            if role_plan.action_type.as_deref() != Some("lab_director_requery_followup") {
                continue;
            }
            if !labdirector_requery_lane_completed_with_decision(&lane.lane_dir)? {
                continue;
            }
            let completed_at = lane.completed_at.or_else(|| {
                let final_status_path = lane.lane_dir.join("final-status.json");
                fs::metadata(&final_status_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .map(DateTime::<Utc>::from)
            });
            match (min_completed_at, completed_at) {
                (Some(minimum), Some(completed)) if completed >= minimum => return Ok(true),
                (Some(_), Some(_)) => {}
                (Some(_), None) => {}
                (None, _) => return Ok(true),
            }
        }
        return Ok(false);
    }
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.contains("lab-director") {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !role_plan_path.exists() || !final_status_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        if !labdirector_requery_lane_completed_with_decision(&lane_dir)? {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("lab-director") {
            continue;
        }
        if role_plan.action_type.as_deref() != Some("lab_director_requery_followup") {
            continue;
        }
        let completed_at = final_status
            .get("completed_at")
            .and_then(Value::as_str)
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|parsed| parsed.with_timezone(&Utc))
            .or_else(|| {
                fs::metadata(&final_status_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .map(DateTime::<Utc>::from)
            });
        match (min_completed_at, completed_at) {
            (Some(minimum), Some(completed)) if completed >= minimum => return Ok(true),
            (Some(_), Some(_)) => {}
            (Some(_), None) => {}
            (None, _) => return Ok(true),
        }
    }
    Ok(false)
}

pub(crate) fn labdirector_requery_lane_completed_with_decision(lane_dir: &Path) -> Result<bool> {
    let final_status_path = lane_dir.join("final-status.json");
    if final_status_path.exists() {
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            return Ok(false);
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            return Ok(false);
        }
        if final_status
            .get("degraded")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || final_status
                .get("failure_category")
                .and_then(Value::as_str)
                .is_some()
        {
            return Ok(false);
        }
    }
    let result_path = lane_dir.join("result.json");
    if !result_path.exists() {
        return Ok(true);
    }
    let result = lane_result_fields(
        &result_path,
        &[
            "degraded",
            "failure_category",
            "model_reported_execution_error",
            "extracted_json",
        ],
    )?;
    if result
        .get("degraded")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || result
            .get("failure_category")
            .and_then(Value::as_str)
            .is_some()
        || result
            .get("model_reported_execution_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Ok(false);
    }
    if let Some(extracted) = result.get("extracted_json") {
        if extracted.get("is_error").and_then(Value::as_bool) == Some(true)
            || extracted.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
            || extracted
                .get("errors")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn completed_labdirector_requery_at_or_after_latest_pivot_evidence(
    paths: &AppPaths,
    cycle_id: &str,
    pivot_decision_time: Option<DateTime<Utc>>,
) -> Result<bool> {
    let latest_chronicle_evidence = latest_completed_followup_action_at(
        paths,
        cycle_id,
        "chronicle",
        "chronicle_evidence_request_followup",
        None,
    )?;
    let minimum = match (pivot_decision_time, latest_chronicle_evidence) {
        (Some(pivot), Some(evidence)) => Some(std::cmp::max(pivot, evidence)),
        (Some(pivot), None) => Some(pivot),
        (None, Some(evidence)) => Some(evidence),
        (None, None) => None,
    };
    completed_labdirector_requery_at_or_after(paths, cycle_id, minimum)
}
