use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};
use std::fs::{self, read_dir};
use std::path::PathBuf;

use crate::chronicle::reporting::append_event;
use crate::core::model::AppPaths;
use crate::core::support::{
    cycle_lanes_root, lane_process_path, lane_root, now_iso, read_json, read_json_cached, state_root,
    write_json,
};
use crate::runtime::{
    abort_lane, all_cycle_contract_paths, process_is_alive, update_sqlite_contract_queue_status,
};

pub(crate) fn lane_dirs_from_contract_index(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Vec<(String, PathBuf)>> {
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        let mut lanes = lane_statuses
            .into_iter()
            .filter_map(|lane| {
                let lane_id = lane.get("lane_id")?.as_str()?.to_string();
                Some((lane_id.clone(), lane_root(paths, cycle_id, &lane_id)))
            })
            .collect::<Vec<_>>();
        lanes.sort_by(|a, b| a.0.cmp(&b.0));
        lanes.dedup_by(|a, b| a.0 == b.0);
        return Ok(lanes);
    }

    let mut lanes = all_cycle_contract_paths(paths, cycle_id)?
        .into_iter()
        .filter_map(|contract_path| {
            let lane_dir = contract_path.parent()?.to_path_buf();
            let lane_id = lane_dir.file_name()?.to_string_lossy().to_string();
            Some((lane_id, lane_dir))
        })
        .collect::<Vec<_>>();
    if lanes.len() < 32 {
        // Small or legacy cycles may contain manually materialized lane dirs.
        // Large active cycles stay on the contract index to avoid 9p stalls.
        let lanes_dir = cycle_lanes_root(paths, cycle_id);
        if lanes_dir.exists() {
            for entry in read_dir(&lanes_dir)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                lanes.push((
                    entry.file_name().to_string_lossy().to_string(),
                    entry.path(),
                ));
            }
        }
    }
    lanes.sort_by(|a, b| a.0.cmp(&b.0));
    lanes.dedup_by(|a, b| a.0 == b.0);
    Ok(lanes)
}

pub(crate) fn cached_large_cycle_lane_statuses(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Vec<Value>>> {
    let state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    if !state_path.exists() {
        return Ok(None);
    }
    let state = read_json_cached(&state_path)?;
    let lane_statuses = state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if lane_statuses.len() < 32 {
        return Ok(None);
    }
    Ok(Some(
        lane_statuses
            .into_iter()
            .map(|lane| overlay_open_lane_status_from_disk(paths, cycle_id, lane))
            .collect(),
    ))
}

fn overlay_open_lane_status_from_disk(paths: &AppPaths, cycle_id: &str, mut lane: Value) -> Value {
    let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
    if !matches!(status, "pending" | "prepared" | "running") {
        return lane;
    }
    let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) else {
        return lane;
    };
    let lane_dir = lane_root(paths, cycle_id, lane_id);
    let final_status_path = lane_dir.join("final-status.json");
    let disk_status = if final_status_path.exists() {
        read_json(&final_status_path).ok()
    } else {
        let run_state_path = lane_dir.join("run-state.json");
        if run_state_path.exists() {
            read_json(&run_state_path).ok()
        } else {
            None
        }
    };
    let Some(disk_status) = disk_status else {
        return lane;
    };
    let Some(actual_status) = disk_status.get("status").and_then(Value::as_str) else {
        return lane;
    };
    if matches!(actual_status, "pending" | "prepared" | "running") {
        return lane;
    }
    if let Some(object) = lane.as_object_mut() {
        object.insert("status".to_string(), json!(actual_status));
        for key in ["completed_at", "updated_at", "reason"] {
            if let Some(value) = disk_status.get(key).cloned() {
                object.insert(key.to_string(), value);
            }
        }
    }
    lane
}

pub(crate) fn finalize_orphaned_running_lane(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    reason: &str,
) -> Result<()> {
    let lane_dir = lane_root(paths, cycle_id, lane_id);
    let run_state_path = lane_dir.join("run-state.json");
    let final_status_path = lane_dir.join("final-status.json");
    let events_path = lane_dir.join("events.jsonl");
    let now = now_iso();

    // A lane that wrote its own final status is not an orphan. It finished, and
    // the reconciler arrived after it did.
    //
    // MEASURED ON cycle-g-v91, 2026-09-13. followup-runner-54 wrote
    // final-status.json `status: completed, degraded: false` at 20:03:08Z, with
    // a 92 KB result.json beside it and 177 KB of external artifacts --
    // validation-summary.json, summary.md, the lot -- and this function stamped
    // run-state.json `aborted / orphaned running lane detected during status
    // reconciliation` at the same second. The aggregate reads run-state, so a
    // finished render counted as an abort. The gatekeepers waiting on "a runner
    // for the newest analyst handoff" were never released, and the gate sat at
    // round 32 for three hours while ten of them stayed blocked.
    //
    // The `if !final_status_path.exists()` guard below shows the case was
    // already known: it protected the FILE and not the status anybody reads.
    //
    // Reconciled, not aborted: the lane's own terminal status is copied onto its
    // run state, and the fields the run state already carried (result_path,
    // role, runtime_class) are kept, because the consumers read those too.
    let finished_status = read_json(&final_status_path)
        .ok()
        .and_then(|status| {
            status
                .get("status")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .filter(|status| matches!(status.as_str(), "completed" | "failed"));

    if let Some(status) = finished_status {
        let mut run_state = read_json(&run_state_path).unwrap_or_else(|_| json!({}));
        if !run_state.is_object() {
            run_state = json!({});
        }
        run_state["lane_id"] = json!(lane_id);
        run_state["status"] = json!(status);
        run_state["updated_at"] = json!(now);
        run_state["reconciled_from_final_status"] = json!(true);
        write_json(&run_state_path, &run_state)?;
        let _ = fs::remove_file(lane_process_path(paths, cycle_id, lane_id));
        update_sqlite_contract_queue_status(
            paths,
            cycle_id,
            lane_id,
            &status,
            Some("reconciled from the lane's own final status"),
        )?;
        return Ok(());
    }

    write_json(
        &run_state_path,
        &json!({
            "lane_id": lane_id,
            "status": "aborted",
            "updated_at": now,
            "reason": reason,
        }),
    )?;
    if !final_status_path.exists() {
        write_json(
            &final_status_path,
            &json!({
                "lane_id": lane_id,
                "status": "aborted",
                "completed_at": now_iso(),
                "reason": reason,
            }),
        )?;
    }
    let process_path = lane_process_path(paths, cycle_id, lane_id);
    let _ = fs::remove_file(process_path);
    update_sqlite_contract_queue_status(paths, cycle_id, lane_id, "aborted", Some(reason))?;
    append_event(
        &events_path,
        "lane_aborted",
        json!({
            "lane_id": lane_id,
            "reason": reason,
        }),
    )?;
    Ok(())
}

pub(crate) fn lane_has_finalized_outputs(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> bool {
    // `result.json` is an incremental checkpoint for Scouts and may carry
    // `pending_review` while its worker is still alive.  Only an explicit
    // terminal final-status can release a worker slot or suppress recovery.
    let final_status_path = lane_root(paths, cycle_id, lane_id).join("final-status.json");
    read_json(&final_status_path)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .map(|status| matches!(status.as_str(), "completed" | "failed" | "aborted"))
        .unwrap_or(false)
}

pub(crate) fn lane_process_is_alive(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> bool {
    read_json(&lane_process_path(paths, cycle_id, lane_id))
        .ok()
        .and_then(|process| process.get("pid").and_then(Value::as_u64))
        .map(|pid| pid > 0 && process_is_alive(pid as u32))
        .unwrap_or(false)
}

pub(crate) fn running_lane_recently_updated(run_state: &Value, grace_seconds: i64) -> bool {
    let recent_ts = run_state
        .get("updated_at")
        .and_then(Value::as_str)
        .or_else(|| run_state.get("started_at").and_then(Value::as_str))
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    recent_ts
        .map(|value| (Utc::now() - value).num_seconds() <= grace_seconds)
        .unwrap_or(false)
}

pub(crate) fn abort_cycle_running_lanes(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    let mut aborted = Vec::new();
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let run_state_path = lane_dir.join("run-state.json");
        if !run_state_path.exists() {
            continue;
        }
        let run_state = read_json(&run_state_path)?;
        if run_state.get("status").and_then(Value::as_str) != Some("running") {
            continue;
        }
        if lane_has_finalized_outputs(paths, cycle_id, &lane_id) {
            continue;
        }
        let process_path = lane_process_path(paths, cycle_id, &lane_id);
        if process_path.exists() {
            aborted.push(abort_lane(paths, cycle_id, &lane_id)?);
        } else {
            finalize_orphaned_running_lane(
                paths,
                cycle_id,
                &lane_id,
                "orphaned running lane detected during cycle shutdown",
            )?;
            aborted.push(json!({
                "cycle_id": cycle_id,
                "lane_id": lane_id,
                "aborted": true,
                "reason": "orphaned running lane detected during cycle shutdown",
            }));
        }
    }
    Ok(aborted)
}
