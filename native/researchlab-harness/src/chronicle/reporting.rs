use anyhow::Result;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::core::model::{AppPaths, ChronicleBrief};
use crate::core::support::segmented_log::{chronicle_report_log, labdirector_inbox_log, SegmentedLog};
use crate::core::support::{make_runtime_path_collaborative, now_iso, read_json};

const CHRONICLE_REPORT_RESULT_READ_LIMIT_BYTES: u64 = 5 * 1024 * 1024;

fn read_json_if_below(path: &Path, max_bytes: u64) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let size = fs::metadata(path).ok()?.len();
    if size > max_bytes {
        return None;
    }
    read_json(path).ok()
}

pub(crate) fn report_already_published_for_lane(reports: &SegmentedLog, lane_id: &str) -> bool {
    if lane_id.trim().is_empty() {
        return false;
    }
    let mut published = false;
    let _ = reports.for_each_line(|line| {
        // Only a line that mentions the lane is worth parsing.
        if published || !line.contains(lane_id) {
            return;
        }
        published = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|item| item.get("lane_id").and_then(Value::as_str).map(|id| id == lane_id))
            .unwrap_or(false);
    });
    published
}

fn is_labdirector_dialogue_path(events_path: &Path) -> bool {
    events_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.ends_with("-labdirector-dialogue.jsonl"))
        .unwrap_or(false)
}

pub(crate) fn append_event(events_path: &Path, event_type: &str, payload: Value) -> Result<()> {
    if let Some(parent) = events_path.parent() {
        fs::create_dir_all(parent)?;
        make_runtime_path_collaborative(parent);
    }
    let row = json!({
        "ts": now_iso(),
        "event_type": event_type,
        "payload": payload,
    });
    // The dialogue is kept by the hour, like every append-only log of a cycle
    // (core::support::segmented_log). It used to be one file moved aside
    // whenever it passed 64 MB: 171 pieces cut at arbitrary records, in an
    // archive nothing read.
    if is_labdirector_dialogue_path(events_path) {
        let dialogue = SegmentedLog::replacing(events_path);
        let segment = dialogue.append(&row)?;
        make_runtime_path_collaborative(&dialogue.dir);
        make_runtime_path_collaborative(&segment);
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path)?;
    writeln!(file, "{}", serde_json::to_string(&row)?)?;
    make_runtime_path_collaborative(events_path);
    Ok(())
}

fn truncated_text(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= limit {
        return trimmed.to_string();
    }
    format!(
        "{} [truncated]",
        trimmed
            .chars()
            .take(limit.saturating_sub(12))
            .collect::<String>()
    )
}

fn inferred_failure_category(result_json: &Value) -> Option<String> {
    if let Some(category) = result_json.get("failure_category").and_then(Value::as_str) {
        return Some(category.to_string());
    }
    if result_json.get("timed_out").and_then(Value::as_bool) == Some(true) {
        return Some("timeout".to_string());
    }
    if result_json.get("retry_reason").and_then(Value::as_str) == Some("codex_auth_expired") {
        return Some("auth_refresh_wait".to_string());
    }
    let warning = result_json
        .get("warning")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if warning.contains("timeout") {
        return Some("timeout".to_string());
    }
    if warning.contains("rate limit") || warning.contains("rate_limit") {
        return Some("rate_limited".to_string());
    }
    if warning.contains("quota") || warning.contains("insufficient_quota") {
        return Some("quota_exceeded".to_string());
    }
    if warning.contains("context window")
        || warning.contains("context_length_exceeded")
        || warning.contains("maximum context length")
    {
        return Some("context_window_exceeded".to_string());
    }
    None
}

fn token_pressure_category(category: &str) -> bool {
    matches!(
        category,
        "quota_exceeded" | "rate_limited" | "auth_refresh_wait"
    )
}

fn result_payload_sources<'a>(result_json: &'a Value) -> Vec<&'a Value> {
    [
        "extracted_json",
        "chronicle_fallback",
        "author_fallback",
        "fallback_payload",
    ]
    .iter()
    .filter_map(|key| result_json.get(*key).filter(|value| value.is_object()))
    .collect()
}

fn first_nonempty_result_array(result_json: &Value, keys: &[&str]) -> Vec<Value> {
    for payload in result_payload_sources(result_json) {
        for key in keys {
            if let Some(array) = payload.get(*key).and_then(Value::as_array) {
                if !array.is_empty() {
                    return array.clone();
                }
            }
        }
    }
    Vec::new()
}

fn first_result_object(result_json: &Value, key: &str) -> Option<Value> {
    result_payload_sources(result_json)
        .into_iter()
        .find_map(|payload| payload.get(key).filter(|value| value.is_object()).cloned())
}

pub(crate) fn publish_brief_report(
    paths: &AppPaths,
    brief: &ChronicleBrief,
    lane_id: &str,
) -> Result<()> {
    let reports = chronicle_report_log(paths, &brief.cycle_id);
    if report_already_published_for_lane(&reports, lane_id) {
        return Ok(());
    }
    let lane_summary = brief
        .lane_summaries
        .iter()
        .find(|item| item.get("lane_id").and_then(Value::as_str) == Some(lane_id))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let role_plan_summary = lane_summary
        .get("role_plan")
        .cloned()
        .unwrap_or(Value::Null);
    let lane_root = paths
        .runtime_root
        .join("lanes")
        .join(&brief.cycle_id)
        .join(lane_id);
    let result_path = lane_root.join("result.json");
    let compact_stats_result_path = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(&brief.cycle_id)
        .join(lane_id)
        .join("result.json");
    let result_json = read_json_if_below(&result_path, CHRONICLE_REPORT_RESULT_READ_LIMIT_BYTES)
        .or_else(|| {
            read_json_if_below(
                &compact_stats_result_path,
                CHRONICLE_REPORT_RESULT_READ_LIMIT_BYTES,
            )
        })
        .unwrap_or_else(|| {
            json!({
                "status": "large_result_skipped",
                "summary": "chronicle report used the brief payload because lane result exceeded repeated-read limit",
            })
        });
    let fallback_payload = result_json
        .get("chronicle_fallback")
        .cloned()
        .or_else(|| result_json.get("author_fallback").cloned())
        .unwrap_or(Value::Null);
    let effective_claim_deltas = if brief.claim_deltas.is_empty() {
        first_nonempty_result_array(&result_json, &["claim_deltas"])
    } else {
        brief.claim_deltas.clone()
    };
    let effective_open_questions = if brief.open_questions.is_empty() {
        first_nonempty_result_array(&result_json, &["open_questions"])
    } else {
        brief
            .open_questions
            .iter()
            .map(|item| json!(item))
            .collect::<Vec<_>>()
    };
    let effective_recommended_actions = if brief.recommended_actions.is_empty() {
        first_nonempty_result_array(&result_json, &["recommended_actions", "next_actions"])
    } else {
        brief.recommended_actions.clone()
    };
    let effective_hypothesis_candidates = if brief.hypothesis_candidates.is_empty() {
        first_nonempty_result_array(&result_json, &["hypothesis_candidates"])
    } else {
        brief
            .hypothesis_candidates
            .iter()
            .map(|item| json!(item))
            .collect::<Vec<_>>()
    };
    let recovered_soft_complete_signals = (brief.claim_deltas.is_empty()
        && !effective_claim_deltas.is_empty())
        || (brief.open_questions.is_empty() && !effective_open_questions.is_empty())
        || (brief.recommended_actions.is_empty() && !effective_recommended_actions.is_empty())
        || (brief.hypothesis_candidates.is_empty() && !effective_hypothesis_candidates.is_empty());
    let effective_strategy_advice = if recovered_soft_complete_signals {
        first_result_object(&result_json, "strategy_advice")
            .unwrap_or_else(|| brief.strategy_advice.clone())
    } else {
        brief.strategy_advice.clone()
    };
    let rubric_targets = effective_recommended_actions
        .iter()
        .filter_map(|item| item.get("target_rubric").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let interpretation_schema = role_plan_summary
        .get("interpretation_schema")
        .cloned()
        .unwrap_or(Value::Null);
    // Derive claim-status breakdown from the deltas so downstream readers
    // (labdirector/mod.rs review_labdirector_inbox, research_report builder)
    // have non-null primary_claim_count/supporting_claim_count (revision P1-3).
    let mut claim_status_breakdown: std::collections::BTreeMap<String, u64> =
        std::collections::BTreeMap::new();
    let mut primary_claim_count: u64 = 0;
    let mut supporting_claim_count: u64 = 0;
    for delta in effective_claim_deltas.iter() {
        let current = delta
            .get("current")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !current.is_empty() {
            *claim_status_breakdown.entry(current.clone()).or_insert(0) += 1;
        }
        match current.as_str() {
            "robust" | "promoted" => primary_claim_count += 1,
            "exploratory" | "tentative" | "candidate" | "contending" | "strengthened" => {
                supporting_claim_count += 1
            }
            _ => {}
        }
    }

    let report = json!({
        "ts": now_iso(),
        "cycle_id": brief.cycle_id,
        "brief_id": brief.brief_id,
        "lane_id": lane_id,
        "claim_delta_count": effective_claim_deltas.len(),
        "claim_deltas": effective_claim_deltas,
        "primary_claim_count": primary_claim_count,
        "supporting_claim_count": supporting_claim_count,
        "claim_status_breakdown": claim_status_breakdown,
        "open_question_count": effective_open_questions.len(),
        "open_questions": effective_open_questions,
        "recommended_action_count": effective_recommended_actions.len(),
        "hypothesis_candidate_count": effective_hypothesis_candidates.len(),
        "hypothesis_candidates": effective_hypothesis_candidates,
        "strategy_advice": effective_strategy_advice,
        "lane_summaries": brief.lane_summaries,
        "role_plan_summary": role_plan_summary,
        "interpretation_schema": interpretation_schema,
        "rubric_targets": rubric_targets,
        "recommended_actions": effective_recommended_actions,
        "raw_output": result_json.get("output_last_message").cloned().unwrap_or(Value::Null),
        "extracted_json": result_json.get("extracted_json").cloned().unwrap_or(Value::Null),
        "fallback_payload": fallback_payload,
        "parse_warning": result_json.get("warning").cloned().unwrap_or(Value::Null),
    });

    reports.append(&report)?;
    labdirector_inbox_log(paths, &brief.cycle_id).append(&json!({
        "ts": now_iso(),
        "type": "chronicle_report",
        "payload": report,
    }))?;

    if let Some(failure_category) = inferred_failure_category(&result_json) {
        let token_pressure = token_pressure_category(&failure_category);
        let failure_notice = json!({
            "ts": now_iso(),
            "cycle_id": brief.cycle_id,
            "brief_id": brief.brief_id,
            "lane_id": lane_id,
            "role": role_plan_summary
                .get("role")
                .cloned()
                .unwrap_or(Value::Null),
            "assigned_model": role_plan_summary
                .get("assigned_model")
                .cloned()
                .unwrap_or(Value::Null),
            "failure_category": failure_category,
            "token_pressure": token_pressure,
            "degraded": result_json
                .get("degraded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "timed_out": result_json
                .get("timed_out")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "reason": result_json.get("reason").cloned().unwrap_or(Value::Null),
            "summary": result_json.get("summary").cloned().unwrap_or(Value::Null),
            "warning": result_json.get("warning").cloned().unwrap_or(Value::Null),
            "retry_reason": result_json
                .get("retry_reason")
                .cloned()
                .unwrap_or(Value::Null),
            "timeout_seconds": result_json
                .get("timeout_seconds")
                .cloned()
                .or_else(|| {
                    result_json
                        .get("role_plan")
                        .and_then(|value| value.get("constraints"))
                        .and_then(|value| value.get("timeout_seconds"))
                        .cloned()
                })
                .unwrap_or(Value::Null),
            "failure_excerpt": result_json
                .get("failure_excerpt")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "stdout": truncated_text(
                            result_json
                                .get("stdout")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            500
                        ),
                        "stderr": truncated_text(
                            result_json
                                .get("stderr")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            500
                        ),
                        "last_message": truncated_text(
                            result_json
                                .get("output_last_message")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            500
                        ),
                    })
                }),
            "result_path": result_path.display().to_string(),
            "prompt_path": result_json
                .get("prompt_path")
                .cloned()
                .unwrap_or(Value::Null),
            "invocation_path": result_json
                .get("invocation_path")
                .cloned()
                .unwrap_or(Value::Null),
            "output_last_message_path": result_json
                .get("output_last_message_path")
                .cloned()
                .unwrap_or(Value::Null),
            "role_plan_summary": role_plan_summary,
        });
        labdirector_inbox_log(paths, &brief.cycle_id).append(&json!({
            "ts": now_iso(),
            "type": "lane_failure_notice",
            "payload": failure_notice,
        }))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{append_event, publish_brief_report};
    use crate::core::model::{AppPaths, ChronicleBrief};
    use crate::core::support::segmented_log::{chronicle_report_log, labdirector_inbox_log, SegmentedLog};
    use serde_json::{json, Value};
    use std::fs;
    use tempfile::TempDir;

    fn build_paths(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join(".research-lab").join("datasets"),
            stats_driver_script: root.join("python_stats.py"),
            literature_driver_script: root.join("search.py"),
        }
    }

    #[test]
    fn the_dialogue_is_appended_by_the_hour_and_other_event_logs_are_not() {
        let tmp = TempDir::new().unwrap();
        let events_dir = tmp.path().join(".research-lab").join("events");
        fs::create_dir_all(&events_dir).unwrap();
        let dialogue_path = events_dir.join("cycle-a-labdirector-dialogue.jsonl");
        // A cycle that still has its single dialogue file keeps it as history.
        fs::write(&dialogue_path, "{\"event_type\":\"old\"}\n").unwrap();

        append_event(&dialogue_path, "new_event", json!({"ok": true})).unwrap();
        assert_eq!(fs::read_to_string(&dialogue_path).unwrap(), "{\"event_type\":\"old\"}\n");
        let dialogue = SegmentedLog::replacing(&dialogue_path);
        assert_eq!(dialogue.dir, events_dir.join("cycle-a-labdirector-dialogue"));
        let segments = dialogue.segments();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0], dialogue_path);
        assert!(crate::core::support::segmented_log::is_segment_name(
            segments[1].file_name().unwrap().to_str().unwrap()
        ));
        let mut types = Vec::new();
        dialogue
            .for_each_line(|line| {
                let row = serde_json::from_str::<Value>(line).unwrap();
                types.push(row["event_type"].as_str().unwrap().to_string());
            })
            .unwrap();
        assert_eq!(types, vec!["old", "new_event"]);

        // Any other event log is one file, as before.
        let supervisor_path = events_dir.join("cycle-a-supervisor-actions.jsonl");
        append_event(&supervisor_path, "supervisor_action", json!({"n": 1})).unwrap();
        append_event(&supervisor_path, "supervisor_action", json!({"n": 2})).unwrap();
        assert_eq!(fs::read_to_string(&supervisor_path).unwrap().lines().count(), 2);
    }

    #[test]
    fn publish_brief_report_promotes_soft_complete_embedded_arrays() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-soft-complete-report";
        let lane_id = "followup-chronicle-03";
        let lane_root = paths.runtime_root.join("lanes").join(cycle).join(lane_id);
        fs::create_dir_all(&lane_root).unwrap();

        let claim_deltas = (1..=6)
            .map(|idx| {
                json!({
                    "claim_id": format!("claim-{idx}"),
                    "previous": "tentative",
                    "current": "exploratory",
                    "reason": format!("reason-{idx}"),
                })
            })
            .collect::<Vec<_>>();
        let open_questions = (1..=3)
            .map(|idx| json!(format!("open-question-{idx}")))
            .collect::<Vec<_>>();
        let recommended_actions = (1..=4)
            .map(|idx| {
                json!({
                    "type": format!("action-{idx}"),
                    "priority": "high",
                    "description": format!("recommended-action-{idx}"),
                })
            })
            .collect::<Vec<_>>();
        let hypothesis_candidates = vec![json!("candidate-a"), json!("candidate-b")];

        let result_json = json!({
            "output_last_message": "{\"summary\":\"soft-complete payload with usable deltas\"}",
            "warning": "chronicle lane soft-completed from partial structured output after mixed-format model response",
            "extracted_json": {
                "summary": "soft-complete payload with usable deltas",
                "claim_deltas": claim_deltas,
                "open_questions": open_questions,
                "recommended_actions": recommended_actions,
                "hypothesis_candidates": hypothesis_candidates,
                "strategy_advice": {
                    "mode": "refine",
                    "reason": "embedded payload remains actionable"
                }
            },
            "chronicle_fallback": {
                "summary": "soft-complete payload with usable deltas",
                "claim_deltas": claim_deltas,
                "open_questions": open_questions,
                "recommended_actions": recommended_actions,
                "hypothesis_candidates": hypothesis_candidates,
                "strategy_advice": {
                    "mode": "refine",
                    "reason": "embedded payload remains actionable"
                }
            }
        });
        fs::write(
            lane_root.join("result.json"),
            serde_json::to_vec_pretty(&result_json).unwrap(),
        )
        .unwrap();

        let brief = ChronicleBrief {
            brief_id: "brief-soft-complete".to_string(),
            cycle_id: cycle.to_string(),
            claim_deltas: Vec::new(),
            lane_summaries: vec![json!({
                "lane_id": lane_id,
                "status": "completed",
                "summary": "followup-chronicle-03 lane completed",
                "role_plan": {
                    "role": "chronicle",
                    "action_type": "chronicle_serialization_fix",
                }
            })],
            open_questions: Vec::new(),
            recommended_actions: Vec::new(),
            hypothesis_candidates: Vec::new(),
            strategy_advice: json!({
                "mode": "hold",
                "reason": "initial signal is stable enough for reporting"
            }),
        };

        publish_brief_report(&paths, &brief, lane_id).unwrap();

        let mut report_rows = Vec::new();
        chronicle_report_log(&paths, cycle)
            .for_each_line(|line| report_rows.push(serde_json::from_str::<Value>(line).unwrap()))
            .unwrap();
        // The report is in this hour's segment, not in a single file.
        assert!(!chronicle_report_log(&paths, cycle).legacy.exists());
        let report = report_rows.last().unwrap().clone();
        assert_eq!(report["claim_delta_count"], json!(6));
        assert_eq!(report["open_question_count"], json!(3));
        assert_eq!(report["recommended_action_count"], json!(4));
        assert_eq!(report["hypothesis_candidate_count"], json!(2));
        assert_eq!(report["claim_deltas"].as_array().unwrap().len(), 6);
        assert_eq!(report["open_questions"].as_array().unwrap().len(), 3);
        assert_eq!(report["recommended_actions"].as_array().unwrap().len(), 4);
        assert_eq!(report["hypothesis_candidates"].as_array().unwrap().len(), 2);
        assert_eq!(report["strategy_advice"]["mode"], json!("refine"));

        let mut inbox_rows = Vec::new();
        labdirector_inbox_log(&paths, cycle)
            .for_each_line(|line| inbox_rows.push(serde_json::from_str::<Value>(line).unwrap()))
            .unwrap();
        let inbox_item = inbox_rows.last().unwrap().clone();
        let payload = &inbox_item["payload"];
        assert_eq!(payload["claim_delta_count"], json!(6));
        assert_eq!(payload["open_question_count"], json!(3));
        assert_eq!(payload["recommended_action_count"], json!(4));
        assert_eq!(payload["hypothesis_candidate_count"], json!(2));
        assert_eq!(payload["strategy_advice"]["mode"], json!("refine"));
    }
}
