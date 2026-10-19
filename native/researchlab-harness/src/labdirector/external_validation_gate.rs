use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashSet;

use crate::core::model::AppPaths;
use crate::core::support::{read_json, slugify, state_root};

pub(crate) fn external_validation_required_for_gate(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !review_path.exists() {
        return Ok(false);
    }
    let review = read_json(&review_path)?;
    Ok(review
        .get("external_validation_review")
        .and_then(|item| item.get("required_for_gate"))
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

pub(crate) fn external_validation_gate_actions(review: &Value) -> Vec<Value> {
    let mut actions = Vec::new();
    let mut seen = HashSet::new();
    let mut push_action = |action: &Value| {
        let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
        let target_rubric = action
            .get("target_rubric")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !matches!(
            action_type,
            "external_validation_followup" | "external_validation_analysis_followup"
        ) && target_rubric != "external_validity"
        {
            return;
        }
        let key = format!(
            "{}::{}::{}",
            action_type,
            action
                .get("preferred_role")
                .and_then(Value::as_str)
                .unwrap_or(""),
            slugify(
                action
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            )
        );
        if seen.insert(key) {
            actions.push(action.clone());
        }
    };

    for path in [
        &["external_validation_review", "recommended_actions"][..],
        &["recommended_actions"][..],
        &["recommended_followup_actions"][..],
    ] {
        let mut cursor = review;
        for key in path {
            cursor = cursor.get(*key).unwrap_or(&Value::Null);
        }
        if let Some(items) = cursor.as_array() {
            for action in items {
                push_action(action);
            }
        }
    }

    if actions.is_empty() {
        if let Some(external_review) = review.get("external_validation_review") {
            let validation_plan = external_review
                .get("validation_plan")
                .cloned()
                .unwrap_or(Value::Null);
            actions.push(json!({
                "type": "external_validation_followup",
                "preferred_role": "scout",
                "priority": "high",
                "target_rubric": "external_validity",
                "target_score": 95,
                "description": "attempt public independent, orthogonal, or stricter sensitivity validation before allowing hypothesis-gate closure; download/materialize accessible data or write a concrete failed-attempt artifact",
                "validation_plan": validation_plan,
            }));
            actions.push(json!({
                "type": "external_validation_analysis_followup",
                "preferred_role": "analyst",
                "priority": "high",
                "target_rubric": "external_validity",
                "target_score": 95,
                "description": "design the next executable external-validation or fallback sensitivity analysis, including explicit criteria for narrowing, replacing, or demoting the current hypothesis",
                "validation_plan": validation_plan,
            }));
        }
    }

    actions
}
