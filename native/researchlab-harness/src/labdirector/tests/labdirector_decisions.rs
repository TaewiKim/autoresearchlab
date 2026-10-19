#[test]
fn labdirector_replacement_forces_comparator_aware_analyst_validation() {
    assert_labdirector_decision_forces_comparator_validation(
        "replace",
        "cycle-labdirector-replacement-validation",
    );
}

#[test]
fn labdirector_upheld_lead_forces_comparator_aware_analyst_validation() {
    assert_labdirector_decision_forces_comparator_validation(
        "uphold",
        "cycle-labdirector-upheld-validation",
    );
}
