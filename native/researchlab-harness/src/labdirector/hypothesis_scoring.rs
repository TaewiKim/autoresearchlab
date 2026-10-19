use serde_json::Value;

fn value_is_present(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(items)) => !items.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn contract_field_present(entry: &Value, names: &[&str]) -> bool {
    let contract = entry.get("scientific_contract");
    names.iter().any(|name| {
        if value_is_present(entry.get(*name))
            || value_is_present(contract.and_then(|value| value.get(*name)))
        {
            return true;
        }
        match *name {
            "primary_estimand" => value_is_present(
                contract
                    .and_then(|value| value.get("kill_test"))
                    .and_then(|value| value.get("primary_estimand")),
            ),
            "falsification_criteria" | "falsification_test" => value_is_present(
                contract
                    .and_then(|value| value.get("kill_test"))
                    .and_then(|value| value.get("rejection_criterion")),
            ),
            "smallest_useful_effect" | "decision_threshold" => value_is_present(
                contract
                    .and_then(|value| value.get("kill_test"))
                    .and_then(|value| value.get("smallest_useful_effect")),
            ),
            "minimum_discriminator" | "kill_test" => {
                value_is_present(contract.and_then(|value| value.get("kill_test")))
            }
            "procedure_signature" => {
                value_is_present(contract.and_then(|value| value.get("procedure")))
            }
            "null_contribution" | "value_if_null" => value_is_present(
                contract
                    .and_then(|value| value.get("outcome_value"))
                    .and_then(|value| value.get("if_refuted")),
            ),
            _ => false,
        }
    })
}

fn independently_assessed_score(entry: &Value, assessment_name: &str) -> Option<i64> {
    let assessment = entry.get(assessment_name)?.as_object()?;
    let score = assessment.get("score").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|v| v.round() as i64))
    })?;
    let assessor_present = assessment
        .get("assessor")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let evidence_present = assessment
        .get("evidence_refs")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    (assessor_present && evidence_present).then_some(score.clamp(0, 100))
}

pub(crate) fn statement_structure_score(statement: &str) -> i64 {
    // Text alone cannot establish scientific structure. Keep this legacy
    // function as a diagnostic for an empty statement, but never reward
    // novelty or methodology buzzwords.
    if statement.trim().is_empty() {
        0
    } else {
        20
    }
}

pub(crate) fn statement_measurability_score(statement: &str) -> i64 {
    if statement.trim().is_empty() {
        0
    } else {
        20
    }
}

pub(crate) fn hypothesis_impact_score(entry: &Value) -> i64 {
    // Impact is a scientific judgment, not a citation/agent-vote count. Only a
    // separately attributed assessment with evidence can supply this score.
    independently_assessed_score(entry, "impact_assessment").unwrap_or(0)
}

pub(crate) fn hypothesis_data_verifiability_score(entry: &Value) -> i64 {
    // This score measures whether a test contract is executable. It does not
    // infer verifiability from how many papers, claims, or agents mention it.
    let mut score = 0i64;
    if contract_field_present(entry, &["primary_estimand"]) {
        score += 20;
    }
    if contract_field_present(entry, &["falsification_criteria", "falsification_test"]) {
        score += 20;
    }
    if contract_field_present(entry, &["boring_baseline", "strongest_baseline"]) {
        score += 15;
    }
    if contract_field_present(entry, &["evidence_route", "validation_evidence_route"]) {
        score += 15;
    }
    if contract_field_present(entry, &["identification_strategy", "experimental_design"])
        && entry.get("identification_strategy").and_then(Value::as_str) != Some("unspecified")
    {
        score += 10;
    }
    if contract_field_present(entry, &["smallest_useful_effect", "decision_threshold"]) {
        score += 10;
    }
    if contract_field_present(entry, &["instrument_limitations", "data_limitations"]) {
        score += 10;
    }
    score.clamp(0, 100)
}

pub(crate) fn hypothesis_reasoning_graph_score(entry: &Value) -> i64 {
    let fields: &[&[&str]] = &[
        &["mechanism"],
        &["procedure_signature"],
        &["closest_prior_art"],
        &["novelty_delta", "state_of_art_delta"],
        &["strongest_inversion"],
        &["null_contribution", "value_if_null"],
        &["minimum_discriminator", "kill_test"],
        &["boundary_conditions", "scope_conditions"],
    ];
    fields
        .iter()
        .filter(|names| contract_field_present(entry, names))
        .count()
        .saturating_mul(12)
        .min(100) as i64
}

pub(crate) fn hypothesis_selection_score(entry: &Value) -> i64 {
    let impact = hypothesis_impact_score(entry);
    let novelty = independently_assessed_score(entry, "novelty_assessment").unwrap_or(0);
    let verifiability = hypothesis_data_verifiability_score(entry);
    let reasoning = hypothesis_reasoning_graph_score(entry);
    (impact * 30 / 100 + novelty * 30 / 100 + verifiability * 25 / 100 + reasoning * 15 / 100)
        .clamp(0, 100)
}

pub(crate) fn reasoning_gap_hypothesis_statements(open_validation_gaps: &[Value]) -> Vec<String> {
    open_validation_gaps
        .iter()
        .filter_map(|item| {
            let hypothesis_id = item
                .get("hypothesis_id")
                .and_then(Value::as_str)
                .unwrap_or("hypothesis");
            let statement = item
                .get("statement")
                .and_then(Value::as_str)
                .unwrap_or(hypothesis_id);
            let gaps = item
                .get("unresolved_gaps")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|gap| gap.as_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            if gaps.is_empty() {
                None
            } else {
                Some(format!(
                    "{} | unresolved reasoning/data gaps: {}",
                    statement,
                    gaps.join(", ")
                ))
            }
        })
        .take(6)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn novelty_words_and_duplicate_support_do_not_raise_scientific_scores() {
        let plain = json!({"statement": "A changes B."});
        let padded = json!({
            "statement": "A has a novel threshold mechanism with moderators, confounds, and sensitivity.",
            "support_count": 999,
            "role_diversity_count": 20,
            "paper_examples": ["same", "same", "same"]
        });
        assert_eq!(
            statement_structure_score(plain["statement"].as_str().unwrap()),
            20
        );
        assert_eq!(
            statement_structure_score(padded["statement"].as_str().unwrap()),
            20
        );
        assert_eq!(hypothesis_impact_score(&plain), 0);
        assert_eq!(hypothesis_impact_score(&padded), 0);
        assert_eq!(
            hypothesis_selection_score(&plain),
            hypothesis_selection_score(&padded)
        );
    }

    #[test]
    fn attributed_evidence_backed_judgments_and_test_contract_drive_selection() {
        let entry = json!({
            "statement": "A changes B under C.",
            "impact_assessment": {"score": 84, "assessor": "independent-review", "evidence_refs": ["ref:1"]},
            "novelty_assessment": {"score": 72, "assessor": "prior-art-review", "evidence_refs": ["ref:2"]},
            "primary_estimand": "held-out difference in B",
            "falsification_criteria": "reject when the sign reversal is absent",
            "boring_baseline": "fixed conservative policy",
            "evidence_route": "controlled_simulation",
            "identification_strategy": "paired_intervention",
            "smallest_useful_effect": 0.1,
            "instrument_limitations": ["aggregate force only"],
            "mechanism": "bounded information delay",
            "procedure_signature": "paired-intervention:latency-crossing",
            "closest_prior_art": ["ref:2"],
            "novelty_delta": "adds an empirical deadline crossover",
            "strongest_inversion": "always ask wins",
            "null_contribution": "bounds when simple interaction suffices",
            "kill_test": "two-world paired counterexample",
            "boundary_conditions": ["contact deadline"]
        });
        assert_eq!(hypothesis_impact_score(&entry), 84);
        assert_eq!(hypothesis_data_verifiability_score(&entry), 100);
        assert_eq!(hypothesis_reasoning_graph_score(&entry), 96);
        assert!(hypothesis_selection_score(&entry) >= 80);
    }

    #[test]
    fn self_reported_numbers_without_provenance_are_not_scientific_evidence() {
        let entry = json!({
            "statement": "A changes B.",
            "expected_impact_score": 99,
            "novelty_delta_score": 99,
            "evidence_quality_score": 99
        });
        assert_eq!(hypothesis_impact_score(&entry), 0);
        assert_eq!(hypothesis_selection_score(&entry), 0);
    }
}
