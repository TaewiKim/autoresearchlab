#[test]
fn generic_robot_prompts_do_not_inject_renderer_apis_or_costs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let task_path = dir.path().join("task.md");
    let objective =
        "Study robot manipulation in simulation with repeated trials and measured task outcomes";
    std::fs::write(&task_path, objective).unwrap();
    for role in ["analyst", "lab-director", "gatekeeper"] {
        let mut contract = test_contract(role, task_path.clone());
        contract.cwd = dir.path().to_path_buf();
        let prompt = build_codex_prompt(&contract, Some(&json!({ "objective": objective })))
            .expect("prompt builds");
        let lower = prompt.to_lowercase();
        for unwanted in [
            "mitsuba",
            "mi.render",
            "mi.load_dict",
            "mi.register_integrator",
            "equal spp",
            "equal ray count",
            "36s of render",
            "render_time_s",
        ] {
            assert!(
                !lower.contains(unwanted),
                "{role} prompt injected {unwanted}"
            );
        }
        if role == "analyst" {
            assert!(prompt.contains("HARD WALL-CLOCK BUDGET"));
            assert!(prompt.contains("matched_budget"));
            assert!(prompt.contains("valid_falsification"));
        }
    }
}

#[test]
fn codex_prompt_hard_truncates_oversized_tail() {
    let dir = tempfile::tempdir().expect("tempdir");
    let task_path = dir.path().join("task.md");
    std::fs::write(&task_path, "# Task\nSummarize and decide.").unwrap();
    let role_plan = json!({
        "lane_id": "lab-director-01",
        "role": "lab-director",
        "objective": "make a decision",
        "planner_metadata": {
            "candidate_datasets": ["x".repeat(1_200_000)],
            "data_graph": { "nodes": ["y".repeat(1_200_000)] }
        },
        "materialized_dataset_context": "z".repeat(1_200_000)
    });
    let prompt = build_codex_prompt(&test_contract("lab-director", task_path), Some(&role_plan))
        .expect("prompt builds");
    assert!(
        prompt.as_bytes().len() <= 650_000,
        "prompt bytes={}",
        prompt.as_bytes().len()
    );
    assert!(prompt.contains("tail truncated") || prompt.contains("hard input byte limit"));
}

#[test]
fn codex_failure_category_detects_codex_input_length_error() {
    assert_eq!(
            codex_failure_category(
                "",
                "Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters.",
                "",
                false,
            ),
            Some("context_window_exceeded")
        );
}

#[test]
fn normalize_grows_vocabulary_from_observed_types() {
    let graph = json!({
        "nodes": [
            {"id": "family:foo", "type": "family"},
            {"id": "ds:landsat", "type": "dataset"},
            {"id": "ds:ecostress", "type": "dataset"}
        ],
        "edges": [
            {"id": "e1", "from": "family:foo", "to": "ds:landsat", "relation": "supports"}
        ]
    });
    let path = write_tmp_graph(graph);
    normalize_graph_vocabulary(&path).expect("normalize");
    let g: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let vocab = g.get("vocabulary").unwrap();
    let nt = vocab.get("node_types").and_then(|v| v.as_array()).unwrap();
    let er = vocab
        .get("edge_relations")
        .and_then(|v| v.as_array())
        .unwrap();
    let nt_strs: Vec<&str> = nt.iter().filter_map(|v| v.as_str()).collect();
    let er_strs: Vec<&str> = er.iter().filter_map(|v| v.as_str()).collect();
    assert!(nt_strs.contains(&"family"));
    assert!(nt_strs.contains(&"dataset"));
    assert!(er_strs.contains(&"supports"));
}

#[test]
fn normalize_preserves_orphan_vocabulary_entries() {
    // Vocabulary registers a type that no surviving node uses; the
    // normalizer must keep it (graphs lose nodes between passes).
    let graph = json!({
        "vocabulary": {"node_types": ["retired_type"], "edge_relations": []},
        "nodes": [{"id": "family:foo", "type": "family"}],
        "edges": []
    });
    let path = write_tmp_graph(graph);
    normalize_graph_vocabulary(&path).expect("normalize");
    let g: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let nt = g
        .get("vocabulary")
        .and_then(|v| v.get("node_types"))
        .and_then(|v| v.as_array())
        .unwrap();
    let nt_strs: Vec<&str> = nt.iter().filter_map(|v| v.as_str()).collect();
    assert!(nt_strs.contains(&"retired_type"), "orphan dropped");
    assert!(nt_strs.contains(&"family"), "observed type lost");
}

#[test]
fn normalize_chronicle_result_payload_promotes_embedded_counts() {
    let claim_deltas = (1..=6)
        .map(|idx| {
            json!({
                "claim_id": format!("claim-{idx}"),
                "previous": "tentative",
                "current": "exploratory",
                "reason": format!("reason-{idx}"),
            })
        })
        .collect::<Vec<_>>();
    let open_questions = (1..=3)
        .map(|idx| json!(format!("open-question-{idx}")))
        .collect::<Vec<_>>();
    let recommended_actions = (1..=4)
        .map(|idx| {
            json!({
                "type": format!("action-{idx}"),
                "priority": "high",
                "description": format!("recommended-action-{idx}"),
            })
        })
        .collect::<Vec<_>>();
    let hypothesis_candidates = vec![json!("candidate-a"), json!("candidate-b")];
    let mut payload = json!({
        "status": "completed",
        "claim_delta_count": 0,
        "claim_deltas": [],
        "open_question_count": 0,
        "open_questions": [],
        "recommended_action_count": 0,
        "recommended_actions": [],
        "hypothesis_candidate_count": 0,
        "hypothesis_candidates": [],
        "strategy_advice": {
            "mode": "hold",
            "reason": "stale top-level strategy"
        },
        "extracted_json": {
            "summary": "soft-complete payload with usable deltas",
            "claim_deltas": claim_deltas,
            "open_questions": open_questions,
            "recommended_actions": recommended_actions,
            "hypothesis_candidates": hypothesis_candidates,
            "strategy_advice": {
                "mode": "refine",
                "reason": "embedded payload remains actionable"
            }
        }
    });

    normalize_chronicle_result_payload(&mut payload);

    assert_eq!(
        payload["summary"],
        json!("soft-complete payload with usable deltas")
    );
    assert_eq!(payload["claim_delta_count"], json!(6));
    assert_eq!(payload["open_question_count"], json!(3));
    assert_eq!(payload["recommended_action_count"], json!(4));
    assert_eq!(payload["hypothesis_candidate_count"], json!(2));
    assert_eq!(payload["claim_deltas"].as_array().unwrap().len(), 6);
    assert_eq!(payload["open_questions"].as_array().unwrap().len(), 3);
    assert_eq!(payload["recommended_actions"].as_array().unwrap().len(), 4);
    assert_eq!(
        payload["hypothesis_candidates"].as_array().unwrap().len(),
        2
    );
    assert_eq!(payload["strategy_advice"]["mode"], json!("refine"));
}

#[test]
fn data_scout_fetch_is_validation_stage_only() {
    let initial_search = json!({
        "planner_metadata": {
            "initial_lane": true,
            "source_discovery_mode": "initial-open-data-search"
        }
    });
    assert!(!data_scout_should_fetch(Some(&initial_search)));

    let hypothesis_restart_search = json!({
        "source_brief_id": "hypothesis-gate-literature-restart",
        "planner_metadata": {"target_rubric": "hypothesis_gate"}
    });
    assert!(!data_scout_should_fetch(Some(&hypothesis_restart_search)));

    let validation_materialization = json!({
        "source_brief_id": "stage-gate-validation-materialization",
        "planner_metadata": {"target_rubric": "validation_materialization_gate"}
    });
    assert!(data_scout_should_fetch(Some(&validation_materialization)));

    let materialization_recovery = json!({
        "source_brief_id": "strategy_pivot",
        "planner_metadata": {
            "fetch_policy": "fetch",
            "source_discovery_mode": "validation-materialization-fetch"
        }
    });
    assert!(data_scout_should_fetch(Some(&materialization_recovery)));

    let initial_fetch_policy_is_still_discovery_only = json!({
        "planner_metadata": {
            "initial_lane": true,
            "fetch_policy": "fetch",
            "source_discovery_mode": "initial-open-data-search"
        }
    });
    assert!(!data_scout_should_fetch(Some(
        &initial_fetch_policy_is_still_discovery_only
    )));
}

#[test]
fn classifies_context_window_failures() {
    let category = codex_failure_category(
        "",
        "Error: context_length_exceeded maximum context length reached",
        "",
        false,
    );
    assert_eq!(category, Some("context_window_exceeded"));
}

#[test]
fn classifies_quota_failures() {
    let category = codex_failure_category(
        "",
        "insufficient_quota billing_hard_limit_reached",
        "",
        false,
    );
    assert_eq!(category, Some("quota_exceeded"));
}

#[test]
fn a_filename_the_agent_read_is_not_a_quota_failure() {
    // followup-analyst-221, cycle-g-v89, 2026-09-10 18:13. The runtime reported
    // a transient capacity error; the agent had listed `.research-lab/state`,
    // whose listing contained an archived halt file with "quota" in its NAME.
    // That one word inside 211,788 bytes of transcript made the lane
    // quota_exceeded and halted the cycle for four hours.
    let stdout = concat!(
        "{\"type\":\"thread.started\",\"thread_id\":\"01a08a94\"}\n",
        "{\"type\":\"turn.started\"}\n",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",",
        "\"command\":\"/bin/bash -lc 'ls .research-lab/state'\",\"aggregated_output\":\"",
        "cycle-g-v89-20260831-watchdog-halt.json.cleared-20260909-quota-window-and-author-context-slim\\n",
        "cycle-g-v89-20260831-paper-review.json\"}}\n",
        "{\"type\":\"error\",\"message\":\"Selected model is at capacity. Please try a different model.\"}\n",
        "{\"type\":\"turn.failed\",\"error\":{\"message\":\"Selected model is at capacity. Please try a different model.\"}}\n",
    );
    // A busy model is its own category, and specifically NOT a quota failure:
    // one halts the cycle, the other costs a retry on the next model in the
    // chain.
    assert_eq!(
        codex_failure_category(stdout, "", "", false),
        Some("model_at_capacity")
    );
}

#[test]
fn a_real_usage_limit_is_still_a_quota_failure() {
    // followup-illustrator-09 and followup-gatekeeper-312, 2026-09-09. The
    // runtime said it outright, and it must keep halting the cycle.
    let stdout = concat!(
        "{\"type\":\"turn.started\"}\n",
        "{\"type\":\"error\",\"message\":\"You've hit your usage limit. Visit ",
        "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ",
        "Sep 15th, 2026 5:26 PM.\"}\n",
    );
    assert_eq!(
        codex_failure_category(stdout, "", "", false),
        Some("quota_exceeded")
    );
}

#[test]
fn an_agent_reading_about_rate_limits_does_not_fail_the_lane() {
    // The same hole, in the branches beside quota: an agent that greps a source
    // file mentioning rate limits, or a listing whose byte count contains 403,
    // must not name this lane's cause of death.
    let stdout = concat!(
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",",
        "\"command\":\"/bin/bash -lc 'rg -n rate_limit src'\",",
        "\"aggregated_output\":\"src/cli/index.js:403: // retry on rate limit / 429 too many requests\"}}\n",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":366382}}\n",
    );
    assert_eq!(codex_failure_category(stdout, "", "", false), None);
}

#[test]
fn plain_text_stderr_is_still_read() {
    // Not every runtime speaks JSON, and stderr is the runtime's own channel.
    assert_eq!(
        codex_failure_category("", "insufficient_quota", "", false),
        Some("quota_exceeded")
    );
}

#[test]
fn classifies_rate_limit_failures() {
    let category = codex_failure_category("", "rate limit exceeded: too many requests", "", false);
    assert_eq!(category, Some("rate_limited"));
}

#[test]
fn classifies_auth_refresh_failures() {
    let category = codex_failure_category(
        "",
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        "",
        false,
    );
    assert_eq!(category, Some("auth_refresh_wait"));
}

#[test]
fn classifies_oauth_permission_failures_as_auth_refresh() {
    let category = codex_failure_category(
            "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"errors\":[\"Error: 403 {\\\"type\\\":\\\"error\\\",\\\"error\\\":{\\\"type\\\":\\\"permission_error\\\",\\\"message\\\":\\\"OAuth authentication is currently not allowed for this organization.\\\"}}\"]}",
            "",
            "",
            false,
        );
    assert_eq!(category, Some("auth_refresh_wait"));
}

#[test]
fn uses_role_aligned_timeout_defaults() {
    let contract = LaneContract {
        cycle_id: "cycle-0001".to_string(),
        lane_id: "gatekeeper-01".to_string(),
        role: "gatekeeper".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "async".to_string(),
        cwd: PathBuf::from("/tmp"),
        task_file: PathBuf::from("/tmp/task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    assert_eq!(codex_timeout_seconds(&contract, None), 1_200);
    assert_eq!(
        codex_timeout_seconds(
            &contract,
            Some(&json!({ "action_type": "recovery_followup" }))
        ),
        1_500
    );
}

// cycle-a-20260919: the ordered experiment builds its scene,
// demonstrations and policy arms and then runs every condition x seed x episode.
// On the engineer's 900 s default it spent 120 of them on one dependency.
#[test]
fn the_ordered_experiment_gets_its_own_budget() {
    let contract = LaneContract {
        cycle_id: "cycle-0001".to_string(),
        lane_id: "followup-engineer-02".to_string(),
        role: "engineer".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "async".to_string(),
        cwd: PathBuf::from("/tmp"),
        task_file: PathBuf::from("/tmp/task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    assert_eq!(codex_timeout_seconds(&contract, None), 900);
    assert_eq!(
        codex_timeout_seconds(
            &contract,
            Some(&json!({
                "action_type": crate::labdirector::SIMULATION_DATA_GENERATION_ACTION
            }))
        ),
        7_200
    );
}

#[test]
fn landscape_and_novelty_scouts_are_not_held_to_the_scout_search_budget() {
    let contract = LaneContract {
        cycle_id: "cycle-0001".to_string(),
        lane_id: "followup-scout-01".to_string(),
        role: "scout".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "async".to_string(),
        cwd: PathBuf::from("/tmp"),
        task_file: PathBuf::from("/tmp/task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    };
    // A plain literature scout has the literature-search budget, below the
    // landscape's and above the novelty refutation's.
    assert_eq!(codex_timeout_seconds(&contract, None), 2_700);
    let restart = json!({ "action_type": "reasoning_literature_scout" });
    assert_eq!(codex_timeout_seconds(&contract, Some(&restart)), 2_700);
    let landscape = json!({ "action_type": crate::labdirector::FIELD_LANDSCAPE_SCOUT_ACTION });
    assert_eq!(codex_timeout_seconds(&contract, Some(&landscape)), 3_600);
    let novelty = json!({ "action_type": crate::labdirector::NOVELTY_REFUTATION_ACTION });
    assert_eq!(codex_timeout_seconds(&contract, Some(&novelty)), 2_400);
}

#[test]
fn disables_snapshot_features_by_default() {
    let features = codex_disabled_features();
    assert!(features.iter().any(|item| item == "shell_snapshot"));
}

#[test]
fn removed_ghost_snapshot_override_is_never_forwarded_to_strict_codex() {
    assert!(parse_codex_config_overrides(None).is_empty());
    assert_eq!(
        parse_codex_config_overrides(Some(
            "ghost_snapshot.enabled=false, model_verbosity=\"low\", ghost_snapshot.enabled=true"
        )),
        vec!["model_verbosity=\"low\"".to_string()]
    );
}

#[test]
fn chronicle_continuation_prompt_restates_artifact_paths_and_demands_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let task_path = dir.path().join("task.md");
    std::fs::write(&task_path, "# Task").unwrap();
    let contract = test_contract("chronicle", task_path);
    let state_dir = dir.path().join("state");
    let prompt = crate::runtime::codex_lane::build_chronicle_continuation_prompt(
        &contract,
        &state_dir,
        1,
        "I'm pulling the exact abstracts so the graph edges and trend summary can cite themes.",
    );
    // Restates the three exact KG artifact filenames the lane must write.
    assert!(prompt.contains("cycle-test-literature-graph.json"));
    assert!(prompt.contains("cycle-test-data-graph.json"));
    assert!(prompt.contains("cycle-test-trend-summary.json"));
    // Feeds back the model's own truncated last message so it resumes
    // instead of re-planning.
    assert!(prompt.contains("pulling the exact abstracts"));
    // Directs the model to emit files rather than narrate.
    assert!(prompt.contains("produce the FILES"));
    assert!(prompt.contains("Do NOT re-plan"));
    assert!(prompt.contains(crate::runtime::codex_prompt::ABSTRACT_SCREENING_POLICY));
    assert!(prompt.contains(crate::runtime::codex_prompt::RESEARCH_API_POLICY));
    assert!(prompt.contains("do not invent graph evidence"));
}

#[test]
fn lab_director_prompt_carries_novelty_rejection_pivot_rule() {
    let dir = tempfile::tempdir().expect("tempdir");
    let task_path = dir.path().join("task.md");
    std::fs::write(&task_path, "# Task\nDecide the lead.").unwrap();
    let role_plan = json!({
        "lane_id": "lab-director-01",
        "role": "lab-director",
        "objective": "decide",
    });
    let prompt = build_codex_prompt(&test_contract("lab-director", task_path), Some(&role_plan))
        .expect("prompt builds");
    assert!(prompt.contains("Novelty-rejection pivot rule"));
    // Must forbid upholding a novelty-rejected lead without new evidence.
    assert!(prompt.contains("MUST NOT answer requery_decision=uphold"));
    assert!(prompt.contains("family_switch_recommendations"));
}

#[test]
fn chronicle_continuation_default_passes_is_two_when_env_unset() {
    // Only assert the default when the override is absent in this process,
    // to avoid interference from a globally-set env var.
    if std::env::var("RESEARCHLAB_CHRONICLE_CONTINUATION_MAX_PASSES").is_err() {
        assert_eq!(
            crate::runtime::codex_lane::chronicle_continuation_max_passes(),
            2
        );
    }
}
