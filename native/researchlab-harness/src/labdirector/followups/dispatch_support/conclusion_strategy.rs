#![allow(unused_imports)]
use super::*;

pub(crate) fn active_conclusion_strategy_requery_action(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    if !conclusion_needs_hypothesis_strategy(paths, cycle_id)? {
        return Ok(None);
    }
    let review_path = state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
    if !review_path.exists() {
        return Ok(None);
    }
    let review = read_json(&review_path)?;
    let review_stamp = review
        .get("reviewed_at")
        .or_else(|| review.get("ts"))
        .and_then(Value::as_str)
        .map(|raw| {
            raw.chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .filter(|stamp| !stamp.is_empty())
        .or_else(|| {
            fs::metadata(&review_path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|mtime| mtime.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs().to_string())
        })
        .unwrap_or_else(|| "active".to_string());
    let review_actions = review
        .get("recommended_followup_actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut action = review_actions
        .iter()
        .find(|item| {
            item.get("type").and_then(Value::as_str) == Some("lab_director_requery_followup")
                || (item.get("preferred_role").and_then(Value::as_str) == Some("lab-director")
                    && item.get("target_rubric").and_then(Value::as_str)
                        == Some("hypothesis_strategy"))
        })
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "type": "lab_director_requery_followup",
                "preferred_role": "lab-director",
                "target_rubric": "hypothesis_strategy",
                "description": "Conclusion review still requires LabDirector hypothesis strategy requery before document-stage work can resume."
            })
        });
    action["type"] = json!("lab_director_requery_followup");
    action["preferred_role"] = json!("lab-director");
    action["target_rubric"] = json!("hypothesis_strategy");
    action["brief_id"] = json!(format!("conclusion-review-requery-{review_stamp}"));
    action["priority"] = json!("high");
    action["priority_score"] = json!(10_000);
    action["recovery_reason"] = json!("conclusion_requires_lab_director_requery");
    Ok(Some(action))
}
