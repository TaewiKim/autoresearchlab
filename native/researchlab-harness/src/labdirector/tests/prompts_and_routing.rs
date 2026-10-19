#[test]
fn analyst_task_markdown_carries_pick_dataset_directive() {
    // Locks in the docs/data-fetcher-2026-04-28.md §E directive
    // language that the analyst prompt must consume `candidate_datasets`
    // from `planner_metadata` and emit both `dataset_root` and
    // `column_mapping` in its handoff.
    use crate::labdirector::policy::task_markdown;
    let agent = json!({
        "agent_id": "analyst-01",
        "role": "analyst",
        "duty": "statistician test stub",
    });
    let md = task_markdown(&agent, "cycle-test", "test objective");
    assert!(
        md.contains("pick_dataset_for_hypothesis"),
        "analyst task_markdown missing pick_dataset_for_hypothesis directive"
    );
    assert!(
        md.contains("candidate_datasets"),
        "directive must reference candidate_datasets"
    );
    assert!(
        md.contains("reference_resources") && md.contains("GitHub"),
        "directive must require active use of reference_resources / GitHub repositories"
    );
    assert!(
        md.contains("column_mapping"),
        "directive must require column_mapping in handoff"
    );
    assert!(
        md.contains("no_matching_bundle"),
        "directive must define a deferred reason when no bundle covers the variables"
    );
    assert!(
        md.contains("open_source_analysis_agent_discovery")
            && md.contains("selected_open_source_analysis_agent"),
        "analyst task_markdown must require open-source analysis agent discovery before analysis"
    );
}

#[test]
fn lab_director_task_markdown_requires_research_notes() {
    use crate::labdirector::policy::task_markdown;
    let agent = json!({
        "agent_id": "lab-director-01",
        "role": "lab-director",
        "duty": "research lead test stub",
    });
    let md = task_markdown(&agent, "cycle-test", "test objective");
    assert!(
        md.contains("research_notes_duty"),
        "lab-director task_markdown missing research notes duty"
    );
    assert!(
        md.contains("cycle-test-lab-director-research-notes.md")
            && md.contains("cycle-test-lab-director-research-notes.json"),
        "lab-director notes must include both Markdown and JSON paths"
    );
    assert!(
        md.contains("handoff_for_next_lab_director"),
        "research notes must preserve handoff context for the next lab-director"
    );
    assert!(
        md.contains("completion_rule") && md.contains("updated research notes"),
        "lab-director completion rule must include research notes"
    );
    assert!(
        md.contains("hypothesis_gate_efficiency_mandate")
            && md.contains("minimum valid time and token spend")
            && md.contains("smallest targeted gatekeeper/rubric review"),
        "lab-director task_markdown must prioritize efficient hypothesis-gate closure"
    );
}

#[test]
fn chronicle_task_markdown_requires_direct_corpus_interaction() {
    use crate::labdirector::policy::task_markdown;
    let agent = json!({
        "agent_id": "chronicle-01",
        "role": "chronicle",
        "duty": "evidence synthesis test stub",
    });
    let md = task_markdown(&agent, "cycle-test", "test objective");
    assert!(
        md.contains("direct_corpus_interaction_duty"),
        "chronicle task_markdown missing DCI duty"
    );
    assert!(
        md.contains("arXiv:2605.05242") && md.contains("DCI-Agent-Lite"),
        "chronicle DCI duty must cite the paper and repository"
    );
    assert!(
        md.contains("cycle-test-chronicle-dci-corpus-map.json")
            && md.contains("cycle-test-chronicle-dci-evidence-ledger.json")
            && md.contains("cycle-test-chronicle-dci-checkpoint.json"),
        "chronicle DCI duty must require corpus map, evidence ledger, and checkpoint artifacts"
    );
}

#[test]
fn lab_director_notes_context_falls_back_when_json_is_invalid() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-notes";
    let state_dir = state_root(&paths);
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join(format!("{cycle}-lab-director-research-notes.json")),
        "{invalid json",
    )
    .unwrap();
    fs::write(
        state_dir.join(format!("{cycle}-lab-director-research-notes.md")),
        "current lead hypothesis and next action",
    )
    .unwrap();

    let context = lab_director_existing_research_notes_context(&paths, cycle)
        .unwrap()
        .expect("existing notes context");
    assert_eq!(
        context["format"].as_str(),
        Some("markdown_with_json_parse_error")
    );
    assert!(
        !context["json_parse_error"]
            .as_str()
            .unwrap()
            .trim()
            .is_empty(),
        "parse error should be preserved for repair"
    );
    assert!(
        context["excerpt"]
            .as_str()
            .unwrap()
            .contains("current lead hypothesis"),
        "Markdown fallback should remain available"
    );
}

#[test]
fn followup_analyst_task_markdown_also_carries_directive() {
    // Followup analyst lanes (pivot_followup, brainstorm, recovery, …)
    // verify the lab-director hypothesis on the same code path as the
    // base analyst, so they MUST receive the same directive — a v23
    // live-cycle observation showed followup-analyst lanes were
    // silently bypassing the dataset-pick step because they go
    // through followup_task_markdown, which historically did not
    // carry the directive.
    let md = followup_task_markdown(
        "cycle-test",
        "test objective",
        "analyst",
        "strategy_pivot",
        "Generate a rival family",
        &["hyp-1".to_string()],
    );
    assert!(
        md.contains("pick_dataset_for_hypothesis"),
        "followup analyst markdown missing pick_dataset_for_hypothesis directive"
    );
    assert!(
        md.contains("candidate_datasets"),
        "directive must reference candidate_datasets"
    );
    assert!(
        md.contains("reference_resources") && md.contains("GitHub"),
        "directive must require active use of reference_resources / GitHub repositories"
    );
    assert!(
        md.contains("column_mapping"),
        "directive must require column_mapping"
    );
    assert!(
        md.contains("no_matching_bundle"),
        "directive must define the deferred reason"
    );
    assert!(
        md.contains("open_source_analysis_agent_discovery")
            && md.contains("selected_open_source_analysis_agent"),
        "followup analyst markdown must require open-source analysis agent discovery"
    );
}

#[test]
fn followup_lab_director_task_markdown_requires_research_notes() {
    let md = followup_task_markdown(
        "cycle-test",
        "test objective",
        "lab-director",
        "strategy_pivot",
        "Replace the current lead hypothesis",
        &["hyp-1".to_string()],
    );
    assert!(
        md.contains("research_notes_duty"),
        "followup lab-director markdown missing research notes duty"
    );
    assert!(
        md.contains("cycle-test-lab-director-research-notes.md")
            && md.contains("cycle-test-lab-director-research-notes.json"),
        "followup lab-director notes must include both paths"
    );
    assert!(
        md.contains("pivot_hypothesis_replacement_contract"),
        "pivot followup should retain its existing replacement contract"
    );
    assert!(
        md.contains("hypothesis_gate_efficiency_mandate")
            && md.contains("Do not repeat broad scout searches")
            && md.contains("technical_quality"),
        "followup lab-director markdown must avoid redundant gate-passing attempts"
    );
}

#[test]
fn followup_chronicle_task_markdown_requires_direct_corpus_interaction() {
    let md = followup_task_markdown(
        "cycle-test",
        "test objective",
        "chronicle",
        "logic_trace_followup",
        "Rebuild the evidence trace",
        &[],
    );
    assert!(
        md.contains("direct_corpus_interaction_duty"),
        "followup chronicle markdown missing DCI duty"
    );
    assert!(
        md.contains("cycle-test-chronicle-dci-corpus-map.json")
            && md.contains("cycle-test-chronicle-dci-evidence-ledger.json"),
        "followup chronicle DCI duty must include artifact paths"
    );
}

#[test]
fn runner_methods_followup_without_executable_spec_is_routed_to_analyst() {
    let vague_runner_action = json!({
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "description": "run the requested robustness checks for the revised lead"
    });
    assert!(
        runner_validation_action_requires_analyst_handoff(
            "methods_followup",
            "lab-runner",
            &vague_runner_action
        ),
        "lab-runner followups without executable checks/code must first become analyst handoffs"
    );

    let executable_runner_action = json!({
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "handoff_checks": [{ "check_id": "check-1" }],
        "validation_code_blueprints": [{ "code": "print({})" }]
    });
    assert!(
        !runner_validation_action_requires_analyst_handoff(
            "methods_followup",
            "lab-runner",
            &executable_runner_action
        ),
        "lab-runner may execute when the action carries checks and code"
    );
}

#[test]
fn executable_analyst_handoff_action_stays_with_lab_runner_even_without_blueprint_code() {
    let handoff_action = json!({
        "brief_id": "analyst-handoff",
        "type": "methods_followup",
        "preferred_role": "lab-runner",
        "description": "execute the latest analyst handoff from v56-omics-paper-complete-cache-fresh",
        "handoff_checks": [{ "check_id": "check-1" }],
        "validation_code_blueprints": [{
            "blueprint_id": "external-agent-first",
            "dependencies": ["python-open-source-workflow-adapter"]
        }],
        "analysis_request": {
            "source": "latest-executable-analyst-handoff",
            "analyst_handoff": {
                "selected_open_source_analysis_agent": {
                    "name": "python-open-source-workflow-adapter",
                    "application_command": "python3 open_source_workflow_adapter.py --csv-root \"$RESEARCHLAB_CSV_ROOT\""
                }
            }
        }
    });
    let (role, handoff_required) =
        effective_preferred_role_for_action("methods_followup", "lab-runner", &handoff_action);
    assert_eq!(role, "lab-runner");
    assert!(
            !handoff_required,
            "the latest analyst handoff is already the executable handoff and must not be rerouted back to analyst or scout"
        );
}

#[test]
fn explicit_lab_runner_action_is_not_rerouted_by_paper_text_in_cycle_id() {
    assert!(
        !should_route_to_literature_analyst(
            "lab-runner",
            "methods_followup",
            "execute the latest analyst handoff from v56-omics-paper-complete-cache-fresh"
        ),
        "cycle ids or paths containing 'paper' must not reroute explicit lab-runner validation"
    );
    assert!(
        should_route_to_literature_analyst(
            "analyst",
            "literature_followup",
            "compare the current paper baseline"
        ),
        "literature analyst routing should remain available for non-runner actions"
    );
}

#[test]
fn lab_director_executable_matrix_action_is_routed_to_analyst() {
    let action = json!({
        "type": "hypothesis_followup",
        "preferred_role": "lab-director",
        "description": "Once GSE282742 matrices are present, run a direct rival comparison with matched splits, calibration assessment, and parsimonious signatures."
    });
    let (role, handoff_required) =
        effective_preferred_role_for_action("hypothesis_followup", "lab-director", &action);
    assert_eq!(role, "analyst");
    assert!(
            handoff_required,
            "executable analysis requests from LabDirector should become analyst handoffs instead of spawning repeated LabDirector requery lanes"
        );

    let requery = json!({
        "type": "lab_director_requery_followup",
        "preferred_role": "lab-director",
        "description": "answer gatekeeper questions about hypothesis strategy"
    });
    let (role, handoff_required) = effective_preferred_role_for_action(
        "lab_director_requery_followup",
        "lab-director",
        &requery,
    );
    assert_eq!(role, "lab-director");
    assert!(!handoff_required);
}

// cycle-b-20260918, 2026-09-18: the owner assigned simulation orchestration
// to the LabDirector; an analyst-declared request let the analyst choose the
// experiment. The director is told to order it, the analyst only to analyse the
// bundle it produces, and an engineer to run it.
#[test]
fn the_director_orders_the_simulation_the_engineer_runs_it_the_analyst_analyses_it() {
    use crate::labdirector::policy::task_markdown;
    let director = json!({"agent_id": "lab-director-01", "role": "lab-director", "duty": "stub"});
    let base = task_markdown(&director, "cycle-sim", "objective");
    let followup = followup_task_markdown(
        "cycle-sim", "objective", "lab-director", "brief", "requery the lead", &[],
    );
    for md in [&base, &followup] {
        assert!(md.contains("- simulation_orders:"), "director missing the simulation directive");
        assert!(md.contains(".research-lab/datasets/cycle-sim/simulations/"));
        assert!(md.contains("instrument_inventory.simulators"));
        assert!(md.contains("hypothesis_link"));
    }

    let analyst = json!({"agent_id": "analyst-01", "role": "analyst", "duty": "stub"});
    let base = task_markdown(&analyst, "cycle-sim", "objective");
    let followup = followup_task_markdown(
        "cycle-sim", "objective", "analyst", "brief", "design the validation", &[],
    );
    for md in [&base, &followup] {
        assert!(!md.contains("simulation_request"), "the analyst no longer declares simulations");
        assert!(!md.contains("- simulation_orders:"));
        assert!(md.contains("provider: \"simulation\""), "the analyst is told what a simulation bundle is");
    }

    let engineer = followup_task_markdown(
        "cycle-sim",
        "objective",
        "engineer",
        "simulation-grasp_sweep",
        "Run the LabDirector's simulation order `grasp_sweep`",
        &[],
    );
    assert!(engineer.contains("simulation_execution_contract"));
    let provisioning = followup_task_markdown(
        "cycle-sim", "objective", "engineer", "brief", "provision a tool", &[],
    );
    assert!(!provisioning.contains("simulation_execution_contract"));
}
