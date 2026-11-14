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
        // The plan ranks a data acquisition and no data scout has ever existed:
        // the state that refused the director's audit on every pass.
        has_pending_data_acquisition_action: true,
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

// MEASURED ON cycle-a-20260919, 2026-11-10: eight directors in fifty
// minutes, each `restart` with nothing to dispatch, each queued by the plan's
// re-queued requery.
#[test]
fn a_director_that_restarted_with_nothing_to_do_holds_off_the_next_for_a_while() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "idle-director";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    let lane = "followup-lab-director-9";
    let dir = lane_root(&paths, cycle, lane);
    fs::create_dir_all(&dir).unwrap();
    write_json(&dir.join("lane-contract.json"), &json!({
        "cycle_id": cycle, "lane_id": lane, "role": "lab-director", "runtime_class": "codex-agent",
        "mode": "read-write-scoped", "cwd": paths.project_root, "task_file": dir.join("task.md"),
        "allowed_inputs": [], "allowed_outputs": [], "output_artifact": null, "fallback_strategy": null,
    })).unwrap();
    write_json(&dir.join("role-plan.json"), &json!({
        "lane_id": lane, "role": "lab-director", "action_type": "lab_director_requery_followup",
    })).unwrap();
    let write_result = |decision: &str, next_actions: Value| {
        write_json(&dir.join("result.json"), &json!({"extracted_json": {
            "requery_decision": decision, "decision_status": "final",
            "next_actions": next_actions, "replacement_hypotheses": [],
        }})).unwrap();
    };
    let finished = |minutes_ago: i64| {
        write_json(&dir.join("final-status.json"), &json!({
            "status": "completed",
            "completed_at": (Utc::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339(),
        })).unwrap();
    };

    write_result("restart", json!([]));
    finished(5);
    assert!(director_requery_would_repeat_idle_restart(&paths, cycle).unwrap(), "just said nothing to do");
    finished(90);
    assert!(!director_requery_would_repeat_idle_restart(&paths, cycle).unwrap(), "the cooldown has passed");
    // A director that asked for work, or chose a different outcome, is not idle.
    finished(5);
    write_result("restart", json!([{"type": "novelty_followup", "preferred_role": "scout", "description": "x"}]));
    assert!(!director_requery_would_repeat_idle_restart(&paths, cycle).unwrap());
    write_result("defer_for_chronicle", json!([]));
    assert!(!director_requery_would_repeat_idle_restart(&paths, cycle).unwrap());
}

// MEASURED ON cycle-a-20260919, 2026-11-10: director 1913 ordered a scout
// audit, 1914 was opened for something else and listed nothing, and the audit was
// never dispatched. An order stands until a lane carries it out.
#[test]
fn an_earlier_directors_order_is_still_dispatched_after_a_later_director_says_nothing() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "standing-orders";
    fs::create_dir_all(state_root(&paths)).unwrap();
    fs::create_dir_all(plans_root(&paths)).unwrap();
    let lane = |lane_id: &str, role: &str, action_type: &str, brief: &str, minutes_ago: i64, result: Value| {
        let dir = lane_root(&paths, cycle, lane_id);
        fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join("lane-contract.json"), &json!({
            "cycle_id": cycle, "lane_id": lane_id, "role": role, "runtime_class": "codex-agent",
            "mode": "read-write-scoped", "cwd": paths.project_root, "task_file": dir.join("task.md"),
            "allowed_inputs": [], "allowed_outputs": [], "output_artifact": null, "fallback_strategy": null,
        })).unwrap();
        write_json(&dir.join("role-plan.json"), &json!({
            "lane_id": lane_id, "role": role, "action_type": action_type, "source_brief_id": brief,
        })).unwrap();
        write_json(&dir.join("result.json"), &result).unwrap();
        write_json(&dir.join("final-status.json"), &json!({
            "status": "completed",
            "completed_at": (Utc::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339(),
        })).unwrap();
    };
    let decision = |next_actions: Value| json!({"extracted_json": {
        "requery_decision": "restart", "decision_status": "final", "rationale": "r",
        "next_actions": next_actions, "replacement_hypotheses": [],
    }});
    let queued = || {
        let mut ranked = Vec::new();
        append_completed_labdirector_next_actions(&paths, cycle, &mut ranked).unwrap();
        ranked
            .iter()
            .map(|action| format!(
                "{}:{}:{}",
                action["source_lab_director_lane_id"].as_str().unwrap_or(""),
                action["preferred_role"].as_str().unwrap_or(""),
                action["brief_id"].as_str().unwrap_or(""),
            ))
            .collect::<Vec<_>>()
    };

    lane("followup-lab-director-1", "lab-director", "lab_director_requery_followup", "gate-review", 30, decision(json!([
        {"type": "novelty_followup", "preferred_role": "scout", "description": "audit the allocation procedure, eight abstracts"},
        {"type": "capability_provisioning_followup", "preferred_role": "engineer", "description": "install gym_pusht and prove one episode steps"},
    ])));
    let plan = vec![
        "followup-lab-director-1:scout:labdirector-next-action-followup-lab-director-1".to_string(),
        "followup-lab-director-1:engineer:labdirector-next-action-followup-lab-director-1".to_string(),
    ];
    assert_eq!(queued(), plan);

    // A later director, opened for something else, lists nothing.
    lane("followup-lab-director-2", "lab-director", "lab_director_requery_followup", "gate-review", 10, decision(json!([])));
    assert_eq!(queued(), plan, "the plan survives a director that does not mention it");
    assert!(work_orders_in_flight(&paths, cycle));

    // The scout carries its order out; the engineer's still stands.
    lane("followup-scout-1", "scout", "novelty_followup", "labdirector-next-action-followup-lab-director-1", 5, json!({}));
    assert_eq!(queued(), plan[1..].to_vec());
    // Whichever role took the engineer's order, it is carried out.
    lane("followup-analyst-1", "analyst", "capability_provisioning_followup", "labdirector-next-action-followup-lab-director-1", 1, json!({}));
    assert!(queued().is_empty());
    assert!(!work_orders_in_flight(&paths, cycle));
}

#[test]
fn ledger_identity_replaces_plan_summaries_for_every_dispatchable_order() {
    // MEASURED ON cycle-a-20260919, 2026-11-11: plan text deduplication
    // discarded the Director's order identity. Exercise the shared boundary for
    // every allowed role/action, including method routing and cancellation.
    for (role, action_type) in [
        ("analyst", "methods_followup"), ("lab-runner", "methods_followup"),
        ("chronicle", "chronicle_evidence_request_followup"),
        ("scout", "data_acquisition_followup"), ("scout", "novelty_followup"),
        ("gatekeeper", "novelty_followup"), ("gatekeeper", "gate_restart_followup"),
        ("analyst", "impact_followup"), ("engineer", "capability_provisioning_followup"),
    ] {
        let tmp = TempDir::new().unwrap();
        let paths = build_paths(tmp.path());
        let cycle = "canonical-orders";
        let director = "followup-lab-director-1";
        let lane = lane_root(&paths, cycle, director);
        write_codex_contract(&paths.runtime_root, cycle, director);
        write_json(&lane.join("role-plan.json"), &json!({"role": "lab-director", "action_type": "lab_director_requery_followup"})).unwrap();
        write_json(&lane.join("final-status.json"), &json!({"status": "completed", "completed_at": now_iso()})).unwrap();
        write_json(&lane.join("result.json"), &json!({"extracted_json": {
            "requery_decision": "restart", "decision_status": "final",
            "next_actions": [{"type": action_type, "preferred_role": role, "description": "carry out the bounded order"}]
        }})).unwrap();
        let summary = json!({"brief_id": director, "type": action_type,
            "preferred_role": role, "description": "carry out the bounded order"});
        let mut actions = vec![summary.clone()];
        append_completed_labdirector_next_actions(&paths, cycle, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{role}/{action_type}: {actions:?}");
        let canonical = actions[0].clone();
        assert_eq!(canonical["source_lab_director_lane_id"], director);
        assert_eq!(canonical["brief_id"], format!("labdirector-next-action-{director}"));
        if role == "analyst" && action_type == "methods_followup" {
            assert_eq!(canonical["type"], "labdirector_comparator_validation_followup");
            assert!(canonical["analysis_request"].is_object());
        }
        // A duplicate from another reader must not discard identity either.
        let mut other_summary = canonical.clone();
        other_summary["brief_id"] = json!("review-summary");
        other_summary.as_object_mut().unwrap().remove("source_lab_director_lane_id");
        other_summary.as_object_mut().unwrap().remove("work_order_id");
        let mut actions = vec![other_summary.clone(), other_summary];
        append_completed_labdirector_next_actions(&paths, cycle, &mut actions).unwrap();
        assert_eq!(actions, vec![canonical.clone()]);

        let mut ledger = read_json(&crate::labdirector::work_orders::work_orders_path(&paths, cycle)).unwrap();
        ledger["orders"][0]["status"] = json!("cancelled");
        write_json(&crate::labdirector::work_orders::work_orders_path(&paths, cycle), &ledger).unwrap();
        let mut actions = vec![summary];
        append_completed_labdirector_next_actions(&paths, cycle, &mut actions).unwrap();
        assert!(actions.is_empty(), "a cancelled order cannot be revived by a plan summary");
    }
}

// The analyst that prepared the reproduction declared three capabilities as the
// engineer's to provision and nothing opened an engineer.
#[test]
fn an_analyst_handoffs_unmet_capabilities_become_one_engineer_order() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "capability-route";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let analyst = "followup-analyst-7";
    let dir = lane_root(&paths, cycle, analyst);
    fs::create_dir_all(&dir).unwrap();
    write_json(&dir.join("analyst-handoff.json"), &json!({"capability_requirements": [
        {"capability_id": "CAP-OFFLINE-PUSHT-RUNTIME", "owner_role": "engineer", "status": "missing_dependencies", "tool": "gym_pusht + diffusers + pymunk"},
        {"capability_id": "CAP-TORCH", "owner_role": "engineer", "status": "available", "tool": "torch"},
    ]})).unwrap();
    write_json(&dir.join("role-plan.json"), &json!({"lane_id": analyst, "role": "analyst", "action_type": "methods_followup"})).unwrap();
    write_json(&dir.join("final-status.json"), &json!({"status": "completed", "completed_at": now_iso()})).unwrap();
    let ledger = crate::labdirector::work_orders::refresh_work_orders(&paths, cycle).unwrap();
    let orders = ledger["orders"].as_array().unwrap();
    assert_eq!(orders.len(), 1, "{orders:?}");
    assert_eq!(orders[0]["role"], json!("engineer"));
    assert!(orders[0]["description"].as_str().unwrap().contains("CAP-OFFLINE-PUSHT-RUNTIME"));
    assert!(!orders[0]["description"].as_str().unwrap().contains("CAP-TORCH"));
    let mut ranked = Vec::new();
    append_capability_provisioning_actions(&paths, cycle, &mut ranked);
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0]["preferred_role"], json!("engineer"));
    assert!(ranked[0]["description"].as_str().unwrap().contains("CAP-OFFLINE-PUSHT-RUNTIME"));
    assert_eq!(ranked[0]["brief_id"], json!(format!("capability-requirements-{analyst}")));
}


// MEASURED ON cycle-a-20260919, 2026-11-12: scout 750 refused a bounded
// order it could have carried out, and director 1948 closed the inquiry on it.
#[test]
fn every_order_carries_its_limits_as_bounds_and_the_director_is_told_how_to_write_one() {
    let scout = followup_task_markdown("c", "o", "scout", "b", "audit RE4 citation neighbours", &[]);
    assert!(scout.contains("order_limits_contract"), "{scout}");
    assert!(scout.contains("--max-requests"), "the scout is told the bounded probe exists");
    assert!(scout.contains("proposed_order_change"));
    assert!(!scout.contains("order_writing_contract"));
    let engineer = followup_task_markdown("c", "o", "engineer", "b", "repair the loader", &[]);
    assert!(engineer.contains("order_limits_contract"));
    let director = followup_task_markdown("c", "o", "lab-director", "b", "decide", &[]);
    assert!(director.contains("order_writing_contract"), "{director}");
    assert!(!director.contains("order_limits_contract"));
}
