#[test]
fn measured_supporting_handoff_result_prevents_a_new_runner() {
    // MEASURED ON cycle-a-20260919, 2026-11-22: runner 859 recorded
    // analyst 1655's supporting check only in executed_handoff_path. The
    // scheduler did not credit it and dispatched runner 861 for the same check.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-a-20260919";
    let analyst_dir = lane_root(&paths, cycle, "followup-analyst-1655");
    fs::create_dir_all(&analyst_dir).unwrap();
    let handoff_path = analyst_dir.join("handoff-validation-plan.json");
    let check = "development_endpoint_tolerance_1655";
    let execution_id = "dff9cc37026d7565294c1094acb812e5c8af1908c9ff9fec30127cabf3479eec";
    write_json(&handoff_path, &json!({
        "handoff_seal": {"status": "sealed", "execution_id": execution_id},
        "handoff_checks": [{
            "check_id": check,
            "dataset": "episodes.csv",
            "exposures": ["endpoint_error"],
            "column_mapping": {"analysis_evidence_role": "supporting"},
        }],
        "validation_code_blueprints": [{"check_id": check, "code": "print('check')"}],
    })).unwrap();
    write_json(&analyst_dir.join("run-state.json"), &json!({"role": "analyst", "status": "completed"})).unwrap();
    write_json(&analyst_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
    assert_eq!(latest_executable_analyst_handoff_served(&paths, cycle).unwrap(), Some(false));

    let runner = "followup-runner-859";
    let runner_dir = lane_root(&paths, cycle, runner);
    fs::create_dir_all(&runner_dir).unwrap();
    let role_plan = json!({
        "role": "lab-runner",
        "action_type": "labdirector_comparator_validation_followup",
        "planner_metadata": {"runner_handoff_required": false},
    });
    write_json(&runner_dir.join("role-plan.json"), &role_plan).unwrap();
    let result_path = runner_dir.join("result.json");
    write_json(&result_path, &json!({
        "role_plan": role_plan,
        "status": "completed",
        "executed_handoff_path": handoff_path,
        "execution_receipts": [{
            "script_sha256": "7a8716ec79be9add11bf337f9e6c813a6e5e846b4351e480b3489368e0a84a31",
            "check_spec_sha256": "a0852e8fc129add69dcc9791d990a90bcf08894188203b0d052463ad5a42c9ce",
            "return_code": 0,
        }],
        "validation_summary": {
            "blueprints_passed": 1,
            "handoff_check_resolutions": [{"check_id": check, "resolved": true, "pass_fail": "pass"}],
        },
    })).unwrap();
    write_json(&runner_dir.join("final-status.json"), &json!({
        "lane_id": runner, "status": "completed", "result_path": result_path,
    })).unwrap();

    assert_eq!(latest_executable_analyst_handoff_served(&paths, cycle).unwrap(), Some(true));
    assert_eq!(latest_measured_handoff_execution_id(&paths, cycle).unwrap().as_deref(), Some(execution_id));
    let mut actions = vec![];
    inject_latest_executable_analyst_handoff_action(&paths, cycle, &mut actions).unwrap();
    assert!(actions.iter().all(|action| action["preferred_role"] != "lab-runner"), "{actions:?}");
}

#[test]
fn latest_lab_runner_context_matches_equivalent_handoff_signature() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-equivalent-handoff-signature";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(&lanes_dir).unwrap();

    let analyst_dir = lane_root(&paths, cycle, "followup-analyst-latest");
    fs::create_dir_all(&analyst_dir).unwrap();
    let prior_handoff = analyst_dir.join("prior-handoff-validation-plan.json");
    let latest_handoff = analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &prior_handoff,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/dataset-a",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "same executable claim",
                "data_graph": {"edge_count": 18},
                "validation_scope_policy": {
                    "active": true,
                    "primary_programs": ["mitochondrial_oxidative", "interferon"],
                    "source_text_excerpt": "short analyst rewrite note"
                },
                "secondary_rival_programs": ["cd8_cytotoxic"]
            },
            "handoff_checks": [{
                "check_id": "check-a",
                "goal": "estimate the same effect",
                "dataset": "matrix",
                "validation_scope_policy": {
                    "active": true,
                    "primary_programs": ["mitochondrial_oxidative", "interferon"],
                    "source_text_excerpt": "short analyst rewrite note"
                },
                "data_graph": {"node_count": 54}
            }],
            "validation_code_blueprints": [{
                "check_id": "check-a",
                "model_family": "same-model",
                "outcome": "Cohort"
            }]
        }),
    )
    .unwrap();
    write_json(
        &latest_handoff,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": "/tmp/dataset-a",
            "column_mapping": {
                "outcome": "Cohort",
                "hypothesis_statement": "same executable claim",
                "data_graph": {"edge_count": 19},
                "validation_scope_policy": {
                    "active": true,
                    "primary_programs": ["mitochondrial_oxidative", "interferon"],
                    "source_text_excerpt": "longer lab-director instruction excerpt with the same executable plan"
                },
                "secondary_rival_programs": ["cd8_cytotoxic", "cd4_helper", "b_plasma"],
                "secondary_limitations": ["age_field_unavailable"]
            },
            "handoff_checks": [{
                "check_id": "check-a",
                "goal": "estimate the same effect",
                "dataset": "matrix",
                "validation_scope_policy": {
                    "active": true,
                    "primary_programs": ["mitochondrial_oxidative", "interferon"],
                    "source_text_excerpt": "longer lab-director instruction excerpt with the same executable plan"
                },
                "data_graph": {"node_count": 55}
            }],
            "validation_code_blueprints": [{
                "check_id": "check-a",
                "model_family": "same-model",
                "outcome": "Cohort"
            }]
        }),
    )
    .unwrap();

    let runner_dir = lane_root(&paths, cycle, "followup-runner-a");
    fs::create_dir_all(&runner_dir).unwrap();
    write_json(
        &runner_dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": "followup-runner-a",
            "role": "lab-runner",
            "runtime_class": "codex-agent",
            "mode": "run",
            "cwd": paths.project_root,
            "task_file": runner_dir.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-a",
            "role": "lab-runner",
            "planner_metadata": {
                "analyst_handoff_path": prior_handoff,
                "analysis_request": {"handoff_path": prior_handoff}
            }
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("final-status.json"),
        &json!({
            "lane_id": "followup-runner-a",
            "status": "completed",
            "result_path": runner_dir.join("result.json")
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("result.json"),
        &json!({
            "role_plan": {
                "planner_metadata": {
                    "analyst_handoff_path": prior_handoff
                }
            },
            "validation_summary": {
                "overall_status": "degraded",
                "checks_failed": 1,
                "blueprints_failed": 0,
                "failed_checks": ["directional_hypothesis_pattern_observed"]
            }
        }),
    )
    .unwrap();

    let latest_handoff_string = latest_handoff.to_string_lossy().to_string();
    let context = latest_lab_runner_context_for_handoff(&paths, cycle, &latest_handoff_string)
        .unwrap()
        .expect("equivalent handoff should resolve to prior runner context");
    assert_eq!(context["lane_id"], json!("followup-runner-a"));
    assert_eq!(context["semantic_handoff_match"], json!(true));
}
