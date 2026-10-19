#[test]
fn adaptive_pacing_ignores_finalized_auth_refresh_retry_lanes() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-pacing-finalized-auth";
    write_codex_contract(tmp.path(), cycle, "followup-chronicle-01-recovery-01");
    write_lane(
        tmp.path(),
        cycle,
        "followup-chronicle-01-recovery-01",
        json!({ "lane_id": "followup-chronicle-01-recovery-01", "status": "aborted" }),
        json!({ "retry_reason": "codex_auth_expired" }),
    );

    let pacing = adaptive_codex_pacing_snapshot(&paths, cycle, 2, 0, 0).unwrap();

    assert_eq!(pacing["auth_refresh_wait_count"].as_u64(), Some(0));
    assert_eq!(pacing["pause_reason"].as_str(), Some("idle-backoff"));
    assert_eq!(pacing["pause_seconds"].as_u64(), Some(30));
}

#[test]
fn supervisor_keeps_only_one_unopened_gate_review_per_rubric() {
    // MEASURED ON cycle-a-20260919, 2026-10-01: pipeline health read
    // 59 pending independent gate reviews from cycle state while later reviews
    // had completed. Role-plan refresh had assigned 58 open records to
    // technical_quality, so releasing their dependency would run the same
    // current-rubric review dozens of times.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-a-20260919";
    let mut contracts = Vec::new();
    for (index, (lane_id, rubric)) in [
        ("followup-gatekeeper-100", "technical_quality"),
        ("followup-gatekeeper-118", "technical_quality"),
        ("followup-gatekeeper-135", "technical_quality"),
        ("followup-gatekeeper-136", "novelty"),
    ]
    .into_iter()
    .enumerate()
    {
        let root = lane_root(&paths, cycle, lane_id);
        fs::create_dir_all(&root).unwrap();
        let contract_path = root.join("lane-contract.json");
        write_json(
            &contract_path,
            &json!({
                "cycle_id": cycle,
                "lane_id": lane_id,
                "role": "gatekeeper",
                "runtime_class": "codex-agent",
                "mode": "read-write-scoped",
                "cwd": tmp.path(),
                "task_file": root.join("task.md"),
                "allowed_inputs": [],
                "allowed_outputs": [],
                "output_artifact": null,
                "fallback_strategy": null,
            }),
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&contract_path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(60 - index as u64))
            .unwrap();
        write_json(
            &root.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "gatekeeper",
                "action_type": "independent_gate_review_followup",
                "target_rubric": rubric,
                "planner_metadata": {"target_rubric": rubric},
            }),
        )
        .unwrap();
        contracts.push(contract_path);
    }

    let actions =
        supervisor_supersede_redundant_pending_gate_reviews(&paths, cycle, &contracts).unwrap();

    assert_eq!(actions.len(), 2);
    assert_eq!(
        actions
            .iter()
            .map(|action| action["lane_id"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["followup-gatekeeper-100", "followup-gatekeeper-118"]),
    );
    for lane_id in ["followup-gatekeeper-100", "followup-gatekeeper-118"] {
        let status = read_json(&lane_root(&paths, cycle, lane_id).join("final-status.json"))
            .unwrap();
        assert_eq!(status["status"], json!("aborted"));
        assert_eq!(
            status["failure_category"],
            json!("supervisor_superseded_redundant_pending_gate_review")
        );
    }
    assert!(!lane_root(&paths, cycle, "followup-gatekeeper-135")
        .join("final-status.json")
        .exists());
    assert!(!lane_root(&paths, cycle, "followup-gatekeeper-136")
        .join("final-status.json")
        .exists());
}

#[test]
fn failure_diagnostics_skips_healthy_lanes() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-diag-healthy";

    write_lane(
        tmp.path(),
        cycle,
        "analyst-01",
        json!({ "lane_id": "analyst-01", "status": "completed", "degraded": false }),
        json!({ "status": "completed", "driver": "codex-agent-executor" }),
    );

    let records = collect_lane_failure_diagnostics(&paths, cycle);
    assert!(
        records.is_empty(),
        "healthy completed lane must not produce a diagnostic record"
    );
}

#[test]
fn native_reapers_keep_a_running_simulation_inside_its_runtime_budget() {
    // MEASURED ON cycle-a-20260919, 2026-09-22. followup-engineer-46
    // was still checkpointing the ordered sweep when native shutdown killed
    // it at 2,265 seconds, despite its recorded timeout_seconds being 7,200.
    let contract = LaneContract {
        cycle_id: "cycle-simulation-supervision".to_string(),
        lane_id: "followup-engineer-46".to_string(),
        role: "engineer".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "async".to_string(),
        cwd: PathBuf::from("/tmp"),
        task_file: PathBuf::from("/tmp/task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    let role_plan = json!({
        "action_type": SIMULATION_DATA_GENERATION_ACTION,
    });

    let threshold = stale_threshold_for_lane(&contract, Some(&role_plan), 1_800);

    assert!(
        threshold > 2_265,
        "active measured lane must remain below stale threshold"
    );
    assert_eq!(threshold, 7_800);
    assert_eq!(
        lane_quiescence_wait_seconds(&contract, Some(&role_plan), 2_265, 1_800),
        5_535,
        "shutdown must wait for the measured lane's remaining runtime budget"
    );
}

#[test]
fn failure_diagnostics_captures_degraded_lanes() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-diag-degraded";

    // Healthy analyst lane (should be skipped)
    write_lane(
        tmp.path(),
        cycle,
        "analyst-01",
        json!({ "lane_id": "analyst-01", "status": "completed", "degraded": false }),
        json!({ "status": "completed", "driver": "codex-agent-executor" }),
    );

    // Degraded gatekeeper lane with failure_excerpt (codex-agent-fallback
    // path) — this is the common shape of a Codex timeout.
    write_lane(
        tmp.path(),
        cycle,
        "gatekeeper-01",
        json!({
            "lane_id": "gatekeeper-01",
            "status": "completed",
            "degraded": true,
            "failure_category": "timeout",
            "completed_at": "2026-04-23T10:30:00Z",
        }),
        json!({
            "status": "completed",
            "driver": "codex-agent-fallback",
            "role": "gatekeeper",
            "reason": "codex execution timed out; emitted degraded fallback payload from role plan",
            "failure_excerpt": {
                "last_message": "Reviewing the novelty rubric for rival DAG families...",
                "stderr": "",
                "stdout": "{\"type\":\"thread.started\"}\n{\"type\":\"item.started\"}",
            },
        }),
    );

    // Truly failed lane with top-level stderr (live codex-agent path)
    write_lane(
        tmp.path(),
        cycle,
        "lab-runner-01",
        json!({
            "lane_id": "lab-runner-01",
            "status": "failed",
            "degraded": false,
            "completed_at": "2026-04-23T10:45:00Z",
        }),
        json!({
            "status": "failed",
            "driver": "python-stats-driver",
            "error": "blueprint returned non-zero exit",
            "stderr": "Traceback (most recent call last):\n  File \"script.py\"...",
            "stdout": "",
            "output_last_message": "",
            "role_plan": { "role": "lab-runner" },
            "timed_out": false,
            "returncode": 1,
        }),
    );

    let records = collect_lane_failure_diagnostics(&paths, cycle);
    assert_eq!(records.len(), 2, "both problematic lanes must be captured");

    // Newest first (lab-runner-01 at 10:45 > gatekeeper-01 at 10:30)
    let first = &records[0];
    assert_eq!(first["lane_id"], json!("lab-runner-01"));
    assert_eq!(first["status"], json!("failed"));
    assert!(first["stderr_preview"]
        .as_str()
        .unwrap_or("")
        .contains("Traceback"));
    assert_eq!(first["role"], json!("lab-runner"));

    let second = &records[1];
    assert_eq!(second["lane_id"], json!("gatekeeper-01"));
    assert_eq!(second["degraded"], json!(true));
    assert_eq!(second["failure_category"], json!("timeout"));
    assert_eq!(second["role"], json!("gatekeeper"));
    // The failure_excerpt path must have been followed — reason and
    // last_message flow through even though top-level fields are absent.
    assert!(second["reason"]
        .as_str()
        .unwrap_or("")
        .contains("timed out"));
    assert!(second["output_last_message_preview"]
        .as_str()
        .unwrap_or("")
        .contains("Reviewing the novelty rubric"));
    assert!(second["stdout_preview"]
        .as_str()
        .unwrap_or("")
        .contains("thread.started"));
}

#[test]
fn failure_diagnostics_truncates_long_blobs() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-diag-truncate";

    let huge = "x".repeat(5000);
    write_lane(
        tmp.path(),
        cycle,
        "analyst-01",
        json!({ "lane_id": "analyst-01", "status": "completed", "degraded": true }),
        json!({
            "status": "completed",
            "driver": "codex-agent-executor",
            "stderr": huge.clone(),
            "stdout": huge.clone(),
            "output_last_message": huge,
            "role_plan": { "role": "analyst" },
        }),
    );

    let records = collect_lane_failure_diagnostics(&paths, cycle);
    assert_eq!(records.len(), 1);
    let stderr_p = records[0]["stderr_preview"].as_str().unwrap_or("");
    let stdout_p = records[0]["stdout_preview"].as_str().unwrap_or("");
    let last_p = records[0]["output_last_message_preview"]
        .as_str()
        .unwrap_or("");
    // Expect truncation markers + length bounded
    assert!(stderr_p.contains("[truncated]"));
    assert!(stderr_p.len() <= 1520);
    assert!(stdout_p.contains("[truncated]"));
    assert!(last_p.contains("[truncated]"));
    assert!(last_p.len() <= 820);
}

#[test]
fn failure_diagnostics_returns_empty_when_no_cycle() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let records = collect_lane_failure_diagnostics(&paths, "cycle-that-does-not-exist");
    assert!(records.is_empty());
}

#[test]
fn labdirector_label_does_not_hide_runner_handoff_binding() {
    // MEASURED ON cycle-a-20260919, 2026-10-17: followup-runner-390
    // carried these dispatch labels plus analyst-909's superseded handoff, so
    // the stale-runner guards missed the code that the stats driver executed.
    let tmp = TempDir::new().unwrap();
    let cycle = "cycle-labdirector-labelled-stale-runner";
    let (paths, runner_dir, runner) = stale_handoff_runner_fixture(&tmp, cycle);
    let old_plan = read_json(&runner_dir.join("role-plan.json")).unwrap();
    let old_handoff = old_plan
        .pointer("/planner_metadata/analysis_request/handoff_path")
        .unwrap();
    write_json(
        &runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": runner,
            "role": "lab-runner",
            "action_type": "hypothesis_followup",
            "source_brief_id": "followup-lab-director-935",
            "planner_metadata": {
                "analyst_handoff_path": old_handoff
            }
        }),
    )
    .unwrap();

    let actions = supervise_cycle(&paths, cycle, 2, 1800).unwrap();
    assert!(runner_was_superseded(&actions, &runner));
    assert_eq!(
        read_json(&runner_dir.join("final-status.json")).unwrap()["status"],
        json!("aborted")
    );
}

#[test]
fn supervisor_supersedes_stale_direct_handoff_runner_before_dispatch() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-stale-direct-handoff-runner";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Keep lab-runner bound to the newest Analyst handoff."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A schema-backed immune program predicts treatment resistance.",
            "identification_strategy": {"design": "latest handoff only"}
        }),
    )
    .unwrap();

    let old_analyst = "followup-analyst-01";
    create_lane_contract(
        &paths,
        cycle,
        old_analyst,
        "analyst",
        "external-driver",
        "driver-exec",
        "old analyst handoff",
    )
    .unwrap();
    let old_dir = lane_root(&paths, cycle, old_analyst);
    let old_handoff = old_dir.join("handoff-validation-plan.json");
    write_json(
        &old_dir.join("run-state.json"),
        &json!({"lane_id": old_analyst, "role": "analyst", "status": "done"}),
    )
    .unwrap();
    write_json(
        &old_dir.join("final-status.json"),
        &json!({"lane_id": old_analyst, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_handoff,
        &json!({
            "status": "ready",
            "summary": "Old executable handoff.",
            "handoff_checks": [{"check_id": "old_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "old", "code": "print('old')"}]
        }),
    )
    .unwrap();

    let new_analyst = "followup-analyst-02";
    create_lane_contract(
        &paths,
        cycle,
        new_analyst,
        "analyst",
        "external-driver",
        "driver-exec",
        "new analyst handoff",
    )
    .unwrap();
    let new_dir = lane_root(&paths, cycle, new_analyst);
    let new_handoff = new_dir.join("handoff-validation-plan.json");
    write_json(
        &new_dir.join("run-state.json"),
        &json!({"lane_id": new_analyst, "role": "analyst", "status": "done"}),
    )
    .unwrap();
    write_json(
        &new_dir.join("final-status.json"),
        &json!({"lane_id": new_analyst, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &new_handoff,
        &json!({
            "status": "ready",
            "summary": "New executable handoff.",
            "handoff_checks": [{"check_id": "new_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "new", "code": "print('new')"}]
        }),
    )
    .unwrap();

    let stale_runner = "followup-runner-01";
    create_lane_contract(
        &paths,
        cycle,
        stale_runner,
        "lab-runner",
        "external-driver",
        "driver-exec",
        &format!(
            "execute the latest executable analyst handoff from {}",
            old_handoff.display()
        ),
    )
    .unwrap();
    let stale_runner_dir = lane_root(&paths, cycle, stale_runner);
    write_json(
        &stale_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": stale_runner,
            "role": "lab-runner",
            "action_type": "methods_followup",
            "source_brief_id": "analyst-handoff",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": old_handoff
                }
            }
        }),
    )
    .unwrap();

    let actions = supervise_cycle(&paths, cycle, 2, 1800).unwrap();
    assert!(
        actions.iter().any(|item| {
            item.get("action").and_then(Value::as_str)
                == Some("supersede_stale_direct_handoff_runner")
                && item.get("lane_id").and_then(Value::as_str) == Some(stale_runner)
        }),
        "supervisor must supersede direct handoff runners that no longer match the latest Analyst handoff"
    );
    let final_status = read_json(&stale_runner_dir.join("final-status.json")).unwrap();
    assert_eq!(final_status["status"], json!("aborted"));
    assert_eq!(
        final_status["failure_category"],
        json!("supervisor_superseded_stale_direct_handoff_runner")
    );
    assert_eq!(
        final_status["latest_executable_handoff_path"],
        json!(new_handoff.display().to_string())
    );

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let replacement_runner = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("dispatch must create a fresh runner for the latest Analyst handoff");
    let role_plan_path = PathBuf::from(
        replacement_runner
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(new_handoff.display().to_string())
    );
}

#[test]
fn latest_labdirector_decision_reads_tail_of_large_jsonl() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-labdirector-decisions";
    // A cycle whose ledger is still the single file it used to be.
    let decisions_path = crate::core::support::labdirector_decisions_legacy_path(&paths, cycle);
    fs::create_dir_all(decisions_path.parent().unwrap()).unwrap();
    let large_historical_line = "x".repeat(256 * 1024);
    let latest = json!({
        "cycle_id": cycle,
        "mode": "refine",
        "decision": "latest-tail-entry"
    });
    fs::write(
        &decisions_path,
        format!("{large_historical_line}\n{}\n", serde_json::to_string(&latest).unwrap()),
    )
    .unwrap();

    let decision = latest_labdirector_decision(&paths, cycle)
        .unwrap()
        .expect("latest decision should parse from tail");
    assert_eq!(decision["decision"], json!("latest-tail-entry"));
}

#[test]
fn the_decision_ledger_is_written_and_read_by_the_hour() {
    use crate::core::support::{
        append_labdirector_decision, labdirector_decision_segment_path, labdirector_decision_segments,
        labdirector_decisions_dir, labdirector_decisions_legacy_path,
    };
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-hourly-decisions";
    assert!(latest_labdirector_decision(&paths, cycle).unwrap().is_none());

    // The name is the UTC hour, so segments sort into the order they were written.
    let at = |text: &str| chrono::DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&chrono::Utc);
    let nine = labdirector_decision_segment_path(&paths, cycle, at("2026-10-11T09:59:59Z"));
    let ten = labdirector_decision_segment_path(&paths, cycle, at("2026-10-11T10:00:00Z"));
    let next_day = labdirector_decision_segment_path(&paths, cycle, at("2026-10-12T00:00:01+09:00"));
    assert_eq!(nine.file_name().unwrap(), "2026-10-11T09.jsonl");
    assert_eq!(ten.file_name().unwrap(), "2026-10-11T10.jsonl");
    assert_eq!(next_day.file_name().unwrap(), "2026-10-11T15.jsonl");
    assert_eq!(nine.parent().unwrap(), labdirector_decisions_dir(&paths, cycle));

    // An append goes to the current hour's segment and nowhere else.
    let written = append_labdirector_decision(&paths, cycle, &json!({"decision": "now"})).unwrap();
    assert_eq!(written.parent().unwrap(), labdirector_decisions_dir(&paths, cycle));
    assert!(!labdirector_decisions_legacy_path(&paths, cycle).exists());
    assert_eq!(labdirector_decision_segments(&paths, cycle), vec![written.clone()]);
    assert_eq!(latest_labdirector_decision(&paths, cycle).unwrap().unwrap()["decision"], json!("now"));

    // Earlier hours, an unsplit single file, and a stray file in the directory.
    fs::write(&nine, "{\"decision\":\"nine-a\"}\n{\"decision\":\"nine-b\"}\n").unwrap();
    fs::write(&ten, "{\"decision\":\"ten\"}\n").unwrap();
    fs::write(labdirector_decisions_legacy_path(&paths, cycle), "{\"decision\":\"legacy\"}\n").unwrap();
    fs::write(labdirector_decisions_dir(&paths, cycle).join("notes.txt"), "not a segment").unwrap();
    fs::write(labdirector_decisions_dir(&paths, cycle).join("2026-10-11T10.jsonl.part"), "{}").unwrap();
    assert_eq!(
        labdirector_decision_segments(&paths, cycle),
        vec![labdirector_decisions_legacy_path(&paths, cycle), nine.clone(), ten.clone(), written.clone()]
    );
    assert_eq!(latest_labdirector_decision(&paths, cycle).unwrap().unwrap()["decision"], json!("now"));

    // The hour that has just begun is empty, and the one before ends in a
    // record a crash cut short: the latest decision is the last whole one.
    fs::write(&written, "").unwrap();
    fs::write(&ten, "{\"decision\":\"ten\"}\n{\"decision\":\"cut sho").unwrap();
    assert_eq!(latest_labdirector_decision(&paths, cycle).unwrap().unwrap()["decision"], json!("ten"));
    fs::remove_file(&ten).unwrap();
    assert_eq!(latest_labdirector_decision(&paths, cycle).unwrap().unwrap()["decision"], json!("nine-b"));
    fs::remove_file(&nine).unwrap();
    assert_eq!(latest_labdirector_decision(&paths, cycle).unwrap().unwrap()["decision"], json!("legacy"));
}

#[test]
fn latest_subagent_response_uses_large_cycle_state_cache() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-state-response-cache";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let lane_statuses = (0..40)
        .map(|idx| {
            json!({
                "lane_id": format!("followup-runner-{idx:02}"),
                "role": "lab-runner",
                "status": "completed",
                "updated_at": if idx == 39 { "2026-05-21T07:45:00Z" } else { "2026-05-21T07:00:00Z" }
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "updated_at": "2026-05-21T07:30:00Z",
            "lane_statuses": lane_statuses
        }),
    )
    .unwrap();

    let latest = latest_subagent_response_at(&paths, cycle)
        .unwrap()
        .expect("cached lane status timestamp should be used");
    assert_eq!(latest.to_rfc3339(), "2026-05-21T07:45:00+00:00");
}

#[test]
fn open_contract_paths_for_dispatch_uses_large_cycle_state_cache() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-open-contract-cache";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let pending_lane_id = "followup-lab-director-99";
    let pending_contract_path = lane_root(&paths, cycle, pending_lane_id).join("lane-contract.json");
    fs::create_dir_all(pending_contract_path.parent().unwrap()).unwrap();
    write_json(
        &pending_contract_path,
        &json!({
            "cycle_id": cycle,
            "lane_id": pending_lane_id,
            "role": "lab-director",
            "runtime_class": "codex-agent"
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
        "lane_id": pending_lane_id,
        "role": "lab-director",
        "status": "pending"
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "lane_statuses": lane_statuses
        }),
    )
    .unwrap();

    let contract_paths = open_contract_paths_for_dispatch(&paths, cycle, &[])
        .unwrap()
        .expect("large cycle state should be authoritative for open contracts");
    assert_eq!(contract_paths, vec![pending_contract_path]);
}

#[test]
fn supervision_contract_scope_uses_large_cycle_state_cache() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-supervision-scope";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let pending_lane_id = "followup-lab-director-88";
    let failed_lane_id = "followup-scout-88";
    let completed_lane_id = "followup-runner-88";
    for lane_id in [pending_lane_id, failed_lane_id, completed_lane_id] {
        let contract_path = lane_root(&paths, cycle, lane_id).join("lane-contract.json");
        fs::create_dir_all(contract_path.parent().unwrap()).unwrap();
        write_json(
            &contract_path,
            &json!({
                "cycle_id": cycle,
                "lane_id": lane_id,
                "role": "lab-director",
                "runtime_class": "codex-agent"
            }),
        )
        .unwrap();
    }
    let mut lane_statuses = (0..40)
        .map(|idx| {
            json!({
                "lane_id": format!("followup-analyst-{idx:02}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    lane_statuses.push(json!({
        "lane_id": pending_lane_id,
        "role": "lab-director",
        "status": "pending"
    }));
    lane_statuses.push(json!({
        "lane_id": failed_lane_id,
        "role": "scout",
        "status": "failed"
    }));
    lane_statuses.push(json!({
        "lane_id": completed_lane_id,
        "role": "lab-runner",
        "status": "completed"
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "lane_statuses": lane_statuses
        }),
    )
    .unwrap();

    let (contracts, lane_dirs) = supervision_contract_scope(&paths, cycle).unwrap();
    assert_eq!(contracts.len(), 2);
    assert!(contracts.contains(&lane_root(&paths, cycle, pending_lane_id).join("lane-contract.json")));
    assert!(contracts.contains(&lane_root(&paths, cycle, failed_lane_id).join("lane-contract.json")));
    assert!(lane_dirs.contains(&lane_root(&paths, cycle, completed_lane_id)));
}

#[test]
fn latest_completed_followup_action_uses_large_cycle_state_cache() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-latest-followup-action-cache";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let older_lane = "followup-chronicle-01";
    let newer_lane = "followup-chronicle-02";
    for lane_id in [older_lane, newer_lane] {
        let lane_dir = lane_root(&paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "chronicle",
                "action_type": "chronicle_evidence_request_followup",
                "source_brief_id": "chronicle-evidence"
            }),
        )
        .unwrap();
    }
    let mut lane_statuses = (0..40)
        .map(|idx| {
            json!({
                "lane_id": format!("followup-analyst-{idx:02}"),
                "role": "analyst",
                "status": "completed",
                "updated_at": "2026-05-21T06:00:00Z"
            })
        })
        .collect::<Vec<_>>();
    lane_statuses.push(json!({
        "lane_id": older_lane,
        "role": "chronicle",
        "status": "completed",
        "updated_at": "2026-05-21T07:00:00Z"
    }));
    lane_statuses.push(json!({
        "lane_id": newer_lane,
        "role": "chronicle",
        "status": "completed",
        "updated_at": "2026-05-21T07:30:00Z"
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "lane_statuses": lane_statuses
        }),
    )
    .unwrap();

    let latest = latest_completed_followup_action_at(
        &paths,
        cycle,
        "chronicle",
        "chronicle_evidence_request_followup",
        None,
    )
    .unwrap()
    .expect("large cycle state should provide the latest completed followup action");
    assert_eq!(latest.to_rfc3339(), "2026-05-21T07:30:00+00:00");
}

#[test]
fn review_labdirector_inbox_uses_embedded_soft_complete_counts() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-soft-complete-counts";
    let inbox_path = labdirector_inbox_path(&paths, cycle);
    fs::create_dir_all(inbox_path.parent().unwrap()).unwrap();

    let claim_deltas = (1..=6)
        .map(|idx| {
            json!({
                "claim_id": format!("claim-{idx}"),
                "previous": "tentative",
                "current": "exploratory",
                "reason": format!("reason-{idx}"),
            })
        })
        .collect::<Vec<_>>();
    let open_questions = (1..=3)
        .map(|idx| json!(format!("open-question-{idx}")))
        .collect::<Vec<_>>();
    let recommended_actions = (1..=4)
        .map(|idx| {
            json!({
                "type": format!("action-{idx}"),
                "priority": "high",
                "description": format!("recommended-action-{idx}"),
            })
        })
        .collect::<Vec<_>>();

    let report_item = json!({
        "ts": "2026-05-07T11:10:00Z",
        "type": "chronicle_report",
        "payload": {
            "lane_id": "followup-chronicle-03",
            "claim_delta_count": 0,
            "claim_deltas": [],
            "open_question_count": 0,
            "open_questions": [],
            "recommended_action_count": 0,
            "recommended_actions": [],
            "hypothesis_candidate_count": 0,
            "hypothesis_candidates": [],
            "strategy_advice": {
                "mode": "hold",
                "reason": "initial signal is stable enough for reporting"
            },
            "parse_warning": "chronicle lane soft-completed from partial structured output after mixed-format model response",
            "extracted_json": {
                "summary": "soft-complete payload with usable deltas",
                "claim_deltas": claim_deltas,
                "open_questions": open_questions,
                "recommended_actions": recommended_actions,
                "hypothesis_candidates": ["candidate-a", "candidate-b"],
                "strategy_advice": {
                    "mode": "refine",
                    "reason": "embedded payload remains actionable"
                }
            }
        }
    });
    fs::write(
        &inbox_path,
        format!("{}\n", serde_json::to_string(&report_item).unwrap()),
    )
    .unwrap();

    let review = review_labdirector_inbox(&paths, cycle)
        .unwrap()
        .expect("review should be emitted");
    assert_eq!(review["claim_delta_count"], json!(6));
    assert_eq!(review["open_question_count"], json!(3));
    assert_eq!(review["recommended_action_count"], json!(4));
    assert_eq!(review["mode"], json!("refine"));
    assert_eq!(
        review["reason"],
        json!("Chronicle reports contain unresolved questions or follow-up actions")
    );

    let strongest_lanes = review["chronicle_response"]["strongest_evidence_lanes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(strongest_lanes.len(), 1);
    assert_eq!(
        strongest_lanes[0]["lane_id"],
        json!("followup-chronicle-03")
    );
    assert_eq!(strongest_lanes[0]["claim_delta_count"], json!(6));
    assert_eq!(strongest_lanes[0]["open_question_count"], json!(3));

    let aggregate_metrics = read_json(&cycle_aggregate_metrics_path(&paths, cycle)).unwrap();
    assert_eq!(aggregate_metrics["claim_delta_count"], json!(6));
    assert_eq!(aggregate_metrics["open_question_count"], json!(3));
    assert_eq!(aggregate_metrics["recommended_action_count"], json!(4));
}

#[test]
fn review_labdirector_inbox_routes_supervisor_instruction_to_labdirector() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-supervisor-instruction";
    let inbox_path = labdirector_inbox_path(&paths, cycle);
    fs::create_dir_all(inbox_path.parent().unwrap()).unwrap();

    let supervisor_item = json!({
        "ts": "2026-05-21T03:00:00Z",
        "type": "supervisor_instruction",
        "payload": {
            "issue_code": "cycle_blocked_no_active_lanes",
            "severity": "process_attention",
            "message": "Process stall: LabDirector must author the next research instruction.",
            "requested_action": {
                "supervisor_scope": "process_escalation_only",
                "lab_director_must_author_research_instruction": true
            }
        }
    });
    fs::write(
        &inbox_path,
        format!("{}\n", serde_json::to_string(&supervisor_item).unwrap()),
    )
    .unwrap();

    let review = review_labdirector_inbox(&paths, cycle)
        .unwrap()
        .expect("supervisor instruction should be reviewed");
    assert_eq!(review["mode"], json!("refine"));
    assert_eq!(review["supervisor_instruction_count"], json!(1));
    let spawned = review["spawned_supervisor_instruction_lanes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0]["role"], json!("lab-director"));
    assert_eq!(
        spawned[0]["source_brief_id"],
        json!("supervisor-instruction-cycle_blocked_no_active_lanes")
    );

    let role_plan_path = PathBuf::from(
        spawned[0]
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("lab_director_requery_followup")
    );
    assert_eq!(
        role_plan.get("source_brief_id").and_then(Value::as_str),
        Some("supervisor-instruction-cycle_blocked_no_active_lanes")
    );
    assert_eq!(
        role_plan["planner_metadata"]["supervisor_scope"],
        json!("process_escalation_only")
    );
    assert_eq!(
        role_plan["planner_metadata"]["lab_director_must_author_research_instruction"],
        json!(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["research_notes_policy"]["must_update_notes_with_decision"],
        json!(true)
    );
}

#[test]
fn gate_score_stagnation_waits_for_pending_gatekeeper_reviews() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-supervisor-gatekeeper-first";
    let inbox_path = labdirector_inbox_path(&paths, cycle);
    fs::create_dir_all(inbox_path.parent().unwrap()).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "score": 63,
            "pass": false,
            "gatekeeper_pending_rubrics": ["novelty", "impact"],
            "recommended_actions": [{
                "type": "independent_gate_review_followup",
                "preferred_role": "gatekeeper",
                "target_rubric": "novelty",
                "validation_results": {"validation_results": [{"lane_id": "followup-runner-694"}]}
            }]
        }),
    )
    .unwrap();

    let supervisor_item = json!({
        "ts": "2026-06-02T03:00:00Z",
        "type": "supervisor_instruction",
        "payload": {
            "issue_code": "gate_score_stagnation",
            "severity": "process_attention",
            "message": "Gate score is unchanged; close the pending gatekeeper rubric reviews first."
        }
    });
    fs::write(
        &inbox_path,
        format!("{}\n", serde_json::to_string(&supervisor_item).unwrap()),
    )
    .unwrap();

    let review = review_labdirector_inbox(&paths, cycle)
        .unwrap()
        .expect("supervisor instruction should be reviewed");
    assert_eq!(review["mode"], json!("refine"));
    assert_eq!(review["supervisor_instruction_count"], json!(1));
    assert_eq!(
        review["spawned_supervisor_instruction_lanes"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    let lane_root = cycle_lanes_root(&paths, cycle);
    let spawned_lab_directors = fs::read_dir(&lane_root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("followup-lab-director-")
        })
        .count();
    assert_eq!(spawned_lab_directors, 0);
}

#[test]
fn review_labdirector_inbox_dedupes_open_supervisor_instruction_lane() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-supervisor-dedupe";
    let inbox_path = labdirector_inbox_path(&paths, cycle);
    fs::create_dir_all(inbox_path.parent().unwrap()).unwrap();

    let supervisor_item = json!({
        "ts": "2026-05-21T03:00:00Z",
        "type": "supervisor_instruction",
        "payload": {
            "issue_code": "cycle_blocked_no_active_lanes",
            "severity": "process_attention",
            "message": "Process stall: LabDirector must author the next research instruction."
        }
    });
    fs::write(
        &inbox_path,
        format!("{}\n", serde_json::to_string(&supervisor_item).unwrap()),
    )
    .unwrap();

    let first_review = review_labdirector_inbox(&paths, cycle)
        .unwrap()
        .expect("first supervisor instruction should be reviewed");
    assert_eq!(
        first_review["spawned_supervisor_instruction_lanes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let second_item = json!({
        "ts": "2026-05-21T03:05:00Z",
        "type": "supervisor_instruction",
        "payload": {
            "issue_code": "cycle_blocked_no_active_lanes",
            "severity": "process_attention",
            "message": "Same process stall repeated before the LabDirector lane has finished."
        }
    });
    fs::write(
        &inbox_path,
        format!(
            "{}\n{}\n",
            serde_json::to_string(&supervisor_item).unwrap(),
            serde_json::to_string(&second_item).unwrap()
        ),
    )
    .unwrap();

    let second_review = review_labdirector_inbox(&paths, cycle)
        .unwrap()
        .expect("second supervisor instruction should be acknowledged");
    assert_eq!(second_review["supervisor_instruction_count"], json!(1));
    assert_eq!(
        second_review["spawned_supervisor_instruction_lanes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let lane_root = cycle_lanes_root(&paths, cycle);
    let labdirector_lanes = fs::read_dir(lane_root)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("followup-lab-director-"))
        .count();
    assert_eq!(labdirector_lanes, 1);
}

/// Fixture for the supersession-grace tests: an old and a new executable analyst
/// handoff, plus a lab-runner still bound to the old one.
fn stale_handoff_runner_fixture(tmp: &TempDir, cycle: &str) -> (AppPaths, PathBuf, String) {
    let paths = build_paths(tmp.path());
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Let a running renderer finish before superseding it."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "Variance-guided allocation beats uniform at matched spp.",
            "identification_strategy": {"design": "latest handoff only"}
        }),
    )
    .unwrap();

    let mut handoffs = Vec::new();
    for (lane, label) in [("followup-analyst-01", "old"), ("followup-analyst-02", "new")] {
        create_lane_contract(&paths, cycle, lane, "analyst", "external-driver", "driver-exec", label)
            .unwrap();
        let dir = lane_root(&paths, cycle, lane);
        write_json(
            &dir.join("run-state.json"),
            &json!({"lane_id": lane, "role": "analyst", "status": "done"}),
        )
        .unwrap();
        write_json(
            &dir.join("final-status.json"),
            &json!({"lane_id": lane, "status": "completed"}),
        )
        .unwrap();
        let handoff = dir.join("handoff-validation-plan.json");
        write_json(
            &handoff,
            &json!({
                "status": "ready",
                "summary": format!("{label} executable handoff."),
                "handoff_checks": [{"check_id": format!("{label}_check"), "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
                "validation_code_blueprints": [{"blueprint_id": label, "code": "print('x')"}]
            }),
        )
        .unwrap();
        handoffs.push(handoff);
    }
    let old_handoff = handoffs.remove(0);

    let runner = "followup-runner-01".to_string();
    create_lane_contract(
        &paths,
        cycle,
        &runner,
        "lab-runner",
        "external-driver",
        "driver-exec",
        &format!("execute the handoff from {}", old_handoff.display()),
    )
    .unwrap();
    let runner_dir = lane_root(&paths, cycle, &runner);
    write_json(
        &runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": runner,
            "role": "lab-runner",
            "action_type": "methods_followup",
            "source_brief_id": "analyst-handoff",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": old_handoff
                }
            }
        }),
    )
    .unwrap();
    (paths, runner_dir, runner)
}

fn runner_was_superseded(actions: &[Value], lane_id: &str) -> bool {
    actions.iter().any(|item| {
        item.get("action").and_then(Value::as_str) == Some("supersede_stale_direct_handoff_runner")
            && item.get("lane_id").and_then(Value::as_str) == Some(lane_id)
    })
}

#[test]
fn a_running_renderer_is_left_to_finish_before_being_superseded() {
    // cycle-g-v74: 76 runner lanes ended "aborted / superseded by newer
    // executable analyst handoff" and not one wrote a result. The analyst emitted
    // a fresh handoff every few minutes while a render sweep took longer than
    // that, so no runner ever reached the finish line and reproducibility stayed
    // at 14-25 across 158 gate reviews.
    let tmp = TempDir::new().unwrap();
    let cycle = "cycle-runner-grace-running";
    let (paths, runner_dir, runner) = stale_handoff_runner_fixture(&tmp, cycle);
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({
            "lane_id": runner,
            "role": "lab-runner",
            "status": "running",
            "updated_at": Utc::now().to_rfc3339()
        }),
    )
    .unwrap();

    let actions = supervise_cycle(&paths, cycle, 2, 1800).unwrap();
    assert!(
        !runner_was_superseded(&actions, &runner),
        "a runner that is already executing must be allowed to produce its evidence"
    );
    assert!(
        !runner_dir.join("final-status.json").exists(),
        "the running lane must not be finalized as aborted"
    );
}

#[test]
fn a_runner_that_never_launched_is_still_superseded() {
    // Nothing is lost by replacing a lane that holds no work — that is the whole
    // point of the rule, and the grace must not disable it.
    let tmp = TempDir::new().unwrap();
    let cycle = "cycle-runner-grace-pending";
    let (paths, runner_dir, runner) = stale_handoff_runner_fixture(&tmp, cycle);
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({
            "lane_id": runner,
            "role": "lab-runner",
            "status": "pending",
            "updated_at": Utc::now().to_rfc3339()
        }),
    )
    .unwrap();

    let actions = supervise_cycle(&paths, cycle, 2, 1800).unwrap();
    assert!(runner_was_superseded(&actions, &runner));
}

#[test]
fn a_runner_stalled_past_the_grace_is_reclaimed() {
    // The grace is bounded: past roughly the compute budget the runner was
    // promised it is not going to produce evidence, and the stale-handoff
    // argument wins again.
    let tmp = TempDir::new().unwrap();
    let cycle = "cycle-runner-grace-expired";
    let (paths, runner_dir, runner) = stale_handoff_runner_fixture(&tmp, cycle);
    let long_ago =
        Utc::now() - chrono::Duration::seconds(RUNNER_SUPERSEDE_GRACE_SECONDS_DEFAULT + 600);
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({
            "lane_id": runner,
            "role": "lab-runner",
            "status": "running",
            "updated_at": long_ago.to_rfc3339()
        }),
    )
    .unwrap();

    let actions = supervise_cycle(&paths, cycle, 2, 1800).unwrap();
    assert!(runner_was_superseded(&actions, &runner));
}
