use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use crate::core::model::AppPaths;
use crate::core::support::{now_iso, state_root, write_json};

pub(crate) fn cycle_aggregate_metrics_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-cycle-aggregate-metrics.json"))
}

fn embedded_chronicle_report_payload(payload: &Value) -> Option<&Value> {
    payload
        .get("extracted_json")
        .filter(|value| value.is_object())
        .or_else(|| {
            payload
                .get("fallback_payload")
                .filter(|value| value.is_object())
        })
}

fn chronicle_report_nonempty_array(payload: &Value, keys: &[&str]) -> Option<Vec<Value>> {
    for key in keys {
        if let Some(array) = payload.get(*key).and_then(Value::as_array) {
            if !array.is_empty() {
                return Some(array.clone());
            }
        }
    }
    if let Some(embedded) = embedded_chronicle_report_payload(payload) {
        for key in keys {
            if let Some(array) = embedded.get(*key).and_then(Value::as_array) {
                if !array.is_empty() {
                    return Some(array.clone());
                }
            }
        }
    }
    None
}

fn normalized_chronicle_report_payload(payload: &Value) -> Value {
    let mut normalized = payload.clone();
    if let Some(obj) = normalized.as_object_mut() {
        if let Some(claim_deltas) = chronicle_report_nonempty_array(payload, &["claim_deltas"]) {
            obj.insert(
                "claim_deltas".to_string(),
                Value::Array(claim_deltas.clone()),
            );
            obj.insert("claim_delta_count".to_string(), json!(claim_deltas.len()));
        }
        if let Some(open_questions) = chronicle_report_nonempty_array(payload, &["open_questions"])
        {
            obj.insert(
                "open_questions".to_string(),
                Value::Array(open_questions.clone()),
            );
            obj.insert(
                "open_question_count".to_string(),
                json!(open_questions.len()),
            );
        }
        if let Some(recommended_actions) =
            chronicle_report_nonempty_array(payload, &["recommended_actions", "next_actions"])
        {
            obj.insert(
                "recommended_actions".to_string(),
                Value::Array(recommended_actions.clone()),
            );
            obj.insert(
                "recommended_action_count".to_string(),
                json!(recommended_actions.len()),
            );
        }
        if let Some(hypothesis_candidates) =
            chronicle_report_nonempty_array(payload, &["hypothesis_candidates"])
        {
            obj.insert(
                "hypothesis_candidates".to_string(),
                Value::Array(hypothesis_candidates.clone()),
            );
            obj.insert(
                "hypothesis_candidate_count".to_string(),
                json!(hypothesis_candidates.len()),
            );
        }
    }
    normalized
}

pub(crate) fn normalized_chronicle_report_item(item: &Value) -> Value {
    if item.get("type").and_then(Value::as_str) != Some("chronicle_report") {
        return item.clone();
    }
    let mut normalized = item.clone();
    if let Some(obj) = normalized.as_object_mut() {
        let payload = item.get("payload").cloned().unwrap_or_else(|| json!({}));
        obj.insert(
            "payload".to_string(),
            normalized_chronicle_report_payload(&payload),
        );
    }
    normalized
}

/// Compute cumulative metrics over the ENTIRE inbox (not just the unread
/// slice). This underpins revision P1-2 so strategy decisions reflect
/// cycle-total progress, not just this pass's activity.
pub(crate) fn compute_cycle_aggregate_metrics(lines: &[String]) -> Value {
    let mut chronicle_report_count: u64 = 0;
    let mut claim_delta_count: u64 = 0;
    let mut primary_claim_count: u64 = 0;
    let mut supporting_claim_count: u64 = 0;
    let mut open_question_count: u64 = 0;
    let mut recommended_action_count: u64 = 0;
    let mut failure_notice_count: u64 = 0;
    let mut rate_limited_lane_count: u64 = 0;
    let mut quota_exceeded_lane_count: u64 = 0;
    let mut timeout_lane_count: u64 = 0;
    let mut context_window_lane_count: u64 = 0;
    let mut user_message_count: u64 = 0;
    let mut control_command_count: u64 = 0;
    let mut seen_chronicle_report_lanes: HashSet<String> = HashSet::new();
    let mut duplicate_chronicle_report_count: u64 = 0;

    for line in lines {
        let item: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = item.get("payload");
        match item_type {
            "chronicle_report" => {
                if let Some(p) = payload {
                    let lane_id = p
                        .get("lane_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !lane_id.is_empty() && !seen_chronicle_report_lanes.insert(lane_id) {
                        duplicate_chronicle_report_count += 1;
                        continue;
                    }
                    chronicle_report_count += 1;
                    let p = normalized_chronicle_report_payload(p);
                    claim_delta_count += p
                        .get("claim_delta_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    primary_claim_count += p
                        .get("primary_claim_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    supporting_claim_count += p
                        .get("supporting_claim_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    open_question_count += p
                        .get("open_question_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    recommended_action_count += p
                        .get("recommended_action_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                }
            }
            "lane_failure_notice" => {
                failure_notice_count += 1;
                if let Some(p) = payload {
                    match p.get("failure_category").and_then(Value::as_str) {
                        Some("rate_limited") => rate_limited_lane_count += 1,
                        Some("quota_exceeded") => quota_exceeded_lane_count += 1,
                        Some("timeout") => timeout_lane_count += 1,
                        Some("context_window_exceeded") => context_window_lane_count += 1,
                        _ => {}
                    }
                }
            }
            "user_message" => user_message_count += 1,
            "control_command" => control_command_count += 1,
            _ => {}
        }
    }

    json!({
        "generated_at": now_iso(),
        "chronicle_report_count": chronicle_report_count,
        "claim_delta_count": claim_delta_count,
        "primary_claim_count": primary_claim_count,
        "supporting_claim_count": supporting_claim_count,
        "open_question_count": open_question_count,
        "recommended_action_count": recommended_action_count,
        "failure_notice_count": failure_notice_count,
        "rate_limited_lane_count": rate_limited_lane_count,
        "quota_exceeded_lane_count": quota_exceeded_lane_count,
        "timeout_lane_count": timeout_lane_count,
        "context_window_lane_count": context_window_lane_count,
        "user_message_count": user_message_count,
        "control_command_count": control_command_count,
        "duplicate_chronicle_report_count": duplicate_chronicle_report_count,
        "unique_chronicle_report_lane_count": seen_chronicle_report_lanes.len(),
        "total_inbox_items": lines.len(),
    })
}

pub(crate) fn write_cycle_aggregate_metrics(
    paths: &AppPaths,
    cycle_id: &str,
    metrics: &Value,
) -> Result<()> {
    let path = cycle_aggregate_metrics_path(paths, cycle_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json(&path, metrics)?;
    Ok(())
}
