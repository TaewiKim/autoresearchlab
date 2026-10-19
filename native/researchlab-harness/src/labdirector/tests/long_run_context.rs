#[test]
fn materialize_long_run_plan_uses_external_agent_plan_prompt_as_objective() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let plan_dir = plans_root(&paths);
    fs::create_dir_all(&plan_dir).unwrap();
    let agent_plan_path = plan_dir.join("cycle-agent-plan.json");
    let objective = "Run a long-running omics data-analysis research cycle.";
    write_json(
        &agent_plan_path,
        &json!({
            "prompt": objective,
            "agents": [],
        }),
    )
    .unwrap();

    materialize_long_run_plan_with_objective(
        &paths,
        "cycle-agent-plan",
        None,
        Some(&agent_plan_path),
    )
    .unwrap();

    let prompt_txt = fs::read_to_string(plan_dir.join("cycle-agent-plan-prompt.txt")).unwrap();
    assert_eq!(prompt_txt, objective);
    let cycle_plan = read_json(&plan_dir.join("cycle-agent-plan-cycle-plan.json")).unwrap();
    assert_eq!(cycle_plan["objective"].as_str(), Some(objective));
}

#[test]
fn lab_director_existing_research_notes_context_is_compact() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-compact-notes";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    write_json(
            &state_dir.join(format!("{cycle}-lab-director-research-notes.json")),
            &json!({
                "updated_at": "2026-05-15T00:00:00Z",
                "generated_by": "test",
                "current_lead_hypothesis": {
                    "statement": "Lead claim",
                    "materialized_dataset": {"bundle_path": "/tmp/bundle"}
                },
                "latest_lab_director_decision": {
                    "lane_id": "followup-lab-director-01",
                    "requery_decision": "replace",
                    "rationale": "x".repeat(10_000),
                    "next_actions": (0..12).map(|idx| json!({"description": format!("action {idx}")})).collect::<Vec<_>>()
                },
                "open_blockers": (0..20).map(|idx| json!(format!("blocker {idx}"))).collect::<Vec<_>>(),
                "resolved_or_superseded_blockers": (0..14).map(|idx| json!(format!("old blocker {idx}"))).collect::<Vec<_>>(),
                "communication_quality": {"stale_blocker_count": 6},
                "next_actions": (0..12).map(|idx| json!(format!("next {idx}"))).collect::<Vec<_>>(),
                "decision_log": "y".repeat(200_000)
            }),
        )
        .unwrap();

    let context = lab_director_existing_research_notes_context(&paths, cycle)
        .unwrap()
        .expect("notes context");

    assert_eq!(context["format"].as_str(), Some("json_compact"));
    assert!(context.get("content").is_none());
    assert_eq!(context["active_blockers"].as_array().map(Vec::len), Some(8));
    assert_eq!(
        context["resolved_or_superseded_summary"]["count"].as_u64(),
        Some(14)
    );
    assert!(
        json_approx_bytes(&context) < 20_000,
        "compact context should stay small"
    );
}

#[test]
fn lab_director_context_controls_add_trace_and_budget_policy() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-context-trace";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    let memory_dir = paths.runtime_root.join("memory").join(cycle);
    fs::create_dir_all(&memory_dir).unwrap();
    fs::write(
        memory_dir.join("memory_summary.md"),
        "# ResearchLab Memory Summary\n\n- read_policy: read this summary first\n",
    )
    .unwrap();
    fs::write(
        memory_dir.join("MEMORY.md"),
        "# ResearchLab Memory\n\n## Durable Role Boundaries\n",
    )
    .unwrap();
    // The bus writes <role>.jsonl at the bus root; there is no mailbox
    // subdirectory any more, and the shape is the bus's.
    let mailbox_dir = paths
        .runtime_root
        .join("messages")
        .join(cycle)
        .join("");
    fs::create_dir_all(&mailbox_dir).unwrap();
    let first_message = serde_json::to_string(&json!({
        "message_id": "supervisor->lab-director:focus#director-focus",
        "channel": "supervisor->lab-director:focus",
        "cycle_id": cycle,
        "from_role": "supervisor",
        "to_roles": ["lab-director"],
        "kind": "request",
        "open": true,
        "asks_for": "adjudicate the gate blocker",
        "subject": "An earlier wording of the same standing message.",
        "payload": {"issue_code": "gate_score_stagnation"}
    }))
    .unwrap();
    let newest_message = serde_json::to_string(&json!({
            "message_id": "supervisor->lab-director:focus#director-focus",
            "channel": "supervisor->lab-director:focus",
            "cycle_id": cycle,
            "from_role": "supervisor",
            "to_roles": ["lab-director"],
            "kind": "request",
            "open": true,
            "asks_for": "adjudicate the gate blocker",
            "subject": "Adjudicate the current gate blocker before launching another scout lane.",
            "payload": {"issue_code": "gate_score_stagnation"}
        }))
    .unwrap();
    fs::write(
        mailbox_dir.join("lab-director.jsonl"),
        format!("{first_message}\n{newest_message}\n"),
    )
    .unwrap();
    write_json(
        &state_dir.join(format!("{cycle}-agent-communication-digest.json")),
        &json!({
            "updated_at": "2026-05-15T00:00:00Z",
            "current_focus": {"lead_hypothesis": "Lead claim"},
            "communication_diagnosis": ["stale blocker carried forward"],
            "active_blockers": ["active blocker"],
            "resolved_or_superseded_blockers": ["old blocker"],
            "handoffs": {"lab_director": {"summary": "handoff"}},
            "role_boundaries": ["LabDirector owns scientific direction"],
            "timeline": ["t0"],
            "source_paths": {}
        }),
    )
    .unwrap();
    let mut role_plan = json!({
        "lane_id": "followup-lab-director-01",
        "role": "lab-director",
        "planner_metadata": {
            "previous_review_context": "p".repeat(20_000),
            "review_action": {
                "description": "review",
                "large": "r".repeat(20_000)
            }
        },
        "previous_review_context": "q".repeat(20_000)
    });

    attach_lab_director_context_controls(&paths, cycle, &mut role_plan).unwrap();

    assert!(role_plan.get("context_input_trace").is_some());
    assert!(role_plan.get("context_budget_policy").is_some());
    assert_eq!(
        role_plan["cycle_memory_context"]["format"].as_str(),
        Some("cycle_memory_compact")
    );
    assert_eq!(
        role_plan["agent_mailbox_context"]["format"].as_str(),
        Some("message_bus_compact")
    );
    assert_eq!(
        role_plan["agent_mailbox_context"]["open_request_count"].as_u64(),
        Some(1)
    );
    assert_eq!(
        role_plan["agent_mailbox_context"]["you_owe_an_answer"][0]["message_id"].as_str(),
        Some("supervisor->lab-director:focus#director-focus")
    );
    assert_eq!(
        role_plan["agent_communication_digest_context"]["format"].as_str(),
        Some("agent_communication_digest_compact")
    );
    assert_eq!(
        role_plan["previous_review_context"]["truncated"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["truncated"].as_bool(),
        Some(true)
    );
}

#[test]
fn followup_role_plan_promotes_impact_first_mandate_from_review_action() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-impact-first-followup";
    let lane_id = "followup-lab-director-01";

    let role_plan_path = write_followup_role_plan(
        &paths,
        cycle,
        lane_id,
        "lab-director",
        "gpt-test",
        "Recover scientific impact after a weak gate result.",
        "strategy_pivot",
        "force a pivot to impact-ranked hypothesis families",
        "gate_restart_followup",
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "review_action": {
                "type": "gate_restart_followup",
                "preferred_role": "lab-director",
                "description": "force pivot",
                "impact_first_hypothesis_mandate": {
                    "active": true,
                    "policy_version": "impact-first-v1",
                    "required_candidate_fields": ["hypothesis_id", "expected_impact_score"]
                }
            }
        }),
    )
    .unwrap();

    let role_plan = read_json(&role_plan_path).unwrap();
    assert_eq!(
        role_plan["impact_first_hypothesis_mandate"]["active"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["impact_first_hypothesis_mandate"]["active"].as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["planner_metadata"]["review_action"]["impact_first_hypothesis_mandate"]["active"]
            .as_bool(),
        Some(true)
    );
    assert_eq!(
        role_plan["hypothesis_generation_policy"]["mode"].as_str(),
        Some("impact-first")
    );
}
