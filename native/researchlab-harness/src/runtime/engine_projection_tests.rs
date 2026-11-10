    #[cfg(unix)]
    #[test]
    fn command_lookup_falls_back_to_nvm_bins_when_path_misses_codex() {
        let dir = tempfile::tempdir().expect("tempdir");
        let codex = dir
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v99.0.0")
            .join("bin")
            .join("codex");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::write(&codex, "#!/bin/sh\necho codex\n").unwrap();
        make_executable(&codex);

        let old_home = std::env::var("HOME").ok();
        let old_nvm_bin = std::env::var("NVM_BIN").ok();
        std::env::set_var("HOME", dir.path());
        std::env::remove_var("NVM_BIN");
        let found = command_from_common_locations("codex");
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        }
        if let Some(value) = old_nvm_bin {
            std::env::set_var("NVM_BIN", value);
        }

        assert_eq!(found.as_deref(), Some(codex.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn command_lookup_skips_broken_newer_nvm_codex_and_uses_working_older_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let broken = dir
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v99.0.0")
            .join("bin")
            .join("codex");
        let working = dir
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v98.0.0")
            .join("bin")
            .join("codex");
        std::fs::create_dir_all(broken.parent().unwrap()).unwrap();
        std::fs::create_dir_all(working.parent().unwrap()).unwrap();
        std::fs::write(&broken, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::write(&working, "#!/bin/sh\necho codex-cli 0.1.0\n").unwrap();
        make_executable(&broken);
        make_executable(&working);

        let old_home = std::env::var("HOME").ok();
        let old_nvm_bin = std::env::var("NVM_BIN").ok();
        std::env::set_var("HOME", dir.path());
        std::env::remove_var("NVM_BIN");
        let found = command_from_common_locations("codex");
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        }
        if let Some(value) = old_nvm_bin {
            std::env::set_var("NVM_BIN", value);
        }

        assert_eq!(found.as_deref(), Some(working.to_str().unwrap()));
    }

    #[test]
    fn researchlab_codex_home_prefers_user_codex_home() {
        let dir = tempfile::tempdir().expect("tempdir");
        let codex_home = dir.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();

        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", dir.path());
        let found = researchlab_codex_home();
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        }

        assert_eq!(found.as_deref(), Some(codex_home.as_path()));
    }

    // The lead projection now refuses a selection until a valid field landscape
    // exists and the lead cites it (labdirector::field_landscape). The tests below
    // exercise what the projection does AFTER that gate -- dataset identity, the
    // lead hold -- so they project through a valid landscape and a lead that cites
    // it. The gate itself is tested in its own tests further down.
    fn write_valid_test_landscape(paths: &AppPaths) {
        let path = crate::labdirector::field_landscape_state_path(paths, "cycle-test");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string(&crate::labdirector::valid_field_landscape_fixture("cycle-test")).unwrap(),
        )
        .unwrap();
    }

    fn cite_test_landscape(payload: &serde_json::Value) -> serde_json::Value {
        let mut payload = payload.clone();
        let cite = |lead: &mut serde_json::Value| {
            if lead.is_object() {
                lead["landscape_open_problem_id"] = json!("op_sf0");
                lead["landscape_paper_ids"] =
                    json!(["doi:10.1/sf0-c0", "doi:10.1/sf0-c1", "arxiv:sf0-f0"]);
            }
        };
        for decision in [payload.get_mut("extracted_json")].into_iter().flatten() {
            if let Some(lead) = decision.get_mut("selected_hypothesis") {
                cite(lead);
            }
            if let Some(items) = decision.get_mut("replacement_hypotheses").and_then(|v| v.as_array_mut()) {
                items.iter_mut().for_each(cite);
            }
        }
        if let Some(lead) = payload.get_mut("selected_hypothesis") {
            cite(lead);
        }
        payload
    }

    fn project_with_valid_landscape(
        paths: &AppPaths,
        contract: &LaneContract,
        payload: &serde_json::Value,
    ) -> anyhow::Result<Option<PathBuf>> {
        write_valid_test_landscape(paths);
        project_lab_director_payload_to_hypothesis(paths, contract, &cite_test_landscape(payload))
    }

    #[test]
    fn a_first_lead_is_refused_until_a_valid_field_landscape_exists() {
        // cycle-b-20260918: the lead was chosen by the most ready instrument,
        // with no field survey behind it.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let hypothesis_path = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = cite_test_landscape(&json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": { "statement": "guard termination overstates the checkpoint", "primary_family": "f" }
            }
        }));
        let projected = project_lab_director_payload_to_hypothesis(&paths, &contract, &payload).unwrap();
        assert!(projected.is_none());
        assert!(!hypothesis_path.exists(), "a lead was selected with no landscape");
        let rejections: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(crate::labdirector::lead_selection_rejections_path(&paths, "cycle-test")).unwrap(),
        )
        .unwrap();
        let reason = rejections["rejections"][0]["reasons"][0].as_str().unwrap();
        assert!(reason.starts_with("field_landscape_missing"), "{reason}");
        assert_eq!(rejections["rejections"][0]["lane_id"], json!("lab-director-01"));

        // With the landscape in place the same selection goes through.
        write_valid_test_landscape(&paths);
        project_lab_director_payload_to_hypothesis(&paths, &contract, &payload).unwrap();
        let lead: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(lead["statement"], json!("guard termination overstates the checkpoint"));
    }

    #[test]
    fn a_lead_without_an_open_problem_or_enough_landscape_citations_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        write_valid_test_landscape(&paths);
        let hypothesis_path = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let reasons_for = |lead: serde_json::Value| -> Vec<String> {
            let payload = json!({ "status": "completed", "extracted_json": { "requery_decision": "replace", "selected_hypothesis": lead } });
            assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &payload).unwrap().is_none());
            assert!(!hypothesis_path.exists());
            let rejections: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(crate::labdirector::lead_selection_rejections_path(&paths, "cycle-test")).unwrap(),
            )
            .unwrap();
            let last = rejections["rejections"].as_array().unwrap().last().unwrap().clone();
            last["reasons"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect()
        };

        let missing = reasons_for(json!({ "statement": "a lead with no landscape references" }));
        assert!(missing.iter().any(|r| r.starts_with("landscape_open_problem_id is missing")), "{missing:?}");
        assert!(missing.iter().any(|r| r.contains("at least 3 are required")), "{missing:?}");

        let unknown_problem = reasons_for(json!({
            "statement": "a lead naming a problem the landscape does not hold",
            "landscape_open_problem_id": "op_invented",
            "landscape_paper_ids": ["doi:10.1/sf0-c0", "doi:10.1/sf0-c1", "arxiv:sf0-f0"],
        }));
        assert_eq!(unknown_problem.len(), 1, "{unknown_problem:?}");
        assert!(unknown_problem[0].contains("'op_invented' is not an open problem"), "{unknown_problem:?}");

        let no_frontier = reasons_for(json!({
            "statement": "a lead citing only canonical work",
            "landscape_open_problem_id": "op_sf0",
            "landscape_paper_ids": ["doi:10.1/sf0-c0", "doi:10.1/sf0-c1", "doi:10.1/sf1-c0", "doi:10.9/not-in-landscape"],
        }));
        assert_eq!(no_frontier.len(), 1, "{no_frontier:?}");
        assert!(no_frontier[0].contains("no frontier work"), "{no_frontier:?}");
    }

    #[test]
    fn a_refused_replacement_keeps_the_current_lead_and_says_why() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let hypothesis_path = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        project_with_valid_landscape(&paths, &contract, &json!({
            "status": "completed",
            "extracted_json": { "requery_decision": "replace", "selected_hypothesis": { "statement": "the landscape lead" } }
        }))
        .unwrap();
        let replacement = json!({
            "status": "completed",
            "extracted_json": { "requery_decision": "replace", "selected_hypothesis": { "statement": "an instrument-first idea" } }
        });
        project_lab_director_payload_to_hypothesis(&paths, &contract, &replacement).unwrap();
        let kept: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(kept["statement"], json!("the landscape lead"));
        assert_eq!(kept["replacement_deferred"][0]["reason"], json!("field_landscape_gate"));
        assert_eq!(kept["replacement_deferred"][0]["statement"], json!("an instrument-first idea"));

        // An uphold of the lead the projection wrote is not a selection.
        let uphold = json!({
            "status": "completed",
            "extracted_json": { "requery_decision": "uphold", "selected_hypothesis": { "statement": "the landscape lead" } }
        });
        std::fs::remove_file(crate::labdirector::field_landscape_state_path(&paths, "cycle-test")).unwrap();
        project_lab_director_payload_to_hypothesis(&paths, &contract, &uphold).unwrap();
        let upheld: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(upheld["statement"], json!("the landscape lead"));
    }

    #[test]
    fn a_lead_the_director_wrote_itself_does_not_bypass_the_landscape_gate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let hypothesis_path = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        std::fs::create_dir_all(hypothesis_path.parent().unwrap()).unwrap();
        std::fs::write(&hypothesis_path, serde_json::to_string(&json!({ "statement": "self-written lead" })).unwrap()).unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": { "requery_decision": "uphold", "selected_hypothesis": { "statement": "self-written lead" } }
        });
        assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &payload).unwrap().is_none());
        assert!(!hypothesis_path.exists(), "the self-written lead still stands");
        assert!(paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.rejected-by-field-landscape.json")
            .exists());
    }

    #[test]
    fn a_lead_written_to_the_file_during_the_lane_with_no_selection_in_the_result_is_set_aside() {
        // The base director task tells the agent to write the lead file itself;
        // a result that selects nothing would otherwise leave that lead ungated.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let lane_dir = crate::core::support::lane_root(&paths, "cycle-test", "lab-director-01");
        lead_hold_write(&lane_dir.join("execution-context.json"), json!({}));
        let before = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        lead_hold_tick();
        lead_hold_write(&before, json!({ "statement": "an instrument-first lead written by hand" }));
        let payload = json!({ "status": "completed", "extracted_json": { "decision_status": "final", "summary": "wrote the lead file" } });
        assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &payload).unwrap().is_none());
        assert!(!before.exists(), "the hand-written lead bypassed the landscape gate");
        let rejections: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(crate::labdirector::lead_selection_rejections_path(&paths, "cycle-test")).unwrap(),
        )
        .unwrap();
        assert_eq!(rejections["rejections"][0]["requery_decision"], json!("written_to_lead_file_directly"));

        // A lead file from before this lane is not this lane's selection.
        let (_dir2, paths2, hypothesis2) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        lead_hold_tick();
        let lane_dir2 = crate::core::support::lane_root(&paths2, "cycle-test", "lab-director-01");
        lead_hold_write(&lane_dir2.join("execution-context.json"), json!({}));
        project_lab_director_payload_to_hypothesis(&paths2, &contract, &payload).unwrap();
        assert!(hypothesis2.exists());
    }

    #[test]
    fn lab_director_payload_projects_selected_hypothesis_to_canonical_artifact() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        std::fs::write(
            &hypothesis_path,
            serde_json::to_string(&json!({
                "statement": "stale superiority claim",
                "primary_family": "stale_family",
                "dataset_or_accession": "GSE282742",
                "identification_strategy": {
                    "materialized_dataset": {
                        "bundle_path": "/tmp/gse282742"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "restart",
                "summary": "restart around audit",
                "selected_hypothesis": {
                    "statement": "In GSE282742, run a reproducibility and leakage audit of the published 8-gene classifier.",
                    "primary_family": "reproducibility_audit",
                    "same_dataset_reference_papers": [{
                        "title": "Transcriptomic predictors",
                        "doi": "10.1186/s13195-024-01651-0"
                    }],
                    "reference_methods_baseline": "published 8-gene AUC 0.93 baseline"
                },
                "next_actions": [{
                    "type": "methods_followup",
                    "description": "run grouped CV audit",
                    "preferred_role": "lab-runner"
                }]
            }
        });

        let projected =
            project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        assert_eq!(projected.as_deref(), Some(hypothesis_path.as_path()));
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["primary_family"], json!("reproducibility_audit"));
        assert_eq!(updated["dataset_or_accession"], json!("GSE282742"));
        assert_eq!(updated["validation_data_status"], json!("materialized"));
        assert_eq!(
            updated["identification_strategy"]["materialized_dataset"]["bundle_path"],
            json!("/tmp/gse282742")
        );
        assert!(updated["statement"]
            .as_str()
            .unwrap()
            .contains("reproducibility and leakage audit"));
    }

    fn lead_hold_now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn lead_hold_write(path: &Path, value: serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string(&value).unwrap()).unwrap();
    }

    // File order is read from modification times, which the kernel stamps from a
    // coarse clock; wait past a tick wherever the order is the point.
    fn lead_hold_tick() {
        std::thread::sleep(std::time::Duration::from_millis(80));
    }

    fn lead_hold_replacement(statement: &str) -> serde_json::Value {
        json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "rationale": "a different idea",
                "selected_hypothesis": { "statement": statement, "primary_family": "family_b" }
            }
        })
    }

    fn lead_hold_runner(paths: &AppPaths, lane: &str, handoff: &Path, result: serde_json::Value) {
        let dir = paths.runtime_root.join("lanes").join("cycle-test").join(lane);
        lead_hold_write(
            &dir.join("role-plan.json"),
            json!({ "planner_metadata": { "analyst_handoff_path": handoff } }),
        );
        lead_hold_write(&dir.join("result.json"), result);
        lead_hold_write(&dir.join("final-status.json"), json!({ "status": "completed" }));
    }

    fn lead_hold_gatekeeper(paths: &AppPaths, lane: &str) {
        let dir = paths.runtime_root.join("lanes").join("cycle-test").join(lane);
        lead_hold_write(&dir.join("final-status.json"), json!({ "status": "completed" }));
    }

    // One recorded gate decision -- the watchdog's unit of a gate round.
    fn lead_hold_gate_decision(paths: &AppPaths) {
        let log = paths
            .runtime_root
            .join("state")
            .join("cycle-test-hypothesis-progress.jsonl");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let row = json!({
            "memory_type": "decision",
            "ts": crate::core::support::now_iso(),
            "content": {"rubric": [{"name": "novelty", "score": 58}]},
        });
        let mut text = std::fs::read_to_string(&log).unwrap_or_default();
        text.push_str(&format!("{row}
"));
        std::fs::write(&log, text).unwrap();
    }

    fn lead_hold_setup(selected_ms: u64) -> (tempfile::TempDir, AppPaths, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        lead_hold_write(
            &hypothesis_path,
            json!({
                "statement": "the lead being tested",
                "primary_family": "family_a",
                "selected_at_epoch_ms": selected_ms,
            }),
        );
        (dir, paths, hypothesis_path)
    }

    fn lead_hold_read(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn director_withdrawal_clears_measured_interpretation_churn_and_allows_next_anchor() {
        // MEASURED ON cycle-a-20260919, 2026-11-01: lead_selected
        // still named Director 1759 after 60 aborted interpretations and repeated
        // restart/null-lead decisions. The scientific withdrawal never projected.
        let (dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 144_000_000);
        let mut incumbent = lead_hold_read(&hypothesis_path);
        incumbent["status"] = json!("selected");
        incumbent["projection_source"] = json!("lab_director_lane_result");
        incumbent["validation_data_status"] = json!("needs_materialization");
        incumbent["dataset_or_accession"] = json!("balanced_local_gap_five_arm_frozen_1391");
        lead_hold_write(&hypothesis_path, incumbent.clone());
        for (kind, value) in [
            ("field-landscape", json!({"subfields": [{}]})),
            ("frontier-harvest", json!({"top_k": []})),
            ("sota-cards", json!({"cards": [{}]})),
            ("field-beliefs", json!({"beliefs": [{}]})),
            ("candidate-slate", json!({"candidates": [{}]})),
            ("expert-panel", json!({"ranking": [{}]})),
            ("novelty-audit", json!({"audits": [{}]})),
            ("candidate-feasibility", json!({"assessments": [{}]})),
            ("owner-candidates", json!({"published_at": "2026-09-20T00:00:00Z", "candidates": [{}]})),
            ("owner-selection", json!({"candidate_id": "c1"})),
        ] {
            lead_hold_write(&paths.runtime_root.join(format!("state/cycle-test-{kind}.json")), value);
        }
        for n in 1399..1459 {
            let lane = paths.runtime_root.join(format!("lanes/cycle-test/followup-analyst-{n}"));
            lead_hold_write(&lane.join("role-plan.json"), json!({
                "role": "analyst", "action_type": "runner_result_interpretation_followup"
            }));
            lead_hold_write(&lane.join("final-status.json"), json!({
                "status": "aborted", "failure_category": "director_retired_blocked_lane",
                "completed_at": crate::core::support::now_iso()
            }));
        }
        let progress = || {
            let output = std::process::Command::new("node")
                .arg("-e").arg("const m=require(process.argv[1]); const p=m.deriveProgress({cwd:process.argv[2],cycleId:'cycle-test'}); console.log(JSON.stringify({progress:p,findings:m.stallFindings({progress:p,config:m.supervisorConfig({})})}));")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/orchestrator/cycle_progress.js"))
                .arg(dir.path()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let stuck = progress();
        assert_eq!(stuck["progress"]["current_milestone"], json!("lead_selected"));
        assert_eq!(stuck["progress"]["waiting_on"], json!(["lead_validation_data_status=needs_materialization"]));
        assert_eq!(stuck["progress"]["lanes_since_milestone"]["by_action_type"]["runner_result_interpretation_followup"]["total"], json!(60));
        assert!(stuck["findings"].as_array().unwrap().iter().any(|f| f["signature"] == "lane_churn:lead_selected:runner_result_interpretation_followup"));

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let withdrawal = json!({"extracted_json": {
            "requery_decision": "restart", "selected_hypothesis": null,
            "replacement_hypotheses": [], "simulation_orders": null,
            "resume_lead_decision": {"decision": "decline", "lead_id": "hyp:50f5d3574965dd5e"},
            "next_actions": []
        }});
        let silent = json!({"extracted_json": {"requery_decision": "uphold", "selected_hypothesis": null}});
        assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &silent).unwrap().is_none());
        // Withdrawal cannot evade the existing evidence hold or clear its orders.
        project_lab_director_payload_to_hypothesis(&paths, &contract, &withdrawal).unwrap();
        assert_eq!(lead_hold_read(&hypothesis_path)["statement"], incumbent["statement"]);
        assert!(super::super::lab_director_projection::project_lab_director_simulation_orders(&paths, &contract, &withdrawal).unwrap().is_none());
        let handoff = paths.runtime_root.join("lanes/cycle-test/followup-analyst-01/handoff-validation-plan.json");
        lead_hold_write(&handoff, json!({}));
        lead_hold_runner(&paths, "followup-runner-842", &handoff, json!({
            "validation_summary": {"overall_status": "passed", "checks_failed": 0},
            "blueprint_executions": [{"status": "completed", "produced_evidence": true, "metrics": {"gain": 0.03}}]
        }));
        lead_hold_tick();
        lead_hold_gatekeeper(&paths, "followup-gatekeeper-2014");
        let mut stale_contract = contract.clone();
        stale_contract.lane_id = "followup-lab-director-1810".to_string();
        lead_hold_write(&paths.runtime_root.join("lanes/cycle-test/followup-lab-director-1810/execution-context.json"), json!({}));
        lead_hold_tick();
        project_lab_director_payload_to_hypothesis(&paths, &contract, &withdrawal).unwrap();
        super::super::lab_director_projection::project_lab_director_simulation_orders(&paths, &contract, &withdrawal).unwrap();
        let retired = lead_hold_read(&hypothesis_path);
        assert_eq!(retired["status"], json!("withdrawn"));
        assert_eq!(retired["withdrawn_hypothesis"]["statement"], incumbent["statement"]);
        assert_eq!(progress()["progress"]["current_milestone"], json!("owner_selection"));
        // An older in-flight director cannot restore the retired lead or
        // overwrite the new withdrawal epoch, including through simulation orders.
        assert!(project_lab_director_payload_to_hypothesis(&paths, &stale_contract, &lead_hold_replacement("the old allocation claim")).unwrap().is_none());
        assert!(project_lab_director_payload_to_hypothesis(&paths, &stale_contract, &withdrawal).unwrap().is_none());
        assert!(super::super::lab_director_projection::project_lab_director_simulation_orders(&paths, &stale_contract, &withdrawal).unwrap().is_none());
        assert_eq!(lead_hold_read(&hypothesis_path), retired);

        // A future director can select a successor through the ordinary gates;
        // neither the old hold nor its materialization wait survives withdrawal.
        lead_hold_write(&paths.runtime_root.join("state/cycle-test-expert-selection.json"), json!({
            "engaged_at": "2026-09-19T12:00:00Z", "owner_selection": {"candidate_id": "c1", "released": false}
        }));
        lead_hold_write(&paths.runtime_root.join("state/cycle-test-owner-candidates.json"), json!({
            "published_at": "2026-09-20T00:00:00Z", "candidates": [{"candidate_id": "c1"}, {"candidate_id": "c2"}]
        }));
        let successor = cite_test_landscape(&json!({"extracted_json": {
            "requery_decision": "replace",
            "selected_hypothesis": {"statement": "a successor method", "primary_family": "family_b", "slate_candidate_id": "c2"},
            "simulation_orders": [{"request_id": "successor-anchor", "conditions": []}]
        }}));
        let mut unvetted = successor.clone();
        unvetted["extracted_json"]["selected_hypothesis"]["slate_candidate_id"] = json!("unvetted");
        assert!(project_with_valid_landscape(&paths, &contract, &unvetted).unwrap().is_none());
        project_with_valid_landscape(&paths, &contract, &successor).unwrap();
        super::super::lab_director_projection::project_lab_director_simulation_orders(&paths, &contract, &successor).unwrap();
        assert_eq!(progress()["progress"]["current_milestone"], json!("reproduction_anchor"));
    }

    #[test]
    fn full_disposition_register_unblocks_measured_chronicle_owner_selection_churn() {
        // MEASURED ON cycle-a-20260919, 2026-11-09: six Chronicle
        // evidence lanes finished at owner_selection with a withdrawn lead and
        // a standing owner release. Director 1906 still requested supersession
        // synchronization because approval read only the gate's empty subset.
        let (dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let retired = json!({"status": "withdrawn", "selected_hypothesis": null,
            "projection_source": "lab_director_lane_result", "requery_decision": "restart",
            "selected_at_epoch_ms": lead_hold_now_ms() - 60_000,
            "withdrawn_hypothesis": {"statement": "old allocation claim"}});
        lead_hold_write(&hypothesis_path, retired.clone());
        lead_hold_write(&paths.runtime_root.join("state/cycle-test-lead-hold.json"), json!({"lead": retired}));
        for (kind, value) in [
            ("field-landscape", json!({"subfields": [{}]})),
            ("frontier-harvest", json!({"top_k": []})),
            ("sota-cards", json!({"cards": [{}]})),
            ("field-beliefs", json!({"beliefs": [{}]})),
            ("candidate-slate", json!({"candidates": [{}]})),
            ("expert-panel", json!({"ranking": [{}]})),
            ("novelty-audit", json!({"audits": [{}]})),
            ("candidate-feasibility", json!({"assessments": [{}]})),
            ("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z", "round": 3,
                "rounds": [{"spent_round": {"owner_selection": {"candidate_id": "release",
                    "decision": "slate_released", "selected_at": "2026-11-09T02:40:34Z"}}}]})),
        ] {
            lead_hold_write(&paths.runtime_root.join(format!("state/cycle-test-{kind}.json")), value);
        }
        for n in 264..270 {
            let lane = paths.runtime_root.join(format!("lanes/cycle-test/followup-chronicle-{n}"));
            lead_hold_write(&lane.join("role-plan.json"), json!({"role": "chronicle",
                "action_type": "chronicle_evidence_request_followup"}));
            lead_hold_write(&lane.join("final-status.json"), json!({"status": "completed",
                "completed_at": crate::core::support::now_iso()}));
        }
        let old = "Novelty: need a broader set of non-trivial hypotheses";
        let gate = json!({"gatekeeper_review_status": "parsed", "score": 20, "gate_passed": false,
            "rubric": [{"name": "novelty", "score": 20}],
            "gate_blocker_adjudications": [{"blocker": old, "decision": "superseded"},
                {"blocker": old, "decision": "uphold"}],
            "gate_blocker_adjudication_resolution": {"active_blockers": [],
                "removed_blockers": [], "downgraded_blockers": [], "upheld_blockers": []}});
        let gate_path = paths.runtime_root.join("state/cycle-test-gate-review.json");
        lead_hold_write(&gate_path, gate.clone());
        let snapshot = || {
            let output = std::process::Command::new("node").arg("-e").arg(r#"
                const base=process.argv[1], cwd=process.argv[2], cycleId='cycle-test';
                const m=require(base+'/src/orchestrator/cycle_progress');
                const summary={objective:'Robot imitation coverage', evidence_readiness:{ready:true},
                  conclusion_readiness_score:50, approval_readiness_score:50,
                  conclusion_rubric:[{name:'novelty',score:50,reasons:[
                    'Novelty: need a broader set of non-trivial hypotheses',
                    'The registered controlled effects are nonidentified']}]};
                summary.approval_rubric=summary.conclusion_rubric;
                const conclusion=require(base+'/src/reporting/conclusion_review')
                  .buildConclusionReview({cwd,cycleId,researcherView:{summary}}).review;
                const approval=require(base+'/src/reporting/approval_review')
                  .buildApprovalReview({cwd,cycleId,researcherView:{summary},conclusionReview:conclusion,staged:true}).review;
                const progress=m.deriveProgress({cwd,cycleId});
                console.log(JSON.stringify({conclusion,approval,progress,
                  findings:m.stallFindings({progress,config:m.supervisorConfig({})})}));
            "#).arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).arg(dir.path()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let stuck = snapshot();
        assert_eq!(stuck["progress"]["current_milestone"], "owner_selection");
        assert_eq!(stuck["progress"]["waiting_on"], json!(["lead_selected_not_published: lab-director-hypothesis has not been written"]));
        assert_eq!(stuck["progress"]["lanes_since_milestone"]["by_action_type"]["chronicle_evidence_request_followup"]["total"], 6);
        let signature = "lane_churn:owner_selection:chronicle_evidence_request_followup";
        assert!(stuck["findings"].as_array().unwrap().iter().any(|f| f["signature"] == signature));
        assert!(!stuck["approval"]["approval_rubric"].to_string().contains(old));
        assert!(stuck["approval"]["approval_rubric"].to_string().contains("nonidentified"));
        assert_eq!(stuck["conclusion"]["conclusion_rubric"][0]["score"], 20);
        assert_eq!(stuck["approval"]["approval_gate_passed"], false);
        // The resolved administrative wait reaches the next Director; only its
        // authored successor, through the ordinary landscape gate, advances.
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        assert!(project_with_valid_landscape(&paths, &contract,
            &lead_hold_replacement("a director-authored successor method")).unwrap().is_some());
        let advanced = snapshot();
        assert_eq!(advanced["progress"]["current_milestone"], "lead_selected");
        assert!(!advanced["findings"].as_array().unwrap().iter().any(|f| f["signature"] == signature));
        assert_eq!(lead_hold_read(&gate_path), gate);
    }

    #[test]
    fn gate_dispositions_reach_successors_and_release_owner_selection_churn() {
        // MEASURED ON cycle-a-20260919, 2026-11-06: 271 adaptive
        // searches finished at owner_selection. Independent dispositions had
        // landed, but downstream reviews reintroduced the settled objections;
        // Director 1872 waited for controller synchronization instead of choosing.
        let (dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let retired = json!({"status": "withdrawn", "selected_hypothesis": null,
            "projection_source": "lab_director_lane_result", "requery_decision": "restart",
            "selected_at_epoch_ms": lead_hold_now_ms() - 60_000,
            "withdrawn_hypothesis": {"statement": "the old allocation claim",
                "projection_source": "lab_director_lane_result"}});
        lead_hold_write(&hypothesis_path, retired.clone());
        lead_hold_write(&paths.runtime_root.join("state/cycle-test-lead-hold.json"), json!({"lead": retired}));
        for (kind, value) in [
            ("field-landscape", json!({"subfields": [{}]})),
            ("frontier-harvest", json!({"top_k": []})),
            ("sota-cards", json!({"cards": [{}]})),
            ("field-beliefs", json!({"beliefs": [{}]})),
            ("candidate-slate", json!({"candidates": [{}]})),
            ("expert-panel", json!({"ranking": [{}]})),
            ("novelty-audit", json!({"audits": [{}]})),
            ("candidate-feasibility", json!({"assessments": [{}]})),
            ("owner-candidates", json!({"published_at": "2026-09-20T00:00:00Z",
                "candidates": [{"candidate_id": "c1"}, {"candidate_id": "c2"}]})),
            ("owner-selection", json!({"candidate_id": "c1", "decided_at": "2026-10-01T22:47:03Z"})),
            ("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z",
                "owner_selection": {"candidate_id": "c1", "released": false}})),
        ] {
            lead_hold_write(&paths.runtime_root.join(format!("state/cycle-test-{kind}.json")), value);
        }
        for n in 443..714 {
            let lane = paths.runtime_root.join(format!("lanes/cycle-test/followup-scout-{n}"));
            lead_hold_write(&lane.join("role-plan.json"), json!({"role": "scout", "action_type": "adaptive_search_followup"}));
            lead_hold_write(&lane.join("final-status.json"), json!({"status": "completed", "completed_at": crate::core::support::now_iso()}));
        }
        let old = "Novelty: need a broader set of non-trivial hypotheses";
        let active = "The registered controlled effects are nonidentified";
        let gate = json!({"gatekeeper_review_status": "parsed", "score": 20, "gate_passed": false,
            "rubric": [{"name": "novelty", "score": 20}], "blockers": [active],
            "gate_blocker_adjudication_resolution": {"active_blockers": [active],
                "removed_blockers": [{"blocker": old, "adjudication": {"decision": "superseded"}}],
                "downgraded_blockers": []}});
        let gate_path = paths.runtime_root.join("state/cycle-test-gate-review.json");
        lead_hold_write(&gate_path, gate.clone());
        let snapshot = || {
            let output = std::process::Command::new("node").arg("-e").arg(r#"
                const base = process.argv[1], cwd = process.argv[2], cycleId = 'cycle-test';
                const {buildConclusionReview} = require(base + '/src/reporting/conclusion_review');
                const {buildApprovalReview} = require(base + '/src/reporting/approval_review');
                const m = require(base + '/src/orchestrator/cycle_progress');
                const summary = {objective: 'Robot imitation coverage', evidence_readiness: {ready:true},
                  conclusion_readiness_score: 50, approval_readiness_score: 50,
                  conclusion_rubric: [{name:'novelty',score:50,reasons:[
                    'Novelty: need a broader set of non-trivial hypotheses',
                    'The registered controlled effects are nonidentified']}]};
                summary.approval_rubric = summary.conclusion_rubric;
                const conclusion = buildConclusionReview({cwd,cycleId,researcherView:{summary}}).review;
                const approval = buildApprovalReview({cwd,cycleId,researcherView:{summary},conclusionReview:conclusion,staged:true}).review;
                const progress = m.deriveProgress({cwd,cycleId});
                console.log(JSON.stringify({conclusion,approval,progress,
                  findings:m.stallFindings({progress,config:m.supervisorConfig({})})}));
            "#).arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
                .arg(dir.path()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let stuck = snapshot();
        assert_eq!(stuck["progress"]["current_milestone"], json!("owner_selection"));
        assert_eq!(stuck["progress"]["lanes_since_milestone"]["by_action_type"]["adaptive_search_followup"]["total"], json!(271));
        assert!(stuck["findings"].as_array().unwrap().iter().any(|f|
            f["signature"] == "lane_churn:owner_selection:adaptive_search_followup"));
        assert!(!stuck["conclusion"]["conclusion_blockers"].as_array().unwrap().contains(&json!(old)));
        assert!(!stuck["approval"]["approval_blockers"].to_string().contains(old));
        assert!(stuck["approval"]["approval_blockers"].to_string().contains(active));
        assert_eq!(stuck["conclusion"]["conclusion_rubric"][0]["score"], json!(20));
        assert_eq!(stuck["approval"]["approval_gate_passed"], json!(false));
        assert_eq!(lead_hold_read(&gate_path), gate);
        // The settled administrative prerequisite is now visible in both sinks.
        // Only a Director-authored, ordinarily vetted successor advances the cycle;
        // synchronization itself cannot select a lead or turn a gate into a pass.
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let successor = cite_test_landscape(&json!({"extracted_json": {
            "requery_decision": "replace", "selected_hypothesis": {
                "statement": "a successor method", "primary_family": "family_b", "slate_candidate_id": "c2"}
        }}));
        assert!(project_with_valid_landscape(&paths, &contract, &successor).unwrap().is_some());
        let advanced = snapshot();
        assert_eq!(advanced["progress"]["current_milestone"], json!("lead_selected"));
        assert!(!advanced["findings"].as_array().unwrap().iter().any(|f|
            f["signature"] == "lane_churn:owner_selection:adaptive_search_followup"));
        assert_eq!(lead_hold_read(&gate_path), gate);
    }

    #[cfg(unix)]
    #[test]
    fn relocated_execution_advances_measured_blocking_recovery_churn() {
        // MEASURED ON cycle-a-20260919, 2026-11-06: 262 recovery
        // planners completed at owner_selection. Released base lanes then used
        // a nonexistent Windows cwd. A reset must repair the execution contract,
        // not replay ENOENT; a real Director selection must still pass projection.
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            project_root: dir.path().to_path_buf(),
            runtime_root: dir.path().join(".research-lab"),
            data_root: dir.path().join("data"),
            stats_driver_script: PathBuf::from("unused"),
            literature_driver_script: PathBuf::from("unused"),
        };
        let hypothesis = paths.runtime_root.join("state/cycle-test-lab-director-hypothesis.json");
        let retired = json!({"status": "withdrawn", "selected_hypothesis": null,
            "projection_source": "lab_director_lane_result", "requery_decision": "restart",
            "withdrawn_hypothesis": {"statement": "the prior lead", "projection_source": "lab_director_lane_result"}});
        lead_hold_write(&hypothesis, retired.clone());
        for (kind, value) in [
            ("field-landscape", json!({"subfields": [{}]})),
            ("frontier-harvest", json!({"top_k": []})),
            ("sota-cards", json!({"cards": [{}]})),
            ("field-beliefs", json!({"beliefs": [{}]})),
            ("candidate-slate", json!({"candidates": [{}]})),
            ("expert-panel", json!({"ranking": [{}]})),
            ("novelty-audit", json!({"audits": [{}]})),
            ("candidate-feasibility", json!({"assessments": [{}]})),
            ("owner-candidates", json!({"published_at": "2026-09-20T00:00:00Z",
                "candidates": [{"candidate_id": "c1"}, {"candidate_id": "c2"}]})),
            ("owner-selection", json!({"candidate_id": "c1", "decided_at": "2026-10-01T22:47:03Z"})),
            ("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z",
                "owner_selection": {"candidate_id": "c1", "released": false}})),
        ] {
            lead_hold_write(&paths.runtime_root.join(format!("state/cycle-test-{kind}.json")), value);
        }
        for n in 0..262 {
            let lane = paths.runtime_root.join(format!("lanes/cycle-test/followup-lab-director-{n}"));
            lead_hold_write(&lane.join("role-plan.json"), json!({"role": "lab-director",
                "action_type": "blocking_lane_recovery_planning"}));
            lead_hold_write(&lane.join("final-status.json"), json!({"status": "completed",
                "completed_at": crate::core::support::now_iso()}));
        }
        let snapshot = || {
            let output = std::process::Command::new("node").arg("-e").arg(r#"
                const m=require(process.argv[1]+'/src/orchestrator/cycle_progress');
                const progress=m.deriveProgress({cwd:process.argv[2],cycleId:'cycle-test'});
                console.log(JSON.stringify({progress, findings:m.stallFindings({progress,config:m.supervisorConfig({})})}));
            "#).arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).arg(dir.path()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let stuck = snapshot();
        assert_eq!(stuck["progress"]["current_milestone"], "owner_selection");
        assert_eq!(stuck["progress"]["lanes_since_milestone"]["by_action_type"]["blocking_lane_recovery_planning"]["total"], 262);
        assert!(stuck["findings"].as_array().unwrap().iter().any(|f|
            f["signature"] == "lane_churn:owner_selection:blocking_lane_recovery_planning"));

        let lane = paths.runtime_root.join("lanes/cycle-test/lab-director-01");
        let old_root = r"Z:\retired-host\researchlab";
        let old_lane = format!(r"{old_root}\.research-lab\lanes\cycle-test\lab-director-01");
        lead_hold_write(&lane.join("lane-contract.json"), json!({
            "cycle_id": "cycle-test", "lane_id": "lab-director-01", "role": "lab-director",
            "runtime_class": "codex-agent", "mode": "read-write-scoped", "cwd": old_root,
            "task_file": format!(r"{old_lane}\task.md"), "allowed_outputs": [old_lane],
            "output_artifact": format!(r"{old_lane}\result.json"), "fallback_strategy": null
        }));
        lead_hold_write(&lane.join("final-status.json"), json!({"status": "failed",
            "error": "failed to spawn agent runtime (codex)"}));
        let successor = cite_test_landscape(&json!({"extracted_json": {
            "requery_decision": "replace", "selected_hypothesis": {"statement": "a vetted successor",
                "primary_family": "family_b", "slate_candidate_id": "c2"}}}));
        // Local executor, no model/network. Its saved decision is still subject
        // to the real landscape, owner-slate and lead-protection gates below.
        std::fs::write(lane.join("task.md"), format!("process.stdout.write(JSON.stringify({successor}));")).unwrap();
        assert_eq!(std::process::Command::new("node").current_dir(old_root).output().unwrap_err().kind(),
            std::io::ErrorKind::NotFound);
        let healed = std::process::Command::new("node").arg("-e").arg(r#"
            const {healCycleOnce}=require(process.argv[1]+'/src/orchestrator/self_healing_cycle');
            healCycleOnce({cwd:process.argv[2],cycleId:'cycle-test'});
        "#).arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).arg(dir.path()).output().unwrap();
        assert!(healed.status.success(), "{}", String::from_utf8_lossy(&healed.stderr));
        assert!(!lane.join("final-status.json").exists());
        let contract: LaneContract = serde_json::from_value(lead_hold_read(&lane.join("lane-contract.json"))).unwrap();
        let executed = std::process::Command::new("node").arg(&contract.task_file)
            .current_dir(&contract.cwd).output().unwrap();
        assert!(executed.status.success(), "{}", String::from_utf8_lossy(&executed.stderr));
        assert_eq!(lead_hold_read(&hypothesis), retired, "relocation cannot promote a lead");
        let payload = serde_json::from_slice(&executed.stdout).unwrap();
        assert!(project_with_valid_landscape(&paths, &contract, &payload).unwrap().is_some());
        let advanced = snapshot();
        assert_eq!(advanced["progress"]["current_milestone"], "lead_selected");
        assert!(!advanced["findings"].as_array().unwrap().iter().any(|f|
            f["signature"] == "lane_churn:owner_selection:blocking_lane_recovery_planning"));
    }

    #[test]
    fn accepted_restart_receipt_breaks_measured_owner_selection_requery_churn() {
        // MEASURED ON cycle-a-20260919, 2026-11-06: 745 requery lanes
        // finished at owner_selection. The lead was withdrawn, but successor
        // plans omitted that status and still awaited administrative release.
        let (dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let retired = json!({
            "status": "withdrawn", "selected_hypothesis": null,
            "requery_decision": "restart", "projection_source": "lab_director_lane_result",
            "generated_by": "followup-lab-director-1866",
            "selected_at_epoch_ms": lead_hold_now_ms() - 60_000,
            "withdrawn_hypothesis": {"statement": "the old allocation claim", "projection_source": "lab_director_lane_result"},
            "lead_hold_released_by": null
        });
        lead_hold_write(&hypothesis_path, retired.clone());
        lead_hold_write(&paths.runtime_root.join("state/cycle-test-lead-hold.json"), json!({"lead": retired}));
        for (kind, value) in [
            ("field-landscape", json!({"subfields": [{}]})),
            ("frontier-harvest", json!({"top_k": []})),
            ("sota-cards", json!({"cards": [{}]})),
            ("field-beliefs", json!({"beliefs": [{}]})),
            ("candidate-slate", json!({"candidates": [{}]})),
            ("expert-panel", json!({"ranking": [{}]})),
            ("novelty-audit", json!({"audits": [{}]})),
            ("candidate-feasibility", json!({"assessments": [{}]})),
            ("owner-candidates", json!({"published_at": "2026-10-01T22:47:00Z", "candidates": [{"candidate_id": "c1"}, {"candidate_id": "c2"}]})),
            ("owner-selection", json!({"candidate_id": "c1", "decided_at": "2026-10-01T22:47:03Z"})),
            ("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z", "owner_selection": {"candidate_id": "c1", "released": false}})),
        ] {
            lead_hold_write(&paths.runtime_root.join(format!("state/cycle-test-{kind}.json")), value);
        }
        for n in 1122..1867 {
            let lane = paths.runtime_root.join(format!("lanes/cycle-test/followup-lab-director-{n}"));
            lead_hold_write(&lane.join("role-plan.json"), json!({
                "role": "lab-director", "action_type": "lab_director_requery_followup"
            }));
            lead_hold_write(&lane.join("final-status.json"), json!({
                "status": "completed", "completed_at": crate::core::support::now_iso()
            }));
        }
        let progress = || {
            let output = std::process::Command::new("node")
                .arg("-e").arg("const m=require(process.argv[1]); const p=m.deriveProgress({cwd:process.argv[2],cycleId:'cycle-test'}); console.log(JSON.stringify({progress:p,findings:m.stallFindings({progress:p,config:m.supervisorConfig({})})}));")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/orchestrator/cycle_progress.js"))
                .arg(dir.path()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let stuck = progress();
        assert_eq!(stuck["progress"]["current_milestone"], "owner_selection");
        assert_eq!(stuck["progress"]["waiting_on"], json!(["lead_selected_not_published: lab-director-hypothesis has not been written"]));
        assert_eq!(stuck["progress"]["lanes_since_milestone"]["by_action_type"]["lab_director_requery_followup"]["total"], 745);
        assert!(stuck["findings"].as_array().unwrap().iter().any(|f| f["signature"] == "lane_churn:owner_selection:lab_director_requery_followup"));

        let receipt = crate::labdirector::current_lead_under_review(&paths, "cycle-test");
        assert_eq!(receipt["status"], "withdrawn");
        assert_eq!(receipt["requery_decision"], "restart");
        assert_eq!(receipt["projection_source"], "lab_director_lane_result");
        assert!(receipt["statement"].is_null());
        // The nullable release reason on a repeated withdrawal is not a live
        // hold. The accepted status tells the next director it already applied.
        assert!(receipt["lead_hold_released_by"].is_null());
        assert!(receipt["note"].as_str().unwrap().contains("no incumbent lead hold to release"));

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let successor = lead_hold_replacement("a director-authored successor method");
        let mut unvetted = successor.clone();
        unvetted["extracted_json"]["selected_hypothesis"]["slate_candidate_id"] = json!("unvetted");
        assert!(project_with_valid_landscape(&paths, &contract, &unvetted).unwrap().is_none());
        let mut vetted = successor;
        vetted["extracted_json"]["selected_hypothesis"]["slate_candidate_id"] = json!("c2");
        project_with_valid_landscape(&paths, &contract, &vetted).unwrap();
        assert_eq!(progress()["progress"]["current_milestone"], "lead_selected");
        assert!(!progress()["findings"].as_array().unwrap().iter().any(|f| f["signature"] == "lane_churn:owner_selection:lab_director_requery_followup"));
    }

    #[test]
    fn a_lead_is_not_replaced_before_its_own_evidence_is_gated() {
        // cycle-g-v91: four replacements in 3.5 hours, each gate review rejecting
        // a lead "no supplied validation executes".
        let (_dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let contract = test_contract("lab-director", PathBuf::from("task.md"));

        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("an untested new idea")).unwrap();
        let held = lead_hold_read(&hypothesis_path);
        assert_eq!(held["statement"], json!("the lead being tested"));
        assert_eq!(held["replacement_deferred"][0]["statement"], json!("an untested new idea"));
        assert_eq!(held["replacement_deferred"][0]["lane_id"], json!("lab-director-01"));

        let handoff = paths.runtime_root.join("lanes/cycle-test/followup-analyst-01/handoff-validation-plan.json");
        lead_hold_write(&handoff, json!({}));
        lead_hold_runner(&paths, "followup-runner-01", &handoff, json!({
            "blueprint_executions": [{ "status": "completed", "produced_evidence": true, "metrics": { "gain": 0.1 } }]
        }));
        // Evidence alone does not release it; the gate has to have read it.
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("an untested new idea")).unwrap();
        assert_eq!(lead_hold_read(&hypothesis_path)["statement"], json!("the lead being tested"));

        lead_hold_tick();
        lead_hold_gatekeeper(&paths, "followup-gatekeeper-01");
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("an untested new idea")).unwrap();
        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("an untested new idea"));
        assert_eq!(replaced["lead_hold_released_by"], json!("lead_evidence_reviewed_by_gate"));
        assert_eq!(replaced["replacement_deferred"], json!([]));
        assert!(replaced["selected_at_epoch_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn an_exact_gate_review_releases_a_lead_selected_from_materialized_evidence() {
        // MEASURED ON cycle-a-20260919, 2026-10-05: lead 425 was
        // selected from completed Runner-140 evidence and forbade a rerun.
        // Gatekeeper-219 rejected that exact lead, but the hold ignored the
        // pre-selection runner and indefinitely deferred its replacement order.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let handoff = paths
            .runtime_root
            .join("lanes/cycle-test/followup-analyst-01/handoff-validation-plan.json");
        lead_hold_write(
            &handoff,
            json!({"dataset": "/sealed/resource_matched/episodes.csv"}),
        );
        lead_hold_runner(
            &paths,
            "followup-runner-140",
            &handoff,
            json!({
                "blueprint_executions": [{
                    "status": "completed",
                    "produced_evidence": true,
                    "metrics": {"gain": 0.1}
                }]
            }),
        );

        lead_hold_tick();
        let selected_ms = lead_hold_now_ms();
        let hypothesis_path = paths
            .runtime_root
            .join("state/cycle-test-lab-director-hypothesis.json");
        lead_hold_write(
            &hypothesis_path,
            json!({
                "statement": "the materialized lead being tested",
                "primary_family": "family_a",
                "dataset_or_accession": "/sealed/resource_matched/episodes.csv",
                "validation_data_status": "materialized",
                "identification_strategy": {
                    "dataset_or_accession": "/sealed/resource_matched/episodes.csv",
                    "materialized_dataset": {"rows": 12000},
                    "validation_data_status": "materialized"
                },
                "selected_at_epoch_ms": selected_ms,
            }),
        );

        lead_hold_tick();
        let gate = paths
            .runtime_root
            .join("lanes/cycle-test/followup-gatekeeper-219");
        lead_hold_write(
            &gate.join("role-plan.json"),
            json!({"planner_metadata": {"current_lead_under_review": {
                "statement": "the materialized lead being tested"
            }}}),
        );
        lead_hold_write(
            &gate.join("result.json"),
            json!({"extracted_json": {
                "verdict": "reject",
                "rubric": [{"name": "novelty", "score": 40}]
            }}),
        );
        lead_hold_write(
            &gate.join("final-status.json"),
            json!({"status": "completed"}),
        );

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let mut replacement = lead_hold_replacement("the executable replacement");
        replacement["extracted_json"]["simulation_orders"] = json!([{
            "request_id": "loss_iteration_support_v1",
            "simulator_backend": "mujoco",
            "output_path": ".research-lab/datasets/cycle-test/simulations/loss_iteration_support_v1/episodes.csv"
        }]);
        project_with_valid_landscape(
            &paths,
            &contract,
            &replacement,
        )
        .unwrap();
        super::project_lab_director_simulation_orders(&paths, &contract, &replacement).unwrap();

        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("the executable replacement"));
        assert_eq!(
            replaced["lead_hold_released_by"],
            json!("lead_evidence_reviewed_by_gate")
        );
        assert_eq!(replaced["replacement_deferred"], json!([]));
        let orders =
            crate::labdirector::latest_lab_director_simulation_orders(&paths, "cycle-test")
                .unwrap();
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0]["request_id"], json!("loss_iteration_support_v1"));
    }

    #[test]
    fn a_deferred_replacement_cannot_withdraw_the_selected_leads_simulation_order() {
        // MEASURED ON cycle-a-20260919, 2026-10-02: three
        // simulation_data_generation_followup lanes completed, then a deferred
        // replacement's `simulation_orders: null` erased their selected order;
        // the progress pipeline stayed at lead_selected instead of advancing.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let mut incumbent_contract = test_contract("lab-director", PathBuf::from("task.md"));
        incumbent_contract.lane_id = "followup-lab-director-325".to_string();
        let incumbent = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": {
                    "statement": "the protected support-metric lead",
                    "primary_family": "support_metric_measurement_invariance"
                },
                "simulation_orders": [{
                    "request_id": "support_metric_discordance_v2",
                    "simulator_backend": "mujoco",
                    "output_path": ".research-lab/datasets/cycle-test/simulations/support_metric_discordance_v2/episodes.csv"
                }]
            }
        });
        let incumbent = cite_test_landscape(&incumbent);
        write_valid_test_landscape(&paths);
        project_lab_director_payload_to_hypothesis(
            &paths,
            &incumbent_contract,
            &incumbent,
        )
        .unwrap();
        super::project_lab_director_simulation_orders(
            &paths,
            &incumbent_contract,
            &incumbent,
        )
        .unwrap();

        let mut replacement_contract = incumbent_contract.clone();
        replacement_contract.lane_id = "followup-lab-director-326".to_string();
        let replacement = cite_test_landscape(&json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": {
                    "statement": "the materialized adaptive-retrieval replacement",
                    "primary_family": "axis_specific_adaptive_retrieval_rescue"
                },
                "simulation_orders": null
            }
        }));
        project_lab_director_payload_to_hypothesis(
            &paths,
            &replacement_contract,
            &replacement,
        )
        .unwrap();
        super::project_lab_director_simulation_orders(
            &paths,
            &replacement_contract,
            &replacement,
        )
        .unwrap();

        let lead = lead_hold_read(
            &paths
                .runtime_root
                .join("state/cycle-test-lab-director-hypothesis.json"),
        );
        assert_eq!(lead["statement"], json!("the protected support-metric lead"));
        assert_eq!(
            lead["replacement_deferred"][0]["lane_id"],
            json!("followup-lab-director-326")
        );
        let orders =
            crate::labdirector::latest_lab_director_simulation_orders(&paths, "cycle-test")
                .unwrap();
        assert_eq!(
            orders.len(),
            1,
            "the reproduction-anchor order was withdrawn"
        );
        assert_eq!(
            orders[0]["request_id"],
            json!("support_metric_discordance_v2")
        );
    }

    #[test]
    fn an_upheld_refinement_can_issue_the_selected_leads_materialization_order() {
        // MEASURED ON cycle-a-20260919, 2026-10-06: at lead_selected,
        // five comparator Analysts completed against no bundle because final
        // director upholds sharpened the statement but kept this exact family
        // and output path; the lead hold misclassified every uphold as a pivot
        // and simulation-orders stayed null.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let mut first_contract = test_contract("lab-director", PathBuf::from("task.md"));
        first_contract.lane_id = "followup-lab-director-449".to_string();
        let output = ".research-lab/datasets/cycle-test/simulations/forced_impulse_recovery_v1/episodes.csv";
        let first = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": {
                    "statement": "A feasible impulse exposes a recovery crossover.",
                    "primary_family": "forced_disturbance_recovery_assay",
                    "dataset_or_accession": output,
                    "validation_data_status": "needs_materialization"
                },
                "simulation_orders": null
            }
        });
        project_with_valid_landscape(&paths, &first_contract, &first).unwrap();
        super::project_lab_director_simulation_orders(&paths, &first_contract, &first).unwrap();

        let mut uphold_contract = first_contract.clone();
        uphold_contract.lane_id = "followup-lab-director-451".to_string();
        let uphold = cite_test_landscape(&json!({
            "status": "completed",
            "extracted_json": {
                "decision_status": "final",
                "requery_decision": "uphold",
                "selected_hypothesis": {
                    "statement": "Across four fixed checkpoints, a feasible impulse exposes a coverage-conditioned recovery crossover.",
                    "primary_family": "forced_disturbance_recovery_assay",
                    "dataset_or_accession": output,
                    "validation_data_status": "needs_materialization"
                },
                "simulation_orders": [{
                    "request_id": "forced_impulse_recovery_v1",
                    "simulator_backend": "mujoco",
                    "output_path": output
                }]
            }
        }));
        project_lab_director_payload_to_hypothesis(&paths, &uphold_contract, &uphold).unwrap();
        super::project_lab_director_simulation_orders(&paths, &uphold_contract, &uphold).unwrap();

        let lead = lead_hold_read(
            &paths
                .runtime_root
                .join("state/cycle-test-lab-director-hypothesis.json"),
        );
        assert_eq!(lead["generated_by"], json!("followup-lab-director-451"));
        assert_eq!(lead["replacement_deferred"], json!([]));
        let orders =
            crate::labdirector::latest_lab_director_simulation_orders(&paths, "cycle-test")
                .unwrap();
        assert_eq!(orders.len(), 1, "the materialization order remained stuck");
        assert_eq!(orders[0]["request_id"], json!("forced_impulse_recovery_v1"));
    }

    #[test]
    fn an_uphold_keeps_the_claim_the_analysis_contract_is_made_of() {
        // MEASURED ON cycle-a-20260919, 2026-10-15: four upholds re-worded
        // the lead ("{0.10, ..., 0.16}" -> "0.10 through 0.16"); each wording was a
        // new analysis contract and every executable handoff went stale.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let hypothesis_path = paths.runtime_root.join("state/cycle-test-lab-director-hypothesis.json");
        let output = ".research-lab/datasets/cycle-test/simulations/paired_v1/episodes.csv";
        let lead = |statement: &str, threshold: &str, family: &str| {
            json!({
                "statement": statement,
                "primary_family": family,
                "dataset_or_accession": output,
                "identification_strategy": { "estimands": [format!("paired difference at {threshold}")] },
                "falsification_conditions": [format!("falsify if any threshold in {threshold} differs")],
                "rival_mechanisms": ["checkpoint quality"],
            })
        };
        let decide = |lane: &str, decision: &str, selected: serde_json::Value| {
            let mut contract = test_contract("lab-director", PathBuf::from("task.md"));
            contract.lane_id = lane.to_string();
            let payload = json!({ "status": "completed", "extracted_json": { "requery_decision": decision, "selected_hypothesis": selected } });
            project_with_valid_landscape(&paths, &contract, &payload).unwrap();
            lead_hold_read(&hypothesis_path)
        };

        decide("followup-lab-director-880", "replace", lead("The ranking is a threshold artifact.", "{0.10, ..., 0.16}", "paired_threshold"));
        let upheld = decide(
            "followup-lab-director-883",
            "uphold",
            lead("The apparent ranking is a threshold/adjustment artifact.", "0.10 through 0.16", "paired_threshold"),
        );
        // The canonical claim is the one selected, field for field.
        assert_eq!(upheld["statement"], json!("The ranking is a threshold artifact."));
        assert_eq!(upheld["selected_hypothesis"]["statement"], json!("The ranking is a threshold artifact."));
        assert_eq!(
            upheld["selected_hypothesis"]["identification_strategy"]["estimands"],
            json!(["paired difference at {0.10, ..., 0.16}"])
        );
        assert_eq!(
            upheld["selected_hypothesis"]["falsification_conditions"],
            json!(["falsify if any threshold in {0.10, ..., 0.16} differs"])
        );
        // The decision is still this director's, and its wording is kept beside it.
        assert_eq!(upheld["generated_by"], json!("followup-lab-director-883"));
        assert_eq!(upheld["upheld_restatements"][0]["lane_id"], json!("followup-lab-director-883"));
        assert_eq!(
            upheld["upheld_restatements"][0]["statement"],
            json!("The apparent ranking is a threshold/adjustment artifact.")
        );

        // An uphold in the same words changes nothing and records nothing new.
        let same = decide("followup-lab-director-884", "uphold", lead("The ranking is a threshold artifact.", "{0.10, ..., 0.16}", "paired_threshold"));
        assert_eq!(same["upheld_restatements"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_lead_its_own_validation_falsified_can_be_replaced_at_once() {
        let (_dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let handoff = paths.runtime_root.join("lanes/cycle-test/followup-analyst-01/handoff-validation-plan.json");
        lead_hold_write(&handoff, json!({}));
        lead_hold_runner(&paths, "followup-runner-01", &handoff, json!({
            "blueprint_executions": [{
                "status": "completed", "produced_evidence": true,
                "metrics": { "pass_fail": "fail", "resolution_status": "valid_falsification" }
            }]
        }));
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("a different method")).unwrap();
        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("a different method"));
        assert_eq!(replaced["lead_hold_released_by"], json!("lead_falsified_by_its_own_validation"));
    }

    #[test]
    fn a_lead_its_own_fail_closed_invalid_design_can_be_replaced_at_once() {
        // MEASURED ON cycle-a-20260919, 2026-10-26: runner 777
        // completed the v1 validity gate with produced_evidence=false and
        // not_estimable_design_invalid. After three gate rounds, three director
        // decisions for the executable v2 order were still held behind v1.
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        let mut incumbent = lead_hold_read(&hypothesis_path);
        incumbent["dataset_or_accession"] = json!("directional_support_cell_ablation_v1");
        incumbent["identification_strategy"] = json!({
            "dataset_or_accession": "directional_support_cell_ablation_v1",
            "validation_data_status": "materialized"
        });
        lead_hold_write(&hypothesis_path, incumbent);
        for _ in 0..3 {
            lead_hold_gate_decision(&paths);
        }

        lead_hold_tick();
        let handoff = paths.runtime_root.join(
            "lanes/cycle-test/followup-analyst-1308/handoff-validation-plan.json",
        );
        lead_hold_write(&handoff, json!({}));
        lead_hold_runner(&paths, "followup-runner-777", &handoff, json!({
            "blueprint_executions": [{
                "status": "completed",
                "produced_evidence": false,
                "metrics": {
                    "pass_fail": "fail",
                    "resolution_status": "not_estimable_design_invalid"
                }
            }]
        }));

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let replacement = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "rationale": "retain the family but replace its invalid control prospectively",
                "selected_hypothesis": {
                    "statement": "the twin-remote deletion design",
                    "primary_family": "family_a",
                    "dataset_or_accession": "directional_support_cell_ablation_v2"
                },
                "simulation_orders": [{
                    "request_id": "directional_support_cell_ablation_v2",
                    "simulator_backend": "mujoco",
                    "output_path": ".research-lab/datasets/cycle-test/simulations/directional_support_cell_ablation_v2/episodes.csv"
                }]
            }
        });
        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();
        super::project_lab_director_simulation_orders(&paths, &contract, &replacement).unwrap();

        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("the twin-remote deletion design"));
        assert_eq!(
            replaced["lead_hold_released_by"],
            json!("lead_design_invalidated_by_its_own_validation")
        );
        let orders =
            crate::labdirector::latest_lab_director_simulation_orders(&paths, "cycle-test")
                .unwrap();
        assert_eq!(
            orders[0]["request_id"],
            json!("directional_support_cell_ablation_v2")
        );
    }

    #[test]
    fn a_reviewed_selected_simulation_blocker_releases_the_lead_hold() {
        // MEASURED ON cycle-a-20260919, 2026-10-04: at
        // reproduction_anchor the selected competence-matching order returned
        // zero rows with return code 2 because its novelty/anchor preconditions
        // were uncleared. Gatekeeper-204 reviewed that exact lead, but three
        // director replacements stayed deferred and needs_materialization could
        // never move to the replacement's executable order.
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        let incumbent_statement = "the lead being tested";
        let incumbent_output =
            ".research-lab/datasets/cycle-test/simulations/blocked_lead/episodes.csv";
        let mut incumbent = lead_hold_read(&hypothesis_path);
        incumbent["dataset_or_accession"] = json!(incumbent_output);
        incumbent["validation_data_status"] = json!("needs_materialization");
        incumbent["identification_strategy"] = json!({
            "dataset_or_accession": incumbent_output,
            "validation_data_status": "needs_materialization"
        });
        lead_hold_write(&hypothesis_path, incumbent);

        let engineer_dir = paths
            .runtime_root
            .join("lanes/cycle-test/followup-engineer-338");
        lead_hold_write(
            &engineer_dir.join("role-plan.json"),
            json!({
                "action_type": crate::labdirector::SIMULATION_DATA_GENERATION_ACTION,
                "planner_metadata": { "simulation_order": {
                    "request_id": "blocked_lead",
                    "output_path": incumbent_output
                }}
            }),
        );
        lead_hold_write(
            &engineer_dir.join("result.json"),
            json!({ "extracted_json": {
                "capability_blockers": [{"requirement": "ordered preconditions are unresolved"}],
                "simulation_outputs": [{
                    "request_id": "blocked_lead", "rows": 0, "return_code": 2
                }]
            }}),
        );
        lead_hold_write(
            &engineer_dir.join("final-status.json"),
            json!({ "status": "completed" }),
        );

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let mut replacement = lead_hold_replacement("the executable replacement");
        replacement["extracted_json"]["simulation_orders"] = json!([{
            "request_id": "executable_replacement",
            "simulator_backend": "mujoco",
            "output_path": ".research-lab/datasets/cycle-test/simulations/executable_replacement/episodes.csv"
        }]);
        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();
        assert_eq!(
            lead_hold_read(&hypothesis_path)["statement"],
            json!(incumbent_statement),
            "an unreviewed execution blocker released the safety hold"
        );

        lead_hold_tick();
        let gate_dir = paths
            .runtime_root
            .join("lanes/cycle-test/followup-gatekeeper-204");
        lead_hold_write(
            &gate_dir.join("role-plan.json"),
            json!({ "planner_metadata": { "current_lead_under_review": {
                "statement": incumbent_statement
            }}}),
        );
        lead_hold_write(
            &gate_dir.join("result.json"),
            json!({ "extracted_json": {
                "verdict": "reject",
                "rubric": [{"name": "novelty", "score": 56}]
            }}),
        );
        lead_hold_write(
            &gate_dir.join("final-status.json"),
            json!({ "status": "completed" }),
        );

        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();
        super::project_lab_director_simulation_orders(&paths, &contract, &replacement).unwrap();
        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("the executable replacement"));
        assert_eq!(
            replaced["lead_hold_released_by"],
            json!("lead_execution_blocker_reviewed_by_gate")
        );
        assert_eq!(replaced["replacement_deferred"], json!([]));
        let orders =
            crate::labdirector::latest_lab_director_simulation_orders(&paths, "cycle-test")
                .unwrap();
        assert_eq!(orders[0]["request_id"], json!("executable_replacement"));
    }

    #[test]
    fn evidence_from_a_handoff_written_before_the_lead_does_not_release_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let handoff = paths.runtime_root.join("lanes/cycle-test/followup-analyst-01/handoff-validation-plan.json");
        lead_hold_write(&handoff, json!({}));
        lead_hold_tick();
        let hypothesis_path = paths.runtime_root.join("state").join("cycle-test-lab-director-hypothesis.json");
        lead_hold_write(&hypothesis_path, json!({
            "statement": "the lead being tested",
            "selected_at_epoch_ms": lead_hold_now_ms(),
        }));
        lead_hold_tick();
        lead_hold_runner(&paths, "followup-runner-01", &handoff, json!({
            "blueprint_executions": [{ "status": "completed", "produced_evidence": true, "metrics": { "gain": 0.1 } }]
        }));
        lead_hold_tick();
        lead_hold_gatekeeper(&paths, "followup-gatekeeper-01");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("an untested new idea")).unwrap();
        assert_eq!(lead_hold_read(&hypothesis_path)["statement"], json!("the lead being tested"));
    }

    #[test]
    fn a_lead_nothing_validated_is_released_by_the_round_ceiling() {
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        let history = paths.runtime_root.join("state").join("cycle-test-watchdog-history.jsonl");
        std::fs::write(
            &history,
            format!(
                "{}\n{}\n",
                json!({ "epoch_ms": selected - 1, "gate_rounds": 10 }),
                // 4 is the default hold; the constant is private to the projection.
                json!({ "epoch_ms": lead_hold_now_ms(), "gate_rounds": 14 }),
            ),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("after a long wait")).unwrap();
        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("after a long wait"));
        assert_eq!(replaced["lead_hold_released_by"], json!("lead_hold_round_ceiling_reached"));
    }

    #[test]
    fn completed_gate_rounds_release_a_lead_without_watchdog_history() {
        // MEASURED ON cycle-a-20260919, 2026-10-01: the watchdog
        // history file was absent, so `gate_rounds_held` remained null and 13
        // gate-restart followups could not move reproduction_anchor to the
        // replacement. Rounds are then read from the recorded gate decisions.
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        for _ in 1..=3 {
            lead_hold_gate_decision(&paths);
        }
        assert!(!paths
            .runtime_root
            .join("state")
            .join("cycle-test-watchdog-history.jsonl")
            .exists());

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let replacement = lead_hold_replacement("the now-actionable replacement");
        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();
        assert_eq!(
            lead_hold_read(&hypothesis_path)["statement"],
            json!("the lead being tested"),
            "the four-round safety threshold was weakened"
        );

        lead_hold_gate_decision(&paths);
        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();

        let replaced = lead_hold_read(&hypothesis_path);
        assert_eq!(replaced["statement"], json!("the now-actionable replacement"));
        assert_eq!(
            replaced["lead_hold_released_by"],
            json!("lead_hold_round_ceiling_reached")
        );
    }

    #[test]
    fn gatekeeper_lanes_of_one_round_are_one_round() {
        // MEASURED ON cycle-a-20260919, 2026-10-01: eight gatekeeper
        // lanes -- rubric re-reviews and gate-restart challenges -- completed
        // after the lead was selected, around one recorded gate decision. A
        // count of lanes released the four-round hold after that one round.
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        for lane in 1..=8 {
            lead_hold_gatekeeper(&paths, &format!("followup-gatekeeper-{lane:02}"));
        }
        lead_hold_gate_decision(&paths);

        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let replacement = lead_hold_replacement("a replacement after one round");
        project_with_valid_landscape(&paths, &contract, &replacement).unwrap();
        assert_eq!(
            lead_hold_read(&hypothesis_path)["statement"],
            json!("the lead being tested"),
            "eight gatekeeper lanes of one gate round released a four-round hold"
        );
    }

    #[test]
    fn an_agent_rewriting_the_lead_file_does_not_release_the_hold() {
        // cycle-g-v91 followup-lab-director-75: the agent deleted the lead file
        // and added its own without a top-level statement, and the projection
        // that followed found no current lead to hold.
        let (_dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        // An uphold through the projection establishes its own record of the lead.
        let uphold = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": { "statement": "the lead being tested", "primary_family": "family_a" }
            }
        });
        project_with_valid_landscape(&paths, &contract, &uphold).unwrap();

        lead_hold_write(&hypothesis_path, json!({
            "decision": "replace",
            "generated_by": "followup-lab-director-75",
            "selected_hypothesis": { "statement": "an untested new idea" },
        }));
        project_with_valid_landscape(&paths, &contract, &lead_hold_replacement("an untested new idea")).unwrap();

        let restored = lead_hold_read(&hypothesis_path);
        assert_eq!(restored["statement"], json!("the lead being tested"), "the held lead was not restored");
        assert_eq!(restored["replacement_deferred"][0]["statement"], json!("an untested new idea"));
    }

    // cycle-a-20260919, 2026-10-02: director-335 started on one lead,
    // -334 replaced it, and -335's uphold of the old lead was written back over
    // -334's choice.
    #[test]
    fn a_decision_on_a_lead_replaced_while_the_lane_ran_is_not_projected() {
        let (_dir, paths, hypothesis_path) = lead_hold_setup(lead_hold_now_ms() - 60_000);
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let context = paths
            .runtime_root
            .join("lanes/cycle-test")
            .join(&contract.lane_id)
            .join("execution-context.json");
        lead_hold_write(&context, json!({}));
        let started = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        std::fs::File::options().write(true).open(&context).unwrap().set_modified(started).unwrap();
        // Another director chose the current lead after this lane started.
        let mut current = lead_hold_read(&hypothesis_path);
        current["selected_at_epoch_ms"] = json!(lead_hold_now_ms() - 30_000);
        current["generated_by"] = json!("followup-lab-director-334");
        lead_hold_write(&hypothesis_path, current.clone());

        let stale = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": { "statement": "the lead this lane was shown", "primary_family": "family_c" }
            }
        });
        assert!(project_with_valid_landscape(&paths, &contract, &stale).unwrap().is_none());
        assert_eq!(lead_hold_read(&hypothesis_path)["statement"], current["statement"]);
        let events = std::fs::read_to_string(
            crate::core::support::harness_notices_path(&paths, "cycle-test"),
        )
        .unwrap();
        assert!(events.contains("labdirector_decision_stale"), "{events}");

        // A lane that started after the lead was chosen decides on it as usual.
        std::fs::File::options()
            .write(true)
            .open(&context)
            .unwrap()
            .set_modified(std::time::SystemTime::now())
            .unwrap();
        let uphold = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": { "statement": "the lead being tested", "primary_family": "family_a" }
            }
        });
        assert!(project_with_valid_landscape(&paths, &contract, &uphold).unwrap().is_some());
    }

    #[test]
    fn an_uphold_keeps_the_date_the_lead_was_chosen() {
        let selected = lead_hold_now_ms() - 60_000;
        let (_dir, paths, hypothesis_path) = lead_hold_setup(selected);
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let uphold = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": { "statement": "the lead being tested", "primary_family": "family_a" }
            }
        });
        project_with_valid_landscape(&paths, &contract, &uphold).unwrap();
        assert_eq!(lead_hold_read(&hypothesis_path)["selected_at_epoch_ms"], json!(selected));
    }

    #[test]
    fn lab_director_projection_drops_stale_materialized_dataset_when_dataset_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        std::fs::write(
            &hypothesis_path,
            serde_json::to_string(&json!({
                "statement": "stale GSE282742 audit claim",
                "dataset_or_accession": "GSE282742",
                "identification_strategy": {
                    "dataset_or_accession": "GSE282742",
                    "validation_data_status": "materialized",
                    "materialized_dataset": {
                        "bundle_path": "/tmp/researchlab/gse282742",
                        "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": {
                    "statement": "In GSE289864, anti-PD1 glioblastoma tumors harbor a MAIT17/RORC-high suppressive circuit.",
                    "dataset_or_accession": "GSE289864",
                    "validation_data_status": "materialized",
                    "primary_family": "tumor_immune_resistance"
                }
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["dataset_or_accession"], json!("GSE289864"));
        assert_eq!(
            updated["identification_strategy"]["dataset_or_accession"],
            json!("GSE289864")
        );
        assert!(updated["identification_strategy"]
            .get("materialized_dataset")
            .is_none());
        assert_eq!(
            updated["validation_data_status"],
            json!("needs_materialization")
        );
        assert!(!serde_json::to_string(&updated["identification_strategy"])
            .unwrap()
            .to_ascii_lowercase()
            .contains("gse282742"));
    }

    #[test]
    fn lab_director_projection_clears_stale_identity_when_statement_implies_new_accession() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        std::fs::write(
            &hypothesis_path,
            serde_json::to_string(&json!({
                "statement": "old breast metastasis lead",
                "hypothesis_id": "hyp-example-materialized",
                "primary_family": "classified_tumor_microenvironment",
                "dataset_or_accession": "GSE322943",
                "identification_strategy": {
                    "dataset_or_accession": "GSE322943"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": {
                    "statement": "In GSE228779 GeoMx spatial transcriptomics, liver-cell interferon injury distinguishes vaccine-associated liver injury from autoimmune hepatitis.",
                    "why_selected": "Structurally distinct replacement; fields still need Analyst refresh."
                }
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["dataset_or_accession"], json!("GSE228779"));
        assert!(updated["hypothesis_id"].is_null());
        assert!(updated["primary_family"].is_null());
        assert_eq!(
            updated["identification_strategy"]["dataset_or_accession"],
            json!("GSE228779")
        );
    }

    #[test]
    fn lab_director_projection_infers_dataset_from_lead_context_without_stale_hybrid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        std::fs::write(
            &hypothesis_path,
            serde_json::to_string(&json!({
                "statement": "In GSE318067, SLE severity rises across RBM and SomaLogic protein assays.",
                "hypothesis_id": "HYP-GSE318067-SLE-PROTEIN-SEVERITY-01",
                "dataset_or_accession": null,
                "selected_hypothesis": {
                    "statement": "In GSE318067, SLE severity rises across RBM and SomaLogic protein assays."
                },
                "identification_strategy": {
                    "dataset_or_accession": "GSE318067",
                    "validation_data_status": "materialized",
                    "materialized_dataset": {
                        "bundle_path": "/tmp/researchlab/gse318067",
                        "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE318067"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "replace",
                "selected_hypothesis": {
                    "statement": "In vaccine-induced liver injury, a liver-cell-enriched interferon and antigen-presentation transcriptomic program distinguishes VILI from autoimmune hepatitis beyond region, TMA/batch, QC, and repeated-patient effects.",
                    "why_selected": "Selected lead: materialized, clinically decision-relevant, mechanism-level, and directly testable with GSE228779 segment metadata and expression matrix."
                }
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["dataset_or_accession"], json!("GSE228779"));
        assert!(updated["hypothesis_id"].is_null());
        assert_eq!(
            updated["identification_strategy"]["dataset_or_accession"],
            json!("GSE228779")
        );
        assert!(updated["identification_strategy"]
            .get("materialized_dataset")
            .is_none());
        assert!(!serde_json::to_string(&updated["identification_strategy"])
            .unwrap()
            .to_ascii_lowercase()
            .contains("gse318067"));
    }

    #[test]
    fn lab_director_projection_accepts_top_level_selected_hypothesis_payload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "requery_decision": "replace",
            "selected_hypothesis": {
                "statement": "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell interferon activation.",
                "dataset_or_accession": "GSE228779",
                "validation_data_status": "materialized"
            }
        });

        let projected =
            project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        assert_eq!(projected.as_deref(), Some(hypothesis_path.as_path()));
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["dataset_or_accession"], json!("GSE228779"));
        assert_eq!(
            updated["selected_hypothesis"]["statement"],
            json!("In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell interferon activation.")
        );
    }

    #[test]
    fn lab_director_projection_does_not_promote_replacement_rivals_on_uphold() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        let existing = json!({
            "statement": "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH primarily through liver-cell mitochondrial injury with lower interferon response.",
            "primary_family": "classified_spatial_liver_injury_interferon_decoupling",
            "dataset_or_accession": "GSE228779",
            "selected_hypothesis": {
                "statement": "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH primarily through liver-cell mitochondrial injury with lower interferon response.",
                "primary_family": "classified_spatial_liver_injury_interferon_decoupling",
                "dataset_or_accession": "GSE228779"
            },
            "identification_strategy": {
                "dataset_or_accession": "GSE228779",
                "validation_data_status": "materialized"
            }
        });
        std::fs::write(&hypothesis_path, serde_json::to_string(&existing).unwrap()).unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "summary": "Uphold GSE228779; listed replacements are rivals only.",
                "selected_hypothesis": null,
                "replacement_hypotheses": [{
                    "statement": "GSE318067 autoimmune proteogenomic discordance remains a contingent rival, not the active replacement.",
                    "why_selected": "Retained only as fallback."
                }]
            }
        });

        let projected =
            project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        assert!(projected.is_none());
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated, existing);
    }

    #[test]
    fn lab_director_projection_removes_mismatched_materialized_dataset_for_same_accession() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        std::fs::write(
            &hypothesis_path,
            serde_json::to_string(&json!({
                "statement": "In GSE289864, anti-PD1 glioblastoma tumors harbor a MAIT17/RORC-high suppressive circuit.",
                "primary_family": "reproducibility_audit",
                "dataset_or_accession": "GSE289864",
                "identification_strategy": {
                    "dataset_or_accession": "GSE289864",
                    "validation_data_status": "materialized",
                    "materialized_dataset": {
                        "bundle_path": "/tmp/researchlab/gse282742",
                        "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "selected_hypothesis": {
                    "statement": "In GSE289864, anti-PD1 glioblastoma tumors harbor a MAIT17/RORC-high suppressive circuit.",
                    "primary_family": "tumor_immune_resistance",
                    "dataset_or_accession": "GSE289864"
                }
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(updated["dataset_or_accession"], json!("GSE289864"));
        assert_eq!(updated["primary_family"], json!("tumor_immune_resistance"));
        assert_eq!(
            updated["identification_strategy"]["dataset_or_accession"],
            json!("GSE289864")
        );
        assert!(updated["identification_strategy"]
            .get("materialized_dataset")
            .is_none());
        assert_eq!(
            updated["identification_strategy"]["validation_data_status"],
            json!("needs_materialization")
        );
        assert!(!serde_json::to_string(&updated["identification_strategy"])
            .unwrap()
            .to_ascii_lowercase()
            .contains("gse282742"));
    }

    #[test]
    fn lab_director_projection_accepts_nested_string_materialized_dataset() {
        // MEASURED ON cycle-a-20260919, 2026-10-03: the selected lead
        // named its completed procedural CSV under identification_strategy, yet
        // four requeries projected needs_materialization at the top level.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        let dataset = ".research-lab/datasets/cycle-test/simulations/head_to_head/episodes.csv";
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "status": "completed",
            "extracted_json": {
                "requery_decision": "uphold",
                "selected_hypothesis": {
                    "statement": "Compare policies on the completed shared-state simulation.",
                    "primary_family": "shared_coverage_decay",
                    "dataset_or_accession": dataset,
                    "validation_data_status": "materialized",
                    "identification_strategy": {
                        "validation_data_status": "materialized",
                        "materialized_dataset": dataset
                    }
                }
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&hypothesis_path).unwrap(),
        )
        .unwrap();
        assert_eq!(updated["validation_data_status"], json!("materialized"));
        assert_eq!(
            updated["identification_strategy"]["materialized_dataset"],
            json!(dataset)
        );
    }

    #[test]
    fn lab_director_projection_extracts_embedded_kg_first_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        std::fs::create_dir_all(paths.runtime_root.join("state")).unwrap();
        let hypothesis_path = paths
            .runtime_root
            .join("state")
            .join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let payload = json!({
            "extracted_json": {
                "requery_decision": "replace",
                "replacement_hypotheses": [{
                    "statement": "RPPA pathway activity improves TCGA-BRCA survival stratification.",
                    "why_selected": "KG-supported lead.\nprimary_family: tcga-rppa-pathway-survival\nvalidation_data_status: needs_materialization\ndataset_or_accession: TCGA-BRCA"
                }]
            }
        });

        project_with_valid_landscape(&paths, &contract, &payload).unwrap();
        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(
            updated["primary_family"],
            json!("tcga-rppa-pathway-survival")
        );
        assert_eq!(updated["dataset_or_accession"], json!("TCGA-BRCA"));
        assert_eq!(
            updated["validation_data_status"],
            json!("needs_materialization")
        );
    }

    #[test]
    fn role_plan_dataset_override_follows_analysis_request_handoff() {
        let dataset_root = PathBuf::from("/tmp/researchlab/gse282742");
        let role_plan = json!({
            "planner_metadata": {
                "analysis_request": {
                    "analyst_handoff": {
                        "dataset_root": dataset_root.display().to_string()
                    }
                }
            }
        });

        assert_eq!(
            role_plan_dataset_override(Some(&role_plan)),
            Some(dataset_root)
        );
    }

    #[test]
    fn role_plan_dataset_override_follows_lab_runner_handoff() {
        let dataset_root = PathBuf::from("/tmp/researchlab/gse289864");
        let role_plan = json!({
            "lab_runner": {
                "analyst_handoff": {
                    "dataset_root": dataset_root.display().to_string()
                }
            }
        });

        assert_eq!(
            role_plan_dataset_override(Some(&role_plan)),
            Some(dataset_root)
        );
    }

    #[test]
    fn role_plan_dataset_override_reads_handoff_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dataset_root = dir.path().join("gse282742");
        let handoff_path = dir.path().join("handoff-validation-plan.json");
        std::fs::write(
            &handoff_path,
            serde_json::to_string(&json!({
                "analyst_handoff": {
                    "dataset_root": dataset_root.display().to_string()
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let role_plan = json!({
            "planner_metadata": {
                "analyst_handoff_path": handoff_path.display().to_string()
            }
        });

        assert_eq!(
            role_plan_dataset_override(Some(&role_plan)),
            Some(dataset_root)
        );
    }

    // cycle-b-20260919, 2026-09-19: with a valid landscape, one director
    // alone still chose a diagnostic on the most ready instrument. Once the expert
    // selection is engaged (labdirector::problem_selection) the projection
    // applies a lead only when it is the owner's pick from the slate, on top of
    // the landscape gate.
    #[test]
    fn once_the_expert_selection_is_engaged_the_lead_is_the_owners_pick_from_the_slate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        write_valid_test_landscape(&paths);
        let state = paths.runtime_root.join("state");
        let write = |name: &str, value: serde_json::Value| {
            std::fs::write(state.join(format!("cycle-test-{name}.json")), serde_json::to_string(&value).unwrap()).unwrap();
        };
        write("candidate-slate", json!({"candidates": [
            {"candidate_id": "cand_equal_budget", "landscape_open_problem_id": "op_sf0"},
            {"candidate_id": "cand_other", "landscape_open_problem_id": "op_sf1"}
        ]}));
        write("owner-candidates", json!({"candidates": [{"candidate_id": "cand_equal_budget"}, {"candidate_id": "cand_other"}]}));
        write("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z"}));
        let hypothesis_path = state.join("cycle-test-lab-director-hypothesis.json");
        let contract = test_contract("lab-director", PathBuf::from("task.md"));
        let selection = |slate_candidate_id: serde_json::Value| {
            cite_test_landscape(&json!({
                "status": "completed",
                "extracted_json": {
                    "requery_decision": "replace",
                    "selected_hypothesis": {"statement": "per-link force dispersion predicts held-lift failure", "slate_candidate_id": slate_candidate_id}
                }
            }))
        };
        let last_reasons = || -> Vec<String> {
            let rejections: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(crate::labdirector::lead_selection_rejections_path(&paths, "cycle-test")).unwrap(),
            )
            .unwrap();
            let last = rejections["rejections"].as_array().unwrap().last().unwrap().clone();
            last["reasons"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect()
        };

        // Before the owner has chosen, nothing is selected -- landscape or not.
        assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &selection(json!("cand_equal_budget"))).unwrap().is_none());
        assert!(!hypothesis_path.exists());
        assert!(last_reasons()[0].starts_with("expert_selection_pending"), "{:?}", last_reasons());

        write("expert-selection", json!({"engaged_at": "2026-09-19T12:00:00Z", "owner_selection": {"candidate_id": "cand_equal_budget", "released": false}}));
        // A lead chosen alone, from outside the slate, is refused.
        assert!(project_lab_director_payload_to_hypothesis(&paths, &contract, &selection(serde_json::Value::Null)).unwrap().is_none());
        assert!(!hypothesis_path.exists());
        assert!(last_reasons().iter().any(|r| r.starts_with("slate_candidate_id is missing")), "{:?}", last_reasons());
        // The owner's pick, citing the landscape, goes through.
        project_lab_director_payload_to_hypothesis(&paths, &contract, &selection(json!("cand_equal_budget"))).unwrap();
        let lead: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hypothesis_path).unwrap()).unwrap();
        assert_eq!(lead["statement"], json!("per-link force dispersion predicts held-lift failure"));
    }
