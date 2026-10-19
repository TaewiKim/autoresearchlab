// The judge was asked about falsification and never handed the lead's own.
//
// The gatekeeper prompt asks "does the reasoning graph still indicate missing
// falsification, rival-explanation, or moderator tests that make the current
// conclusion premature" -- and carried neither the lead's stated falsification
// conditions nor its rival mechanisms. The hypothesis statement was not in it
// either: the only `"statement"` in 88 KB of prompt was the output template's
// own placeholder.
//
// MEASURED ON cycle-g-v91, 2026-09-13. In a real gatekeeper prompt the word
// `falsification` appears nineteen times, `rival_mechanism` zero, and
// `candidate_hypothesis_ranking` zero -- while the director had written all
// three into the hypothesis artifact an hour earlier. The rubric peaks for that
// cycle were novelty 58 and technical_quality 34, which is the honest output of
// a judge scoring a reconstruction instead of the claim.
//
// These read the plan the dispatcher actually builds. A directive present in
// the source and absent from every plan is the failure this repository keeps
// finding, and a grep would reproduce it rather than catch it.

fn write_lead(paths: &AppPaths, cycle: &str, selected: Value) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "cycle_id": cycle,
            "generated_by": "followup-lab-director-31",
            "selected_hypothesis": selected,
        }),
    )
    .unwrap();
}

fn full_lead() -> Value {
    json!({
        "statement": "an active-probing policy lowers false-safe upper90 by at least 0.03",
        "answers_research_problem": "where does fixed stale reuse first cross NRMSE>=0.02",
        "primary_family": "value_of_information_active_probing",
        "falsification_conditions": [
            "upper90 improves by less than 0.03 versus either comparator at matched saving",
        ],
        "rival_mechanisms": [
            "edit phase and severity already determine the boundary, so adaptive rays add nothing",
        ],
        "candidate_hypothesis_ranking": [
            { "statement": "phase/severity alone localizes first harm", "expected_impact_score": 45 },
        ],
        "supporting_literature_edges": ["url:http://arxiv.org/abs/2310.03507v1 -> nearest neighbour"],
        "supporting_data_graph_edges": ["followup-runner-13 -> rejection_map/phase_sham tie"],
        "reference_methods_baseline": "phase/severity stopping; uniform verification",
        "trend_positioning": "answers the sub-1-spp open problem",
    })
}

#[test]
fn the_gatekeeper_receives_the_lead_in_the_terms_it_scores() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-sees-lead";
    write_lead(&paths, cycle, full_lead());

    let lead = current_lead_under_review(&paths, cycle);
    // The three the prompt asks about and never carried.
    for key in [
        "falsification_conditions",
        "rival_mechanisms",
        "candidate_hypothesis_ranking",
    ] {
        assert!(
            lead.get(key).map(|value| !value.is_null()).unwrap_or(false),
            "{key} did not reach the gatekeeper",
        );
    }
    // And the claim itself, which was never in the prompt at all.
    assert_eq!(
        lead.get("statement").and_then(Value::as_str),
        Some("an active-probing policy lowers false-safe upper90 by at least 0.03"),
    );
    // Traceable back to its author, or a reviewer cannot ask them about it.
    assert_eq!(
        lead.get("generated_by").and_then(Value::as_str),
        Some("followup-lab-director-31"),
    );
    assert!(lead.get("source_artifact").and_then(Value::as_str).is_some());
}

#[test]
fn a_field_the_director_never_supplied_reaches_the_judge_as_null() {
    // Silence has to be visible. If a missing falsification condition arrived
    // looking the same as an absent key, the gate could not tell "the director
    // did not say" from "nothing was asked" -- and the second is what made this
    // gap survive a whole cycle.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-sees-nothing";
    write_lead(&paths, cycle, json!({ "statement": "a bare claim" }));

    let lead = current_lead_under_review(&paths, cycle);
    assert_eq!(lead.get("statement").and_then(Value::as_str), Some("a bare claim"));
    for key in ["falsification_conditions", "rival_mechanisms", "candidate_hypothesis_ranking"] {
        assert!(lead.get(key).is_some(), "{key} must be present as a key");
        assert!(lead[key].is_null(), "{key} must be null, not missing");
    }
    assert!(
        lead.get("note").and_then(Value::as_str).unwrap_or("").contains("did not supply"),
        "the note must tell the judge that a null is the director's silence",
    );
}

#[test]
fn no_lead_yet_is_not_an_empty_lead() {
    // A cycle before its first hypothesis must not hand the judge an object of
    // nulls that reads like a lead with nothing in it.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    fs::create_dir_all(state_root(&paths)).unwrap();
    assert!(current_lead_under_review(&paths, "cg-gate-no-lead").is_null());
}

#[test]
fn the_gatekeeper_is_told_to_score_against_it() {
    // Delivering the record and never mentioning it is half a fix: the judge
    // reads the prompt, not the metadata tree.
    let body = followup_task_markdown(
        "cg-gate-sees-lead",
        "an objective",
        "gatekeeper",
        "brief-1",
        "review the current lead",
        &[],
    );
    assert!(body.contains("current_lead_under_review"), "the prompt never names the record");
    assert!(body.contains("score_the_lead_as_its_author_stated_it"));
    // A null is a finding, not a gap to fill in silently.
    assert!(body.contains("which is also a finding"));

    // And it stays a gatekeeper rule.
    let analyst = followup_task_markdown(
        "cg-gate-sees-lead", "an objective", "analyst", "brief-1", "do the thing", &[],
    );
    assert!(!analyst.contains("score_the_lead_as_its_author_stated_it"));
}

#[test]
fn converging_still_asks_whether_the_lead_is_new() {
    // Converging suppresses widening the hypothesis space, which is right. It
    // was also suppressing the prior-art audit of the lead already chosen --
    // and that audit is the evidence the gate needs to score novelty at all.
    //
    // MEASURED ON cycle-g-v91 at gate round 15: convergence_mode=converge, EIGHT
    // queued `novelty_followup` actions naming `scout` for exactly that audit,
    // none carrying a selected hypothesis, and zero scout novelty lanes in the
    // whole cycle. The gatekeeper scored novelty 50 and said why: "the retrieval
    // was noisy and cannot clear novelty". The audit that would settle it was
    // requested eight times and dropped eight times.
    let source = include_str!("../followups/dispatch_novelty.rs");
    let converging = source
        .split("if assigned_selected_hypotheses.is_empty() {")
        .nth(1)
        .expect("the empty-selection branch is gone");
    let branch = converging.split("dispatch_open_novelty_followups(").next().unwrap();
    assert!(
        branch.contains("current_lead_under_review(paths, cycle_id)"),
        "a converging cycle no longer takes the lead from the artifact",
    );
    assert!(
        branch.contains("dispatch_selected_novelty_followups("),
        "a converging cycle dispatches nothing for a novelty_followup again",
    );
    // And with no lead at all it still dispatches nothing, rather than auditing
    // a claim that does not exist.
    assert!(
        branch.contains("return Ok(true);"),
        "the no-lead case must still be a quiet no-op",
    );
}
