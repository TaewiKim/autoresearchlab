// The field landscape comes before the lead (labdirector::field_landscape).
//
// MEASURED ON cycle-b-20260918, 2026-09-18/19: no field-wide survey was ever
// run, the first scout query was already the most ready instrument's topic, and
// 290 admitted papers held none of the field's SOTA. The lead ended as a narrow
// evaluation question about that one instrument.

fn landscape_thresholds() -> FieldLandscapeThresholds {
    FieldLandscapeThresholds::default()
}

fn fixture_verified(landscape: &Value) -> serde_json::Map<String, Value> {
    landscape["verified_papers"].as_object().cloned().unwrap()
}

#[test]
fn a_complete_landscape_validates() {
    let landscape = valid_field_landscape_fixture("c");
    let validation = validate_field_landscape(&landscape, &fixture_verified(&landscape), &landscape_thresholds());
    assert!(validation.valid, "{:?}", validation.reasons);
    assert_eq!(
        validation.open_problem_ids.iter().cloned().collect::<Vec<_>>(),
        vec!["op_sf0", "op_sf1", "op_sf2"]
    );
    assert_eq!(validation.frontier_paper_keys.len(), 15);
    assert_eq!(validation.landscape_paper_keys.len(), 24);
}

#[test]
fn a_landscape_collapsed_onto_one_subfield_is_invalid() {
    // The measured failure: one subfield, chosen by the instrument.
    let mut landscape = valid_field_landscape_fixture("c");
    landscape["subfields"].as_array_mut().unwrap().truncate(1);
    let validation = validate_field_landscape(&landscape, &fixture_verified(&landscape), &landscape_thresholds());
    assert!(!validation.valid);
    assert!(
        validation.reasons.iter().any(|reason| reason.starts_with("1 subfield(s) mapped, at least 3 required")),
        "{:?}",
        validation.reasons
    );
}

#[test]
fn frontier_is_judged_by_the_admitted_record_not_by_the_landscape() {
    let landscape = valid_field_landscape_fixture("c");
    let mut verified = fixture_verified(&landscape);
    // The landscape says 2025; the admitted record says 2021.
    verified.insert("arxiv:sf0-f0".to_string(), json!({"paper_id": "arxiv:sf0-f0", "year": 2021}));
    let validation = validate_field_landscape(&landscape, &verified, &landscape_thresholds());
    assert!(!validation.valid);
    assert!(
        validation.reasons.iter().any(|reason| reason.contains("subfield sf0: 4 verified frontier work(s) dated 2024+, at least 5 required")),
        "{:?}",
        validation.reasons
    );
    assert!(validation.warnings.iter().any(|warning| warning.contains("admitted year 2021")));
}

#[test]
fn a_paper_the_gate_did_not_admit_counts_for_nothing() {
    let landscape = valid_field_landscape_fixture("c");
    let mut verified = fixture_verified(&landscape);
    verified.remove("doi:10.1/sf1-c2");
    let validation = validate_field_landscape(&landscape, &verified, &landscape_thresholds());
    assert!(!validation.valid);
    assert!(validation
        .reasons
        .iter()
        .any(|reason| reason == "subfield sf1: 2 verified canonical work(s), at least 3 required"));
    assert!(validation.warnings.iter().any(|warning| warning.contains("'doi:10.1/sf1-c2' is not an admitted")));
}

#[test]
fn an_open_problem_must_be_attributed_and_annotated_with_instrument_fit() {
    let mut landscape = valid_field_landscape_fixture("c");
    let verified = fixture_verified(&landscape);
    landscape["subfields"][0]["open_problems"][0]["paper_ids"] = json!(["doi:10.9/never-admitted"]);
    landscape["subfields"][1]["open_problems"][0]["instrument_fit"] = json!({"how": "no verdict"});
    let validation = validate_field_landscape(&landscape, &verified, &landscape_thresholds());
    assert!(!validation.valid);
    for subfield in ["sf0", "sf1"] {
        assert!(
            validation.reasons.iter().any(|reason| reason.starts_with(&format!("subfield {subfield}: no open problem"))),
            "{subfield}: {:?}",
            validation.reasons
        );
    }
    assert!(!validation.open_problem_ids.contains("op_sf0"));
    assert!(validation.open_problem_ids.contains("op_sf2"));
}

#[test]
fn a_landscape_without_subfields_is_invalid() {
    let validation = validate_field_landscape(&json!({"notes": "x"}), &serde_json::Map::new(), &landscape_thresholds());
    assert!(!validation.valid);
    assert_eq!(validation.reasons, vec!["subfields[] is missing".to_string()]);
}

#[test]
fn only_papers_the_screening_gate_accepted_are_admitted() {
    let registry = admitted_paper_registry(&[
        json!({"title": "kept", "publication_date": "2025-03-01",
               "literature_screening": {"status": "accepted", "review": {"paper_id": "DOI:10.1/Kept"}}}),
        json!({"title": "excluded", "year": 2025,
               "literature_screening": {"status": "excluded", "review": {"paper_id": "doi:10.1/x"}}}),
        json!({"title": "unread", "year": 2025,
               "literature_screening": {"status": "accepted", "review": {"paper_id": "doi:10.1/u", "abstract_read_in_full": false}}}),
        json!({"title": "never screened", "paper_id": "doi:10.1/n", "year": 2025}),
    ]);
    assert_eq!(registry.keys().cloned().collect::<Vec<_>>(), vec!["doi:10.1/kept"]);
    assert_eq!(registry["doi:10.1/kept"]["year"], json!(2025));
    assert_eq!(registry["doi:10.1/kept"]["paper_id"], json!("DOI:10.1/Kept"));
}

fn landscape_scout_contract(paths: &AppPaths, cycle: &str, lane_id: &str) -> LaneContract {
    let lane_dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: "scout".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_dir.join("task.md"),
        allowed_inputs: vec![],
        allowed_outputs: vec![lane_dir.clone()],
        output_artifact: Some(lane_dir.join("result.json")),
        fallback_strategy: None,
    }
}

fn admitted_papers_for(landscape: &Value) -> Value {
    Value::Array(
        landscape["verified_papers"]
            .as_object()
            .unwrap()
            .values()
            .map(|paper| {
                json!({
                    "title": paper["title"], "year": paper["year"],
                    "literature_screening": {"status": "accepted", "review": {"paper_id": paper["paper_id"], "abstract_read_in_full": true}},
                })
            })
            .collect(),
    )
}

#[test]
fn a_landscape_scout_result_is_validated_against_its_admitted_papers_and_published() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-publish";
    let contract = landscape_scout_contract(&paths, cycle, "followup-scout-01");
    let lane_dir = lane_root(&paths, cycle, "followup-scout-01");
    let mut landscape = valid_field_landscape_fixture(cycle);
    let papers = admitted_papers_for(&landscape);
    // The scout does not get to say which papers are verified.
    landscape.as_object_mut().unwrap().remove("verified_papers");
    write_json(&lane_dir.join("papers.json"), &papers).unwrap();
    write_json(&lane_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE), &landscape).unwrap();
    let role_plan = json!({"action_type": FIELD_LANDSCAPE_SCOUT_ACTION});

    assert_eq!(field_landscape_status(&paths, cycle).state, "missing");
    let published = project_field_landscape(&paths, &contract, Some(&role_plan)).unwrap();
    assert_eq!(published, Some(field_landscape_state_path(&paths, cycle)));
    let status = field_landscape_status(&paths, cycle);
    assert_eq!(status.state, "valid", "{:?}", status.validation.reasons);
    assert_eq!(status.landscape["generated_by"], json!("followup-scout-01"));
    assert_eq!(status.landscape["validation"]["valid"], json!(true));

    // A later, broken attempt never replaces a valid landscape, and is recorded.
    let second = landscape_scout_contract(&paths, cycle, "followup-scout-02");
    let second_dir = lane_root(&paths, cycle, "followup-scout-02");
    write_json(&second_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE), &json!({"subfields": []})).unwrap();
    assert_eq!(project_field_landscape(&paths, &second, Some(&role_plan)).unwrap(), None);
    assert_eq!(field_landscape_status(&paths, cycle).state, "valid");
    let attempts = read_json(&state_root(&paths).join(format!("{cycle}-field-landscape-attempts.json"))).unwrap();
    assert_eq!(attempts["attempts"][1]["valid"], json!(false));

    // An ordinary literature scout is not a landscape scout.
    let other = json!({"action_type": "reasoning_literature_scout"});
    assert_eq!(project_field_landscape(&paths, &contract, Some(&other)).unwrap(), None);
}

#[test]
fn a_landscape_whose_papers_were_not_admitted_is_published_invalid_with_reasons() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-unadmitted";
    let contract = landscape_scout_contract(&paths, cycle, "followup-scout-01");
    let lane_dir = lane_root(&paths, cycle, "followup-scout-01");
    write_json(&lane_dir.join("papers.json"), &json!([])).unwrap();
    write_json(&lane_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE), &valid_field_landscape_fixture(cycle)).unwrap();
    project_field_landscape(&paths, &contract, Some(&json!({"action_type": FIELD_LANDSCAPE_SCOUT_ACTION}))).unwrap();
    let status = field_landscape_status(&paths, cycle);
    assert_eq!(status.state, "invalid");
    assert!(status.validation.reasons.iter().any(|reason| reason.contains("0 verified canonical work(s)")));
    // A lead is refused against it, with the landscape's own reasons attached.
    let reasons = lead_landscape_rejection_reasons(&json!({"statement": "x"}), &status, &landscape_thresholds());
    assert!(reasons[0].starts_with("field_landscape_invalid"), "{reasons:?}");
    assert!(reasons.len() > 1);
}

fn landscape_dispatch_cycle(paths: &AppPaths, cycle: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(paths)).unwrap();
    write_json(
        &plans_root(paths).join(format!("{cycle}-cycle-plan.json")),
        &json!({"objective": "Pick ONE falsifiable question across manipulation, legged locomotion, sim-to-real, contact safety and language-conditioned policies."}),
    )
    .unwrap();
}

#[test]
fn the_landscape_scout_is_dispatched_when_the_landscape_is_missing_and_routed_as_reasoning() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-dispatch";
    landscape_dispatch_cycle(&paths, cycle);

    let created = dispatch_field_landscape_scout(&paths, cycle).unwrap();
    assert_eq!(created.len(), 1, "no landscape scout at cycle start");
    let lane_id = created[0]["lane_id"].as_str().unwrap().to_string();
    assert!(lane_id.starts_with("followup-scout-"));
    let role_plan = read_json(&lane_role_plan_path(&paths, cycle, &lane_id)).unwrap();
    assert_eq!(role_plan["action_type"], json!(FIELD_LANDSCAPE_SCOUT_ACTION));
    // Mapping a field is reasoning work: Sol at high effort, never the Luna floor.
    assert_eq!(role_plan["model_route"]["model"], json!(crate::labdirector::policy::CODEX_DEFAULT_AGENT_MODEL));
    assert_eq!(role_plan["model_route"]["reasoning_effort"], json!("high"));
    assert_ne!(role_plan["assigned_model"], json!(crate::labdirector::policy::CODEX_LUNA_MODEL));
    let contract_value = read_json(&lane_root(&paths, cycle, &lane_id).join("lane-contract.json")).unwrap();
    assert_eq!(contract_value["runtime_class"], json!("codex-agent"));
    let landscape_contract = &role_plan["planner_metadata"]["field_landscape_contract"];
    assert_eq!(landscape_contract["thresholds"]["frontier_per_subfield"], json!(5));
    assert!(landscape_contract["output_path"].as_str().unwrap().ends_with(FIELD_LANDSCAPE_OUTPUT_FILE));

    // One at a time: an open landscape scout is not duplicated.
    assert!(dispatch_field_landscape_scout(&paths, cycle).unwrap().is_empty());

    // And the opening director waits for it rather than choosing without it.
    let director = LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "lab-director-01".to_string(),
        role: "lab-director".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_root(&paths, cycle, "lab-director-01").join("task.md"),
        allowed_inputs: vec![],
        allowed_outputs: vec![],
        output_artifact: None,
        fallback_strategy: None,
    };
    let reason = director_field_landscape_wait_reason(&paths, cycle).expect("no hold on the director");
    assert!(reason.starts_with("waiting-for-field-landscape status=missing"), "{reason}");
    assert_eq!(blocker_descriptor(&reason).0, Some("scout"));
    let mut snapshot = dependency_snapshot(&paths, cycle).unwrap();
    snapshot.completed_scouts = 1;
    snapshot.counts.insert("chronicle".to_string(), 1);
    let blocker = dependency_blocker_for_lane_with_snapshot(&paths, cycle, &director, &snapshot).unwrap();
    assert!(
        blocker.as_deref().is_some_and(|reason| reason.starts_with("waiting-for-field-landscape")),
        "{blocker:?}"
    );

    // Once a valid landscape is published nothing more is dispatched or held.
    write_json(&field_landscape_state_path(&paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
    assert!(director_field_landscape_wait_reason(&paths, cycle).is_none());
    assert!(dispatch_field_landscape_scout(&paths, cycle).unwrap().is_empty());
}

#[test]
fn failed_landscape_attempts_stop_at_the_cap_until_a_director_is_refused_again() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-cap";
    landscape_dispatch_cycle(&paths, cycle);
    let role_plan = json!({"action_type": FIELD_LANDSCAPE_SCOUT_ACTION});
    let finish_invalid = |lane_id: &str| {
        // The scout wrote no landscape: recorded as an invalid attempt.
        let contract = landscape_scout_contract(&paths, cycle, lane_id);
        project_field_landscape(&paths, &contract, Some(&role_plan)).unwrap();
        write_json(&lane_root(&paths, cycle, lane_id).join("final-status.json"), &json!({"status": "failed"})).unwrap();
    };
    for attempt in 1..=3 {
        let created = dispatch_field_landscape_scout(&paths, cycle).unwrap();
        assert_eq!(created.len(), 1, "attempt {attempt} was not dispatched");
        finish_invalid(created[0]["lane_id"].as_str().unwrap());
    }
    assert!(
        dispatch_field_landscape_scout(&paths, cycle).unwrap().is_empty(),
        "a scout failing the same way is retried without bound"
    );
    assert!(director_field_landscape_wait_reason(&paths, cycle).is_none(), "the director is held with no scout open");
    // A director tries to select and is refused: the gate cannot be left with
    // nothing that can open it.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    record_lead_selection_rejection(&paths, cycle, "followup-lab-director-01", "a lead", &json!("replace"), &["x".to_string()]).unwrap();
    assert_eq!(dispatch_field_landscape_scout(&paths, cycle).unwrap().len(), 1);
}

#[test]
fn the_landscape_scout_prompt_verifies_by_title_and_keeps_instruments_out_of_scope() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-prompt";
    landscape_dispatch_cycle(&paths, cycle);
    let created = dispatch_field_landscape_scout(&paths, cycle).unwrap();
    let lane_id = created[0]["lane_id"].as_str().unwrap();
    let contract: LaneContract =
        serde_json::from_value(read_json(&lane_root(&paths, cycle, lane_id).join("lane-contract.json")).unwrap()).unwrap();
    let role_plan = read_json(&lane_role_plan_path(&paths, cycle, lane_id)).unwrap();
    let prompt = crate::runtime::codex_prompt::build_codex_prompt(&contract, Some(&role_plan)).unwrap();
    assert!(prompt.contains("FIELD LANDSCAPE SCOUT"));
    assert!(prompt.contains("\"--title\""), "the landscape is not verified by title lookup");
    assert!(prompt.contains("\"--arxiv-id\""));
    assert!(prompt.contains(FIELD_LANDSCAPE_OUTPUT_FILE));
    assert!(prompt.contains("does NOT decide a subfield, a query or a problem"));
    // An ordinary scout is not handed the landscape clause.
    let ordinary = json!({"action_type": "reasoning_literature_scout"});
    let plain = crate::runtime::codex_prompt::build_codex_prompt(&contract, Some(&ordinary)).unwrap();
    assert!(!plain.contains("FIELD LANDSCAPE SCOUT"));
}

#[test]
fn the_director_is_told_the_landscape_gate_and_that_instruments_never_choose_the_problem() {
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Field-landscape gate (ENFORCED by the harness"));
    assert!(contract.contains("INSTRUMENTS DECIDE FEASIBILITY, NEVER THE PROBLEM"));
    assert!(contract.contains("\\\"landscape_open_problem_id\\\"") || contract.contains("\"landscape_open_problem_id\""));
    assert!(contract.contains("never tell scouts to stop, narrow or defer broad acquisition"));
    assert!(crate::labdirector::policy::lab_director_hypothesis_gate_efficiency_directive()
        .contains("never applies to the field landscape"));

    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-director-context";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let missing = field_landscape_director_context(&paths, cycle);
    assert_eq!(missing["status"], json!("missing"));
    assert!(missing["broad_acquisition_override"].as_str().unwrap().contains("do not restart broad acquisition"));
    write_json(&field_landscape_state_path(&paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
    let valid = field_landscape_director_context(&paths, cycle);
    assert_eq!(valid["status"], json!("valid"));
    assert!(valid["broad_acquisition_override"].is_null());
    assert_eq!(valid["open_problems"].as_array().unwrap().len(), 3);
    assert_eq!(valid["papers"].as_array().unwrap().len(), 24);
    assert!(valid["papers"].as_array().unwrap().iter().any(|paper| paper["frontier"] == json!(true)));
    assert!(valid["selection_rule"].as_str().unwrap().contains("An instrument never chooses the problem"));
}

#[test]
fn a_director_lane_is_refreshed_with_the_landscape_and_broad_acquisition_is_not_suppressed() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "landscape-refresh";
    landscape_dispatch_cycle(&paths, cycle);
    let lane_id = "followup-lab-director-01";
    let contract_path = create_lane_contract(&paths, cycle, lane_id, "lab-director", "codex-agent", "read-write-scoped", "# task").unwrap();
    let contract: LaneContract = serde_json::from_value(read_json(&contract_path).unwrap()).unwrap();
    write_json(
        &lane_role_plan_path(&paths, cycle, lane_id),
        &json!({
            "lane_id": lane_id, "role": "lab-director", "action_type": "lab_director_requery_followup",
            "planner_metadata": {"hypothesis_gate_efficiency_mandate": {"avoid": [
                "broad repeated scout searches after failed-attempt evidence already closes external validation",
                "runner reruns unless the latest blocker requires new execution evidence"
            ]}}
        }),
    )
    .unwrap();
    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();
    let plan = read_json(&lane_role_plan_path(&paths, cycle, lane_id)).unwrap();
    let metadata = &plan["planner_metadata"];
    assert_eq!(metadata["field_landscape"]["status"], json!("missing"));
    let avoid = metadata["hypothesis_gate_efficiency_mandate"]["avoid"].as_array().unwrap();
    assert_eq!(avoid.len(), 1, "{avoid:?}");
    assert!(metadata["hypothesis_gate_efficiency_mandate"]["suspended_until_field_landscape_is_valid"].is_string());
}
