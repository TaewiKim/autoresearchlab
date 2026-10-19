#[test]
fn cycle_fetched_data_bundles_returns_empty_when_no_index_file() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let bundles = cycle_fetched_data_bundles(&paths, "cycle-missing");
    assert!(
        bundles.is_empty(),
        "no data-bundles.json → empty list (not panic, not None)"
    );
}

#[test]
fn lab_runner_refresh_recovers_handoff_dataset_root_from_task_when_role_plan_missing() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-runner-handoff-recovery";
    let lane_id = "followup-runner-01";
    let selected_bundle = paths
        .runtime_root
        .join("datasets")
        .join(cycle)
        .join("gse289864");
    fs::create_dir_all(selected_bundle.join("csv")).unwrap();
    fs::write(
        selected_bundle.join("csv").join("gse289864-series-matrix.csv"),
        "gene,s1,s2\nA,1,2\n",
    )
    .unwrap();
    let competing_bundle = paths
        .runtime_root
        .join("datasets")
        .join(cycle)
        .join("gse318067");
    fs::create_dir_all(competing_bundle.join("csv")).unwrap();
    fs::write(competing_bundle.join("csv").join("a.csv"), "x\n1\n").unwrap();
    fs::write(competing_bundle.join("csv").join("b.csv"), "x\n2\n").unwrap();

    let handoff_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle)
        .join("followup-analyst-01");
    fs::create_dir_all(&handoff_dir).unwrap();
    let handoff_path = handoff_dir.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready_for_runner",
            "dataset_root": selected_bundle,
            "handoff_checks": [{
                "check_id": "gse289864-check",
                "dataset_path": selected_bundle.join("csv").join("gse289864-series-matrix.csv")
            }],
            "validation_code_blueprints": [{
                "check_id": "gse289864-check",
                "code": "print({})"
            }]
        }),
    )
    .unwrap();

    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    let task_file = lane_dir.join("task.md");
    fs::write(
        &task_file,
        format!(
            "# task\nexecute the latest executable analyst handoff artifact from {} with 1 validation checks\n",
            handoff_path.display()
        ),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "lab-runner".to_string(),
        runtime_class: "external-driver".to_string(),
        mode: "driver-exec".to_string(),
        cwd: paths.project_root.clone(),
        task_file,
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: Some(
            paths
                .runtime_root
                .join("artifacts")
                .join("stats")
                .join(cycle)
                .join(lane_id)
                .join("result.json"),
        ),
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();
    let role_plan = read_json(&lane_role_plan_path(&paths, cycle, lane_id)).unwrap();
    let selected_bundle_text = selected_bundle.to_string_lossy().to_string();
    let handoff_path_text = handoff_path.to_string_lossy().to_string();
    assert_eq!(
        role_plan.get("source_brief_id").and_then(Value::as_str),
        Some("analyst-handoff-artifact")
    );
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("methods_followup")
    );
    assert_eq!(
        role_plan.get("dataset_root").and_then(Value::as_str),
        Some(selected_bundle_text.as_str())
    );
    assert_eq!(
        role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("analysis_request"))
            .and_then(|item| item.get("handoff_path"))
            .and_then(Value::as_str),
        Some(handoff_path_text.as_str())
    );
}

#[test]
fn cycle_fetched_data_bundles_skips_non_fetched_status() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-mix";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-data-bundles.json")),
        &json!({
            "cycle_id": cycle,
            "bundles": [
                {
                    "bundle_path": tmp.path().join("a").to_string_lossy(),
                    "manifest_path": tmp.path().join("a/manifest.json").to_string_lossy(),
                    "status": "fetch_error",
                    "provider": "zenodo",
                    "csv_count": 0,
                },
                {
                    "bundle_path": tmp.path().join("b").to_string_lossy(),
                    "manifest_path": tmp.path().join("b/manifest.json").to_string_lossy(),
                    "status": "skipped_unsupported",
                    "provider": "figshare",
                    "csv_count": 0,
                }
            ],
        }),
    )
    .unwrap();
    let bundles = cycle_fetched_data_bundles(&paths, cycle);
    assert!(
        bundles.is_empty(),
        "bundles with non-fetched status must be filtered out"
    );
}

#[test]
fn cycle_fetched_data_bundles_enriches_with_manifest_columns() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-enrich";

    // Synthesise the per-bundle manifest the data-fetcher writes.
    let bundle_dir = tmp.path().join("zenodo-12345");
    fs::create_dir_all(&bundle_dir).unwrap();
    let manifest_path = bundle_dir.join("manifest.json");
    write_json(
        &manifest_path,
        &json!([
            {
                "name": "patients",
                "kind": "indicator",
                "csv_path": bundle_dir.join("csv/patients.csv").to_string_lossy(),
                "raw_path": bundle_dir.join("raw/patients.csv").to_string_lossy(),
                "row_count": 1234,
                "columns": ["patient_id", "ntprobnp", "readmit_30d"],
                "format_hint": "csv",
                "source_url": "https://zenodo.org/records/12345/files/patients.csv",
                "fetch_status": "fetched"
            },
            {
                "name": "broken_entry",
                "kind": "indicator",
                "csv_path": null,
                "fetch_status": "skipped_unsupported"
            }
        ]),
    )
    .unwrap();

    // Synthesise the cycle-level bundle index the scout writes.
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-data-bundles.json")),
        &json!({
            "cycle_id": cycle,
            "bundles": [
                {
                    "bundle_path": bundle_dir.to_string_lossy(),
                    "manifest_path": manifest_path.to_string_lossy(),
                    "provider": "zenodo",
                    "status": "fetched",
                    "csv_count": 1,
                    "downloaded_count": 1,
                    "candidate_doi": "10.5281/zenodo.12345",
                }
            ],
        }),
    )
    .unwrap();

    let bundles = cycle_fetched_data_bundles(&paths, cycle);
    assert_eq!(bundles.len(), 1, "one fetched bundle should be returned");
    let entry = &bundles[0];
    assert_eq!(entry["provider"].as_str(), Some("zenodo"));
    assert_eq!(
        entry["candidate_doi"].as_str(),
        Some("10.5281/zenodo.12345")
    );
    let csvs = entry["csvs"].as_array().expect("csvs is an array");
    assert_eq!(csvs.len(), 1, "skipped manifest entry must be filtered out");
    let csv = &csvs[0];
    assert_eq!(csv["name"].as_str(), Some("patients"));
    assert_eq!(csv["row_count"].as_i64(), Some(1234));
    let columns = csv["columns"].as_array().expect("columns is an array");
    let column_names: Vec<&str> = columns.iter().filter_map(|v| v.as_str()).collect();
    assert!(column_names.contains(&"ntprobnp"));
    assert!(column_names.contains(&"readmit_30d"));
}

#[test]
fn cycle_reference_resources_returns_open_github_resources() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-resources";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-reference-resources.json")),
        &json!({
            "cycle_id": cycle,
            "resources": [
                {
                    "title": "reference code",
                    "url": "https://github.com/example/gse282742",
                    "access_status": "open",
                    "accessions": [{"repository": "GitHub", "accession": "example/gse282742"}],
                    "reference_paper": {"doi": "10.1186/s13195-024-01651-0"}
                },
                {
                    "title": "closed supplement",
                    "url": "https://example.org/closed",
                    "access_status": "gated"
                }
            ]
        }),
    )
    .unwrap();
    let resources = cycle_reference_resources(&paths, cycle);
    assert_eq!(resources.len(), 1);
    assert_eq!(
        resources[0]["url"].as_str(),
        Some("https://github.com/example/gse282742")
    );
}

#[test]
fn cycle_reference_resources_falls_back_to_fetched_bundle_sources() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-bundle-resources";
    let state_dir = state_root(&paths);
    let bundle_dir = tmp.path().join("datasets/gse282742");
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&bundle_dir).unwrap();
    let manifest_path = bundle_dir.join("manifest.json");
    write_json(
            &manifest_path,
            &json!({"manifest": [{
                "name": "supplementary TPM matrix",
                "fetch_status": "fetched",
                "source_url": "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE282nnn/GSE282742/suppl/GSE282742_TPM.tsv.gz",
                "csv_path": bundle_dir.join("tpm.csv"),
                "row_count": 116,
                "columns": ["sample", "diagnosis", "sex"],
                "format_hint": "tsv"
            }]})
        )
        .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-data-bundles.json")),
        &json!({"cycle_id": cycle, "bundles": [{
            "provider": "GEO",
            "status": "fetched",
            "candidate_title": "GSE282742",
            "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
            "bundle_path": bundle_dir,
            "manifest_path": manifest_path,
            "csv_count": 1,
            "downloaded_count": 1
        }]}),
    )
    .unwrap();

    let resources = cycle_reference_resources(&paths, cycle);
    let urls: Vec<&str> = resources.iter().filter_map(|r| r["url"].as_str()).collect();
    assert!(urls.contains(&"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742"));
    assert!(urls.contains(
        &"https://ftp.ncbi.nlm.nih.gov/geo/series/GSE282nnn/GSE282742/suppl/GSE282742_TPM.tsv.gz"
    ));
    assert!(resources
        .iter()
        .any(|r| r["resource_type"].as_str() == Some("fetched_bundle_source_file")));
}

#[test]
fn refresh_role_plan_context_surfaces_reference_resources_to_analyst() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-refresh-resources";
    let state_dir = state_root(&paths);
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(lanes_dir.join("followup-analyst-01")).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-reference-resources.json")),
        &json!({
            "cycle_id": cycle,
            "resources": [{
                "title": "analysis repo",
                "url": "https://github.com/example/gse282742",
                "access_status": "open",
                "accessions": [{"repository": "GitHub", "accession": "example/gse282742"}],
                "downstream_usage_hint": "use code"
            }]
        }),
    )
    .unwrap();
    let role_plan_path = lanes_dir.join("followup-analyst-01/role-plan.json");
    write_json(
        &role_plan_path,
        &json!({"lane_id": "followup-analyst-01", "role": "analyst", "planner_metadata": {}}),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "followup-analyst-01".to_string(),
        role: "analyst".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["reference_resources"][0]["url"].as_str(),
        Some("https://github.com/example/gse282742")
    );
    assert!(role_plan["reference_resource_context"]["usage_rule"]
        .as_str()
        .unwrap()
        .contains("Actively use"));
}

#[test]
fn refresh_role_plan_context_promotes_impact_first_for_labdirector() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-refresh-impact-first";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(lanes_dir.join("followup-lab-director-01")).unwrap();
    let role_plan_path = lanes_dir.join("followup-lab-director-01/role-plan.json");
    write_json(
        &role_plan_path,
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "gate_restart_followup",
            "planner_metadata": {
                "review_action": {
                    "type": "gate_restart_followup",
                    "target_rubric": "scientific_value"
                }
            }
        }),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "followup-lab-director-01".to_string(),
        role: "lab-director".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["impact_first_hypothesis_mandate"]["active"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["impact_first_hypothesis_mandate"]["active"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["impact_first_hypothesis_mandate"]["active"]
            .as_bool(),
        Some(true)
    );
}

#[test]
fn refresh_role_plan_context_copies_gatekeeper_target_rubric_to_top_level() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-refresh-gatekeeper-target";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(lanes_dir.join("followup-gatekeeper-01")).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gatekeeper_pending_rubrics": ["technical_quality"],
            "recommended_followup_actions": [{
                "type": "independent_gate_review_followup",
                "preferred_role": "gatekeeper",
                "target_rubric": "technical_quality",
                "target_score": 95,
                "current_score": 72,
                "description": "review the current technical quality evidence"
            }]
        }),
    )
    .unwrap();
    let role_plan_path = lanes_dir.join("followup-gatekeeper-01/role-plan.json");
    write_json(
        &role_plan_path,
        &json!({
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "planner_metadata": {}
        }),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "followup-gatekeeper-01".to_string(),
        role: "gatekeeper".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(role_plan["target_rubric"], json!("technical_quality"));
    assert_eq!(
        role_plan["planner_metadata"]["target_rubric"],
        json!("technical_quality")
    );
}

#[test]
fn refresh_role_plan_context_does_not_retarget_an_open_gate_review() {
    // MEASURED ON cycle-a-20260919, 2026-10-01: old unopened review
    // lanes were all rewritten to the first currently pending rubric, leaving
    // 58 technical_quality reviews ready to run against the same evidence.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-preserve-gatekeeper-target";
    let lane_id = "followup-gatekeeper-100";
    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gatekeeper_pending_rubrics": ["technical_quality"],
            "recommended_followup_actions": [{
                "type": "independent_gate_review_followup",
                "target_rubric": "technical_quality",
                "description": "review current technical quality"
            }]
        }),
    )
    .unwrap();
    write_json(
        &lane_dir.join("role-plan.json"),
        &json!({
            "lane_id": lane_id,
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "target_rubric": "clarity",
            "planner_metadata": {"target_rubric": "clarity"}
        }),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "gatekeeper".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_dir.join("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let refreshed = read_json(&lane_dir.join("role-plan.json")).unwrap();
    assert_eq!(refreshed["target_rubric"], json!("clarity"));
    assert_eq!(
        refreshed["planner_metadata"]["target_rubric"],
        json!("clarity")
    );
}

#[test]
fn launch_refresh_rebinds_queued_gate_review_to_the_current_lead() {
    // MEASURED ON cycle-a-20260919, 2026-10-13: four queued
    // independent_gate_review_followup lanes retained hyp:16be076a3e7616ae
    // after the authoritative lead became hyp:a2ad7b8358742c8a. They all
    // completed, but the gate correctly superseded them and analysis could not
    // advance. A launch refresh must preserve the rubric while rebinding every
    // input that makes the resulting review publishable for the current lead.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-a-20260919";
    let lane_id = "followup-gatekeeper-567";
    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "generated_by": "followup-lab-director-796",
            "selected_hypothesis": {
                "statement": "five policies have different exact-support-distance slopes",
                "primary_family": "shared_success_distance_curve",
                "falsification_conditions": ["all simultaneous upper bounds are below 0.05"],
                "rival_mechanisms": ["oracle difficulty creates the apparent difference"]
            }
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gatekeeper_pending_rubrics": ["reproducibility"],
            "recommended_followup_actions": [{
                "type": "independent_gate_review_followup",
                "target_rubric": "reproducibility",
                "gate_review_lead_key": "hyp:a2ad7b8358742c8a",
                "description": "review reproducibility of the five-policy evidence",
                "candidate_hypotheses": [{
                    "statement": "five policies have different exact-support-distance slopes"
                }],
                "validation_results": {"validation_result_count": 6},
                "latest_validation_lane_id": "followup-analyst-751",
                "latest_validation_summary": {"passed_checks": 6}
            }]
        }),
    )
    .unwrap();
    let role_plan_path = lane_dir.join("role-plan.json");
    write_json(
        &role_plan_path,
        &json!({
            "lane_id": lane_id,
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "target_rubric": "reproducibility",
            "assigned_hypotheses": ["retired two-policy refinement claim"],
            "planner_metadata": {
                "target_rubric": "reproducibility",
                "gate_review_lead_key": "hyp:16be076a3e7616ae",
                "current_lead_under_review": {
                    "statement": "retired two-policy refinement claim",
                    "primary_family": "loss_family_by_refinement"
                },
                "validation_results": {"validation_result_count": 4},
                "latest_validation_lane_id": "followup-runner-232"
            }
        }),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "gatekeeper".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_dir.join("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let refreshed = read_json(&role_plan_path).unwrap();
    assert_eq!(refreshed["target_rubric"], json!("reproducibility"));
    assert_eq!(
        refreshed["planner_metadata"]["gate_review_lead_key"],
        json!("hyp:a2ad7b8358742c8a")
    );
    assert_eq!(
        refreshed["planner_metadata"]["current_lead_under_review"]["primary_family"],
        json!("shared_success_distance_curve")
    );
    assert_eq!(
        refreshed["assigned_hypotheses"],
        json!(["five policies have different exact-support-distance slopes"])
    );
    assert_eq!(
        refreshed["planner_metadata"]["latest_validation_lane_id"],
        json!("followup-analyst-751")
    );
    assert_eq!(
        refreshed["planner_metadata"]["review_action"]["gate_review_lead_key"],
        json!("hyp:a2ad7b8358742c8a")
    );
}

#[test]
fn refresh_role_plan_context_always_adds_analyst_open_source_agent_mandate() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-agent-mandate";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(lanes_dir.join("analyst-01")).unwrap();
    let plan_dir = plans_root(&paths);
    fs::create_dir_all(&plan_dir).unwrap();
    write_json(
        &plan_dir.join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Evaluate a public policy panel with tabular outcomes."}),
    )
    .unwrap();
    let role_plan_path = lanes_dir.join("analyst-01/role-plan.json");
    write_json(
        &role_plan_path,
        &json!({"lane_id": "analyst-01", "role": "analyst", "planner_metadata": {}}),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "analyst-01".to_string(),
        role: "analyst".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let role_plan = read_json(&role_plan_path).unwrap();
    // The mandate is ALWAYS attached -- that is what this test is named for, and
    // it is how an analyst knows the search exists at all.
    assert_eq!(
        role_plan["planner_metadata"]["open_source_analysis_agent_mandate"]["active"],
        json!(true)
    );
    // Whether discovery is REQUIRED is a separate claim, and it used to be
    // written as `true` whenever the mandate existed -- so a lane could be told
    // it was required while the mandate beside it said it was not. A tabular
    // policy panel states no scale and no runner has failed, so it is not
    // required, and the plan says which of the two reasons applies.
    assert_eq!(
        role_plan["planner_metadata"]["require_open_source_analysis_agent_discovery"],
        json!(false)
    );
    assert!(role_plan["planner_metadata"]["open_source_discovery_required_because"]
        .as_str()
        .unwrap()
        .contains("not required"));
    assert_eq!(
        role_plan["planner_metadata"]["open_source_analysis_agent_mandate"]["mandatory"],
        json!(false)
    );
}

#[test]
fn refresh_role_plan_context_marks_omics_agent_discovery_mandatory() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-omics-agent-mandate";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(lanes_dir.join("analyst-01")).unwrap();
    let plan_dir = plans_root(&paths);
    fs::create_dir_all(&plan_dir).unwrap();
    write_json(
        &plan_dir.join(format!("{cycle}-cycle-plan.json")),
        // Naming a modality is not stating a scale. The predicate behind
        // "mandatory" used to be a list of one field's assays and archives, so
        // "is this large enough that ad hoc code is the wrong answer" was being
        // answered by "is this biology" -- and the answer for every other field
        // was no, however large its data. It reads scale now, and the stronger
        // signal is the measured one: a candidate dataset's own column count.
        &json!({"objective": "Run a high-dimensional differential analysis at scale."}),
    )
    .unwrap();
    let role_plan_path = lanes_dir.join("analyst-01/role-plan.json");
    write_json(
        &role_plan_path,
        &json!({"lane_id": "analyst-01", "role": "analyst", "planner_metadata": {}}),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "analyst-01".to_string(),
        role: "analyst".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let role_plan = read_json(&role_plan_path).unwrap();
    let mandate = &role_plan["planner_metadata"]["open_source_analysis_agent_mandate"];
    assert_eq!(mandate["mandatory"], json!(true));
    assert!(mandate["tool_discovery_rule"]
        .as_str()
        .unwrap()
        .contains("mandatory"));
    let reasons: Vec<&str> = mandate["detection_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(reasons.contains(&"objective_indicates_large_scale_data"));
}

#[test]
fn runner_failure_recovery_analyst_receives_open_source_debug_context() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-runner-tool-recovery";
    let plan_dir = plans_root(&paths);
    let state_dir = state_root(&paths);
    let lane_id = "lab-runner-01";
    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&plan_dir).unwrap();
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&lane_dir).unwrap();

    write_json(
            &plan_dir.join(format!("{cycle}-cycle-plan.json")),
            &json!({"objective": "Run transcriptomics RNA-seq validation with a reusable open-source workflow."}),
        )
        .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "batch-corrected transcriptomic signatures predict response",
            "primary_family": "rna_seq_signature",
            "identification_strategy": {"design": "adjusted_association"}
        }),
    )
    .unwrap();

    let stderr_path = lane_dir.join("stderr.txt");
    fs::write(
        &stderr_path,
        "ModuleNotFoundError: No module named 'workflow_dependency'\n",
    )
    .unwrap();
    write_json(
        &lane_dir.join("run-state.json"),
        &json!({"lane_id": lane_id, "role": "lab-runner", "status": "done"}),
    )
    .unwrap();
    write_json(
        &lane_dir.join("final-status.json"),
        &json!({"lane_id": lane_id, "status": "failed"}),
    )
    .unwrap();
    write_json(
            &lane_dir.join("result.json"),
            &json!({
                "experiment_result": {
                    "reason": "external tool smoke test failed",
                    "returncode": 1,
                    "script_path": lane_dir.join("run-tool.sh"),
                    "stderr_path": stderr_path
                },
                "role_plan": {
                    "planner_metadata": {
                        "analyst_handoff_path": lane_dir.join("analyst-handoff.json"),
                        "analyst_handoff": {
                            "open_source_agent_discovery": {
                                "candidates": [{
                                    "name": "candidate workflow",
                                    "url": "https://github.com/example/workflow",
                                    "local_path": ".research-lab/tools/cycle-runner-tool-recovery/workflow",
                                    "application_command": "python app.py --config config.yaml",
                                    "debug_attempts": []
                                }]
                            },
                            "selected_open_source_analysis_agent": {
                                "name": "candidate workflow",
                                "url": "https://github.com/example/workflow",
                                "local_path": ".research-lab/tools/cycle-runner-tool-recovery/workflow",
                                "application_command": "python app.py --config config.yaml",
                                "reason": "matched the RNA-seq workflow"
                            }
                        }
                    }
                }
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let analyst = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("analyst"))
        .expect("runner failure should queue analyst recovery");
    let role_plan_path = PathBuf::from(
        analyst
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["action_type"].as_str(),
        Some("runner_failure_recovery_followup")
    );
    // Discovery is required here because a RUNNER FAILED on the tool, which
    // implicates it whatever the data's scale -- and the plan says which of the
    // two reasons applies. The flag used to be set whenever a mandate merely
    // existed, so a lane could be told discovery was required while the mandate
    // beside it said it was not.
    assert_eq!(
        role_plan["planner_metadata"]["require_open_source_analysis_agent_discovery"],
        json!(true)
    );
    assert!(role_plan["planner_metadata"]["open_source_discovery_required_because"]
        .as_str()
        .unwrap()
        .contains("a lab-runner failed"));
    // The mandate keys on the DATA, and this objective states a modality rather
    // than a scale, so it does not fire. The two are separate claims now.
    assert_eq!(
        role_plan["planner_metadata"]["open_source_analysis_agent_mandate"]["mandatory"],
        json!(false)
    );
    assert!(
        role_plan["planner_metadata"]["failed_runner_context"]["stderr_excerpt"]
            .as_str()
            .unwrap()
            .contains("workflow_dependency")
    );
    assert_eq!(
        role_plan["planner_metadata"]["runner_failure_debug_contract"]
            ["must_record_debug_attempts"],
        json!(true)
    );
    assert!(
        role_plan["planner_metadata"]["failed_runner_context"]["analyst_handoff"]
            ["selected_open_source_analysis_agent"]["application_command"]
            .as_str()
            .unwrap()
            .contains("config.yaml")
    );

    let recovery_lane_id = analyst.get("lane_id").and_then(Value::as_str).unwrap();
    let task_md =
        fs::read_to_string(lane_root(&paths, cycle, recovery_lane_id).join("task.md")).unwrap();
    assert!(task_md.contains("open_source_analysis_agent_discovery"));
    assert!(task_md.contains("failed_runner_context"));
}

#[test]
fn latest_lab_runner_context_filters_by_role_plan_handoff_before_reading_result() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-role-plan-handoff-prefilter";
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(&lanes_dir).unwrap();

    let analyst_dir = lane_root(&paths, cycle, "followup-analyst-latest");
    fs::create_dir_all(&analyst_dir).unwrap();
    let latest_handoff = analyst_dir.join("handoff-validation-plan.json");
    let stale_handoff = analyst_dir.join("stale-handoff-validation-plan.json");
    write_json(
        &latest_handoff,
        &json!({"status": "ready", "handoff_checks": [{"check_id": "latest", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]}),
    )
    .unwrap();
    write_json(
        &stale_handoff,
        &json!({"status": "ready", "handoff_checks": [{"check_id": "stale", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]}),
    )
    .unwrap();

    let good_runner_dir = lane_root(&paths, cycle, "followup-runner-a");
    fs::create_dir_all(&good_runner_dir).unwrap();
    write_json(
        &good_runner_dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": "followup-runner-a",
            "role": "lab-runner",
            "runtime_class": "codex-agent",
            "mode": "run",
            "cwd": paths.project_root,
            "task_file": good_runner_dir.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();
    write_json(
        &good_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-a",
            "role": "lab-runner",
            "planner_metadata": {
                "analyst_handoff_path": latest_handoff,
                "analysis_request": {"handoff_path": latest_handoff}
            }
        }),
    )
    .unwrap();
    write_json(
        &good_runner_dir.join("final-status.json"),
        &json!({
            "lane_id": "followup-runner-a",
            "status": "completed",
            "result_path": good_runner_dir.join("result.json")
        }),
    )
    .unwrap();
    write_json(
        &good_runner_dir.join("result.json"),
        &json!({
            "role_plan": {
                "planner_metadata": {
                    "analyst_handoff_path": latest_handoff
                }
            },
            "validation_summary": {
                "overall_status": "pass",
                "checks_failed": 0,
                "blueprints_failed": 0
            }
        }),
    )
    .unwrap();

    let stale_runner_dir = lane_root(&paths, cycle, "followup-runner-z");
    fs::create_dir_all(&stale_runner_dir).unwrap();
    write_json(
        &stale_runner_dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": "followup-runner-z",
            "role": "lab-runner",
            "runtime_class": "codex-agent",
            "mode": "run",
            "cwd": paths.project_root,
            "task_file": stale_runner_dir.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();
    write_json(
        &stale_runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-z",
            "role": "lab-runner",
            "planner_metadata": {
                "analyst_handoff_path": stale_handoff,
                "analysis_request": {"handoff_path": stale_handoff}
            }
        }),
    )
    .unwrap();
    write_json(
        &stale_runner_dir.join("final-status.json"),
        &json!({
            "lane_id": "followup-runner-z",
            "status": "completed",
            "result_path": stale_runner_dir.join("result.json")
        }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(
        stale_runner_dir.join("result.json"),
        format!(
            "{{\"mentions_latest_handoff_but_is_invalid_json\":\"{}\"",
            latest_handoff.display()
        ),
    )
    .unwrap();

    let latest_handoff_string = latest_handoff.to_string_lossy().to_string();
    let context = latest_lab_runner_context_for_handoff(&paths, cycle, &latest_handoff_string)
        .unwrap()
        .expect("latest handoff should resolve to the matching runner");
    assert_eq!(context["lane_id"], json!("followup-runner-a"));
}


// cycle-b-20260918, 2026-09-18: the owner assigned simulation orchestration
// to the LabDirector. Once an engineer has written an order's episodes.csv and
// manifest.json, the analyst sees it as one more candidate bundle -- columns from
// the CSV header, row_count from the file -- and picks it on the unchanged path.
#[test]
fn an_analyst_sees_a_fulfilled_simulation_order_as_a_candidate_bundle() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-sim-bundle";
    let lane_id = "followup-analyst-01";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let contract = |role: &str, lane: &str| LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane.to_string(),
        role: role.to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_root(&paths, cycle, lane).join("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    let candidates = |role: &str, lane: &str| {
        fs::create_dir_all(lane_root(&paths, cycle, lane)).unwrap();
        refresh_role_plan_context_before_launch(&paths, cycle, &contract(role, lane)).unwrap();
        let role_plan = read_json(&lane_role_plan_path(&paths, cycle, lane)).unwrap();
        role_plan["planner_metadata"]["candidate_datasets"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };

    // A cycle without orders is unaffected.
    assert!(candidates("analyst", lane_id).is_empty());

    record_lab_director_simulation_orders(
        &paths,
        cycle,
        "followup-lab-director-01",
        &json!({"simulation_orders": [{
            "request_id": "grasp_sweep",
            "simulator_backend": "mujoco",
            "output_path": format!(".research-lab/datasets/{cycle}/simulations/grasp_sweep/episodes.csv"),
        }]}),
    )
    .unwrap();
    // Ordered but not yet written: nothing to pick.
    assert!(candidates("analyst", lane_id).is_empty());

    let out = paths
        .runtime_root
        .join("datasets")
        .join(cycle)
        .join("simulations")
        .join("grasp_sweep");
    fs::create_dir_all(&out).unwrap();
    fs::write(
        out.join("episodes.csv"),
        "friction,seed,episode,lift_success\n0.4,1,0,1\n0.4,1,1,0\n0.8,1,0,1\n",
    )
    .unwrap();
    fs::write(out.join("manifest.json"), "{\"request_id\": \"grasp_sweep\"}").unwrap();

    let bundles = candidates("analyst", lane_id);
    assert_eq!(bundles.len(), 1, "{bundles:?}");
    let bundle = &bundles[0];
    assert_eq!(bundle["provider"], "simulation");
    assert_eq!(bundle["request_id"], "grasp_sweep");
    assert_eq!(bundle["bundle_path"], json!(out.display().to_string()));
    assert_eq!(bundle["manifest_path"], json!(out.join("manifest.json").display().to_string()));
    let csv = &bundle["csvs"][0];
    assert_eq!(csv["name"], "episodes.csv");
    assert_eq!(csv["csv_path"], json!(out.join("episodes.csv").display().to_string()));
    assert_eq!(csv["row_count"], 3);
    assert_eq!(csv["columns"], json!(["friction", "seed", "episode", "lift_success"]));
    assert_eq!(csv["format_hint"], "csv");

    // Only the analyst analyses it.
    assert!(candidates("lab-runner", "followup-lab-runner-01").is_empty());
}
