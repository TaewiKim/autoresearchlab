// MEASURED ON cycle-a-20260919, 2026-11-10: directors 1913 and 1914 each
// asked for one bounded scout audit of the successor they were weighing. The lead
// was withdrawn, there was no lead statement to take from the artifact, and the
// converging branch returned having dispatched nothing -- the audit was "already
// authorized" in each next director's notes and never ran.
#[test]
fn a_directors_bounded_novelty_audit_runs_without_a_lead() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "directed-novelty";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({"status": "withdrawn", "requery_decision": "restart", "selected_hypothesis": null}),
    )
    .unwrap();

    let counts: HashMap<String, usize> = HashMap::new();
    let budget: HashMap<&'static str, usize> = HashMap::new();
    let availability = FollowupRoleAvailabilityContext {
        external_validation_required: false,
        gate_independence_required: false,
        data_acquisition_query_blocked: false,
        has_pending_data_acquisition_action: false,
        existing_followup_counts: &counts,
        existing_action_counts: &counts,
        open_action_counts: &counts,
        existing_total_followups: 0,
        total_followup_cap: 1000,
        pass_budget_by_role: &budget,
        document_stage_authorized: false,
        latest_handoff_served: None,
    };
    let (quality, graph, data) = (json!({}), json!({}), json!({}));
    let ctx = DispatchPlanContext {
        objective: "Does demonstration coverage explain architecture gains?",
        convergence_mode: "converge",
        candidate_hypotheses: &[],
        schema_quality: &quality,
        reasoning_graph: &graph,
        data_graph: &data,
        open_validation_gaps: &[],
    };
    let instruction = "Audit the explicit allocation procedure in this lane's successor-admission-plan.json. Use one OpenAlex-only lookup, reviewing at most eight abstracts, and return a terminal disposition.";
    let from_director = json!({
        "type": "novelty_followup",
        "preferred_role": "scout",
        "description": instruction,
        "source_lab_director_lane_id": "followup-lab-director-1913",
    });
    let run = |action: &Value| {
        let mut created = Vec::new();
        let mut signatures = HashSet::new();
        let mut by_role = HashMap::new();
        let mut by_action = HashMap::new();
        dispatch_novelty_followups(
            &paths, cycle, 4, &ctx, &availability, &counts, action, "novelty_followup",
            "labdirector-next-action-followup-lab-director-1913", instruction, "", true,
            &[], &[], &[], &mut created, &mut signatures, &mut by_role, &mut by_action,
        )
        .unwrap();
        created
    };

    let created = run(&from_director);
    assert_eq!(created.len(), 1, "{created:?}");
    let lane_id = created[0]["lane_id"].as_str().unwrap();
    assert_eq!(created[0]["role"], json!("scout"));
    let task = fs::read_to_string(lane_root(&paths, cycle, lane_id).join("task.md")).unwrap();
    assert!(task.contains("at most eight abstracts"), "the director's own instruction is the task: {task}");
    assert!(!task.contains("Search BROADLY"), "a bounded audit is not widened: {task}");
    let plan = read_json(&lane_role_plan_path(&paths, cycle, lane_id)).unwrap();
    assert_eq!(plan["planner_metadata"]["novelty_mode"], json!("director-directed-audit"));

    // An action no director wrote, with no lead to audit, still dispatches nothing
    // while converging: the fix does not widen what the cycle explores.
    let anonymous = json!({"type": "novelty_followup", "preferred_role": "scout", "description": instruction});
    assert!(run(&anonymous).is_empty());
}
