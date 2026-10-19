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
