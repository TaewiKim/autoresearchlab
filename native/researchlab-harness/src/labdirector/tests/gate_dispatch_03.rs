#[test]
fn gatekeeper_waits_for_labdirector_recovery_on_degraded_runner() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-degraded-runner-hard-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE289864 MAIT17 signal predicts suppressive myeloid co-enrichment.",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();

    let handoff_path = tmp.path().join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({"status": "ready", "handoff_checks": [{"check_id": "primary", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]}),
    )
    .unwrap();
    let analyst_lane = lane_root(&paths, cycle, "followup-analyst-handoff");
    fs::create_dir_all(&analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-analyst-handoff",
        "analyst",
        "external-driver",
        "driver-exec",
        "analyst handoff fixture",
    )
    .unwrap();
    write_json(
        &analyst_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-handoff", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-handoff", "status": "completed"}),
    )
    .unwrap();
    write_json(&analyst_lane.join("result.json"), &json!({"status": "completed"})).unwrap();

    let runner_lane = lane_root(&paths, cycle, "followup-runner-01");
    fs::create_dir_all(&runner_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-runner-01",
        "lab-runner",
        "external-driver",
        "driver-exec",
        "runner fixture",
    )
    .unwrap();
    write_json(
        &runner_lane.join("run-state.json"),
        &json!({"lane_id": "followup-runner-01", "role": "lab-runner", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_lane.join("final-status.json"),
        &json!({"lane_id": "followup-runner-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_lane.join("result.json"),
        &json!({
            "role_plan": {"planner_metadata": {"analyst_handoff_path": handoff_path}},
            "validation_summary": {
                "overall_status": "degraded",
                "checks_failed": 2,
                "blueprints_failed": 0,
                "analyst_quality_standard": {"satisfied": false}
            }
        }),
    )
    .unwrap();

    let gatekeeper_lane = lane_root(&paths, cycle, "followup-gatekeeper-01");
    fs::create_dir_all(&gatekeeper_lane).unwrap();
    let gatekeeper_contract_path = create_lane_contract(
        &paths,
        cycle,
        "followup-gatekeeper-01",
        "gatekeeper",
        "codex-agent",
        "run",
        "gatekeeper fixture",
    )
    .unwrap();
    write_json(
        &gatekeeper_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup"
        }),
    )
    .unwrap();
    let contract: LaneContract =
        serde_json::from_value(read_json(&gatekeeper_contract_path).unwrap()).unwrap();
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert!(
        blocker
            .as_deref()
            .unwrap_or("")
            .contains("waiting-for-labdirector-runner-recovery"),
        "Gatekeeper must wait for LabDirector degraded-runner recovery, got {blocker:?}"
    );

    let recovery_lane = lane_root(&paths, cycle, "followup-lab-director-runner-recovery");
    fs::create_dir_all(&recovery_lane).unwrap();
    let recovery_contract_path = create_lane_contract(
        &paths,
        cycle,
        "followup-lab-director-runner-recovery",
        "lab-director",
        "codex-agent",
        "run",
        "runner recovery fixture",
    )
    .unwrap();
    write_json(
        &recovery_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-runner-recovery",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "labdirector-runner-recovery-followup-runner-01"
        }),
    )
    .unwrap();

    let completed_generic_requery_lane = lane_root(&paths, cycle, "followup-lab-director-generic");
    fs::create_dir_all(&completed_generic_requery_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-lab-director-generic",
        "lab-director",
        "codex-agent",
        "run",
        "generic requery fixture",
    )
    .unwrap();
    write_json(
        &completed_generic_requery_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-generic",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "gate-stagnation-review"
        }),
    )
    .unwrap();
    write_json(
        &completed_generic_requery_lane.join("final-status.json"),
        &json!({"lane_id": "followup-lab-director-generic", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &completed_generic_requery_lane.join("result.json"),
        &json!({"decision_status": "final"}),
    )
    .unwrap();
    let chronicle_lane = lane_root(&paths, cycle, "followup-chronicle-completed");
    fs::create_dir_all(&chronicle_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-chronicle-completed",
        "chronicle",
        "codex-agent",
        "run",
        "chronicle fixture",
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-chronicle-completed",
            "role": "chronicle",
            "action_type": "chronicle_gate_deliberation_followup"
        }),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("final-status.json"),
        &json!({"lane_id": "followup-chronicle-completed", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("run-state.json"),
        &json!({"lane_id": "followup-chronicle-completed", "role": "chronicle", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("result.json"),
        &json!({"summary": "Chronicle context ready."}),
    )
    .unwrap();

    let recovery_contract: LaneContract =
        serde_json::from_value(read_json(&recovery_contract_path).unwrap()).unwrap();
    let blocker = dependency_blocker_for_lane(&paths, cycle, &recovery_contract).unwrap();
    assert_eq!(
        blocker, None,
        "Runner recovery LabDirector requery must not be blocked as a duplicate generic requery"
    );

    let recovery_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&recovery_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-lab-director-01",
        "lab-director",
        "codex-agent",
        "run",
        "runner recovery fixture",
    )
    .unwrap();
    write_json(
        &recovery_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "labdirector-runner-recovery-followup-runner-01"
        }),
    )
    .unwrap();
    write_json(
        &recovery_lane.join("final-status.json"),
        &json!({"lane_id": "followup-lab-director-01", "status": "completed"}),
    )
    .unwrap();
    write_json(&recovery_lane.join("result.json"), &json!({"decision_status": "final"})).unwrap();

    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert_eq!(blocker, None);
}

#[test]
fn gatekeeper_waits_for_runner_on_latest_analyst_handoff() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-latest-handoff-runner-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();

    let old_analyst_lane = lane_root(&paths, cycle, "followup-analyst-01");
    fs::create_dir_all(&old_analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-analyst-01",
        "analyst",
        "external-driver",
        "driver-exec",
        "old analyst handoff fixture",
    )
    .unwrap();
    let old_handoff_path = old_analyst_lane.join("handoff-validation-plan.json");
    write_json(
        &old_analyst_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-01", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_analyst_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_handoff_path,
        &json!({
            "status": "ready",
            "summary": "Old executable handoff.",
            "handoff_checks": [{"check_id": "old_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "old", "code": "print('old')"}]
        }),
    )
    .unwrap();

    let new_analyst_lane = lane_root(&paths, cycle, "followup-analyst-02");
    fs::create_dir_all(&new_analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-analyst-02",
        "analyst",
        "external-driver",
        "driver-exec",
        "new analyst handoff fixture",
    )
    .unwrap();
    let new_handoff_path = new_analyst_lane.join("handoff-validation-plan.json");
    write_json(
        &new_analyst_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-02", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &new_analyst_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-02", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &new_handoff_path,
        &json!({
            "status": "ready",
            "summary": "New executable handoff.",
            "handoff_checks": [{"check_id": "new_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "new", "code": "print('new')"}]
        }),
    )
    .unwrap();

    let runner_lane = lane_root(&paths, cycle, "followup-runner-01");
    fs::create_dir_all(&runner_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-runner-01",
        "lab-runner",
        "external-driver",
        "driver-exec",
        "old runner fixture",
    )
    .unwrap();
    write_json(
        &runner_lane.join("run-state.json"),
        &json!({"lane_id": "followup-runner-01", "role": "lab-runner", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_lane.join("final-status.json"),
        &json!({"lane_id": "followup-runner-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_lane.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": {
                "source_brief_id": "analyst-handoff",
                "action_type": "methods_followup",
                "planner_metadata": {
                    "analyst_handoff_path": old_handoff_path,
                    "analyst_handoff": {"summary": "Old executable handoff."}
                }
            },
            "validation_summary": {
                "overall_status": "pass",
                "checks_failed": 0,
                "blueprints_failed": 0,
                "analyst_quality_standard": {"satisfied": true}
            }
        }),
    )
    .unwrap();

    let gatekeeper_contract_path = create_lane_contract(
        &paths,
        cycle,
        "followup-gatekeeper-01",
        "gatekeeper",
        "codex-agent",
        "run",
        "gatekeeper fixture",
    )
    .unwrap();
    let contract: LaneContract =
        serde_json::from_value(read_json(&gatekeeper_contract_path).unwrap()).unwrap();
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert!(
        blocker
            .as_deref()
            .unwrap_or("")
            .contains("waiting-for-latest-analyst-handoff-runner"),
        "Gatekeeper must wait until the newest Analyst handoff has its own runner, got {blocker:?}"
    );
}

#[test]
fn stage_gates_require_ordered_search_kg_hypothesis_validation() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-stage-gates";

    let initial = research_stage_gate_state(&paths, cycle).unwrap();
    assert_eq!(
        initial["gates"][0]["stage"],
        json!("literature_data_search")
    );
    assert_eq!(initial["gates"][0]["passed"], json!(false));

    write_stage_gate_search_inputs(&paths, cycle);
    let after_search = research_stage_gate_state(&paths, cycle).unwrap();
    assert_eq!(after_search["gates"][0]["passed"], json!(true));
    assert_eq!(after_search["gates"][1]["stage"], json!("kg_generation"));
    assert_eq!(after_search["gates"][1]["passed"], json!(false));

    write_stage_gate_kg(&paths, cycle);
    let after_kg = research_stage_gate_state(&paths, cycle).unwrap();
    assert_eq!(after_kg["gates"][1]["passed"], json!(true));
    assert_eq!(
        after_kg["gates"][2]["stage"],
        json!("hypothesis_generation")
    );
    assert_eq!(after_kg["gates"][2]["passed"], json!(false));

    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "RPPA pathway activity improves TCGA-BRCA survival stratification.",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    let after_hypothesis = research_stage_gate_state(&paths, cycle).unwrap();
    assert_eq!(after_hypothesis["gates"][2]["passed"], json!(true));
    assert_eq!(
        after_hypothesis["gates"][3]["stage"],
        json!("validation_materialization_analysis")
    );
    assert_eq!(after_hypothesis["gates"][3]["passed"], json!(false));
}

#[test]
fn hypothesis_gate_failure_restarts_from_literature_data_search() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-hypothesis-gate-restart";
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A weak lead that the hypothesis gate rejects.",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "hypothesis_gate_passed": false,
            "restart_recommended": true,
            "verdict": "reject"
        }),
    )
    .unwrap();

    let gate_state = research_stage_gate_state(&paths, cycle).unwrap();
    assert_eq!(gate_state["gates"][2]["passed"], json!(false));
    assert_eq!(
        gate_state["gates"][2]["retry_from_stage"],
        json!("literature_data_search")
    );

    let mut actions = vec![json!({
        "brief_id": "validation-only-patch",
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "priority_score": 1,
        "description": "try to patch validation only"
    }), json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "priority_score": 285,
        "description": "execute the latest executable analyst handoff from handoff-validation-plan.json"
    })];
    enforce_stage_gate_recovery_actions(
        &paths,
        cycle,
        &mut actions,
        "Do omics KG-first research; never reuse GSE282742.",
    )
    .unwrap();

    assert!(!actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("validation-only-patch")
    }));
    assert!(actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff")
            && action.get("type").and_then(Value::as_str) == Some("methods_followup")
    }));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("gate_restart_followup")
            && action
                .get("requires_completed_chronicle_gate_deliberation")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }));
    assert!(actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("hypothesis-gate-literature-restart")
            && action.get("type").and_then(Value::as_str) == Some("data_acquisition_followup")
    }));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str)
            == Some("hypothesis_regeneration_from_literature_search")
    }));
}

#[test]
fn dispatch_e2e_routes_failed_hypothesis_gate_to_scout_restart() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-hypothesis-gate-e2e";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run KG-first omics research and never reuse GSE282742."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A weak lead that should not survive the hypothesis gate.",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "hypothesis_gate_passed": false,
            "restart_recommended": true,
            "verdict": "reject"
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 2).unwrap();
    let chronicle = created
            .iter()
            .find(|item| item.get("role").and_then(Value::as_str) == Some("chronicle"))
            .expect(
                "failed hypothesis gate must dispatch Chronicle deliberation before literature/data restart",
            );
    assert_eq!(
        chronicle.get("source_brief_id").and_then(Value::as_str),
        Some("hypothesis-gate-chronicle-deliberation")
    );
    let role_plan_path = PathBuf::from(
        chronicle
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("chronicle_gate_deliberation_followup")
    );
    let role_plan_text = serde_json::to_string(&role_plan).unwrap();
    assert!(role_plan_text.contains("Hypothesis gate failed"));
    assert!(role_plan_text.contains("Chronicle"));
}

#[test]
fn a_rejected_gate_still_opens_the_data_scout_its_chronicle_step_waits_for() {
    // cycle-b-20260918: after the literature search finally completed, every
    // core lane sat pending. Chronicle waits for a completed data scout, and the
    // data_acquisition_followup that would produce one was deferred to Chronicle's
    // gate deliberation every pass.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-data-scout-loop";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run KG-first omics research and never reuse GSE282742."}),
    )
    .unwrap();
    // Only the literature scout completed; no data scout has.
    write_stage_gate_lane(&paths, cycle, "scout-01", "scout", "literature-search-driver", json!({"paper_count": 27}));
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A weak lead that should not survive the hypothesis gate.",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({"hypothesis_gate_passed": false, "restart_recommended": true, "verdict": "reject"}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let data_scout = created.iter().find(|item| {
        item.get("source_brief_id").and_then(Value::as_str) == Some("hypothesis-gate-literature-restart")
    });
    let data_scout = data_scout.unwrap_or_else(|| {
        panic!("no data scout dispatched while none has completed; created={created:?}")
    });
    let role_plan = read_json(&PathBuf::from(
        data_scout.get("role_plan_path").and_then(Value::as_str).unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("data_acquisition_followup")
    );
    // The Chronicle deliberation is still dispatched alongside it.
    assert!(created.iter().any(|item| {
        item.get("source_brief_id").and_then(Value::as_str)
            == Some("hypothesis-gate-chronicle-deliberation")
    }));
}
