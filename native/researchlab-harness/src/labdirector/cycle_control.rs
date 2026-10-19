use anyhow::Result;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

use crate::chronicle::reporting::append_event;
use crate::core::model::AppPaths;
use crate::core::support::{events_root, now_iso, read_json, state_root, write_json};

pub(crate) fn termination_code_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-termination-code.json"))
}

pub(crate) fn clear_termination_code(paths: &AppPaths, cycle_id: &str) -> Result<()> {
    let path = termination_code_path(paths, cycle_id);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn read_termination_code(paths: &AppPaths, cycle_id: &str) -> Result<Option<Value>> {
    let path = termination_code_path(paths, cycle_id);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json(&path)?))
}

// Gather a compact diagnostic record per lane whose final-status indicates
// trouble (degraded, failed, or stuck-running). Used to enrich the
// termination record so researchers don't have to hunt through 30+ lane
// directories to learn WHY the cycle stopped.
pub(crate) fn collect_lane_failure_diagnostics(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    let lanes_dir = paths.runtime_root.join("lanes").join(cycle_id);
    let mut records: Vec<Value> = Vec::new();
    let Ok(entries) = fs::read_dir(&lanes_dir) else {
        return records;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        if !lane_dir.is_dir() {
            continue;
        }
        let lane_id = lane_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let final_status = read_json(&lane_dir.join("final-status.json")).ok();
        let result = read_json(&lane_dir.join("result.json")).ok();
        let (status, degraded, failure_category, completed_at) = final_status
            .as_ref()
            .map(|fs| {
                (
                    fs.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    fs.get("degraded").and_then(Value::as_bool).unwrap_or(false),
                    fs.get("failure_category")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    fs.get("completed_at")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                )
            })
            .unwrap_or_else(|| ("missing".to_string(), false, None, None));
        // Skip lanes that are cleanly completed with no degradation — the
        // researcher does not need a diagnostic for those.
        let is_interesting = status != "completed"
            || degraded
            || failure_category.is_some()
            || result
                .as_ref()
                .map(|r| {
                    r.get("gate_review_empty_output")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
        if !is_interesting {
            continue;
        }
        // Top-level failure fields are produced by the live codex-agent
        // payload (when Codex actually ran and we annotated the lane
        // result). The synthetic codex-agent-fallback payload — written
        // when Codex timed out / hit quota / etc. — stashes the same info
        // under different keys. Try both so the diagnostic works for both
        // lane flavours.
        let error = result
            .as_ref()
            .and_then(|r| r.get("error").cloned())
            .unwrap_or(Value::Null);
        let warning = result
            .as_ref()
            .and_then(|r| r.get("warning").cloned())
            .unwrap_or(Value::Null);
        let reason = result
            .as_ref()
            .and_then(|r| r.get("reason").cloned())
            .unwrap_or(Value::Null);
        let driver = result
            .as_ref()
            .and_then(|r| r.get("driver").and_then(Value::as_str))
            .map(ToString::to_string);
        let timed_out = result
            .as_ref()
            .and_then(|r| r.get("timed_out").and_then(Value::as_bool))
            .unwrap_or(false);
        let returncode = result
            .as_ref()
            .and_then(|r| r.get("returncode").cloned())
            .unwrap_or(Value::Null);
        let timeout_seconds = result
            .as_ref()
            .and_then(|r| r.get("timeout_seconds").cloned())
            .unwrap_or(Value::Null);

        // Look in both top-level and failure_excerpt for the text blobs.
        let failure_excerpt = result
            .as_ref()
            .and_then(|r| r.get("failure_excerpt").cloned());
        let stderr_text = result
            .as_ref()
            .and_then(|r| r.get("stderr").and_then(Value::as_str))
            .map(ToString::to_string)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                failure_excerpt
                    .as_ref()
                    .and_then(|fe| fe.get("stderr").and_then(Value::as_str))
                    .map(ToString::to_string)
            })
            .unwrap_or_default();
        let stdout_text = result
            .as_ref()
            .and_then(|r| r.get("stdout").and_then(Value::as_str))
            .map(ToString::to_string)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                failure_excerpt
                    .as_ref()
                    .and_then(|fe| fe.get("stdout").and_then(Value::as_str))
                    .map(ToString::to_string)
            })
            .unwrap_or_default();
        let last_message_text = result
            .as_ref()
            .and_then(|r| r.get("output_last_message").and_then(Value::as_str))
            .map(ToString::to_string)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                failure_excerpt
                    .as_ref()
                    .and_then(|fe| fe.get("last_message").and_then(Value::as_str))
                    .map(ToString::to_string)
            })
            .unwrap_or_default();
        let stderr_preview = excerpt_text_for_diagnostics(&stderr_text, 1500);
        let stdout_preview = excerpt_text_for_diagnostics(&stdout_text, 1500);
        let last_message_preview = excerpt_text_for_diagnostics(&last_message_text, 800);
        let gate_empty = result
            .as_ref()
            .and_then(|r| r.get("gate_review_empty_output").and_then(Value::as_bool))
            .unwrap_or(false);
        // role can live either on result.role_plan.role OR as a top-level
        // ``role`` field on codex-agent-fallback payloads.
        let role = result
            .as_ref()
            .and_then(|r| {
                r.get("role_plan")
                    .and_then(|rp| rp.get("role"))
                    .and_then(Value::as_str)
                    .or_else(|| r.get("role").and_then(Value::as_str))
            })
            .map(ToString::to_string);
        records.push(json!({
            "lane_id": lane_id,
            "role": role,
            "driver": driver,
            "status": status,
            "degraded": degraded,
            "failure_category": failure_category,
            "gate_review_empty_output": gate_empty,
            "timed_out": timed_out,
            "timeout_seconds": timeout_seconds,
            "returncode": returncode,
            "completed_at": completed_at,
            "warning": warning,
            "error": error,
            "reason": reason,
            "output_last_message_preview": last_message_preview,
            "stderr_preview": stderr_preview,
            "stdout_preview": stdout_preview,
        }));
    }
    // Newest first so the most actionable failure is at index 0.
    records.sort_by(|a, b| {
        let ak = a.get("completed_at").and_then(Value::as_str).unwrap_or("");
        let bk = b.get("completed_at").and_then(Value::as_str).unwrap_or("");
        bk.cmp(ak)
    });
    records.truncate(12);
    records
}

fn excerpt_text_for_diagnostics(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(limit.saturating_sub(20)).collect();
    format!("{head}… [truncated]")
}

pub(crate) fn write_termination_code(
    paths: &AppPaths,
    cycle_id: &str,
    code: &str,
    category: &str,
    reason: &str,
    metadata: Value,
) -> Result<Value> {
    // Enrich non-success termination records with a lane-level diagnostic
    // bundle so researchers can see — without opening every lane dir — why
    // the cycle could not continue. The bundle includes each degraded /
    // failed lane's status, timeout, warning, error, and truncated
    // stdout/stderr/output_last_message from the Codex call that produced
    // the failure.
    let mut final_metadata = metadata;
    let is_success = category == "gate_passed" || code == "APPROVAL_GATE_PASSED";
    if !is_success {
        let diagnostics = collect_lane_failure_diagnostics(paths, cycle_id);
        if let Value::Object(ref mut map) = final_metadata {
            if !diagnostics.is_empty() {
                map.insert(
                    "lane_failure_diagnostics".to_string(),
                    Value::Array(diagnostics.clone()),
                );
                map.insert(
                    "lane_failure_diagnostics_count".to_string(),
                    json!(diagnostics.len()),
                );
            }
        }
    }
    let payload = json!({
        "cycle_id": cycle_id,
        "generated_at": now_iso(),
        "code": code,
        "category": category,
        "reason": reason,
        "source": "lab-director",
        "should_stop": true,
        "metadata": final_metadata,
    });
    write_json(&termination_code_path(paths, cycle_id), &payload)?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_termination_code_written",
        payload.clone(),
    )?;
    Ok(payload)
}

fn legacy_pause_marker_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("runtime")
        .join(format!("{cycle_id}-labdirector-pause.json"))
}

pub(crate) fn shared_pause_marker_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-labdirector-pause.json"))
}

/// Whether the cycle is paused, with the shared marker as the one authority.
///
/// A pause is written twice -- the state-root marker everything else reads, and
/// a legacy copy under runtime/ kept for native callers. Treating the two as
/// equals meant either could outlive the other, and the legacy one did: the
/// owner cleared the marker the JS side and the operator both look at, the
/// cycle stayed paused on a file nothing surfaces, and the dispatch loop slept
/// on `while is_cycle_paused` with no output and almost no CPU.
///
/// MEASURED ON cycle-a-20260919, 2026-09-23: six hours of run-plan
/// that never dispatched a lane, 3 s of user CPU across a seven-minute pass,
/// and a state file last written the previous afternoon.
///
/// A new pause always writes both, so a missing shared marker means a resume
/// happened; the leftover is cleared rather than obeyed.
pub(crate) fn is_cycle_paused(paths: &AppPaths, cycle_id: &str) -> bool {
    if shared_pause_marker_path(paths, cycle_id).exists() {
        return true;
    }
    let legacy = legacy_pause_marker_path(paths, cycle_id);
    if legacy.exists() {
        let _ = fs::remove_file(&legacy);
    }
    false
}

pub(crate) fn write_pause_marker(paths: &AppPaths, cycle_id: &str, reason: &str) -> Result<Value> {
    let path = shared_pause_marker_path(paths, cycle_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = json!({
        "cycle_id": cycle_id,
        "paused_at": now_iso(),
        "reason": reason,
        "source": "researcher",
    });
    write_json(&path, &payload)?;
    // Keep existing native callers compatible while the JS orchestrator reads
    // the shared state-root marker.
    let legacy_path = legacy_pause_marker_path(paths, cycle_id);
    if let Some(parent) = legacy_path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json(&legacy_path, &payload)?;
    Ok(payload)
}

pub(crate) fn clear_pause_marker(paths: &AppPaths, cycle_id: &str) -> Result<()> {
    for path in [
        shared_pause_marker_path(paths, cycle_id),
        legacy_pause_marker_path(paths, cycle_id),
    ] {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod pause_marker_tests {
    use super::*;
    use tempfile::TempDir;

    fn paths(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.parent().unwrap_or(root).to_path_buf(),
            runtime_root: root.to_path_buf(),
            data_root: root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        }
    }

    // cycle-a-20260919, 2026-09-23: the owner cleared the marker the
    // JS side and the operator both read, and the cycle stayed paused for six
    // hours on the legacy copy under runtime/, which nothing surfaces.
    #[test]
    fn a_legacy_marker_alone_does_not_keep_a_cycle_paused() {
        let temp = TempDir::new().unwrap();
        let paths = paths(temp.path());
        let cycle_id = "cycle-paused";

        // A real pause writes both, and both mean paused.
        write_pause_marker(&paths, cycle_id, "owner asked").unwrap();
        assert!(shared_pause_marker_path(&paths, cycle_id).exists());
        assert!(legacy_pause_marker_path(&paths, cycle_id).exists());
        assert!(is_cycle_paused(&paths, cycle_id));

        // A resume clears the one everything reads; the leftover must not
        // outlive it, and must not be obeyed.
        fs::remove_file(shared_pause_marker_path(&paths, cycle_id)).unwrap();
        assert!(!is_cycle_paused(&paths, cycle_id), "a leftover held the cycle");
        assert!(
            !legacy_pause_marker_path(&paths, cycle_id).exists(),
            "the leftover is cleared, not just ignored"
        );
    }
}
