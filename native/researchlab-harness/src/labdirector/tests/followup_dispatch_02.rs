#[test]
fn labdirector_role_plan_uses_chronicle_digest_not_full_kg() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-labdirector-digest-only";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_stage_gate_kg(&paths, cycle);

    let huge_graph = json!({
        "nodes": (0..200).map(|index| json!({
            "id": format!("node:{index}"),
            "type": "mechanism",
            "summary": "x".repeat(400)
        })).collect::<Vec<_>>(),
        "edges": (0..200).map(|index| json!({
            "id": format!("edge:{index}"),
            "type": "supports",
            "summary": "y".repeat(400)
        })).collect::<Vec<_>>()
    });
    let role_plan_path = write_followup_role_plan(
        &paths,
        cycle,
        "followup-lab-director-01",
        "lab-director",
        "codex",
        "Select the next research direction without reading full KG dumps.",
        "digest-only-test",
        "Make a decision from Chronicle's compact digest.",
        "lab_director_requery_followup",
        &[],
        &[],
        None,
        Some(&huge_graph),
        Some(&huge_graph),
        &[],
        json!({
            "reasoning_graph": huge_graph,
            "data_graph": huge_graph,
            "knowledge_graph": huge_graph,
        }),
    )
    .unwrap();
    let role_plan = read_json(&role_plan_path).unwrap();
    let planner = role_plan.get("planner_metadata").unwrap();
    assert!(planner.get("chronicle_decision_digest").is_some());
    assert!(planner.get("reasoning_graph").is_none());
    assert!(planner.get("data_graph").is_none());
    assert!(planner.get("knowledge_graph").is_none());
    assert_eq!(
        planner["raw_kg_context_policy"]["full_kg_inline_allowed"],
        json!(false)
    );
    assert!(
        role_plan["context_input_trace"]["total_role_plan_inline_bytes"]
            .as_u64()
            .unwrap()
            < 80_000
    );
    let contract = &planner["kg_first_hypothesis_contract"];
    assert!(contract.get("artifact_inputs").is_none());
    assert!(contract["forbidden_context_inputs"]
        .as_array()
        .unwrap()
        .contains(&json!("full_lane_tree")));
}

#[test]
fn labdirector_recorded_override_treats_hypothesis_gate_as_advisory() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-labdirector-stage-gate-override";
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
                "statement": "A LabDirector-selected lead with a justified advisory-gate override.",
                "dataset_or_accession": "TCGA-BRCA",
                "validation_data_status": "needs_materialization",
                "lab_director_stage_gate_override": {
                    "stage": "hypothesis_generation",
                    "approved": true,
                    "rationale": "The gate rejection is a process recommendation; Chronicle digest shows this is still the best decision path."
                }
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
    assert_eq!(
        gate_state["mode"],
        json!("advisory_stage_gates_with_hard_safety_constraints")
    );
    assert_eq!(gate_state["gates"][2]["passed"], json!(true));
    assert_eq!(
        gate_state["gates"][2]["lab_director_override_applied"],
        json!(true)
    );

    let mut actions = Vec::new();
    enforce_stage_gate_recovery_actions(
        &paths,
        cycle,
        &mut actions,
        "Run KG-first omics research and never reuse GSE282742.",
    )
    .unwrap();
    assert!(actions.iter().all(|action| {
        action.get("brief_id").and_then(Value::as_str) != Some("hypothesis-gate-literature-restart")
    }));
    assert!(actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str)
            == Some("stage-gate-validation-materialization")
    }));
}

#[test]
fn labdirector_uphold_decision_treats_hypothesis_gate_as_advisory() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-labdirector-uphold-stage-gate";
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
            "statement": "A LabDirector-selected lead upheld after gate review.",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-research-notes.json")),
        &json!({
            "rejected_prior_family": {
                "dataset_or_accession": "GSE282742",
                "status": "forbidden_or_rejected"
            },
            "latest_lab_director_decision": {
                "requery_decision": "uphold",
                "rationale": "The gate rejection is advisory; the current digest supports this as the best lead.",
                "selected_hypothesis": {
                    "statement": "A LabDirector-selected lead upheld after gate review.",
                    "dataset_or_accession": "TCGA-BRCA"
                }
            }
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
    assert_eq!(gate_state["gates"][2]["passed"], json!(true));
    assert_eq!(
        gate_state["gates"][2]["lab_director_override_applied"],
        json!(true)
    );
}

// MEASURED ON cycle-a-20260919, 2026-09-21. The engineer action for
// the ordered simulation sat behind 61 gate restarts, 47 novelty follow-ups and
// 35 chronicle evidence requests, so the experiment the owner approved was
// never dispatched and every gate reviewed a lead with no data.
#[test]
fn the_ordered_experiment_outranks_every_review_of_it() {
    let simulation = json!({
        "type": crate::labdirector::SIMULATION_DATA_GENERATION_ACTION,
        "priority": "high",
        "brief_id": "simulation-coverage_decay_planar_push_v1",
    });
    for competitor in [
        json!({"type": "gate_restart_followup", "priority": "high", "target_rubric": "gate_independence"}),
        json!({"type": "novelty_followup", "priority": "high", "target_rubric": "gate_independence"}),
        json!({"type": "lab_director_requery_followup", "priority": "high"}),
        json!({"type": "chronicle_evidence_request_followup", "priority": "high"}),
        json!({"type": "independent_gate_review_followup", "priority": "critical", "target_rubric": "novelty"}),
    ] {
        for (external, closure) in [(false, false), (false, true), (true, false)] {
            assert!(
                followup_action_sort_key(&simulation, external, closure)
                    <= followup_action_sort_key(&competitor, external, closure),
                "{} outranked the ordered experiment",
                competitor["type"],
            );
        }
    }
}

#[test]
fn independent_gate_review_outranks_regeneration_for_focused_gate_rubrics() {
    let novelty = json!({
        "type": "hypothesis_regeneration_followup",
        "priority": "high",
        "target_rubric": "novelty",
    });
    let gate = json!({
        "type": "independent_gate_review_followup",
        "priority": "high",
        "target_rubric": "novelty",
    });
    assert!(
        followup_action_sort_key(&gate, false, true)
            < followup_action_sort_key(&novelty, false, true)
    );
    assert!(
        followup_action_sort_key(&gate, false, false)
            < followup_action_sort_key(&novelty, false, false)
    );
}

#[test]
fn current_director_novelty_prerequisite_outranks_reviews_of_demoted_leads() {
    // MEASURED ON cycle-a-20260919, 2026-10-02: owner_selection stayed
    // fixed for 429 minutes while the latest director's bounded novelty action
    // waited behind reviews and comparator work belonging to demoted leads.
    let prerequisite = json!({
        "brief_id": "followup-lab-director-321",
        "type": "novelty_followup",
        "preferred_role": "scout",
        "priority_score": 238,
        "requery_decision": "defer_for_chronicle",
    });
    let stale_gate = json!({
        "brief_id": "gate-review-novelty",
        "type": "independent_gate_review_followup",
        "preferred_role": "gatekeeper",
        "priority": "critical",
        "target_rubric": "novelty",
    });
    assert!(
        followup_action_sort_key(&prerequisite, false, false)
            < followup_action_sort_key(&stale_gate, false, false)
    );
}

#[test]
fn stale_conclusion_review_does_not_close_a_gate_without_a_selected_lead() {
    // MEASURED ON cycle-a-20260919, 2026-10-02: the current lead was
    // null, but a conclusion_gate_passed receipt from its demoted predecessor
    // continued to promote gate reviews ahead of replacement selection.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-stale-conclusion-before-replacement";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({"status": "deferred", "selected_hypothesis": null}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({"conclusion_gate_passed": true}),
    )
    .unwrap();
    assert!(!hypothesis_gate_closure_ready(&paths, cycle).unwrap());

    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({"status": "selected", "statement": "a current lead"}),
    )
    .unwrap();
    assert!(hypothesis_gate_closure_ready(&paths, cycle).unwrap());
}

#[test]
fn executable_analyst_handoff_action_outranks_pivot_and_gate_actions() {
    let handoff = json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "priority": "high",
        "target_rubric": "technical_quality",
    });
    let regeneration = json!({
        "type": "hypothesis_regeneration_followup",
        "priority": "high",
        "target_rubric": "novelty",
    });
    let gate = json!({
        "type": "independent_gate_review_followup",
        "priority": "high",
        "target_rubric": "novelty",
    });
    assert!(
        followup_action_sort_key(&handoff, false, false)
            < followup_action_sort_key(&regeneration, false, false)
    );
    assert!(
        followup_action_sort_key(&handoff, false, true)
            < followup_action_sort_key(&gate, false, true)
    );
    let comparator = json!({
        "brief_id": "labdirector-next-action-followup-lab-director-01",
        "type": "labdirector_comparator_validation_followup",
        "priority": "critical",
        "target_rubric": "technical_quality",
    });
    assert!(
        followup_action_sort_key(&handoff, false, false)
            < followup_action_sort_key(&comparator, false, false)
    );
    let external = json!({
        "type": "external_validation_followup",
        "priority": "high",
        "target_rubric": "external_validity",
    });
    assert!(
        followup_action_sort_key(&handoff, true, false)
            < followup_action_sort_key(&external, true, false)
    );
}

#[test]
fn high_readiness_low_gate_without_claim_delta_pivots_immediately() {
    let completion_review = json!({
        "approval_readiness_score": 92,
        "claim_count": 0,
        "approval_blocker_count": 2,
        "mode": "refine"
    });
    let gate_review = json!({
        "score": 6,
        "mode": "defer",
        "gate_passed": false
    });

    let reason = pre_gate_pivot_reason(
        false,
        false,
        &completion_review,
        &gate_review,
        66,
        0,
        0,
        30,
        1,
        3,
        1200,
    );

    assert_eq!(reason, Some("scientific_gate_ceiling"));
}

#[test]
fn high_readiness_low_gate_waits_when_supported_claim_delta_exists() {
    let completion_review = json!({
        "approval_readiness_score": 92,
        "claim_count": 3,
        "approval_blocker_count": 1,
        "mode": "refine"
    });
    let gate_review = json!({
        "score": 6,
        "mode": "defer",
        "gate_passed": false
    });

    let reason = pre_gate_pivot_reason(
        false,
        false,
        &completion_review,
        &gate_review,
        66,
        0,
        0,
        30,
        1,
        3,
        1200,
    );

    assert_eq!(reason, None);
}

#[test]
fn pending_analyst_handoff_suppresses_pivot_scout_until_runner_dispatch() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-handoff-before-pivot-scout";
    let state_dir = state_root(&paths);
    let brief_dir = chronicle_briefs_root(&paths, cycle);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&brief_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Prioritize executable analyst handoff validation."}),
    )
    .unwrap();
    write_json(
            &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
            &json!({
                "statement": "A transcriptomic immune-state score is reproducibly associated with pathway activity.",
                "primary_family": "immune_state_transcriptomics",
                "identification_strategy": {"design": "same-dataset robustness"}
            }),
        )
        .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-strategy-decision.json")),
        &json!({
            "mode": "pivot",
            "reason": "latest validation was degraded and needs a structurally stronger family"
        }),
    )
    .unwrap();
    write_json(
            &brief_dir.join("analyst-handoff.json"),
            &json!({
                "brief_id": "analyst-handoff",
                "recommended_actions": [{
                    "type": "methods_followup",
                    "preferred_role": "lab-runner",
                    "priority": "high",
                    "description": "execute the latest analyst handoff before launching additional pivot discovery"
                }]
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        created
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner")),
        "the executable analyst handoff should dispatch a runner immediately"
    );
    assert!(
            !created.iter().any(|item| {
                item.get("role").and_then(Value::as_str) == Some("scout")
                    && item
                        .get("source_brief_id")
                        .and_then(Value::as_str)
                        == Some("strategy_pivot")
            }),
            "pivot scout discovery must wait until the pending analyst handoff runner has been dispatched"
        );
}

#[test]
fn executable_handoff_dispatches_runner_before_labdirector_comparator_rework() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-handoff-before-comparator-rework";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Validate the current GSE289864 handoff before further rework."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "In GSE289864, MAIT17 states co-enrich with suppressive TAN/MDSC programs.",
            "identification_strategy": {"dataset_or_accession": "GSE289864"}
        }),
    )
    .unwrap();

    let director_lane_id = "followup-lab-director-01";
    let director_lane = lane_root(&paths, cycle, director_lane_id);
    fs::create_dir_all(&director_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        director_lane_id,
        "lab-director",
        "codex-agent",
        "run",
        "LabDirector comparator rework fixture",
    )
    .unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": director_lane_id,
            "role": "lab-director",
            "action_type": "gate_restart_followup",
            "source_brief_id": "hypothesis-gate-labdirector-requery"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({"lane_id": director_lane_id, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &director_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "next_actions": [{
                    "type": "methods_followup",
                    "preferred_role": "analyst",
                    "description": "Write comparator-aware validation spec before promotion."
                }]
            }
        }),
    )
    .unwrap();

    let analyst_lane_id = "followup-analyst-01";
    let analyst_lane = lane_root(&paths, cycle, analyst_lane_id);
    fs::create_dir_all(&analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        analyst_lane_id,
        "analyst",
        "external-driver",
        "driver-exec",
        "ready Analyst handoff fixture",
    )
    .unwrap();
    write_json(
        &analyst_lane.join("run-state.json"),
        &json!({"lane_id": analyst_lane_id, "role": "analyst", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_lane.join("final-status.json"),
        &json!({"lane_id": analyst_lane_id, "status": "completed"}),
    )
    .unwrap();
    let handoff_path = analyst_lane.join("handoff-validation-plan.json");
    write_json(
        &handoff_path,
        &json!({
            "status": "ready_for_runner",
            "summary": "In GSE289864, MAIT17 states co-enrich with suppressive TAN/MDSC programs.",
            "handoff_checks": [{"check_id": "gse289864_mait17_tan_mdsc", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "runner", "code": "print('run')"}]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert_eq!(
        created
            .first()
            .and_then(|item| item.get("role"))
            .and_then(Value::as_str),
        Some("lab-runner"),
        "a ready executable Analyst handoff must consume the next dispatch slot before more Analyst comparator rework"
    );
    let role_plan_path =
        PathBuf::from(created[0].get("role_plan_path").and_then(Value::as_str).unwrap());
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(handoff_path.display().to_string())
    );
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("analyst")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("labdirector-next-action-")
        }),
        "ready handoff must suppress additional Analyst comparator rework until a runner consumes it"
    );
}

#[test]
fn cached_lane_index_uses_completion_time_to_dispatch_fresh_handoff_runner() {
    // MEASURED ON cycle-a-20260919, 2026-10-03: cycle-run-state had
    // no completed_at fields. Analyst-299 completed at 09:08 after the selected
    // simulation bundle, but older analyst-301 had the larger suffix and its
    // already-served handoff hid analyst-299 from LabRunner dispatch.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-completion-order-handoff";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Run fresh validation after the selected simulation bundle."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({"status": "selected", "statement": "Current robotics lead"}),
    )
    .unwrap();

    let write_handoff = |lane_id: &str, completed_at: &str, blueprint: &str| {
        let lane_dir = lane_root(&paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({"lane_id": lane_id, "role": "analyst", "action_type": "hypothesis_followup"}),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane_id, "role": "analyst", "status": "completed", "completed_at": completed_at}),
        )
        .unwrap();
        let handoff_path = lane_dir.join("handoff-validation-plan.json");
        write_json(
            &handoff_path,
            &json!({
                "status": "ready_for_runner",
                "handoff_checks": [{
                    "check_id": blueprint,
                    "exposures": ["policy_inference_arm"],
                    "dataset": "materialized-bundle"
                }],
                "validation_code_blueprints": [{
                    "blueprint_id": blueprint,
                    "check_id": blueprint,
                    "code": "print('run validation')"
                }]
            }),
        )
        .unwrap();
        handoff_path
    };
    let fresh_handoff = write_handoff(
        "followup-analyst-299",
        "2026-10-03T09:08:30Z",
        "BP-RMIA-001",
    );
    let stale_handoff = write_handoff(
        "followup-analyst-301",
        "2026-10-03T07:12:38Z",
        "BP-RR25-001",
    );

    let runner_id = "followup-runner-115";
    let runner_dir = lane_root(&paths, cycle, runner_id);
    fs::create_dir_all(&runner_dir).unwrap();
    write_json(
        &runner_dir.join("role-plan.json"),
        &json!({
            "lane_id": runner_id,
            "role": "lab-runner",
            "action_type": "methods_followup",
            "planner_metadata": {"analysis_request": {"handoff_path": stale_handoff}}
        }),
    )
    .unwrap();
    let runner_result = runner_dir.join("result.json");
    write_json(
        &runner_result,
        &json!({
            "status": "completed",
            "analyst_handoff_path": stale_handoff,
            "validation_summary": {"overall_status": "passed"}
        }),
    )
    .unwrap();
    write_json(
        &runner_dir.join("final-status.json"),
        &json!({"lane_id": runner_id, "status": "completed", "result_path": runner_result}),
    )
    .unwrap();

    let mut lane_statuses = vec![
        json!({"lane_id": "followup-analyst-299", "role": "analyst", "status": "completed"}),
        json!({"lane_id": "followup-analyst-301", "role": "analyst", "status": "completed"}),
        json!({"lane_id": runner_id, "role": "lab-runner", "status": "completed"}),
    ];
    for index in 0..29 {
        lane_statuses.push(json!({
            "lane_id": format!("finished-filler-{index:02}"),
            "role": "author",
            "status": "completed"
        }));
    }
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"cycle_id": cycle, "status": "running", "lane_statuses": lane_statuses}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    assert_eq!(created.len(), 1, "fresh post-bundle handoff must open a runner");
    assert_eq!(created[0]["role"], json!("lab-runner"));
    let role_plan = read_json(Path::new(
        created[0]["role_plan_path"].as_str().unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(fresh_handoff.display().to_string()),
        "the newer completed handoff advances analysis instead of reusing stale validation"
    );
}

#[test]
fn chronicle_followup_analyst_can_bootstrap_missing_labdirector_hypothesis() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-bootstrap-analyst";
    let lane_id = "followup-analyst-02";
    let state_dir = state_root(&paths);
    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&lane_dir).unwrap();

    write_json(
        &lane_dir.join("role-plan.json"),
        &json!({
            "lane_id": lane_id,
            "role": "analyst",
            "action_type": "chronicle_required_evidence",
            "planner_metadata": {
                "analyst_handoff_required": true,
                "candidate_datasets": [{"bundle_path": "dataset-a"}]
            }
        }),
    )
    .unwrap();

    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "analyst".to_string(),
        runtime_class: "external-driver".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_dir.join("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    let snapshot = DependencySnapshot {
        counts: HashMap::new(),
        completed_scouts: 1,
        completed_data_scouts: 1,
        has_lab_director_hypothesis: false,
        conclusion_needs_hypothesis_strategy: false,
        hypothesis_gate_passed: false,
        latest_analyst_handoff_signal: None,
        pending_runner_post_run_review: None,
    };

    let blocker =
        dependency_blocker_for_lane_with_snapshot(&paths, cycle, &contract, &snapshot).unwrap();
    assert_eq!(
            blocker, None,
            "chronicle-requested analyst handoff lanes must run when no lab-director hypothesis exists; otherwise pending analysts and runners deadlock"
        );
}

#[test]
fn runner_recovery_analyst_can_repair_handoff_without_labdirector_hypothesis() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-recovery-analyst";
    let lane_id = "followup-analyst-04";
    let state_dir = state_root(&paths);
    let lane_dir = lane_root(&paths, cycle, lane_id);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&lane_dir).unwrap();

    write_json(
        &lane_dir.join("role-plan.json"),
        &json!({
            "lane_id": lane_id,
            "role": "analyst",
            "action_type": "runner_scientific_recovery_followup"
        }),
    )
    .unwrap();

    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "analyst".to_string(),
        runtime_class: "external-driver".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_dir.join("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    let snapshot = DependencySnapshot {
        counts: HashMap::new(),
        completed_scouts: 1,
        completed_data_scouts: 1,
        has_lab_director_hypothesis: false,
        conclusion_needs_hypothesis_strategy: false,
        hypothesis_gate_passed: false,
        latest_analyst_handoff_signal: None,
        pending_runner_post_run_review: None,
    };

    let blocker =
        dependency_blocker_for_lane_with_snapshot(&paths, cycle, &contract, &snapshot).unwrap();
    assert_eq!(
            blocker, None,
            "runner recovery analyst lanes revise failed handoffs and must not wait for the missing hypothesis they are trying to replace"
        );
}

#[test]
fn unclassified_fallback_hypothesis_is_not_selectable() {
    assert!(!is_nonfallback_hypothesis_candidate(&json!({
        "statement": "Select family `unclassified_family` and issue one executable validation handoff.",
        "family_root": "unclassified_family",
    })));
    assert!(is_nonfallback_hypothesis_candidate(&json!({
        "statement": "Microglial interferon-response modules predict accelerated cortical atrophy in an independent single-cell cohort.",
        "family_root": "microglial_interferon_atrophy",
    })));
}

#[test]
fn zero_nonfallback_plan_routes_to_design_recovery_not_validation() {
    let mut actions = vec![
        json!({
            "brief_id": "gate-review",
            "type": "independent_gate_review_followup",
            "preferred_role": "gatekeeper",
            "priority_score": 145,
        }),
        json!({
            "brief_id": "chronicle-response",
            "type": "chronicle_required_evidence",
            "preferred_role": "lab-runner",
            "priority_score": 108,
        }),
    ];
    enforce_zero_nonfallback_hypothesis_recovery_actions(
        &mut actions,
        &[],
        "Do not reuse GSE282742",
    );
    assert!(!actions.iter().any(|action| matches!(
        action.get("type").and_then(Value::as_str),
        Some("independent_gate_review_followup") | Some("chronicle_required_evidence")
    )));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("lab_director_requery_followup")
            && action.get("brief_id").and_then(Value::as_str) == Some("zero-nonfallback-hypotheses")
    }));
    assert!(actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("data_acquisition_followup")
            && action.get("brief_id").and_then(Value::as_str) == Some("zero-nonfallback-hypotheses")
    }));
}

#[test]
fn independent_gate_reviews_parallelize_by_target_rubric() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-parallel-gate-rubrics";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Close independent hypothesis gate rubrics quickly."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A current lead has enough validation context for independent review.",
            "primary_family": "current_lead_family",
            "selected_hypothesis": {
                "statement": "A current lead has enough validation context for independent review.",
                "family_root": "current_lead_family"
            },
            "validation_data_status": "materialized",
            "identification_strategy": {
                "materialized_dataset": {"bundle_path": "/tmp/current-lead"}
            }
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({"conclusion_gate_passed": true, "conclusion_score": 96}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-approval-review.json")),
        &json!({"approval_gate_passed": false, "approval_readiness_score": 63}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "score": 63,
            "gatekeeper_review_status": "superseded",
            "gatekeeper_pending_rubrics": [
                "novelty",
                "technical_quality",
                "strobe_reporting_completeness"
            ],
            "recommended_followup_actions": [
                {
                    "type": "independent_gate_review_followup",
                    "preferred_role": "gatekeeper",
                    "priority": "high",
                    "target_rubric": "novelty",
                    "description": "review novelty for the current lead"
                },
                {
                    "type": "independent_gate_review_followup",
                    "preferred_role": "gatekeeper",
                    "priority": "high",
                    "target_rubric": "technical_quality",
                    "description": "review technical quality for the current lead"
                },
                {
                    "type": "independent_gate_review_followup",
                    "preferred_role": "gatekeeper",
                    "priority": "high",
                    "target_rubric": "strobe_reporting_completeness",
                    "description": "review STROBE reporting completeness for the current lead"
                }
            ]
        }),
    )
    .unwrap();

    let open_novelty = lane_root(&paths, cycle, "followup-gatekeeper-01");
    fs::create_dir_all(&open_novelty).unwrap();
    write_json(
        &open_novelty.join("role-plan.json"),
        &json!({
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "source_brief_id": "gate-review",
            "planner_metadata": {"target_rubric": "novelty"}
        }),
    )
    .unwrap();
    write_json(
        &open_novelty.join("run-state.json"),
        &json!({"lane_id": "followup-gatekeeper-01", "role": "gatekeeper", "status": "pending"}),
    )
    .unwrap();
    write_json(
        &open_novelty.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "runtime_class": "codex-agent",
            "mode": "read-write-scoped",
            "task_file": open_novelty.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
            "output_artifact": null
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "status": "running",
            "lane_counts": {"pending": 1, "running": 0, "completed": 4, "failed": 0, "total": 5},
            "lane_statuses": [
                {"lane_id": "followup-gatekeeper-01", "role": "gatekeeper", "status": "pending"}
            ]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 8).unwrap();
    let gatekeepers = created
        .iter()
        .filter(|item| item.get("role").and_then(Value::as_str) == Some("gatekeeper"))
        .collect::<Vec<_>>();
    assert_eq!(gatekeepers.len(), 2, "{created:#?}");
    let rubrics = gatekeepers
        .iter()
        .map(|item| {
            let role_plan_path =
                PathBuf::from(item.get("role_plan_path").and_then(Value::as_str).unwrap());
            read_json(&role_plan_path).unwrap()["planner_metadata"]["target_rubric"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        rubrics,
        BTreeSet::from([
            "strobe_reporting_completeness".to_string(),
            "technical_quality".to_string()
        ])
    );
}

#[test]
fn gate_review_dispatch_preserves_the_briefed_lead_key() {
    // MEASURED ON cycle-a-20260919, 2026-10-04: five gate reviews
    // finished after a lead replacement, but every dispatched role plan omitted
    // gate_review_lead_key. The gate consequently kept their retired-lead
    // rejections active and conclusion could not advance.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-review-lead-binding";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Review only the currently selected lead."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "The replacement lead uses a distinct topology-inversion estimand.",
            "primary_family": "policy_specific_coverage_geometry",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({"conclusion_gate_passed": true, "conclusion_score": 96}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-approval-review.json")),
        &json!({"approval_gate_passed": false, "approval_readiness_score": 63}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "gatekeeper_pending_rubrics": ["technical_quality"],
            "recommended_followup_actions": [{
                "type": "independent_gate_review_followup",
                "preferred_role": "gatekeeper",
                "priority": "high",
                "target_rubric": "technical_quality",
                "gate_review_lead_key": "hyp:replacement-lead",
                "description": "review technical quality for the replacement lead"
            }]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    let gatekeeper = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("gatekeeper"))
        .unwrap_or_else(|| panic!("current-lead gate review should dispatch: {created:#?}"));
    let role_plan = read_json(&PathBuf::from(
        gatekeeper
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["gate_review_lead_key"],
        json!("hyp:replacement-lead")
    );
}

#[test]
fn focused_gatekeeper_retry_allowed_for_pending_rubric_without_open_lane() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-focused-gatekeeper-retry";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "gatekeeper_pending_rubrics": ["novelty"]
        }),
    )
    .unwrap();

    assert!(
        focused_gatekeeper_retry_allowed(
            &paths,
            cycle,
            "gatekeeper",
            "independent_gate_review_followup",
            "novelty"
        )
        .unwrap()
    );

    let open_novelty = lane_root(&paths, cycle, "followup-gatekeeper-01");
    fs::create_dir_all(&open_novelty).unwrap();
    write_json(
        &open_novelty.join("role-plan.json"),
        &json!({
            "lane_id": "followup-gatekeeper-01",
            "role": "gatekeeper",
            "action_type": "independent_gate_review_followup",
            "planner_metadata": {"target_rubric": "novelty"}
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "status": "running",
            "lane_counts": {"pending": 1, "running": 0, "completed": 0, "failed": 0, "total": 1},
            "lane_statuses": [
                {"lane_id": "followup-gatekeeper-01", "role": "gatekeeper", "status": "pending"}
            ]
        }),
    )
    .unwrap();

    assert!(
        !focused_gatekeeper_retry_allowed(
            &paths,
            cycle,
            "gatekeeper",
            "independent_gate_review_followup",
            "novelty"
        )
        .unwrap()
    );
}

// 2026-10-03: one follow-up budget for the cycle (budget_caps::total_followup_cap).
// Nothing bypasses it -- not a gate review, not a recovery -- and no role has a
// lifetime cap of its own beneath it.
#[test]
fn a_spent_budget_stops_every_role_and_an_open_one_stops_none() {
    let pass_budget_by_role = HashMap::from([
        ("gatekeeper", 8usize),
        ("scout", 3usize),
        ("lab-director", 2usize),
        ("author", 1usize),
        ("engineer", 1usize),
        ("chronicle", 1usize),
    ]);
    // 2026-10-02/03: the roles that had passed their old lifetime caps.
    let long_cycle = HashMap::from([
        ("lab-director".to_string(), 371usize),
        ("chronicle".to_string(), 167usize),
        ("engineer".to_string(), 255usize),
        ("analyst".to_string(), 288usize),
    ]);
    let none = HashMap::new();
    let ctx = |existing_total: usize| FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts: &long_cycle,
        existing_action_counts: &none,
        open_action_counts: &none,
        existing_total_followups: existing_total,
        total_followup_cap: 4096,
        pass_budget_by_role: &pass_budget_by_role,
        document_stage_authorized: false,
        latest_handoff_served: None,
    };
    let actions = [
        ("lab-director", "lab_director_requery_followup"),
        ("lab-director", "blocking_lane_recovery_planning"),
        ("chronicle", "chronicle_evidence_request_followup"),
        ("engineer", "capability_provisioning_followup"),
        ("engineer", crate::labdirector::SIMULATION_DATA_GENERATION_ACTION),
        ("gatekeeper", "independent_gate_review_followup"),
    ];
    let open = ctx(1584);
    for (role, action) in actions {
        assert!(
            followup_role_available(&open, role, action, &HashMap::new(), &HashMap::new()),
            "{role} {action} was refused on its own lifetime count",
        );
    }
    let spent = ctx(4096);
    for (role, action) in actions {
        assert!(
            !followup_role_available(&spent, role, action, &HashMap::new(), &HashMap::new()),
            "{role} {action} bypassed the spent budget",
        );
    }
}


#[test]
fn a_failed_literature_scout_resumes_while_data_acquisition_is_pending() {
    // cycle-b-20260917d: the pending data-acquisition action was held behind
    // a Chronicle deliberation that itself waited for a literature scout, so
    // refusing the resume of the only literature scout closed the loop.
    let pass_budget_by_role = HashMap::from([("scout", 3usize)]);
    let ctx = FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: true,
        existing_followup_counts: &HashMap::new(),
        existing_action_counts: &HashMap::new(),
        open_action_counts: &HashMap::new(),
        existing_total_followups: 0,
        total_followup_cap: total_followup_cap(),
        pass_budget_by_role: &pass_budget_by_role,
        document_stage_authorized: false,
        latest_handoff_served: None,
    };

    for resume in ["adaptive_search_followup", "abstract_review_followup"] {
        assert!(
            followup_role_available(&ctx, "scout", resume, &HashMap::new(), &HashMap::new()),
            "{resume} was held behind data acquisition",
        );
    }
    // New scouting still waits for the data-acquisition scout it depends on.
    assert!(!followup_role_available(
        &ctx,
        "scout",
        "novelty_followup",
        &HashMap::new(),
        &HashMap::new()
    ));
}

// MEASURED ON cycle-a-20260919, 2026-09-28: 198 director lanes
// against an exempt ceiling of 64 x 3 = 192. Every director action was refused,
// including the one decision on the analysts' proposals that could change the
// answer. That decision carries its own bound instead.
fn exhausted_director_ctx<'a>(
    pass_budget_by_role: &'a HashMap<&'static str, usize>,
    existing_followup_counts: &'a HashMap<String, usize>,
    existing_action_counts: &'a HashMap<String, usize>,
    open_action_counts: &'a HashMap<String, usize>,
) -> FollowupRoleAvailabilityContext<'a> {
    FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts,
        existing_action_counts,
        open_action_counts,
        existing_total_followups: 700,
        total_followup_cap: total_followup_cap(),
        pass_budget_by_role,
        document_stage_authorized: false,
        latest_handoff_served: None,
    }
}

// cycle-a-20260919, 2026-10-01: 240 engineer lanes and the director's
// replacement order could not open a lane. With one budget there is no engineer
// ceiling; the order is still one open at a time and one engineer per pass.
#[test]
fn a_simulation_order_is_one_open_at_a_time_and_one_per_pass() {
    let order = crate::labdirector::SIMULATION_DATA_GENERATION_ACTION;
    let key = format!("engineer::{order}");
    let pass_budget_by_role = HashMap::from([("engineer", 1usize)]);
    let existing_followup_counts = HashMap::from([("engineer".to_string(), 240usize)]);
    let none: HashMap<String, usize> = HashMap::new();
    let ctx = exhausted_director_ctx(&pass_budget_by_role, &existing_followup_counts, &none, &none);
    assert!(followup_role_available(&ctx, "engineer", order, &HashMap::new(), &HashMap::new()));
    let one_open = HashMap::from([(key, 1usize)]);
    let ctx_open = exhausted_director_ctx(&pass_budget_by_role, &existing_followup_counts, &none, &one_open);
    assert!(!followup_role_available(&ctx_open, "engineer", order, &HashMap::new(), &HashMap::new()));
    let created = HashMap::from([("engineer".to_string(), 1usize)]);
    assert!(!followup_role_available(&ctx, "engineer", order, &created, &HashMap::new()));
}

// cycle-a-20260919, 2026-10-02: the recovery for an owner-stopped
// engineer could not open a lane at 321 director lanes. Still one open at a time.
#[test]
fn a_blocker_recovery_is_one_open_at_a_time() {
    let recovery = "blocking_lane_recovery_planning";
    let pass_budget_by_role = HashMap::from([("lab-director", 2usize)]);
    let existing_followup_counts = HashMap::from([("lab-director".to_string(), 321usize)]);
    let none: HashMap<String, usize> = HashMap::new();
    let ctx = exhausted_director_ctx(&pass_budget_by_role, &existing_followup_counts, &none, &none);
    assert!(followup_role_available(&ctx, "lab-director", recovery, &HashMap::new(), &HashMap::new()));
    let one_open = HashMap::from([(format!("lab-director::{recovery}"), 1usize)]);
    let ctx_open = exhausted_director_ctx(&pass_budget_by_role, &existing_followup_counts, &none, &one_open);
    assert!(!followup_role_available(&ctx_open, "lab-director", recovery, &HashMap::new(), &HashMap::new()));
}

#[test]
fn an_exhausted_director_can_still_decide_on_the_analysts_proposals() {
    let decision = crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION;
    let key = format!("lab-director::{decision}");
    let pass_budget_by_role = HashMap::from([("lab-director", 2usize)]);
    let existing_followup_counts = HashMap::from([("lab-director".to_string(), 198usize)]);
    let none: HashMap<String, usize> = HashMap::new();

    let ctx = exhausted_director_ctx(
        &pass_budget_by_role,
        &existing_followup_counts,
        &none,
        &none,
    );
    assert!(
        followup_role_available(&ctx, "lab-director", decision, &HashMap::new(), &HashMap::new()),
        "the decision on the analysts' proposals was refused on a count of unrelated requeries",
    );

    // Still one open at a time.
    let one_open = HashMap::from([(key.clone(), 1usize)]);
    let ctx_open = exhausted_director_ctx(
        &pass_budget_by_role,
        &existing_followup_counts,
        &none,
        &one_open,
    );
    assert!(!followup_role_available(&ctx_open, "lab-director", decision, &HashMap::new(), &HashMap::new()));

    // And finite: its own ceiling holds.
    let at_ceiling = HashMap::from([(key, analysis_proposal_decision_cap())]);
    let ctx_full = exhausted_director_ctx(
        &pass_budget_by_role,
        &existing_followup_counts,
        &at_ceiling,
        &none,
    );
    assert!(!followup_role_available(&ctx_full, "lab-director", decision, &HashMap::new(), &HashMap::new()));
}

// A lab-runner executes the newest executable analyst handoff and nothing else,
// whatever action opened it.
//
// MEASURED ON cycle-a-20260919, 2026-09-29: sixteen runners ran six
// handoffs. A director's comparator validation fell back to a runner at the
// analyst's per-pass limit -- twice per decision -- and chronicle, gate-restart
// and novelty actions opened runners too, each queued behind one already bound
// to the same handoff.
fn runner_ctx<'a>(
    pass_budget_by_role: &'a HashMap<&'static str, usize>,
    empty: &'a HashMap<String, usize>,
    latest_handoff_served: Option<bool>,
) -> FollowupRoleAvailabilityContext<'a> {
    FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts: empty,
        existing_action_counts: empty,
        open_action_counts: empty,
        existing_total_followups: 0,
        total_followup_cap: total_followup_cap(),
        pass_budget_by_role,
        document_stage_authorized: false,
        latest_handoff_served,
    }
}

#[test]
fn a_handoff_that_has_its_runner_opens_no_other() {
    let budget = HashMap::from([("lab-runner", 4usize), ("analyst", 3usize)]);
    let empty = HashMap::new();
    let served = runner_ctx(&budget, &empty, Some(true));
    for action in [
        "labdirector_comparator_validation_followup",
        "hypothesis_followup",
        "gate_restart_followup",
        "methods_followup",
    ] {
        assert!(
            !followup_role_available(&served, "lab-runner", action, &HashMap::new(), &HashMap::new()),
            "{action} opened a second runner on a handoff that already has one",
        );
    }
    // Other roles are untouched.
    assert!(followup_role_available(&served, "analyst", "methods_followup", &HashMap::new(), &HashMap::new()));
}

#[test]
fn a_waiting_handoff_gets_one_runner_per_pass() {
    let budget = HashMap::from([("lab-runner", 4usize)]);
    let empty = HashMap::new();
    let waiting = runner_ctx(&budget, &empty, Some(false));
    assert!(followup_role_available(&waiting, "lab-runner", "methods_followup", &HashMap::new(), &HashMap::new()));
    // The runner opened earlier in this pass is bound to that same handoff.
    let one_opened = HashMap::from([("lab-runner".to_string(), 1usize)]);
    assert!(!followup_role_available(&waiting, "lab-runner", "hypothesis_followup", &one_opened, &HashMap::new()));
}

#[test]
fn no_executable_handoff_leaves_runner_availability_as_it_was() {
    // `None` says nothing about whether a runner is wanted; cycles whose runners
    // do not run analyst handoffs must dispatch exactly as before.
    let budget = HashMap::from([("lab-runner", 4usize)]);
    let empty = HashMap::new();
    let none = runner_ctx(&budget, &empty, None);
    let one_opened = HashMap::from([("lab-runner".to_string(), 1usize)]);
    assert!(followup_role_available(&none, "lab-runner", "hypothesis_followup", &one_opened, &HashMap::new()));
}

#[test]
fn post_bundle_analysis_is_not_held_by_the_analysts_history() {
    // MEASURED ON cycle-a-20260919, 2026-10-02: experiment_data was
    // stuck for 100 minutes after support_metric_discordance_v1 completed; the
    // only action able to publish validation newer than that bundle was an
    // Analyst hypothesis_followup, refused on 275 historical Analyst lanes.
    let budget = pass_followup_budget_by_role();
    let existing = HashMap::from([("analyst".to_string(), 275usize)]);
    let empty = HashMap::new();
    let ctx = FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts: &existing,
        existing_action_counts: &empty,
        open_action_counts: &empty,
        existing_total_followups: 1584,
        total_followup_cap: 4096,
        pass_budget_by_role: &budget,
        document_stage_authorized: false,
        latest_handoff_served: Some(true),
    };
    for action in ["hypothesis_followup", "accuracy_followup"] {
        assert!(
            followup_role_available(&ctx, "analyst", action, &HashMap::new(), &HashMap::new()),
            "{action} was refused on the analysts' history",
        );
    }
    let spent = FollowupRoleAvailabilityContext { existing_total_followups: 4096, ..ctx };
    assert!(!followup_role_available(&spent, "analyst", "hypothesis_followup", &HashMap::new(), &HashMap::new()));
}
