    fn analyst_contract() -> LaneContract {
        LaneContract {
            cycle_id: "cycle-analyst-0001".to_string(),
            lane_id: "analyst-01".to_string(),
            role: "analyst".to_string(),
            runtime_class: "codex-agent".to_string(),
            mode: "async".to_string(),
            cwd: PathBuf::from("/tmp"),
            task_file: PathBuf::from("/tmp/task.md"),
            allowed_inputs: Vec::new(),
            allowed_outputs: Vec::new(),
            output_artifact: None,
            fallback_strategy: None,
        }
    }

    #[test]
    fn analyst_prompt_requires_code_blueprint_and_self_review() {
        let contract = analyst_contract();
        let prompt = build_codex_prompt(
            &contract,
            Some(&json!({
                "role": "analyst",
                "analysis_goal": "produce a decisive validation handoff"
            })),
        )
        .expect("prompt should render");
        assert!(prompt.contains("validation_code_blueprints"));
        assert!(prompt.contains("self_review"));
        assert!(prompt.contains("open_source_agent_discovery"));
        assert!(prompt.contains("selected_open_source_analysis_agent"));
        assert!(prompt.contains("smoke_test_command"));
        assert!(prompt.contains("debug_attempts"));
        assert!(prompt.contains("failed_runner_context"));
        assert!(prompt.contains("generic single-library adapter"));
        assert!(prompt.contains("Do not hardcode AutoBA"));
        assert!(prompt.contains("Generate at least one concrete validation-code blueprint"));
        assert!(prompt.contains("analyst_quality_standard"));
        assert!(prompt.contains("Analyst-controlled LabRunner loop"));
    }

    #[test]
    fn post_run_interpretation_emits_the_report_that_releases_the_gate() {
        // MEASURED ON cycle-a-20260919, 2026-10-17: Analyst 963, 968,
        // and 973 completed runner_result_interpretation_followup, but the
        // pre-run schema made all three emit handoffs and none could emit the
        // lab_director_validation_report consumed by the post-run gate.
        let contract = analyst_contract();
        let role_plan = json!({
            "role": "analyst",
            "action_type": "runner_result_interpretation_followup",
            "source_brief_id": "followup-runner-454",
            "planner_metadata": {"validation_results": {"overall_status": "passed"}}
        });
        let prompt = build_codex_prompt(&contract, Some(&role_plan)).expect("prompt should render");
        assert!(prompt.contains("lab_director_validation_report"));
        assert!(prompt.contains("This is POST-RUN interpretation"));
        assert!(!prompt.contains("Generate at least one concrete validation-code blueprint"));

        let schema = codex_output_schema("analyst", "runner_result_interpretation_followup")
            .expect("post-run schema");
        let properties = schema["properties"].as_object().expect("schema properties");
        assert!(properties.contains_key("lab_director_validation_report"));
        assert!(!properties.contains_key("validation_code_blueprints"));
        let report = &schema["properties"]["lab_director_validation_report"];
        let required = report["required"].as_array().expect("required report fields");
        for field in [
            "hypothesis_decision",
            "effect_direction",
            "controls",
            "negative_controls",
            "confounder_assessment",
            "protocol_deviations",
            "failure_modes",
            "artifacts",
        ] {
            assert!(required.iter().any(|item| item == field), "missing {field}");
        }
    }

    // MEASURED ON cycle-a-20260919, 2026-09-28: the strict analyst
    // schema had no field for readiness, the harness wrote ready_for_runner=false
    // in the analyst's name, and all 163 handoffs were blocked -- including ones
    // whose summaries said the handoff was ready.
    #[test]
    fn the_analyst_can_state_whether_its_handoff_is_ready() {
        let schema = codex_output_schema("analyst", "").expect("analyst schema should exist");
        let required = schema["required"].as_array().expect("required fields");
        assert!(required.iter().any(|item| item == "handoff_readiness"));
        let readiness = &schema["properties"]["handoff_readiness"];
        assert_eq!(readiness["additionalProperties"], json!(false));
        assert!(readiness["required"].as_array().unwrap().iter().any(|item| item == "ready_for_runner"));

        let ready = super::super::codex_outputs::analyst_design_memo(&json!({
            "handoff_readiness": {"ready_for_runner": true, "reason": "bundle materialized and hash-pinned"}
        }));
        assert_eq!(ready["final_handoff_readiness"]["ready_for_runner"], json!(true));
        assert_eq!(ready["final_handoff_readiness"]["stated_by"], json!("analyst"));

        // A deferral stays a block, with the analyst's reason on it.
        let deferred = super::super::codex_outputs::analyst_design_memo(&json!({
            "handoff_readiness": {"ready_for_runner": false, "reason": "no_matching_bundle"}
        }));
        assert_eq!(deferred["final_handoff_readiness"]["ready_for_runner"], json!(false));
        assert_eq!(deferred["final_handoff_readiness"]["blocking_reason"], json!("no_matching_bundle"));

        // Saying nothing is still not "ready": an old or unread handoff must not
        // dispatch (2026-09-20: ten runners failed on a CSV that did not exist).
        let silent = super::super::codex_outputs::analyst_design_memo(&json!({}));
        assert_eq!(silent["final_handoff_readiness"]["ready_for_runner"], json!(false));
        assert_eq!(silent["final_handoff_readiness"]["stated_by"], json!("harness_default"));
    }

    #[test]
    fn analyst_schema_requires_code_blueprint_and_self_review() {
        let schema = codex_output_schema("analyst", "").expect("analyst schema should exist");
        let required = schema
            .get("required")
            .and_then(|value| value.as_array())
            .expect("required fields");
        assert!(required
            .iter()
            .any(|item| item == "validation_code_blueprints"));
        assert!(required.iter().any(|item| item == "self_review"));
        assert!(required
            .iter()
            .any(|item| item == "open_source_agent_discovery"));
        assert!(required
            .iter()
            .any(|item| item == "selected_open_source_analysis_agent"));
        assert!(required
            .iter()
            .any(|item| item == "analyst_quality_standard"));
        let candidate_required = schema["properties"]["open_source_agent_discovery"]["properties"]
            ["candidates"]["items"]["required"]
            .as_array()
            .expect("candidate required fields");
        assert!(candidate_required
            .iter()
            .any(|item| item == "download_command"));
        assert!(candidate_required
            .iter()
            .any(|item| item == "smoke_test_command"));
        assert!(candidate_required
            .iter()
            .any(|item| item == "debug_attempts"));
        let selected_required = schema["properties"]["selected_open_source_analysis_agent"]
            ["required"]
            .as_array()
            .expect("selected agent required fields");
        assert!(selected_required
            .iter()
            .any(|item| item == "smoke_test_command"));
        assert!(selected_required
            .iter()
            .any(|item| item == "application_command"));
        let quality_required =
            schema["properties"]["analyst_quality_standard"]["required"]
                .as_array()
                .expect("analyst quality standard required fields");
        assert!(quality_required
            .iter()
            .any(|item| item == "minimum_external_agent_runs_passed"));
    }

    #[test]
    fn analyst_handoff_synthesizes_code_blueprint_and_review_from_minimal_output() {
        let payload = analyst_handoff_payload(
            &serde_json::to_string(&json!({
                "summary": "analyst brief",
                "primary_hypothesis_id": "hyp-primary-family-positive",
                "candidate_primary_families": [
                    {
                        "family_root": "candidate_family_alpha",
                        "why_competitive": "derived from the objective and current evidence bundle",
                        "priority": "high"
                    }
                ],
                "candidate_estimands": ["adjusted association for the primary family"],
                "open_source_agent_discovery": {
                    "query_log": ["searched same-dataset GitHub and package catalogues"],
                    "candidates": [{
                        "name": "statsmodels",
                        "url": "https://www.statsmodels.org/",
                        "license": "BSD",
                        "domain": "regression",
                        "fit_score": 82,
                        "reuse_decision": "adapt",
                        "download_command": "python -c 'import statsmodels'",
                        "local_path": null,
                        "setup_commands": ["pip install statsmodels"],
                        "smoke_test_command": "python -c 'import statsmodels.api as sm; print(sm.__version__)'",
                        "application_command": "python analyst-scratch.py",
                        "expected_outputs": ["coefficient table", "diagnostic figure"],
                        "debug_attempts": [{
                            "command": "python -c 'import statsmodels.api as sm'",
                            "status": "passed",
                            "stderr_excerpt": "",
                            "fix_or_blocker": ""
                        }],
                        "evidence": "supports OLS with adjustment terms"
                    }],
                    "selected_agent": {
                        "name": "statsmodels",
                        "url": "https://www.statsmodels.org/",
                        "reuse_decision": "adapt",
                        "local_path": null,
                        "smoke_test_command": "python -c 'import statsmodels.api as sm; print(sm.__version__)'",
                        "application_command": "python analyst-scratch.py",
                        "reason": "best fit for adjusted OLS blueprint"
                    },
                    "rejection_summary": ""
                },
                "selected_open_source_analysis_agent": {
                    "name": "statsmodels",
                    "url": "https://www.statsmodels.org/",
                    "reuse_decision": "adapt",
                    "local_path": null,
                    "smoke_test_command": "python -c 'import statsmodels.api as sm; print(sm.__version__)'",
                    "application_command": "python analyst-scratch.py",
                    "reason": "best fit for adjusted OLS blueprint"
                },
                "rival_dags": ["shared upstream driver"],
                "confounders": ["control_a", "control_b"],
                "falsification_ideas": ["sign flip after adjustment"],
                "evidence_gaps": ["runner must execute the adjusted model"],
                "analysis_lane_proposals": [
                    {
                        "description": "run the adjusted model for the primary family",
                        "target_family": "candidate_family_alpha",
                        "decision_value": "high"
                    }
                ],
                "handoff_checks": [
                    {
                        "check_id": "primary_family_alpha_01",
                        "goal": "Estimate the adjusted association of the primary exposure with the primary outcome.",
                        "dataset": "analysis_bundle.csv",
                        "outcome": "primary_outcome",
                        "exposures": ["primary_exposure"],
                        "adjustment_set": ["control_a", "control_b"],
                        "fixed_effects": ["control_b"],
                        "sample_filters": [],
                        "model_family": "ols",
                        "success_criteria": {
                            "expected_sign": "negative",
                            "p_value_max": 0.05,
                            "minimum_effect_description": "Primary coefficient remains negative after adjustment."
                        },
                        "failure_criteria": ["The adjusted coefficient flips sign."]
                    }
                ]
            }))
            .expect("json serialization"),
        )
        .expect("handoff payload should be synthesized");
        assert!(payload
            .get("validation_code_blueprints")
            .and_then(|value| value.as_array())
            .map(|items| !items.is_empty())
            .unwrap_or(false));
        assert_eq!(
            payload
                .get("self_review")
                .and_then(|value| value.get("review_status"))
                .and_then(|value| value.as_str()),
            Some("approved_for_handoff")
        );
        assert_eq!(
            payload
                .get("selected_open_source_analysis_agent")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str()),
            Some("statsmodels")
        );
        assert_eq!(
            payload
                .get("selected_open_source_analysis_agent")
                .and_then(|value| value.get("application_command"))
                .and_then(|value| value.as_str()),
            Some("python analyst-scratch.py")
        );
        assert!(payload
            .get("open_source_agent_discovery")
            .and_then(|value| value.get("candidates"))
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .and_then(|item| item.get("debug_attempts"))
            .and_then(|value| value.as_array())
            .map(|items| !items.is_empty())
            .unwrap_or(false));
        assert_eq!(
            payload
                .get("analyst_quality_standard")
                .and_then(|value| value.get("minimum_blueprints_passed"))
                .and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(
            payload
                .get("analyst_quality_standard")
                .and_then(|value| value.get("require_all_handoff_checks_resolved"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    // Gatekeeper empty-output reclassification — the fix that keeps
    // silent Codex failures from masquerading as successful reviews.
