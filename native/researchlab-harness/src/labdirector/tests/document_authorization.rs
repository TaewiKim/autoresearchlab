// The document stage has a door. It is not a rewrite of the gate's verdict.
//
// cycle-g-v89 produced technical_quality 98, reproducibility 86 and clarity 91
// against novelty 64 and impact 62 -- 100 runner lanes, 93 of them clean, 27
// distinct methods against ONE research question, every one failing the same
// preregistered false-safe bound of 0.10. Real work, an honest reject, and the
// author and illustrator lanes held behind `gate_passed=false`.
//
// Writing gate_passed: true would have been one line and would have asserted
// something false about prior art. cycle-g-v62 is the recorded cost of that
// shortcut: score 98 and approval-ready on all-null evidence.

fn write_gate_review(paths: &AppPaths, cycle: &str, passed: bool) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "gate_passed": passed,
            "rubric": [
                {"name": "novelty", "score": 64},
                {"name": "technical_quality", "score": 98},
                {"name": "reproducibility", "score": 86},
            ]
        }),
    )
    .unwrap();
}

fn write_authorization(paths: &AppPaths, cycle: &str, body: Value) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-document-authorization.json")),
        &body,
    )
    .unwrap();
}

fn document_lane(paths: &AppPaths, cycle: &str, lane_id: &str, role: &str) -> LaneContract {
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
fn an_authorized_cycle_releases_the_author_without_passing_the_gate() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-authorized";
    write_gate_review(&paths, cycle, false);
    write_authorization(
        &paths,
        cycle,
        json!({
            "authorized": true,
            "reason": "owner: document the negative result; 27 methods, one question",
            "rubric_at_authorization": {"novelty": 64, "technical_quality": 98},
        }),
    );

    let contract = document_lane(&paths, cycle, "author-01", "author");
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert_ne!(
        blocker.as_deref(),
        Some("waiting-for-hypothesis-gate gate_passed=false"),
        "an authorised cycle must reach the document stage"
    );

    // And the verdict itself is untouched: everything else still reads a reject.
    assert!(
        !hypothesis_gate_passed(&paths, cycle).unwrap(),
        "the authorisation must not make the gate claim it passed"
    );
}

#[test]
fn without_an_authorization_the_author_still_waits() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-unauthorized";
    write_gate_review(&paths, cycle, false);

    let contract = document_lane(&paths, cycle, "author-01", "author");
    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap().as_deref(),
        Some("waiting-for-hypothesis-gate gate_passed=false"),
    );
}

#[test]
fn an_authorization_without_a_reason_is_not_one() {
    // An authorisation nobody can account for later is a silently loosened gate.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-no-reason";
    write_gate_review(&paths, cycle, false);

    for body in [
        json!({ "authorized": true }),
        json!({ "authorized": true, "reason": "" }),
        json!({ "authorized": true, "reason": "   " }),
        json!({ "authorized": false, "reason": "changed my mind" }),
        json!({ "reason": "no flag at all" }),
    ] {
        write_authorization(&paths, cycle, body.clone());
        assert!(
            !document_stage_authorized(&paths, cycle),
            "must not authorise on {body}"
        );
        let contract = document_lane(&paths, cycle, "author-01", "author");
        assert_eq!(
            dependency_blocker_for_lane(&paths, cycle, &contract).unwrap().as_deref(),
            Some("waiting-for-hypothesis-gate gate_passed=false"),
            "the lane must stay held for {body}"
        );
    }
}

#[test]
fn the_door_opens_only_for_the_document_roles() {
    // It is a door for the write-up, not a general gate release. A gatekeeper or
    // analyst must not inherit it.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-scope";
    write_gate_review(&paths, cycle, false);
    write_authorization(
        &paths,
        cycle,
        json!({ "authorized": true, "reason": "owner: document the negative result" }),
    );

    assert!(document_stage_authorized(&paths, cycle));
    for role in ["author", "illustrator"] {
        let contract = document_lane(&paths, cycle, "lane-01", role);
        let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
        assert_ne!(
            blocker.as_deref(),
            Some("waiting-for-hypothesis-gate gate_passed=false"),
            "{role} should be released"
        );
    }
    // hypothesis_gate_passed is what every other consumer reads, and it is false.
    assert!(!hypothesis_gate_passed(&paths, cycle).unwrap());
}

#[test]
fn the_authorization_clears_the_strategy_hold_too() {
    // The first version cleared only the hypothesis-gate hold, and cycle-g-v89's
    // author lane stayed pending on `waiting-for-hypothesis-strategy`: its
    // conclusion review carried lab_director_requery_followup and
    // hypothesis_regeneration_followup among eleven follow-ups, which is exactly
    // what conclusion_needs_hypothesis_strategy looks for.
    //
    // That recommendation is advice on how to pass the gate. It is not a reason
    // to refuse to record a result that already exists.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-strategy-hold";
    write_gate_review(&paths, cycle, false);
    write_json(
        &state_root(&paths).join(format!("{cycle}-conclusion-review.json")),
        &json!({
            "conclusion_gate_passed": false,
            "recommended_followup_actions": [
                {"type": "lab_director_requery_followup", "preferred_role": "lab-director"},
                {"type": "hypothesis_regeneration_followup"}
            ]
        }),
    )
    .unwrap();

    // Without the authorisation the strategy hold stands.
    let contract = document_lane(&paths, cycle, "author-01", "author");
    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap().as_deref(),
        Some("waiting-for-hypothesis-strategy conclusion_requires_lab_director_requery=true"),
    );

    write_authorization(
        &paths,
        cycle,
        json!({ "authorized": true, "reason": "owner: document the cycle at its true scores" }),
    );
    let blocker = dependency_blocker_for_lane(&paths, cycle, &contract).unwrap();
    assert!(
        !blocker.as_deref().unwrap_or("").starts_with("waiting-for-hypothesis-strategy"),
        "the authorisation must clear BOTH document holds, got {blocker:?}"
    );
    assert!(
        !blocker.as_deref().unwrap_or("").starts_with("waiting-for-hypothesis-gate"),
        "and the second one as well, got {blocker:?}"
    );
}

#[test]
fn an_authorized_cycle_with_no_runs_is_still_held() {
    // The one document hold the authorisation deliberately does NOT clear: with
    // no execution there is nothing to write about. v89 has 103 completed runner
    // lanes, so this never applied there, but the exemption must not widen to it.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cycle-authorized-no-runs";
    write_gate_review(&paths, cycle, false);
    write_authorization(
        &paths,
        cycle,
        json!({ "authorized": true, "reason": "owner: document the cycle" }),
    );

    let contract = document_lane(&paths, cycle, "author-01", "author");
    assert_eq!(
        dependency_blocker_for_lane(&paths, cycle, &contract).unwrap().as_deref(),
        Some("waiting-for-core-experiments lab_runner_completed=0"),
        "an authorisation is not a licence to write about nothing"
    );
}

#[test]
fn an_authorized_document_lane_sorts_to_the_front() {
    // cycle-g-v89 reached the budget wall with author-01 still pending. It was
    // never blocked -- it was outranked. author is role_rank 7, the cycle created
    // 172 analyst follow-ups, and with max-concurrency 3 the slots ahead of it
    // were refilled faster than they drained.
    //
    // An owner authorization is an explicit human decision and outranks a queue
    // built from the cycle's own heuristics. Without one, nothing changes.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let author = document_lane(&paths, "cycle-rank", "author-01", "author");
    let illustrator = document_lane(&paths, "cycle-rank", "illustrator-01", "illustrator");
    let analyst = document_lane(&paths, "cycle-rank", "followup-analyst-172", "analyst");

    // Unauthorized: the existing order stands. A BASE lane already outranks every
    // `followup-*` on phase_rank -- my first reading of this was wrong, and the
    // assertion below is what corrected it. author sorts last only among the
    // eight base roles.
    let a = lane_priority_rank_with_authorization(&author, false);
    let n = lane_priority_rank_with_authorization(&analyst, false);
    assert!(a < n, "a base author lane already outranks a follow-up analyst lane");
    assert_eq!(lane_priority_rank(&author), a, "the wrapper keeps the old behaviour");
    let base_analyst = document_lane(&paths, "cycle-rank", "analyst-01", "analyst");
    assert!(
        lane_priority_rank(&base_analyst) < a,
        "among base lanes analyst does outrank author"
    );

    // Authorized: both document roles sort ahead of everything else.
    let a = lane_priority_rank_with_authorization(&author, true);
    let i = lane_priority_rank_with_authorization(&illustrator, true);
    let n = lane_priority_rank_with_authorization(&analyst, true);
    assert!(a < n, "an authorized author must outrank the analyst queue");
    assert!(i < n, "and so must the illustrator");
    assert_eq!(a.0, 0, "phase 0: ahead of recovery too");
    assert_eq!(a.1, 0, "role 0: ahead of scout");
}

#[test]
fn the_authorization_does_not_reorder_anyone_else() {
    // The flag must not become a general reshuffle: only the two document roles
    // move, and every other lane keeps the rank it had.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    for (lane_id, role) in [
        ("scout-01", "scout"),
        ("followup-analyst-01", "analyst"),
        ("lab-runner-01", "lab-runner"),
        ("followup-gatekeeper-01", "gatekeeper"),
        ("followup-lab-director-01", "lab-director"),
    ] {
        let contract = document_lane(&paths, "cycle-rank", lane_id, role);
        assert_eq!(
            lane_priority_rank_with_authorization(&contract, true),
            lane_priority_rank_with_authorization(&contract, false),
            "{role} must be unaffected by a document authorization"
        );
    }
}
