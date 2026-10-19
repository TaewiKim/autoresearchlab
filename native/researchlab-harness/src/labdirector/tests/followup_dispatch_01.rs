#[test]
fn dispatch_promotes_repeated_scout_discovery_to_materialization_fetch() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-scout-materialization-promotion";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run KG-first omics research with materialized validation data."}),
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
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "hypothesis_gate_passed": true,
            "gate_passed": false,
            "recommended_followup_actions": [{
                "type": "data_acquisition_followup",
                "preferred_role": "scout",
                "target_rubric": "dataset_support",
                "priority": "high",
                "priority_score": 180,
                "description": "Find additional open omics datasets for validation."
            }]
        }),
    )
    .unwrap();
    for index in 1..=3 {
        let lane_id = format!("followup-scout-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
        write_json(
            &lane_dir.join("result.json"),
            &json!({
                "status": "completed",
                "driver": "data-scout-browser",
                "candidate_count": 12,
                "open_candidate_count": 12,
                "candidates_with_accession": 12,
                "fetched_bundle_count": 0,
                "candidates": [{
                    "title": "GEO candidate",
                    "url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE322943",
                    "accessions": [{"repository": "GEO", "accession": "GSE322943"}]
                }]
            }),
        )
        .unwrap();
    }

    let created = dispatch_followup_lanes(&paths, cycle, 2).unwrap();
    let scout = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("scout"))
        .expect("repeated accession-only scouts should queue a scout materialization pass");
    let role_plan_path =
        PathBuf::from(scout.get("role_plan_path").and_then(Value::as_str).unwrap());
    let role_plan = read_json(&role_plan_path).unwrap();
    let metadata = &role_plan["planner_metadata"];
    assert_eq!(
        metadata["target_rubric"].as_str(),
        Some("validation_materialization_gate")
    );
    assert_eq!(metadata["fetch_policy"].as_str(), Some("fetch"));
    assert_eq!(
        metadata["source_discovery_mode"].as_str(),
        Some("validation-materialization-fetch")
    );
    assert_eq!(
        metadata["materialization_recovery"]["reason"].as_str(),
        Some("scout_discovery_without_materialization_stagnation")
    );
}

#[test]
fn dispatch_does_not_duplicate_open_runner_for_same_analyst_handoff() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-open-runner-handoff-dedupe";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run one executable Analyst handoff exactly once."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 spatial transcriptomics should be tested once.",
            "geo_accessions": ["GSE228779"],
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse228779"}
            }
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({"gate_passed": false, "recommended_followup_actions": []}),
    )
    .unwrap();
    let lane_statuses = (1..=40)
        .map(|index| {
            json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"lane_statuses": lane_statuses}),
    )
    .unwrap();

    let artifacts_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle)
        .join("followup-analyst-999");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let handoff_path = artifacts_dir.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready",
            "summary": "Validate GSE228779 spatial transcriptomics once.",
            "handoff_checks": [{"check_id": "gse228779_spatial_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{
                "blueprint_id": "gse228779-spatial",
                "code": "print('validate once')"
            }]
        }),
    )
    .unwrap();

    let open_runner_dir = lane_root(&paths, cycle, "followup-runner-041");
    fs::create_dir_all(&open_runner_dir).unwrap();
    write_json(
        &open_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-041",
            "role": "lab-runner",
            "source_brief_id": "analyst-handoff",
            "action_type": "methods_followup",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": handoff_path.display().to_string()
                }
            }
        }),
    )
    .unwrap();
    write_json(
        &open_runner_dir.join("run-state.json"),
        &json!({"lane_id": "followup-runner-041", "role": "lab-runner", "status": "running"}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-runner")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("analyst-handoff")
        }),
        "an open lab-runner already owns this Analyst handoff, even when the cached lane state is stale"
    );
}

#[test]
fn gate_blocking_methods_repair_does_not_fallback_to_lab_runner_when_analyst_budget_is_full() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-blocking-analyst-repair";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Repair the GSE318067 omics workflow handoff before rerunning validation."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE318067 serum proteomics inflammatory module severity gradient.",
            "geo_accessions": ["GSE318067"],
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse318067"}
            }
        }),
    )
    .unwrap();
    for index in 1..=40 {
        let lane_id = format!("followup-analyst-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
    }
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "lane_statuses": (1..=40).map(|index| json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })).collect::<Vec<_>>()
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "recommended_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "target_rubric": "reproducibility",
                "priority": "high",
                "description": "Repair the GSE318067 repository-native workflow handoff or write a concrete waiver before LabRunner repeats validation.",
                "blocker_reasons": [
                    "mandatory omics/high-dimensional analysis only completed repository inventory/CSV profiling",
                    "repository-native workflow/skill/domain command must produce hypothesis-relevant output artifacts"
                ],
                "open_source_agent_requirement": {
                    "repository_agent_required": true,
                    "substantive_repository_workflow_applied": false,
                    "repository_workflow_exhausted": true,
                    "repository_workflow_repetition": {
                        "repeated_count": 3,
                        "lane_ids": ["followup-runner-168", "followup-runner-176", "followup-runner-180"]
                    }
                },
                "failed_runner_context": {
                    "lane_id": "followup-runner-180",
                    "repository_workflow_exhausted": true,
                    "workflow_blockers": [
                        "no CSV matched a repository-native differential feature workflow input contract"
                    ],
                    "recovery_instruction": "Analyst must not issue another handoff that reuses this workflow unchanged."
                },
                "repository_workflow_exhausted": true,
                "repository_workflow_repetition": {
                    "repeated_count": 3,
                    "lane_ids": ["followup-runner-168", "followup-runner-176", "followup-runner-180"]
                },
                "expected_artifacts": [
                    "repository_workflow_compatibility_decision.json"
                ]
            }]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        created
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("analyst")),
        "gate-blocking repository workflow repair must create an Analyst handoff lane even after the normal Analyst budget is exhausted"
    );
    assert!(
        !created
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner")),
        "the dispatcher must not reroute an Analyst repair blocker into another LabRunner timeout"
    );
    let analyst = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("analyst"))
        .unwrap();
    let role_plan = read_json(&PathBuf::from(
        analyst
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("methods_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["gate_blocking_analyst_repair"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["effective_role"].as_str(),
        Some("analyst")
    );
    assert_eq!(
        role_plan["planner_metadata"]["failed_runner_context"]["lane_id"].as_str(),
        Some("followup-runner-180")
    );
    assert_eq!(
        role_plan["planner_metadata"]["failed_runner_context"]["repository_workflow_exhausted"]
            .as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["open_source_agent_requirement"]
            ["repository_workflow_repetition"]["repeated_count"]
            .as_i64(),
        Some(3)
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["expected_artifacts"][0].as_str(),
        Some("repository_workflow_compatibility_decision.json")
    );
}

#[test]
fn analyst_methods_repair_does_not_fallback_to_runner_when_budget_is_full() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-analyst-methods-no-runner-fallback";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Repair the GSE318067 technical-quality methods handoff."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE318067 serum proteomics inflammatory module severity gradient.",
            "geo_accessions": ["GSE318067"],
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse318067"}
            }
        }),
    )
    .unwrap();
    for index in 1..=40 {
        let lane_id = format!("followup-analyst-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
    }
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "recommended_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "target_rubric": "technical_quality",
                "priority": "high",
                "description": "For GSE318067, repair the technical-quality methods handoff before any LabRunner rerun."
            }]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        created
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("analyst")),
        "Analyst methods repair should stay Analyst even when the normal Analyst budget is full"
    );
    assert!(
        !created
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner")),
        "Analyst methods repair must not become a LabRunner lane without a direct executable handoff"
    );
    let analyst = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("analyst"))
        .unwrap();
    let role_plan = read_json(&PathBuf::from(
        analyst
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analyst_repair_stays_analyst"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["effective_role"].as_str(),
        Some("analyst")
    );
}

#[test]
fn latest_handoff_action_replaces_stale_direct_handoff_action() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-replace-stale-handoff-action";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();

    let old_analyst_lane = "followup-analyst-01";
    let old_analyst_dir = lane_root(&paths, cycle, old_analyst_lane);
    fs::create_dir_all(&old_analyst_dir).unwrap();
    let old_handoff_path = old_analyst_dir.join("handoff-validation-plan.json");
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

    let new_analyst_lane = "followup-analyst-02";
    let new_analyst_dir = lane_root(&paths, cycle, new_analyst_lane);
    fs::create_dir_all(&new_analyst_dir).unwrap();
    let new_handoff_path = new_analyst_dir.join("handoff-validation-plan.json");
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
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "lane_statuses": [
                {"lane_id": old_analyst_lane, "role": "analyst", "status": "completed"},
                {"lane_id": new_analyst_lane, "role": "analyst", "status": "completed"}
            ]
        }),
    )
    .unwrap();

    let mut ranked_actions = vec![json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "analysis_request": {
            "source": "latest-executable-analyst-handoff",
            "handoff_path": old_handoff_path.display().to_string()
        }
    })];
    inject_latest_executable_analyst_handoff_action(&paths, cycle, &mut ranked_actions).unwrap();

    assert_eq!(ranked_actions.len(), 1);
    assert_eq!(
        direct_handoff_action_path(&ranked_actions[0]).map(normalized_path_key),
        Some(normalized_path_key(&new_handoff_path.display().to_string()))
    );
}

#[test]
fn dispatch_falls_back_to_newer_handoff_artifact_when_notes_point_to_consumed_handoff() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-newer-artifact-handoff-after-stale-notes";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run the newest executable Analyst handoff artifact."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 spatial transcriptomics has a testable immune state.",
            "dataset_or_accession": "GSE228779",
            "validation_data_status": "materialized",
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse228779"}
            }
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({"hypothesis_gate_passed": true, "gate_passed": true}),
    )
    .unwrap();

    let old_artifacts_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle)
        .join("followup-analyst-001");
    fs::create_dir_all(&old_artifacts_dir).unwrap();
    let old_handoff_path = old_artifacts_dir.join("handoff-validation-plan.json");
    write_json(
        &old_handoff_path,
        &json!({
            "status": "ready",
            "summary": "Old GSE228779 handoff already consumed by a runner.",
            "handoff_checks": [{"check_id": "old_gse228779_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "old", "code": "print('old')"}]
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-analyst-research-notes.json")),
        &json!({
            "latest_analyst_memo": {
                "lane_id": "followup-analyst-001",
                "handoff_path": old_handoff_path.display().to_string(),
                "updated_at": "2026-05-17T00:00:00Z"
            }
        }),
    )
    .unwrap();

    let old_runner_lane = "followup-runner-001";
    let old_runner_dir = lane_root(&paths, cycle, old_runner_lane);
    create_lane_contract(
        &paths,
        cycle,
        old_runner_lane,
        "lab-runner",
        "external-driver",
        "driver-exec",
        "old consumed runner",
    )
    .unwrap();
    write_json(
        &old_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": old_runner_lane,
            "role": "lab-runner",
            "source_brief_id": "analyst-handoff",
            "action_type": "methods_followup",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": old_handoff_path.display().to_string()
                }
            }
        }),
    )
    .unwrap();
    write_json(
        &old_runner_dir.join("run-state.json"),
        &json!({"lane_id": old_runner_lane, "role": "lab-runner", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &old_runner_dir.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": {
                "source_brief_id": "analyst-handoff",
                "action_type": "methods_followup",
                "planner_metadata": {
                    "analysis_request": {
                        "handoff_path": old_handoff_path.display().to_string()
                    }
                }
            },
            "validation_summary": {
                "overall_status": "supported",
                "checks_failed": 0,
                "blueprints_failed": 0
            }
        }),
    )
    .unwrap();
    write_json(
        &old_runner_dir.join("final-status.json"),
        &json!({
            "lane_id": old_runner_lane,
            "status": "completed",
            "result_path": old_runner_dir.join("result.json")
        }),
    )
    .unwrap();

    let new_artifacts_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle)
        .join("followup-analyst-999");
    fs::create_dir_all(&new_artifacts_dir).unwrap();
    let new_handoff_path = new_artifacts_dir.join("handoff-validation-plan.json");
    write_json(
        &new_handoff_path,
        &json!({
            "status": "ready_for_runner",
            "summary": "Newer GSE228779 handoff must not be hidden by stale Analyst notes.",
            "handoff_checks": [{"check_id": "new_gse228779_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "new", "code": "print('new')"}]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let runner = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("newer executable handoff artifact should dispatch a lab-runner");
    assert_eq!(
        runner.get("source_brief_id").and_then(Value::as_str),
        Some("analyst-handoff-artifact")
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
        json!(new_handoff_path.display().to_string())
    );
}

#[test]
fn dispatch_treats_open_recovery_runner_as_owning_source_handoff() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-open-recovery-runner-handoff-dedupe";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run one executable Analyst handoff exactly once."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 spatial transcriptomics should be tested once.",
            "geo_accessions": ["GSE228779"],
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/gse228779"}
            }
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({"gate_passed": false, "recommended_followup_actions": []}),
    )
    .unwrap();

    let artifacts_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle)
        .join("followup-analyst-999");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let handoff_path = artifacts_dir.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready",
            "summary": "Validate GSE228779 spatial transcriptomics once.",
            "handoff_checks": [{"check_id": "gse228779_spatial_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{
                "blueprint_id": "gse228779-spatial",
                "code": "print('validate once')"
            }]
        }),
    )
    .unwrap();

    let source_runner_dir = lane_root(&paths, cycle, "followup-runner-041");
    fs::create_dir_all(&source_runner_dir).unwrap();
    write_json(
        &source_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-041",
            "role": "lab-runner",
            "source_brief_id": "analyst-handoff",
            "action_type": "methods_followup",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": handoff_path.display().to_string()
                }
            }
        }),
    )
    .unwrap();
    write_json(
        &source_runner_dir.join("final-status.json"),
        &json!({"lane_id": "followup-runner-041", "status": "aborted"}),
    )
    .unwrap();

    let recovery_dir = lane_root(&paths, cycle, "followup-runner-041-recovery-01");
    fs::create_dir_all(&recovery_dir).unwrap();
    write_json(
        &recovery_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-041-recovery-01",
            "role": "lab-runner",
            "source_brief_id": "followup-runner-041",
            "action_type": "recovery_followup"
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-runner")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("analyst-handoff")
        }),
        "an open recovery lab-runner inherits ownership of the source runner's Analyst handoff"
    );
}

#[test]
fn running_lane_count_finalizes_filesystem_only_orphans_when_large_state_cache_is_stale() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-cache-fs-orphan";
    let lane_statuses = (1..=40)
        .map(|index| {
            json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"lane_statuses": lane_statuses}),
    )
    .unwrap();

    let orphan_dir = lane_root(&paths, cycle, "followup-runner-041");
    fs::create_dir_all(&orphan_dir).unwrap();
    write_json(
        &orphan_dir.join("run-state.json"),
        &json!({
            "lane_id": "followup-runner-041",
            "role": "lab-runner",
            "status": "running",
            "started_at": "2020-01-01T00:00:00Z"
        }),
    )
    .unwrap();

    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 0);
    let final_status = read_json(&orphan_dir.join("final-status.json")).unwrap();
    assert_eq!(final_status["status"], json!("aborted"));
    assert_eq!(
        final_status["reason"],
        json!("orphaned running lane detected during status reconciliation")
    );
}

#[test]
fn running_lane_count_updates_sqlite_queue_when_finalizing_orphan() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-cache-sqlite-orphan";
    let lane_id = "followup-runner-041";
    let mut lane_statuses = (1..=40)
        .map(|index| {
            json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    lane_statuses.push(json!({
        "lane_id": lane_id,
        "role": "lab-runner",
        "status": "running"
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"lane_statuses": lane_statuses}),
    )
    .unwrap();

    let orphan_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&orphan_dir).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        lane_id,
        "lab-runner",
        "external-driver",
        "driver-exec",
        "orphan runner fixture",
    )
    .unwrap();
    write_json(
        &orphan_dir.join("run-state.json"),
        &json!({
            "lane_id": lane_id,
            "role": "lab-runner",
            "status": "running",
            "started_at": "2020-01-01T00:00:00Z"
        }),
    )
    .unwrap();
    let db_path = paths.runtime_root.join("queues").join("pipeline.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "UPDATE pipeline_queue SET status = 'running' WHERE cycle_id = ?1 AND lane_id = ?2",
        rusqlite::params![cycle, lane_id],
    )
    .unwrap();

    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 0);

    let status: String = conn
        .query_row(
            "SELECT status FROM pipeline_queue WHERE cycle_id = ?1 AND lane_id = ?2",
            rusqlite::params![cycle, lane_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "aborted");
}

#[test]
fn running_lane_count_keeps_recent_filesystem_only_running_lane_when_cache_is_stale() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-cache-fs-recent-running";
    let lane_statuses = (1..=40)
        .map(|index| {
            json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"lane_statuses": lane_statuses}),
    )
    .unwrap();

    let running_dir = lane_root(&paths, cycle, "followup-runner-041");
    fs::create_dir_all(&running_dir).unwrap();
    write_json(
        &running_dir.join("run-state.json"),
        &json!({
            "lane_id": "followup-runner-041",
            "role": "lab-runner",
            "status": "running",
            "started_at": chrono::Utc::now().to_rfc3339()
        }),
    )
    .unwrap();

    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 1);
    assert!(
        !running_dir.join("final-status.json").exists(),
        "recent filesystem-only running lanes should not be false-aborted"
    );
}

#[test]
fn running_lane_count_uses_recent_disk_state_when_cached_running_lane_lacks_timestamp() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-large-cache-running-no-timestamp";
    let mut lane_statuses = (1..=40)
        .map(|index| {
            json!({
                "lane_id": format!("followup-analyst-{index:03}"),
                "role": "analyst",
                "status": "completed"
            })
        })
        .collect::<Vec<_>>();
    lane_statuses.push(json!({
        "lane_id": "followup-runner-041",
        "role": "lab-runner",
        "status": "running"
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"lane_statuses": lane_statuses}),
    )
    .unwrap();

    let running_dir = lane_root(&paths, cycle, "followup-runner-041");
    fs::create_dir_all(&running_dir).unwrap();
    write_json(
        &running_dir.join("run-state.json"),
        &json!({
            "lane_id": "followup-runner-041",
            "role": "lab-runner",
            "status": "running",
            "started_at": chrono::Utc::now().to_rfc3339()
        }),
    )
    .unwrap();

    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 1);
    assert!(
        !running_dir.join("final-status.json").exists(),
        "recent disk run-state should protect cached running lanes that lack timestamps"
    );
}

#[test]
fn pending_review_result_with_a_live_worker_still_occupies_a_worker_slot() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-pending-review-live-worker";
    let lane_id = "scout-02";
    create_lane_contract(
        &paths,
        cycle,
        lane_id,
        "scout",
        "codex-agent",
        "read-write-scoped",
        "incremental literature Scout fixture",
    )
    .unwrap();
    let lane_dir = lane_root(&paths, cycle, lane_id);
    write_json(
        &lane_dir.join("result.json"),
        &json!({"status": "pending_review", "papers": []}),
    )
    .unwrap();
    write_json(
        &lane_dir.join("run-state.json"),
        &json!({
            "lane_id": lane_id,
            "role": "scout",
            "status": "running",
            "updated_at": Utc::now().to_rfc3339(),
        }),
    )
    .unwrap();
    write_json(
        &lane_process_path(&paths, cycle, lane_id),
        &json!({"pid": std::process::id(), "stage": "launcher_spawned"}),
    )
    .unwrap();

    assert!(!lane_has_finalized_outputs(&paths, cycle, lane_id));
    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 1);
}

#[test]
fn spawn_metadata_reserves_a_max_one_slot_before_run_state_and_dead_pid_does_not() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-spawn-reservation";
    let lane_id = "scout-03";
    create_lane_contract(
        &paths,
        cycle,
        lane_id,
        "scout",
        "codex-agent",
        "read-write-scoped",
        "launcher reservation fixture",
    )
    .unwrap();
    // This is the synchronous state after launch_lane_background returns and
    // before its child writes run-state.json.
    write_json(
        &lane_process_path(&paths, cycle, lane_id),
        &json!({"pid": std::process::id(), "stage": "launcher_spawned"}),
    )
    .unwrap();

    let max_concurrency = 1usize;
    let active = running_lane_count(&paths, cycle).unwrap();
    assert_eq!(active, 1);
    assert_eq!(max_concurrency.saturating_sub(active), 0);

    write_json(
        &lane_process_path(&paths, cycle, lane_id),
        &json!({"pid": 0, "stage": "launcher_spawned"}),
    )
    .unwrap();
    assert_eq!(running_lane_count(&paths, cycle).unwrap(), 0);
}
