use super::{
    all_cycle_contract_paths, analyst_handoff_payload, annotate_contract_queue_role_plan,
    build_codex_prompt, codex_disabled_features, codex_failure_category, codex_output_schema,
    codex_timeout_seconds, command_from_common_locations, contract_index_path, contract_queue_path,
    create_lane_contract, data_scout_should_fetch, is_gatekeeper_empty_output,
    normalize_chronicle_result_payload, normalize_graph_vocabulary, parse_codex_config_overrides,
    pipeline_queue_db_path, process_metadata, project_lab_director_payload_to_hypothesis,
    researchlab_codex_home, role_plan_dataset_override, update_sqlite_contract_queue_status,
    validate_process_metadata,
};
use crate::core::model::{AppPaths, LaneContract};
use serde_json::json;
use std::path::{Path, PathBuf};

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

fn write_tmp_graph(graph: serde_json::Value) -> PathBuf {
    let dir = tempfile::tempdir().expect("tempdir").keep();
    let path = dir.join("graph.json");
    std::fs::write(&path, serde_json::to_string(&graph).unwrap()).unwrap();
    path
}

fn test_contract(role: &str, task_file: PathBuf) -> LaneContract {
    LaneContract {
        cycle_id: "cycle-test".to_string(),
        lane_id: format!("{role}-01"),
        role: role.to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: PathBuf::from("."),
        task_file,
        allowed_inputs: vec![],
        allowed_outputs: vec![],
        output_artifact: None,
        fallback_strategy: None,
    }
}

fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        project_root: root.join("project"),
        runtime_root: root.join(".research-lab"),
        data_root: root.join("data"),
        stats_driver_script: root.join("stats-driver.js"),
        literature_driver_script: root.join("literature-driver.js"),
    }
}
