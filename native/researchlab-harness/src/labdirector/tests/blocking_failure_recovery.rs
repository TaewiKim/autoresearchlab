// A blocking lane failure asked the director to plan, and nothing opened a lane.
//
// `chronicle/aggregate.rs` writes the request whenever a blocking lane fails:
// `recovery_needed: true`, `lab_director_attention_required: true`, and an entry
// in `lab_director_alerts` with `owner: "lab-director"`, `requires_recovery:
// true`, and the reason "blocking lane failed; keep cycle alive and request
// recovery planning".
//
// Nothing read it. The only other reference in the tree was
// `reporting/visualizer/shared.js`, which re-writes the field for display. So
// the message named its recipient, stated what it wanted, and no lane was opened.
//
// Measured twice, both with a live supervisor and no halt:
//   cycle-g-v90   failed_blocking 1, pending 10, running 0 -- for hours
//   cycle-g-v91   failed_blocking 3, pending 12, running 0, the supervisor
//                 returning `resume-cycle-complete` every pass while the
//                 blocking failures accumulated
//
// A human had to notice both times.

fn write_cycle_state_with_alerts(paths: &AppPaths, cycle: &str, lanes: &[(&str, &str)]) {
    fs::create_dir_all(state_root(paths)).unwrap();
    let alerts = lanes
        .iter()
        .map(|(lane_id, role)| {
            json!({
                "lane": { "lane_id": lane_id, "role": role, "status": "failed" },
                "owner": "lab-director",
                "reason": "blocking lane failed; keep cycle alive and request recovery planning",
                "requires_recovery": true,
                "severity": "error",
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &state_root(paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "status": "running",
            "recovery_needed": true,
            "lab_director_attention_required": true,
            "lab_director_alerts": alerts,
            "lane_counts": { "completed": 10, "failed": lanes.len(), "pending": 12, "running": 0 },
        }),
    )
    .unwrap();
}

fn write_lane_failure_category(paths: &AppPaths, cycle: &str, lane_id: &str, category: &str) {
    let dir = cycle_lanes_root(paths, cycle).join(lane_id);
    fs::create_dir_all(&dir).unwrap();
    write_json(
        &dir.join("run-state.json"),
        &json!({ "lane_id": lane_id, "status": "failed", "degraded": true, "failure_category": category }),
    )
    .unwrap();
}

#[test]
fn a_blocking_failure_opens_the_director_lane_it_asks_for() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";
    write_cycle_state_with_alerts(&paths, cycle, &[("scout-02", "scout")]);
    write_lane_failure_category(&paths, cycle, "scout-02", "adaptive_literature_search_incomplete");

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();

    assert_eq!(actions.len(), 1, "the alert named lab-director and no lane was opened");
    let action = &actions[0];
    assert_eq!(action["preferred_role"], json!("lab-director"));
    assert_eq!(action["type"], json!("blocking_lane_recovery_planning"));
    assert_eq!(action["priority"], json!("critical"));
    assert_eq!(action["failed_lane_ids"], json!(["scout-02"]));

    // The director plans against what the lane RECORDED, not a restatement of
    // "it failed": the category is the only thing that says a re-run is pointless.
    let blockers = action["blocker_reasons"].as_array().unwrap();
    assert!(
        blockers[0]
            .as_str()
            .unwrap()
            .contains("adaptive_literature_search_incomplete"),
        "the recorded failure category did not reach the director: {blockers:?}",
    );
}

#[test]
fn every_distinct_blocking_lane_reaches_the_director_once() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";
    // v91's actual three, including the duplicate an alert list can carry.
    write_cycle_state_with_alerts(
        &paths,
        cycle,
        &[
            ("scout-02", "scout"),
            ("followup-scout-01", "scout"),
            ("followup-scout-02", "scout"),
            ("scout-02", "scout"),
        ],
    );
    for lane in ["scout-02", "followup-scout-01", "followup-scout-02"] {
        write_lane_failure_category(&paths, cycle, lane, "literature_abstract_review_required");
    }

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();

    assert_eq!(actions.len(), 1, "one planning request, not one per lane");
    assert_eq!(
        actions[0]["failed_lane_ids"],
        json!(["scout-02", "followup-scout-01", "followup-scout-02"]),
    );
}

#[test]
fn a_cycle_that_needs_no_recovery_gets_no_action() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "status": "running",
            "recovery_needed": false,
            "lab_director_alerts": [],
            "lane_counts": { "completed": 10, "failed": 0, "pending": 2, "running": 2 },
        }),
    )
    .unwrap();

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert!(actions.is_empty());
}

#[test]
fn an_alert_that_does_not_require_recovery_is_not_a_recovery_request() {
    // `lab_director_alerts` carries more than blocking failures; only the ones
    // that say they need recovery may open a lane.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({
            "cycle_id": cycle,
            "recovery_needed": true,
            "lab_director_alerts": [{
                "lane": { "lane_id": "gatekeeper-04", "role": "gatekeeper", "status": "completed" },
                "owner": "lab-director",
                "reason": "informational",
                "requires_recovery": false,
            }],
        }),
    )
    .unwrap();

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert!(actions.is_empty());
}

#[test]
fn a_missing_cycle_state_is_silence_rather_than_an_error() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, "cg-gate-absent", &mut actions).unwrap();
    assert!(actions.is_empty());
}

#[test]
fn completed_simulation_blockers_open_one_director_decision_lane() {
    // MEASURED ON cycle-a-20260919, 2026-09-30: the milestone stayed
    // at reproduction_anchor through six completed simulation lanes. All six
    // returned the same structured missing-GPU blocker, but completed reports
    // were invisible to failed-lane recovery and no decision lane owned them.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-a-20260919";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let simulation_order = json!({
        "request_id": "axis_visual_invariance_v1",
        "simulator_backend": "isaacsim",
        "output_path": format!(".research-lab/datasets/{cycle}/simulations/axis_visual_invariance_v1/episodes.csv"),
    });
    record_lab_director_simulation_orders(
        &paths,
        cycle,
        "followup-lab-director-263",
        &json!({"simulation_orders": [simulation_order]}),
    )
    .unwrap();
    for lane_id in [
        "followup-engineer-218",
        "followup-engineer-219",
        "followup-engineer-221",
        "followup-engineer-223",
        "followup-engineer-225",
        "followup-engineer-227",
    ] {
        let lane_dir = cycle_lanes_root(&paths, cycle).join(lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "role": "engineer",
                "action_type": SIMULATION_DATA_GENERATION_ACTION,
                "source_brief_id": "simulation-axis_visual_invariance_v1",
            }),
        )
        .unwrap();
        write_json(&lane_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        write_json(
            &lane_dir.join("result.json"),
            &json!({"extracted_json": {
                "capability_blockers": [{
                    "requirement": "Isaac Sim paired RGB rendering",
                    "attempts": [{"command": "nvidia-smi", "error": "GPU access blocked"}],
                    "alternatives_tried": [{"approach": "CPU PhysX", "outcome": "physics only"}],
                    "why_unsatisfiable": "Device nodes and the required driver are absent."
                }]
            }}),
        )
        .unwrap();
    }

    let mut actions = Vec::new();
    collect_simulation_blocker_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1, "the six blockers did not converge on one decision: {actions:?}");
    assert_eq!(actions[0]["preferred_role"], json!("lab-director"));
    assert_eq!(actions[0]["type"], json!("blocking_lane_recovery_planning"));
    assert_eq!(actions[0]["blocked_lane_ids"].as_array().unwrap().len(), 6);
    // MEASURED ON cycle-a-20260919, 2026-10-01: three completed
    // recovery planners selected a different Isaac worker, but simulation
    // orders have no venue selector and every reissue ran on the same GPU-less
    // executor. The recovery contract must expose only state changes the
    // scheduler can carry.
    assert!(
        actions[0]["description"]
            .as_str()
            .unwrap()
            .contains("no worker or execution-venue selector"),
        "the director was not told why the requested venue change is inert: {:?}",
        actions[0],
    );
    assert!(
        actions[0]["description"]
            .as_str()
            .unwrap()
            .contains("environment-blocked"),
        "the real environment-block exit was not preserved: {:?}",
        actions[0],
    );
    assert!(
        !actions[0]["description"]
            .as_str()
            .unwrap()
            .contains("arrange a capable venue"),
        "the decision lane can still select an unrepresentable route: {:?}",
        actions[0],
    );

    // A director-owned replacement is representable: a new request bound to a
    // backend on the current path immediately becomes engineer work instead of
    // another recovery-planning loop.
    let replacement_order = json!({
        "request_id": "randomized_support_equivalence_v2",
        "simulator_backend": "mujoco",
        "interpreter_path": "/opt/envs/research/bin/python",
        "output_path": format!(
            ".research-lab/datasets/{cycle}/simulations/randomized_support_equivalence_v2/episodes.csv"
        ),
    });
    record_lab_director_simulation_orders(
        &paths,
        cycle,
        "followup-lab-director-285",
        &json!({"simulation_orders": [replacement_order]}),
    )
    .unwrap();
    let mut replacement_actions = Vec::new();
    collect_simulation_generation_actions(&paths, cycle, &mut replacement_actions).unwrap();
    assert_eq!(replacement_actions.len(), 1);
    assert_eq!(
        replacement_actions[0]["type"],
        json!(SIMULATION_DATA_GENERATION_ACTION),
        "the executable replacement did not advance to data generation"
    );
    assert_eq!(
        replacement_actions[0]["simulation_order"]["request_id"],
        json!("randomized_support_equivalence_v2")
    );
}

#[test]
fn simulation_recovery_does_not_offer_an_unroutable_worker_change() {
    // MEASURED ON cycle-a-20260919, 2026-10-01: three
    // blocking_lane_recovery_planning lanes completed while reproduction_anchor
    // did not move. Each chose a different capable worker, but no simulation
    // order field can select one, so the scheduler returned to the same venue.
    let description = simulation_blocker_recovery_description("axis_visual_invariance_v1");
    assert!(description.contains("no worker or execution-venue selector"));
    assert!(description.contains("environment-blocked"));
    assert!(description.contains("scientifically valid replacement"));
    assert!(!description.contains("arrange a capable venue"));
}

#[test]
fn blocking_recovery_uses_bounded_headroom_after_plain_director_cap() {
    // MEASURED ON cycle-a-20260919, 2026-09-30: the six completed
    // simulation blockers arrived after the cycle had already exceeded the
    // ordinary LabDirector cap. Routing the evidence to a director action is
    // ineffective unless that critical action can use the existing finite
    // exempt headroom.
    let pass_budget_by_role = HashMap::from([("lab-director", 2usize)]);
    let existing_followup_counts = HashMap::from([("lab-director".to_string(), 65usize)]);
    let none = HashMap::new();
    let ctx = FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts: &existing_followup_counts,
        existing_action_counts: &none,
        open_action_counts: &none,
        existing_total_followups: 65,
        total_followup_cap: 4096,
        pass_budget_by_role: &pass_budget_by_role,
        document_stage_authorized: false,
        latest_handoff_served: None,
    };

    assert!(followup_role_available(
        &ctx,
        "lab-director",
        "blocking_lane_recovery_planning",
        &HashMap::new(),
        &HashMap::new(),
    ));
    // 2026-10-03: one budget, and nothing bypasses it once spent.
    let spent = FollowupRoleAvailabilityContext { existing_total_followups: 64, total_followup_cap: 64, ..ctx };
    assert!(!followup_role_available(
        &spent,
        "lab-director",
        "blocking_lane_recovery_planning",
        &HashMap::new(),
        &HashMap::new(),
    ));
}

#[test]
fn the_recovery_lane_is_not_held_by_the_gate_it_exists_to_resolve() {
    // cycle-g-v91: three scouts failed, the aggregate raised the request, the
    // dispatcher opened followup-lab-director-02 for it -- and the ordering gate
    // skipped that lane with
    //
    //     waiting-for-literature-scout scout_literature_completed=0
    //
    // which is the condition it was opened to decide about. All twelve pending
    // lanes carried a variant of that one reason, so the cycle could neither
    // move nor decide to move differently.
    let recovery = json!({ "action_type": "blocking_lane_recovery_planning" });
    assert!(lane_is_blocking_failure_recovery(&recovery));

    // An ordinary director lane still waits its turn: the exemption is for the
    // one action, not for the role.
    for plan in [
        json!({ "action_type": "hypothesis_refinement" }),
        json!({ "action_type": "methods_followup" }),
        json!({}),
    ] {
        assert!(
            !lane_is_blocking_failure_recovery(&plan),
            "an ordinary director lane must still wait for a corpus: {plan}",
        );
    }
}

#[test]
fn the_recovery_request_carries_what_this_role_did_in_earlier_cycles() {
    // The first read of state/researchlab.sqlite. It held 7,015 task rows across
    // 18 cycles and nothing in the tree ever SELECTed from it -- rebuilt every
    // supervisor pass, queried by nobody. A director asked to repair, replace or
    // proceed without a failed lane is being asked whether this is a blip or a
    // pattern, and that question has an answer on disk.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";

    fs::create_dir_all(state_root(&paths)).unwrap();
    let conn = rusqlite::Connection::open(state_root(&paths).join("researchlab.sqlite")).unwrap();
    conn.execute(
        "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, cycle_id TEXT, role TEXT, status TEXT)",
        [],
    )
    .unwrap();
    for (id, c, role, status) in [
        ("t1", "cycle-g-v90-test", "scout", "failed"),
        ("t2", "cycle-g-v90-test", "scout", "completed"),
        ("t3", "cycle-g-v89-test", "scout", "completed"),
        ("t4", "cycle-g-v89-test", "analyst", "failed"),
        // The current cycle is excluded: it is the thing being decided about.
        ("t5", "cycle-g-v91-test", "scout", "failed"),
    ] {
        conn.execute(
            "INSERT INTO tasks (task_id, cycle_id, role, status) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, c, role, status],
        )
        .unwrap();
    }
    drop(conn);

    write_cycle_state_with_alerts(&paths, cycle, &[("scout-02", "scout")]);
    write_lane_failure_category(&paths, cycle, "scout-02", "adaptive_literature_search_incomplete");

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    let blocker = actions[0]["blocker_reasons"][0].as_str().unwrap();

    assert!(blocker.contains("Prior record"), "no history reached the director: {blocker}");
    assert!(blocker.contains("2 earlier cycle(s)"), "{blocker}");
    assert!(blocker.contains("failures in 1 of them"), "{blocker}");
    // The current cycle's own failure is not counted as history.
    assert!(!blocker.contains("cycle-g-v91-test 0ok"), "{blocker}");
}

#[test]
fn a_missing_store_costs_the_recovery_request_nothing() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-g-v91-test";
    write_cycle_state_with_alerts(&paths, cycle, &[("scout-02", "scout")]);
    write_lane_failure_category(&paths, cycle, "scout-02", "literature_retrieval_throttled");

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1, "a store that cannot be read must not lose the request");
    let blocker = actions[0]["blocker_reasons"][0].as_str().unwrap();
    assert!(blocker.contains("literature_retrieval_throttled"));
    assert!(!blocker.contains("Prior record"));
}
