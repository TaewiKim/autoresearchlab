use anyhow::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;

use crate::core::model::AppPaths;
use crate::core::support::{
    lane_result_fields, lane_root, read_json, read_lane_final_status, state_root,
};

use super::lane_state::lane_dirs_from_contract_index;

pub(crate) fn dependency_base_lane_id(lane_id: &str) -> String {
    let mut current = lane_id.to_string();
    loop {
        if let Some((prefix, _)) = current.rsplit_once("-recovery-") {
            current = prefix.to_string();
            continue;
        }
        return current;
    }
}

fn cached_cycle_lane_statuses(paths: &AppPaths, cycle_id: &str) -> Result<Option<Vec<Value>>> {
    let path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    if !path.exists() {
        return Ok(None);
    }
    let value = read_json(&path)?;
    Ok(value
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned())
}

pub(crate) fn cached_completed_lanes_for_role(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
) -> Result<Option<HashSet<String>>> {
    let Some(lane_statuses) = cached_cycle_lane_statuses(paths, cycle_id)? else {
        return Ok(None);
    };
    let mut lanes = HashSet::new();
    for lane in lane_statuses {
        if lane.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        if lane.get("role").and_then(Value::as_str) != Some(role) {
            continue;
        }
        if let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) {
            lanes.insert(lane_id.to_string());
        }
    }
    Ok(Some(lanes))
}

pub(crate) fn completed_role_counts(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, usize>> {
    let mut best_by_base: HashMap<String, String> = HashMap::new();
    if let Some(lane_statuses) = cached_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            if lane.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            let lane_id = lane
                .get("lane_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if lane_id.is_empty() {
                continue;
            }
            let role = lane
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            best_by_base
                .entry(dependency_base_lane_id(&lane_id))
                .or_insert(role);
        }
        // The cached cycle-run-state lane_statuses snapshot omits dynamically-
        // created recovery lanes (e.g. `chronicle-01-recovery-01`). A completed
        // recovery lane satisfies a dependency on its aborted/failed root, so
        // merge completed recovery lanes from the contract index, keyed by their
        // base lane id. Without this, a downstream lane gated on a completed
        // predecessor (e.g. the lab-director synthesis lane requires a completed
        // chronicle) never becomes ready when the original lane aborted and only
        // its recovery completed — deadlocking the cycle past the recovery.
        for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
            if !lane_id.contains("-recovery-") {
                continue;
            }
            let base_id = dependency_base_lane_id(&lane_id);
            if best_by_base.contains_key(&base_id) {
                continue;
            }
            let final_status_path = lane_dir.join("final-status.json");
            if !final_status_path.exists() {
                continue;
            }
            let Some(final_status) = read_lane_final_status(&final_status_path)? else {
                continue;
            };
            if final_status.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            let run_state_path = lane_dir.join("run-state.json");
            let role = if run_state_path.exists() {
                read_json(&run_state_path)?
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string()
            } else {
                final_status
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string()
            };
            best_by_base.entry(base_id).or_insert(role);
        }
        let mut counts = HashMap::new();
        for role in best_by_base.into_values() {
            *counts.entry(role).or_insert(0) += 1;
        }
        return Ok(counts);
    }

    for (indexed_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let run_state_path = lane_dir.join("run-state.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !run_state_path.exists() || !final_status_path.exists() {
            continue;
        }
        let run_state = read_json(&run_state_path)?;
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let lane_id = run_state
            .get("lane_id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or(indexed_lane_id);
        let role = run_state
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let base_id = dependency_base_lane_id(&lane_id);
        best_by_base.entry(base_id).or_insert(role);
    }
    let mut counts = HashMap::new();
    for role in best_by_base.into_values() {
        *counts.entry(role).or_insert(0) += 1;
    }
    Ok(counts)
}

fn result_has_completed_literature_evidence(result_path: &std::path::Path) -> Result<bool> {
    // Lane results are expected to be compact. A result too large to inspect
    // cannot prove literature readiness and must not unblock downstream work.
    if !result_path.exists() || fs::metadata(result_path)?.len() > 5 * 1024 * 1024 {
        return Ok(false);
    }
    let result = lane_result_fields(
        result_path,
        &[
            "paper_count",
            "papers",
            "driver",
            "search_agent_assessment",
            "search_decision_ready",
            "search_complete",
        ],
    )?;
    let paper_count = result
        .get("paper_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let admitted_papers = result
        .get("papers")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    // Preserve compatibility with the direct Python literature driver. Its
    // admission boundary predates the canonical search-agent assessment.
    if result.get("driver").and_then(Value::as_str) == Some("literature-search-driver") {
        return Ok(paper_count > 0);
    }

    // Reasoning Codex Scouts retain their executor driver name. Count them only
    // after the deterministic post-exit validator marked the search decision
    // ready and preserved a nonempty set of admitted papers.
    let assessment_ready = result
        .pointer("/search_agent_assessment/decision_ready")
        .and_then(Value::as_bool)
        == Some(true)
        && result
            .pointer("/search_agent_assessment/valid")
            .and_then(Value::as_bool)
            == Some(true);
    let search_complete = result.get("search_decision_ready").and_then(Value::as_bool)
        == Some(true)
        || result.get("search_complete").and_then(Value::as_bool) == Some(true);
    Ok(assessment_ready && search_complete && paper_count > 0 && admitted_papers > 0)
}

pub(crate) fn completed_literature_scout_count(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    let mut completed: HashSet<String> = HashSet::new();
    if let Some(lane_statuses) = cached_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            if lane.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            if lane.get("role").and_then(Value::as_str) != Some("scout") {
                continue;
            }
            if let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) {
                let result_path = lane_root(paths, cycle_id, lane_id).join("result.json");
                if !result_has_completed_literature_evidence(&result_path)? {
                    continue;
                }
                completed.insert(dependency_base_lane_id(lane_id));
            }
        }
        return Ok(completed.len());
    }

    for (indexed_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let run_state_path = lane_dir.join("run-state.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !run_state_path.exists() || !final_status_path.exists() || !result_path.exists() {
            continue;
        }
        let run_state = read_json(&run_state_path)?;
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        if run_state.get("role").and_then(Value::as_str) != Some("scout") {
            continue;
        }
        if !result_has_completed_literature_evidence(&result_path)? {
            continue;
        }
        let lane_id = run_state
            .get("lane_id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or(indexed_lane_id);
        completed.insert(dependency_base_lane_id(&lane_id));
    }
    Ok(completed.len())
}

fn completed_data_scout_count_from_sqlite_queue(paths: &AppPaths, cycle_id: &str) -> Option<usize> {
    let db_path = paths.runtime_root.join("queues").join("pipeline.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let cycle_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pipeline_queue WHERE cycle_id = ?1",
            rusqlite::params![cycle_id],
            |row| row.get(0),
        )
        .ok()?;
    if cycle_rows == 0 {
        return None;
    }
    let mut stmt = conn
        .prepare(
            "SELECT lane_id FROM pipeline_queue \
             WHERE cycle_id = ?1 AND role = 'scout' \
               AND action_type = 'data_acquisition_followup' \
               AND status = 'completed'",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![cycle_id], |row| row.get::<_, String>(0))
        .ok()?;
    let mut completed: HashSet<String> = HashSet::new();
    for lane_id in rows.flatten() {
        completed.insert(dependency_base_lane_id(&lane_id));
    }
    Some(completed.len())
}

pub(crate) fn completed_data_scout_count(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    // A ZERO from the queue is not an answer, it is a missing answer.
    //
    // The queue only counts scout rows tagged action_type='data_acquisition_followup'.
    // cycle-g-v84's three scouts were queued with action_type NULL, so the query
    // returned 0 -- authoritatively, short-circuiting the disk scan below that
    // would have seen scout-01's completed native-readonly-scan with a dataset
    // candidate. chronicle stayed blocked on data_scout_completed=0, the
    // lab-director stayed blocked on chronicle, no followup could be created, and
    // the cycle spent two hours at 19 pending / 0 running before terminating
    // itself twice with STAGNATION_HARD_STALL.
    //
    // A positive count is trusted; a zero falls through to the evidence on disk,
    // which checks what a lane actually DID rather than how it was tagged.
    match completed_data_scout_count_from_sqlite_queue(paths, cycle_id) {
        Some(count) if count > 0 => return Ok(count),
        _ => {}
    }
    let mut completed: HashSet<String> = HashSet::new();
    for (indexed_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let result_path = lane_dir.join("result.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !result_path.exists() || !final_status_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        if fs::metadata(&result_path)?.len() > 5 * 1024 * 1024 {
            continue;
        }
        let result = lane_result_fields(
            &result_path,
            &["driver", "dataset_candidates", "lane_id"],
        )?;
        // A completed data scan counts, whichever scanner produced it.
        //
        // THE DEADLOCK THIS BREAKS (cycle-g-v84). Requiring `data-scout-browser`
        // specifically made chronicle wait for a lane that could not exist yet:
        //
        //   chronicle    <- waits for a completed DATA scout
        //   lab-director <- waits for a completed chronicle
        //   followups    <- only the lab-director creates them
        //   data-scout-browser lanes are only ever created as followups
        //
        // v84 opened with scout-01 running `native-readonly-scan`, which completed
        // and reported a dataset candidate. It was not counted, so chronicle stayed
        // blocked on data_scout_completed=0, the director stayed blocked on
        // chronicle_completed=0, no followup was ever created, and after an hour of
        // 19 pending / 0 running lanes the cycle terminated itself with
        // STAGNATION_HARD_STALL and created_followups_count=0.
        //
        // The requirement is also wrong on its own terms for this objective: a
        // computer-graphics cycle builds its validation data PROCEDURALLY in code
        // (see the materialized_bundle_mandate for the cs domain - "validation data
        // is generated procedurally, not downloaded"), so a browser scout that
        // fetches external bundles is never what unblocks it.
        //
        // What the gate actually needs to know is that SOME lane has established
        // the dataset picture. A readonly scan that produced candidates has done
        // exactly that; one that produced nothing has not, and still does not count.
        let driver = result.get("driver").and_then(Value::as_str);
        let counts_as_data_scan = match driver {
            Some("data-scout-browser") => true,
            Some("native-readonly-scan") => result
                .get("dataset_candidates")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false),
            _ => false,
        };
        if !counts_as_data_scan {
            continue;
        }
        let lane_id = result
            .get("lane_id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or(indexed_lane_id);
        completed.insert(dependency_base_lane_id(&lane_id));
    }
    Ok(completed.len())
}

#[cfg(test)]
mod literature_count_tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn test_paths(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("datasets"),
            stats_driver_script: PathBuf::from("unused-stats.py"),
            literature_driver_script: PathBuf::from("unused-literature.py"),
        }
    }

    fn write_cached_lane(paths: &AppPaths, cycle: &str, lane_id: &str, result: Value) {
        let lane_dir = lane_root(paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        fs::create_dir_all(state_root(paths)).unwrap();
        fs::write(
            lane_dir.join("result.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        fs::write(
            state_root(paths).join(format!("{cycle}-cycle-run-state.json")),
            serde_json::to_vec_pretty(&json!({
                "lane_statuses": [{
                    "lane_id": lane_id,
                    "role": "scout",
                    "runtime_class": result.get("runtime_class").cloned().unwrap_or(Value::Null),
                    "status": "completed"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn incomplete_unrelated_final_status_does_not_block_completed_data_scout() {
        // MEASURED ON cycle-a-20260919, 2026-10-04: while analysis
        // waited to advance to gate_review, followup-lab-director-403 had an
        // empty final-status.json and completed_data_scout_count returned EOF
        // instead of allowing the planner to continue past the stuck state.
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "cycle-a-20260919";

        let incomplete_dir = lane_root(&paths, cycle, "followup-lab-director-403");
        fs::create_dir_all(&incomplete_dir).unwrap();
        fs::write(incomplete_dir.join("final-status.json"), "").unwrap();
        fs::write(incomplete_dir.join("result.json"), "").unwrap();

        let scout_dir = lane_root(&paths, cycle, "followup-scout-001");
        fs::create_dir_all(&scout_dir).unwrap();
        fs::write(
            scout_dir.join("final-status.json"),
            serde_json::to_vec(&json!({"status": "completed"})).unwrap(),
        )
        .unwrap();
        fs::write(
            scout_dir.join("result.json"),
            serde_json::to_vec(&json!({
                "lane_id": "followup-scout-001",
                "driver": "data-scout-browser"
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            completed_data_scout_count(&paths, cycle).unwrap(),
            1,
            "the valid scout must still release planning toward gate_review"
        );
    }

    #[test]
    fn cached_completed_readonly_scout_is_not_literature_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "cached-readonly";
        write_cached_lane(
            &paths,
            cycle,
            "scout-01",
            json!({
                "runtime_class": "native-readonly",
                "driver": "native-readonly-scan",
                "paper_count": 9,
                "status": "completed"
            }),
        );

        assert_eq!(completed_literature_scout_count(&paths, cycle).unwrap(), 0);
    }

    #[test]
    fn cached_validated_codex_scout_with_admitted_papers_is_literature_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "cached-reviewed-literature";
        write_cached_lane(
            &paths,
            cycle,
            "scout-02",
            json!({
                "runtime_class": "codex-agent",
                "driver": "codex-agent-executor",
                "paper_count": 1,
                "papers": [{"title": "independently screened paper"}],
                "search_agent_assessment": {"valid": true, "decision_ready": true},
                "search_decision_ready": true,
                "status": "completed"
            }),
        );

        assert_eq!(completed_literature_scout_count(&paths, cycle).unwrap(), 1);
    }

    #[test]
    fn legacy_literature_driver_with_papers_remains_compatible() {
        let temp = tempfile::tempdir().unwrap();
        let result_path = temp.path().join("result.json");
        fs::write(
            &result_path,
            serde_json::to_vec(&json!({
                "driver": "literature-search-driver",
                "paper_count": 2
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(result_has_completed_literature_evidence(&result_path).unwrap());
    }
}
