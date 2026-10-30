// The materialization gate must not name a role.
//
// cycle-g-v87 cleared its probe and scheme blockers, produced its first gate
// round, and was rejected for having no evidence: "The sole runner record is
// not_applicable and cannot substantiate any result." 18 analyst lanes pending
// and 0 completed; 13 runner lanes pending.
//
// The cycle-g-v79 exemption released only `contract.role == "lab-runner"`, while
// the gate holds analyst, lab-runner and gatekeeper. The analyst stayed held,
// the released runner was then held on `analyst_completed=0`, and nothing ever
// executed to make the gate pass.

fn write_generated_data_lead(paths: &AppPaths, cycle: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "Upper-tail residual concentration predicts the equal-wall-time crossover boundary.",
            "primary_family": "counterfactual_change_point_modeling",
            // v87's director wrote exactly this, one colon and no slashes.
            "dataset_or_accession": "procedural:Mitsuba-3.8.0-counterfactual-edit-scenes",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
}

fn write_fetchable_lead(paths: &AppPaths, cycle: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "RPPA pathway activity improves TCGA-BRCA survival stratification.",
            "primary_family": "pathway_activity_survival",
            "dataset_or_accession": "TCGA-BRCA",
            "validation_data_status": "needs_materialization"
        }),
    )
    .unwrap();
}

// completed_literature_scout_count wants all four of these, and an earlier
// version of this fixture supplied two. The analyst then stopped at
// "waiting-for-literature-scout scout_literature_completed=0", 60 lines above
// the gate under test, and the analyst half of these tests proved nothing.
fn write_completed_scout(paths: &AppPaths, cycle: &str, lane_id: &str) {
    let lane = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane).unwrap();
    create_lane_contract(
        paths,
        cycle,
        lane_id,
        "scout",
        "external-driver",
        "driver-exec",
        "scout fixture",
    )
    .unwrap();
    write_json(
        &lane.join("run-state.json"),
        &json!({"lane_id": lane_id, "role": "scout"}),
    )
    .unwrap();
    write_json(
        &lane.join("final-status.json"),
        &json!({"lane_id": lane_id, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &lane.join("result.json"),
        &json!({
            "status": "completed",
            "driver": "literature-search-driver",
            "paper_count": 12
        }),
    )
    .unwrap();
}

fn lane_contract_for(paths: &AppPaths, cycle: &str, lane_id: &str, role: &str) -> LaneContract {
    LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: lane_id.to_string(),
        role: role.to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: PathBuf::from("task.md"),
        allowed_inputs: Vec::new(),
        allowed_outputs: Vec::new(),
        output_artifact: None,
        fallback_strategy: None,
    }
}

#[test]
fn a_generated_data_lead_does_not_hold_the_analyst() {
    // The v87 deadlock, stated as an assertion.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-generated-data-analyst";
    write_generated_data_lead(&paths, cycle);
    write_completed_scout(&paths, cycle, "scout-01");

    // Prove the fixture reaches the gate under test before asserting on it: the
    // upstream scout and hypothesis gates sit above it and would pass this
    // assertion for the wrong reason.
    let fetchable = "cycle-generated-data-analyst-control";
    write_fetchable_lead(&paths, fetchable);
    write_completed_scout(&paths, fetchable, "scout-01");
    let control = lane_contract_for(&paths, fetchable, "analyst-01", "analyst");
    assert_eq!(
        dependency_blocker_for_lane(&paths, fetchable, &control).unwrap().as_deref(),
        Some("waiting-for-validation-materialization-gate validation_data_status=needs_materialization"),
        "control: an identical analyst on a fetchable lead must reach and fail the gate"
    );

    let contract = lane_contract_for(&paths, cycle, "analyst-01", "analyst");
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert!(
        !blocker
            .as_deref()
            .unwrap_or("")
            .starts_with("waiting-for-validation-materialization-gate"),
        "a lead that generates its own data has nothing for the analyst to wait on, got {blocker:?}"
    );
}

#[test]
fn a_generated_data_lead_does_not_hold_the_runner_either() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-generated-data-runner";
    write_generated_data_lead(&paths, cycle);
    write_completed_scout(&paths, cycle, "scout-01");

    let contract = lane_contract_for(&paths, cycle, "lab-runner-02", "lab-runner");
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert!(
        !blocker
            .as_deref()
            .unwrap_or("")
            .starts_with("waiting-for-validation-materialization-gate"),
        "the runner exemption must survive the rewrite, got {blocker:?}"
    );
}

#[test]
fn a_fetchable_accession_still_holds_every_gated_role() {
    // The fail-closed behaviour that matters: never run a lane against a cohort
    // that has not downloaded. Widening the exemption must not touch this.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-fetchable-still-gates";
    write_fetchable_lead(&paths, cycle);
    write_completed_scout(&paths, cycle, "scout-01");

    for (lane_id, role) in [
        ("analyst-01", "analyst"),
        ("lab-runner-02", "lab-runner"),
        ("gatekeeper-01", "gatekeeper"),
    ] {
        let contract = lane_contract_for(&paths, cycle, lane_id, role);
        let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
        assert_eq!(
            blocker.as_deref(),
            Some("waiting-for-validation-materialization-gate validation_data_status=needs_materialization"),
            "{role} must still wait for a real accession to land"
        );
    }
}

#[test]
fn a_lead_whose_data_the_harness_generated_under_simulations_is_materialized() {
    // cycle-a-20260919, 2026-10-30: the lead's episodes.csv was on disk
    // under datasets/<cycle>/simulations/<slug>, and the lookup only read
    // datasets/<cycle>/<slug>. Fifty-six older override runners then made the
    // lead "unobtainable", the artifact unusable, and every analyst wait for it.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-simulated-lead";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "status": "selected",
            "statement": "Removing nearest support makes chunked BC brittle.",
            "dataset_or_accession": "state_support_randomized_intervention_v1",
            "validation_data_status": "materialized"
        }),
    )
    .unwrap();
    assert!(!active_lead_dataset_materialized_on_disk(&paths, cycle), "nothing on disk yet");

    let bundle = paths
        .runtime_root
        .join("datasets")
        .join(cycle)
        .join("simulations")
        .join("state_support_randomized_intervention_v1");
    fs::create_dir_all(&bundle).unwrap();
    assert!(!active_lead_dataset_materialized_on_disk(&paths, cycle), "an empty directory is not data");
    fs::write(bundle.join("episodes.csv"), "episode,success
0,1
").unwrap();
    assert!(active_lead_dataset_materialized_on_disk(&paths, cycle));
}
