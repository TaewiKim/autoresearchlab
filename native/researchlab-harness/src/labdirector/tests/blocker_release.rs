// A door the director was told it had, at one of sixteen places it needed one.
//
// Every director prompt in this programme carries the sentence "Process stages
// are advisory safety rails; a LabDirector override requires a recorded
// `stage_gate_override` rationale". The override behind it is real and careful.
// It had ONE call site -- `hypothesis_generation` -- while the twenty
// `waiting-for-*` dependency blockers that actually froze cycle-g-v90 and
// cycle-g-v91 had no override, no timeout and no grace period between them.
//
// That is the eighth instance this cycle of one shape: a rule exists, and does
// not reach the path that runs.

fn override_paths_cycle(paths: &AppPaths, cycle: &str, override_block: Value) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "cycle_id": cycle,
            "selected_hypothesis": { "statement": "a statement" },
            "dependency_gate_override": override_block,
        }),
    )
    .unwrap();
}

#[test]
fn every_blocker_names_who_can_clear_it() {
    // This is the enforcement, not a description of it. A gate added without an
    // owner fails here, because the whole finding was that a blocker string
    // carried a count and not one word about who was supposed to change it: on
    // cycle-g-v91, `scout_literature_completed=0` was owned by a scout that
    // could never complete, and twelve lanes waited on it anyway.
    let sources = [
        include_str!("../gates/dependency_gates/dependency_gates_01.rs"),
        include_str!("../gates/dependency_gates/dependency_gates_02.rs"),
    ];
    let mut checked = 0usize;
    for source in sources {
        for fragment in source.split("\"waiting-for-").skip(1) {
            let blocker: String = fragment
                .chars()
                .take_while(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || *character == '-'
                })
                .collect();
            if blocker.is_empty() {
                continue;
            }
            let reason = format!("waiting-for-{blocker}");
            let (awaited_role, clears_when) = blocker_descriptor(&reason);
            assert!(
                awaited_role.is_some(),
                "{reason} names nobody who could clear it; add it to BLOCKER_OWNERS",
            );
            assert!(
                !clears_when.starts_with("unrecorded"),
                "{reason} does not say what would clear it",
            );
            checked += 1;
        }
    }
    assert!(checked >= 15, "only {checked} blockers scanned; the scan broke");
}

#[test]
fn the_longest_prefix_wins_so_a_graph_wait_is_not_read_as_a_chronicle_wait() {
    // `waiting-for-chronicle-graphs` and `waiting-for-chronicle` are different
    // holds with different remedies, and a table that resolved by write order
    // would conflate them the first time somebody appended an entry.
    let (_, graphs) = blocker_descriptor("waiting-for-chronicle-graphs literature_graph=false");
    assert!(graphs.contains("literature graph"), "{graphs}");
    let (_, chronicle) = blocker_descriptor("waiting-for-chronicle chronicle_completed=0");
    assert!(!chronicle.contains("literature graph"), "{chronicle}");

    let (_, reroute) = blocker_descriptor("waiting-for-analyst-handoff-reroute x=1");
    assert!(reroute.contains("rerouted"), "{reroute}");
}

#[test]
fn a_recorded_override_releases_the_blocker_it_names() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-override";
    override_paths_cycle(
        &paths,
        cycle,
        json!({
            "approved": true,
            "blocker": "waiting-for-literature-scout",
            "rationale": "scout-02 cannot complete; proceeding on the 21 candidates already queued",
        }),
    );
    assert!(dependency_gate_override_for(
        &paths,
        cycle,
        "waiting-for-literature-scout scout_literature_completed=0"
    )
    .is_some());
    // A different dead end is a different decision.
    assert!(dependency_gate_override_for(
        &paths,
        cycle,
        "waiting-for-core-experiments lab_runner_completed=0"
    )
    .is_none());
}

#[test]
fn an_override_without_approval_or_reason_releases_nothing() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-override-weak";

    override_paths_cycle(
        &paths,
        cycle,
        json!({ "blocker": "waiting-for-literature-scout", "rationale": "because" }),
    );
    assert!(
        dependency_gate_override_for(&paths, cycle, "waiting-for-literature-scout x=0").is_none(),
        "an unapproved override released a gate",
    );

    override_paths_cycle(
        &paths,
        cycle,
        json!({ "approved": true, "blocker": "waiting-for-literature-scout", "rationale": "   " }),
    );
    assert!(
        dependency_gate_override_for(&paths, cycle, "waiting-for-literature-scout x=0").is_none(),
        "an override with a blank rationale released a gate",
    );
}

#[test]
fn a_blanket_override_releases_nothing() {
    // A wildcard release is not an override; it is the dependency gates turned
    // off, which is a different decision and not one this door is for.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-override-blanket";
    for target in ["*", "all", ""] {
        override_paths_cycle(
            &paths,
            cycle,
            json!({ "approved": true, "blocker": target, "rationale": "open everything" }),
        );
        assert!(
            dependency_gate_override_for(&paths, cycle, "waiting-for-literature-scout x=0")
                .is_none(),
            "a blanket target ({target}) released a gate",
        );
    }
}

#[test]
fn a_stall_ages_while_its_blockers_hold_and_resets_when_they_change() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-stall";

    let held = vec![(
        "followup-analyst-03".to_string(),
        DependencyBlocker::describe("waiting-for-literature-scout scout_literature_completed=0".into()),
    )];
    record_dependency_stall(&paths, cycle, &held);
    let first = read_json(&dependency_stall_path(&paths, cycle)).unwrap();
    let first_seen = first.get("first_seen").and_then(Value::as_str).unwrap().to_string();

    // The same lanes held for the same reasons is the same stall, so the age
    // survives the round -- the age is the entire signal.
    record_dependency_stall(&paths, cycle, &held);
    let again = read_json(&dependency_stall_path(&paths, cycle)).unwrap();
    assert_eq!(again.get("first_seen").and_then(Value::as_str), Some(first_seen.as_str()));
    assert_eq!(
        again
            .get("blocked_lanes")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("awaited_role"))
            .and_then(Value::as_str),
        Some("scout"),
        "the stall record must name who could clear it",
    );

    // Another lane joining the same blocker is the stall growing, not the cycle
    // moving: it must not restart the clock (cycle-a-20260919, 2026-10-31).
    let grown = vec![
        held[0].clone(),
        (
            "followup-analyst-04".to_string(),
            DependencyBlocker::describe("waiting-for-literature-scout scout_literature_completed=0".into()),
        ),
    ];
    record_dependency_stall(&paths, cycle, &grown);
    let grown_stall = read_json(&dependency_stall_path(&paths, cycle)).unwrap();
    assert_eq!(grown_stall.get("first_seen").and_then(Value::as_str), Some(first_seen.as_str()));

    // Blockers that change mean the cycle is moving, even before a lane launches.
    let moved = vec![(
        "followup-analyst-03".to_string(),
        DependencyBlocker::describe("waiting-for-core-experiments lab_runner_completed=0".into()),
    )];
    record_dependency_stall(&paths, cycle, &moved);
    let reset = read_json(&dependency_stall_path(&paths, cycle)).unwrap();
    assert_ne!(reset.get("signature"), first.get("signature"));

    // Nothing held is not a stall.
    record_dependency_stall(&paths, cycle, &[]);
    assert!(!dependency_stall_path(&paths, cycle).exists());
}

#[test]
fn an_expired_stall_asks_the_director_to_decide_and_never_decides_itself() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-stall-expired";
    fs::create_dir_all(state_root(&paths)).unwrap();

    // A stall younger than the threshold is a cycle working slowly.
    write_json(
        &dependency_stall_path(&paths, cycle),
        &json!({
            "cycle_id": cycle,
            "first_seen": Utc::now().to_rfc3339(),
            "signature": "x",
            "blocked_lanes": [{
                "lane_id": "followup-analyst-03",
                "reason": "waiting-for-literature-scout scout_literature_completed=0",
                "awaited_role": "scout",
                "clears_when": "a literature scout lane completes",
            }],
        }),
    )
    .unwrap();
    let mut actions = Vec::new();
    collect_dependency_stall_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert!(actions.is_empty(), "a fresh stall is not a stall");

    // Past it, the harness asks -- and the action is the one the dependency
    // gates already exempt, so the decision lane can actually be dispatched.
    write_json(
        &dependency_stall_path(&paths, cycle),
        &json!({
            "cycle_id": cycle,
            "first_seen": (Utc::now() - chrono::Duration::seconds(
                dependency_stall_escalation_seconds() + 60,
            )).to_rfc3339(),
            "signature": "x",
            "blocked_lanes": [{
                "lane_id": "followup-analyst-03",
                "reason": "waiting-for-literature-scout scout_literature_completed=0",
                "awaited_role": "scout",
                "clears_when": "a literature scout lane completes",
            }],
        }),
    )
    .unwrap();
    let mut actions = Vec::new();
    collect_dependency_stall_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1);
    let action = &actions[0];
    assert_eq!(
        action.get("type").and_then(Value::as_str),
        Some("blocking_lane_recovery_planning"),
        "the escalation must use the action the gates exempt, or it deadlocks too",
    );
    assert_eq!(
        action.get("preferred_role").and_then(Value::as_str),
        Some("lab-director"),
        "the harness asks; it does not decide",
    );
    let reasons = action
        .get("blocker_reasons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = reasons
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    assert!(text.contains("scout owns it"), "{text}");
    assert!(text.contains("clears when"), "{text}");
    // Nothing was released -- the stall file is untouched by the request.
    assert!(dependency_stall_path(&paths, cycle).exists());
}

#[test]
fn the_director_is_told_the_door_exists() {
    // The whole finding is that a rule nobody is told about is a rule that does
    // not run. An override the director never hears of is exactly the stage-gate
    // override at one call site: present, correct, and unreachable.
    let authority = include_str!("../context/impact_mandate.rs");
    assert!(
        authority.contains("dependency_gate_override"),
        "the standing authority text does not mention the dependency override",
    );
    let plan = include_str!("../followups/role_plan/role_plan_01.rs");
    assert!(plan.contains("dependency_gate_override"), "role plans do not carry it");
    let policy = include_str!("../policy.rs");
    assert!(policy.contains("dependency_gate_override"), "the director duty does not carry it");
}

#[test]
fn a_director_answer_is_collected_whatever_the_lane_was_opened_for() {
    // The allowlist that discarded three correct recovery plans is gone, in both
    // copies -- the primary branch and the fallback, the second of which still
    // held the original two literals after the first fix. `next_actions` is a
    // required field of the director contract, so role is the only filter that
    // belongs here.
    let source = include_str!("../recovery/requery_evidence/requery_evidence_01.rs");
    assert!(
        !source.contains("LAB_DIRECTOR_ACTION_TYPES_WITH_COLLECTED_NEXT_ACTIONS"),
        "the allowlist is back",
    );
    assert!(
        !source.contains(r#"Some("lab_director_requery_followup" | "gate_restart_followup")"#),
        "the fallback branch still filters director answers by action type",
    );
}

#[test]
fn a_lane_that_is_closed_is_not_a_lane_that_is_waiting() {
    // Found by running it: the live cycle-g-v91 stall record held fifteen lanes
    // and two of them were `blocked-by-completed-gatekeeper-review` -- reviews
    // that had finished with no pending rubrics and are meant to sit in the
    // pending list forever. A cycle whose only remaining held lanes were of that
    // kind would have raised a decision request with nothing to decide.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-closed";

    let closed = DependencyBlocker::describe(
        "blocked-by-completed-gatekeeper-review pending_rubrics=0".into(),
    );
    assert!(closed.is_permanently_closed());
    let waiting = DependencyBlocker::describe(
        "waiting-for-literature-scout scout_literature_completed=0".into(),
    );
    assert!(!waiting.is_permanently_closed());

    record_dependency_stall(&paths, cycle, &[("followup-gatekeeper-06".to_string(), closed.clone())]);
    assert!(
        !dependency_stall_path(&paths, cycle).exists(),
        "a closed lane was counted as a stall",
    );

    record_dependency_stall(
        &paths,
        cycle,
        &[
            ("followup-gatekeeper-06".to_string(), closed),
            ("followup-analyst-03".to_string(), waiting),
        ],
    );
    let stall = read_json(&dependency_stall_path(&paths, cycle)).unwrap();
    let lanes = stall.get("blocked_lanes").and_then(Value::as_array).unwrap();
    assert_eq!(lanes.len(), 1, "the closed lane is not part of the stall");
    assert_eq!(
        lanes[0].get("lane_id").and_then(Value::as_str),
        Some("followup-analyst-03"),
    );
}

#[test]
fn a_blocked_base_runner_does_not_suppress_the_work_that_would_unblock_it() {
    // cycle-g-v91, measured. With the action-type allowlist gone the director's
    // recovery plan reached the planner and asked four separate times for one
    // replacement scout. No scout lane was ever opened: `lab-runner-02` sat
    // pending on `waiting-for-upstream-evidence analyst_completed=0`, which was
    // not one of the two blockers this function used to skip, so follow-up
    // dispatch was withheld for a runner that could not move -- and the scout
    // that would have ended `analyst_completed=0` was the follow-up being
    // withheld.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-base-runner";
    let lane_id = "lab-runner-02";
    let lane_dir = cycle_lanes_root(&paths, cycle).join(lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    write_json(
        &lane_dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": lane_id,
            "role": "lab-runner",
            "runtime_class": "codex",
            "mode": "execute",
            "cwd": lane_dir,
            "task_file": lane_dir.join("task.md"),
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();

    // No scout and no analyst have completed, so this runner is blocked.
    assert!(
        dependency_blocker_for_lane(
            &paths,
            cycle,
            &serde_json::from_value(read_json(&lane_dir.join("lane-contract.json")).unwrap())
                .unwrap(),
        )
        .unwrap()
        .is_some(),
        "the fixture is wrong: this runner is not blocked",
    );
    assert!(
        !pending_base_lab_runner_exists(&paths, cycle).unwrap(),
        "a blocked base runner withheld the follow-ups that would unblock it",
    );
}

#[test]
fn materialized_simulation_lead_clears_stale_override_mismatch_for_analyst() {
    // MEASURED ON cycle-a-20260919, 2026-10-10: the selected
    // 34,560-row simulation bundle existed at its declared relative path, but
    // nineteen historical override runners made artifact_exists=false and held
    // five analysts after five recovery plans had completed.
    let temp = TempDir::new().unwrap();
    let project_root = temp.path();
    let paths = AppPaths {
        project_root: project_root.to_path_buf(),
        runtime_root: project_root.join(".research-lab"),
        data_root: project_root.join("datasets"),
        stats_driver_script: PathBuf::from("/dev/null"),
        literature_driver_script: PathBuf::from("/dev/null"),
    };
    let cycle = "cycle-a-20260919";
    let relative_dataset = format!(
        ".research-lab/datasets/{cycle}/simulations/state_support_randomized_intervention_v1/episodes.csv"
    );
    let dataset_path = project_root.join(&relative_dataset);
    fs::create_dir_all(dataset_path.parent().unwrap()).unwrap();
    fs::write(&dataset_path, "eval_state_id,outcome\n1,1\n").unwrap();
    fs::create_dir_all(state_root(&paths)).unwrap();
    let hypothesis_path = state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json"));
    write_json(
        &hypothesis_path,
        &json!({
            "status": "selected",
            "validation_data_status": "materialized",
            "dataset_or_accession": relative_dataset,
            "selected_hypothesis": {
                "statement": "randomized support removal changes the policy gap",
                "primary_family": "randomized_support_removal_intervention",
                "dataset_or_accession": relative_dataset,
                "validation_data_status": "materialized"
            }
        }),
    )
    .unwrap();

    for suffix in ["212", "213"] {
        let lane_dir = lane_root(&paths, cycle, &format!("followup-runner-{suffix}"));
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("result.json"),
            &json!({
                "dataset_bundle_source": "override",
                "dataset_root": "/tmp/retired-substitute",
                "selected_hypotheses": [{
                    "hypothesis_id": "state_support_randomized_intervention_v1"
                }]
            }),
        )
        .unwrap();
    }

    write_stage_gate_lane(
        &paths,
        cycle,
        "scout-01",
        "scout",
        "literature-search-driver",
        json!({"paper_count": 2}),
    );
    let analyst_dir = lane_root(&paths, cycle, "followup-analyst-613");
    fs::create_dir_all(&analyst_dir).unwrap();
    write_json(
        &analyst_dir.join("role-plan.json"),
        &json!({"role": "analyst", "action_type": "methods_followup"}),
    )
    .unwrap();
    let contract: LaneContract = serde_json::from_value(json!({
        "cycle_id": cycle,
        "lane_id": "followup-analyst-613",
        "role": "analyst",
        "runtime_class": "codex-agent",
        "mode": "run",
        "cwd": analyst_dir,
        "task_file": analyst_dir.join("task.md"),
        "output_artifact": null,
        "fallback_strategy": null
    }))
    .unwrap();

    assert!(active_lead_dataset_materialized_on_disk(&paths, cycle));
    assert!(active_lead_dataset_override_mismatch(&paths, cycle, 2).is_none());
    assert!(super::context::lead_dataset_failclosed_signal(&paths, cycle).is_none());
    assert!(lead_unmaterialized_persisted(&paths, cycle, 1).is_none());
    assert!(lab_director_hypothesis_is_usable(
        &paths,
        cycle,
        &hypothesis_path
    ));
    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap(),
        None,
        "the materialized lead must let the requested analyst advance"
    );
}

fn write_answered_recovery_lane(paths: &AppPaths, cycle: &str, lane_id: &str, reasons: &[&str]) {
    let lane_dir = cycle_lanes_root(paths, cycle).join(lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    write_json(
        &lane_dir.join("final-status.json"),
        &json!({ "lane_id": lane_id, "status": "completed" }),
    )
    .unwrap();
    write_json(
        &lane_dir.join("role-plan.json"),
        &json!({
            "lane_id": lane_id,
            "role": "lab-director",
            "action_type": "blocking_lane_recovery_planning",
            "planner_metadata": { "blocker_reasons": reasons },
        }),
    )
    .unwrap();
}

#[test]
fn a_director_who_has_answered_is_not_asked_the_same_question_again() {
    // cycle-g-v91 opened FOURTEEN blocking_lane_recovery_planning lanes for the
    // same three failed lanes. `recovery_needed` stays true while the lanes stay
    // failed, and repairing them is precisely what the director is being asked
    // to plan, so the request re-raised every pass. Each was a full model call
    // returning the same plan -- and a critical action every round crowded the
    // dispatch batch, so the scout those plans asked for kept losing its place
    // to another request for the plan already given.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-reraise";
    write_cycle_state_with_alerts(&paths, cycle, &[("scout-02", "scout"), ("scout-03", "scout")]);

    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1, "the first request must be raised");

    write_answered_recovery_lane(
        &paths,
        cycle,
        "followup-lab-director-09",
        &[
            "scout-02 (scout) stopped on adaptive_literature_search_incomplete; it is a blocking lane.",
            "scout-03 (scout) stopped on unrecorded; it is a blocking lane.",
        ],
    );
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert!(actions.is_empty(), "the same question was asked twice");

    // A new failure is a different question, so it is asked.
    write_cycle_state_with_alerts(
        &paths,
        cycle,
        &[("scout-02", "scout"), ("scout-03", "scout"), ("analyst-01", "analyst")],
    );
    let mut actions = Vec::new();
    collect_blocking_failure_recovery_actions(&paths, cycle, &mut actions).unwrap();
    assert_eq!(actions.len(), 1, "a new blocking failure must reopen the question");
}

#[test]
fn the_director_is_given_papers_it_can_actually_cite() {
    // The trend directive requires every open_problems[] and proposed_methods[]
    // entry to carry a paper_id from the admitted corpus, and the director is
    // told not to read the graphs or the state tree but to work from the
    // digest. The digest carried eight literature EDGES and a topic-level trend
    // summary -- neither of which contains a paper id.
    //
    // So cycle-g-v91's director was required to attribute and given nothing
    // attributable. It emitted empty lists and wrote the reason into
    // survey_coverage_gaps: "no policy-compliant paper_id is therefore
    // available ... padding those arrays would fabricate evidence". The
    // contract held; the input failed it.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-citable";
    fs::create_dir_all(state_root(&paths)).unwrap();
    // An admitted paper carries no top-level paper_id. The identity the gate
    // validated is stamped at literature_screening.review.paper_id -- 41 of 41
    // admitted papers on cycle-g-v91 -- and that is the id a citation has to
    // use, or the director cites something the gate cannot recognise.
    write_json(
        &state_root(&paths).join(format!("{cycle}-literature-summary.json")),
        &json!({
            "recent_frontier_papers": [
                {
                    "title": "A recent thing", "year": 2025, "doi": null,
                    "literature_screening": { "review": { "paper_id": "url:http://example/abs/1" } },
                },
            ],
            "established_impact_papers": [
                {
                    "title": "An older thing", "year": 2018, "doi": "10.1/b",
                    "literature_screening": { "review": { "paper_id": "doi:10.1/b" } },
                },
            ],
        }),
    )
    .unwrap();

    let digest = compact_chronicle_decision_digest(&paths, cycle);
    let corpus = digest.get("citable_corpus").expect("no citable corpus in the digest");
    assert_eq!(corpus.get("admitted_paper_count").and_then(Value::as_u64), Some(2));
    // Both tracks, separately: recency says what the field is doing now, and
    // citation-backed standing is what a novelty baseline is measured against.
    for track in ["recent_frontier_papers", "established_impact_papers"] {
        let papers = corpus.get(track).and_then(Value::as_array).unwrap_or_else(|| panic!("{track} missing"));
        assert_eq!(papers.len(), 1, "{track}");
        let cited = papers[0].get("paper_id").and_then(Value::as_str);
        assert!(cited.is_some(), "{track} carries no id");
        // The gate's own id, not a second implementation of the identity rule.
        assert!(
            cited.unwrap().starts_with("url:") || cited.unwrap().starts_with("doi:"),
            "{track} cites {cited:?}, which is not the id the screening gate validated",
        );
    }
}

#[test]
fn a_selected_hypothesis_sends_a_scout_after_its_own_prior_art() {
    // Once a hypothesis was chosen, nobody went back to the literature for it.
    // The selected branch dispatched a lab-runner to execute the claim and an
    // analyst to design tests for it -- both about whether it is TRUE. Nothing
    // asked whether it is NEW. The open branch does search, but it runs only
    // while no hypothesis has been selected, so its query is the whole prior-art
    // landscape rather than this claim's.
    //
    // MEASURED ON cycle-g-v91: the two novelty_followup lanes were
    // followup-analyst-01 and followup-runner-01. No scout -- for a programme
    // whose binding rubric is novelty.
    let source = include_str!("../followups/dispatch_novelty.rs");
    let selected_branch = source
        .split("pub(crate) fn dispatch_selected_novelty_followups")
        .nth(1)
        .expect("the selected-hypothesis branch is gone");
    assert!(
        selected_branch.contains("\"prior-art-for-selected-hypothesis\""),
        "a selected hypothesis still opens no scout for its own prior art",
    );
    // The hypothesis has to travel with it, or the scout searches the objective
    // again and returns the crowded centre a second time.
    let scout_block = selected_branch
        .split("novelty_mode\": \"prior-art-for-selected-hypothesis")
        .next()
        .unwrap();
    assert!(
        scout_block.contains("&scout_description,\n            assigned_selected_hypotheses,"),
        "the scout task body does not carry the selected hypothesis",
    );
    // Prior art first: this action exists to move novelty, and when slots are
    // scarce the prior art is what moves it.
    let scout_at = selected_branch.find("\"scout\",").expect("no scout role in the branch");
    let runner_at = selected_branch
        .find("\"lab-runner\",")
        .expect("no lab-runner role in the branch");
    assert!(
        scout_at < runner_at,
        "the validation lane is dispatched before the prior-art lane",
    );
}

#[test]
fn a_novelty_action_opens_a_runner_only_for_a_handoff_waiting_for_one() {
    // A lab-runner executes an analyst handoff and nothing else. MEASURED ON
    // cycle-a-20260919, 2026-09-28/29: the plan held 84
    // novelty_followup actions and this branch opened a runner for each one it
    // reached; with no new handoff, every runner re-executed
    // followup-analyst-192's, which failed before inference each time -- 25 of
    // 37 runners in ten hours, the last eight back to back.
    let source = include_str!("../followups/dispatch_novelty.rs");
    let selected_branch = source
        .split("pub(crate) fn dispatch_selected_novelty_followups")
        .nth(1)
        .expect("the selected-hypothesis branch is gone");
    let runner_at = selected_branch
        .find("\"lab-runner\",")
        .expect("no lab-runner role in the branch");
    let runner_guard = &selected_branch[..runner_at];
    let guard_at = runner_guard
        .rfind("if created.len() < max_new_lanes")
        .expect("the runner block lost its guard");
    assert!(
        runner_guard[guard_at..].contains("latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)?"),
        "a novelty action opens a lab-runner with no handoff waiting for one",
    );
}

#[test]
fn the_corpus_is_carried_whether_or_not_chronicle_has_written_a_digest_file() {
    // The first version of this attached the corpus only where the digest FILE
    // is absent -- the branch that stops running the moment the file exists.
    // Chronicle wrote the file at 07:57 on cycle-g-v91 and the next director
    // role plan, at 08:10, carried a digest with no citable_corpus at all.
    // Primary map plus fallback, and the live path was the other one.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-digest-both";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-literature-summary.json")),
        &json!({
            "recent_frontier_papers": [{
                "title": "A recent thing", "year": 2025,
                "literature_screening": { "review": { "paper_id": "url:http://example/abs/1" } },
            }],
            "established_impact_papers": [],
        }),
    )
    .unwrap();

    // Branch one: no digest file yet.
    let without_file = compact_chronicle_decision_digest(&paths, cycle);
    assert!(
        without_file.get("citable_corpus").is_some(),
        "no corpus when the digest file is absent",
    );

    // Branch two: chronicle has written one. This is the live case.
    write_json(
        &state_root(&paths).join(format!("{cycle}-chronicle-decision-digest.json")),
        &json!({ "format": "chronicle_decision_digest", "generated_by": "chronicle" }),
    )
    .unwrap();
    let with_file = compact_chronicle_decision_digest(&paths, cycle);
    let corpus = with_file
        .get("citable_corpus")
        .expect("no corpus once chronicle has written a digest -- the live path");
    assert_eq!(corpus.get("admitted_paper_count").and_then(Value::as_u64), Some(1));
    assert_eq!(
        corpus
            .get("recent_frontier_papers")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|paper| paper.get("paper_id"))
            .and_then(Value::as_str),
        Some("url:http://example/abs/1"),
    );
}

#[test]
fn a_waiting_director_lane_gets_the_evidence_that_exists_now() {
    // Both writers of `chronicle_decision_digest` set it only when absent, so the
    // digest was computed once at lane creation and carried forward however long
    // the lane waited. The launch refresh updated research notes, runner context
    // and dataset bundles -- and not the digest, which is the one input every
    // director prompt names as the thing to decide from.
    //
    // cycle-g-v91: followup-lab-director-17 was created at 08:10 when the corpus
    // could not be cited, the corpus became citable at 08:36, its plan was
    // rewritten at 08:38, and it still carried the 08:10 digest.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-stale-digest";
    fs::create_dir_all(state_root(&paths)).unwrap();

    let lane_id = "followup-lab-director-17";
    let lane_dir = cycle_lanes_root(&paths, cycle).join(lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    // A plan queued before any corpus existed.
    write_json(
        &lane_role_plan_path(&paths, cycle, lane_id),
        &json!({
            "lane_id": lane_id,
            "role": "lab-director",
            "action_type": "hypothesis_generation",
            "planner_metadata": {
                "chronicle_decision_digest": { "format": "stale", "citable_corpus": null },
            },
        }),
    )
    .unwrap();
    let contract_value = json!({
        "cycle_id": cycle,
        "lane_id": lane_id,
        "role": "lab-director",
        "runtime_class": "codex-agent",
        "mode": "read-write-scoped",
        "cwd": lane_dir,
        "task_file": lane_dir.join("task.md"),
        "output_artifact": null,
        "fallback_strategy": null,
    });
    write_json(&lane_dir.join("lane-contract.json"), &contract_value).unwrap();
    let contract: LaneContract = serde_json::from_value(contract_value).unwrap();

    // Evidence arrives after the lane was queued.
    write_json(
        &state_root(&paths).join(format!("{cycle}-literature-summary.json")),
        &json!({
            "recent_frontier_papers": [{
                "title": "A paper admitted after the lane was queued", "year": 2025,
                "literature_screening": { "review": { "paper_id": "doi:10.1/late" } },
            }],
            "established_impact_papers": [],
        }),
    )
    .unwrap();

    refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();

    let refreshed = read_json(&lane_role_plan_path(&paths, cycle, lane_id)).unwrap();
    let corpus = refreshed
        .pointer("/planner_metadata/chronicle_decision_digest/citable_corpus")
        .expect("the launch refresh kept the digest the lane was queued with");
    assert_eq!(corpus.get("admitted_paper_count").and_then(Value::as_u64), Some(1));
    assert_eq!(
        corpus
            .pointer("/recent_frontier_papers/0/paper_id")
            .and_then(Value::as_str),
        Some("doi:10.1/late"),
    );
}

// The owner of a blocker must be someone who can clear it.
//
// MEASURED ON cycle-g-v91, 2026-09-14. Ten gatekeepers sat on
// `waiting-for-latest-analyst-handoff-runner` for four hours with the owner
// recorded as `analyst`. That blocker fires when no completed lab-runner is
// gate-ready AND no runner context matches the latest executable handoff -- the
// handoff already exists, so the analyst has nothing left to do. Once the
// dispatch order began promoting the awaited role, the mis-assignment promoted
// analysts, who answered by emitting NEWER handoffs, moving the `latest` the
// blocker names and resetting the wait each time.
#[test]
fn the_awaited_role_is_the_one_that_can_clear_it() {
    let blocker = DependencyBlocker::describe(
        "waiting-for-latest-analyst-handoff-runner analyst_handoff_path=/x/handoff.json".to_string(),
    );
    assert_eq!(
        blocker.awaited_role.as_deref(),
        Some("lab-runner"),
        "the analyst has already emitted the handoff and cannot clear this",
    );
    assert!(
        blocker.clears_when.contains("executes"),
        "clears_when must say what has to HAPPEN: {}",
        blocker.clears_when,
    );
}

#[test]
fn the_blockers_an_analyst_really_owns_are_untouched() {
    // Longest-prefix matching means one entry can shadow another; these three
    // sit next to the corrected one and are genuinely the analyst's.
    for reason in [
        "waiting-for-analyst-handoff",
        "waiting-for-analyst-handoff-reroute",
        "waiting-for-rival-analyst-handoffs",
    ] {
        assert_eq!(
            DependencyBlocker::describe(reason.to_string()).awaited_role.as_deref(),
            Some("analyst"),
            "{reason} lost its owner",
        );
    }
}
