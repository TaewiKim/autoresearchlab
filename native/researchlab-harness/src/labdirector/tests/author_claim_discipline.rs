// The author lane had no author directive.
//
// Every author lane in a running cycle is a follow-up, and `followup_task_markdown`
// had branches for analyst, engineer, lab-director, gatekeeper and chronicle --
// and none for author. An author follow-up received the generic header, the
// action description, and nothing about how to make a claim.
//
// Owner, 2026-09-13, four rules:
//   - same problem as prior work means the method must be new AND the number
//     better; if it cannot be both, redefine the problem
//   - the highest-value result is Figure 1
//   - not hiding a weakness is NOT the same as making a timid claim
//   - a weakness you found is work to do before writing, not a sentence to write
//
// These assertions read the task body the dispatcher actually produces, not the
// source text of the directive. A rule can be present in the source and absent
// from every prompt -- that is the failure this repository keeps finding, and a
// grep would reproduce it rather than catch it.

fn author_task_body() -> String {
    followup_task_markdown(
        "cg-gate-author",
        "some objective in some field",
        "author",
        "brief-1",
        "revise the manuscript against the gate review",
        &["a hypothesis statement".to_string()],
    )
}

#[test]
fn the_author_prompt_carries_the_claim_discipline() {
    let body = author_task_body();
    for key in [
        "same_problem_needs_new_method_and_better_numbers",
        "highest_value_result_is_figure_one",
        "disclosure_is_not_hedging",
        "a_weakness_is_work_not_a_sentence",
    ] {
        assert!(body.contains(key), "the author prompt does not carry {key}");
    }
}

#[test]
fn the_same_problem_rule_demands_both_halves_and_names_the_alternative() {
    let body = author_task_body();
    // Both, not either: a new method that does not beat the number is not a
    // contribution to that problem, and neither is a better number from a
    // reworded method.
    assert!(body.contains("Not one of the two."), "{body}");
    // And the way out is stated, or the rule is only a prohibition: when the
    // work cannot be both, the problem itself is what changes.
    assert!(
        body.contains("redefine the problem"),
        "the rule forbids without naming what to do instead",
    );
}

#[test]
fn disclosure_and_hedging_are_kept_apart() {
    let body = author_task_body();
    assert!(body.contains("DIFFERENT THINGS"), "{body}");
    // The failure mode is specific: softening the claim as a substitute for
    // naming what is unresolved. Naming the hedging words is what makes it
    // checkable by the writer.
    for hedge in ["`may`", "`appears to`", "`suggests`"] {
        assert!(body.contains(hedge), "the prompt does not name the hedge {hedge}");
    }
}

#[test]
fn a_weakness_is_an_action_with_a_named_fallback() {
    let body = author_task_body();
    assert!(
        body.contains("address it and THEN write"),
        "the prompt does not say the weakness is closed before writing",
    );
    // A rule that only forbids leaves nothing to do when the weakness genuinely
    // cannot be closed in this cycle, so the prompt has to say what that case
    // looks like -- otherwise it reads as "never mention limitations".
    assert!(
        body.contains("what specifically would close it"),
        "the prompt gives no instruction for a weakness that cannot be closed here",
    );
}

#[test]
fn other_roles_do_not_receive_the_author_rules() {
    // These are rules for writing a claim. An analyst or a scout given them
    // would be told to redefine a problem it does not own.
    for role in ["analyst", "scout", "gatekeeper", "lab-runner"] {
        let body = followup_task_markdown(
            "cg-gate-author",
            "some objective in some field",
            role,
            "brief-1",
            "do the thing",
            &[],
        );
        assert!(
            !body.contains("highest_value_result_is_figure_one"),
            "{role} received the author claim rules",
        );
    }
}
