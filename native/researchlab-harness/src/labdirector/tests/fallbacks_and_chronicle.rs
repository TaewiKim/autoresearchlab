#[test]
fn chronicle_graph_gate_requires_nonempty_literature_and_allowed_candidate_dataset() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-kg-order";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-literature-graph.json")),
        &json!({"nodes": [{"node_id": "mechanism:immune", "type": "concept"}], "edges": []}),
    )
    .unwrap();
    write_json(
            &state_dir.join(format!("{cycle}-data-graph.json")),
            &json!({"nodes": [{"node_id": "dataset:GSE282742", "type": "dataset", "metadata": {"forbidden_reuse": true}}], "edges": []}),
        )
        .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-trend-summary.json")),
        &json!({"cluster_labels": ["immune"]}),
    )
    .unwrap();
    assert!(
        !chronicle_graph_artifacts_ready(&paths, cycle),
        "forbidden-only data graph must not unblock LabDirector hypothesis generation"
    );
    write_json(
            &state_dir.join(format!("{cycle}-data-graph.json")),
            &json!({"nodes": [
                {"node_id": "dataset:GSE999999", "type": "dataset", "metadata": {"accession": "GSE999999", "materialized": false, "access_status": "open"}}
            ], "edges": []}),
        )
        .unwrap();
    assert!(
            chronicle_graph_artifacts_ready(&paths, cycle),
            "candidate dataset nodes should unblock KG-derived hypothesis generation even before materialization"
        );
}

#[test]
fn chronicle_graph_gate_accepts_materialized_bundle_when_legacy_data_graph_lacks_dataset_nodes() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-legacy-data-graph";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-literature-graph.json")),
        &json!({"nodes": [{"node_id": "mechanism:immune", "type": "concept"}], "edges": []}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-data-graph.json")),
        &json!({"nodes": [{"node_id": "variable:ifn", "type": "variable"}], "edges": []}),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-trend-summary.json")),
        &json!({"cluster_labels": ["immune"]}),
    )
    .unwrap();
    fs::create_dir_all(
        paths
            .runtime_root
            .join("datasets")
            .join(cycle)
            .join("gse228779"),
    )
    .unwrap();

    assert!(
        chronicle_graph_artifacts_ready(&paths, cycle),
        "legacy data graphs without dataset nodes should be accepted when a cycle-scoped materialized bundle exists"
    );
}

#[test]
fn validation_materialization_gate_accepts_current_hypothesis_dataset_bundle() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-materialized-current-lead";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "GSE228779 hypothesis",
            "validation_data_status": "needs_materialization",
            "identification_strategy": {"dataset_or_accession": "GSE228779"}
        }),
    )
    .unwrap();
    let bundle_dir = paths
        .runtime_root
        .join("datasets")
        .join(cycle)
        .join("gse228779");
    fs::create_dir_all(&bundle_dir).unwrap();
    fs::write(bundle_dir.join("table.csv"), "x\n1\n").unwrap();

    assert!(
        validation_materialization_gate_passed(&paths, cycle).unwrap(),
        "needs_materialization is stale when the selected accession has a non-empty cycle-scoped bundle"
    );
}

#[test]
fn fallback_action_injected_when_hypothesis_has_open_datasets_and_chronicle_silent() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-fallback-fires";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "BNP/NT-proBNP is the strongest biomarker family",
            "primary_family": "vf_natriuretic_peptides",
            "identification_strategy": {
                "design": "cross-cohort comparison",
                "open_datasets": [
                    {
                        "dataset_id": "ds_mimic_iv_hf",
                        "label": "MIMIC-IV adult heart-failure admissions",
                        "endpoint": "30-day all-cause readmission"
                    },
                    {
                        "dataset_id": "ds_zigong_hf",
                        "label": "Zigong hospitalized heart-failure cohort",
                        "endpoint": "28-day all-cause readmission"
                    }
                ]
            }
        }),
    )
    .unwrap();
    // chronicle only recommended verification-type actions
    let mut actions = vec![
        json!({"type": "verification", "description": "Verify variable coverage", "priority_score": 100}),
        json!({"type": "hypothesis_refinement", "description": "Frame hypothesis", "priority_score": 60}),
    ];
    inject_data_acquisition_fallback_action(&paths, cycle, &mut actions);
    let injected = actions
        .iter()
        .find(|a| a.get("type").and_then(Value::as_str) == Some("data_acquisition_followup"));
    assert!(
        injected.is_some(),
        "fallback must inject a data_acquisition_followup"
    );
    let injected = injected.unwrap();
    assert_eq!(
        injected.get("preferred_role").and_then(Value::as_str),
        Some("scout"),
        "fallback action must be routed to scout"
    );
    assert_eq!(
        injected.get("fallback_origin").and_then(Value::as_str),
        Some("lab_director_open_datasets")
    );
    let labels = injected
        .get("dataset_labels")
        .and_then(Value::as_array)
        .unwrap();
    let label_strs: Vec<&str> = labels.iter().filter_map(|v| v.as_str()).collect();
    assert!(label_strs.iter().any(|s| s.contains("MIMIC-IV")));
    assert!(label_strs.iter().any(|s| s.contains("Zigong")));
}

#[test]
fn fallback_action_not_injected_when_acquisition_action_already_present() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-fallback-already-present";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "identification_strategy": {
                "open_datasets": [{"label": "Some Dataset"}]
            }
        }),
    )
    .unwrap();
    let mut actions = vec![json!({
        "type": "data_acquisition_followup",
        "description": "chronicle already requested this",
        "priority_score": 100
    })];
    let before = actions.len();
    inject_data_acquisition_fallback_action(&paths, cycle, &mut actions);
    assert_eq!(
        actions.len(),
        before,
        "must not duplicate when chronicle already emitted the acquisition action"
    );
}

#[test]
fn fallback_action_skipped_when_hypothesis_file_missing() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let mut actions: Vec<Value> = vec![];
    inject_data_acquisition_fallback_action(&paths, "cycle-no-hypothesis", &mut actions);
    assert!(actions.is_empty(), "no hypothesis file → no fallback");
}

#[test]
fn fallback_action_skipped_when_open_datasets_empty() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-no-datasets";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "identification_strategy": {"design": "..." /* no open_datasets */}
        }),
    )
    .unwrap();
    let mut actions: Vec<Value> = vec![];
    inject_data_acquisition_fallback_action(&paths, cycle, &mut actions);
    assert!(
        actions.is_empty(),
        "hypothesis without open_datasets → no fallback"
    );
}

#[test]
fn followup_task_markdown_skips_directive_for_non_analyst_roles() {
    // The directive is analyst-specific (it talks about hypothesis
    // x_variable / y_variable matching). Scout / lab-runner / chronicle
    // followups must NOT receive it — that would just be prompt noise
    // for roles that have no dataset-picking duty.
    for role in ["scout", "lab-runner", "chronicle", "gatekeeper"] {
        let md = followup_task_markdown("cycle-test", "obj", role, "src", "do work", &[]);
        assert!(
            !md.contains("pick_dataset_for_hypothesis"),
            "{role} followup must not carry analyst-specific directive"
        );
    }
}

#[test]
fn labdirector_can_ask_chronicle_for_targeted_decision_evidence() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-labdirector-asks-chronicle";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Let LabDirector request missing Chronicle evidence."}),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "hypothesis-gate-labdirector-requery"
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
                "extracted_json": {
                    "decision_status": "needs_chronicle_evidence",
                    "requery_decision": "defer_for_chronicle",
                    "summary": "Need one clue before choosing.",
                    "chronicle_requests": [{
                        "question": "Find the exact GSE322943 TRM/TLS baseline definition and source path.",
                        "why_needed_for_decision": "This decides whether antigen/IFN failure beats the incumbent baseline.",
                        "source_scope": ["chronicle decision digest", "GSE322943 paper/supplement"],
                        "priority": "critical"
                    }]
                }
            }),
        )
        .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let chronicle = created
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("chronicle"))
        .expect("LabDirector evidence request should dispatch Chronicle");
    assert_eq!(
        chronicle.get("source_brief_id").and_then(Value::as_str),
        Some("followup-lab-director-01")
    );
    let chronicle_role_plan = read_json(&PathBuf::from(
        chronicle
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(
        chronicle_role_plan
            .get("action_type")
            .and_then(Value::as_str),
        Some("chronicle_evidence_request_followup")
    );
    let task_md = fs::read_to_string(
        lane_root(&paths, cycle, chronicle["lane_id"].as_str().unwrap()).join("task.md"),
    )
    .unwrap();
    assert!(task_md.contains("lab_director_question_answer_contract"));
    assert!(task_md.contains("TRM/TLS baseline"));
    assert!(
        !created.iter().any(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("chronicle-evidence-response-")
        }),
        "LabDirector continuation must wait until Chronicle evidence is completed"
    );
}

#[test]
fn deferred_chronicle_evidence_runs_before_the_dependent_gate_restart() {
    // MEASURED ON cycle-a-20260919, 2026-10-03: at conclusion,
    // followup-lab-director-366 through -370 each finished successfully with
    // defer_for_chronicle, the same Chronicle table request, and a gate restart
    // after that table. The flattened queue ran all five restarts first.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-chronicle-before-gate-restart";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Resolve novelty evidence, then restart the gate."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "Measured coverage does not make the procedures equivalent.",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-370");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-370",
            "role": "lab-director",
            "action_type": "gate_restart_followup",
            "source_brief_id": "followup-lab-director-369"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-370",
            "status": "completed",
            "completed_at": "2026-10-03T03:48:43Z"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "decision_status": "needs_chronicle_evidence",
                "requery_decision": "defer_for_chronicle",
                "chronicle_requests": [{
                    "question": "Persist the admitted-record five-row procedure table.",
                    "why_needed_for_decision": "Novelty cannot be adjudicated without it.",
                    "priority": "critical"
                }],
                "next_actions": [
                    {
                        "type": "chronicle_evidence_request_followup",
                        "preferred_role": "chronicle",
                        "description": "Persist the admitted-record five-row procedure table."
                    },
                    {
                        "type": "gate_restart_followup",
                        "preferred_role": "lab-director",
                        "description": "After the table exists, conduct the targeted gate review."
                    }
                ]
            }
        }),
    )
    .unwrap();

    let first = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].get("role").and_then(Value::as_str),
        Some("chronicle"),
        "first dispatch was {first:#?}"
    );
    let chronicle_lane_id = first[0]["lane_id"].as_str().unwrap();
    let chronicle_lane = lane_root(&paths, cycle, chronicle_lane_id);
    write_json(
        &chronicle_lane.join("final-status.json"),
        &json!({
            "lane_id": chronicle_lane_id,
            "status": "completed",
            "completed_at": "2026-10-03T03:50:00Z"
        }),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("result.json"),
        &json!({"extracted_json": {"answer": "The bounded table is persisted."}}),
    )
    .unwrap();
    crate::runtime::update_sqlite_contract_queue_status(
        &paths,
        cycle,
        chronicle_lane_id,
        "completed",
        None,
    )
    .unwrap();

    assert_eq!(
        pending_labdirector_chronicle_prerequisite(&paths, cycle).unwrap(),
        None,
        "the completed Chronicle answer must release gate work"
    );
    let mut actions = Vec::new();
    let mut hypotheses = HashMap::new();
    collect_labdirector_requery_actions(&paths, cycle, &mut actions, &mut hypotheses).unwrap();
    assert!(
        actions.iter().any(|action| {
            action.get("type").and_then(Value::as_str) == Some("gate_restart_followup")
                && action.get("brief_id").and_then(Value::as_str)
                    == Some("followup-lab-director-370")
        }),
        "the dependent gate restart must become eligible after Chronicle completes"
    );
}

#[test]
fn falsification_release_bypasses_the_retired_leads_chronicle_prerequisite() {
    // MEASURED ON cycle-a-20260919, 2026-10-07: at owner_selection,
    // 139 runner-audit lanes had finished while an old defer_for_chronicle
    // request suppressed the LabDirector action that alone could replace the
    // method validly falsified by followup-runner-188.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-falsification-replaces-before-stale-chronicle";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Replace the falsified method for the surviving question."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "The retired coverage method.",
            "selected_at_epoch_ms": 1791407645680_i64,
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lead-protection.json")),
        &json!({
            "ts": "2026-10-07T23:22:02.666Z",
            "decision": "allow",
            "reason": "lead_falsified_by_completed_run",
            "lead": "hyp:retired",
            "directive": "Select and record a replacement method for the surviving research question."
        }),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-515");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-515",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "gate-review-before-falsification"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-515",
            "status": "completed",
            "completed_at": "2026-10-07T22:35:31Z"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "requery_decision": "defer_for_chronicle",
                "chronicle_requests": [{
                    "question": "Audit the retired method's closest procedure.",
                    "why_needed_for_decision": "It was needed before Runner-188 falsified the method."
                }],
                "next_actions": [
                    {
                        "type": "chronicle_evidence_request_followup",
                        "preferred_role": "chronicle",
                        "description": "Audit the retired method's closest procedure."
                    },
                    {
                        "type": "lab_director_requery_followup",
                        "preferred_role": "lab-director",
                        "target_rubric": "gate_independence",
                        "description": "Select the replacement method required by the falsification release."
                    }
                ]
            }
        }),
    )
    .unwrap();

    assert_eq!(
        pending_labdirector_chronicle_prerequisite(&paths, cycle).unwrap(),
        Some("followup-lab-director-515".to_string())
    );
    let created = dispatch_followup_lanes(&paths, cycle, 2).unwrap();
    assert!(
        created.iter().any(|lane| {
            if lane.get("role").and_then(Value::as_str) != Some("lab-director") {
                return false;
            }
            let Some(role_plan_path) = lane.get("role_plan_path").and_then(Value::as_str) else {
                return false;
            };
            read_json(Path::new(role_plan_path))
                .ok()
                .and_then(|plan| plan.get("action_type").cloned())
                .and_then(|value| value.as_str().map(ToString::to_string))
                .as_deref()
                == Some("lab_director_requery_followup")
        }),
        "the replacement decision lane must advance owner_selection despite the retired lead's prerequisite: {created:#?}"
    );

    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "A newer replacement method.",
            "selected_at_epoch_ms": 1791415500000_i64,
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    assert!(
        !active_lead_falsification_release(&paths, cycle),
        "the old release must stop bypassing prerequisites after the replacement is selected"
    );
}

#[test]
fn falsification_release_dispatches_replacement_before_retired_method_work() {
    // MEASURED ON cycle-a-20260919, 2026-10-08: owner_selection had
    // 1,021 finished lanes, including 121 methods follow-ups. After the live
    // lead was falsified, a runner-ready handoff for a successor and recurring
    // reviews still outranked the LabDirector decision required to select it.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-falsification-replacement-outranks-handoff";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Replace the falsified method for the surviving question."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "The retired support-risk calibration method.",
            "selected_at_epoch_ms": 1791420208378_i64,
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lead-protection.json")),
        &json!({
            "ts": "2026-10-08T07:37:37.457Z",
            "decision": "allow",
            "reason": "lead_falsified_by_completed_run",
            "lead": "hyp:d5718e3920d17fc6",
            "directive": "Select and record a replacement method for the surviving research question."
        }),
    )
    .unwrap();
    // The dispatcher's older append-only view may still end in a commit-window
    // deny. The typed live release is newer and is the decision that must win.
    fs::write(
        state_root(&paths).join(format!("{cycle}-hypothesis-progress.jsonl")),
        serde_json::to_string(&json!({
            "event_type": "lead_supersession_decision",
            "decision": {"decision": "deny", "reason": "novelty_refinement_window"}
        }))
        .unwrap(),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-524");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-524",
            "role": "lab-director",
            "action_type": "gate_restart_followup",
            "source_brief_id": "pre-falsification-review"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("final-status.json"),
        &json!({
            "lane_id": "followup-lab-director-524",
            "status": "completed",
            "completed_at": "2026-10-08T07:10:24Z"
        }),
    )
    .unwrap();
    write_json(
        &director_lane.join("result.json"),
        &json!({"extracted_json": {
            "decision_status": "final",
            "requery_decision": "uphold",
            "selected_hypothesis": {"statement": "The retired support-risk calibration method."},
            "next_actions": [{
                "type": "methods_followup",
                "preferred_role": "analyst",
                "description": "Keep reproducing the retired method's statistics."
            }]
        }}),
    )
    .unwrap();

    let analyst_lane_id = "followup-analyst-502";
    let analyst_lane = lane_root(&paths, cycle, analyst_lane_id);
    fs::create_dir_all(&analyst_lane).unwrap();
    create_lane_contract(
        &paths,
        cycle,
        analyst_lane_id,
        "analyst",
        "external-driver",
        "driver-exec",
        "runner-ready successor handoff fixture",
    )
    .unwrap();
    write_json(
        &analyst_lane.join("final-status.json"),
        &json!({"lane_id": analyst_lane_id, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &analyst_lane.join("handoff-validation-plan.json"),
        &json!({
            "status": "ready_for_runner",
            "summary": "A successor method that the director has not selected yet.",
            "handoff_checks": [{
                "check_id": "successor_check",
                "exposures": ["support_distance"],
                "dataset": "materialized-bundle"
            }],
            "validation_code_blueprints": [{"blueprint_id": "successor", "code": "print('run')"}]
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["role"], json!("lab-director"));
    assert!(created[0]["source_brief_id"]
        .as_str()
        .unwrap_or("")
        .starts_with("lead-falsification-replacement-"));
    let role_plan = read_json(&PathBuf::from(
        created[0]["role_plan_path"].as_str().unwrap(),
    ))
    .unwrap();
    assert_eq!(
        role_plan["action_type"],
        json!("lab_director_requery_followup")
    );
    assert_eq!(
        role_plan["planner_metadata"]["falsification_replacement_required"],
        json!(true)
    );

    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "The selected successor method.",
            "selected_at_epoch_ms": 1791445100000_i64,
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
    assert!(
        !active_lead_falsification_release(&paths, cycle),
        "a newer selected successor must advance beyond the owner_selection release"
    );
}

#[test]
fn chronicle_waits_for_the_directors_ordered_review_bundle_prerequisite() {
    // MEASURED ON cycle-a-20260919, 2026-10-06: at conclusion,
    // followup-chronicle-176 through -179 completed without milestone progress.
    // The latest director ordered local review-bundle finalization first, but
    // its higher-priority structured Chronicle request ran before that bundle
    // existed and could only repeat corpus_too_thin_to_say.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-chronicle-review-bundle-prerequisite";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Finalize the review bundle before adjudicating it."}),
    )
    .unwrap();
    write_stage_gate_search_inputs(&paths, cycle);
    write_stage_gate_kg(&paths, cycle);
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "The now-falsified incumbent remains recorded.",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();

    for lane_number in 176..=179 {
        let lane_id = format!("followup-chronicle-{lane_number}");
        let lane = lane_root(&paths, cycle, &lane_id);
        fs::create_dir_all(&lane).unwrap();
        write_json(
            &lane.join("role-plan.json"),
            &json!({
                "lane_id": lane_id,
                "role": "chronicle",
                "action_type": "chronicle_evidence_request_followup",
                "source_brief_id": format!("followup-lab-director-{}", lane_number + 260)
            }),
        )
        .unwrap();
        write_json(
            &lane.join("final-status.json"),
            &json!({"lane_id": lane_id, "status": "completed"}),
        )
        .unwrap();
        write_json(
            &lane.join("result.json"),
            &json!({"extracted_json": {"verdict": "corpus_too_thin_to_say"}}),
        )
        .unwrap();
    }

    let director_lane_id = "followup-lab-director-447";
    let director_lane = lane_root(&paths, cycle, director_lane_id);
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": director_lane_id,
            "role": "lab-director",
            "action_type": "blocking_lane_recovery_planning"
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
        &json!({"extracted_json": {
            "decision_status": "needs_chronicle_evidence",
            "requery_decision": "defer_for_chronicle",
            "chronicle_requests": [{
                "question": "After the review bundle exists, adjudicate the forced-disturbance procedure.",
                "why_needed_for_decision": "The replacement cannot be selected without it.",
                "priority": "critical"
            }],
            "next_actions": [
                {
                    "type": "novelty_followup",
                    "preferred_role": "scout",
                    "description": "Finalize the existing exact-hash review bundle."
                },
                {
                    "type": "chronicle_evidence_request_followup",
                    "preferred_role": "chronicle",
                    "description": "After the finalized review bundle exists, adjudicate it."
                }
            ]
        }}),
    )
    .unwrap();

    let first = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    assert_eq!(first.len(), 1, "the review prerequisite was not runnable");
    assert_eq!(first[0]["role"], json!("scout"), "first dispatch was {first:#?}");
    let scout_lane_id = first[0]["lane_id"].as_str().unwrap();
    let scout_lane = lane_root(&paths, cycle, scout_lane_id);
    write_json(
        &scout_lane.join("final-status.json"),
        &json!({"lane_id": scout_lane_id, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &scout_lane.join("result.json"),
        &json!({"status": "completed", "review_bundle_finalized": true}),
    )
    .unwrap();
    crate::runtime::update_sqlite_contract_queue_status(
        &paths,
        cycle,
        scout_lane_id,
        "completed",
        None,
    )
    .unwrap();

    let second = dispatch_followup_lanes(&paths, cycle, 1).unwrap();
    assert_eq!(second.len(), 1, "Chronicle did not resume after its prerequisite");
    assert_eq!(second[0]["role"], json!("chronicle"), "second dispatch was {second:#?}");
    assert_eq!(
        second[0]["source_brief_id"],
        json!(director_lane_id),
        "the released request must adjudicate the current director decision"
    );
}

#[test]
fn completed_chronicle_answer_reopens_labdirector_adjudication() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-chronicle-answer-reopens-director";
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Continue LabDirector after Chronicle answers."}),
    )
    .unwrap();

    let director_lane = lane_root(&paths, cycle, "followup-lab-director-01");
    fs::create_dir_all(&director_lane).unwrap();
    write_json(
        &director_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-01",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "hypothesis-gate-labdirector-requery"
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
            "extracted_json": {
                "decision_status": "needs_chronicle_evidence",
                "requery_decision": "defer_for_chronicle",
                "chronicle_requests": [{"question": "Which source defines the baseline?"}]
            }
        }),
    )
    .unwrap();

    let chronicle_lane = lane_root(&paths, cycle, "followup-chronicle-01");
    fs::create_dir_all(&chronicle_lane).unwrap();
    write_json(
        &chronicle_lane.join("role-plan.json"),
        &json!({
            "lane_id": "followup-chronicle-01",
            "role": "chronicle",
            "action_type": "chronicle_evidence_request_followup",
            "source_brief_id": "followup-lab-director-01"
        }),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("final-status.json"),
        &json!({"lane_id": "followup-chronicle-01", "status": "completed"}),
    )
    .unwrap();
    write_json(
        &chronicle_lane.join("result.json"),
        &json!({
            "extracted_json": {
                "lab_director_question_answer": {
                    "answer": "The baseline is the paper's TRM-high/TLS-positive classifier.",
                    "source_paths": [".research-lab/state/baseline.json"],
                    "confidence": "high"
                }
            }
        }),
    )
    .unwrap();

    let created = dispatch_followup_lanes(&paths, cycle, 4).unwrap();
    let director = created
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("lab-director")
                && item
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("chronicle-evidence-response-")
        })
        .expect("completed Chronicle answer should reopen LabDirector adjudication");
    assert!(director
        .get("source_brief_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .starts_with("chronicle-evidence-response-followup-lab-director-01"));
    let role_plan = read_json(&PathBuf::from(
        director
            .get("role_plan_path")
            .and_then(Value::as_str)
            .unwrap(),
    ))
    .unwrap();
    assert!(
        role_plan["planner_metadata"]["chronicle_evidence_responses"]
            .as_array()
            .map(|items| !items.is_empty())
            .unwrap_or(false)
    );
}
