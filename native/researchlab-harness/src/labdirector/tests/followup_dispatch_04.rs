#[test]
fn equivalent_newer_handoff_still_dispatches_fresh_runner() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-equivalent-newer-handoff-runner";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run the latest Analyst handoff exactly once."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE228779 liver-cell injury/interferon decoupling.",
            "dataset_or_accession": "GSE228779"
        }),
    )
    .unwrap();

    let old_analyst_dir = lane_root(&paths, cycle, "followup-analyst-01");
    fs::create_dir_all(&old_analyst_dir).unwrap();
    let old_handoff_path = old_analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &old_analyst_dir.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-01", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_analyst_dir.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_handoff_path,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/gse228779",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "GSE228779 liver-cell injury/interferon decoupling",
                "secondary_limitations": ["older note"]
            },
            "handoff_checks": [{"check_id": "primary_direction", "goal": "estimate primary effect", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"check_id": "primary_direction", "code": "print('ok')", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
        }),
    )
    .unwrap();

    let runner_dir = lane_root(&paths, cycle, "followup-runner-01");
    fs::create_dir_all(&runner_dir).unwrap();
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({"lane_id": "followup-runner-01", "role": "lab-runner", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_dir.join("final-status.json"),
        &json!({
            "lane_id": "followup-runner-01",
            "status": "completed",
            "result_path": runner_dir.join("result.json")
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("role-plan.json"),
        &json!({
            "planner_metadata": {
                "analyst_handoff_path": old_handoff_path,
                "analysis_request": {"handoff_path": old_handoff_path}
            }
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("result.json"),
        &json!({
            "validation_summary": {"overall_status": "passed", "checks_failed": 0, "blueprints_failed": 0},
            "role_plan": {
                "planner_metadata": {
                    "analyst_handoff_path": old_handoff_path
                }
            }
        }),
    )
    .unwrap();

    std::thread::sleep(std::time::Duration::from_millis(20));
    let new_analyst_dir = lane_root(&paths, cycle, "followup-analyst-02");
    fs::create_dir_all(&new_analyst_dir).unwrap();
    let new_handoff_path = new_analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &new_analyst_dir.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-02", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &new_analyst_dir.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-02", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &new_handoff_path,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/gse228779",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "GSE228779 liver-cell injury/interferon decoupling",
                "secondary_limitations": ["newer patient-aware note"]
            },
            "handoff_checks": [{"check_id": "primary_direction", "goal": "estimate primary effect", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"check_id": "primary_direction", "code": "print('ok')", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
        }),
    )
    .unwrap();
    // Context refresh can rewrite or copy older handoff artifacts after a
    // newer Analyst lane completes. Dispatch must still use lane recency,
    // not the handoff file mtime, when choosing the executable frontier.
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_json(
        &old_handoff_path,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/gse228779",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "GSE228779 liver-cell injury/interferon decoupling",
                "secondary_limitations": ["older note refreshed later"]
            },
            "handoff_checks": [{"check_id": "primary_direction", "goal": "estimate primary effect", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"check_id": "primary_direction", "code": "print('ok')", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let runner = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("latest equivalent handoff still needs its own LabRunner lane");
    let role_plan = read_json(&PathBuf::from(
        runner
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(new_handoff_path.display().to_string())
    );
}

#[test]
fn aborted_direct_handoff_runner_is_retried() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-aborted-direct-handoff-runner-retry";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Retry an Analyst handoff runner if the first direct runner was orphan-aborted."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 liver-cell injury/interferon decoupling.",
            "validation_data_status": "materialized",
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse228779"}
            }
        }),
    )
    .unwrap();

    let analyst_dir = lane_root(&paths, cycle, "followup-analyst-01");
    fs::create_dir_all(&analyst_dir).unwrap();
    let handoff_path = analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &analyst_dir.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-01", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_dir.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &handoff_path,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/gse228779",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "GSE228779 liver-cell injury/interferon decoupling"
            },
            "handoff_checks": [{"check_id": "primary_direction", "goal": "estimate primary effect", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"check_id": "primary_direction", "code": "print('ok')", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
        }),
    )
    .unwrap();

    let first_created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let first_runner = first_created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("initial executable handoff should create a direct LabRunner lane");
    let first_runner_id = first_runner
        .get("lane_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    write_json(
        &lane_root(&paths, cycle, &first_runner_id).join("run-state.json"),
        &json!({
            "lane_id": first_runner_id,
            "role": "lab-runner",
            "status": "aborted",
            "reason": "orphaned running lane detected during status reconciliation"
        }),
    )
    .unwrap();
    write_json(
        &lane_root(&paths, cycle, &first_runner_id).join("final-status.json"),
        &json!({
            "lane_id": first_runner_id,
            "status": "aborted",
            "reason": "orphaned running lane detected during status reconciliation"
        }),
    )
    .unwrap();

    let retry_created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let retry_runner = retry_created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("aborted direct handoff runner should be retried");
    assert_ne!(
        retry_runner.get("lane_id").and_then(Value::as_str),
        Some(first_runner_id.as_str())
    );
    let retry_role_plan = read_json(&PathBuf::from(
        retry_runner
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        retry_role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(handoff_path.display().to_string())
    );
}

#[test]
fn pre_schedule_dispatch_creates_runner_for_waiting_handoff_with_running_scout() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-pre-schedule-handoff-runner";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run analyst to runner handoff before slow materialization followups."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A materialized lead keeps advisory gates out of this test.",
            "validation_data_status": "materialized",
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/materialized"}
            }
        }),
    )
    .unwrap();

    let analyst_lane = "followup-analyst-42";
    let analyst_dir = lane_root(&paths, cycle, analyst_lane);
    fs::create_dir_all(&analyst_dir).unwrap();
    let handoff_path = analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &analyst_dir.join("run-state.json"),
        &json!({"lane_id": analyst_lane, "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_dir.join("final-status.json"),
        &json!({"lane_id": analyst_lane, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &handoff_path,
        &json!({
            "status": "ready_for_runner",
            "summary": "Executable handoff awaiting lab-runner execution.",
            "handoff_checks": [{"check_id": "check_latest", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "bp_latest", "code": "print('latest')"}]
        }),
    )
    .unwrap();

    let scout_lane = "followup-scout-99";
    let scout_dir = lane_root(&paths, cycle, scout_lane);
    fs::create_dir_all(&scout_dir).unwrap();
    write_json(
        &scout_dir.join("run-state.json"),
        &json!({"lane_id": scout_lane, "role": "scout", "status": "running"}),
    )
    .unwrap();
    write_json(
        &scout_dir.join("role-plan.json"),
        &json!({
            "lane_id": scout_lane,
            "role": "scout",
            "action_type": "data_acquisition_followup",
            "source_brief_id": "slow-materialization"
        }),
    )
    .unwrap();
    create_lane_contract(
        &paths,
        cycle,
        scout_lane,
        "scout",
        "external-driver",
        "run",
        "slow materialization lane",
    )
    .unwrap();

    let created = dispatch_pre_schedule_followups(&paths, cycle, 4, 4).unwrap();
    let runner = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("waiting executable handoff should pre-schedule a lab-runner");
    assert_eq!(
        runner.get("source_brief_id").and_then(Value::as_str),
        Some("analyst-handoff")
    );
    let role_plan_path = PathBuf::from(
        runner
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(handoff_path.display().to_string())
    );
}

#[test]
fn changing_paper_counts_do_not_make_a_failed_literature_lineage_unbounded() {
    // MEASURED ON cycle-a-20260919, 2026-10-06. Trigger lanes
    // followup-scout-258, -259, and -260 finished after conclusion across two
    // recovery lineages. Both lineages kept ending
    // adaptive_literature_search_incomplete while paper_count changed, so the
    // volatile outcome key kept scheduling more searches instead of leaving
    // the director's decision-critical Chronicle pivot runnable.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-bounded-literature-recovery-lineage";
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();

    let attempts = [
        (
            "followup-scout-241",
            "reasoning_literature_scout",
            "hypothesis-gate",
            11,
        ),
        (
            "followup-scout-235",
            "abstract_review_followup",
            "hypothesis-restart",
            0,
        ),
        (
            "followup-scout-249",
            "adaptive_search_followup",
            "followup-scout-235",
            55,
        ),
        (
            "followup-scout-258",
            "adaptive_search_followup",
            "followup-scout-241",
            20,
        ),
        (
            "followup-scout-259",
            "adaptive_search_followup",
            "followup-scout-249",
            65,
        ),
        (
            "followup-scout-260",
            "adaptive_search_followup",
            "followup-scout-258",
            27,
        ),
    ];
    for (index, (lane_id, action_type, source_brief_id, paper_count)) in
        attempts.into_iter().enumerate()
    {
        let lane_dir = lane_root(&paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "scout",
                "action_type": action_type,
                "source_brief_id": source_brief_id
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "failed",
                "completed_at": format!("2026-10-06T03:{index:02}:00Z")
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("result.json"),
            &json!({
                "status": "insufficient_corpus",
                "failure_category": "adaptive_literature_search_incomplete",
                "paper_count": paper_count,
                "search_agent_assessment": {
                    "errors": if index < 2 {
                        json!(["search_not_completed", "coverage_gaps_missing"])
                    } else {
                        json!(["search_not_completed", "coverage_gaps_pending"])
                    }
                },
                "recommended_actions": [{
                    "type": "adaptive_search_followup",
                    "description": "resume broad literature acquisition"
                }]
            }),
        )
        .unwrap();
    }

    let mut actions = vec![json!({
        "type": "chronicle_evidence_request_followup",
        "preferred_role": "chronicle",
        "description": "answer the director's bounded exact-hash question"
    })];
    collect_failed_literature_recovery_actions(&paths, cycle, &mut actions).unwrap();

    assert_eq!(actions.len(), 1, "a fourth adaptive resume must not be offered");
    assert_eq!(
        actions[0].get("type").and_then(Value::as_str),
        Some("chronicle_evidence_request_followup"),
        "the targeted pivot must remain available to advance the cycle"
    );
}
