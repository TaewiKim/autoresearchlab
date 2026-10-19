#![allow(unused_imports)]
use super::*;
use crate::labdirector::context::compact_runner_context_for_prompt;

pub(crate) fn latest_lab_runner_context_for_handoff(
    paths: &AppPaths,
    cycle_id: &str,
    handoff_path: &str,
) -> Result<Option<Value>> {
    let handoff_key = normalized_path_key(handoff_path);
    let handoff_modified_at = fs::metadata(handoff_path)
        .and_then(|meta| meta.modified())
        .ok();
    let mut result_candidates = Vec::new();
    for (fallback_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_lab_runner(&fallback_lane_id) {
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
        let result_path = final_status
            .get("result_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| lane_dir.join("result.json"));
        if !result_path.exists() {
            continue;
        }
        let metadata = fs::metadata(&result_path)?;
        let modified_at = metadata.modified().ok();
        if let (Some(result_modified_at), Some(handoff_modified_at)) =
            (modified_at, handoff_modified_at)
        {
            if result_modified_at < handoff_modified_at {
                continue;
            }
        }
        if let Some(matches_handoff) = role_plan_references_handoff(
            &lane_dir.join("role-plan.json"),
            handoff_path,
            &handoff_key,
        )? {
            if !matches_handoff {
                continue;
            }
        }
        result_candidates.push((
            modified_at,
            fallback_lane_id,
            result_path,
            metadata.len(),
            final_status,
        ));
    }
    result_candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, fallback_lane_id, result_path, result_size, final_status) in
        result_candidates.into_iter().take(20)
    {
        let handoff_file_name = PathBuf::from(handoff_path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let handoff_needles = vec![
            handoff_path.to_string(),
            handoff_key.clone(),
            handoff_file_name,
        ];
        let precise_handoff_needles = vec![handoff_path.to_string(), handoff_key.clone()];
        let has_handoff_reference = if result_size > 16 * 1024 * 1024 {
            let window = json_file_window_text(&result_path, 64 * 1024)?;
            precise_handoff_needles
                .iter()
                .filter(|needle| !needle.is_empty())
                .any(|needle| window.contains(needle))
        } else {
            file_contains_any_text(&result_path, &handoff_needles)?
        };
        if !has_handoff_reference {
            continue;
        }
        let (
            result_handoff_path,
            validation_summary,
            open_source_agent_requirements,
            external_agent_runs,
            quality_gates,
            blueprint_executions,
            hypothesis_results,
            checks_failed,
            blueprints_failed,
            failed_checks,
            overall_status,
            external_agent_runs_total,
        ) = if result_size > 16 * 1024 * 1024 {
            (
                handoff_path.to_string(),
                Value::Null,
                Value::Null,
                json!([]),
                Value::Null,
                json!([]),
                json!([]),
                0,
                0,
                json!([]),
                json!("unknown_large_result_unparsed"),
                Value::Null,
            )
        } else {
            let result: Value = read_json(&result_path)?;
            let Some(result_handoff_path) = lab_runner_result_analyst_handoff_path(&result) else {
                continue;
            };
            if normalized_path_key(result_handoff_path) != handoff_key {
                continue;
            }
            let validation_summary = result
                .get("validation_summary")
                .cloned()
                .unwrap_or(Value::Null);
            let open_source_agent_requirements = validation_summary
                .get("open_source_agent_requirements")
                .or_else(|| result.get("open_source_agent_requirements"))
                .cloned()
                .unwrap_or(Value::Null);
            let external_agent_runs = result
                .get("external_agent_runs")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let quality_gates = result.get("quality_gates").cloned().unwrap_or(Value::Null);
            let blueprint_executions = result
                .get("blueprint_executions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let hypothesis_results = result
                .get("hypothesis_results")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let checks_failed = validation_summary
                .get("checks_failed")
                .or_else(|| result.get("checks_failed"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let blueprints_failed = validation_summary
                .get("blueprints_failed")
                .or_else(|| result.get("blueprints_failed"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let failed_checks = validation_summary
                .get("failed_checks")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let overall_status = validation_summary
                .get("overall_status")
                .or_else(|| result.get("overall_status"))
                .cloned()
                .unwrap_or(Value::Null);
            let external_agent_runs_total = validation_summary
                .get("external_agent_runs_total")
                .or_else(|| result.get("external_agent_runs_total"))
                .cloned()
                .unwrap_or(Value::Null);
            (
                result_handoff_path.to_string(),
                validation_summary,
                open_source_agent_requirements,
                external_agent_runs,
                quality_gates,
                blueprint_executions,
                hypothesis_results,
                checks_failed,
                blueprints_failed,
                failed_checks,
                overall_status,
                external_agent_runs_total,
            )
        };
        let lane_id = fallback_lane_id;
        return Ok(Some(json!({
            "lane_id": lane_id,
            "result_path": result_path.display().to_string(),
            "analyst_handoff_path": result_handoff_path,
            "final_status": final_status,
            "validation_summary": validation_summary,
            "open_source_agent_requirements": open_source_agent_requirements,
            "external_agent_runs": external_agent_runs,
            "quality_gates": quality_gates,
            "blueprint_executions": blueprint_executions,
            "hypothesis_results": hypothesis_results,
            "overall_status": overall_status,
            "checks_failed": checks_failed,
            "blueprints_failed": blueprints_failed,
            "failed_checks": failed_checks,
            "external_agent_runs_total": external_agent_runs_total,
        })));
    }
    latest_lab_runner_context_for_equivalent_handoff(paths, cycle_id, handoff_path)
}

pub(crate) fn runner_context_is_exact_handoff(context: &Value, handoff_path: &str) -> bool {
    if context
        .get("semantic_handoff_match")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    context
        .get("analyst_handoff_path")
        .and_then(Value::as_str)
        .map(|path| normalized_path_key(path) == normalized_path_key(handoff_path))
        .unwrap_or(false)
}

pub(crate) fn handoff_execution_signature_from_path(handoff_path: &str) -> Result<Option<Value>> {
    if handoff_path.trim().is_empty() || !PathBuf::from(handoff_path).exists() {
        return Ok(None);
    }
    let payload = read_json(&PathBuf::from(handoff_path))?;
    Ok(Some(handoff_execution_signature(&payload)))
}

pub(crate) fn handoff_execution_signature(payload: &Value) -> Value {
    json!({
        "dataset_root": payload.get("dataset_root").cloned().unwrap_or(Value::Null),
        "column_mapping": stable_handoff_signature_value(
            payload.get("column_mapping").unwrap_or(&Value::Null),
        ),
        "handoff_checks": stable_handoff_signature_value(
            payload.get("handoff_checks").unwrap_or(&Value::Null),
        ),
        "validation_code_blueprints": stable_handoff_signature_value(
            payload.get("validation_code_blueprints").unwrap_or(&Value::Null),
        ),
    })
}

pub(crate) fn stable_handoff_signature_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut stable = serde_json::Map::new();
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "data_graph"
                        | "data_graph_update_path"
                        | "edge_count"
                        | "node_count"
                        | "matched_edges"
                        | "matched_nodes"
                        | "source_text_excerpt"
                        | "secondary_limitations"
                        | "secondary_rival_programs"
                ) {
                    continue;
                }
                stable.insert(key.clone(), stable_handoff_signature_value(child));
            }
            Value::Object(stable)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(stable_handoff_signature_value)
                .collect::<Vec<_>>(),
        ),
        _ => value.clone(),
    }
}

pub(crate) fn latest_lab_runner_context_for_equivalent_handoff(
    paths: &AppPaths,
    cycle_id: &str,
    handoff_path: &str,
) -> Result<Option<Value>> {
    let Some(target_signature) = handoff_execution_signature_from_path(handoff_path)? else {
        return Ok(None);
    };
    let target_key = normalized_path_key(handoff_path);
    let mut result_candidates = Vec::new();
    for (fallback_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_lab_runner(&fallback_lane_id) {
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
        let result_path = final_status
            .get("result_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| lane_dir.join("result.json"));
        if !result_path.exists() {
            continue;
        }
        let modified_at = fs::metadata(&result_path)
            .and_then(|meta| meta.modified())
            .ok();
        result_candidates.push((modified_at, fallback_lane_id, result_path, final_status));
    }
    result_candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, lane_id, result_path, final_status) in result_candidates.into_iter().take(50) {
        let role_plan_path = lane_root(paths, cycle_id, &lane_id).join("role-plan.json");
        let role_plan = if role_plan_path.exists() {
            read_json(&role_plan_path)?
        } else {
            Value::Null
        };
        let result_size = fs::metadata(&result_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let result_handoff_path =
            if let Some(path) = lab_runner_role_plan_analyst_handoff_path(&role_plan) {
                path.to_string()
            } else if result_size <= 16 * 1024 * 1024 {
                let result = read_json(&result_path)?;
                let Some(path) = lab_runner_result_analyst_handoff_path(&result) else {
                    continue;
                };
                path.to_string()
            } else {
                continue;
            };
        if normalized_path_key(&result_handoff_path) == target_key {
            continue;
        }
        let Some(result_signature) = handoff_execution_signature_from_path(&result_handoff_path)?
        else {
            continue;
        };
        if result_signature != target_signature {
            continue;
        }
        let result = if result_size <= 16 * 1024 * 1024 {
            read_json(&result_path)?
        } else {
            Value::Null
        };
        let validation_summary = result
            .get("validation_summary")
            .cloned()
            .unwrap_or(Value::Null);
        let checks_failed = validation_summary
            .get("checks_failed")
            .or_else(|| result.get("checks_failed"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let blueprints_failed = validation_summary
            .get("blueprints_failed")
            .or_else(|| result.get("blueprints_failed"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let failed_checks = validation_summary
            .get("failed_checks")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let overall_status = validation_summary
            .get("overall_status")
            .or_else(|| result.get("overall_status"))
            .cloned()
            .unwrap_or(Value::Null);
        return Ok(Some(json!({
            "lane_id": lane_id,
            "result_path": result_path.display().to_string(),
            "analyst_handoff_path": result_handoff_path,
            "equivalent_analyst_handoff_path": handoff_path,
            "semantic_handoff_match": true,
            "final_status": final_status,
            "validation_summary": validation_summary,
            "overall_status": overall_status,
            "checks_failed": checks_failed,
            "blueprints_failed": blueprints_failed,
            "failed_checks": failed_checks,
        })));
    }
    Ok(None)
}

pub(crate) fn open_lab_runner_lane_for_handoff(
    paths: &AppPaths,
    cycle_id: &str,
    handoff_path: &str,
) -> Result<Option<String>> {
    let handoff_key = normalized_path_key(handoff_path);
    let mut lane_dirs = lane_dirs_from_contract_index(paths, cycle_id)?;
    let mut seen_lane_ids = lane_dirs
        .iter()
        .map(|(lane_id, _)| lane_id.clone())
        .collect::<HashSet<_>>();
    let lanes_dir = cycle_lanes_root(paths, cycle_id);
    if lanes_dir.exists() {
        for entry in read_dir(&lanes_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if seen_lane_ids.insert(lane_id.clone()) {
                lane_dirs.push((lane_id, entry.path()));
            }
        }
    }
    lane_dirs.sort_by(|a, b| a.0.cmp(&b.0));

    for (lane_id, lane_dir) in lane_dirs {
        if !lane_id_looks_like_lab_runner(&lane_id) {
            continue;
        }
        if lane_dir.join("final-status.json").exists() {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        if role_plan_references_handoff(&role_plan_path, handoff_path, &handoff_key)? == Some(true)
        {
            return Ok(Some(lane_id));
        }
        if !role_plan_path.exists() {
            continue;
        }
        let role_plan = read_json(&role_plan_path)?;
        if role_plan.get("action_type").and_then(Value::as_str) != Some("recovery_followup") {
            continue;
        }
        let Some(source_lane_id) = role_plan.get("source_brief_id").and_then(Value::as_str) else {
            continue;
        };
        if role_plan_references_handoff(
            &lane_root(paths, cycle_id, source_lane_id).join("role-plan.json"),
            handoff_path,
            &handoff_key,
        )? == Some(true)
        {
            return Ok(Some(lane_id));
        }
    }
    Ok(None)
}

pub(crate) fn runner_context_requires_handoff_revision(context: &Value) -> bool {
    let overall_status = context
        .get("overall_status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let status_passed = matches!(
        overall_status.as_str(),
        "pass" | "passed" | "ok" | "validated"
    );
    let checks_failed = context
        .get("checks_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let blueprints_failed = context
        .get("blueprints_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let analyst_standard_satisfied = context
        .get("analyst_quality_standard")
        .or_else(|| {
            context
                .get("validation_summary")
                .and_then(|value| value.get("analyst_quality_standard"))
        })
        .and_then(|value| value.get("satisfied"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if analyst_standard_satisfied && blueprints_failed == 0 {
        return false;
    }
    !status_passed || checks_failed > 0 || blueprints_failed > 0
}

pub(crate) fn refresh_lab_director_latest_runner_context(
    paths: &AppPaths,
    cycle_id: &str,
    role_plan: &mut Value,
) -> Result<()> {
    let Some(runner_context) = latest_completed_lab_runner_context(paths, cycle_id)? else {
        return Ok(());
    };
    let planner_metadata = ensure_object_field(role_plan, "planner_metadata");
    // Digest into the prompt; the full context stays available to the Rust
    // callers below. See compact_runner_context_for_prompt.
    planner_metadata["latest_completed_lab_runner_context"] =
        compact_runner_context_for_prompt(&runner_context);
    planner_metadata["latest_completed_lab_runner_context_source"] =
        json!("launch_context_refresh");
    if planner_metadata
        .get("validation_results")
        .map(|value| value.is_null())
        .unwrap_or(true)
    {
        // The SAME digest as the line above, not the raw context.
        //
        // This cloned `runner_context` whole, and 36.2 KB of its 44.5 KB was
        // `analyst_handoff` inlined beside the path to it -- the exact shape
        // compact_runner_context_for_prompt exists to fold, and which its
        // sibling assignment two lines up already folds. Measured on a median
        // lab-director prompt from cycle-g-v89: 44.5 KB of 193 KB, the single
        // largest block in the prompt.
        //
        // There is a compaction list that names `validation_results` at 8 KB,
        // in attach_lab_director_context_controls -- and it runs BEFORE this
        // function, so it compacted a key that did not exist yet and this
        // assignment landed on top of it. A cap that runs before the value is
        // written is not a cap.
        //
        // Safe for the Rust readers: every one of them tests this key for
        // PRESENCE (`is_some`, `!is_null`) and none reads a field inside it,
        // and the path to the full handoff stays in the digest.
        planner_metadata["validation_results"] =
            compact_runner_context_for_prompt(&runner_context);
    }
    if !runner_context_requires_handoff_revision(&runner_context)
        && planner_metadata
            .get("failed_runner_context")
            .map(|value| value.is_null())
            .unwrap_or(true)
    {
        planner_metadata["failed_runner_context"] = Value::Null;
    }
    Ok(())
}

/// Is this raw runner result the boot-time capability probe?
///
/// Read here rather than at the gate because the context handed downstream is a
/// hand-built summary that carries no `extracted_json`. The probe reports its
/// inventory there and nowhere else, so the marker has to be lifted while the
/// raw result is still in scope.
pub(crate) fn lab_runner_result_is_instrument_probe(result: &Value) -> bool {
    if result
        .get("extracted_json")
        .and_then(|value| value.get("instrument_inventory"))
        .is_some()
    {
        return true;
    }
    if result.get("instrument_inventory").is_some() {
        return true;
    }
    matches!(
        result
            .get("role_plan")
            .and_then(|value| value.get("lane_kind"))
            .and_then(Value::as_str),
        Some("instrument_probe")
    )
}

pub(crate) fn latest_completed_lab_runner_context(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let mut candidates: Vec<(Option<SystemTime>, String, PathBuf, PathBuf)> = Vec::new();
    let latest_handoff_key = latest_executable_analyst_handoff_path(paths, cycle_id)?
        .as_deref()
        .map(normalized_path_key);
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_lab_runner(&lane_id) {
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
        let result_path =
            compact_lab_runner_result_path(paths, cycle_id, &lane_id, &lane_dir, &final_status);
        if !result_path.exists() {
            continue;
        }
        let modified_at = fs::metadata(&result_path)
            .and_then(|metadata| metadata.modified())
            .ok();
        candidates.push((
            modified_at,
            lane_id,
            result_path,
            lane_dir.join("role-plan.json"),
        ));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, lane_id, result_path, role_plan_path) in candidates {
        let raw_result = read_json_if_below(&result_path, 5 * 1024 * 1024)?.unwrap_or(Value::Null);
        let result = if result_path.file_name().and_then(|name| name.to_str())
            == Some("validation-summary.json")
        {
            json!({"validation_summary": raw_result})
        } else {
            raw_result
        };
        let role_plan =
            read_json_if_below(&role_plan_path, 2 * 1024 * 1024)?.unwrap_or(Value::Null);
        let handoff_path = lab_runner_result_analyst_handoff_path(&result)
            .map(ToString::to_string)
            .or_else(|| {
                lab_runner_role_plan_analyst_handoff_path(&role_plan).map(ToString::to_string)
            })
            .or_else(|| {
                result
                    .get("role_plan")
                    .and_then(|value| value.get("planner_metadata"))
                    .and_then(|value| value.get("cycle_analyst_handoff"))
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            });
        if let (Some(latest_key), Some(runner_handoff_path)) =
            (latest_handoff_key.as_ref(), handoff_path.as_ref())
        {
            if (lab_runner_result_is_direct_analyst_handoff(&result)
                || lab_runner_role_plan_is_direct_analyst_handoff(&role_plan))
                && normalized_path_key(runner_handoff_path) != *latest_key
            {
                continue;
            }
        }
        let validation_summary = result
            .get("validation_summary")
            .cloned()
            .unwrap_or(Value::Null);
        // Compact results may keep only the handoff path. Recover the exact
        // handoff consumed by this runner so adjudication retains its hypothesis.
        // Prefer an embedded snapshot if present; a newer handoff is unrelated.
        let mut analyst_handoff = result
            .get("role_plan")
            .and_then(|value| value.get("planner_metadata"))
            .and_then(|value| value.get("analyst_handoff"))
            .filter(|value| value.is_object())
            .or_else(|| {
                role_plan
                    .get("planner_metadata")
                    .and_then(|value| value.get("analyst_handoff"))
                    .filter(|value| value.is_object())
            })
            .cloned()
            .unwrap_or(Value::Null);
        if analyst_handoff.is_null() {
            if let Some(path) = handoff_path.as_deref().filter(|path| !path.trim().is_empty()) {
                analyst_handoff = read_json_if_below(
                    &resolve_task_handoff_path(paths, path),
                    2 * 1024 * 1024,
                )?
                .unwrap_or(Value::Null);
            }
        }
        return Ok(Some(json!({
            "lane_id": lane_id,
            "result_path": result_path.display().to_string(),
            "analyst_handoff_path": handoff_path.unwrap_or_default(),
            // Lifted from the raw result while it is still in scope: the summary
            // below carries no extracted_json, and the gate cannot see the probe
            // without this.
            "instrument_probe": lab_runner_result_is_instrument_probe(&result),
            "validation_summary": validation_summary,
            "overall_status": validation_summary
                .get("overall_status")
                .or_else(|| result.get("overall_status"))
                .cloned()
                .unwrap_or(Value::Null),
            "checks_failed": validation_summary
                .get("checks_failed")
                .or_else(|| result.get("checks_failed"))
                .cloned()
                .unwrap_or(Value::Null),
            "blueprints_failed": validation_summary
                .get("blueprints_failed")
                .or_else(|| result.get("blueprints_failed"))
                .cloned()
                .unwrap_or(Value::Null),
            "failed_checks": validation_summary
                .get("failed_checks")
                .or_else(|| result.get("failed_checks"))
                .cloned()
                .unwrap_or_else(|| json!([])),
            "open_source_agent_requirements": validation_summary
                .get("open_source_agent_requirements")
                .or_else(|| result.get("open_source_agent_requirements"))
                .cloned()
                .unwrap_or(Value::Null),
            "analyst_handoff": analyst_handoff,
        })));
    }
    Ok(None)
}

// True when ANY completed lab-runner this cycle is gate-ready (clean, analyst-
// quality-satisfied, no failed blueprints) — not just the single latest one.
//
// The gate-convergence guard in latest_runner_post_run_review_blocker only
// checked `latest_completed_lab_runner_context`. When a clean render/validation
// runner (e.g. lab-runner-01) already produced robust evidence but a NEWER
// followup-runner then completed in a degraded state (blueprints_failed>0,
// analyst standard not satisfied), the "latest" was the degraded one, so
// gate_ready flipped back to false and the gatekeeper was deferred FOREVER on a
// post-run-review / handoff-revision for the degraded churn — even though a
// gate-ready runner for the current lead already existed. This is the exact
// failure mode that guard's comment says it wants to prevent, so readiness must
// be judged over ALL completed runners, not only the most recent.
//
// Mirrors runner_context_gate_ready's criteria (analyst_quality_standard
// satisfied && blueprints_failed == 0) against every completed lab-runner.
pub(crate) fn any_completed_lab_runner_gate_ready(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_lab_runner(&lane_id) {
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
        let result_path =
            compact_lab_runner_result_path(paths, cycle_id, &lane_id, &lane_dir, &final_status);
        if !result_path.exists() {
            continue;
        }
        let raw_result = read_json_if_below(&result_path, 5 * 1024 * 1024)?.unwrap_or(Value::Null);
        let result = if result_path.file_name().and_then(|name| name.to_str())
            == Some("validation-summary.json")
        {
            json!({ "validation_summary": raw_result })
        } else {
            raw_result
        };
        let validation_summary = result
            .get("validation_summary")
            .cloned()
            .unwrap_or(Value::Null);
        // Build the minimal context runner_context_gate_ready inspects so the
        // readiness criteria stay identical to the latest-runner path.
        let context = json!({
            "validation_summary": validation_summary,
            "analyst_quality_standard": result
                .get("analyst_quality_standard")
                .cloned()
                .unwrap_or(Value::Null),
            "overall_status": validation_summary
                .get("overall_status")
                .or_else(|| result.get("overall_status"))
                .cloned()
                .unwrap_or(Value::Null),
            "checks_failed": validation_summary
                .get("checks_failed")
                .or_else(|| result.get("checks_failed"))
                .cloned()
                .unwrap_or(Value::Null),
            "blueprints_failed": validation_summary
                .get("blueprints_failed")
                .or_else(|| result.get("blueprints_failed"))
                .cloned()
                .unwrap_or(Value::Null),
        });
        if runner_context_gate_ready(&context) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn push_runner_post_run_gate_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let Some(runner_context) = latest_completed_lab_runner_context(paths, cycle_id)? else {
        return Ok(());
    };
    let lane_id = runner_context
        .get("lane_id")
        .and_then(Value::as_str)
        .unwrap_or("lab-runner");
    if lane_id.trim().is_empty() {
        return Ok(());
    }
    let handoff_path = runner_context
        .get("analyst_handoff_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    let handoff_payload = runner_context
        .get("analyst_handoff")
        .cloned()
        .unwrap_or(Value::Null);
    let handoff_hypothesis_statement = handoff_payload
        .get("column_mapping")
        .and_then(|item| item.get("hypothesis_statement"))
        .and_then(Value::as_str)
        .or_else(|| handoff_payload.get("summary").and_then(Value::as_str))
        .or_else(|| {
            handoff_payload
                .get("handoff_checks")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("hypothesis_text"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let handoff_candidate_hypotheses = if handoff_hypothesis_statement.trim().is_empty() {
        json!([])
    } else {
        json!([{ "statement": handoff_hypothesis_statement }])
    };
    let overall_status = runner_context
        .get("overall_status")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let checks_failed = runner_context
        .get("checks_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let blueprints_failed = runner_context
        .get("blueprints_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let failed_checks = runner_context
        .get("failed_checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    let failed_check_summary = if failed_checks.is_empty() {
        "none reported".to_string()
    } else {
        failed_checks.join(",")
    };
    if runner_context_requires_handoff_revision(&runner_context) {
        // Runner-recovery loop guard (see RUNNER_RECOVERY_ATTEMPT_CAP): stop generating new
        // degraded-runner recovery requeries once the cap is reached, so the analyst stops
        // emitting fresh handoffs that supersede runners and the gatekeeper can finally review.
        if completed_runner_recovery_requery_count(paths, cycle_id)? >= RUNNER_RECOVERY_ATTEMPT_CAP
        {
            return Ok(());
        }
        let source_brief_id = format!("labdirector-runner-recovery-{lane_id}");
        if completed_followup_action_from_source_exists(
            paths,
            cycle_id,
            "lab-director",
            "lab_director_requery_followup",
            &source_brief_id,
        ) || open_followup_action_from_source_lane(
            paths,
            cycle_id,
            "lab-director",
            "lab_director_requery_followup",
            &source_brief_id,
            None,
        )?
        .is_some()
            || priority_actions.iter().any(|action| {
                action.get("type").and_then(Value::as_str) == Some("lab_director_requery_followup")
                    && action.get("brief_id").and_then(Value::as_str)
                        == Some(source_brief_id.as_str())
            })
            || runner_adjudicated_by_director(paths, cycle_id, lane_id)?
        {
            return Ok(());
        }
        priority_actions.push(json!({
            "brief_id": source_brief_id,
            "description": format!(
                "{}LabDirector must adjudicate degraded validation from lab-runner {lane_id}: overall_status={overall_status}, checks_failed={checks_failed}, blueprints_failed={blueprints_failed}, failed_checks={failed_check_summary}. This post-run recovery is mandatory before gate review; LabDirector must author the next research instruction, decide whether to revise the handoff, demote/replace the claim, request missing evidence, or close the current lead, and update research notes.",
                lead_protection_directive(paths, cycle_id)
            ),
            "type": "lab_director_requery_followup",
            "priority": "critical",
            "priority_score": 286,
            "preferred_role": "lab-director",
            "target_rubric": "technical_quality",
            "target_score": 95,
            "current_score": Value::Null,
            "blocker_reasons": json!([
                "lab-runner completed but scientific validation did not pass",
                "post-run LabDirector recovery is required before gate review"
            ]),
            "candidate_hypotheses": handoff_candidate_hypotheses,
            // The digest, for the same reason as the assignment above: the raw
            // context inlines a 36 KB analyst_handoff beside the path to it, and
            // the recovery action needs the verdict and the paths, not the copy.
            "validation_results": compact_runner_context_for_prompt(&runner_context),
            "failed_runner_context": compact_runner_context_for_prompt(&runner_context),
            "open_source_agent_requirement": runner_context
                .get("open_source_agent_requirements")
                .cloned()
                .unwrap_or(Value::Null),
            "analysis_request": {
                "source": "degraded-runner-labdirector-adjudication",
                "lab_director_must_author_research_instruction": true,
                "supervisor_or_runtime_must_not_prescribe_analysis_plan": true,
                "handoff_source": "latest-completed-runner",
                "handoff_path": handoff_path,
                "analyst_handoff": handoff_payload,
                "failed_runner_context": runner_context,
            },
        }));
    } else {
        let source_brief_id = lane_id.to_string();
        if completed_followup_action_from_source_exists(
            paths,
            cycle_id,
            "analyst",
            "runner_result_interpretation_followup",
            &source_brief_id,
        ) || open_followup_action_from_source_lane(
            paths,
            cycle_id,
            "analyst",
            "runner_result_interpretation_followup",
            &source_brief_id,
            None,
        )?
        .is_some()
            || priority_actions.iter().any(|action| {
                action.get("type").and_then(Value::as_str)
                    == Some("runner_result_interpretation_followup")
                    && action.get("brief_id").and_then(Value::as_str)
                        == Some(source_brief_id.as_str())
            })
        {
            return Ok(());
        }
        priority_actions.push(json!({
            "brief_id": source_brief_id,
            "description": format!(
                "interpret LabRunner {lane_id} results for the Analyst-to-LabRunner validation cycle. Decide whether the evidence is sufficient for LabDirector gate review or whether another runner iteration is needed. If sufficient, write a concise lab_director_validation_report with hypothesis decision, effect direction/strength, controls, failure modes, and artifacts; otherwise emit a revised executable handoff-validation-plan.json. overall_status={overall_status}, checks_failed={checks_failed}, blueprints_failed={blueprints_failed}."
            ),
            "type": "runner_result_interpretation_followup",
            "priority": "critical",
            "priority_score": 287,
            "preferred_role": "analyst",
            "target_rubric": "technical_quality",
            "target_score": 95,
            "current_score": Value::Null,
            "blocker_reasons": json!([
                "LabRunner produced validation results that must be interpreted by Analyst before LabDirector gate review"
            ]),
            "candidate_hypotheses": handoff_candidate_hypotheses,
            "validation_results": runner_context,
            "analysis_request": {
                "source": "runner-result-analyst-interpretation",
                "handoff_source": "latest-completed-runner",
                "handoff_path": handoff_path,
                "analyst_handoff": handoff_payload,
                "runner_context": runner_context,
                "analyst_decides_report_timing": true,
                "lab_director_is_gate_after_analyst_report": true,
                "post_run_review_contract": {
                    "gate_unlock_condition": "emit lab_director_validation_report with a decision and scientific basis; otherwise emit a revised handoff-validation-plan.json and keep gate blocked",
                    "required_report_fields": [
                        "hypothesis_decision",
                        "effect_direction",
                        "effect_strength",
                        "controls",
                        "negative_controls",
                        "confounder_assessment",
                        "falsification_assessment",
                        "protocol_deviations",
                        "failure_modes",
                        "artifacts"
                    ]
                }
            },
        }));
    }
    Ok(())
}

pub(crate) fn analyst_post_run_report_payload(result: &Value) -> Option<&Value> {
    [
        result.get("lab_director_validation_report"),
        result
            .get("extracted_json")
            .and_then(|value| value.get("lab_director_validation_report")),
        result.get("analyst_interpretation"),
        result
            .get("extracted_json")
            .and_then(|value| value.get("analyst_interpretation")),
        result.get("post_run_review"),
        result
            .get("extracted_json")
            .and_then(|value| value.get("post_run_review")),
    ]
    .into_iter()
    .flatten()
    .find(|value| {
        value
            .as_object()
            .map(|map| !map.is_empty())
            .unwrap_or(false)
    })
}

pub(crate) fn analyst_post_run_report_declares_gate_ready(result: &Value) -> bool {
    let Some(report) = analyst_post_run_report_payload(result) else {
        let role_plan = result.get("role_plan").unwrap_or(&Value::Null);
        let action_type = role_plan
            .get("action_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if action_type != "runner_result_interpretation_followup" {
            return false;
        }
        let runner_context = role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("validation_results"))
            .or_else(|| {
                role_plan
                    .get("analysis_request")
                    .and_then(|value| value.get("runner_context"))
            })
            .unwrap_or(&Value::Null);
        return runner_context.is_object()
            && !runner_context_requires_handoff_revision(runner_context);
    };
    if report
        .get("gate_ready")
        .or_else(|| report.get("ready_for_labdirector_gate"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    let has_decision = [
        "hypothesis_decision",
        "decision",
        "verdict",
        "support_status",
        "requery_decision",
    ]
    .iter()
    .any(|key| {
        report
            .get(*key)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    });
    let has_scientific_basis = [
        "effect_direction",
        "effect_strength",
        "controls",
        "negative_controls",
        "confounder_assessment",
        "falsification_assessment",
        "protocol_deviations",
        "failure_modes",
        "artifacts",
    ]
    .iter()
    .any(|key| {
        report
            .get(*key)
            .map(|value| !value.is_null())
            .unwrap_or(false)
    });
    has_decision && has_scientific_basis
}

/// The ledger's current lead directive, as text, or empty.
///
/// The gate writes `<cycle>-lead-protection.json` whenever the progress ledger
/// produces a protective decision. Reading it rather than re-deriving the rule
/// keeps ONE copy of the prose, so this dispatcher and the JS gate cannot drift
/// into two different anti-churn rules.
///
/// MEASURED ON cycle-g-v81. The ledger emitted its dormant-lead decision 14
/// times and not one lane received the directive, because the requery lanes
/// being opened were `labdirector-runner-recovery-*` built in this file, which
/// composes its own description and never consulted the ledger. Leads averaged
/// 1.92 rounds. The protection existed on a road the traffic was not using.
fn lead_protection_directive(paths: &AppPaths, cycle_id: &str) -> String {
    let path = state_root(paths).join(format!("{cycle_id}-lead-protection.json"));
    read_json(&path)
        .ok()
        .and_then(|value| {
            value
                .get("directive")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_default()
}
