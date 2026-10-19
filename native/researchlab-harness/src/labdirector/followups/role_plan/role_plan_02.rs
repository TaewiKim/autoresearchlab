#![allow(unused_imports)]
use super::*;

pub(crate) fn validation_blueprints_have_code(value: &Value) -> bool {
    value
        .as_array()
        .map(|items| {
            items.iter().any(|item| {
                item.get("code")
                    .and_then(Value::as_str)
                    .map(|code| !code.trim().is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub(crate) fn executable_validation_spec_present(value: &Value) -> bool {
    let has_handoff_checks = value
        .get("handoff_checks")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let has_code_blueprints = value
        .get("validation_code_blueprints")
        .map(validation_blueprints_have_code)
        .unwrap_or(false);
    if has_handoff_checks && has_code_blueprints {
        return true;
    }

    for nested_key in [
        "analyst_handoff",
        "cycle_analyst_handoff",
        "handoff_validation_plan",
        "validation_plan",
        "analysis_request",
        "review_action",
    ] {
        if value
            .get(nested_key)
            .map(executable_validation_spec_present)
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

pub(crate) fn runner_validation_action_requires_analyst_handoff(
    action_type: &str,
    preferred_role: &str,
    action: &Value,
) -> bool {
    let brief_id = action.get("brief_id").and_then(Value::as_str).unwrap_or("");
    if brief_id == "analyst-handoff" || brief_id == "analyst-handoff-artifact" {
        return false;
    }
    if preferred_role != "lab-runner" {
        return false;
    }
    let requires_executable_spec = matches!(
        action_type,
        "methods_followup"
            | "accuracy_followup"
            | "hypothesis_followup"
            | "chronicle_required_evidence"
            | "external_validation_analysis_followup"
    ) || action_type.contains("validation")
        || action_type.contains("evidence");
    requires_executable_spec && !executable_validation_spec_present(action)
}

pub(crate) fn lab_director_action_should_be_analyst_handoff(
    action_type: &str,
    action: &Value,
) -> bool {
    if matches!(
        action_type,
        "lab_director_requery_followup"
            | "gate_restart_followup"
            | "independent_gate_review_followup"
    ) {
        return false;
    }
    let analysis_action = matches!(
        action_type,
        "hypothesis_followup"
            | "methods_followup"
            | "accuracy_followup"
            | "external_validation_analysis_followup"
    ) || action_type.contains("validation")
        || action_type.contains("evidence");
    if !analysis_action {
        return false;
    }
    let text = action
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let requests_execution = [
        "run ",
        "test ",
        "validate",
        "analysis",
        "comparison",
        "matrix",
        "matrices",
        "calibration",
        "matched split",
        "signature",
        "model",
    ]
    .iter()
    .any(|needle| text.contains(needle));
    requests_execution
        || action.get("analysis_request").is_some()
        || action.get("validation_plan").is_some()
}

pub(crate) fn effective_preferred_role_for_action<'a>(
    action_type: &str,
    requested_preferred_role: &'a str,
    action: &Value,
) -> (&'a str, bool) {
    if runner_validation_action_requires_analyst_handoff(
        action_type,
        requested_preferred_role,
        action,
    ) {
        return ("analyst", true);
    }
    if requested_preferred_role == "lab-director"
        && lab_director_action_should_be_analyst_handoff(action_type, action)
    {
        return ("analyst", true);
    }
    (requested_preferred_role, false)
}
