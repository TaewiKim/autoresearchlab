fn build_paths(runtime_root: &Path) -> AppPaths {
    AppPaths {
        project_root: runtime_root.parent().unwrap_or(runtime_root).to_path_buf(),
        runtime_root: runtime_root.to_path_buf(),
        data_root: runtime_root.join("datasets"),
        stats_driver_script: PathBuf::from("/dev/null"),
        literature_driver_script: PathBuf::from("/dev/null"),
    }
}

fn write_stage_gate_lane(
    paths: &AppPaths,
    cycle: &str,
    lane_id: &str,
    role: &str,
    driver: &str,
    result_extra: Value,
) {
    let lane_dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    write_json(
        &lane_dir.join("run-state.json"),
        &json!({"lane_id": lane_id, "role": role, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &lane_dir.join("final-status.json"),
        &json!({"lane_id": lane_id, "status": "completed"}),
    )
    .unwrap();
    let mut result = json!({"lane_id": lane_id, "driver": driver, "status": "completed"});
    if let (Some(target), Some(extra)) = (result.as_object_mut(), result_extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    write_json(&lane_dir.join("result.json"), &result).unwrap();
}

fn write_stage_gate_kg(paths: &AppPaths, cycle: &str) {
    let state = state_root(paths);
    fs::create_dir_all(&state).unwrap();
    write_json(
        &state.join(format!("{cycle}-literature-graph.json")),
        &json!({
            "status": "ok",
            "nodes": [{"id": "paper:1", "type": "paper"}],
            "edges": [{"source": "paper:1", "target": "mechanism:1", "type": "supports"}]
        }),
    )
    .unwrap();
    write_json(
            &state.join(format!("{cycle}-data-graph.json")),
            &json!({
                "status": "ok",
                "nodes": [{"id": "dataset:TCGA-BRCA", "type": "dataset", "metadata": {"forbidden_reuse": false, "materialized": false}}],
                "edges": [{"source": "dataset:TCGA-BRCA", "target": "outcome:survival", "type": "candidate_validation_target"}]
            }),
        )
        .unwrap();
    write_json(
        &state.join(format!("{cycle}-trend-summary.json")),
        &json!({"status": "ok", "cluster_labels": ["pathway survival"]}),
    )
    .unwrap();
}

fn write_stage_gate_search_inputs(paths: &AppPaths, cycle: &str) {
    write_stage_gate_lane(
        paths,
        cycle,
        "scout-01",
        "scout",
        "literature-search-driver",
        json!({"paper_count": 2}),
    );
    write_stage_gate_lane(
        paths,
        cycle,
        "followup-scout-01",
        "scout",
        "data-scout-browser",
        json!({"candidate_count": 3, "fetched_bundle_count": 0}),
    );
}


fn write_lane(
    runtime_root: &Path,
    cycle_id: &str,
    lane_id: &str,
    final_status: Value,
    result: Value,
) {
    let lane_dir = runtime_root.join("lanes").join(cycle_id).join(lane_id);
    fs::create_dir_all(&lane_dir).expect("mkdir lane");
    write_json(&lane_dir.join("final-status.json"), &final_status).unwrap();
    write_json(&lane_dir.join("result.json"), &result).unwrap();
}

fn write_codex_contract(runtime_root: &Path, cycle_id: &str, lane_id: &str) {
    let lane_dir = runtime_root.join("lanes").join(cycle_id).join(lane_id);
    fs::create_dir_all(&lane_dir).expect("mkdir lane");
    write_json(
        &lane_dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "role": "lab-director",
            "runtime_class": "codex-agent",
            "mode": "run",
            "cwd": runtime_root,
            "task_file": lane_dir.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();
}


fn assert_labdirector_decision_forces_comparator_validation(requery_decision: &str, cycle: &str) {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Validate the GSE322943 B pivot."}),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-71");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-71",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "hypothesis-gate-labdirector-requery"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({"lane_id": "followup-lab-director-71", "status": "completed"}),
    )
    .unwrap();
    let selected_statement = "In GSE322943, antigen-presentation and interferon-response failure define immune evasion beyond the TRM/TLS baseline.";
    let stale_replacement_statement = "A deferred GSE280974 splicing fallback that was not selected.";
    let extracted_json = if requery_decision == "uphold" {
        json!({
            "requery_decision": requery_decision,
            "selected_hypothesis": {
                "statement": selected_statement,
                "why_selected": "upheld current lead"
            },
            "replacement_hypotheses": [{
                "statement": stale_replacement_statement,
                "why_selected": "not selected; contingency only"
            }],
            "validation_changes": [
                "reproduce the same-dataset TRM/TLS baseline",
                "define HLA/IFN exposures, outcomes, covariates, rival comparators, falsification checks, and transportability"
            ],
            "next_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "description": "Write comparator-aware validation spec."
            }]
        })
    } else {
        json!({
            "requery_decision": requery_decision,
            "replacement_hypotheses": [{
                "statement": selected_statement,
                "why_selected": "best materialized comparator-aware mechanism"
            }],
            "validation_changes": [
                "reproduce the same-dataset TRM/TLS baseline",
                "define HLA/IFN exposures, outcomes, covariates, rival comparators, falsification checks, and transportability"
            ],
            "next_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "description": "Write comparator-aware validation spec."
            }]
        })
    };
    write_json(
        &director_lane.join("result.json"),
        &json!({ "extracted_json": extracted_json }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let analyst = created
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("analyst")
                && item.get("source_brief_id").and_then(Value::as_str)
                    == Some("followup-lab-director-71")
        })
        .expect("LabDirector replacement must force an Analyst comparator validation lane");
    let role_plan = read_json(&PathBuf::from(
        analyst
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("labdirector_comparator_validation_followup")
    );
    let task_md = fs::read_to_string(
        lane_root(&paths, cycle, analyst["lane_id"].as_str().unwrap()).join("task.md"),
    )
    .unwrap();
    assert!(task_md.contains("TRM/TLS baseline"));
    assert!(
        role_plan["planner_metadata"]["analysis_request"]["required_outputs"]
            .as_array()
            .map(|items| items.len() >= 5)
            .unwrap_or(false)
    );
    assert!(
        role_plan["planner_metadata"]["analysis_request"]["forbidden_validation_modes"]
            .as_array()
            .map(|items| items.iter().any(|item| item
                .as_str()
                .unwrap_or("")
                .contains("topic-token/path-token validation")))
            .unwrap_or(false)
    );
    let assigned = role_plan["assigned_hypotheses"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        assigned
            .iter()
            .any(|item| item.as_str() == Some(selected_statement))
    );
    if requery_decision == "uphold" {
        assert!(
            assigned
                .iter()
                .all(|item| item.as_str() != Some(stale_replacement_statement)),
            "upheld LabDirector decisions must not assign deferred replacement candidates"
        );
    }
}
