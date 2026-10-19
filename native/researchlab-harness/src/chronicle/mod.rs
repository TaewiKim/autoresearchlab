pub(crate) mod reporting;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, read_dir, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::chronicle::reporting::publish_brief_report;
use crate::core::model::{AppPaths, ChronicleBrief, StrategyDecision};
use crate::core::support::{
    chronicle_briefs_root, dedup_actions, dedup_claims, dedup_strings, events_root,
    lane_role_plan_path, lane_root, make_runtime_path_collaborative, now_iso, plans_root,
    read_json, slugify, state_root, viz_root, write_json,
};
use crate::runtime::all_cycle_contract_paths;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn build_paths(runtime_root: &Path) -> AppPaths {
        AppPaths {
            project_root: runtime_root.parent().unwrap_or(runtime_root).to_path_buf(),
            runtime_root: runtime_root.to_path_buf(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        }
    }

    fn write_contract(paths: &AppPaths, cycle: &str, lane_id: &str, role: &str) {
        let lane_dir = lane_root(paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("lane-contract.json"),
            &json!({
                "cycle_id": cycle,
                "lane_id": lane_id,
                "role": role,
                "runtime_class": "external-driver",
                "mode": "run",
                "cwd": paths.runtime_root,
                "task_file": lane_dir.join("task.md"),
                "allowed_inputs": [],
                "allowed_outputs": [],
                "output_artifact": null,
                "fallback_strategy": null,
            }),
        )
        .unwrap();
    }

    #[test]
    fn aggregate_prefers_terminal_final_status_over_stale_failed_run_state() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-terminal-final-status-wins";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(events_root(&paths)).unwrap();
        let lane_id = "followup-scout-270";
        write_contract(&paths, cycle, lane_id, "scout");
        let lane_dir = lane_root(&paths, cycle, lane_id);
        write_json(
            &lane_dir.join("run-state.json"),
            &json!({
                "lane_id": lane_id,
                "role": "scout",
                "runtime_class": "external-driver",
                "status": "failed",
                "error": "python stats driver failed"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "aborted",
                "reason": "manual_abort_to_prioritize_labdirector_gate_requery"
            }),
        )
        .unwrap();

        let state_path = aggregate_cycle(&paths, cycle).unwrap();
        let state = read_json(&state_path).unwrap();

        assert_eq!(state["lane_counts"]["failed"], json!(0));
        assert_eq!(state["lane_counts"]["aborted"], json!(1));
        assert_eq!(state["recovery_needed"], json!(false));
        assert_eq!(state["lane_statuses"][0]["status"], json!("aborted"));
    }

    #[test]
    fn aggregate_heals_cached_failed_status_from_terminal_final_status() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-cached-terminal-final-status-wins";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(events_root(&paths)).unwrap();
        let lane_id = "followup-scout-269";
        write_contract(&paths, cycle, lane_id, "scout");
        write_json(
            &lane_root(&paths, cycle, lane_id).join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "aborted",
                "reason": "manual_abort_to_prioritize_labdirector_gate_requery"
            }),
        )
        .unwrap();
        let mut lane_statuses = (0..40)
            .map(|idx| {
                json!({
                    "lane_id": format!("followup-runner-{idx:02}"),
                    "role": "lab-runner",
                    "status": "completed"
                })
            })
            .collect::<Vec<_>>();
        lane_statuses.push(json!({
            "lane_id": lane_id,
            "role": "unknown",
            "status": "failed"
        }));
        write_json(
            &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
            &json!({
                "cycle_id": cycle,
                "lane_statuses": lane_statuses
            }),
        )
        .unwrap();

        let state_path = aggregate_cycle(&paths, cycle).unwrap();
        let state = read_json(&state_path).unwrap();
        let healed = state["lane_statuses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|lane| lane["lane_id"] == json!(lane_id))
            .unwrap();

        assert_eq!(healed["status"], json!("aborted"));
        assert_eq!(state["lane_counts"]["failed"], json!(0));
        assert_eq!(state["lane_counts"]["aborted"], json!(1));
    }

    #[test]
    fn aggregate_does_not_heal_failed_lane_from_large_result_json() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-large-result-skip";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(events_root(&paths)).unwrap();
        let lane_id = "followup-runner-121";
        write_contract(&paths, cycle, lane_id, "lab-runner");
        let lane_dir = lane_root(&paths, cycle, lane_id);
        let result_path = lane_dir.join("result.json");
        fs::write(
            &result_path,
            serde_json::to_vec(&json!({
                "status": "completed",
                "padding": "x".repeat(5 * 1024 * 1024)
            }))
            .unwrap(),
        )
        .unwrap();
        write_json(
            &lane_dir.join("run-state.json"),
            &json!({
                "lane_id": lane_id,
                "role": "lab-runner",
                "status": "failed",
                "runtime_class": "external-driver",
                "result_path": result_path,
            }),
        )
        .unwrap();
        write_json(
            &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
            &json!({
                "cycle_id": cycle,
                "lane_statuses": [{
                    "lane_id": lane_id,
                    "role": "lab-runner",
                    "status": "failed",
                    "runtime_class": "external-driver",
                    "result_path": result_path,
                }],
                "recent_events": []
            }),
        )
        .unwrap();

        let state_path = aggregate_cycle(&paths, cycle).unwrap();
        let state = read_json(&state_path).unwrap();
        let lane_status = state["lane_statuses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|lane| lane["lane_id"] == json!(lane_id))
            .unwrap();

        assert_eq!(lane_status["status"], json!("failed"));
    }

    #[test]
    fn aggregate_treats_obsolete_reconciled_failures_as_aborted() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-obsolete-reconciled-failure";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(events_root(&paths)).unwrap();
        let lane_id = "followup-lab-director-196";
        write_contract(&paths, cycle, lane_id, "lab-director");
        write_json(
            &lane_root(&paths, cycle, lane_id).join("final-status.json"),
            &json!({
                "status": "failed",
                "completed_at": "2026-05-19T00:33:13.867Z",
                "error": "obsolete_role_plan_missing_operator_selected_gse322943_constraint"
            }),
        )
        .unwrap();

        let state_path = aggregate_cycle(&paths, cycle).unwrap();
        let state = read_json(&state_path).unwrap();

        assert_eq!(state["lane_counts"]["failed"], json!(0));
        assert_eq!(state["lane_counts"]["aborted"], json!(1));
        assert_eq!(state["recovery_needed"], json!(false));
    }

    #[test]
    fn aggregate_heals_cached_superseded_failures_as_aborted() {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "cycle-cached-superseded-failure";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(events_root(&paths)).unwrap();
        let lane_id = "followup-lab-director-191";
        write_contract(&paths, cycle, lane_id, "lab-director");
        write_json(
            &lane_root(&paths, cycle, lane_id).join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "failed",
                "completed_at": "2026-05-19T02:12:02Z",
                "error": "obsolete_planned_analyst_handoff_review_superseded_by_latest_labdirector_lead",
                "superseded_by_runtime_reconciliation": true
            }),
        )
        .unwrap();
        write_json(
            &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
            &json!({
                "cycle_id": cycle,
                "lane_statuses": [{
                    "lane_id": lane_id,
                    "role": "unknown",
                    "status": "failed"
                }]
            }),
        )
        .unwrap();

        let state_path = aggregate_cycle(&paths, cycle).unwrap();
        let state = read_json(&state_path).unwrap();

        assert_eq!(state["lane_counts"]["failed"], json!(0));
        assert_eq!(state["lane_counts"]["aborted"], json!(1));
        assert_eq!(state["recovery_needed"], json!(false));
    }
    include!("tests/recovery_lane_visibility.rs");
}

#[path = "lane_index.rs"]
mod lane_index;
pub(crate) use lane_index::*;
#[path = "briefs.rs"]
mod briefs;
pub(crate) use briefs::*;
#[path = "aggregate.rs"]
mod aggregate;
pub(crate) use aggregate::*;
#[path = "projections.rs"]
mod projections;
pub(crate) use projections::*;
#[path = "reports.rs"]
mod reports;
pub(crate) use reports::*;
#[path = "paper.rs"]
mod paper;
pub(crate) use paper::*;
