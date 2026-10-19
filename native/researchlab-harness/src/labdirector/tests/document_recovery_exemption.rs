// While the hypothesis gate is rejected, the recovery filter kept only the
// actions that could answer it -- and dropped every document action on the way.
//
// That is right while a cycle is still trying to pass the gate. It is wrong the
// moment the owner has authorised writing the paper anyway, which is precisely
// when the document reviews start producing work. cycle-g-v89 spent a day in
// that state: three author-owned blockers in the paper review, six document
// actions carried into this function, 797 actions out with none of them, no
// author lane ever opened, and a stagnation halt with the manuscript
// byte-identical to the one it started with.
//
// The authorisation already exempted the LANE gate in dependency_gates_01. Its
// own comment says an exemption that names one door leaves the traffic at the
// other, still bolted. This is the other door.

fn write_rejected_hypothesis_gate(paths: &AppPaths, cycle: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_stage_gate_search_inputs(paths, cycle);
    write_json(
        &state_root(paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "residual correlation localizes the safe reuse boundary",
            "primary_family": "prospective_reuse_safety",
            "identification_strategy": {"materialized_dataset": {"accession": "GSE322943"}}
        }),
    )
    .unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-gate-review.json")),
        &json!({
            "mode": "defer",
            "gate_passed": false,
            "score": 46,
            "gatekeeper_pending_rubrics": [],
            "gate_scientific_blockers": ["no comparator, dispersion unreported"],
        }),
    )
    .unwrap();
}

fn document_actions() -> Vec<Value> {
    vec![
        json!({
            "brief_id": "paper-review",
            "type": "manuscript_standard_followup",
            "preferred_role": "author",
            "priority": "critical",
            "required_for_gate": true,
            "priority_score": 9_900,
            "description": "contribution_type is not stated"
        }),
        json!({
            "brief_id": "paper-review",
            "type": "figure_submission_discipline_followup",
            "preferred_role": "illustrator",
            "priority_score": 116,
            "description": "the demo video ships without a video_check"
        }),
        json!({
            "brief_id": "gate-review",
            "type": "gate_restart_followup",
            "preferred_role": "lab-director",
            "priority_score": 240,
            "description": "rerank the families"
        }),
    ]
}

fn surviving_roles(actions: &[Value]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| {
            action
                .get("preferred_role")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect()
}

#[test]
fn a_rejected_gate_still_drops_document_work_when_nobody_authorised_it() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-document-recovery-unauthorised";
    write_rejected_hypothesis_gate(&paths, cycle);

    let mut actions = document_actions();
    enforce_stage_gate_recovery_actions(&paths, cycle, &mut actions, "graphics").unwrap();

    let roles = surviving_roles(&actions);
    assert!(!roles.contains(&"author".to_string()), "{roles:?}");
    assert!(!roles.contains(&"illustrator".to_string()), "{roles:?}");
    assert!(
        roles.contains(&"lab-director".to_string()),
        "the recovery action that answers the gate has to survive: {roles:?}",
    );
}

#[test]
fn an_authorised_document_stage_keeps_its_author_and_illustrator_work() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-document-recovery-authorised";
    write_rejected_hypothesis_gate(&paths, cycle);
    write_json(
        &state_root(&paths).join(format!("{cycle}-document-authorization.json")),
        &json!({
            "authorized": true,
            "authorized_by": "owner",
            "reason": "document this cycle; the gate's reject stands and is not being rewritten",
        }),
    )
    .unwrap();
    assert!(document_stage_authorized(&paths, cycle));

    let mut actions = document_actions();
    enforce_stage_gate_recovery_actions(&paths, cycle, &mut actions, "graphics").unwrap();

    let roles = surviving_roles(&actions);
    assert!(roles.contains(&"author".to_string()), "{roles:?}");
    assert!(roles.contains(&"illustrator".to_string()), "{roles:?}");
    // The authorisation opens the document door. It does not close the gate's.
    assert!(roles.contains(&"lab-director".to_string()), "{roles:?}");
}
