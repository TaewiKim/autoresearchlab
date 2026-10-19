// A lane that is always passed over is a lane that never runs.
//
// The dispatch order is a priority sort with no term for waiting, and slots are
// few. When higher-ranked work is created faster than it is consumed, the sort
// is stable against the same losers forever -- a lane behind the cut is behind
// it on every round, and nothing about it changes.
//
// MEASURED ON cycle-g-v91, 2026-09-13/14. With `--max-concurrency 3`, one
// dispatch pass skipped 37 lanes and 29 of them read `no-worker-slots`. Two were
// the cycle's only `abstract_review_followup` lanes -- the step that turns
// retrieved papers into admitted ones -- enqueued at 10:09Z and still unlaunched
// five and a half hours later, behind 94 queued novelty actions and 51
// gate-restart actions. Admitted papers sat at 179 through all of it while the
// gate advanced from round 21 to 29, and every literature lane that found
// reviewable papers was recorded as a blocking failure asking for the review
// lane that could not start.

fn touch_contract_aged(paths: &AppPaths, cycle: &str, lane_id: &str, age_seconds: u64) {
    let root = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&root).unwrap();
    let contract_path = root.join("lane-contract.json");
    write_json(&contract_path, &json!({ "lane_id": lane_id })).unwrap();
    let when = SystemTime::now() - std::time::Duration::from_secs(age_seconds);
    fs::OpenOptions::new()
        .write(true)
        .open(&contract_path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
fn a_lane_waiting_past_the_threshold_is_promoted() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-starvation";

    touch_contract_aged(&paths, cycle, "followup-scout-18", 6 * 3600);
    touch_contract_aged(&paths, cycle, "followup-scout-40", 30);

    // 0 sorts before 1, so the starved lane reaches a slot first.
    assert_eq!(dispatch_starvation_rank(&paths, cycle, "followup-scout-18"), 0);
    assert_eq!(dispatch_starvation_rank(&paths, cycle, "followup-scout-40"), 1);
}

#[test]
fn the_threshold_is_tunable_and_zero_restores_the_old_order() {
    // An owner who does not want the promotion must be able to turn it off
    // without a rebuild, and a shorter threshold must actually shorten it.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-starvation-tunable";
    touch_contract_aged(&paths, cycle, "followup-scout-18", 6 * 3600);

    env::set_var("RESEARCHLAB_DISPATCH_STARVATION_SECONDS", "0");
    assert_eq!(dispatch_starvation_rank(&paths, cycle, "followup-scout-18"), 1);

    env::set_var("RESEARCHLAB_DISPATCH_STARVATION_SECONDS", "60");
    assert_eq!(dispatch_starvation_rank(&paths, cycle, "followup-scout-18"), 0);

    env::remove_var("RESEARCHLAB_DISPATCH_STARVATION_SECONDS");
}

#[test]
fn a_lane_with_no_contract_is_not_called_starved() {
    // Absence is not age. A lane whose contract cannot be read has no waiting
    // time to measure, and guessing "forever" would put it in front of work
    // that really is waiting.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    assert_eq!(lane_waiting_seconds(&paths, "cg-starvation-missing", "followup-scout-99"), 0);
    assert_eq!(dispatch_starvation_rank(&paths, "cg-starvation-missing", "followup-scout-99"), 1);
}

#[test]
fn among_starved_lanes_the_longest_waiting_goes_first() {
    // cycle-a-20260919: every gate re-review had waited past the
    // threshold, so the rank no longer told them apart and the novelty
    // re-review (enqueued 19:46Z) kept beating technical quality (15:26Z).
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-starvation-fifo";
    touch_contract_aged(&paths, cycle, "followup-gatekeeper-32", 17 * 3600);
    touch_contract_aged(&paths, cycle, "followup-gatekeeper-38", 13 * 3600);
    touch_contract_aged(&paths, cycle, "followup-scout-90", 30);

    let older = dispatch_starvation_order(&paths, cycle, "followup-gatekeeper-32");
    let newer = dispatch_starvation_order(&paths, cycle, "followup-gatekeeper-38");
    let fresh = dispatch_starvation_order(&paths, cycle, "followup-scout-90");
    assert!(older < newer, "the lane waiting 17 h must sort before the one waiting 13 h");
    assert!(newer < fresh, "a starved lane still sorts before fresh work");
}

#[test]
fn lanes_that_are_not_starved_keep_the_schedulers_order() {
    // Below the threshold the key must be identical, or waiting time would
    // silently replace every priority the scheduler computes.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-starvation-fresh";
    touch_contract_aged(&paths, cycle, "followup-scout-90", 30);
    touch_contract_aged(&paths, cycle, "followup-scout-91", 1200);
    assert_eq!(
        dispatch_starvation_order(&paths, cycle, "followup-scout-90"),
        dispatch_starvation_order(&paths, cycle, "followup-scout-91"),
    );
}

#[test]
fn executable_handoff_runner_outranks_stale_review_backlog() {
    // MEASURED ON cycle-a-20260919, 2026-10-01: the cycle was at
    // experiment_data with three completed comparator-design lanes and a
    // sealed handoff, but followup-runner-101 remained pending behind 60 gate
    // reviews aged up to 49 hours. The runner is the only lane whose completion
    // can publish post-bundle validation and advance the cycle to analysis.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-a-20260919";
    touch_contract_aged(&paths, cycle, "followup-gatekeeper-100", 49 * 3600);
    touch_contract_aged(&paths, cycle, "followup-runner-101", 7 * 60);

    let stale_review = json!({
        "role": "gatekeeper",
        "action_type": "independent_gate_review_followup",
        "source_brief_id": "old-gate-review"
    });
    let handoff_runner = json!({
        "role": "lab-runner",
        "action_type": "methods_followup",
        "source_brief_id": "analyst-handoff"
    });
    let scheduling_key = |lane_id: &str, role_plan: &Value| {
        (
            pending_lane_pipeline_unblock_rank(Some(role_plan)),
            dispatch_starvation_order(&paths, cycle, lane_id),
            pending_lane_action_priority(Some(role_plan), false),
        )
    };

    assert!(
        scheduling_key("followup-runner-101", &handoff_runner)
            < scheduling_key("followup-gatekeeper-100", &stale_review),
        "the executable validation runner must reach a worker slot before stale reviews"
    );
}

#[test]
fn post_bundle_analysis_outranks_gate_review_churn() {
    // MEASURED ON cycle-a-20260919, 2026-10-02: while progress waited
    // at experiment_data for validation newer than the selected bundle, three
    // independent_gate_review_followup lanes finished. The requested Analyst
    // hypothesis_followup is what creates the fresh executable analysis handoff;
    // letting another review run first cannot satisfy the milestone.
    let analyst = json!({
        "role": "analyst",
        "action_type": "hypothesis_followup",
        "source_brief_id": "followup-lab-director-320"
    });
    let review = json!({
        "role": "gatekeeper",
        "action_type": "independent_gate_review_followup",
        "source_brief_id": "gate-review-clarity"
    });

    assert_eq!(pending_lane_pipeline_unblock_rank(Some(&analyst)), 0);
    assert_eq!(pending_lane_pipeline_unblock_rank(Some(&review)), 1);
}

#[test]
fn a_prepared_quota_lane_remains_dispatchable_after_resume() {
    // MEASURED ON cycle-a-20260919, 2026-09-30. The records read by
    // the health finding had followup-lab-director-195 `prepared` in both the
    // large-cycle index and final-status.json after quota recovery. It waited
    // 157 hours while followup-lab-director-236 through -238 finished because
    // dispatch treated any final-status file as terminal.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-a-20260919";
    fs::create_dir_all(state_root(&paths)).unwrap();

    let prepared_id = "followup-lab-director-195";
    let prepared_dir = lane_root(&paths, cycle, prepared_id);
    fs::create_dir_all(&prepared_dir).unwrap();
    let prepared_contract = prepared_dir.join("lane-contract.json");
    write_json(
        &prepared_contract,
        &json!({
            "cycle_id": cycle,
            "lane_id": prepared_id,
            "role": "lab-director",
            "runtime_class": "codex-agent",
            "mode": "read-write-scoped",
            "cwd": temp.path(),
            "task_file": prepared_dir.join("task.md"),
            "allowed_inputs": [],
            "allowed_outputs": [],
        }),
    )
    .unwrap();
    write_json(
        &prepared_dir.join("run-state.json"),
        &json!({
            "lane_id": prepared_id,
            "status": "prepared",
            "failure_category": "quota_exceeded",
        }),
    )
    .unwrap();
    write_json(
        &prepared_dir.join("final-status.json"),
        &json!({
            "lane_id": prepared_id,
            "status": "prepared",
            "failure_category": "quota_exceeded",
        }),
    )
    .unwrap();
    write_json(
        &prepared_dir.join("role-plan.json"),
        &json!({"action_type": "lab_director_requery_followup"}),
    )
    .unwrap();

    let mut lane_statuses = (0..43)
        .map(|index| {
            json!({
                "lane_id": format!("followup-lab-director-{}", 196 + index),
                "role": "lab-director",
                "status": "completed",
            })
        })
        .collect::<Vec<_>>();
    lane_statuses.push(json!({
        "lane_id": prepared_id,
        "role": "lab-director",
        "status": "prepared",
    }));
    write_json(
        &state_root(&paths).join(format!("{cycle}-cycle-run-state.json")),
        &json!({"cycle_id": cycle, "lane_statuses": lane_statuses}),
    )
    .unwrap();

    let cached = open_contract_paths_for_dispatch(&paths, cycle, &[])
        .unwrap()
        .expect("the measured large-cycle index must be used");
    let dispatchable = dispatchable_contract_paths(&paths, cycle, cached);
    assert_eq!(dispatchable, vec![prepared_contract]);

    write_json(
        &prepared_dir.join("final-status.json"),
        &json!({"lane_id": prepared_id, "status": "completed"}),
    )
    .unwrap();
    assert!(dispatchable_contract_paths(&paths, cycle, dispatchable).is_empty());
}

#[test]
fn the_promotion_names_no_action_type() {
    // The failure is starvation, not a mis-ranked action. A rule that names the
    // one action seen on cycle-g-v91 fixes that cycle and no other -- and this
    // repository has measured that shape of fix failing for the domain nobody
    // enumerated, more than once.
    let source = include_str!("../plan/run_loop.rs");
    let start = source
        .find("fn dispatch_starvation_rank")
        .expect("the starvation rank is gone");
    let end = source[start..]
        .find("\npub(crate) fn ")
        .map(|offset| start + offset)
        .unwrap_or(source.len());
    let body = &source[start..end];
    for named in [
        "abstract_review_followup",
        "novelty_followup",
        "gate_restart_followup",
        "scout",
        "gatekeeper",
    ] {
        assert!(
            !body.contains(named),
            "{named} is named in the starvation rule; it must promote any starved lane",
        );
    }
}

// Whoever the blocked lanes are waiting for goes first.
//
// MEASURED ON cycle-g-v91, 2026-09-13. Ten gatekeepers were blocked on
// `waiting-for-latest-analyst-handoff-runner`; the handoff was written at 03:13
// and no runner started on it until 04:37 -- an hour and twenty-four minutes --
// with every dispatch pass in between recording nineteen `no-worker-slots`
// skips. The gate sat at round 32 for three hours.

fn contract_for(lane_id: &str, role: &str) -> (PathBuf, LaneContract) {
    (
        PathBuf::from(format!("/lanes/{lane_id}/lane-contract.json")),
        LaneContract {
            cycle_id: "cg-awaited".to_string(),
            lane_id: lane_id.to_string(),
            role: role.to_string(),
            runtime_class: "codex-agent".to_string(),
            mode: "read-write-scoped".to_string(),
            cwd: PathBuf::from("/"),
            task_file: PathBuf::from("/task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![],
            output_artifact: None,
            fallback_strategy: None,
        },
    )
}

fn order(items: &[(PathBuf, LaneContract)]) -> Vec<String> {
    items.iter().map(|(_, c)| c.lane_id.clone()).collect()
}

#[test]
fn the_role_others_wait_on_is_dispatched_first() {
    let mut items = vec![
        contract_for("followup-scout-61", "scout"),
        contract_for("followup-gatekeeper-62", "gatekeeper"),
        contract_for("followup-runner-54", "lab-runner"),
        contract_for("followup-scout-62", "scout"),
    ];
    let awaited: HashSet<String> = ["lab-runner".to_string()].into_iter().collect();
    awaited_roles_first(&mut items, &awaited);
    assert_eq!(order(&items)[0], "followup-runner-54");
}

#[test]
fn the_order_already_computed_survives_inside_each_group() {
    // A stable sort, or the promotion would silently discard every key the
    // scheduler spent a disk read working out.
    let mut items = vec![
        contract_for("followup-scout-61", "scout"),
        contract_for("followup-runner-54", "lab-runner"),
        contract_for("followup-scout-62", "scout"),
        contract_for("followup-runner-55", "lab-runner"),
    ];
    let awaited: HashSet<String> = ["lab-runner".to_string()].into_iter().collect();
    awaited_roles_first(&mut items, &awaited);
    assert_eq!(
        order(&items),
        vec![
            "followup-runner-54".to_string(),
            "followup-runner-55".to_string(),
            "followup-scout-61".to_string(),
            "followup-scout-62".to_string(),
        ],
    );
}

#[test]
fn a_cycle_where_nobody_is_waiting_sorts_exactly_as_before() {
    let original = vec![
        contract_for("followup-scout-61", "scout"),
        contract_for("followup-runner-54", "lab-runner"),
        contract_for("followup-gatekeeper-62", "gatekeeper"),
    ];
    let mut items = original.clone();
    awaited_roles_first(&mut items, &HashSet::new());
    assert_eq!(order(&items), order(&original));
}

#[test]
fn the_promotion_reads_the_blocker_and_names_no_role() {
    // The rule must work for whichever role this cycle happens to wait on. A
    // literal here would fix cycle-g-v91 and no other cycle.
    let source = include_str!("../plan/run_loop.rs");
    let start = source.find("pub(crate) fn awaited_roles_first").expect("the rule is gone");
    let end = source[start..]
        .find("\npub(crate) fn lane_waiting_seconds")
        .map(|offset| start + offset)
        .unwrap_or(source.len());
    let body = &source[start..end];
    for named in ["lab-runner", "gatekeeper", "analyst", "scout", "lab-director"] {
        assert!(!body.contains(named), "{named} is named in the promotion rule");
    }
}

#[test]
fn an_engineer_stays_ahead_of_the_role_others_wait_on() {
    // cycle-b-20260918: the simulation engineer was pushed behind two
    // literature lanes by this promotion while all analysis waited on its data.
    let mut items = vec![
        contract_for("followup-scout-31", "scout"),
        contract_for("followup-engineer-01", "engineer"),
        contract_for("followup-scout-32", "scout"),
    ];
    let awaited: HashSet<String> = ["scout".to_string()].into_iter().collect();
    awaited_roles_first(&mut items, &awaited);
    assert_eq!(order(&items)[0], "followup-engineer-01");
    assert_eq!(order(&items)[1], "followup-scout-31");

    let mut nobody_waiting = vec![
        contract_for("followup-scout-31", "scout"),
        contract_for("followup-engineer-01", "engineer"),
    ];
    awaited_roles_first(&mut nobody_waiting, &HashSet::new());
    assert_eq!(order(&nobody_waiting)[0], "followup-engineer-01");
}
