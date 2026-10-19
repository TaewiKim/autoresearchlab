#[test]
fn gate_review_followup_preserves_validation_context_in_role_plan() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-gate-review-validation-context";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Close independent hypothesis gate rubrics with current validation evidence."}),
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
        &json!({"approval_gate_passed": false, "approval_readiness_score": 67}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": false,
            "score": 67,
            "gatekeeper_review_status": "partial",
            "gatekeeper_pending_rubrics": ["impact"],
            "recommended_followup_actions": [
                {
                    "type": "independent_gate_review_followup",
                    "preferred_role": "gatekeeper",
                    "priority": "high",
                    "target_rubric": "impact",
                    "description": "review impact against latest runner evidence",
                    "validation_results": {
                        "validation_results": [
                            {
                                "lane_id": "followup-runner-654",
                                "verdict": "passed",
                                "score": 89,
                                "summary": "overall_status=passed; checks=17/17"
                            }
                        ],
                        "counts": {"validation_result_count": 1}
                    },
                    "latest_validation_lane_id": "followup-runner-654",
                    "latest_validation_summary": {
                        "overall_status": "passed",
                        "checks_passed": 17,
                        "checks_total": 17
                    },
                    "review_mode": "lab_director_blocker_adjudication",
                    "lab_director_blocker_review_requests": [
                        {
                            "request_id": "ld-remove-stale-impact",
                            "blocker": "Impact: too few high-confidence promoted hypotheses are visible",
                            "target_rubric": "impact",
                            "requested_action": "remove",
                            "rationale": "latest runner evidence now supports the narrowed claim",
                            "evidence_refs": ["followup-runner-654/validation-summary.json"],
                            "replacement_blocker": null
                        }
                    ],
                    "lab_director_response_lane_id": "followup-lab-director-77",
                    "review_standard": "research"
                }
            ]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 8).unwrap();
    let gatekeeper = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("gatekeeper"))
        .expect("gatekeeper followup should dispatch");
    let role_plan_path = PathBuf::from(
        gatekeeper
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["validation_results"]["validation_results"]
            [0]["lane_id"],
        json!("followup-runner-654")
    );
    assert_eq!(
        role_plan["planner_metadata"]["validation_results"]["validation_results"][0]["score"],
        json!(89)
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["latest_validation_lane_id"],
        json!("followup-runner-654")
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["review_mode"],
        json!("lab_director_blocker_adjudication")
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["lab_director_blocker_review_requests"][0]
            ["request_id"],
        json!("ld-remove-stale-impact")
    );
    assert_eq!(
        role_plan["planner_metadata"]["lab_director_blocker_review_requests"][0]["blocker"],
        json!("Impact: too few high-confidence promoted hypotheses are visible")
    );
    assert_eq!(
        role_plan["planner_metadata"]["lab_director_response_lane_id"],
        json!("followup-lab-director-77")
    );
}

#[test]
fn forbidden_dataset_terms_filter_candidate_bundles() {
    let terms = forbidden_dataset_terms_from_text("Do not reuse GSE282742 for this run");
    assert_eq!(terms, vec!["gse282742".to_string()]);
    assert!(value_contains_forbidden_dataset_term(
        &json!({"bundle_path": "/tmp/gse282742", "candidate_url": "https://x/GSE282742"}),
        &terms,
    ));
    assert!(!value_contains_forbidden_dataset_term(
        &json!({"bundle_path": "/tmp/gse40279", "candidate_url": "https://x/GSE40279"}),
        &terms,
    ));
}

#[test]
fn strategy_pivot_after_stale_requery_dispatches_labdirector_replacement() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-pivot-fresh-labdirector";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Pivot once the current omics claim fails robustness gates."}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-strategy-decision.json")),
        &json!({
            "mode": "pivot",
            "decided_at": "2026-05-13T15:23:00Z",
            "reason": "no supported claim delta was produced"
        }),
    )
    .unwrap();

    let stale_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&stale_lane).unwrap();
    write_json(
        &stale_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup"
        }),
    )
    .unwrap();
    write_json(
        &stale_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "status": "completed",
            "completed_at": "2026-05-07T10:23:36Z"
        }),
    )
    .unwrap();
    write_json(
        &stale_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "requery_decision": "replace",
                "replacement_hypotheses": [{
                    "statement": "An earlier weak omics hypothesis should be replaced."
                }]
            }
        }),
    )
    .unwrap();
    for index in 2..=64 {
        let generic_lane = lane_root(&paths, cycle, &format!("followup-lab-director-{index:02}"));
        fs::create_dir_all(&generic_lane).unwrap();
        write_json(
            &generic_lane.join("role-plan.json"),
            &json!({
                "lane_id": format!("followup-lab-director-{index:02}"),
                "role": "lab-director",
                "action_type": "methods_followup"
            }),
        )
        .unwrap();
    }

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let labdirector = created
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str) == Some("strategy_pivot")
        })
        .expect("fresh pivot should dispatch a LabDirector replacement requery");
    let role_plan_path = PathBuf::from(
        labdirector
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("lab_director_requery_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["must_issue_replacement_hypotheses"],
        json!(true)
    );
    let task_md = fs::read_to_string(
        lane_root(&paths, cycle, labdirector["lane_id"].as_str().unwrap()).join("task.md"),
    )
    .unwrap();
    assert!(task_md.contains("pivot_hypothesis_replacement_contract"));
}

#[test]
fn strategy_pivot_does_not_duplicate_completed_current_labdirector_requery() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-pivot-current-labdirector-complete";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Avoid duplicate pivot LabDirector requery lanes."}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-strategy-decision.json")),
        &json!({
            "mode": "pivot",
            "decided_at": "2026-05-13T15:23:00Z",
            "reason": "no supported claim delta was produced"
        }),
    )
    .unwrap();

    let current_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&current_lane).unwrap();
    write_json(
        &current_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup"
        }),
    )
    .unwrap();
    write_json(
        &current_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "status": "completed",
            "completed_at": "2026-05-13T15:24:00Z"
        }),
    )
    .unwrap();
    write_json(
        &current_lane.join("result.json"),
        &json!({"extracted_json": {"requery_decision": "replace"}}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item.get("source_brief_id").and_then(Value::as_str) == Some("strategy_pivot")
        }),
        "do not duplicate a LabDirector requery already completed for this pivot decision"
    );
}

#[test]
fn fresh_conclusion_review_reopens_labdirector_strategy_requery() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-conclusion-requery-after-review";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Do not resume document work until hypothesis strategy is refreshed."}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-conclusion-review.json")),
        &json!({
            "cycle_id": cycle,
            "conclusion_gate_passed": false,
            "reviewed_at": "2026-05-21T22:58:48Z",
            "recommended_followup_actions": [{
                "type": "lab_director_requery_followup",
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "description": "Do not stop at a weak conclusion; requery LabDirector strategy."
            }]
        }),
    )
    .unwrap();

    let stale_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&stale_lane).unwrap();
    write_json(
        &stale_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "conclusion-review"
        }),
    )
    .unwrap();
    write_json(
        &stale_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "status": "completed",
            "completed_at": "2026-05-21T21:17:44Z"
        }),
    )
    .unwrap();
    write_json(
        &stale_lane.join("result.json"),
        &json!({"extracted_json": {"requery_decision": "replace"}}),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let labdirector = created
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("conclusion-review")
        })
        .expect("fresh conclusion review should dispatch a new LabDirector strategy requery");
    let role_plan_path = PathBuf::from(
        labdirector
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("lab_director_requery_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["recovery_reason"],
        json!("conclusion_requires_lab_director_requery")
    );
}

#[test]
fn pre_gate_stagnation_pivot_does_not_refresh_existing_same_reason_timestamp() {
    let existing = json!({
        "mode": "pivot",
        "source": "supervisor_stagnation_recovery",
        "stagnation_reason": "pending_lanes_blocked",
        "decided_at": "2026-05-19T22:06:24Z"
    });
    let candidate = json!({
        "mode": "pivot",
        "source": "supervisor_stagnation_recovery",
        "stagnation_reason": "pending_lanes_blocked",
        "decided_at": "2026-05-20T01:40:03Z"
    });

    assert!(
        !should_refresh_pre_gate_pivot_decision(&existing, &candidate),
        "repeated stagnation should not rewrite the pivot decision timestamp and re-open duplicate LabDirector requery dispatch"
    );
}

#[test]
fn pre_gate_stagnation_pivot_refreshes_when_reason_changes() {
    let existing = json!({
        "mode": "pivot",
        "source": "supervisor_stagnation_recovery",
        "stagnation_reason": "pending_lanes_blocked"
    });
    let candidate = json!({
        "mode": "pivot",
        "source": "supervisor_stagnation_recovery",
        "stagnation_reason": "repeated_completion_review"
    });

    assert!(should_refresh_pre_gate_pivot_decision(&existing, &candidate));
}

#[test]
fn degraded_analyst_handoff_runner_queues_analyst_revision_not_repeat_runner() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-degraded-handoff-runner";
    let state_dir = state_root(&paths);
    let lanes_dir = cycle_lanes_root(&paths, cycle);
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(&lanes_dir).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();

    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Recover from scientifically degraded handoff validation."}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A transcriptomic immune-state score is associated with pathway activity.",
            "primary_family": "immune_state_transcriptomics",
            "identification_strategy": {"design": "same-dataset robustness"}
        }),
    )
    .unwrap();
    write_json(
            &state_dir.join(format!("{cycle}-gate-review.json")),
            &json!({
                "gate_passed": false,
                "recommended_followup_actions": [
                    {
                        "type": "methods_followup",
                        "priority": "high",
                        "preferred_role": "analyst",
                        "target_rubric": "technical_quality",
                        "description": "audit whether the stale handoff result is biologically credible before any additional runner execution"
                    },
                    {
                        "type": "methods_followup",
                        "priority": "high",
                        "preferred_role": "lab-runner",
                        "target_rubric": "technical_quality",
                        "description": "run a parallel lab-runner contamination audit while the degraded handoff is still unresolved",
                        "handoff_checks": [{"check_id": "parallel_contamination_audit", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
                        "validation_code_blueprints": [{"code": "print('parallel audit')"}]
                    }
                ]
            }),
        )
        .unwrap();

    for index in 1..=63 {
        let dummy_lane = format!("followup-analyst-{index:02}");
        let dummy_dir = lane_root(&paths, cycle, &dummy_lane);
        fs::create_dir_all(&dummy_dir).unwrap();
        write_json(
            &dummy_dir.join("run-state.json"),
            &json!({"lane_id": dummy_lane, "role": "analyst", "status": "done"}),
        )
        .unwrap();
        write_json(
            &dummy_dir.join("final-status.json"),
            &json!({"status": "completed"}),
        )
        .unwrap();
    }

    let analyst_lane = "followup-analyst-76";
    let analyst_dir = lane_root(&paths, cycle, analyst_lane);
    fs::create_dir_all(&analyst_dir).unwrap();
    let handoff_path = analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &analyst_dir.join("run-state.json"),
        &json!({"lane_id": analyst_lane, "role": "analyst", "status": "done"}),
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
                "status": "ready",
                "summary": "In GSE282742, progression from MCI to AD is linked to mito-nuclear coordination in blood.",
                "handoff_checks": [
                    {"check_id": "label_shuffle_empirical_p_le_0_1", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"},
                    {"check_id": "normalization_sensitivity_corr_ge_0_7", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"},
                    {"check_id": "supplied_effect_corr_ge_0_8", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}
                ],
                "validation_code_blueprints": [{
                    "blueprint_id": "robustness-checks",
                    "code": "print('run robustness checks')"
                }],
                "selected_open_source_analysis_agent": {
                    "name": "python-open-source-workflow-adapter",
                    "application_command": "python open_source_workflow_adapter.py"
                }
            }),
        )
        .unwrap();

    let runner_lane = "followup-runner-59";
    let runner_dir = lane_root(&paths, cycle, runner_lane);
    fs::create_dir_all(&runner_dir).unwrap();
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({"lane_id": runner_lane, "role": "lab-runner", "status": "done"}),
    )
    .unwrap();
    write_json(
        &runner_dir.join("final-status.json"),
        &json!({"lane_id": runner_lane, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_dir.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": {
                "source_brief_id": "analyst-handoff",
                "action_type": "methods_followup",
                "planner_metadata": {
                    "analyst_handoff_path": handoff_path,
                    "analysis_request": {
                        "source": "latest-executable-analyst-handoff"
                    }
                }
            },
            "validation_summary": {
                "overall_status": "degraded",
                "checks_failed": 3,
                "blueprints_failed": 1,
                "failed_checks": [
                    "label_shuffle_empirical_p_le_0_1",
                    "normalization_sensitivity_corr_ge_0_7",
                    "supplied_effect_corr_ge_0_8"
                ],
                "external_agent_runs_total": 2
            }
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
            !created
                .iter()
                .any(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner")),
            "a degraded runner result with a pending analyst revision must not dispatch any lab-runner fallback for the same stale handoff"
        );

    let lab_director = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-director"))
        .expect("degraded handoff validation should queue LabDirector adjudication");
    assert!(
        lab_director
            .get("source_brief_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .starts_with("labdirector-runner-recovery"),
        "LabDirector recovery source should be lane-specific and retain the labdirector-runner-recovery prefix"
    );
    let role_plan_path = PathBuf::from(
        lab_director
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan.get("action_type").and_then(Value::as_str),
        Some("lab_director_requery_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["validation_results"]["overall_status"],
        json!("degraded")
    );
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["source"],
        json!("degraded-runner-labdirector-adjudication")
    );
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]
            ["lab_director_must_author_research_instruction"],
        json!(true)
    );
    let assigned = role_plan
        .get("assigned_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(
            assigned.iter().any(|item| item
                .as_str()
                .unwrap_or("")
                .contains("GSE282742")),
            "LabDirector recovery must keep the failed handoff's scientific hypothesis instead of stale reasoning-gap text"
        );
}

#[test]
fn newer_handoff_supersedes_degraded_runner_recovery_and_dispatches_latest_runner() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-degraded-runner-newer-handoff";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Recover stale runner output before gate review."}),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "A blood immune score separates progression phenotypes.",
            "identification_strategy": {"design": "runner recovery"}
        }),
    )
    .unwrap();
    for index in 1..=2 {
        let pending_lane = format!("followup-lab-director-{index:02}");
        let pending_dir = lane_root(&paths, cycle, &pending_lane);
        fs::create_dir_all(&pending_dir).unwrap();
        create_lane_contract(
            &paths,
            cycle,
            &pending_lane,
            "lab-director",
            "codex-agent",
            "run",
            "pending generic LabDirector action",
        )
        .unwrap();
        write_json(
            &pending_dir.join("role-plan.json"),
            &json!({
                "lane_id": pending_lane,
                "role": "lab-director",
                "action_type": "gate_restart_followup",
                "source_brief_id": format!("generic-pending-{index}")
            }),
        )
        .unwrap();
    }

    let old_analyst_lane = "followup-analyst-01";
    let old_analyst_dir = lane_root(&paths, cycle, old_analyst_lane);
    fs::create_dir_all(&old_analyst_dir).unwrap();
    let old_handoff_path = old_analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &old_analyst_dir.join("run-state.json"),
        &json!({"lane_id": old_analyst_lane, "role": "analyst", "status": "done"}),
    )
    .unwrap();
    write_json(
        &old_analyst_dir.join("final-status.json"),
        &json!({"lane_id": old_analyst_lane, "status": "completed"}),
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

    let runner_lane = "followup-runner-01";
    let runner_dir = lane_root(&paths, cycle, runner_lane);
    fs::create_dir_all(&runner_dir).unwrap();
    write_json(
        &runner_dir.join("run-state.json"),
        &json!({"lane_id": runner_lane, "role": "lab-runner", "status": "done"}),
    )
    .unwrap();
    write_json(
        &runner_dir.join("final-status.json"),
        &json!({"lane_id": runner_lane, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &runner_dir.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": {
                "source_brief_id": "analyst-handoff",
                "action_type": "methods_followup",
                "planner_metadata": {
                    "analyst_handoff_path": old_handoff_path,
                    "analyst_handoff": {
                        "summary": "Old executable handoff.",
                        "handoff_checks": [{"check_id": "old_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}]
                    }
                }
            },
            "validation_summary": {
                "overall_status": "degraded",
                "checks_failed": 1,
                "blueprints_failed": 0,
                "failed_checks": ["old_check"],
                "analyst_quality_standard": {"satisfied": false}
            }
        }),
    )
    .unwrap();

    let newer_analyst_lane = "followup-analyst-02";
    let newer_analyst_dir = lane_root(&paths, cycle, newer_analyst_lane);
    fs::create_dir_all(&newer_analyst_dir).unwrap();
    let newer_handoff_path = newer_analyst_dir.join("handoff-validation-plan.json");
    write_json(
        &newer_analyst_dir.join("run-state.json"),
        &json!({"lane_id": newer_analyst_lane, "role": "analyst", "status": "done"}),
    )
    .unwrap();
    write_json(
        &newer_analyst_dir.join("final-status.json"),
        &json!({"lane_id": newer_analyst_lane, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &newer_handoff_path,
        &json!({
            "status": "ready",
            "summary": "Newer executable handoff that has not yet been run.",
            "handoff_checks": [{"check_id": "new_check", "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
            "validation_code_blueprints": [{"blueprint_id": "new", "code": "print('new')"}]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    == "labdirector-runner-recovery-followup-runner-01"
        }),
        "a newer executable Analyst handoff supersedes recovery of the older degraded runner"
    );
    let replacement_runner = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("lab-runner"))
        .expect("newer executable handoff should dispatch a fresh lab-runner");
    let role_plan_path = PathBuf::from(
        replacement_runner
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["planner_metadata"]["analysis_request"]["handoff_path"],
        json!(newer_handoff_path.display().to_string())
    );
}

