// A director who has ruled on a runner is not asked to rule on it again.
//
// MEASURED ON cycle-a-20260919, 2026-10-06 12:45: five director
// lanes opened at once. Three were `labdirector-runner-recovery-*` requests for
// runners 150, 151 and 152, every one of which a later director had already
// ruled on by name in its own result (runner-152: "validly falsified the
// protected action-support projection lead"). A fourth asked the director to
// plan recovery for 296 failed blocking lanes, analyst-04 from the first day
// among them, because the "already answered" rule compared whole sets and one
// more analyst had failed.

fn adjudication_lane(paths: &AppPaths, cycle: &str, lane_id: &str, role: &str, result: &Value, done_at_s: u64) {
    let dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&dir).unwrap();
    write_json(&dir.join("lane-contract.json"), &json!({"lane_id": lane_id, "role": role})).unwrap();
    write_json(&dir.join("role-plan.json"), &json!({"lane_id": lane_id, "role": role, "action_type": "lab_director_requery_followup"})).unwrap();
    write_json(&dir.join("result.json"), result).unwrap();
    let status = dir.join("final-status.json");
    write_json(&status, &json!({"lane_id": lane_id, "status": "completed"})).unwrap();
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(done_at_s);
    fs::File::options().write(true).open(&status).unwrap().set_modified(when).unwrap();
}

#[test]
fn a_handoff_bound_to_a_superseded_analysis_contract_gets_no_runner() {
    // cycle-a-20260919, 2026-10-16: runners 323-326 were created one
    // per pass for a handoff bound to contract f14409a6... while the lead's was
    // d09ea5a7...; each failed preflight within a minute.
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    let paths = AppPaths {
        project_root: project.clone(),
        runtime_root: project.join(".research-lab"),
        data_root: project.join(".research-lab").join("datasets"),
        stats_driver_script: PathBuf::from("/dev/null"),
        literature_driver_script: PathBuf::from("/dev/null"),
    };
    let cycle = "stale-contract";
    let handoff = |id: Option<&str>| match id {
        Some(id) => json!({"analysis_contract": {"contract_id": id}, "handoff_checks": []}),
        None => json!({"handoff_checks": []}),
    };
    // Without the contract script there is nothing to compare with: nothing is held back.
    assert!(handoff_contract_is_stale(&paths, cycle, &handoff(Some("analysis:old"))).is_none());

    let script = project.join("src").join("policy").join("analysis_contract.js");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(
        &script,
        "if (process.argv[4] === '--current') process.stdout.write(JSON.stringify({ contract_id: 'analysis:current' }));\n",
    )
    .unwrap();
    assert_eq!(current_analysis_contract_id(&paths, cycle).as_deref(), Some("analysis:current"));
    assert_eq!(
        handoff_contract_is_stale(&paths, cycle, &handoff(Some("analysis:old"))),
        Some(("analysis:old".to_string(), "analysis:current".to_string()))
    );
    assert!(handoff_contract_is_stale(&paths, cycle, &handoff(Some("analysis:current"))).is_none());
    // A handoff that names no contract (contracts not in use) is not held back.
    assert!(handoff_contract_is_stale(&paths, cycle, &handoff(None)).is_none());

    // Said once per handoff and contract, not once per pass.
    let stale = ("analysis:old".to_string(), "analysis:current".to_string());
    note_stale_handoff_contract(&paths, cycle, "/lanes/followup-analyst-842/handoff-validation-plan.json", &stale);
    note_stale_handoff_contract(&paths, cycle, "/lanes/followup-analyst-842/handoff-validation-plan.json", &stale);
    let notices = fs::read_to_string(crate::core::support::harness_notices_path(&paths, cycle)).unwrap();
    assert_eq!(notices.lines().filter(|line| line.contains("handoff_contract_stale")).count(), 1);
}

#[test]
fn supporting_audit_is_not_discarded_when_primary_claim_contract_changes() {
    // MEASURED ON cycle-a-20260919, 2026-10-18: analysts 966, 998,
    // and 1016 were recorded as handoff_contract_stale. The first two were
    // primary handoffs for changed specifications; 1016 was a supporting-only
    // audit that runner preflight can safely execute across the claim rewrite.
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    let paths = AppPaths {
        project_root: project.clone(),
        runtime_root: project.join(".research-lab"),
        data_root: project.join(".research-lab").join("datasets"),
        stats_driver_script: PathBuf::from("/dev/null"),
        literature_driver_script: PathBuf::from("/dev/null"),
    };
    let script = project.join("src").join("policy").join("analysis_contract.js");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(
        &script,
        "if (process.argv[4] === '--current') process.stdout.write(JSON.stringify({ contract_id: 'analysis:79cec208' }));\n",
    )
    .unwrap();
    let handoff = |contract: &str, evidence_role: &str| json!({
        "analysis_contract": {"contract_id": contract},
        "handoff_checks": [{
            "check_id": "measured-handoff",
            "column_mapping": [{"key": "analysis_evidence_role", "column": evidence_role}]
        }]
    });

    let measured = [
        handoff("analysis:77b4d5f6", "primary"),
        handoff("analysis:12daf336", "primary"),
        handoff("analysis:9e5d264d", "supporting"),
    ];
    let stale = measured
        .iter()
        .filter(|handoff| {
            handoff_contract_is_stale(&paths, "cycle-a-20260919", handoff)
                .is_some()
        })
        .count();
    assert_eq!(
        stale, 2,
        "the supporting audit must not create the third discarded-work record"
    );
    assert!(
        handoff_contract_is_stale(&paths, "cycle-a-20260919", &measured[2])
            .is_none()
    );
}

#[test]
fn a_contract_measured_once_is_not_run_again() {
    // cycle-a-20260919, 2026-10-18: 18 runners executed contract
    // 12daf336 and wrote the same four estimates each time.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "measured-contract";
    let contract = "analysis:12daf336";
    let runner = |lane: &str, status: &str| {
        let dir = lane_root(&paths, cycle, lane);
        fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join("lane-contract.json"), &json!({"lane_id": lane, "role": "lab-runner"})).unwrap();
        write_json(&dir.join("analysis-contract-preflight.json"), &json!({"contract_id": contract, "status": "ready", "evidence_role": "primary"})).unwrap();
        write_json(
            &dir.join("result.json"),
            &json!({"analysis_contract_validation": {"contract_id": contract, "status": status, "evidence_role": "primary", "problems": []}}),
        )
        .unwrap();
    };
    let handoff_path = lane_root(&paths, cycle, "followup-analyst-991").join("handoff-validation-plan.json");
    let handoff = |role: Option<&str>| {
        let mapping = role.map(|role| json!({"analysis_evidence_role": role})).unwrap_or(json!({}));
        json!({
            "analysis_contract": {"contract_id": contract},
            "handoff_checks": [{"check_id": "HC-CONTRACT-12DAF336", "column_mapping": mapping}],
            "validation_code_blueprints": [{"check_id": "HC-CONTRACT-12DAF336", "code": "print(1)"}]
        })
    };
    let actions_for = |payload: Value| {
        let mut actions = Vec::new();
        push_analyst_handoff_followup_action(
            &paths,
            cycle,
            &mut actions,
            "analyst-handoff",
            "analyst",
            handoff_path.to_string_lossy().to_string(),
            payload,
            120,
            "",
        )
        .unwrap();
        actions
    };
    fs::create_dir_all(state_root(&paths)).unwrap();
    runner("followup-runner-458", "verified");
    runner("followup-runner-446", "mismatch");
    assert_eq!(
        verified_primary_measurements(&paths, cycle, &handoff(None)["analysis_contract"]).unwrap(),
        vec!["followup-runner-458"]
    );
    assert!(actions_for(handoff(None)).is_empty());
    let notices = fs::read_to_string(crate::core::support::harness_notices_path(&paths, cycle)).unwrap();
    assert_eq!(notices.lines().filter(|line| line.contains("contract_already_measured")).count(), 1);
    assert!(notices.contains("followup-runner-458"));

    runner("followup-runner-459", "verified");
    assert!(actions_for(handoff(None)).is_empty());
    assert!(actions_for(handoff(None)).is_empty());
    let notices = fs::read_to_string(crate::core::support::harness_notices_path(&paths, cycle)).unwrap();
    assert_eq!(notices.lines().filter(|line| line.contains("contract_already_measured")).count(), 1);
    // A supporting audit asks something the measurement did not; it runs.
    assert!(handoff_is_supporting_only(&handoff(Some("supporting"))));
    assert_eq!(actions_for(handoff(Some("supporting"))).len(), 1);
    // ... in the [{"key", "column"}] pairs the analyst schema writes, too.
    let mut pairs = handoff(None);
    pairs["handoff_checks"][0]["column_mapping"] =
        json!([{"key": "analysis_evidence_role", "column": "supporting"}, {"key": "seed", "column": "seed"}]);
    assert!(handoff_is_supporting_only(&pairs));
    assert_eq!(actions_for(pairs).len(), 1);
    // A different contract is a different measurement.
    let mut other = handoff(None);
    other["analysis_contract"]["contract_id"] = json!("analysis:d03b2918");
    assert_eq!(actions_for(other).len(), 1);
}

#[test]
fn measured_robotics_handoffs_do_not_create_the_second_primary_runner() {
    // MEASURED ON cycle-a-20260919, 2026-10-26: runner 779 completed
    // the registered primary measurement, but analyst 1312's different script
    // still created runner 780 and wrote the same ten estimands on the same data.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-a-20260919";
    let contract = "analysis:d581ff638d51ea2fe0a64553865dc5b7e7e77beed234ffad1ea8b9d81531c7bf";
    let measured_dir = lane_root(&paths, cycle, "followup-runner-779");
    fs::create_dir_all(&measured_dir).unwrap();
    write_json(
        &measured_dir.join("lane-contract.json"),
        &json!({"lane_id": "followup-runner-779", "role": "lab-runner"}),
    )
    .unwrap();
    write_json(
        &measured_dir.join("analysis-contract-preflight.json"),
        &json!({"contract_id": contract, "status": "ready", "evidence_role": "primary"}),
    )
    .unwrap();
    write_json(
        &measured_dir.join("result.json"),
        &json!({"analysis_contract_validation": {
            "contract_id": contract,
            "status": "verified",
            "evidence_role": "primary"
        }}),
    )
    .unwrap();

    let handoff_path = lane_root(&paths, cycle, "followup-analyst-1312")
        .join("handoff-validation-plan.json");
    let handoff = json!({
        "analysis_contract": {"contract_id": contract},
        "handoff_checks": [{
            "check_id": "directional_support_v2_contract_validation",
            "column_mapping": [{"key": "analysis_evidence_role", "column": "primary"}]
        }],
        "validation_code_blueprints": [{
            "check_id": "directional_support_v2_contract_validation",
            "code": "# second script computing the same registered estimands"
        }]
    });
    let mut actions = Vec::new();
    push_analyst_handoff_followup_action(
        &paths,
        cycle,
        &mut actions,
        "analyst-handoff",
        "analyst",
        handoff_path.to_string_lossy().to_string(),
        handoff,
        120,
        "",
    )
    .unwrap();

    assert!(actions.is_empty(), "runner 780 would repeat runner 779");
    let notices = fs::read_to_string(crate::core::support::harness_notices_path(&paths, cycle)).unwrap();
    assert!(notices.contains("contract_already_measured"));
    assert!(notices.contains("followup-runner-779"));
    assert!(notices.contains("no lab-runner is created"));
}

#[test]
fn measured_pair_form_supporting_audits_still_get_runners() {
    // MEASURED ON cycle-a-20260919, 2026-10-18: supporting contact
    // audits from analysts 1011, 1012, and 1014 were recorded as
    // contract_already_measured even though every handoff used the schema's
    // [{key, column}] form to declare analysis_evidence_role=supporting.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "measured-supporting-audits";
    let contract = "analysis:9e5d264d7e1a70da8201af6dbec5f574ec93c2cf13398a118a7d75d32e14026a";
    fs::create_dir_all(state_root(&paths)).unwrap();
    for lane in ["followup-runner-486", "followup-runner-487"] {
        let dir = lane_root(&paths, cycle, lane);
        fs::create_dir_all(&dir).unwrap();
        write_json(
            &dir.join("lane-contract.json"),
            &json!({"lane_id": lane, "role": "lab-runner"}),
        )
        .unwrap();
        write_json(
            &dir.join("analysis-contract-preflight.json"),
            &json!({"contract_id": contract}),
        )
        .unwrap();
        write_json(
            &dir.join("result.json"),
            &json!({"analysis_contract_validation": {
                "contract_id": contract,
                "status": "verified",
                "evidence_role": "primary"
            }}),
        )
        .unwrap();
    }

    for (analyst, check_id) in [
        ("followup-analyst-1011", "CHECK-CONTACT-MODE-SUPPORTING-AUDIT-01"),
        ("followup-analyst-1012", "CHECK-CONTACT-MODE-SUPPORTING-AUDIT-01"),
        ("followup-analyst-1014", "CHECK-CONTACT-MODE-SUPPORTING-AUDIT-V1"),
    ] {
        let handoff_path = lane_root(&paths, cycle, analyst).join("handoff-validation-plan.json");
        let handoff = json!({
            "analysis_contract": {"contract_id": contract},
            "handoff_checks": [{
                "check_id": check_id,
                "column_mapping": [
                    {"column": "supporting", "key": "analysis_evidence_role"},
                    {"column": "seed", "key": "seed"}
                ]
            }],
            "validation_code_blueprints": [{"check_id": check_id, "code": "print(1)"}]
        });
        let mut actions = Vec::new();
        push_analyst_handoff_followup_action(
            &paths,
            cycle,
            &mut actions,
            "analyst-handoff",
            "analyst",
            handoff_path.to_string_lossy().to_string(),
            handoff,
            120,
            "",
        )
        .unwrap();
        assert_eq!(actions.len(), 1, "{analyst}'s supporting audit was discarded");
    }

    let notices = fs::read_to_string(crate::core::support::harness_notices_path(&paths, cycle))
        .unwrap_or_default();
    assert!(!notices.contains("contract_already_measured"));
}

#[test]
fn a_reprojected_lead_does_not_repeat_the_same_registered_measurement() {
    // MEASURED ON cycle-a-20260919, 2026-10-18: runners 486/487
    // measured the seven registered contrasts; after the lead restated their
    // results under a new contract id, handoffs 1017/1018 created runners
    // 493/494 for the identical sealed data, estimands, and thresholds.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "reprojected-measurement";
    let spec = json!({
        "analysis_evidence_role": "primary",
        "base_contract_id": "analysis:new-base",
        "canonical_statement": "The measured result.",
        "canonical_estimands": ["policy minus retrieval"],
        "comparator": "difference_aware_retrieval",
        "required_contrast_ids": ["recovery_fraction", "policy_discordance"],
        "dataset_sha256": "7a8366570a7b31ed7d5bce0afc6e3c884431ae37cb4d86bbbdd7f414d7573b29",
        "decision_margin": 0.20
    });
    let current_contract = json!({
        "contract_id": "analysis:72e2799d",
        "statement": "The measured result.",
        "operational_spec": spec
    });
    let mut old_contract = current_contract.clone();
    old_contract["contract_id"] = json!("analysis:9e5d264d");
    old_contract["statement"] = json!("The prospective claim.");
    old_contract["operational_spec"]["base_contract_id"] = json!("analysis:old-base");
    old_contract["operational_spec"]["canonical_statement"] = json!("The prospective claim.");
    old_contract["operational_spec"]["canonical_estimands"] =
        json!(["each policy minus retrieval"]);

    for lane in ["followup-runner-486", "followup-runner-487"] {
        let dir = lane_root(&paths, cycle, lane);
        fs::create_dir_all(&dir).unwrap();
        write_json(
            &dir.join("lane-contract.json"),
            &json!({"lane_id": lane, "role": "lab-runner"}),
        )
        .unwrap();
        write_json(
            &dir.join("role-plan.json"),
            &json!({"role": "lab-runner", "planner_metadata": {"analysis_request": {"analyst_handoff": {"analysis_contract": old_contract}}}}),
        )
        .unwrap();
        write_json(
            &dir.join("analysis-contract-preflight.json"),
            &json!({"contract_id": "analysis:9e5d264d", "status": "ready", "evidence_role": "primary"}),
        )
        .unwrap();
        write_json(
            &dir.join("result.json"),
            &json!({"analysis_contract_validation": {"contract_id": "analysis:9e5d264d", "status": "verified", "evidence_role": "primary"}}),
        )
        .unwrap();
    }
    let handoff_path = lane_root(&paths, cycle, "followup-analyst-1017")
        .join("handoff-validation-plan.json");
    let handoff = json!({
        "analysis_contract": current_contract,
        "handoff_checks": [{"check_id": "CHECK-CORRECTED-RETRIEVAL", "column_mapping": {"analysis_evidence_role": "primary"}}],
        "validation_code_blueprints": [{"check_id": "CHECK-CORRECTED-RETRIEVAL", "code": "print(1)"}]
    });
    assert_eq!(
        verified_primary_measurements(&paths, cycle, &handoff["analysis_contract"]).unwrap(),
        vec!["followup-runner-486", "followup-runner-487"]
    );
    let mut actions = Vec::new();
    push_analyst_handoff_followup_action(
        &paths,
        cycle,
        &mut actions,
        "analyst-handoff",
        "analyst",
        handoff_path.to_string_lossy().to_string(),
        handoff,
        120,
        "",
    )
    .unwrap();
    assert!(actions.is_empty(), "runner 493 would repeat runners 486/487");
}

#[test]
fn a_spent_followup_budget_is_said_once_per_budget() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "budget-spent";
    let notices = crate::core::support::harness_notices_path(&paths, cycle);
    let spent = || {
        fs::read_to_string(&notices)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("followup_budget_spent"))
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>()
    };
    notice_followup_budget_spent(&paths, cycle, 4158, 4096);
    notice_followup_budget_spent(&paths, cycle, 4158, 4096);
    notice_followup_budget_spent(&paths, cycle, 4160, 4096);
    assert_eq!(spent().len(), 1, "every idle pass would otherwise repeat it");
    assert_eq!(spent()[0]["payload"]["budget"], json!(4096));
    assert_eq!(spent()[0]["payload"]["followups"], json!(4158));
    // Raised and spent again: that is new, and said again.
    notice_followup_budget_spent(&paths, cycle, 8192, 8192);
    assert_eq!(spent().len(), 2);
    // A budget that merely contains the old number is not the old budget.
    notice_followup_budget_spent(&paths, cycle, 40961, 40960);
    assert_eq!(spent().len(), 3);
}

#[test]
fn a_lane_is_named_only_as_a_whole_token() {
    assert!(text_names_lane("Runner-152 validly falsified the lead", "followup-runner-152"));
    assert!(text_names_lane("see followup-runner-152's handoff", "followup-runner-152"));
    assert!(text_names_lane("(runner-152)", "followup-runner-152"));
    assert!(!text_names_lane("runner-1520 passed", "followup-runner-152"));
    assert!(!text_names_lane("runner-15 passed", "followup-runner-152"));
    assert!(!text_names_lane("lab-runner-152 passed", "followup-runner-152"));
    assert!(!text_names_lane("xrunner-152", "followup-runner-152"));
    assert!(text_names_lane("lab-runner-01 completed", "lab-runner-01"));
    assert!(!text_names_lane("followup-lab-runner-01", "lab-runner-01"));
}

#[test]
fn a_runner_a_later_director_named_is_already_adjudicated() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "adjudicated";
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    adjudication_lane(&paths, cycle, "followup-runner-152", "lab-runner", &json!({"overall_status": "degraded"}), 2_000_000_000);
    assert!(!runner_adjudicated_by_director(&paths, cycle, "followup-runner-152").unwrap());

    // A director that finished BEFORE the runner cannot have ruled on it, even by name.
    adjudication_lane(
        &paths,
        cycle,
        "followup-lab-director-461",
        "lab-director",
        &json!({"extracted_json": {"rationale": "runner-152 is queued"}}),
        1_999_999_000,
    );
    assert!(!runner_adjudicated_by_director(&paths, cycle, "followup-runner-152").unwrap());

    // A later director that does not name it has not ruled on it.
    adjudication_lane(
        &paths,
        cycle,
        "followup-lab-director-462",
        "lab-director",
        &json!({"extracted_json": {"rationale": "Runner-149 validly falsified the impulse rescue."}}),
        2_000_001_000,
    );
    assert!(!runner_adjudicated_by_director(&paths, cycle, "followup-runner-152").unwrap());

    // A later analyst naming it is not a director's ruling.
    adjudication_lane(
        &paths,
        cycle,
        "followup-analyst-420",
        "analyst",
        &json!({"summary": "Runner-152 failed three checks"}),
        2_000_002_000,
    );
    assert!(!runner_adjudicated_by_director(&paths, cycle, "followup-runner-152").unwrap());

    // The real one: director 462's words about runner-152.
    adjudication_lane(
        &paths,
        cycle,
        "followup-lab-director-463",
        "lab-director",
        &json!({"extracted_json": {"rationale": "Decision-supervening Runner-152 subsequently executed and validly falsified the protected action-support projection lead."}}),
        2_000_003_000,
    );
    assert!(runner_adjudicated_by_director(&paths, cycle, "followup-runner-152").unwrap());
}

#[test]
fn only_blocking_failures_no_plan_has_covered_are_asked_about() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "blocking-remainder";
    let old: Vec<String> = (0..5).map(|index| format!("followup-analyst-0{index}")).collect();
    let alerts: Vec<(&str, &str)> = old.iter().map(|lane| (lane.as_str(), "analyst")).collect();
    write_cycle_state_with_alerts(&paths, cycle, &alerts);
    let reasons: Vec<String> = old
        .iter()
        .map(|lane| format!("{lane} (analyst) stopped on unrecorded; it is a blocking lane."))
        .collect();
    write_answered_recovery_lane(
        &paths,
        cycle,
        "followup-lab-director-40",
        &reasons.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert!(actions.is_empty(), "five answered failures were asked about again");

    // One more analyst fails: the question is that one lane, not all six.
    let mut with_new = alerts.clone();
    with_new.push(("followup-analyst-417", "analyst"));
    write_cycle_state_with_alerts(&paths, cycle, &with_new);
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["failed_lane_ids"], json!(["followup-analyst-417"]));
    let description = actions[0]["description"].as_str().unwrap();
    assert!(description.starts_with("1 blocking lane(s) failed"), "{description}");
    assert!(description.contains("5 earlier blocking failure(s) were already answered"), "{description}");
    assert_eq!(actions[0]["blocker_reasons"].as_array().unwrap().len(), 1);

    // A lane named inside another lane's report is not thereby answered.
    let mut answered_elsewhere = with_new.clone();
    answered_elsewhere.push(("followup-scout-09", "scout"));
    write_cycle_state_with_alerts(&paths, cycle, &answered_elsewhere);
    write_answered_recovery_lane(
        &paths,
        cycle,
        "followup-lab-director-41",
        &["followup-analyst-417 (analyst) stopped on unrecorded. It reported: waiting on followup-scout-09."],
    );
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["failed_lane_ids"], json!(["followup-scout-09"]));
}

#[test]
fn a_queued_request_for_a_runner_since_ruled_on_is_retired_before_it_runs() {
    // Directors 470 and 475: created when runners 154 and 157 finished, ruled
    // on by other directors while they waited for a slot.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "queued-adjudication";
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    adjudication_lane(&paths, cycle, "followup-runner-157", "lab-runner", &json!({"overall_status": "degraded"}), 2_000_000_000);
    let queued = lane_root(&paths, cycle, "followup-lab-director-475");
    fs::create_dir_all(&queued).unwrap();
    let contract = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "followup-lab-director-475".to_string(),
        role: "lab-director".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: queued.join("task.md"),
        allowed_inputs: vec![],
        allowed_outputs: vec![],
        output_artifact: None,
        fallback_strategy: None,
    };
    write_json(&queued.join("lane-contract.json"), &serde_json::to_value(&contract).unwrap()).unwrap();
    write_json(
        &queued.join("role-plan.json"),
        &json!({
            "lane_id": "followup-lab-director-475",
            "role": "lab-director",
            "action_type": "lab_director_requery_followup",
            "source_brief_id": "labdirector-runner-recovery-followup-runner-157",
        }),
    )
    .unwrap();

    // Not yet ruled on: it stays queued.
    assert!(supervisor_supersede_adjudicated_runner_recovery(&paths, cycle, &contract, &queued).unwrap().is_none());
    assert!(!queued.join("final-status.json").exists());

    adjudication_lane(
        &paths,
        cycle,
        "followup-lab-director-474",
        "lab-director",
        &json!({"extracted_json": {"rationale": "Runner-157's degraded label is a wrapper mismatch; v2 replaces v1."}}),
        2_000_001_000,
    );
    let action = supervisor_supersede_adjudicated_runner_recovery(&paths, cycle, &contract, &queued)
        .unwrap()
        .expect("a request whose question was answered still runs");
    assert_eq!(action["runner_lane_id"], json!("followup-runner-157"));
    let status = read_json(&queued.join("final-status.json")).unwrap();
    assert_eq!(status["status"], json!("aborted"));
    assert_eq!(status["failure_category"], json!("supervisor_superseded_adjudicated_runner_recovery"));

    // A request that has started is never touched.
    let started = lane_root(&paths, cycle, "followup-lab-director-476");
    fs::create_dir_all(&started).unwrap();
    write_json(&started.join("role-plan.json"), &json!({"role": "lab-director", "action_type": "lab_director_requery_followup", "source_brief_id": "labdirector-runner-recovery-followup-runner-157"})).unwrap();
    write_json(&started.join("run-state.json"), &json!({"status": "running"})).unwrap();
    let mut running = contract.clone();
    running.lane_id = "followup-lab-director-476".to_string();
    assert!(supervisor_supersede_adjudicated_runner_recovery(&paths, cycle, &running, &started).unwrap().is_none());
}
