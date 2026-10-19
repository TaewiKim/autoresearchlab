#![allow(unused_imports)]
use super::*;

pub(crate) fn base_lane_id(lane_id: &str) -> String {
    let mut current = lane_id.to_string();
    loop {
        if let Some((prefix, _)) = current.rsplit_once("-recovery-") {
            current = prefix.to_string();
            continue;
        }
        return current;
    }
}

/// Which of two lanes sharing a base id is the one the cycle should be judged on.
///
/// Status ranks FIRST, and being a recovery lane only breaks a tie. The bonus
/// used to dominate: a recovery lane scored +100 against a status range of
/// 0..40, so a recovery that FAILED outranked the lane it replaced even when
/// that lane had completed, and a retry could erase a real result.
///
/// That never surfaced while the terminal-status cache skipped recovery lanes
/// outright -- the comparison could not happen. It surfaces the moment recovery
/// lanes become visible, which is why both changes belong together.
///
/// The intent the bonus was written for is preserved exactly: a recovery lane
/// supersedes the lane it replaces when it did at least as well.
pub(crate) fn lane_status_priority(lane_id: &str, status: &str) -> i32 {
    let recovery_tiebreak = if lane_id.contains("-recovery-") { 1 } else { 0 };
    let status_score = match status {
        "completed" => 40,
        "running" => 30,
        "prepared" => 20,
        "pending" => 10,
        "failed" => 0,
        _ => 5,
    };
    status_score * 10 + recovery_tiebreak
}

pub(crate) fn terminal_status_after_runtime_reconciliation(status: &str, record: &Value) -> String {
    if status == "failed" {
        let error = record.get("error").and_then(Value::as_str).unwrap_or("");
        let superseded = record
            .get("superseded_by_runtime_reconciliation")
            .and_then(Value::as_bool)
            == Some(true);
        if superseded || error.starts_with("obsolete_") {
            return "aborted".to_string();
        }
    }
    status.to_string()
}

pub(crate) fn lane_dirs_for_cycle(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Vec<(String, PathBuf)>> {
    let mut lanes = all_cycle_contract_paths(paths, cycle_id)?
        .into_iter()
        .filter_map(|contract_path| {
            let lane_dir = contract_path.parent()?.to_path_buf();
            let lane_id = lane_dir.file_name()?.to_string_lossy().to_string();
            Some((lane_id, lane_dir))
        })
        .collect::<Vec<_>>();
    if lanes.len() < 32 {
        let lanes_dir = crate::core::support::cycle_lanes_root(paths, cycle_id);
        if lanes_dir.exists() {
            for entry in read_dir(lanes_dir)? {
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

pub(crate) fn cached_terminal_lane_statuses(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashMap<String, Value>> {
    let cycle_state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    if !cycle_state_path.exists() {
        return Ok(HashMap::new());
    }
    let cycle_state = read_json(&cycle_state_path)?;
    let mut cached = HashMap::new();
    for lane in cycle_state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let lane_id = lane
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if lane_id.is_empty() {
            continue;
        }
        if matches!(
            lane.get("status").and_then(Value::as_str),
            Some("completed" | "aborted" | "failed")
        ) {
            let lane_dir = lane_root(paths, cycle_id, &lane_id);
            let final_status_path = lane_dir.join("final-status.json");
            if final_status_path.exists() {
                if let Ok(final_status) = read_json(&final_status_path) {
                    if matches!(
                        final_status.get("status").and_then(Value::as_str),
                        Some("completed" | "aborted" | "failed")
                    ) {
                        let mut healed = lane.clone();
                        let final_status_text = final_status
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        healed["status"] = json!(terminal_status_after_runtime_reconciliation(
                            final_status_text,
                            &final_status,
                        ));
                        if let Some(role) = final_status.get("role") {
                            healed["role"] = role.clone();
                        }
                        if let Some(path) = final_status.get("result_path") {
                            healed["result_path"] = path.clone();
                        }
                        cached.insert(base_lane_id(&lane_id), healed);
                        continue;
                    }
                }
            }
            if lane.get("status").and_then(Value::as_str) == Some("failed") {
                let result_path = lane_dir.join("result.json");
                let result_is_small_enough = fs::metadata(&result_path)
                    .map(|metadata| metadata.len() <= 5 * 1024 * 1024)
                    .unwrap_or(false);
                if result_path.exists() && result_is_small_enough {
                    if let Ok(result) = read_json(&result_path) {
                        if matches!(
                            result.get("status").and_then(Value::as_str),
                            Some("completed" | "completed_with_warning")
                        ) {
                            let mut healed = lane.clone();
                            healed["status"] = json!("completed");
                            healed["result_path"] = json!(result_path);
                            cached.insert(base_lane_id(&lane_id), healed);
                            continue;
                        }
                    }
                }
            }
            cached.insert(base_lane_id(&lane_id), lane);
        }
    }
    Ok(cached)
}

pub(crate) fn cycle_brief_index_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-brief-index.json"))
}

pub(crate) fn cycle_briefs(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    let index_path = cycle_brief_index_path(paths, cycle_id);
    if index_path.exists() {
        let index = read_json(&index_path)?;
        if index.get("cycle_id").and_then(Value::as_str) == Some(cycle_id) {
            if let Some(briefs) = index.get("briefs").and_then(Value::as_array) {
                return Ok(briefs.clone());
            }
        }
    }

    let briefs_root = chronicle_briefs_root(paths, cycle_id);
    let mut briefs = Vec::new();
    if briefs_root.exists() {
        for entry in read_dir(briefs_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            briefs.push(read_json(&entry.path())?);
        }
    }
    briefs.sort_by(|a, b| {
        a.get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("brief_id").and_then(Value::as_str).unwrap_or(""))
    });
    write_json(
        &index_path,
        &json!({
            "cycle_id": cycle_id,
            "indexed_at": now_iso(),
            "brief_count": briefs.len(),
            "briefs": briefs,
        }),
    )?;
    let index = read_json(&index_path)?;
    Ok(index
        .get("briefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

pub(crate) fn upsert_cycle_brief_index(
    paths: &AppPaths,
    cycle_id: &str,
    brief: &ChronicleBrief,
) -> Result<()> {
    let index_path = cycle_brief_index_path(paths, cycle_id);
    if !index_path.exists() {
        return Ok(());
    }
    let mut index = read_json(&index_path)?;
    if index.get("cycle_id").and_then(Value::as_str) != Some(cycle_id) {
        return Ok(());
    }
    let mut briefs = index
        .get("briefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let brief_value = serde_json::to_value(brief)?;
    briefs.retain(|item| item.get("brief_id").and_then(Value::as_str) != Some(&brief.brief_id));
    briefs.push(brief_value);
    briefs.sort_by(|a, b| {
        a.get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("brief_id").and_then(Value::as_str).unwrap_or(""))
    });
    index["indexed_at"] = json!(now_iso());
    index["brief_count"] = json!(briefs.len());
    index["briefs"] = json!(briefs);
    write_json(&index_path, &index)
}

pub(crate) fn non_blocking_cycle_role(role: &str) -> bool {
    matches!(role, "author" | "gatekeeper" | "illustrator")
}

pub(crate) fn structured_payload_from_lane_result(result: &Value) -> Option<&Value> {
    result
        .get("extracted_json")
        .filter(|value| value.is_object())
        .or_else(|| {
            result
                .get("chronicle_fallback")
                .filter(|value| value.is_object())
        })
        .or_else(|| {
            result
                .get("author_fallback")
                .filter(|value| value.is_object())
        })
}

pub(crate) fn payload_array_values(payload: Option<&Value>, keys: &[&str]) -> Vec<Value> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn payload_value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("question")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .get("description")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .get("statement")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

pub(crate) fn payload_string_values(payload: Option<&Value>, key: &str) -> Vec<String> {
    payload_array_values(payload, &[key])
        .iter()
        .filter_map(payload_value_to_string)
        .collect()
}

pub(crate) fn enrich_brief_from_structured_result(brief: &mut ChronicleBrief, result: &Value) {
    let payload = structured_payload_from_lane_result(result);
    if brief.claim_deltas.is_empty() {
        brief.claim_deltas = payload_array_values(payload, &["claim_deltas"]);
    }
    if brief.open_questions.is_empty() {
        brief.open_questions = payload_string_values(payload, "open_questions");
    }
    if brief.recommended_actions.is_empty() {
        brief.recommended_actions =
            payload_array_values(payload, &["recommended_actions", "next_actions"]);
    }
    if brief.hypothesis_candidates.is_empty() {
        brief.hypothesis_candidates = payload_string_values(payload, "hypothesis_candidates");
    }
}

pub(crate) fn lane_role_plan_summary(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Value {
    let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
    if !role_plan_path.exists() {
        return Value::Null;
    }

    let role_plan = match read_json(&role_plan_path) {
        Ok(value) => value,
        Err(_) => return Value::Null,
    };

    json!({
        "path": role_plan_path,
        "role": role_plan.get("role").cloned().unwrap_or(Value::Null),
        "source": role_plan.get("source").cloned().unwrap_or(Value::Null),
        "action_type": role_plan.get("action_type").cloned().unwrap_or(Value::Null),
        "assigned_model": role_plan.get("assigned_model").cloned().unwrap_or(Value::Null),
        "target_rubric": role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("target_rubric"))
            .cloned()
            .unwrap_or(Value::Null),
        "target_score": role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("target_score"))
            .cloned()
            .unwrap_or(Value::Null),
        "current_score": role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("current_score"))
            .cloned()
            .unwrap_or(Value::Null),
        "blocker_reasons": role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("blocker_reasons"))
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(crate) fn latex_escape(value: &str) -> String {
    value
        .replace('\\', "\\textbackslash{}")
        .replace('&', "\\&")
        .replace('%', "\\%")
        .replace('$', "\\$")
        .replace('#', "\\#")
        .replace('_', "\\_")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('~', "\\textasciitilde{}")
        .replace('^', "\\textasciicircum{}")
}

pub(crate) fn hypothesis_ledger_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-hypothesis-ledger.json"))
}

pub(crate) fn hypothesis_paper_map(
    paths: &AppPaths,
    cycle_id: &str,
) -> HashMap<String, Vec<Value>> {
    let ledger_path = hypothesis_ledger_path(paths, cycle_id);
    if !ledger_path.exists() {
        return HashMap::new();
    }
    let ledger = match read_json(&ledger_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };
    let mut map = HashMap::new();
    for item in ledger
        .get("hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let hypothesis_id = item
            .get("hypothesis_id")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let statement_key = item.get("statement").and_then(Value::as_str).map(slugify);
        let papers = item
            .get("paper_examples")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|paper| {
                if let Some(title) = paper.as_str() {
                    return Some(json!({ "title": title }));
                }
                if paper.is_object() {
                    return Some(paper);
                }
                None
            })
            .collect::<Vec<_>>();
        if papers.is_empty() {
            continue;
        }
        if let Some(key) = hypothesis_id {
            map.insert(key, papers.clone());
        }
        if let Some(key) = statement_key {
            map.entry(key).or_insert_with(|| papers.clone());
        }
    }
    map
}

pub(crate) fn claim_rank(claim: &Value) -> i32 {
    let claim_id = claim
        .get("claim_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = claim
        .get("current")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let supporting_lanes = claim
        .get("supporting_lanes")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0) as i32;
    let supporting_hypotheses = claim
        .get("supporting_hypotheses")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0) as i32;
    let supporting_papers = claim
        .get("supporting_papers")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0) as i32;
    let id_bonus = if claim_id.starts_with("claim-") {
        40
    } else {
        0
    };
    let status_bonus = match status {
        "robust" => 30,
        "supported" => 24,
        "exploratory" => 12,
        _ => 0,
    };

    id_bonus
        + status_bonus
        + supporting_lanes
        + (supporting_hypotheses * 2)
        + (supporting_papers * 3)
}

pub(crate) fn select_primary_claims(claims: &[Value]) -> Vec<Value> {
    let mut ranked = claims.to_vec();
    ranked.sort_by(|a, b| {
        claim_rank(b).cmp(&claim_rank(a)).then_with(|| {
            b.get("supporting_papers")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0)
                .cmp(
                    &a.get("supporting_papers")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0),
                )
        })
    });

    let primary = ranked.into_iter().take(2).collect::<Vec<_>>();
    if primary.is_empty() {
        claims.iter().take(2).cloned().collect()
    } else {
        primary
    }
}

pub(crate) fn existing_path_strings(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
}

pub(crate) fn build_claim_evidence_trace(
    lane_id: &str,
    hypothesis_id: Option<&str>,
    paths: &[PathBuf],
) -> Value {
    json!(existing_path_strings(paths)
        .iter()
        .map(|path| {
            let kind = if path.ends_with("result.json") {
                "lane_result"
            } else if path.ends_with("validation-summary.json") {
                "validation_summary"
            } else if path.ends_with("analysis-trace.json") {
                "analysis_trace"
            } else if path.ends_with("summary.md") {
                "analysis_summary"
            } else if path.ends_with("final-status.json") {
                "final_status"
            } else {
                "artifact"
            };
            json!({
                "lane_id": lane_id,
                "hypothesis_id": hypothesis_id,
                "kind": kind,
                "path": path,
            })
        })
        .collect::<Vec<_>>())
}
