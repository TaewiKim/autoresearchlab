use anyhow::Result;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{lane_role_plan_path, read_json};

pub(crate) fn optional_role_plan(
    paths: &AppPaths,
    contract: &LaneContract,
) -> Result<Option<Value>> {
    let path = lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json(&path)?))
}

fn nested_dataset_root(value: &Value) -> Option<PathBuf> {
    value
        .get("dataset_root")
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .map(PathBuf::from)
}

fn handoff_dataset_root(value: &Value) -> Option<PathBuf> {
    nested_dataset_root(value)
        .or_else(|| value.get("planner_metadata").and_then(handoff_dataset_root))
        .or_else(|| value.get("analysis_request").and_then(handoff_dataset_root))
        .or_else(|| {
            value
                .get("handoff_validation_plan")
                .and_then(handoff_dataset_root)
        })
        .or_else(|| value.get("analyst_handoff").and_then(handoff_dataset_root))
        .or_else(|| {
            value
                .get("cycle_analyst_handoff")
                .and_then(handoff_dataset_root)
        })
        .or_else(|| value.get("lab_runner").and_then(handoff_dataset_root))
        .or_else(|| value.get("runner").and_then(handoff_dataset_root))
        .or_else(|| value.get("payload").and_then(handoff_dataset_root))
}

fn dataset_root_from_handoff_path(value: &Value) -> Option<PathBuf> {
    let path = value.as_str().filter(|item| !item.trim().is_empty())?;
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > 10 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    handoff_dataset_root(&payload)
}

fn handoff_path_dataset_root(value: &Value) -> Option<PathBuf> {
    for key in [
        "analyst_handoff_path",
        "handoff_validation_plan_path",
        "cycle_analyst_handoff_path",
    ] {
        if let Some(dataset_root) = value.get(key).and_then(dataset_root_from_handoff_path) {
            return Some(dataset_root);
        }
    }
    for key in [
        "planner_metadata",
        "analysis_request",
        "review_action",
        "analyst_handoff",
        "handoff_validation_plan",
        "cycle_analyst_handoff",
        "lab_runner",
        "runner",
        "payload",
    ] {
        if let Some(dataset_root) = value.get(key).and_then(handoff_path_dataset_root) {
            return Some(dataset_root);
        }
    }
    None
}

pub(crate) fn role_plan_dataset_override(role_plan: Option<&Value>) -> Option<PathBuf> {
    let plan = role_plan?;
    handoff_dataset_root(plan).or_else(|| handoff_path_dataset_root(plan))
}
