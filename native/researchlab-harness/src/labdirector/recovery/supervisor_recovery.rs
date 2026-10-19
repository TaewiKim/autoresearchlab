#![allow(unused_imports)]
use super::*;

pub(crate) fn assigned_model_for_role(role: &str, runtime_class: &str) -> &'static str {
    assigned_model_parameter(role, runtime_class)
}

pub(crate) fn stale_threshold_for_lane(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    default_stale_seconds: u64,
) -> u64 {
    // MEASURED ON cycle-a-20260919, 2026-09-22. Native shutdown
    // killed three productive simulation lanes after 1,839-2,265 seconds even
    // though their runtime envelope granted 7,200 seconds. Keep this reaper
    // beyond the action-specific runtime deadline, as the JS reaper already is.
    if role_plan.and_then(|plan| plan.get("action_type")).and_then(Value::as_str)
        == Some(SIMULATION_DATA_GENERATION_ACTION)
    {
        return default_stale_seconds
            .max(crate::runtime::codex_timeout_seconds(contract, role_plan).saturating_add(600));
    }
    match (contract.role.as_str(), contract.runtime_class.as_str()) {
        // External data acquisition can legitimately stream multi-GB files.
        // Treat stale detection as a true no-progress watchdog, not a short
        // wall-clock cap that aborts active downloads or heavy validation.
        ("scout", "external-driver") => default_stale_seconds.max(6 * 60 * 60),
        ("lab-runner", "external-driver") => default_stale_seconds.max(2 * 60 * 60),
        _ => default_stale_seconds,
    }
}

pub fn next_recovery_lane_id(
    paths: &AppPaths,
    cycle_id: &str,
    original_lane_id: &str,
) -> Result<String> {
    let prefix = format!("{original_lane_id}-recovery-");
    next_followup_lane_id(paths, cycle_id, &prefix)
}

pub fn supervisor_events_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    events_root(paths).join(format!("{cycle_id}-supervisor-actions.jsonl"))
}

pub(crate) fn result_status_is_recoverably_complete(result: &Value) -> bool {
    matches!(
        result.get("status").and_then(Value::as_str),
        Some("completed") | Some("completed_with_warning")
    )
}

pub(crate) fn supervisor_finalize_orphan_result(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    lane_dir: &Path,
) -> Result<Option<Value>> {
    let final_status_path = lane_dir.join("final-status.json");
    if final_status_path.exists() {
        return Ok(None);
    }
    let result_path = lane_dir.join("result.json");
    if !result_path.exists() {
        return Ok(None);
    }
    let result = read_lane_result_json(&result_path)?;
    if !result_status_is_recoverably_complete(&result) {
        return Ok(None);
    }
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let final_status = json!({
        "completed_at": now_iso(),
        "degraded": status != "completed",
        "failure_category": Value::Null,
        "lane_id": contract.lane_id,
        "result_path": result_path,
        "role_plan_path": lane_role_plan_path(paths, cycle_id, &contract.lane_id),
        "status": "completed",
        "supervisor_recovered": true,
        "supervisor_recovery_reason": "orphan_result_without_final_status",
    });
    write_json(&final_status_path, &final_status)?;
    let action = json!({
        "lane_id": contract.lane_id,
        "action": "finalize_orphan_result",
        "reason": "result.json completed but final-status.json was missing",
        "result_status": status,
        "final_status_path": final_status_path,
    });
    append_event(
        &supervisor_events_path(paths, cycle_id),
        "supervisor_action",
        action.clone(),
    )?;
    Ok(Some(action))
}

pub(crate) fn failed_data_scout_signal_failure(result: &Value, final_status: &Value) -> bool {
    if final_status.get("status").and_then(Value::as_str) != Some("failed") {
        return false;
    }
    let haystack = format!("{} {}", result, final_status).to_ascii_lowercase();
    haystack.contains("terminated_by_signal")
        || haystack.contains("no stdout/stderr emitted")
        || haystack.contains("python stats driver failed")
}

pub(crate) fn supervisor_spawn_constrained_data_scout_retry(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    lane_dir: &Path,
    max_retries_per_lane: usize,
) -> Result<Option<Value>> {
    if contract.role != "scout" || contract.runtime_class != "external-driver" {
        return Ok(None);
    }
    let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
    if !role_plan_path.exists() {
        return Ok(None);
    }
    let role_plan = read_json(&role_plan_path)?;
    if role_plan.get("action_type").and_then(Value::as_str) != Some("data_acquisition_followup") {
        return Ok(None);
    }
    let final_status_path = lane_dir.join("final-status.json");
    if !final_status_path.exists() {
        return Ok(None);
    }
    let Some(final_status) = read_lane_final_status(&final_status_path)? else {
        return Ok(None);
    };
    let result_path = lane_dir.join("result.json");
    let result = if result_path.exists() {
        read_json(&result_path).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if !failed_data_scout_signal_failure(&result, &final_status) {
        return Ok(None);
    }
    let root_lane_id = dependency_base_lane_id(&contract.lane_id);
    if recovery_lane_count_for_origin(paths, cycle_id, &contract.role, &root_lane_id)?
        >= max_retries_per_lane
    {
        return Ok(None);
    }
    if existing_recovery_lane_for_origin(
        paths,
        cycle_id,
        &contract.role,
        &root_lane_id,
        "failed-data-scout-signal",
    )?
    .is_some()
    {
        return Ok(None);
    }

    let new_lane_id = next_recovery_lane_id(paths, cycle_id, &contract.lane_id)?;
    let original_task = fs::read_to_string(&contract.task_file).unwrap_or_default();
    let description = format!(
        "Supervisor constrained recovery for {}: previous data scout terminated by signal with no useful stdout/stderr. Re-run compact repository-native discovery only; cap queries/candidates and do not fetch bundles in this retry.",
        contract.lane_id
    );
    let recovery_task = format!(
        "{original_task}\n\n## Supervisor Constrained Data-Scout Recovery\n- original_lane_id: {}\n- recovery_reason: failed-data-scout-signal\n- action: re-run compact no-fetch discovery with bounded queries/candidates; preserve any candidates/accessions found for LabDirector/gate recovery.\n",
        contract.lane_id
    );
    let new_contract_path = create_lane_contract(
        paths,
        cycle_id,
        &new_lane_id,
        &contract.role,
        &contract.runtime_class,
        &contract.mode,
        &recovery_task,
    )?;
    let hypotheses = role_plan
        .get("assigned_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            item.get("statement")
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let candidate_hypotheses = role_plan
        .get("candidate_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &new_lane_id,
        "scout",
        assigned_model_for_role("scout", "external-driver"),
        role_plan
            .get("objective")
            .and_then(Value::as_str)
            .unwrap_or("Recover failed data scout discovery."),
        &contract.lane_id,
        &description,
        "data_acquisition_followup",
        &hypotheses,
        &candidate_hypotheses,
        role_plan.get("schema_quality"),
        role_plan.get("reasoning_graph"),
        role_plan.get("data_graph"),
        &[],
        json!({
            "recovery_reason": "failed-data-scout-signal",
            "original_lane_id": contract.lane_id,
            "root_lane_id": root_lane_id,
            "runtime_class": contract.runtime_class,
            "supervisor_constrained_data_scout_retry": true,
            "max_queries": 10,
            "max_candidates_per_query": 6,
            "per_page_timeout": 15,
            "fetch_policy": "no-fetch",
            "previous_final_status_path": final_status_path,
            "previous_result_path": result_path,
        }),
    )?;
    let action = json!({
        "lane_id": contract.lane_id,
        "action": "spawn_constrained_data_scout_retry",
        "reason": "failed-data-scout-signal",
        "replacement_lane_id": new_lane_id,
        "replacement_contract_path": new_contract_path,
        "replacement_role_plan_path": role_plan_path,
    });
    append_event(
        &supervisor_events_path(paths, cycle_id),
        "supervisor_action",
        action.clone(),
    )?;
    Ok(Some(action))
}

pub(crate) fn infrastructure_bug_signature(result: &Value, final_status: &Value) -> Option<String> {
    if final_status.get("status").and_then(Value::as_str) != Some("failed") {
        return None;
    }
    let haystack = format!("{} {}", result, final_status).to_ascii_lowercase();
    let signatures = [
        (
            "missing-executable",
            ["no such file or directory", "os error 2"],
        ),
        ("command-not-found", ["command not found", "not found"]),
        (
            "codex-version-mismatch",
            ["requires a newer version of codex", "codex"],
        ),
        (
            "filesystem-cleanup-race",
            ["enotempty", "directory not empty"],
        ),
        ("schema-contract-error", ["schema", "additionalproperties"]),
        ("runtime-panic", ["thread '", "panicked"]),
        ("invalid-config", ["invalid config", "unrecognized key"]),
    ];
    for (signature, needles) in signatures {
        if needles.iter().all(|needle| haystack.contains(needle)) {
            return Some(signature.to_string());
        }
    }
    if haystack.contains("enoent") || haystack.contains("failed to run") {
        return Some("process-launch-failure".to_string());
    }
    None
}

pub(crate) fn supervisor_engineering_bugfix_lane_state(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<(bool, usize)> {
    let mut active = false;
    let mut total = 0usize;
    if let Some(lane_statuses) = large_cycle_lane_statuses_for_supervision(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            let role = lane.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "supervisor" && !lane_id.starts_with("followup-supervisor-") {
                continue;
            }
            let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
            let is_engineering_lane = role_plan_path.exists()
                && read_json(&role_plan_path)
                    .ok()
                    .and_then(|role_plan| {
                        role_plan
                            .get("action_type")
                            .and_then(Value::as_str)
                            .map(|action_type| action_type == "supervisor_engineering_bugfix")
                    })
                    .unwrap_or(false);
            if !is_engineering_lane {
                continue;
            }
            total += 1;
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(status, "pending" | "prepared" | "running") {
                active = true;
            }
        }
        return Ok((active, total));
    }
    for contract_path in all_cycle_contract_paths(paths, cycle_id)? {
        let Some(lane_dir) = contract_path.parent() else {
            continue;
        };
        let contract: LaneContract = serde_json::from_value(read_json(&contract_path)?)?;
        if contract.role != "supervisor" {
            continue;
        }
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        let is_engineering_lane = role_plan_path.exists()
            && read_json(&role_plan_path)
                .ok()
                .and_then(|role_plan| {
                    role_plan
                        .get("action_type")
                        .and_then(Value::as_str)
                        .map(|action_type| action_type == "supervisor_engineering_bugfix")
                })
                .unwrap_or(false);
        if !is_engineering_lane {
            continue;
        }
        total += 1;
        if !lane_dir.join("final-status.json").exists() {
            active = true;
        }
    }
    Ok((active, total))
}

fn maintainer_owns_code_fixes() -> bool {
    env::var("RESEARCHLAB_MAINTAINER").is_ok_and(|value| value.trim() == "1")
}

pub(crate) fn supervisor_spawn_engineering_bugfix_lane(
    paths: &AppPaths,
    cycle_id: &str,
    contracts: &[PathBuf],
) -> Result<Option<Value>> {
    // The orchestrator's maintainer (src/orchestrator/maintainer.js) owns harness
    // code fixes when it is on: it runs between run-plan calls, so a pause cannot
    // hold it, and it gates, commits and rebuilds. This lane edits the same code
    // with none of that, and queued behind the cycle's work it may never run
    // (cycle-b-20260918's followup-supervisor-01).
    if maintainer_owns_code_fixes() {
        return Ok(None);
    }
    let (active_engineering_lane, engineering_lane_count) =
        supervisor_engineering_bugfix_lane_state(paths, cycle_id)?;
    let max_engineering_bugfix_lanes = env::var("RESEARCHLAB_SUPERVISOR_ENGINEERING_BUGFIX_CAP")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(3);
    if active_engineering_lane || engineering_lane_count >= max_engineering_bugfix_lanes {
        return Ok(None);
    }

    for contract_path in contracts {
        let Some(lane_dir) = contract_path.parent() else {
            continue;
        };
        let final_status_path = lane_dir.join("final-status.json");
        if !final_status_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("failed") {
            continue;
        }
        let contract: LaneContract = serde_json::from_value(read_json(contract_path)?)?;
        let result_path = lane_dir.join("result.json");
        let result = if result_path.exists() {
            read_json(&result_path).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        if contract.role == "scout"
            && contract.runtime_class == "external-driver"
            && failed_data_scout_signal_failure(&result, &final_status)
        {
            continue;
        }
        let Some(signature) = infrastructure_bug_signature(&result, &final_status) else {
            continue;
        };
        let root_lane_id = dependency_base_lane_id(&contract.lane_id);
        let recovery_reason = format!("engineering-bugfix-{signature}");
        if existing_recovery_lane_for_origin(
            paths,
            cycle_id,
            "supervisor",
            &root_lane_id,
            &recovery_reason,
        )?
        .is_some()
        {
            continue;
        }

        let new_lane_id = next_followup_lane_id(paths, cycle_id, "followup-supervisor-")?;
        let original_task = fs::read_to_string(&contract.task_file).unwrap_or_default();
        let task = format!(
            "# Supervisor Engineering Bugfix Task\n\n\
cycle_id: {cycle_id}\n\
blocked_lane_id: {}\n\
blocked_role: {}\n\
blocked_runtime_class: {}\n\
bug_signature: {signature}\n\
final_status_path: {}\n\
result_path: {}\n\n\
The research cycle is blocked by an infrastructure/runtime bug, not a scientific judgment. Fix the smallest repository-side bug that prevents progress.\n\n\
Rules:\n\
- Do not invent, alter, or promote scientific claims.\n\
- Do not edit research results to make gates pass.\n\
- Prefer deterministic runtime/orchestrator fixes, dependency guards, path repairs, schema fixes, and recovery automation.\n\
- Preserve safety gates; only unblock execution plumbing.\n\
- Run the smallest meaningful verification, preferably `node ./src/cli native-build` and a targeted test or dry-run.\n\
- Write a concise JSON result describing files_changed, verification, and whether a restart/resume is needed.\n\n\
Original task excerpt for context only:\n\n{}\n",
            contract.lane_id,
            contract.role,
            contract.runtime_class,
            final_status_path.display(),
            result_path.display(),
            original_task.chars().take(4000).collect::<String>()
        );
        let new_contract_path = create_lane_contract(
            paths,
            cycle_id,
            &new_lane_id,
            "supervisor",
            "codex-agent",
            "read-write-scoped",
            &task,
        )?;
        let role_plan_path = write_followup_role_plan(
            paths,
            cycle_id,
            &new_lane_id,
            "supervisor",
            assigned_model_for_role("supervisor", "codex-agent"),
            "Fix an infrastructure bug that blocks research-cycle progress.",
            &contract.lane_id,
            &format!(
                "Supervisor engineering recovery for {} ({signature}); patch the smallest runtime/orchestrator bug and verify.",
                contract.lane_id
            ),
            "supervisor_engineering_bugfix",
            &[],
            &[],
            None,
            None,
            None,
            &[],
            json!({
                "recovery_reason": recovery_reason,
                "original_lane_id": contract.lane_id,
                "root_lane_id": root_lane_id,
                "blocked_role": contract.role,
                "blocked_runtime_class": contract.runtime_class,
                "bug_signature": signature,
                "final_status_path": final_status_path,
                "result_path": result_path,
                "safety_policy": {
                    "may_edit": ["runtime/orchestrator source", "driver guards", "schema handling", "dependency/path repair", "supervisor recovery logic"],
                    "must_not_edit": ["scientific conclusions to force gate passage", "author/illustrator outputs to bypass gates", "raw evidence provenance"],
                    "verification_required": true
                }
            }),
        )?;
        let action = json!({
            "lane_id": contract.lane_id,
            "action": "spawn_supervisor_engineering_bugfix_lane",
            "reason": recovery_reason,
            "bug_signature": signature,
            "replacement_lane_id": new_lane_id,
            "replacement_contract_path": new_contract_path,
            "replacement_role_plan_path": role_plan_path,
        });
        append_event(
            &supervisor_events_path(paths, cycle_id),
            "supervisor_action",
            action.clone(),
        )?;
        return Ok(Some(action));
    }
    Ok(None)
}

pub(crate) fn supervisor_supersede_stale_pending_labdirector_requery(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    root: &Path,
) -> Result<Option<Value>> {
    if contract.role != "lab-director" {
        return Ok(None);
    }
    let role_plan_path = root.join("role-plan.json");
    let final_status_path = root.join("final-status.json");
    let run_state_path = root.join("run-state.json");
    if final_status_path.exists() || run_state_path.exists() || !role_plan_path.exists() {
        return Ok(None);
    }
    let Some(role_plan) = read_role_plan_if_compact(&role_plan_path)? else {
        return Ok(None);
    };
    if role_plan.get("action_type").and_then(Value::as_str) != Some("lab_director_requery_followup")
    {
        return Ok(None);
    }
    let latest_chronicle = latest_completed_followup_action_at(
        paths,
        cycle_id,
        "chronicle",
        "chronicle_evidence_request_followup",
        None,
    )?;
    let Some(latest_chronicle) = latest_chronicle else {
        return Ok(None);
    };
    let role_plan_modified = fs::metadata(&role_plan_path)
        .and_then(|meta| meta.modified())
        .ok()
        .map(DateTime::<Utc>::from);
    let stale_pending_requery_grace_seconds =
        env::var("RESEARCHLAB_SUPERVISOR_STALE_PENDING_LABDIRECTOR_REQUERY_GRACE_SECONDS")
            .ok()
            .and_then(|raw| raw.trim().parse().ok())
            .filter(|value: &i64| *value >= 0)
            .unwrap_or(600);
    let stale_enough_to_supersede = role_plan_modified
        .map(|modified| {
            modified < latest_chronicle
                && (latest_chronicle - modified).num_seconds() > stale_pending_requery_grace_seconds
        })
        .unwrap_or(false);
    if !stale_enough_to_supersede {
        return Ok(None);
    }

    let status = json!({
        "lane_id": contract.lane_id,
        "status": "aborted",
        "completed_at": now_iso(),
        "degraded": true,
        "failure_category": "supervisor_superseded_stale_pending_labdirector_requery",
        "role_plan_path": role_plan_path,
        "supervisor_recovered": true,
        "supervisor_recovery_reason": "stale_pending_labdirector_requery_older_than_chronicle_evidence",
        "latest_chronicle_evidence_completed_at": latest_chronicle.to_rfc3339(),
    });
    write_json(&final_status_path, &status)?;
    let action = json!({
        "lane_id": contract.lane_id,
        "action": "supersede_stale_pending_labdirector_requery",
        "reason": "pending LabDirector requery role-plan predates newer Chronicle evidence; dispatch should create a fresh adjudication lane",
        "latest_chronicle_evidence_completed_at": latest_chronicle.to_rfc3339(),
        "final_status_path": final_status_path,
    });
    append_event(
        &supervisor_events_path(paths, cycle_id),
        "supervisor_action",
        action.clone(),
    )?;
    Ok(Some(action))
}

/// Retire a queued runner-recovery director lane whose runner a director has
/// already ruled on.
///
/// MEASURED ON cycle-a-20260919, 2026-10-06. The request lane is
/// created the moment the runner finishes, and then waits for a director slot.
/// Directors 470 and 475 were created at 14:31 and 18:47 for runners 154 and
/// 157; before either started, directors 468-474 ruled on runner-154 by name,
/// and 474 on runner-157. Suppressing the request at dispatch (see
/// runner_adjudicated_by_director) cannot reach a lane that already exists, so
/// the queued one is retired here, before it runs, as the stale pending requery
/// above is.
pub(crate) fn supervisor_supersede_adjudicated_runner_recovery(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    root: &Path,
) -> Result<Option<Value>> {
    if contract.role != "lab-director" {
        return Ok(None);
    }
    let role_plan_path = root.join("role-plan.json");
    let final_status_path = root.join("final-status.json");
    if final_status_path.exists() || root.join("run-state.json").exists() || !role_plan_path.exists() {
        return Ok(None);
    }
    let Some(role_plan) = read_role_plan_if_compact(&role_plan_path)? else {
        return Ok(None);
    };
    if role_plan.get("action_type").and_then(Value::as_str) != Some("lab_director_requery_followup") {
        return Ok(None);
    }
    let Some(runner_lane_id) = role_plan
        .get("source_brief_id")
        .and_then(Value::as_str)
        .and_then(|source| source.strip_prefix("labdirector-runner-recovery-"))
        .filter(|runner| !runner.is_empty())
        .map(str::to_string)
    else {
        return Ok(None);
    };
    if !runner_adjudicated_by_director(paths, cycle_id, &runner_lane_id)? {
        return Ok(None);
    }
    write_json(
        &final_status_path,
        &json!({
            "lane_id": contract.lane_id,
            "status": "aborted",
            "completed_at": now_iso(),
            "degraded": true,
            "failure_category": "supervisor_superseded_adjudicated_runner_recovery",
            "role_plan_path": role_plan_path,
            "supervisor_recovered": true,
            "supervisor_recovery_reason": "a LabDirector already ruled on this runner by name before this request started",
            "runner_lane_id": runner_lane_id,
        }),
    )?;
    let action = json!({
        "lane_id": contract.lane_id,
        "action": "supersede_adjudicated_runner_recovery",
        "reason": "the runner this request asks about was already ruled on by a completed LabDirector lane",
        "runner_lane_id": runner_lane_id,
        "final_status_path": final_status_path,
    });
    append_event(&supervisor_events_path(paths, cycle_id), "supervisor_action", action.clone())?;
    Ok(Some(action))
}

pub(crate) fn supervisor_supersede_redundant_pending_gate_reviews(
    paths: &AppPaths,
    cycle_id: &str,
    contract_paths: &[PathBuf],
) -> Result<Vec<Value>> {
    #[derive(Clone)]
    struct PendingReview {
        lane_id: String,
        root: PathBuf,
        created: SystemTime,
        active: bool,
    }

    let mut by_rubric: HashMap<String, Vec<PendingReview>> = HashMap::new();
    for contract_path in contract_paths {
        let Some(root) = contract_path.parent() else {
            continue;
        };
        let contract: LaneContract = serde_json::from_value(read_json(contract_path)?)?;
        if contract.role != "gatekeeper"
            || lane_has_finalized_outputs(paths, cycle_id, &contract.lane_id)
        {
            continue;
        }
        let role_plan_path = root.join("role-plan.json");
        let Some(role_plan) = read_role_plan_if_compact(&role_plan_path)? else {
            continue;
        };
        if role_plan.get("action_type").and_then(Value::as_str)
            != Some("independent_gate_review_followup")
        {
            continue;
        }
        let target_rubric = role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("target_rubric"))
            .or_else(|| role_plan.get("target_rubric"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if target_rubric.is_empty() {
            continue;
        }
        let run_state_path = root.join("run-state.json");
        let final_status_path = root.join("final-status.json");
        let active = run_state_path.exists()
            || final_status_path.exists()
            || lane_process_is_alive(paths, cycle_id, &contract.lane_id);
        let created = fs::metadata(contract_path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        by_rubric
            .entry(target_rubric.to_string())
            .or_default()
            .push(PendingReview {
                lane_id: contract.lane_id,
                root: root.to_path_buf(),
                created,
                active,
            });
    }

    let mut actions = Vec::new();
    for (target_rubric, reviews) in by_rubric {
        if reviews.len() < 2 {
            continue;
        }
        let active_exists = reviews.iter().any(|review| review.active);
        let newest = reviews
            .iter()
            .max_by_key(|review| review.created)
            .map(|review| review.lane_id.clone());
        for review in reviews {
            if review.active || (!active_exists && newest.as_deref() == Some(&review.lane_id)) {
                continue;
            }
            // MEASURED ON cycle-a-20260919, 2026-10-01: the records
            // read by pipeline health contained 58 pending gate reviews all
            // assigned technical_quality. Later reviews completed while those
            // contracts remained queued, ready to repeat the same current
            // review after role-plan refresh. One unopened review per rubric is
            // sufficient; keep the active one, or otherwise the newest context.
            let final_status_path = review.root.join("final-status.json");
            write_json(
                &final_status_path,
                &json!({
                    "lane_id": review.lane_id,
                    "status": "aborted",
                    "completed_at": now_iso(),
                    "degraded": true,
                    "failure_category": "supervisor_superseded_redundant_pending_gate_review",
                    "role_plan_path": review.root.join("role-plan.json"),
                    "supervisor_recovered": true,
                    "supervisor_recovery_reason": "redundant_pending_gate_review_for_same_rubric",
                    "target_rubric": target_rubric,
                }),
            )?;
            let action = json!({
                "lane_id": review.lane_id,
                "action": "supersede_redundant_pending_gate_review",
                "reason": "another open independent gate review already owns this rubric; only the newest dispatch context should run",
                "target_rubric": target_rubric,
                "final_status_path": final_status_path,
            });
            append_event(
                &supervisor_events_path(paths, cycle_id),
                "supervisor_action",
                action.clone(),
            )?;
            actions.push(action);
        }
    }
    Ok(actions)
}

pub(crate) fn direct_handoff_runner_role_plan_path(role_plan: &Value) -> Option<String> {
    // MEASURED ON cycle-a-20260919, 2026-10-17: runner 390 was
    // labelled as a LabDirector hypothesis_followup, but the external runner
    // still executed planner_metadata.analyst_handoff_path from analyst 909.
    // Execution binding is the path, not the action/source labels.
    [
        "/planner_metadata/analysis_request/handoff_path",
        "/planner_metadata/analysis_request/analyst_handoff_path",
        "/planner_metadata/analyst_handoff_path",
        "/planner_metadata/handoff_path",
        "/planner_metadata/validation_results/analyst_handoff_path",
        "/metadata/analysis_request/handoff_path",
        "/analysis_request/handoff_path",
    ]
    .iter()
    .filter_map(|pointer| role_plan.pointer(pointer))
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

pub(crate) fn latest_executable_analyst_handoff_path(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<String>> {
    let Some(signal) = latest_analyst_handoff_signal(paths, cycle_id)? else {
        return Ok(None);
    };
    let payload = signal.get("payload").cloned().unwrap_or(Value::Null);
    if !analyst_handoff_is_executable(&payload) {
        return Ok(None);
    }
    Ok(signal
        .get("path")
        .and_then(Value::as_str)
        .map(ToString::to_string))
}

/// Seconds an already-running lab-runner is left alone before a newer analyst
/// handoff may supersede it.
///
/// Sized from what the runner was promised rather than picked: the python-stats
/// driver gives a handoff a ~1500s wall clock
/// (DRIVER_WALL_CLOCK_BUDGET_SECONDS), and the lane spends comparable time on
/// agent authoring, dependency setup and the post-run report before it writes
/// anything. Keep the two roughly in step if the driver budget changes.
pub(crate) const RUNNER_SUPERSEDE_GRACE_SECONDS_DEFAULT: i64 = 3_000;

pub(crate) fn runner_supersede_grace_seconds() -> i64 {
    std::env::var("RESEARCHLAB_RUNNER_SUPERSEDE_GRACE_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(RUNNER_SUPERSEDE_GRACE_SECONDS_DEFAULT)
}

pub(crate) fn supervisor_supersede_stale_direct_handoff_runner(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    root: &Path,
) -> Result<Option<Value>> {
    if contract.role != "lab-runner" {
        return Ok(None);
    }
    let final_status_path = root.join("final-status.json");
    let role_plan_path = root.join("role-plan.json");
    if final_status_path.exists() || !role_plan_path.exists() {
        return Ok(None);
    }
    let Some(role_plan) = read_role_plan_if_compact(&role_plan_path)? else {
        return Ok(None);
    };
    let Some(runner_handoff_path) = direct_handoff_runner_role_plan_path(&role_plan) else {
        return Ok(None);
    };
    let Some(latest_handoff_path) = latest_executable_analyst_handoff_path(paths, cycle_id)? else {
        return Ok(None);
    };
    if normalized_path_key(&runner_handoff_path) == normalized_path_key(&latest_handoff_path) {
        return Ok(None);
    }

    let run_state_path = root.join("run-state.json");
    let run_state = if run_state_path.exists() {
        read_json(&run_state_path).ok()
    } else {
        None
    };
    let run_state_status = run_state.as_ref().and_then(|value| {
        value
            .get("status")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    if let Some(status) = run_state_status.as_deref() {
        if !matches!(status, "pending" | "prepared" | "running" | "queued") {
            return Ok(None);
        }
    }

    // COMPLETION GRACE: a runner that is already EXECUTING is left to finish.
    //
    // Superseding a runner whose handoff is stale is right when nothing is lost —
    // a lane that has not launched yet holds no work, and killing it is the whole
    // point of this rule. Killing one mid-render is a different act: it destroys
    // the only thing in the cycle that produces evidence.
    //
    // Measured on cycle-g-v74: 76 runner lanes ended `aborted / superseded by
    // newer executable analyst handoff` and not one of them ever wrote a result.
    // With the analyst emitting a fresh handoff every few minutes and a render
    // sweep taking longer than that, no runner could reach the finish line, so
    // reproducibility sat at 14-25 across 158 gate reviews while novelty climbed
    // to 55 — the gate could never pass because the evidence side was structurally
    // starved. Raising the per-blueprint compute budget 240s -> ~1494s (44c8e8e)
    // widened the window in which a runner can be killed, so the two changes have
    // to land together.
    //
    // The grace is bounded, so a genuinely wedged runner is still reclaimed: it is
    // roughly the compute budget the runner was promised (the driver's own
    // ~1500s wall clock) plus the same again for agent authoring and setup. Past
    // that it is not going to produce evidence and the stale-handoff argument wins
    // again. Tunable with RESEARCHLAB_RUNNER_SUPERSEDE_GRACE_SECONDS; 0 restores
    // the old kill-immediately behaviour.
    if run_state_status.as_deref() == Some("running") {
        if let Some(state) = run_state.as_ref() {
            if running_lane_recently_updated(state, runner_supersede_grace_seconds()) {
                return Ok(None);
            }
        }
    }

    let abort_details = if run_state_status.as_deref() == Some("running") {
        abort_lane(paths, cycle_id, &contract.lane_id).unwrap_or_else(|err| {
            json!({
                "aborted": false,
                "error": err.to_string(),
            })
        })
    } else {
        json!({
            "aborted": false,
            "reason": "pending stale direct handoff runner superseded before launch",
        })
    };

    let final_status = json!({
        "lane_id": contract.lane_id,
        "status": "aborted",
        "completed_at": now_iso(),
        "degraded": true,
        "failure_category": "supervisor_superseded_stale_direct_handoff_runner",
        "role_plan_path": role_plan_path,
        "supervisor_recovered": true,
        "supervisor_recovery_reason": "direct lab-runner handoff predates or differs from latest executable analyst handoff",
        "stale_runner_handoff_path": runner_handoff_path,
        "latest_executable_handoff_path": latest_handoff_path,
        "abort_details": abort_details,
    });
    write_json(&final_status_path, &final_status)?;
    write_json(
        &run_state_path,
        &json!({
            "lane_id": contract.lane_id,
            "role": contract.role,
            "status": "aborted",
            "updated_at": now_iso(),
            "reason": "superseded by newer executable analyst handoff",
        }),
    )?;
    let _ = fs::remove_file(lane_process_path(paths, cycle_id, &contract.lane_id));

    let action = json!({
        "lane_id": contract.lane_id,
        "action": "supersede_stale_direct_handoff_runner",
        "reason": "direct lab-runner handoff does not match the latest executable analyst handoff; stale runner must not consume role availability or unlock gates",
        "stale_runner_handoff_path": final_status["stale_runner_handoff_path"].clone(),
        "latest_executable_handoff_path": final_status["latest_executable_handoff_path"].clone(),
        "final_status_path": final_status_path,
    });
    append_event(
        &supervisor_events_path(paths, cycle_id),
        "supervisor_action",
        action.clone(),
    )?;
    Ok(Some(action))
}
