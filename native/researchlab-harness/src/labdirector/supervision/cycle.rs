#![allow(unused_imports)]
use super::*;

pub(crate) const RUNNING_LANE_ORPHAN_GRACE_SECONDS: i64 = 180;

pub(crate) fn large_cycle_lane_statuses_for_supervision(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Vec<Value>>> {
    cached_large_cycle_lane_statuses(paths, cycle_id)
}

pub(crate) fn status_contract_path(
    paths: &AppPaths,
    cycle_id: &str,
    lane: &Value,
) -> Option<PathBuf> {
    lane.get("contract_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| {
            lane.get("lane_id")
                .and_then(Value::as_str)
                .map(|lane_id| lane_root(paths, cycle_id, lane_id).join("lane-contract.json"))
        })
}

pub(crate) fn supervision_contract_scope(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    if let Some(lane_statuses) = large_cycle_lane_statuses_for_supervision(paths, cycle_id)? {
        let mut seen_contracts = HashSet::new();
        let mut contracts = Vec::new();
        let mut seen_dirs = HashSet::new();
        let mut lane_dirs = Vec::new();
        for lane in &lane_statuses {
            let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) else {
                continue;
            };
            let lane_dir = lane_root(paths, cycle_id, lane_id);
            let dir_key = lane_dir.display().to_string();
            if seen_dirs.insert(dir_key) {
                lane_dirs.push(lane_dir);
            }
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if !matches!(status, "pending" | "prepared" | "running" | "failed") {
                continue;
            }
            let Some(contract_path) = status_contract_path(paths, cycle_id, lane) else {
                continue;
            };
            let key = contract_path.display().to_string();
            if seen_contracts.insert(key) && contract_path.exists() {
                contracts.push(contract_path);
            }
        }
        return Ok((contracts, lane_dirs));
    }

    let contracts = all_cycle_contract_paths(paths, cycle_id)?;
    let contract_lane_dirs = contracts
        .iter()
        .filter_map(|path| path.parent().map(PathBuf::from))
        .collect::<Vec<_>>();
    Ok((contracts, contract_lane_dirs))
}

pub fn supervise_cycle(
    paths: &AppPaths,
    cycle_id: &str,
    max_retries_per_lane: usize,
    stale_seconds: u64,
) -> Result<Vec<Value>> {
    let mut actions = Vec::new();
    let (contracts, contract_lane_dirs) = supervision_contract_scope(paths, cycle_id)?;
    let conclusion_needs_strategy = conclusion_needs_hypothesis_strategy(paths, cycle_id)?;

    actions.extend(supervisor_supersede_redundant_pending_gate_reviews(
        paths, cycle_id, &contracts,
    )?);

    for contract_path in &contracts {
        let Some(root) = contract_path.parent().map(PathBuf::from) else {
            continue;
        };
        let contract: LaneContract = serde_json::from_value(read_json(contract_path)?)?;
        let final_status_path = root.join("final-status.json");
        let run_state_path = root.join("run-state.json");
        if let Some(action) =
            supervisor_supersede_stale_direct_handoff_runner(paths, cycle_id, &contract, &root)?
        {
            actions.push(action);
            continue;
        }
        if let Some(action) = supervisor_supersede_stale_pending_labdirector_requery(
            paths, cycle_id, &contract, &root,
        )? {
            actions.push(action);
            continue;
        }
        if let Some(action) =
            supervisor_supersede_adjudicated_runner_recovery(paths, cycle_id, &contract, &root)?
        {
            actions.push(action);
            continue;
        }
        if final_status_path.exists() {
            if let Some(action) = supervisor_spawn_constrained_data_scout_retry(
                paths,
                cycle_id,
                &contract,
                &root,
                max_retries_per_lane,
            )? {
                actions.push(action);
            }
            continue;
        }
        if let Some(action) = supervisor_finalize_orphan_result(paths, cycle_id, &contract, &root)?
        {
            actions.push(action);
            continue;
        }
        let run_state = if run_state_path.exists() {
            Some(read_json(&run_state_path)?)
        } else {
            None
        };
        let should_inspect_contract = run_state
            .as_ref()
            .and_then(|value| value.get("status").and_then(Value::as_str))
            == Some("running");
        if !should_inspect_contract {
            continue;
        }
        let existing_recoveries = contract_lane_dirs
            .iter()
            .filter_map(|parent| parent.file_name().map(|name| name.to_string_lossy()))
            .filter(|name| name.starts_with(&format!("{}-recovery-", contract.lane_id)))
            .count();
        let active_recovery_exists = contract_lane_dirs
            .iter()
            .filter(|parent| {
                parent
                    .file_name()
                    .map(|name| {
                        name.to_string_lossy()
                            .starts_with(&format!("{}-recovery-", contract.lane_id))
                    })
                    .unwrap_or(false)
            })
            .any(|parent| {
                let final_status_path = parent.join("final-status.json");
                if final_status_path.exists() {
                    return false;
                }
                let run_state_path = parent.join("run-state.json");
                if !run_state_path.exists() {
                    return true;
                }
                read_json(&run_state_path)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("status")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .map(|status| status == "running" || status == "pending")
                    .unwrap_or(true)
            });

        if existing_recoveries >= max_retries_per_lane || active_recovery_exists {
            continue;
        }

        let mut recovery_reason = None;
        if let Some(run_state) = run_state {
            if run_state.get("status").and_then(Value::as_str) == Some("running") {
                let process_path = lane_process_path(paths, cycle_id, &contract.lane_id);
                if process_path.exists() {
                    let process = read_json(&process_path)?;
                    let pid = process.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let started_at = process
                        .get("started_at")
                        .and_then(Value::as_str)
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.with_timezone(&Utc));
                    let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
                    let role_plan = read_json(&role_plan_path).ok();
                    let lane_stale_seconds =
                        stale_threshold_for_lane(&contract, role_plan.as_ref(), stale_seconds);
                    let is_stale = started_at
                        .map(|value| (Utc::now() - value).num_seconds() as u64 > lane_stale_seconds)
                        .unwrap_or(true);

                    if pid == 0 || !process_is_alive(pid) {
                        recovery_reason = Some("orphaned-running".to_string());
                    } else if is_stale {
                        let aborted = abort_lane(paths, cycle_id, &contract.lane_id)?;
                        let action = json!({
                            "lane_id": contract.lane_id,
                            "action": "abort_stale_lane",
                            "details": aborted,
                        });
                        append_event(
                            &supervisor_events_path(paths, cycle_id),
                            "supervisor_action",
                            action.clone(),
                        )?;
                        actions.push(action);
                        recovery_reason = Some("stale-running".to_string());
                    }
                } else {
                    recovery_reason = Some("missing-process-metadata".to_string());
                }
            }
        }

        if let Some(reason) = recovery_reason {
            if contract.role == "analyst" && contract.lane_id.starts_with("followup-analyst-") {
                continue;
            }
            if matches!(contract.role.as_str(), "author" | "illustrator")
                && conclusion_needs_strategy
            {
                actions.push(json!({
                    "lane_id": contract.lane_id,
                    "action": "suppress_document_recovery",
                    "reason": reason,
                    "details": "conclusion gate requires lab-director hypothesis strategy before more document recovery",
                }));
                continue;
            }
            let current_role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
            let current_role_plan = if current_role_plan_path.exists() {
                Some(read_json(&current_role_plan_path)?)
            } else {
                None
            };
            let recovery_metadata = current_role_plan
                .as_ref()
                .and_then(|value| {
                    value
                        .get("planner_metadata")
                        .cloned()
                        .or_else(|| value.get("metadata").cloned())
                })
                .unwrap_or(Value::Null);
            let root_lane_id = recovery_metadata
                .get("root_lane_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    recovery_metadata
                        .get("original_lane_id")
                        .and_then(Value::as_str)
                })
                .unwrap_or(&contract.lane_id)
                .to_string();
            let root_lane_id = dependency_base_lane_id(&root_lane_id);
            if recovery_lane_count_for_origin(paths, cycle_id, &contract.role, &root_lane_id)?
                >= max_retries_per_lane
            {
                continue;
            }
            if existing_recovery_lane_for_origin(
                paths,
                cycle_id,
                &contract.role,
                &root_lane_id,
                &reason,
            )?
            .is_some()
            {
                continue;
            }
            let new_lane_id = next_recovery_lane_id(paths, cycle_id, &contract.lane_id)?;
            let original_task = fs::read_to_string(&contract.task_file).unwrap_or_default();
            let recovery_task = format!(
                "{original_task}\n\n## Recovery Instruction\n- original_lane_id: {}\n- recovery_reason: {}\n- action: restart the work, verify prior failure cause, and continue from available artifacts.\n",
                contract.lane_id, reason
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
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &new_lane_id,
                &contract.role,
                assigned_model_for_role(&contract.role, &contract.runtime_class),
                "Recover and continue the interrupted research task.",
                &contract.lane_id,
                "restart the work, verify prior failure cause, and continue from available artifacts",
                "recovery_followup",
                &[],
                &[],
                None,
                None,
                None,
                &[],
                json!({
                    "recovery_reason": reason,
                    "original_lane_id": contract.lane_id,
                    "root_lane_id": root_lane_id,
                    "runtime_class": contract.runtime_class,
                }),
            )?;
            let action = json!({
                "lane_id": contract.lane_id,
                "action": "spawn_recovery_lane",
                "reason": reason,
                "replacement_lane_id": new_lane_id,
                "replacement_contract_path": new_contract_path,
                "replacement_role_plan_path": role_plan_path,
            });
            append_event(
                &supervisor_events_path(paths, cycle_id),
                "supervisor_action",
                action.clone(),
            )?;
            actions.push(action);
        }
    }

    if let Some(action) = supervisor_spawn_engineering_bugfix_lane(paths, cycle_id, &contracts)? {
        actions.push(action);
    }

    Ok(actions)
}

pub fn latest_labdirector_decision(paths: &AppPaths, cycle_id: &str) -> Result<Option<Value>> {
    let max_tail_bytes = env::var("RESEARCHLAB_LABDIRECTOR_DECISION_TAIL_BYTES")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value >= 64 * 1024)
        .unwrap_or(8 * 1024 * 1024);
    // The newest segment that holds a readable record: the hour that has just
    // begun may be empty, or end in a record a crash cut short.
    for path in crate::core::support::labdirector_decision_segments(paths, cycle_id)
        .iter()
        .rev()
    {
        let mut file = fs::File::open(path)?;
        let file_len = file.metadata()?.len();
        let read_len = file_len.min(max_tail_bytes);
        file.seek(SeekFrom::Start(file_len.saturating_sub(read_len)))?;
        let mut bytes = Vec::with_capacity(read_len as usize);
        file.take(read_len).read_to_end(&mut bytes)?;
        let content = String::from_utf8_lossy(&bytes);
        for line in content.lines().rev() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                return Ok(Some(value));
            }
        }
    }
    Ok(None)
}

pub fn labdirector_completion_review(paths: &AppPaths, cycle_id: &str) -> Result<Value> {
    let report_dir = paths.runtime_root.join("reports");
    let paper_dir = paths.runtime_root.join("papers");
    let researcher_view_path = paths
        .runtime_root
        .join("researcher-views")
        .join(format!("{cycle_id}-researcher-view.json"));
    let mut report_json_path: Option<PathBuf> = None;
    let mut paper_path: Option<PathBuf> = None;
    let mut latest_report_rev = 0usize;
    if report_dir.exists() {
        for entry in read_dir(&report_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let prefix = format!("{cycle_id}-research-report-v");
            if name.starts_with(&prefix) && name.ends_with(".json") {
                let middle = name.trim_start_matches(&prefix).trim_end_matches(".json");
                if let Ok(rev) = middle.parse::<usize>() {
                    if rev >= latest_report_rev {
                        latest_report_rev = rev;
                        report_json_path = Some(entry.path());
                    }
                }
            }
        }
    }
    if latest_report_rev > 0 {
        let candidate = paper_dir.join(format!("{cycle_id}-paper-v{latest_report_rev:04}.tex"));
        if candidate.exists() {
            paper_path = Some(candidate);
        }
    }
    let cycle_state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    let report = if let Some(path) = report_json_path.as_ref() {
        read_json(path)?
    } else {
        json!({})
    };
    let cycle_state = if cycle_state_path.exists() {
        read_json(&cycle_state_path)?
    } else {
        json!({})
    };
    let researcher_view = if researcher_view_path.exists() {
        read_json(&researcher_view_path)?
    } else {
        json!({})
    };
    let evidence_ready = researcher_view
        .get("evidence_readiness")
        .and_then(|value| value.get("ready"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let claim_count = report
        .get("claim_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let open_question_count = report
        .get("open_question_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let recommended_action_count = report
        .get("recommended_action_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completed_experiment_lanes = cycle_state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("completed"))
        .count() as u64;
    let approval_readiness_score = researcher_view
        .get("approval_readiness_score")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let approval_rubric = researcher_view
        .get("approval_rubric")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let approval_blockers = researcher_view
        .get("approval_blockers")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0) as u64;
    let rubric_average = if approval_rubric.is_empty() {
        0
    } else {
        approval_rubric
            .iter()
            .filter_map(|item| item.get("score").and_then(Value::as_u64))
            .sum::<u64>()
            / approval_rubric.len() as u64
    };
    let weak_rubric_dimensions = approval_rubric
        .iter()
        .filter_map(|item| item.get("score").and_then(Value::as_u64))
        .filter(|score| *score < 70)
        .count() as u64;

    let mut score = 0u64;
    if report_json_path.is_some() {
        score += 15;
    }
    if paper_path.is_some() {
        score += 15;
    }
    score += (claim_count.min(200) * 20) / 200;
    score += (completed_experiment_lanes.min(12) * 20) / 12;
    if evidence_ready {
        score += (approval_readiness_score.min(100) * 20) / 100;
        score += (rubric_average.min(100) * 10) / 100;
    }
    let quality_band = if open_question_count == 0 && recommended_action_count == 0 {
        20
    } else if open_question_count <= 5 && recommended_action_count <= 10 {
        12
    } else if open_question_count <= 20 && recommended_action_count <= 40 {
        6
    } else {
        0
    };
    score += quality_band;
    if researcher_view_path.exists() && approval_blockers == 0 {
        score += 10;
    } else if researcher_view_path.exists() && approval_blockers <= 3 {
        score += 4;
    }
    if weak_rubric_dimensions == 0 && !approval_rubric.is_empty() {
        score += 10;
    } else if weak_rubric_dimensions <= 2 {
        score += 4;
    }
    let score = score.min(100);

    let mode = if !evidence_ready {
        "wait"
    } else if score >= 95 {
        "hold"
    } else if score >= 80 {
        "nudge"
    } else {
        "refine"
    };
    let review = json!({
        "ts": now_iso(),
        "cycle_id": cycle_id,
        "type": "completion_review",
        "completion_score": score,
        "mode": mode,
        "claim_count": claim_count,
        "open_question_count": open_question_count,
        "recommended_action_count": recommended_action_count,
        "completed_experiment_lanes": completed_experiment_lanes,
        "researcher_view_exists": researcher_view_path.exists(),
        "evidence_ready": evidence_ready,
        "approval_readiness_score": approval_readiness_score,
        "approval_rubric_average": rubric_average,
        "weak_rubric_dimension_count": weak_rubric_dimensions,
        "approval_blocker_count": approval_blockers,
        "report_exists": report_json_path.is_some(),
        "paper_exists": paper_path.is_some(),
        "report_revision": latest_report_rev,
    });

    crate::core::support::append_labdirector_decision(paths, cycle_id, &review)?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_completion_review",
        review.clone(),
    )?;
    Ok(review)
}

pub fn running_lane_count(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        let mut count = 0usize;
        let mut seen_lane_ids = HashSet::new();
        for lane in lane_statuses {
            if lane.get("status").and_then(Value::as_str) != Some("running") {
                continue;
            }
            let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) else {
                continue;
            };
            seen_lane_ids.insert(lane_id.to_string());
            if lane_has_finalized_outputs(paths, cycle_id, lane_id) {
                continue;
            }
            let disk_run_state = lane_root(paths, cycle_id, lane_id).join("run-state.json");
            let recently_updated_on_disk = || -> bool {
                disk_run_state
                    .exists()
                    .then(|| read_json(&disk_run_state).ok())
                    .flatten()
                    .map(|run_state| {
                        run_state.get("status").and_then(Value::as_str) == Some("running")
                            && running_lane_recently_updated(
                                &run_state,
                                RUNNING_LANE_ORPHAN_GRACE_SECONDS,
                            )
                    })
                    .unwrap_or(false)
            };
            let process_path = lane_process_path(paths, cycle_id, lane_id);
            if process_path.exists() {
                let process = read_json(&process_path)?;
                let pid = process.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                if pid > 0 && process_is_alive(pid) {
                    count += 1;
                } else if recently_updated_on_disk() {
                    count += 1;
                } else {
                    finalize_orphaned_running_lane(
                        paths,
                        cycle_id,
                        lane_id,
                        "orphaned running lane detected during status reconciliation",
                    )?;
                }
                continue;
            }
            if running_lane_recently_updated(&lane, RUNNING_LANE_ORPHAN_GRACE_SECONDS)
                || recently_updated_on_disk()
            {
                count += 1;
            } else {
                finalize_orphaned_running_lane(
                    paths,
                    cycle_id,
                    lane_id,
                    "orphaned running lane detected during status reconciliation",
                )?;
            }
        }
        let lanes_dir = cycle_lanes_root(paths, cycle_id);
        if lanes_dir.exists() {
            for entry in read_dir(&lanes_dir)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let lane_id = entry.file_name().to_string_lossy().to_string();
                if seen_lane_ids.contains(&lane_id) {
                    continue;
                }
                let lane_dir = entry.path();
                if lane_dir.join("final-status.json").exists() {
                    continue;
                }
                // A launcher writes process metadata before the child has had
                // time to create run-state.json.  Count that live child as a
                // reserved worker slot so the next drain round cannot launch a
                // second lane past max_concurrency.
                if lane_process_is_alive(paths, cycle_id, &lane_id) {
                    count += 1;
                    continue;
                }
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
                    let process = read_json(&process_path)?;
                    let pid = process.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    if pid > 0 && process_is_alive(pid) {
                        count += 1;
                    } else {
                        finalize_orphaned_running_lane(
                            paths,
                            cycle_id,
                            &lane_id,
                            "orphaned running lane detected during status reconciliation",
                        )?;
                    }
                } else if running_lane_recently_updated(
                    &run_state,
                    RUNNING_LANE_ORPHAN_GRACE_SECONDS,
                ) {
                    count += 1;
                } else {
                    finalize_orphaned_running_lane(
                        paths,
                        cycle_id,
                        &lane_id,
                        "orphaned running lane detected during status reconciliation",
                    )?;
                }
            }
        }
        return Ok(count);
    }

    let mut count = 0usize;
    for (indexed_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if lane_dir.join("final-status.json").exists() {
            continue;
        }
        // `launch_lane_background` records the PID before the new process can
        // write run-state.json.  That interval still occupies a worker slot.
        if lane_process_is_alive(paths, cycle_id, &indexed_lane_id) {
            count += 1;
            continue;
        }
        let run_state_path = lane_dir.join("run-state.json");
        if run_state_path.exists() {
            let run_state = read_json(&run_state_path)?;
            if run_state.get("status").and_then(Value::as_str) == Some("running") {
                let lane_id = run_state
                    .get("lane_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or(indexed_lane_id);
                if lane_has_finalized_outputs(paths, cycle_id, &lane_id) {
                    continue;
                }
                let process_path = lane_process_path(paths, cycle_id, &lane_id);
                if process_path.exists() {
                    let process = read_json(&process_path)?;
                    let pid = process.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    if pid > 0 && process_is_alive(pid) {
                        count += 1;
                    } else {
                        finalize_orphaned_running_lane(
                            paths,
                            cycle_id,
                            &lane_id,
                            "orphaned running lane detected during status reconciliation",
                        )?;
                    }
                } else {
                    if running_lane_recently_updated(&run_state, RUNNING_LANE_ORPHAN_GRACE_SECONDS)
                    {
                        count += 1;
                    } else {
                        // Do not emit an abort here. Process metadata can disappear briefly
                        // before the lane writes its final outputs, which would create a
                        // false lane_aborted event immediately before lane_completed.
                        // Stale-lane recovery remains responsible for aborting true orphans.
                        continue;
                    }
                }
            }
        }
    }
    Ok(count)
}

pub fn collect_new_briefs(paths: &AppPaths, cycle_id: &str) -> Result<Vec<String>> {
    let mut brief_ids = Vec::new();
    let published_report_lanes = published_chronicle_report_lane_ids(
        &crate::core::support::segmented_log::chronicle_report_log(paths, cycle_id),
    );
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            if lane.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) else {
                continue;
            };
            let marker_path = lane_brief_marker_path(paths, cycle_id, lane_id);
            if marker_path.exists() {
                continue;
            }
            if published_report_lanes.contains(lane_id) {
                write_brief_marker_best_effort(&marker_path, "report-already-published");
                continue;
            }
            if !lane_root(paths, cycle_id, lane_id)
                .join("result.json")
                .exists()
            {
                continue;
            }
            let brief = build_brief_for_lane(paths, cycle_id, lane_id)?;
            write_brief_marker_best_effort(&marker_path, &brief.brief_id);
            brief_ids.push(brief.brief_id);
        }
        return Ok(brief_ids);
    }

    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let final_status_path = lane_dir.join("final-status.json");
        let marker_path = lane_brief_marker_path(paths, cycle_id, &lane_id);
        if !final_status_path.exists()
            || marker_path.exists()
            || !lane_dir.join("result.json").exists()
        {
            continue;
        }
        if published_report_lanes.contains(lane_id.as_str()) {
            write_brief_marker_best_effort(&marker_path, "report-already-published");
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let brief = build_brief_for_lane(paths, cycle_id, &lane_id)?;
        write_brief_marker_best_effort(&marker_path, &brief.brief_id);
        brief_ids.push(brief.brief_id);
    }
    Ok(brief_ids)
}

pub(crate) fn published_chronicle_report_lane_ids(
    reports: &crate::core::support::segmented_log::SegmentedLog,
) -> HashSet<String> {
    let mut lane_ids = HashSet::new();
    let _ = reports.for_each_line(|line| {
        if let Some(lane_id) = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|item| item.get("lane_id").and_then(Value::as_str).map(ToString::to_string))
        {
            lane_ids.insert(lane_id);
        }
    });
    lane_ids
}

pub(crate) fn write_brief_marker_best_effort(marker_path: &Path, brief_id: &str) {
    let _ = write_json(
        marker_path,
        &json!({
            "brief_id": brief_id,
            "built_at": now_iso(),
        }),
    );
}

pub(crate) fn cycle_objective(paths: &AppPaths, cycle_id: &str) -> String {
    let cycle_plan_path = plans_root(paths).join(format!("{cycle_id}-cycle-plan.json"));
    if cycle_plan_path.exists() {
        return read_json(&cycle_plan_path)
            .ok()
            .and_then(|value| {
                value
                    .get("objective")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "Continue the active research cycle.".to_string());
    }
    "Continue the active research cycle.".to_string()
}

pub(crate) fn failure_notice_actions(payload: &Value) -> Vec<Value> {
    let lane_id = payload
        .get("lane_id")
        .and_then(Value::as_str)
        .unwrap_or("lane");
    let role = payload
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("lane");
    let failure_category = payload
        .get("failure_category")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let token_pressure = payload
        .get("token_pressure")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if token_pressure {
        return vec![json!({
            "type": "wait_for_tokens",
            "preferred_role": "lab-director",
            "source_lane_id": lane_id,
            "description": format!(
                "pause new Codex retries for `{lane_id}` until token or quota pressure clears; preserve current artifacts and resume once pacing exits backoff"
            ),
        })];
    }

    match failure_category {
        "timeout" => vec![
            json!({
                "type": "lane_retry_followup",
                "preferred_role": role,
                "source_lane_id": lane_id,
                "description": format!(
                    "retry `{lane_id}` from the saved artifacts, keep scope to one decisive deliverable, and emit structured output before optional prose"
                ),
            }),
            json!({
                "type": "timeout_root_cause_review",
                "preferred_role": "lab-director",
                "source_lane_id": lane_id,
                "description": format!(
                    "inspect the timeout cause and trim unnecessary workspace scans or prompt breadth before relaunching `{lane_id}`"
                ),
            }),
        ],
        // Both the assigned model and its fallback were busy. Nothing is wrong
        // with the lane, so ask for it again rather than repairing it.
        "model_at_capacity" => vec![json!({
            "type": "failure_repair_followup",
            "preferred_role": role,
            "source_lane_id": lane_id,
            "description": format!(
                "every model offered for `{lane_id}` reported it was at capacity; redispatch the lane unchanged"
            ),
        })],
        "context_window_exceeded" => vec![json!({
            "type": "context_compaction_followup",
            "preferred_role": role,
            "source_lane_id": lane_id,
            "description": format!(
                "rerun `{lane_id}` with tighter context, fewer artifact refs, and one bounded output target"
            ),
        })],
        _ => vec![json!({
            "type": "failure_repair_followup",
            "preferred_role": role,
            "source_lane_id": lane_id,
            "description": format!(
                "repair the failure mode for `{lane_id}` using the saved logs and continue from available artifacts"
            ),
        })],
    }
}

pub(crate) fn spawn_failure_recovery_followups(
    paths: &AppPaths,
    cycle_id: &str,
    failure_items: &[Value],
) -> Result<Vec<Value>> {
    let mut created = Vec::new();
    let objective = cycle_objective(paths, cycle_id);

    for item in failure_items {
        if created.len() >= 2 {
            break;
        }
        let payload = item.get("payload").unwrap_or(item);
        if payload
            .get("token_pressure")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let failure_category = payload
            .get("failure_category")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !matches!(
            failure_category,
            "timeout" | "context_window_exceeded" | "model_at_capacity"
        ) {
            continue;
        }
        let lane_id = match payload.get("lane_id").and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() => value,
            _ => continue,
        };
        let contract_path = lane_root(paths, cycle_id, lane_id).join("lane-contract.json");
        if !contract_path.exists() {
            continue;
        }
        let contract: LaneContract = serde_json::from_value(read_json(&contract_path)?)?;
        if contract.role == "lab-director" {
            continue;
        }
        if matches!(contract.role.as_str(), "author" | "illustrator")
            && conclusion_needs_hypothesis_strategy(paths, cycle_id)?
        {
            continue;
        }
        let role_name = contract.role.clone();
        let runtime_class = contract.runtime_class.clone();
        let mode = contract.mode.clone();
        let recovery_reason = format!("labdirector-{failure_category}-recovery");
        let root_lane_id = dependency_base_lane_id(lane_id);
        if recovery_lane_count_for_origin(paths, cycle_id, &role_name, &root_lane_id)? >= 2 {
            continue;
        }
        if existing_recovery_lane_for_origin(
            paths,
            cycle_id,
            &role_name,
            &root_lane_id,
            &recovery_reason,
        )?
        .is_some()
        {
            continue;
        }

        let new_lane_id = next_recovery_lane_id(paths, cycle_id, lane_id)?;
        let original_task = fs::read_to_string(&contract.task_file).unwrap_or_default();
        let failure_reason = payload
            .get("reason")
            .and_then(Value::as_str)
            .or_else(|| payload.get("warning").and_then(Value::as_str))
            .unwrap_or("lane execution failed before producing a stable structured output");
        let recovery_task = format!(
            "{original_task}\n\n## Lab Director Recovery Instruction\n- original_lane_id: {lane_id}\n- failure_category: {failure_category}\n- failure_reason: {failure_reason}\n- action: restart from the saved artifacts, narrow scope to one decisive deliverable, avoid exhaustive workspace scans, and emit the required structured output before optional explanation.\n"
        );
        let contract_path = create_lane_contract(
            paths,
            cycle_id,
            &new_lane_id,
            &role_name,
            &runtime_class,
            &mode,
            &recovery_task,
        )?;
        let role_plan_path = write_followup_role_plan(
            paths,
            cycle_id,
            &new_lane_id,
            &role_name,
            assigned_model_for_role(&role_name, &runtime_class),
            &objective,
            lane_id,
            &format!(
                "recover `{lane_id}` after {failure_category}; use the saved logs to avoid the previous failure and continue from available artifacts"
            ),
            "recovery_followup",
            &[],
            &[],
            None,
            None,
            None,
            &[],
            json!({
                "priority_source": "labdirector_failure_notice",
                "preferred_role": role_name.clone(),
                "effective_role": role_name.clone(),
                "root_lane_id": root_lane_id,
                "original_lane_id": lane_id,
                "recovery_reason": recovery_reason,
                "failure_notice": payload,
            }),
        )?;
        created.push(json!({
            "lane_id": new_lane_id,
            "role": role_name,
            "contract_path": contract_path,
            "role_plan_path": role_plan_path,
            "source_lane_id": lane_id,
            "failure_category": failure_category,
        }));
    }

    Ok(created)
}
