#[test]
fn is_gatekeeper_blocker_not_affected_by_engine_helper() {
    // Sanity — make sure we imported symbols cleanly and the module
    // tests compile. This serves as a breadcrumb for the runtime
    // module's is_gatekeeper_empty_output tests (defined separately).
    let _ = env::current_dir();
}

#[test]
fn author_and_illustrator_wait_for_hypothesis_gate_before_document_stage() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-doc-blocked-before-hypothesis-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({ "conclusion_gate_passed": true }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({ "gate_passed": false }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "antigen-presentation interferon-response failure is testable",
            "primary_family": "antigen_presentation_interferon_failure"
        }),
    )
    .unwrap();

    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "author-01".to_string(),
        role: "author".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert_eq!(
        blocker.as_deref(),
        Some("waiting-for-hypothesis-gate gate_passed=false")
    );

    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({ "gate_passed": true }),
    )
    .unwrap();
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert_eq!(
        blocker.as_deref(),
        Some("waiting-for-core-experiments lab_runner_completed=0")
    );
}

#[test]
fn external_validation_actions_outrank_stale_novelty_when_required_for_gate() {
    let novelty = json!({
        "type": "hypothesis_regeneration_followup",
        "priority": "high",
        "target_rubric": "novelty",
    });
    let external = json!({
        "type": "external_validation_followup",
        "priority": "medium",
        "target_rubric": "external_validity",
    });
    let handoff = json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "priority": "high",
        "target_rubric": "technical_quality",
    });
    assert!(
        followup_action_sort_key(&external, true, false)
            < followup_action_sort_key(&novelty, true, false)
    );
    assert!(
        followup_action_sort_key(&handoff, true, false)
            < followup_action_sort_key(&external, true, false)
    );
    assert!(
        followup_action_sort_key(&novelty, false, false)
            < followup_action_sort_key(&external, false, false)
    );
    assert!(
        followup_action_sort_key(&handoff, false, false)
            < followup_action_sort_key(&external, false, false)
    );
}

#[test]
fn repository_workflow_gate_recovery_outranks_director_and_novelty_loops() {
    let recovery = json!({
        "type": "methods_followup",
        "priority": "high",
        "preferred_role": "analyst",
        "target_rubric": "reproducibility",
        "blocker_reasons": [
            "mandatory omics/high-dimensional analysis only completed repository inventory/CSV profiling; it must run a repository-native workflow/skill/domain command and produce hypothesis-relevant output artifacts before the hypothesis gate can pass"
        ],
        "open_source_agent_requirement": {
            "repository_agent_required": true,
            "substantive_repository_workflow_applied": false
        }
    });
    let director_requery = json!({
        "type": "lab_director_requery_followup",
        "priority": "high",
        "preferred_role": "lab-director",
        "target_rubric": "gate_independence",
        "description": "Ask LabDirector to rethink the current gate rejection."
    });
    let novelty = json!({
        "type": "novelty_followup",
        "priority": "high",
        "preferred_role": "scout",
        "target_rubric": "novelty",
        "description": "Search for another rival family."
    });
    let pending_recovery = json!({
        "role": "analyst",
        "action_type": "methods_followup",
        "planner_metadata": {
            "target_rubric": "reproducibility",
            "review_action": recovery
        }
    });
    let pending_novelty = json!({
        "role": "scout",
        "action_type": "novelty_followup",
        "target_rubric": "novelty"
    });

    assert!(
        followup_action_sort_key(&pending_recovery["planner_metadata"]["review_action"], false, false)
            < followup_action_sort_key(&director_requery, false, false)
    );
    assert!(
        followup_action_sort_key(&pending_recovery["planner_metadata"]["review_action"], false, false)
            < followup_action_sort_key(&novelty, false, false)
    );
    assert_eq!(
        pending_lane_action_priority(Some(&pending_recovery), false),
        0
    );
    assert!(
        pending_lane_action_priority(Some(&pending_recovery), false)
            < pending_lane_action_priority(Some(&pending_novelty), false)
    );
}

#[test]
fn gate_review_repository_workflow_blocker_becomes_critical_execution_recovery() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-repository-workflow-recovery";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "recommended_actions": [{
                "type": "methods_followup",
                "priority": "high",
                "preferred_role": "analyst",
                "target_rubric": "reproducibility",
                "description": "route repository-workflow incompatibility back to Analyst for handoff repair before LabRunner repeats validation",
                "blocker_reasons": [
                    "mandatory omics/high-dimensional analysis only completed repository inventory/CSV profiling; it must run a repository-native workflow/skill/domain command and produce hypothesis-relevant output artifacts before the hypothesis gate can pass"
                ],
                "open_source_agent_requirement": {
                    "repository_agent_required": true,
                    "substantive_repository_workflow_applied": false
                }
            }]
        }),
    )
    .unwrap();

    let mut actions = Vec::new();
    collect_gate_review_actions(&paths, cycle, &mut actions).unwrap();
    let action = actions
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("methods_followup"))
        .expect("repository-workflow blocker should be collected as a gate action");

    assert_eq!(
        action.get("brief_id").and_then(Value::as_str),
        Some("gate-review-reproducibility-execution-recovery")
    );
    assert_eq!(action.get("priority").and_then(Value::as_str), Some("critical"));
    assert_eq!(action.get("priority_score").and_then(Value::as_i64), Some(320));
    assert_eq!(
        action
            .get("gate_blocking_recovery")
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn pending_external_validation_lane_outranks_data_acquisition_when_required() {
    let external = json!({
        "role": "scout",
        "action_type": "external_validation_followup",
        "target_rubric": "external_validity",
    });
    let data = json!({
        "role": "scout",
        "action_type": "data_acquisition_followup",
    });

    assert!(
        pending_lane_action_priority(Some(&external), true)
            < pending_lane_action_priority(Some(&data), true)
    );
    assert_eq!(pending_lane_action_priority(Some(&data), false), 6);
}

#[test]
fn pending_gate_independence_lanes_outrank_document_and_data_backlog() {
    let director = json!({
        "role": "lab-director",
        "action_type": "lab_director_requery_followup",
        "planner_metadata": { "target_rubric": "gate_independence" },
    });
    let methods = json!({
        "role": "lab-runner",
        "action_type": "methods_followup",
        "target_rubric": "gate_independence",
    });
    let novelty = json!({
        "role": "scout",
        "action_type": "novelty_followup",
        "target_rubric": "gate_independence",
    });
    let author = json!({
        "role": "author",
        "action_type": "report_high_impact_followup",
        "target_rubric": "report_artifact_presence",
    });
    let data = json!({
        "role": "scout",
        "action_type": "data_acquisition_followup",
    });

    assert_eq!(pending_lane_action_priority(Some(&director), false), 0);
    assert_eq!(pending_lane_action_priority(Some(&methods), false), 1);
    assert_eq!(pending_lane_action_priority(Some(&novelty), false), 2);
    assert!(
        pending_lane_action_priority(Some(&methods), false)
            < pending_lane_action_priority(Some(&author), false)
    );
    assert!(
        pending_lane_action_priority(Some(&novelty), false)
            < pending_lane_action_priority(Some(&data), false)
    );
}

#[test]
fn external_validation_dispatch_bypasses_exhausted_scout_budget() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-external-validation-budget";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Keep final gate-critical external validation moving."}),
    )
    .unwrap();
    for index in 1..=160 {
        let lane_id = format!("followup-scout-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "scout",
                "action_type": "data_acquisition_followup"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "completed"
            }),
        )
        .unwrap();
    }
    write_json(
            &brief_dir.join("external-validation.json"),
            &json!({
                "brief_id": "external-validation",
                "recommended_actions": [{
                    "type": "external_validation_followup",
                    "preferred_role": "scout",
                    "priority": "high",
                    "target_rubric": "external_validity",
                    "description": "Run a targeted external validity check against an independent public cohort."
                }]
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let scout = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("scout"))
        .expect("external validation should bypass stale scout followup budget");
    let role_plan_path =
        PathBuf::from(scout.get("role_plan_path").and_then(Value::as_str).unwrap());
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("external_validation_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["target_rubric"],
        json!("external_validity")
    );
}

#[test]
fn external_validation_gate_pre_dispatch_reads_gate_review_directly() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-external-gate-direct";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Dispatch final gate external validation directly."}),
    )
    .unwrap();
    for index in 1..=180 {
        let lane_id = format!("followup-scout-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "scout",
                "action_type": "data_acquisition_followup"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "completed"
            }),
        )
        .unwrap();
    }
    write_json(
            &state_dir.join(format!("{cycle}-gate-review.json")),
            &json!({
                "external_validation_review": {
                    "required_for_gate": true,
                    "validation_plan": {"principle": "independent or stricter validation before gate closure"},
                    "recommended_actions": [{
                        "type": "external_validation_followup",
                        "preferred_role": "scout",
                        "priority": "high",
                        "target_rubric": "external_validity",
                        "description": "materialize an independent public validation dataset or write a failed-attempt artifact"
                    }, {
                        "type": "external_validation_analysis_followup",
                        "preferred_role": "analyst",
                        "priority": "high",
                        "target_rubric": "external_validity",
                        "description": "turn the external search space into an executable sensitivity-analysis decision tree"
                    }]
                }
            }),
        )
        .unwrap();

    let created = dispatch_external_validation_gate_lanes(&paths, cycle, 4).unwrap();
    assert_eq!(created.len(), 2);
    let action_types = created
        .iter()
        .map(|item| {
            let role_plan_path =
                PathBuf::from(item.get("role_plan_path").and_then(Value::as_str).unwrap());
            read_json(&role_plan_path).unwrap()["action_type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert!(action_types.contains(&"external_validation_followup".to_string()));
    assert!(action_types.contains(&"external_validation_analysis_followup".to_string()));
}

#[test]
fn recovery_dispatch_bypasses_stale_global_followup_cap() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-global-cap-recovery";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Keep gate-critical GSE228779 validation and hypothesis search moving despite stale history."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 GeoMx spatial transcriptomics liver injury validation is the current lead.",
            "geo_accession": "GSE228779",
            "validation_data_status": "materialized",
            "identification_strategy": {
                "materialized_dataset": {"accession": "GSE228779", "bundle_path": "/tmp/gse228779"}
            }
        }),
    )
    .unwrap();
    for index in 1..=1030 {
        let lane_id = format!("followup-author-{index:04}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "author",
                "action_type": "report_high_impact_followup"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
    }
    write_json(
        &brief_dir.join("gate-critical-recovery.json"),
        &json!({
            "brief_id": "gate-critical-recovery",
            "recommended_actions": [{
                "type": "labdirector_comparator_validation_followup",
                "preferred_role": "analyst",
                "priority": "high",
                "priority_score": 250,
                "target_rubric": "technical_quality",
                "description": "Build the current-lead GSE228779 comparator-aware Analyst validation handoff."
            }, {
                "type": "hypothesis_regeneration_followup",
                "preferred_role": "scout",
                "priority": "high",
                "priority_score": 240,
                "target_rubric": "hypothesis_gate",
                "description": "Generate fresh GSE228779 mechanism-level hypothesis families in parallel with validation planning."
            }, {
                "type": "novelty_followup",
                "preferred_role": "scout",
                "priority": "high",
                "priority_score": 230,
                "target_rubric": "novelty",
                "description": "Challenge the current lead with higher-impact rival mechanism families from graph weak spots."
            }]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let action_types = created
        .iter()
        .map(|item| {
            let role_plan_path =
                PathBuf::from(item.get("role_plan_path").and_then(Value::as_str).unwrap());
            read_json(&role_plan_path).unwrap()["action_type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert!(
        action_types.contains(&"labdirector_comparator_validation_followup".to_string()),
        "current-lead Analyst validation recovery should bypass stale global followup cap"
    );
    assert!(
        action_types.contains(&"hypothesis_regeneration_followup".to_string()),
        "hypothesis regeneration should continue despite stale global followup cap"
    );
    assert!(
        action_types.contains(&"novelty_followup".to_string()),
        "novelty followup should continue despite stale global followup cap"
    );
    let novelty_scout = created.iter().find(|item| {
        let role_plan = read_json(&PathBuf::from(item["role_plan_path"].as_str().unwrap())).unwrap();
        role_plan["role"] == "scout" && role_plan["action_type"] == "novelty_followup"
    }).expect("novelty dispatch must include its literature scout");
    let scout_contract = read_json(&PathBuf::from(novelty_scout["contract_path"].as_str().unwrap())).unwrap();
    let scout_plan = read_json(&PathBuf::from(novelty_scout["role_plan_path"].as_str().unwrap())).unwrap();
    assert_eq!(scout_contract["runtime_class"], "codex-agent", "abstract reviews need a reasoning Scout");
    assert_eq!(scout_contract["mode"], "read-write-scoped");
    assert_ne!(scout_plan["assigned_model"], "python-external-driver");
}

// 2026-10-03: the cycle's one follow-up budget (budget_caps::total_followup_cap)
// is spent by 4096 lanes, and nothing bypasses it -- a gate-independence
// recovery included. It used to: the global cap had its own exemptions.
#[test]
fn a_spent_followup_budget_stops_even_a_gate_independence_recovery() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-independence-global-cap";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Close the final hypothesis gate without spawning generic backlog."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "score": 73,
            "recommended_actions": [{
                "type": "gate_restart_followup",
                "preferred_role": "lab-director",
                "priority": "high",
                "target_rubric": "gate_independence",
                "gate_closure_goal": "resolve current independent gate rejection",
                "description": "Revise the current hypothesis against the gatekeeper's independent rejection."
            }]
        }),
    )
    .unwrap();
    let deliberation_dir = lane_root(&paths, cycle, "followup-chronicle-001");
    fs::create_dir_all(&deliberation_dir).unwrap();
    write_json(
        &deliberation_dir.join("role-plan.json"),
        &json!({
            "lane_id": "followup-chronicle-001",
            "role": "chronicle",
            "action_type": "chronicle_gate_deliberation_followup"
        }),
    )
    .unwrap();
    write_json(
        &deliberation_dir.join("final-status.json"),
        &json!({"lane_id": "followup-chronicle-001", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &deliberation_dir.join("result.json"),
        &json!({"summary": "Chronicle adjudicated the gate rejection and cleared LabDirector to restart."}),
    )
    .unwrap();
    for index in 1..=4096 {
        let lane_id = format!("followup-author-{index:04}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "author",
                "action_type": "report_high_impact_followup"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
    }

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(created.is_empty(), "a lane was created past the spent budget: {created:?}");}

#[test]
fn completed_recovery_counts_as_original_novelty_followup_source() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-recovery-counts-original-source";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Keep novelty recovery from repeating after an orphaned lane is recovered."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "score": 16,
            "blockers": ["Novelty: alternative hypothesis families are still too limited"],
            "recommended_actions": [{
                "type": "novelty_followup",
                "preferred_role": "scout",
                "priority": "high",
                "target_rubric": "novelty",
                "description": "Challenge the incumbent with rival mechanism families from graph weak spots."
            }]
        }),
    )
    .unwrap();
    write_json(
        &brief_dir.join("gate-review.json"),
        &json!({
            "brief_id": "gate-review",
            "recommended_actions": [{
                "type": "novelty_followup",
                "preferred_role": "scout",
                "priority": "high",
                "target_rubric": "novelty",
                "description": "Challenge the incumbent with rival mechanism families from graph weak spots."
            }]
        }),
    )
    .unwrap();

    let original_lane = "followup-scout-001";
    let original_dir = lane_root(&paths, cycle, original_lane);
    fs::create_dir_all(&original_dir).unwrap();
    write_json(
        &original_dir.join("role-plan.json"),
        &json!({
            "lane_id": original_lane,
            "role": "scout",
            "action_type": "novelty_followup",
            "source_brief_id": "gate-review"
        }),
    )
    .unwrap();
    write_json(
        &original_dir.join("final-status.json"),
        &json!({"lane_id": original_lane, "status": "aborted"}),
    )
    .unwrap();

    let recovery_lane = "followup-scout-001-recovery-01";
    let recovery_dir = lane_root(&paths, cycle, recovery_lane);
    fs::create_dir_all(&recovery_dir).unwrap();
    write_json(
        &recovery_dir.join("role-plan.json"),
        &json!({
            "lane_id": recovery_lane,
            "role": "scout",
            "action_type": "recovery_followup",
            "source_brief_id": original_lane,
            "planner_metadata": {"original_lane_id": original_lane}
        }),
    )
    .unwrap();
    write_json(
        &recovery_dir.join("final-status.json"),
        &json!({"lane_id": recovery_lane, "status": "completed"}),
    )
    .unwrap();

    let completed_source_keys = completed_followup_action_source_keys(&paths, cycle).unwrap();
    assert!(
        completed_source_keys.contains("scout::novelty_followup::gate-review"),
        "completed recovery should satisfy the original scout novelty action source"
    );
}

#[test]
fn next_followup_lane_id_does_not_reuse_filesystem_lane_dirs() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-filesystem-lane-id";
    fs::create_dir_all(lane_root(&paths, cycle, "followup-scout-642")).unwrap();

    let lane_id = next_followup_lane_id(&paths, cycle, "followup-scout-").unwrap();
    assert_eq!(lane_id, "followup-scout-643");
}

#[test]
fn refreshed_conclusion_strategy_requery_dispatches_after_prior_labdirector_requery() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-refreshed-conclusion-requery";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Continue until conclusion blockers are resolved."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE228779 spatial liver injury program remains the active lead.",
            "primary_family": "classified_spatial_liver_injury_compartment_program",
            "family_root": "classified_spatial_liver_injury_compartment_program"
        }),
    )
    .unwrap();

    let completed_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&completed_lane).unwrap();
    write_json(
        &completed_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "conclusion-review",
            "planner_metadata": {"target_rubric": "hypothesis_strategy"}
        }),
    )
    .unwrap();
    write_json(
        &completed_lane.join("final-status.json"),
        &json!({"lane_id": "followup-lab-director-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &completed_lane.join("result.json"),
        &json!({
            "status": "completed",
            "requery_decision": "replace",
            "selected_hypothesis": {"statement": "old conclusion strategy"}
        }),
    )
    .unwrap();

    std::thread::sleep(std::time::Duration::from_millis(1100));
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({
            "conclusion_gate_passed": false,
            "recommended_followup_actions": [{
                "type": "lab_director_requery_followup",
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "description": "do not stop at a weak conclusion: review blockers and assign the next validation lanes"
            }]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("conclusion-review")
        }),
        "refreshed conclusion review should dispatch a new LabDirector strategy requery, created={created:?}"
    );
}

#[test]
fn gate_independence_methods_bypass_exhausted_analyst_budget() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-independence-analyst-budget";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Dispatch gate-independence corrective methods work."}),
    )
    .unwrap();
    for index in 1..=64 {
        let lane_id = format!("followup-analyst-{index:03}");
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "analyst",
                "action_type": "novelty_followup"
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({
                "lane_id": lane_id,
                "status": "completed"
            }),
        )
        .unwrap();
    }
    write_json(
            &brief_dir.join("gate-independence.json"),
            &json!({
                "brief_id": "gate-independence",
                "recommended_actions": [{
                    "type": "methods_followup",
                    "preferred_role": "analyst",
                    "priority": "high",
                    "target_rubric": "gate_independence",
                    "description": "execute the exact claim-faithful DESeq2 pathway deconvolution and 8-gene benchmark plan"
                }]
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let analyst = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("analyst"))
        .expect("gate-independence methods work should bypass stale analyst budget");
    let role_plan_path = PathBuf::from(
        analyst
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("methods_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["target_rubric"],
        json!("gate_independence")
    );
}

#[test]
fn gate_restart_preferred_labdirector_dispatches_labdirector_lane() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-restart-labdirector";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Restart around one defensible gate-independent family."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A same-dataset reproducibility audit can falsify the incumbent claim.",
            "primary_family": "reproducibility_audit",
            "identification_strategy": {"design": "subject-grouped validation"}
        }),
    )
    .unwrap();
    write_json(
            &brief_dir.join("gate-review.json"),
            &json!({
                "brief_id": "gate-review",
                "recommended_actions": [{
                    "type": "gate_restart_followup",
                    "preferred_role": "lab-director",
                    "priority": "high",
                    "target_rubric": "gate_independence",
                    "description": "Restart around one promotable family and prune literature-only claims."
                }]
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let labdirector = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-director"))
        .expect("gate restart preferred for LabDirector should dispatch a LabDirector lane");
    let role_plan_path = PathBuf::from(
        labdirector
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("gate_restart_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["restart_mode"],
        json!("lab-director-gate-restart")
    );
    assert_eq!(
        role_plan["planner_metadata"]["target_rubric"],
        json!("gate_independence")
    );
}

