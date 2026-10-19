use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::core::model::AppPaths;
use crate::core::support::{lane_root, read_json};

use super::lane_identity::{default_followup_action_for_role, infer_followup_role_from_lane_id};
use super::lane_state::{cached_large_cycle_lane_statuses, lane_dirs_from_contract_index};

pub(crate) fn read_role_plan_if_compact(role_plan_path: &Path) -> Result<Option<Value>> {
    if !role_plan_path.exists() {
        return Ok(None);
    }
    if fs::metadata(role_plan_path)?.len() > 5 * 1024 * 1024 {
        return Ok(None);
    }
    Ok(Some(read_json(role_plan_path)?))
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RolePlanIndexFields {
    pub role: Option<String>,
    pub action_type: Option<String>,
    pub source_brief_id: Option<String>,
}

#[derive(Debug, Clone)]
struct RolePlanIndexCacheEntry {
    len: u64,
    modified: Option<SystemTime>,
    fields: Option<RolePlanIndexFields>,
}

static ROLE_PLAN_INDEX_CACHE: OnceLock<Mutex<HashMap<PathBuf, RolePlanIndexCacheEntry>>> =
    OnceLock::new();

fn role_plan_index_cache() -> &'static Mutex<HashMap<PathBuf, RolePlanIndexCacheEntry>> {
    ROLE_PLAN_INDEX_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn read_role_plan_index_fields(
    role_plan_path: &Path,
) -> Result<Option<RolePlanIndexFields>> {
    if !role_plan_path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(role_plan_path)?;
    let cache_key = role_plan_path.to_path_buf();
    let modified = metadata.modified().ok();
    if let Ok(cache) = role_plan_index_cache().lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.len == metadata.len() && entry.modified == modified {
                return Ok(entry.fields.clone());
            }
        }
    }
    let mut file = fs::File::open(role_plan_path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let bytes_read = file.read(&mut buffer)?;
    let raw = String::from_utf8_lossy(&buffer[..bytes_read]);
    let mut fields = RolePlanIndexFields::default();
    for line in raw.lines() {
        if !line.starts_with("  \"") {
            continue;
        }
        if fields.role.is_none() && line.starts_with("  \"role\":") {
            fields.role = parse_json_line_string_value(line);
        } else if fields.action_type.is_none() && line.starts_with("  \"action_type\":") {
            fields.action_type = parse_json_line_string_value(line);
        } else if fields.source_brief_id.is_none() && line.starts_with("  \"source_brief_id\":") {
            fields.source_brief_id = parse_json_line_string_value(line);
        }
        if fields.role.is_some() && fields.action_type.is_some() && fields.source_brief_id.is_some()
        {
            break;
        }
    }
    // Keep this hot-path bounded. Some older/large role plans do not place
    // source_brief_id near the top; reading the whole file for every follow-up
    // count pass makes run-plan stall on large cycles. Role/action are required
    // for counts, while source_brief_id is only a best-effort dedupe key.
    if bytes_read == buffer.len() && (fields.role.is_none() || fields.action_type.is_none()) {
        let raw = fs::read_to_string(role_plan_path)?;
        for line in raw.lines().skip_while(|line| !line.starts_with("  \"")) {
            if fields.role.is_none() && line.starts_with("  \"role\":") {
                fields.role = parse_json_line_string_value(line);
            } else if fields.action_type.is_none() && line.starts_with("  \"action_type\":") {
                fields.action_type = parse_json_line_string_value(line);
            } else if fields.source_brief_id.is_none() && line.starts_with("  \"source_brief_id\":")
            {
                fields.source_brief_id = parse_json_line_string_value(line);
            }
            if fields.role.is_some()
                && fields.action_type.is_some()
                && fields.source_brief_id.is_some()
            {
                break;
            }
        }
    }
    if fields.role.is_none() && fields.action_type.is_none() && fields.source_brief_id.is_none() {
        if let Some(role_plan) = read_role_plan_if_compact(role_plan_path)? {
            fields.role = role_plan
                .get("role")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            fields.action_type = role_plan
                .get("action_type")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            fields.source_brief_id = role_plan
                .get("source_brief_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
    }
    let result = Some(fields);
    if let Ok(mut cache) = role_plan_index_cache().lock() {
        cache.insert(
            cache_key,
            RolePlanIndexCacheEntry {
                len: metadata.len(),
                modified,
                fields: result.clone(),
            },
        );
    }
    Ok(result)
}

fn parse_json_line_string_value(line: &str) -> Option<String> {
    let value = line.split_once(':')?.1.trim().trim_end_matches(',').trim();
    serde_json::from_str::<String>(value).ok()
}

pub(crate) fn count_followup_lanes_by_role(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, usize>> {
    let mut counts = HashMap::new();
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if !lane_id.starts_with("followup-") {
                continue;
            }
            let role = lane
                .get("role")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| infer_followup_role_from_lane_id(lane_id));
            *counts.entry(role).or_insert(0) += 1;
        }
        return Ok(counts);
    }

    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.starts_with("followup-") {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let role = read_role_plan_index_fields(&role_plan_path)?
            .and_then(|fields| fields.role)
            .unwrap_or_else(|| infer_followup_role_from_lane_id(&lane_id));
        *counts.entry(role).or_insert(0) += 1;
    }

    Ok(counts)
}

pub(crate) fn total_followup_lane_count(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    Ok(lane_dirs_from_contract_index(paths, cycle_id)?
        .into_iter()
        .filter(|(lane_id, _)| lane_id.starts_with("followup-"))
        .count())
}

pub(crate) fn count_followup_lanes_by_role_and_action(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, usize>> {
    count_followup_lanes_by_role_and_action_with_filter(paths, cycle_id, false)
}

pub(crate) fn count_open_followup_lanes_by_role_and_action(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, usize>> {
    count_followup_lanes_by_role_and_action_with_filter(paths, cycle_id, true)
}

pub(crate) fn count_completed_followup_lanes_by_role_and_action(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, usize>> {
    let mut counts = HashMap::new();
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if !lane_id.starts_with("followup-")
                || lane.get("status").and_then(Value::as_str) != Some("completed")
            {
                continue;
            }
            let lane_dir = lane_root(paths, cycle_id, lane_id);
            let role_plan_path = lane_dir.join("role-plan.json");
            let role_fields = read_role_plan_index_fields(&role_plan_path)?;
            let inferred_role = infer_followup_role_from_lane_id(lane_id);
            let role = role_fields
                .as_ref()
                .and_then(|fields| fields.role.as_deref())
                .or_else(|| lane.get("role").and_then(Value::as_str))
                .unwrap_or(&inferred_role);
            let action_type = role_fields
                .as_ref()
                .and_then(|fields| fields.action_type.as_deref())
                .unwrap_or_else(|| default_followup_action_for_role(role));
            let key = format!("{role}::{action_type}");
            *counts.entry(key).or_insert(0) += 1;
        }
        return Ok(counts);
    }

    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.starts_with("followup-") {
            continue;
        }
        let final_status_path = lane_dir.join("final-status.json");
        if !final_status_path.exists() {
            continue;
        }
        let final_status_text = fs::read_to_string(&final_status_path)?;
        if !final_status_text.contains("\"status\": \"completed\"")
            && !final_status_text.contains("\"status\":\"completed\"")
        {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let role_fields = read_role_plan_index_fields(&role_plan_path)?;
        let inferred_role = infer_followup_role_from_lane_id(&lane_id);
        let role = role_fields
            .as_ref()
            .and_then(|fields| fields.role.as_deref())
            .unwrap_or(&inferred_role);
        let action_type = role_fields
            .as_ref()
            .and_then(|fields| fields.action_type.as_deref())
            .unwrap_or_else(|| default_followup_action_for_role(role));
        let key = format!("{role}::{action_type}");
        *counts.entry(key).or_insert(0) += 1;
    }

    Ok(counts)
}

fn count_followup_lanes_by_role_and_action_with_filter(
    paths: &AppPaths,
    cycle_id: &str,
    open_only: bool,
) -> Result<HashMap<String, usize>> {
    let mut counts = HashMap::new();
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if !lane_id.starts_with("followup-") {
                continue;
            }
            if open_only
                && matches!(
                    lane.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "aborted" | "cancelled")
                )
            {
                continue;
            }
            let lane_dir = lane_root(paths, cycle_id, lane_id);
            let role_plan_path = lane_dir.join("role-plan.json");
            let role_fields = read_role_plan_index_fields(&role_plan_path)?;
            let inferred_role = infer_followup_role_from_lane_id(lane_id);
            let role = role_fields
                .as_ref()
                .and_then(|fields| fields.role.as_deref())
                .or_else(|| lane.get("role").and_then(Value::as_str))
                .unwrap_or(&inferred_role);
            let action_type = role_fields
                .as_ref()
                .and_then(|fields| fields.action_type.as_deref())
                .unwrap_or_else(|| default_followup_action_for_role(role));
            let key = format!("{role}::{action_type}");
            *counts.entry(key).or_insert(0) += 1;
        }
        return Ok(counts);
    }

    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.starts_with("followup-") {
            continue;
        }
        if open_only && lane_dir.join("final-status.json").exists() {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let role_fields = read_role_plan_index_fields(&role_plan_path)?;
        let inferred_role = infer_followup_role_from_lane_id(&lane_id);
        let role = role_fields
            .as_ref()
            .and_then(|fields| fields.role.as_deref())
            .unwrap_or(&inferred_role);
        let action_type = role_fields
            .as_ref()
            .and_then(|fields| fields.action_type.as_deref())
            .unwrap_or_else(|| default_followup_action_for_role(role));
        let key = format!("{role}::{action_type}");
        *counts.entry(key).or_insert(0) += 1;
    }

    Ok(counts)
}

