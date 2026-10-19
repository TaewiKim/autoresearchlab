#![allow(unused_imports)]
use super::*;

pub fn termination_status(
    paths: &AppPaths,
    cycle_id: &str,
    report_path: Option<&Path>,
) -> Result<Value> {
    let cycle_plan = read_json(&plans_root(paths).join(format!("{cycle_id}-cycle-plan.json")))?;
    let cycle_state =
        read_json(&state_root(paths).join(format!("{cycle_id}-cycle-run-state.json")))?;
    let final_claim_package_path =
        state_root(paths).join(format!("{cycle_id}-final-claim-package.json"));
    let final_claim_package = if final_claim_package_path.exists() {
        Some(read_json(&final_claim_package_path)?)
    } else {
        None
    };
    let started_at = cycle_plan
        .get("created_at")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("cycle plan missing created_at"))?;
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at)?.with_timezone(&Utc);
    let elapsed_hours = (Utc::now() - started_at).num_minutes() as f64 / 60.0;
    let min_runtime_hours = cycle_plan
        .get("minimum_runtime_hours")
        .and_then(Value::as_f64)
        .unwrap_or(8.0);
    let min_supported_claims = cycle_plan
        .get("termination_conditions")
        .and_then(|item| item.get("minimum_supported_claims"))
        .and_then(Value::as_u64)
        .unwrap_or(2) as usize;
    let min_completed_experiment_lanes = cycle_plan
        .get("termination_conditions")
        .and_then(|item| item.get("minimum_completed_experiment_lanes"))
        .and_then(Value::as_u64)
        .unwrap_or(4) as usize;
    let conclusion_gate_passed =
        state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
    let conclusion_gate_passed = if conclusion_gate_passed.exists() {
        read_json(&conclusion_gate_passed)?
            .get("conclusion_gate_passed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        false
    };
    let hypothesis_gate_passed = hypothesis_gate_passed(paths, cycle_id)?;
    let report_gate_passed = state_root(paths).join(format!("{cycle_id}-report-review.json"));
    let report_gate_passed = if report_gate_passed.exists() {
        read_json(&report_gate_passed)?
            .get("report_gate_passed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        false
    };
    let paper_gate_passed = state_root(paths).join(format!("{cycle_id}-paper-review.json"));
    let paper_gate_passed = if paper_gate_passed.exists() {
        read_json(&paper_gate_passed)?
            .get("paper_gate_passed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        false
    };

    let completed_experiment_lanes = cycle_state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("completed"))
        .count();

    let supported_claims = cycle_briefs(paths, cycle_id)?
        .iter()
        .map(|brief| {
            brief
                .get("claim_deltas")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter(|item| {
                    matches!(
                        item.get("current").and_then(Value::as_str),
                        Some("exploratory") | Some("robust") | Some("supported")
                    )
                })
                .count()
        })
        .sum::<usize>();

    let report_ready = report_path.map(|path| path.exists()).unwrap_or(false);
    let approval_review_path = state_root(paths).join(format!("{cycle_id}-approval-review.json"));
    let raw_approval_gate_passed = if approval_review_path.exists() {
        let review = read_json(&approval_review_path)?;
        review
            .get("approval_gate_passed")
            .and_then(Value::as_bool)
            .or_else(|| review.get("pass").and_then(Value::as_bool))
            .unwrap_or(false)
    } else {
        false
    };
    let document_gate_passed = report_gate_passed && paper_gate_passed;
    let approval_gate_passed = raw_approval_gate_passed
        && conclusion_gate_passed
        && hypothesis_gate_passed
        && document_gate_passed;
    let derived_gate_passed = elapsed_hours >= min_runtime_hours
        && supported_claims >= min_supported_claims
        && completed_experiment_lanes >= min_completed_experiment_lanes
        && report_ready
        && conclusion_gate_passed
        && hypothesis_gate_passed
        && report_gate_passed
        && paper_gate_passed;
    let execution_completion = final_claim_package
        .as_ref()
        .and_then(|item| item.get("execution_completion"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            cycle_state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string()
        });
    let research_outcome = final_claim_package
        .as_ref()
        .and_then(|item| item.get("research_outcome"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if conclusion_gate_passed && report_gate_passed && paper_gate_passed {
                "approved".to_string()
            } else if supported_claims == 0 {
                "stopped_without_conclusion".to_string()
            } else {
                "refine".to_string()
            }
        });
    let research_outcome = if conclusion_gate_passed {
        research_outcome
    } else {
        "refine".to_string()
    };
    let should_continue_for_research_outcome = matches!(
        research_outcome.as_str(),
        "refine" | "pivot" | "stopped_without_conclusion"
    );
    let termination_code = read_termination_code(paths, cycle_id)?;
    let should_terminate_execution = termination_code
        .as_ref()
        .and_then(|item| item.get("should_stop"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let termination_reason = if let Some(code) = termination_code
        .as_ref()
        .and_then(|item| item.get("reason"))
        .and_then(Value::as_str)
    {
        code
    } else if derived_gate_passed || approval_gate_passed {
        "derived gate checks indicate the cycle can stop once a termination code is written"
    } else if should_continue_for_research_outcome {
        "execution can continue because research outcome is not approved yet"
    } else {
        "waiting for execution completion criteria"
    };

    Ok(json!({
        "cycle_id": cycle_id,
        "elapsed_hours": elapsed_hours,
        "minimum_runtime_hours": min_runtime_hours,
        "supported_claims": supported_claims,
        "minimum_supported_claims": min_supported_claims,
        "completed_experiment_lanes": completed_experiment_lanes,
        "minimum_completed_experiment_lanes": min_completed_experiment_lanes,
        "raw_approval_gate_passed": raw_approval_gate_passed,
        "approval_gate_passed": approval_gate_passed,
        "conclusion_gate_passed": conclusion_gate_passed,
        "hypothesis_gate_passed": hypothesis_gate_passed,
        "report_gate_passed": report_gate_passed,
        "paper_gate_passed": paper_gate_passed,
        "document_gate_passed": document_gate_passed,
        "report_ready": report_ready,
        "execution_completion": execution_completion,
        "research_outcome": research_outcome,
        "derived_gate_passed": derived_gate_passed,
        "should_terminate_execution": should_terminate_execution,
        "should_continue_for_research_outcome": should_continue_for_research_outcome,
        "termination_reason": termination_reason,
        "termination_code_path": termination_code_path(paths, cycle_id),
        "termination_code": termination_code,
        "should_terminate": should_terminate_execution,
    }))
}

pub(crate) fn numeric_signal_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub(crate) fn find_numeric_signal(value: &Value, keys: &[&str]) -> Option<f64> {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                if keys
                    .iter()
                    .any(|candidate| key.eq_ignore_ascii_case(candidate))
                {
                    if let Some(signal) = numeric_signal_from_value(nested) {
                        return Some(signal);
                    }
                }
                if let Some(signal) = find_numeric_signal(nested, keys) {
                    return Some(signal);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|nested| find_numeric_signal(nested, keys)),
        _ => None,
    }
}

pub(crate) fn codex_pacing_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("runtime")
        .join(format!("{cycle_id}-codex-pacing.json"))
}

#[derive(serde::Deserialize)]
pub(crate) struct PacingContractFields {
    pub(crate) lane_id: String,
    pub(crate) runtime_class: String,
}

pub(crate) fn compact_json_text_window(path: &Path) -> Result<String> {
    let size = fs::metadata(path)?.len();
    let text = if size > 1024 * 1024 {
        json_file_window_text(path, 512 * 1024)?
    } else {
        fs::read_to_string(path)?
    };
    Ok(text.replace(char::is_whitespace, ""))
}

pub(crate) fn adaptive_codex_pacing_snapshot(
    paths: &AppPaths,
    cycle_id: &str,
    configured_sleep_seconds: u64,
    launched_count: usize,
    created_followups_count: usize,
) -> Result<Value> {
    let mut codex_lane_count = 0usize;
    let mut codex_running_count = 0usize;
    let mut degraded_count = 0usize;
    let mut rate_limited_count = 0usize;
    let mut quota_exceeded_count = 0usize;
    let mut auth_refresh_wait_count = 0usize;
    let mut context_window_count = 0usize;
    let mut timeout_count = 0usize;
    let mut token_telemetry_count = 0usize;
    let mut min_remaining_tokens: Option<f64> = None;
    let mut max_usage_tokens: Option<f64> = None;

    let mut inspect_active_codex_result = |result_path: &Path| -> Result<()> {
        let compact = compact_json_text_window(&result_path)?;
        if compact.contains("\"degraded\":true") {
            degraded_count += 1;
        }
        // Backoff pacing is driven only by active Codex pressure. Historical
        // finalized lane results can be huge, and repeatedly scanning/parsing
        // them stalls dispatch before new Analyst/LabRunner work is created.
        if compact.contains("\"failure_category\":\"rate_limited\"") {
            rate_limited_count += 1;
        } else if compact.contains("\"failure_category\":\"quota_exceeded\"") {
            quota_exceeded_count += 1;
        } else if compact.contains("\"failure_category\":\"context_window_exceeded\"") {
            context_window_count += 1;
        } else if compact.contains("\"failure_category\":\"timeout\"") {
            timeout_count += 1;
        }
        if compact.contains("\"retry_reason\":\"codex_auth_expired\"") {
            auth_refresh_wait_count += 1;
        }
        if !compact.contains("remaining_tokens")
            && !compact.contains("remaining_token_count")
            && !compact.contains("tokens_remaining")
            && !compact.contains("remaining_budget_tokens")
            && !compact.contains("total_tokens")
            && !compact.contains("total_token_count")
            && !compact.contains("usage_total_tokens")
        {
            return Ok(());
        }
        let payload = read_json(&result_path)?;
        if let Some(remaining_tokens) = find_numeric_signal(
            &payload,
            &[
                "remaining_tokens",
                "remaining_token_count",
                "tokens_remaining",
                "remaining_budget_tokens",
            ],
        ) {
            token_telemetry_count += 1;
            min_remaining_tokens = Some(
                min_remaining_tokens
                    .map(|current| current.min(remaining_tokens))
                    .unwrap_or(remaining_tokens),
            );
        }
        if let Some(total_tokens) = find_numeric_signal(
            &payload,
            &["total_tokens", "total_token_count", "usage_total_tokens"],
        ) {
            max_usage_tokens = Some(
                max_usage_tokens
                    .map(|current| current.max(total_tokens))
                    .unwrap_or(total_tokens),
            );
        }
        Ok(())
    };

    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            if lane.get("runtime_class").and_then(Value::as_str) != Some("codex-agent") {
                continue;
            }
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if lane_id.is_empty() {
                continue;
            }
            codex_lane_count += 1;
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            let lane_has_process = lane_process_path(paths, cycle_id, lane_id).exists();
            let lane_active = lane_has_process
                && !matches!(status, "completed" | "failed" | "aborted" | "cancelled");
            if lane_active {
                codex_running_count += 1;
            }
            let result_path = lane
                .get("result_path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| lane_root(paths, cycle_id, lane_id).join("result.json"));
            if lane_active && result_path.exists() {
                inspect_active_codex_result(&result_path)?;
            }
        }
    } else {
        for contract_path in all_cycle_contract_paths(paths, cycle_id)? {
            let contract_text = fs::read_to_string(&contract_path)?;
            if !contract_text.contains("\"runtime_class\"")
                || !contract_text.contains("codex-agent")
            {
                continue;
            }
            let contract: PacingContractFields = serde_json::from_str(&contract_text)?;
            if contract.runtime_class != "codex-agent" {
                continue;
            }
            codex_lane_count += 1;
            let lane_dir = lane_root(paths, cycle_id, &contract.lane_id);
            let lane_has_process = lane_process_path(paths, cycle_id, &contract.lane_id).exists();
            let lane_finalized = lane_dir.join("final-status.json").exists();
            let lane_active = lane_has_process && !lane_finalized;
            if lane_active {
                codex_running_count += 1;
            }
            let result_path = lane_dir.join("result.json");
            if lane_active && result_path.exists() {
                inspect_active_codex_result(&result_path)?;
            }
        }
    }
    drop(inspect_active_codex_result);

    let mut pause_seconds = 0u64;
    let mut pause_reason = "immediate-dispatch";

    if quota_exceeded_count > 0 {
        pause_seconds = 900;
        pause_reason = "quota-exceeded-backoff";
    } else if auth_refresh_wait_count > 0 {
        pause_seconds = 300;
        pause_reason = "auth-refresh-backoff";
    } else if rate_limited_count > 0 {
        pause_seconds = 120;
        pause_reason = "rate-limit-backoff";
    } else if let Some(remaining_tokens) = min_remaining_tokens {
        if remaining_tokens <= 1000.0 {
            pause_seconds = 300;
            pause_reason = "remaining-tokens-critical";
        } else if remaining_tokens <= 5000.0 {
            pause_seconds = 60;
            pause_reason = "remaining-tokens-low";
        } else if remaining_tokens <= 10000.0 {
            pause_seconds = 15;
            pause_reason = "remaining-tokens-guarded";
        }
    } else if codex_running_count > 0 {
        pause_seconds = 5;
        pause_reason = "codex-lanes-running";
    } else if launched_count == 0 && created_followups_count == 0 {
        pause_seconds = 30;
        pause_reason = "idle-backoff";
    }

    if configured_sleep_seconds > 0 && pause_seconds < configured_sleep_seconds {
        pause_seconds = configured_sleep_seconds;
        pause_reason = "manual-sleep-floor";
    }

    Ok(json!({
        "cycle_id": cycle_id,
        "generated_at": now_iso(),
        "configured_sleep_seconds": configured_sleep_seconds,
        "pause_seconds": pause_seconds,
        "pause_reason": pause_reason,
        "codex_lane_count": codex_lane_count,
        "codex_running_count": codex_running_count,
        "launched_count": launched_count,
        "created_followups_count": created_followups_count,
        "degraded_count": degraded_count,
        "rate_limited_count": rate_limited_count,
        "quota_exceeded_count": quota_exceeded_count,
        "auth_refresh_wait_count": auth_refresh_wait_count,
        "context_window_count": context_window_count,
        "timeout_count": timeout_count,
        "token_telemetry_count": token_telemetry_count,
        "min_remaining_tokens": min_remaining_tokens,
        "max_usage_tokens": max_usage_tokens,
        "direct_remaining_token_telemetry": token_telemetry_count > 0,
    }))
}

pub fn materialize_long_run_plan_with_objective(
    paths: &AppPaths,
    cycle_id: &str,
    objective_override: Option<&str>,
    agent_plan_override: Option<&Path>,
) -> Result<Value> {
    let blueprint = build_long_run_blueprint();
    let plan_dir = plans_root(paths);
    fs::create_dir_all(&plan_dir)?;
    let cycle_plan_path = plan_dir.join(format!("{cycle_id}-cycle-plan.json"));
    let lane_manifest_path = plan_dir.join(format!("{cycle_id}-lane-manifest.json"));
    let chronicle_schedule_path = plan_dir.join(format!("{cycle_id}-chronicle-schedule.json"));
    let checkpoint_schedule_path = plan_dir.join(format!("{cycle_id}-checkpoint-schedule.json"));
    let resolved_agent_plan_path = agent_plan_override
        .map(PathBuf::from)
        .unwrap_or_else(|| plan_dir.join(format!("{cycle_id}-agent-plan.json")));
    let external_agent_plan = if resolved_agent_plan_path.exists() {
        Some(read_json(&resolved_agent_plan_path)?)
    } else {
        None
    };
    let agents = external_agent_plan
        .as_ref()
        .and_then(|plan| plan.get("agents"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| blueprint["agents"].as_array().cloned().unwrap_or_default());

    if cycle_plan_path.exists()
        && lane_manifest_path.exists()
        && chronicle_schedule_path.exists()
        && checkpoint_schedule_path.exists()
    {
        let lane_manifest = read_json(&lane_manifest_path)?;
        return Ok(json!({
            "cycle_plan_path": cycle_plan_path,
            "lane_manifest_path": lane_manifest_path,
            "chronicle_schedule_path": chronicle_schedule_path,
            "checkpoint_schedule_path": checkpoint_schedule_path,
            "contract_paths": lane_manifest.as_array().cloned().unwrap_or_default().iter().filter_map(|lane| lane.get("contract_path").and_then(Value::as_str).map(ToString::to_string)).collect::<Vec<_>>(),
            "agent_count": lane_manifest.as_array().map(|items| items.len()).unwrap_or(0),
            "minimum_runtime_hours": blueprint["minimum_runtime_hours"],
            "agent_plan_path": resolved_agent_plan_path,
        }));
    }

    let mut lane_manifest = Vec::new();
    let mut contract_paths = Vec::new();
    let objective = objective_override
        .or_else(|| {
            external_agent_plan
                .as_ref()
                .and_then(|plan| plan.get("prompt").or_else(|| plan.get("objective")))
                .and_then(Value::as_str)
        })
        .unwrap_or_else(|| {
            blueprint["objective"]
                .as_str()
                .unwrap_or("Run a sustained research cycle.")
        });
    fs::write(plan_dir.join(format!("{cycle_id}-prompt.txt")), objective)?;

    for agent in agents {
        let lane_id = agent["agent_id"].as_str().unwrap_or("unknown");
        let role = agent["role"].as_str().unwrap_or("unknown");
        let runtime_class = agent["runtime_class"].as_str().unwrap_or("codex-agent");
        let contract_path = create_lane_contract(
            paths,
            cycle_id,
            lane_id,
            role,
            runtime_class,
            agent["lane_mode"].as_str().unwrap_or("read-only"),
            &task_markdown(&agent, cycle_id, objective),
        )?;
        if role == "analyst" {
            let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
            write_json(
                &role_plan_path,
                &initial_analyst_role_plan(&agent, objective),
            )?;
        } else if role == "scout" && lane_id == "scout-03" {
            let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
            write_json(
                &role_plan_path,
                &initial_data_scout_role_plan(&agent, objective),
            )?;
        } else if role == "lab-runner" {
            let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
            write_json(
                &role_plan_path,
                &initial_lab_runner_role_plan(&agent, objective),
            )?;
        } else if role == "gatekeeper" {
            let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
            write_json(
                &role_plan_path,
                &initial_gatekeeper_role_plan(&agent, objective),
            )?;
        }
        lane_manifest.push(json!({
            "lane_id": lane_id,
            "role": role,
            "runtime_class": runtime_class,
            "mode": agent["lane_mode"],
            "model": agent.get("model").cloned().unwrap_or(Value::Null),
            "duty": agent["duty"],
            "contract_path": contract_path
        }));
        contract_paths.push(contract_path.display().to_string());
    }

    let cycle_plan = json!({
        "cycle_id": cycle_id,
        "created_at": now_iso(),
        "blueprint_id": blueprint["blueprint_id"],
        "objective": objective,
        "minimum_runtime_hours": blueprint["minimum_runtime_hours"],
        "agent_count": lane_manifest.len(),
        "agent_plan_path": if resolved_agent_plan_path.exists() { json!(resolved_agent_plan_path) } else { Value::Null },
        "model_catalog_path": external_agent_plan
            .as_ref()
            .and_then(|plan| plan.get("model_catalog_path"))
            .cloned()
            .unwrap_or(Value::Null),
        "orchestration_mode": blueprint["orchestration_mode"],
        "supervision_model": blueprint["supervision_model"],
        "phases": blueprint["phases"],
        "termination_conditions": blueprint["termination_conditions"],
    });
    let chronicle_schedule = json!({
        "cycle_id": cycle_id,
        "brief_every_minutes": blueprint["chronicle_cadence"]["brief_every_minutes"],
        "dialogue_every_minutes": blueprint["chronicle_cadence"]["dialogue_every_minutes"],
        "open_question_refresh_every_minutes": blueprint["chronicle_cadence"]["open_question_refresh_every_minutes"],
    });
    let checkpoint_schedule = json!({
        "cycle_id": cycle_id,
        "checkpoints": blueprint["strategy_checkpoints"],
    });

    write_json(&cycle_plan_path, &cycle_plan)?;
    write_json(&lane_manifest_path, &json!(lane_manifest))?;
    write_json(&chronicle_schedule_path, &chronicle_schedule)?;
    write_json(&checkpoint_schedule_path, &checkpoint_schedule)?;

    Ok(json!({
        "cycle_plan_path": cycle_plan_path,
        "lane_manifest_path": lane_manifest_path,
        "chronicle_schedule_path": chronicle_schedule_path,
        "checkpoint_schedule_path": checkpoint_schedule_path,
        "contract_paths": contract_paths,
        "agent_count": lane_manifest.len(),
        "minimum_runtime_hours": blueprint["minimum_runtime_hours"],
        "agent_plan_path": if resolved_agent_plan_path.exists() { json!(resolved_agent_plan_path) } else { Value::Null },
    }))
}

pub fn materialize_long_run_plan(
    paths: &AppPaths,
    cycle_id: &str,
    agent_plan_override: Option<&Path>,
) -> Result<Value> {
    materialize_long_run_plan_with_objective(paths, cycle_id, None, agent_plan_override)
}

pub(crate) fn numeric_json_field(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|v| v as f64)))
}

pub(crate) fn pre_gate_pivot_reason(
    approval_gate_passed: bool,
    hypothesis_gate_passed: bool,
    completion_review: &Value,
    gate_review: &Value,
    pending_lane_count: u64,
    running_lane_total: u64,
    created_followups_count: usize,
    silence_seconds: i64,
    identical_completion_review_streak: u32,
    stagnation_repeat_limit: u32,
    stagnation_pending_silence_seconds: i64,
) -> Option<&'static str> {
    if approval_gate_passed {
        return None;
    }
    let no_runnable_work =
        pending_lane_count == 0 && running_lane_total == 0 && created_followups_count == 0;
    if no_runnable_work {
        return Some("no_runnable_work");
    }

    // A high approval/conclusion readiness score can mask a hard scientific
    // ceiling: if the actual hypothesis gate is still very low and there is no
    // supported claim delta, do not wait for the generic pending-lane silence
    // timer. Treat this as an immediate pivot signal so the LabDirector moves
    // to a new hypothesis/design family instead of polishing a blocked branch.
    let approval_readiness_score =
        numeric_json_field(completion_review, "approval_readiness_score")
            .or_else(|| numeric_json_field(completion_review, "approval_rubric_average"));
    let claim_count = numeric_json_field(completion_review, "claim_count").unwrap_or(0.0);
    let gate_score = numeric_json_field(gate_review, "score")
        .or_else(|| numeric_json_field(gate_review, "hypothesis_gate_score"));
    let gate_deferred_or_blocked = gate_review
        .get("mode")
        .and_then(Value::as_str)
        .map(|mode| matches!(mode, "defer" | "reject" | "blocked"))
        .unwrap_or(false)
        || gate_review.get("gate_passed").and_then(Value::as_bool) == Some(false);
    let scientifically_blocked_high_readiness = running_lane_total == 0
        && created_followups_count == 0
        && !hypothesis_gate_passed
        && approval_readiness_score
            .map(|score| score >= 90.0)
            .unwrap_or(false)
        && gate_score
            .map(|score| score <= 25.0)
            .unwrap_or(gate_deferred_or_blocked)
        && claim_count <= 0.0;
    if scientifically_blocked_high_readiness {
        return Some("scientific_gate_ceiling");
    }

    let pending_lanes_blocked = pending_lane_count > 0
        && running_lane_total == 0
        && created_followups_count == 0
        && silence_seconds >= stagnation_pending_silence_seconds;
    if pending_lanes_blocked {
        return Some("pending_lanes_blocked");
    }

    let repeated_review_stagnation = identical_completion_review_streak >= stagnation_repeat_limit
        && running_lane_total == 0
        && created_followups_count == 0;
    if repeated_review_stagnation {
        return Some("repeated_completion_review");
    }

    None
}
