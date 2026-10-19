#![allow(unused_imports)]
use super::*;

pub(crate) const AGGREGATE_CYCLE_EVENTS_WRITE_LIMIT: usize = 5000;

pub fn aggregate_cycle(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let mut lane_statuses_by_base: HashMap<String, Value> = HashMap::new();
    let cached_cycle_state_path =
        state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    let cached_cycle_state = if cached_cycle_state_path.exists() {
        Some(read_json(&cached_cycle_state_path)?)
    } else {
        None
    };
    let mut all_events = cached_cycle_state
        .as_ref()
        .and_then(|value| value.get("recent_events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cached_terminal = cached_terminal_lane_statuses(paths, cycle_id)?;
    let mut cached_bases_used: HashSet<String> = HashSet::new();

    for (indexed_lane_id, lane_dir) in lane_dirs_for_cycle(paths, cycle_id)? {
        let base_id = base_lane_id(&indexed_lane_id);
        if let Some(cached) = cached_terminal.get(&base_id) {
            // Seed what the cache remembers, so the priority comparison below
            // is made against it rather than replacing it blind.
            if !cached_bases_used.contains(&base_id) {
                lane_statuses_by_base.insert(base_id.clone(), cached.clone());
                cached_bases_used.insert(base_id.clone());
            }
            // A recovery lane could never succeed, and this is why.
            //
            // The cache is keyed by BASE lane id, and `base_lane_id` strips
            // `-recovery-N`. So once `scout-02` reached a terminal state the
            // entry under `scout-02` was remembered -- and `scout-02-recovery-01`,
            // whose base id is also `scout-02`, hit that entry and was skipped
            // by `continue` before its run-state was ever read. The lane the
            // cycle created to repair the failure was invisible to the record
            // of the failure.
            //
            // `lane_status_priority` ranks a recovery lane above the lane it
            // replaces when it did at least as well. That rule was correct and
            // never ran, because the short circuit above happened first.
            //
            // MEASURED ON cycle-g-v91, 2026-09-12. scout-02 failed with
            // `adaptive_literature_search_incomplete`. scout-02-recovery-01 then
            // COMPLETED: 232 candidates retrieved, 70 papers admitted through
            // the screening gate, `decision_ready: true`, `valid: true`. None of
            // it counted. `completed_literature_scout_count` stayed at 0, so
            // chronicle sat on `waiting-for-literature-scout-before-kg`, so no
            // decision digest was ever written, so the LabDirector -- correctly
            // refusing to cite what it had not been given -- reported zero open
            // problems and zero proposed methods and said so in
            // `survey_coverage_gaps`. Thirteen lanes waited on a count that a
            // succeeding lane could not raise.
            //
            // So: reuse the cached record only for the lane it actually
            // describes. A different lane sharing the base is read, and the
            // priority rule decides between them as it was written to.
            if cached.get("lane_id").and_then(Value::as_str) == Some(indexed_lane_id.as_str()) {
                continue;
            }
        }
        let run_state_path = lane_dir.join("run-state.json");
        let contract_path = lane_dir.join("lane-contract.json");
        let final_status_path = lane_dir.join("final-status.json");
        let run_state = if final_status_path.exists() {
            let final_status = read_json(&final_status_path).unwrap_or_else(|_| json!({}));
            let contract = read_json(&contract_path).unwrap_or_else(|_| json!({}));
            json!({
                "lane_id": final_status
                    .get("lane_id")
                    .cloned()
                    .unwrap_or_else(|| json!(indexed_lane_id)),
                "role": final_status
                    .get("role")
                    .cloned()
                    .or_else(|| contract.get("role").cloned())
                    .unwrap_or_else(|| json!("unknown")),
                "status": final_status
                    .get("status")
                    .cloned()
                    .unwrap_or_else(|| json!("completed")),
                "runtime_class": contract
                    .get("runtime_class")
                    .cloned()
                    .unwrap_or_else(|| json!("unknown")),
                "result_path": final_status.get("result_path").cloned().unwrap_or(Value::Null),
                "error": final_status.get("error").cloned().unwrap_or(Value::Null),
                "superseded_by_runtime_reconciliation": final_status
                    .get("superseded_by_runtime_reconciliation")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        } else if run_state_path.exists() {
            read_json(&run_state_path)?
        } else if contract_path.exists() {
            let contract = read_json(&contract_path).unwrap_or_else(|_| json!({}));
            json!({
                "lane_id": contract
                    .get("lane_id")
                    .cloned()
                    .unwrap_or_else(|| json!(indexed_lane_id)),
                "role": contract
                    .get("role")
                    .cloned()
                    .unwrap_or_else(|| json!("unknown")),
                "status": "pending",
                "runtime_class": contract
                    .get("runtime_class")
                    .cloned()
                    .unwrap_or_else(|| json!("unknown")),
                "result_path": Value::Null,
            })
        } else {
            json!({
                "lane_id": indexed_lane_id,
                "role": "unknown",
                "status": "pending",
                "runtime_class": "unknown",
                "result_path": Value::Null,
            })
        };
        let raw_status = run_state
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let status = terminal_status_after_runtime_reconciliation(raw_status, &run_state);
        let lane_id = run_state
            .get("lane_id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| indexed_lane_id.clone());
        let lane_status = json!({
            "lane_id": run_state.get("lane_id").cloned().unwrap_or_else(|| json!(indexed_lane_id)),
            "role": run_state.get("role").cloned().unwrap_or_else(|| json!("unknown")),
            "status": status.clone(),
            "runtime_class": run_state.get("runtime_class").cloned().unwrap_or_else(|| json!("unknown")),
            "result_path": run_state.get("result_path").cloned().unwrap_or(Value::Null),
        });
        let base_id = base_lane_id(&lane_id);
        let should_replace = lane_statuses_by_base
            .get(&base_id)
            .map(|existing| {
                let existing_lane_id = existing
                    .get("lane_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let existing_status = existing
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                lane_status_priority(&lane_id, status.as_str())
                    >= lane_status_priority(existing_lane_id, existing_status)
            })
            .unwrap_or(true);
        if should_replace {
            lane_statuses_by_base.insert(base_id, lane_status);
        }
        for event in read_jsonl(&lane_dir.join("events.jsonl"))? {
            all_events.push(event);
        }
    }

    for (base_id, lane_status) in cached_terminal {
        if !cached_bases_used.contains(&base_id) {
            lane_statuses_by_base.insert(base_id, lane_status);
        }
    }

    let lane_manifest_path = plans_root(paths).join(format!("{cycle_id}-lane-manifest.json"));
    if lane_manifest_path.exists() {
        let lane_manifest = read_json(&lane_manifest_path)?
            .as_array()
            .cloned()
            .unwrap_or_default();
        for lane in lane_manifest {
            let lane_id = lane
                .get("lane_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let base_id = base_lane_id(lane_id);
            lane_statuses_by_base.entry(base_id).or_insert_with(|| {
                json!({
                    "lane_id": lane_id,
                    "role": lane.get("role").cloned().unwrap_or_else(|| json!("unknown")),
                    "status": "pending",
                    "runtime_class": lane.get("runtime_class").cloned().unwrap_or_else(|| json!("unknown")),
                    "result_path": Value::Null,
                })
            });
        }
    }

    let mut lane_statuses = lane_statuses_by_base.into_values().collect::<Vec<_>>();
    lane_statuses.sort_by(|a, b| {
        a.get("lane_id")
            .and_then(Value::as_str)
            .cmp(&b.get("lane_id").and_then(Value::as_str))
    });

    let mut completed = 0;
    let mut running = 0;
    let mut pending = 0;
    let mut failed = 0;
    let mut aborted = 0;
    let mut unknown = 0;
    let mut failed_blocking = 0;
    let mut failed_non_blocking = 0;
    for item in &lane_statuses {
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        match status {
            "completed" => completed += 1,
            "running" => running += 1,
            "pending" | "prepared" => pending += 1,
            "failed" => {
                failed += 1;
                if non_blocking_cycle_role(role) {
                    failed_non_blocking += 1;
                } else {
                    failed_blocking += 1;
                }
            }
            "aborted" => aborted += 1,
            _ => unknown += 1,
        }
    }

    all_events.sort_by(|a, b| {
        a.get("ts")
            .and_then(Value::as_str)
            .cmp(&b.get("ts").and_then(Value::as_str))
    });
    let recent_events: Vec<Value> = all_events
        .iter()
        .rev()
        .take(20)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let blocking_errors = lane_statuses
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("failed"))
        .filter(|item| {
            !non_blocking_cycle_role(
                item.get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let non_blocking_warnings = lane_statuses
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("failed"))
        .filter(|item| {
            non_blocking_cycle_role(
                item.get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            )
        })
        .map(|item| {
            json!({
                "severity": "warning",
                "reason": "non-blocking lane failed",
                "lane": item,
            })
        })
        .collect::<Vec<_>>();

    let gate_review =
        read_json(&state_root(paths).join(format!("{cycle_id}-gate-review.json"))).ok();
    let conclusion_review =
        read_json(&state_root(paths).join(format!("{cycle_id}-conclusion-review.json"))).ok();
    let strategy_decision =
        read_json(&state_root(paths).join(format!("{cycle_id}-strategy-decision.json"))).ok();
    let gate_deferred = gate_review.as_ref().is_some_and(|review| {
        review.get("gate_passed").and_then(Value::as_bool) != Some(true)
            || review
                .get("conclusion_gate_eligible")
                .and_then(Value::as_bool)
                == Some(false)
            || matches!(
                review.get("mode").and_then(Value::as_str),
                Some("defer" | "refine" | "challenge" | "reject")
            )
    });
    let conclusion_incomplete = conclusion_review.as_ref().is_some_and(|review| {
        review
            .get("conclusion_gate_passed")
            .and_then(Value::as_bool)
            == Some(false)
            || matches!(
                review.get("mode").and_then(Value::as_str),
                Some("defer" | "refine" | "challenge" | "reject")
            )
    });
    let strategy_requests_more_work = strategy_decision.as_ref().is_some_and(|decision| {
        matches!(
            decision.get("mode").and_then(Value::as_str),
            Some("pivot" | "refine" | "challenge")
        )
    });
    let inactive_but_scientifically_open = running == 0
        && pending == 0
        && failed == 0
        && (gate_deferred || conclusion_incomplete || strategy_requests_more_work);

    let recovery_needed =
        failed_blocking > 0 || failed_non_blocking > 0 || inactive_but_scientifically_open;
    let cycle_status = if running > 0 || pending > 0 || recovery_needed {
        if inactive_but_scientifically_open {
            "blocked_no_active_lanes"
        } else {
            "running"
        }
    } else if failed_non_blocking > 0 {
        "completed_with_warnings"
    } else if aborted > 0 || unknown > 0 {
        "completed_with_aborts"
    } else {
        "completed"
    };

    let lab_director_alerts = blocking_errors
        .iter()
        .map(|item| {
            json!({
                "severity": "error",
                "reason": "blocking lane failed; keep cycle alive and request recovery planning",
                "lane": item,
                "requires_recovery": true,
                "owner": "lab-director"
            })
        })
        .collect::<Vec<_>>();
    let mut lab_director_alerts = lab_director_alerts;
    if inactive_but_scientifically_open {
        lab_director_alerts.push(json!({
            "severity": "warning",
            "reason": "no active lanes remain, but gate/conclusion/strategy state still requires scientific follow-up",
            "requires_recovery": true,
            "owner": "lab-director",
            "gate_deferred": gate_deferred,
            "conclusion_incomplete": conclusion_incomplete,
            "strategy_requests_more_work": strategy_requests_more_work,
        }));
    }

    let cycle_state = json!({
        "cycle_id": cycle_id,
        "status": cycle_status,
        "started_at": all_events.first().and_then(|item| item.get("ts")).cloned().unwrap_or(Value::Null),
        "updated_at": now_iso(),
        "completed_at": if cycle_status == "completed" { Value::String(now_iso()) } else { Value::Null },
        "lane_counts": {
            "total": lane_statuses.len(),
            "running": running,
            "pending": pending,
            "completed": completed,
            "aborted": aborted,
            "unknown": unknown,
            "failed": failed,
            "failed_blocking": failed_blocking,
            "failed_non_blocking": failed_non_blocking,
        },
        "lane_statuses": lane_statuses,
        "recent_events": recent_events,
        "aggregate_metrics": {
            "lanes_seen": lane_statuses.len(),
            "events_seen": all_events.len(),
        },
        "errors": blocking_errors,
        "warnings": non_blocking_warnings,
        "recovery_needed": recovery_needed,
        "lab_director_attention_required": recovery_needed,
        "lab_director_alerts": lab_director_alerts,
        "open_scientific_state": {
            "gate_deferred": gate_deferred,
            "conclusion_incomplete": conclusion_incomplete,
            "strategy_requests_more_work": strategy_requests_more_work,
            "inactive_but_scientifically_open": inactive_but_scientifically_open,
        },
    });

    let cycle_state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    write_json(&cycle_state_path, &cycle_state)?;
    let cycle_events_path = events_root(paths).join(format!("{cycle_id}-cycle-events.jsonl"));
    match File::create(&cycle_events_path) {
        Ok(mut file) => {
            let events_to_write = all_events
                .iter()
                .rev()
                .take(AGGREGATE_CYCLE_EVENTS_WRITE_LIMIT)
                .collect::<Vec<_>>();
            for event in events_to_write.into_iter().rev() {
                writeln!(file, "{}", serde_json::to_string(event)?)?;
            }
            make_runtime_path_collaborative(&cycle_events_path);
        }
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {}
        Err(err) => return Err(err.into()),
    }
    Ok(cycle_state_path)
}

pub fn decide_from_brief(paths: &AppPaths, brief_id: &str) -> Result<StrategyDecision> {
    let chronicle_root = paths.runtime_root.join("chronicle").join("briefs");
    let mut brief_path = None;
    if chronicle_root.exists() {
        for entry in read_dir(&chronicle_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let candidate = entry.path().join(format!("{brief_id}.json"));
            if candidate.exists() {
                brief_path = Some(candidate);
                break;
            }
        }
    }
    let brief_path = brief_path.ok_or_else(|| anyhow!("missing brief: {brief_id}"))?;
    let brief = read_json(&brief_path)?;
    let cycle_id = brief
        .get("cycle_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let output = state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
    if output.exists() {
        let existing = read_json(&output).unwrap_or(Value::Null);
        let existing_mode = existing.get("mode").and_then(Value::as_str);
        let existing_source = existing.get("source").and_then(Value::as_str).unwrap_or("");
        let existing_forced_pivot = existing_mode == Some("pivot")
            && (existing
                .get("blocked_terminal_stop")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || existing_source.contains("forced_pivot")
                || existing_source == "supervisor_stagnation_recovery");
        if existing_forced_pivot {
            return Ok(StrategyDecision {
                decision_id: existing
                    .get("decision_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("decision-{}", Uuid::new_v4().simple())),
                cycle_id,
                mode: "pivot".to_string(),
                reason: existing
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("forced pivot is still pending")
                    .to_string(),
                trigger_signals: existing
                    .get("trigger_signals")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["existing_forced_pivot=true".to_string()]),
                approved_actions: Vec::new(),
                deferred_actions: Vec::new(),
            });
        }
    }
    let open_questions = brief
        .get("open_questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let claim_deltas = brief
        .get("claim_deltas")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let recommended_actions = brief
        .get("recommended_actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let (mode, reason) = if claim_deltas.is_empty() {
        ("pivot", "no supported claim delta was produced")
    } else if !open_questions.is_empty() {
        (
            "refine",
            "supported signals exist but open questions remain",
        )
    } else {
        ("hold", "initial signal is stable enough for reporting")
    };

    let decision = StrategyDecision {
        decision_id: format!("decision-{}", Uuid::new_v4().simple()),
        cycle_id,
        mode: mode.to_string(),
        reason: reason.to_string(),
        trigger_signals: vec![
            format!("claim_delta_count={}", claim_deltas.len()),
            format!("open_question_count={}", open_questions.len()),
            format!("recommended_action_count={}", recommended_actions.len()),
        ],
        approved_actions: recommended_actions
            .iter()
            .filter_map(|item| {
                item.get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect(),
        deferred_actions: vec![],
    };

    write_json(&output, &serde_json::to_value(&decision)?)?;
    let dialogue_log =
        events_root(paths).join(format!("{}-chronicle-dialogue.jsonl", decision.cycle_id));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dialogue_log)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&json!({
            "brief_id": brief.get("brief_id").cloned().unwrap_or(Value::Null),
            "cycle_id": brief.get("cycle_id").cloned().unwrap_or(Value::Null),
            "decision": decision,
        }))?
    )?;

    Ok(decision)
}
