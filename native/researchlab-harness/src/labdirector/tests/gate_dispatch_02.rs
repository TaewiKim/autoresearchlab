fn assert_director_requested_gatekeeper_action_routes(action_type: &str) {
    // MEASURED ON cycle-a-20260919, 2026-09-30: at
    // reproduction_anchor the director requested a gatekeeper novelty or gate-
    // restart review eight times, but the specialized fan-outs consumed the
    // action and dispatched no gatekeeper. Lead protection therefore had no
    // adjudication that could release the executable replacement lead.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = format!("cycle-gatekeeper-{}-routing", action_type.replace('_', "-"));
    let brief_dir = chronicle_briefs_root(&paths, &cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();
    write_stage_gate_search_inputs(&paths, &cycle);
    write_stage_gate_kg(&paths, &cycle);
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Test a procedural robotics lead."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "Randomized support identity yields equivalent architecture-specific decay slopes.",
            "validation_data_status": "needs_materialization",
            "lab_director_stage_gate_override": {
                "stage": "hypothesis_generation",
                "approved": true,
                "rationale": "The selected procedural lead needs independent novelty adjudication before execution."
            }
        }),
    )
    .unwrap();
    let director_lane = lane_root(&paths, &cycle, "followup-lab-director-01");
    fs::create_dir_all(&director_lane).unwrap();
    create_lane_contract(
        &paths,
        &cycle,
        "followup-lab-director-01",
        "lab-director",
        "codex-agent",
        "read-write-scoped",
        "Choose the next action for the protected lead.",
    )
    .unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "supervisor-latency"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({"lane_id": "followup-lab-director-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &director_lane.join("result.json"),
        &json!({
            "status": "completed",
            "extracted_json": {"next_actions": [{
                "type": action_type,
                "preferred_role": "gatekeeper",
                "priority": "critical",
                "target_rubric": "novelty",
                "description": "Independently adjudicate the randomized-support procedure before simulation."
            }]}
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, &cycle, 8).unwrap();
    let adjudication = created
        .iter()
        .find(|lane| lane["role"] == json!("gatekeeper"))
        .unwrap_or_else(|| {
            panic!("the blocking adjudication must open a gatekeeper lane: {created:?}")
        });
    let role_plan = read_json(Path::new(
        adjudication["role_plan_path"].as_str().unwrap(),
    ))
    .unwrap();
    assert_eq!(role_plan["action_type"], json!(action_type));
    assert_eq!(
        role_plan["planner_metadata"]["preferred_role"],
        json!("gatekeeper")
    );
}

#[test]
fn director_requested_novelty_adjudication_reaches_a_gatekeeper() {
    assert_director_requested_gatekeeper_action_routes("novelty_followup");
}

#[test]
fn director_requested_gate_restart_adjudication_reaches_a_gatekeeper() {
    assert_director_requested_gatekeeper_action_routes("gate_restart_followup");
}

#[test]
fn completed_hypothesis_strategy_gate_restart_does_not_spawn_labdirector_loop() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-restart-no-self-loop";
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Continue after LabDirector selected the GSE228779 lead."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE228779 IFN antigen-presentation portal chemokine injury is testable.",
            "primary_family": "gse228779_spatial_liver_injury"
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
                "target_rubric": "hypothesis_strategy",
                "description": "Propagate the GSE322943 quarantine and keep GSE228779 as lead."
            }]
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
            "action_type": "gate_restart_followup",
            "source_brief_id": "gate-review"
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
        &json!({"status": "completed", "extracted_json": {"selected_hypothesis": {"statement": "GSE228779 lead"}}}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str) == Some("gate-review")
        }),
        "completed hypothesis-strategy gate restart should not spawn another LabDirector self-loop"
    );
}

#[test]
fn low_scientific_gate_review_counts_as_hypothesis_gate_failure() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-low-scientific-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "mode": "defer",
            "gate_passed": false,
            "score": 18,
            "gate_scientific_blockers": ["same-dataset baseline missing"],
            "recommended_actions": [{
                "type": "gate_restart_followup",
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "description": "rerank three mechanism-level families before more validation"
            }]
        }),
    )
    .unwrap();

    assert!(explicit_hypothesis_gate_failed(&paths, cycle).unwrap());
}

#[test]
fn explicit_gate_reject_controls_recovery_even_when_kg_artifact_is_stale() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-reject-over-stale-kg";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "latent immune state beats pooled averages",
            "primary_family": "classified_tumor_microenvironment",
            "identification_strategy": {"materialized_dataset": {"accession": "GSE322943"}}
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "mode": "defer",
            "gate_passed": false,
            "score": 18,
            "gatekeeper_pending_rubrics": ["impact"],
            "gate_scientific_blockers": ["same-dataset comparator and family rerank missing"],
            "recommended_followup_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "description": "do not run before LabDirector reranks"
            }, {
                "type": "gate_restart_followup",
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "description": "rerank three mechanism-level families"
            }]
        }),
    )
    .unwrap();

    let mut actions = vec![json!({
        "type": "methods_followup",
        "preferred_role": "analyst",
        "priority_score": 300,
        "description": "stale validation patch"
    }), json!({
        "brief_id": "gate-review",
        "type": "independent_gate_review_followup",
        "preferred_role": "gatekeeper",
        "target_rubric": "novelty",
        "priority_score": 145,
        "description": "focused novelty gatekeeper review for the current lead"
    }), json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "priority_score": 285,
        "description": "execute the latest executable analyst handoff from handoff-validation-plan.json"
    })];
    let gate_state =
        enforce_stage_gate_recovery_actions(&paths, cycle, &mut actions, "omics").unwrap();

    let hypothesis_gate = gate_state["gates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|gate| gate.get("stage").and_then(Value::as_str) == Some("hypothesis_generation"))
        .unwrap();
    assert_eq!(
        hypothesis_gate["explicit_hypothesis_gate_failed"],
        json!(true)
    );
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("gate_restart_followup")
            && action
                .get("requires_completed_chronicle_gate_deliberation")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }));
    assert!(actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("hypothesis-gate-literature-restart")
    }));
    assert!(!actions.iter().any(|action| {
        action.get("description").and_then(Value::as_str) == Some("stale validation patch")
    }));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("independent_gate_review_followup")
            && action.get("target_rubric").and_then(Value::as_str) == Some("novelty")
    }));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("independent_gate_review_followup")
            && action.get("target_rubric").and_then(Value::as_str) == Some("impact")
            && action.get("recovery_reason").and_then(Value::as_str)
                == Some("gatekeeper_pending_rubric_review_required")
    }));
    assert!(actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff")
            && action.get("type").and_then(Value::as_str) == Some("methods_followup")
    }));
}

#[test]
fn dispatch_reads_gate_review_independent_rubric_actions() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-review-action-dispatch";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Dispatch fresh gatekeeper rubric reviews."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE228779 VILI liver-cell oxidative stress and interferon decoupling is current.",
            "dataset_or_accession": "GSE228779",
            "validation_data_status": "materialized",
            "identification_strategy": {"materialized_dataset": {"accession": "GSE228779"}},
            "primary_family": "classified_spatial_liver_injury_interferon_decoupling",
            "family_root": "classified_spatial_liver_injury_interferon_decoupling"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "score": 63,
            "gatekeeper_review_status": "superseded",
            "latest_validation_lane_id": "followup-runner-694",
            "gatekeeper_pending_rubrics": ["novelty"],
            "recommended_actions": [{
                "type": "independent_gate_review_followup",
                "priority": "high",
                "preferred_role": "gatekeeper",
                "target_rubric": "novelty",
                "target_score": 95,
                "current_score": 86,
                "description": "focused novelty gatekeeper review for the current lead",
                "validation_results": {
                    "validation_results": [{
                        "lane_id": "followup-runner-694",
                        "verdict": "passed",
                        "summary": "overall_status=passed; checks=17/17"
                    }]
                }
            }],
            "recommended_followup_actions": [{
                "type": "independent_gate_review_followup",
                "priority": "high",
                "preferred_role": "gatekeeper",
                "target_rubric": "novelty",
                "target_score": 95,
                "current_score": 86,
                "description": "duplicate focused novelty gatekeeper review for the current lead",
                "validation_results": {
                    "validation_results": [{
                        "lane_id": "followup-runner-694",
                        "verdict": "passed",
                        "summary": "overall_status=passed; checks=17/17"
                    }]
                }
            }]
        }),
    )
    .unwrap();

    let plan_path = rewrite_task_graph(&paths, cycle).unwrap();
    let plan = read_json(&plan_path).unwrap();
    let action = plan["priority_actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| {
            action.get("type").and_then(Value::as_str)
                == Some("independent_gate_review_followup")
                && action.get("target_rubric").and_then(Value::as_str) == Some("novelty")
        })
        .unwrap_or_else(|| {
            panic!(
                "task graph should include novelty gatekeeper action; actions={}",
                serde_json::to_string_pretty(&plan["priority_actions"]).unwrap()
            )
        });
    assert_eq!(
        action["validation_results"]["validation_results"][0]["lane_id"],
        json!("followup-runner-694")
    );
    assert_eq!(
        action.get("brief_id").and_then(Value::as_str),
        Some("gate-review-novelty")
    );
    let novelty_actions = plan["priority_actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|action| {
            action.get("type").and_then(Value::as_str)
                == Some("independent_gate_review_followup")
                && action.get("target_rubric").and_then(Value::as_str) == Some("novelty")
        })
        .count();
    assert_eq!(novelty_actions, 1);
}

#[test]
fn gate_reject_labdirector_waits_for_chronicle_deliberation() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-reject-ordering";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Gate reject must run Chronicle before LabDirector."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "latent immune state beats pooled averages",
            "primary_family": "classified_tumor_microenvironment",
            "identification_strategy": {"materialized_dataset": {"accession": "GSE322943"}}
        }),
    )
    .unwrap();
    write_json(
            &state_root(&paths).join(format!("{cycle}-gate-review.json")),
            &json!({
                "verdict": "reject",
                "gate_passed": false,
                "score": 18,
                "major_objections": ["LabDirector must read Chronicle deliberation before selecting replacement family"]
            }),
        )
        .unwrap();

    let first_created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(first_created.iter().any(|item| {
        item.get("role").and_then(Value::as_str) == Some("chronicle")
            && item.get("source_brief_id").and_then(Value::as_str)
                == Some("hypothesis-gate-chronicle-deliberation")
    }));
    assert!(
        !first_created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-labdirector-requery")
        }),
        "LabDirector gate restart must not dispatch before Chronicle gate deliberation completes"
    );

    let chronicle_lane = lane_root(&paths, cycle, "followup-chronicle-completed");
    fs::create_dir_all(&chronicle_lane).unwrap();
    write_json(
        &chronicle_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-chronicle-completed",
            "role": "chronicle",
            "action_type": "chronicle_gate_deliberation_followup",
            "source_brief_id": "hypothesis-gate-chronicle-deliberation"
        }),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("final-status.json"),
        &json!({"lane_id": "followup-chronicle-completed", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "gatekeeper_critique_reconstruction": "Reject upheld.",
                "three_family_debate_table": [
                    {"family": "antigen_presentation_interferon_failure"},
                    {"family": "myeloid_stromal_barrier"},
                    {"family": "latent_immune_state_incumbent"}
                ],
                "recommended_decision_options_for_lab_director": ["replace incumbent"]
            }
        }),
    )
    .unwrap();

    let second_created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let director = second_created
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str)
                    == Some("hypothesis-gate-labdirector-requery")
        })
        .expect("LabDirector should dispatch only after completed Chronicle gate deliberation");
    let role_plan = read_json(&PathBuf::from(
        director
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("gate_restart_followup")
    );
    assert!(
        role_plan["planner_metadata"]["chronicle_gate_deliberation_context"]
            .get("result_path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("followup-chronicle-completed")
    );
}

#[test]
fn gate_reject_analyst_handoff_runs_before_labdirector_gate_review() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-reject-handoff-review";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Gate reject Analyst handoff must be reviewed before LabRunner."}),
    )
    .unwrap();
    write_json(
            &state_root(&paths).join(format!("{cycle}-gate-review.json")),
            &json!({
                "verdict": "reject",
                "gate_passed": false,
                "score": 18,
                "major_objections": ["Analyst plan must be scientifically reviewed before runner execution"]
            }),
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

    let chronicle_lane = lane_root(&paths, cycle, "followup-chronicle-completed");
    fs::create_dir_all(&chronicle_lane).unwrap();
    write_json(
        &chronicle_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-chronicle-completed",
            "role": "chronicle",
            "action_type": "chronicle_gate_deliberation_followup",
            "source_brief_id": "hypothesis-gate-chronicle-deliberation"
        }),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("final-status.json"),
        &json!({"lane_id": "followup-chronicle-completed", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("result.json"),
        &json!({"extracted_json": {"recommended_decision_options_for_lab_director": ["replace"]}}),
    )
    .unwrap();

    let analyst_lane = lane_root(&paths, cycle, "followup-analyst-01");
    fs::create_dir_all(&analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-analyst-01",
        "analyst",
        "external-driver",
        "driver-exec",
        "analyst handoff fixture",
    )
    .unwrap();
    write_json(
        &analyst_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-analyst-01",
            "role": "analyst",
            "action_type": "gate_restart_followup"
        }),
    )
    .unwrap();
    write_json(
        &analyst_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-01", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-01", "status": "completed"}),
    )
    .unwrap();
    let handoff_path = analyst_lane.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready",
            "candidate_primary_families": [
                {"family": "antigen_presentation_interferon_failure"},
                {"family": "myeloid_stromal_barrier"},
                {"family": "stress_response_artifact"}
            ],
            "handoff_checks": [{
                "check_id": "family_pairwise_contest",
                "hypothesis_text": "antigen-presentation / interferon-response failure family",
                // The real shape, from a dispatched lane's own handoff:
                // `exposures` is a LIST and the dataset is named. This fixture
                // carried `exposure` singular and no dataset, which is not a
                // shape any analyst emits -- so the check recorded that it could
                // not run and the test was asserting against that by accident.
                "exposures": ["derived antigen presentation module score"],
                "dataset": "materialized-bundle",
                "outcome": "phenotype label or proxy",
                "negative_controls": ["housekeeping module"]
            }],
            "validation_code_blueprints": [{
                "check_id": "family_pairwise_contest",
                "code": "print('run family contest')"
            }]
        }),
    )
    .unwrap();
    let first_created = dispatch_followup_lanes(&paths, cycle, 6).unwrap();
    assert!(
        first_created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-runner")
                && matches!(
                    item.get("source_brief_id").and_then(Value::as_str),
                    Some("analyst-handoff") | Some("analyst-handoff-artifact")
                )
        }),
        "LabRunner must execute Analyst's handoff directly; LabDirector gates only after Analyst interprets runner results"
    );
    assert!(
        !first_created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str)
                    == Some("analyst-handoff-review")
        }),
        "LabDirector must not pre-approve the Analyst-to-LabRunner handoff"
    );
}

#[test]
fn gatekeeper_requires_post_run_review_unless_analyst_standard_is_satisfied() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-post-run-hard-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Post-run interpretation must gate Gatekeeper."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE289864 MAIT17 signal predicts suppressive myeloid co-enrichment.",
            "primary_family": "tumor_immune_resistance",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();

    let handoff_lane = lane_root(&paths, cycle, "followup-analyst-handoff");
    fs::create_dir_all(&handoff_lane).unwrap();
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
        &handoff_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-handoff", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &handoff_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-handoff", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &handoff_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-analyst-handoff",
            "role": "analyst",
            "action_type": "labdirector_comparator_validation_followup"
        }),
    )
    .unwrap();
    let handoff_path = handoff_lane.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready",
            "handoff_checks": [{"check_id": "primary", "hypothesis_text": "MAIT17", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"check_id": "primary", "code": "print('ok')", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
        }),
    )
    .unwrap();
    write_json(&handoff_lane.join("result.json"), &json!({"status": "completed"})).unwrap();

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
        &runner_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-01",
            "role": "lab-runner",
            "action_type": "methods_followup",
            "source_brief_id": "analyst-handoff"
        }),
    )
    .unwrap();
    write_json(
        &runner_lane.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": {
                "planner_metadata": {
                    "analyst_handoff_path": handoff_path
                }
            },
            "validation_summary": {
                "overall_status": "passed",
                "checks_failed": 0,
                "blueprints_failed": 0,
                "analyst_quality_standard": {"satisfied": false},
                "handoff_check_resolutions": [{
                    "check_id": "primary",
                    "resolved": true
                }]
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
            .contains("waiting-for-analyst-post-run-review"),
        "Gatekeeper must wait for Analyst post-run interpretation, got {blocker:?}"
    );

    // Already qualified evidence may proceed to independent Gatekeeper review
    // without repeatedly waiting for another Analyst interpretation.
    let runner_result_path = runner_lane.join("result.json");
    let mut runner_result = read_json(&runner_result_path).unwrap();
    runner_result["validation_summary"]["analyst_quality_standard"]["satisfied"] = json!(true);
    write_json(&runner_result_path, &runner_result).unwrap();
    assert_eq!(dependency_blocker_for_lane(&paths, cycle, &contract).unwrap(), None);
    runner_result["validation_summary"]["analyst_quality_standard"]["satisfied"] = json!(false);
    write_json(&runner_result_path, &runner_result).unwrap();

    let review_lane = lane_root(&paths, cycle, "followup-analyst-post-run");
    fs::create_dir_all(&review_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        "followup-analyst-post-run",
        "analyst",
        "codex-agent",
        "run",
        "post-run analyst fixture",
    )
    .unwrap();
    write_json(
        &review_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-analyst-post-run",
            "role": "analyst",
            "action_type": "runner_result_interpretation_followup",
            "source_brief_id": "followup-runner-01"
        }),
    )
    .unwrap();
    write_json(
        &review_lane.join("run-state.json"),
        &json!({"lane_id": "followup-analyst-post-run", "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &review_lane.join("final-status.json"),
        &json!({"lane_id": "followup-analyst-post-run", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &review_lane.join("result.json"),
        &json!({
            "lab_director_validation_report": {
                "hypothesis_decision": "support",
                "effect_direction": "positive",
                "effect_strength": "moderate",
                "controls": ["generic T-cell infiltration"],
                "negative_controls": ["housekeeping immune program"],
                "confounder_assessment": "bounded",
                "falsification_assessment": "negative controls did not dominate",
                "protocol_deviations": [],
                "failure_modes": [],
                "artifacts": ["validation-summary.json"]
            }
        }),
    )
    .unwrap();

    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert_eq!(blocker, None);
}

#[test]
fn evidence_bound_gatekeeper_review_bypasses_materialization_gate() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-evidence-bound-gatekeeper";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "lane_statuses": [
                {"lane_id": "scout-01", "role": "scout", "status": "completed"},
                {"lane_id": "followup-scout-01", "role": "scout", "status": "completed"},
                {"lane_id": "lab-director-01", "role": "lab-director", "status": "completed"},
                {"lane_id": "lab-runner-01", "role": "lab-runner", "status": "completed"}
            ]
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A selected hypothesis still marks materialization as incomplete.",
            "primary_family": "immune_transport",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();

    let gatekeeper_lane = lane_root(&paths, cycle, "followup-gatekeeper-01");
    fs::create_dir_all(&gatekeeper_lane).unwrap();
    write_json(
        &gatekeeper_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "planner_metadata": {
                "target_rubric": "technical_quality",
                "review_action": {
                    "type": "independent_gate_review_followup",
                    "target_rubric": "technical_quality",
                    "latest_validation_lane_id": "followup-runner-845",
                    "validation_results": {
                        "validation_results": [{
                            "lane_id": "followup-runner-845",
                            "verdict": "degraded"
                        }]
                    }
                }
            }
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

    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap(),
        None
    );
}

#[test]
fn executable_handoff_runner_bypasses_materialization_gate() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-executable-handoff-runner";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "lane_statuses": [
                {"lane_id": "scout-01", "role": "scout", "status": "completed"},
                {"lane_id": "followup-scout-01", "role": "scout", "status": "completed"},
                {"lane_id": "followup-analyst-01", "role": "analyst", "status": "completed"},
                {"lane_id": "followup-analyst-02", "role": "analyst", "status": "completed"},
                {"lane_id": "followup-analyst-03", "role": "analyst", "status": "completed"},
                {"lane_id": "lab-director-01", "role": "lab-director", "status": "completed"}
            ]
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A selected hypothesis still marks materialization as incomplete.",
            "primary_family": "immune_transport",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();

    let analyst_lane = lane_root(&paths, cycle, "followup-analyst-03");
    fs::create_dir_all(&analyst_lane).unwrap();
    write_json(
        &analyst_lane.join("handoff-validation-plan.json"),
        &json!({
            "status": "ready",
            "handoff_checks": [{"check_id": "transport_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{
                "blueprint_id": "transport",
                "code": "print('validate')"
            }]
        }),
    )
    .unwrap();

    let runner_lane = lane_root(&paths, cycle, "followup-runner-01");
    fs::create_dir_all(&runner_lane).unwrap();
    write_json(
        &runner_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-runner-01",
            "role": "lab-runner",
            "source_brief_id": "analyst-handoff",
            "action_type": "methods_followup",
            "planner_metadata": {
                "analysis_request": {
                    "source": "latest-executable-analyst-handoff",
                    "handoff_path": "/tmp/handoff-validation-plan.json",
                    "analyst_handoff": {
                        "handoff_checks": [{"check_id": "transport_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
                        "validation_code_blueprints": [{
                            "blueprint_id": "transport",
                            "code": "print('validate')"
                        }]
                    }
                }
            }
        }),
    )
    .unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "followup-runner-01".to_string(),
        role: "lab-runner".to_string(),
        runtime_class: "external-driver".to_string(),
        mode: "driver-exec".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };

    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap(),
        None
    );
}
