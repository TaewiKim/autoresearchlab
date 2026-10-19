// A falsification retires the METHOD; the question survives it.
//
// MEASURED ON cycle-g-v87. Eleven replace/restart decisions cited a falsification
// and nine of them changed the research question. The cycle opened at 15:47 on
// 08-27 asking whether two decision-time residual descriptors could predict the
// stale-cache crossover boundary, had that predictor falsified by runner-29, and
// spent the next ten hours through AOV cache invalidation, integrator ranking,
// survival modelling, value-of-information and transport failure -- arriving at
// 01:12 on 08-29 at the same boundary question, re-derived by accident.
//
// Three predictors for that one boundary were built during the cycle. Each was
// attached to a different question, so none was ever a second attempt at the
// first.
//
// The contract already forbade retiring a problem for a MISSING INSTRUMENT
// (cycle-g-v82 retired 100 that way). This is its falsification twin, and these
// assertions exist because a prompt-contract clause has no compiler: the only
// thing that fails when the text is dropped in an edit is a test that reads it.

#[test]
fn the_director_contract_forbids_retiring_a_problem_on_one_falsification() {
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(
        contract.contains("Method-persistence rule (MANDATORY)"),
        "the rule must be named so a reader can find it next to the pivot rule"
    );
    assert!(
        contract.contains("RETIRES THE METHOD, NOT THE QUESTION"),
        "the claim itself must be stated, not implied"
    );
    assert!(
        contract.contains("at least THREE distinct"),
        "the floor is the operative part; prose without it is advice"
    );
}

#[test]
fn the_contract_asks_for_the_attempt_history_that_makes_the_floor_checkable() {
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    // A floor of three is unenforceable unless the attempts are written down
    // where the NEXT director reads them.
    assert!(contract.contains("methods_tried"), "attempts must be recorded");
    assert!(
        contract.contains("why_the_next_method_differs"),
        "a dead method is evidence about the problem; the contract must ask what it changed"
    );
    assert!(
        contract.contains("problem_retirement"),
        "retiring a question must be an explicit, justified act"
    );
    assert!(
        contract.contains("distinct in the procedure EXECUTED"),
        "three rewordings of one method are one method; the contract must say so"
    );
}

#[test]
fn the_instrument_gap_guard_is_still_there() {
    // The new rule is the twin of that one, not a replacement for it. cycle-g-v82
    // retired 100 problems for missing instruments and produced zero gate rounds
    // in 5.5 hours.
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Do NOT retire the problem for a missing instrument"));
    assert!(contract.contains("NOT PROBED YET, never NOT POSSIBLE"));
}

#[test]
fn the_two_exit_rules_do_not_contradict_each_other() {
    // The novelty-rejection rule orders a pivot to a different method FAMILY; this
    // one orders persistence on the QUESTION. A director reading both must be told
    // they compose, or it will follow whichever it read last -- on v87 it followed
    // the pivot rule and took the question with it.
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Novelty-rejection pivot rule (MANDATORY)"));
    assert!(
        contract.contains("a second attempt at the same problem satisfies"),
        "the contract must resolve the two rules explicitly rather than leaving the \
         director to choose between two MANDATORY instructions"
    );
}

#[test]
fn the_contract_orders_novelty_before_the_axes_budget_can_buy() {
    // cycle-g-v89 at round 46, 56% of budget spent: clarity 91, reproducibility
    // 86, technical_quality 82, novelty 64, impact 58. It bought everything
    // buyable and hit the wall held by the one axis no run can raise, with 35
    // rounds left that could not help. hypothesis_progress.js:660 already held
    // this reasoning but only fired at the wall, where the ordering mistake has
    // already been made.
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Novelty-first sequencing rule (MANDATORY)"));
    assert!(
        contract.contains("ESTABLISH THE AXIS YOU CANNOT BUY BEFORE SPENDING BUDGET ON THE ONES YOU CAN"),
        "the ordering must be stated as the claim, not left to be inferred"
    );
    // The operative half: what to do NEXT while novelty is short.
    assert!(
        contract.contains("must be a novelty action"),
        "an ordering with no instruction attached is an observation"
    );
    assert!(
        contract.contains("more validation is the WRONG answer"),
        "the director reads the binding rubric to choose an action; the contract          must say when the cheap move is the wrong one"
    );
}

#[test]
fn novelty_first_does_not_swallow_the_two_rules_beside_it() {
    // Three MANDATORY rules now sit together. v87 showed what happens when two of
    // them point different ways and nothing reconciles them: the director followed
    // whichever it read last and took the research question with it.
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Novelty-rejection pivot rule (MANDATORY)"));
    assert!(contract.contains("Method-persistence rule (MANDATORY)"));
    assert!(contract.contains("Novelty-first sequencing rule (MANDATORY)"));
    // Ordering is stated relative to the gate's binding rubric, so the three
    // compose on a fact rather than on precedence.
    assert!(contract.contains("when the binding (lowest) rubric is"));
}

// OWNER DECISION 2026-10-05: the novelty pivot rule waits for the lead's
// refinement window (its first two novelty-reviewed gate rounds). Without the
// exception in the contract the director reads "MUST NOT uphold" beside a ledger
// directive to keep refining, and follows whichever it read last.
#[test]
fn the_novelty_pivot_waits_for_the_refinement_window() {
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("Novelty-rejection pivot rule (MANDATORY): it applies once the lead's refinement window has closed."));
    assert!(contract.contains("novelty_refinement_window"));
    assert!(contract.contains("a valid falsification releases the lead at once"));
}

// OWNER DECISION 2026-10-06: the gate's objections are answered with experiments
// before the lead is replaced.
#[test]
fn the_contract_asks_for_rebuttal_experiments_before_replacement() {
    let contract = crate::runtime::codex_prompt::LAB_DIRECTOR_OUTPUT_CONTRACT;
    assert!(contract.contains("\"rebuttal_experiments\""));
    assert!(contract.contains("REBUTTAL BEFORE REPLACEMENT (MANDATORY when planner_metadata.rebuttal_targets is present)"));
    assert!(contract.contains("planner_metadata.alternate_pilots"));
    assert!(contract.contains("PILOT FIRST (enforced)"));
}
