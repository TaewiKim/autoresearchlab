#![allow(unused_imports)]
use super::*;

pub fn build_workgraph_projection(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for brief in cycle_briefs(paths, cycle_id)? {
        if let Some(claims) = brief.get("claim_deltas").and_then(Value::as_array) {
            for claim in claims {
                let claim_id = claim
                    .get("claim_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                nodes.push(json!({
                    "id": claim_id,
                    "kind": "claim",
                    "status": claim.get("current").and_then(Value::as_str).unwrap_or("tentative"),
                    "label": claim_id,
                }));
            }
        }
        if let Some(hypotheses) = brief.get("hypothesis_candidates").and_then(Value::as_array) {
            for (index, hypothesis) in hypotheses.iter().enumerate() {
                let hyp_id = format!(
                    "{}:hypothesis:{}",
                    brief
                        .get("brief_id")
                        .and_then(Value::as_str)
                        .unwrap_or("brief"),
                    index + 1
                );
                nodes.push(json!({
                    "id": hyp_id,
                    "kind": "hypothesis",
                    "status": "candidate",
                    "label": hypothesis,
                }));
                if let Some(claims) = brief.get("claim_deltas").and_then(Value::as_array) {
                    for claim in claims {
                        if let Some(claim_id) = claim.get("claim_id").and_then(Value::as_str) {
                            edges.push(json!({
                                "source": hyp_id,
                                "target": claim_id,
                                "type": "refines",
                            }));
                        }
                    }
                }
            }
        }
    }
    let output = viz_root(paths).join(format!("{cycle_id}-workgraph.json"));
    write_json(&output, &json!({ "nodes": nodes, "edges": edges }))?;
    Ok(output)
}

pub fn build_lane_timeline_projection(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let events = read_jsonl(&events_root(paths).join(format!("{cycle_id}-cycle-events.jsonl")))?;
    let output = viz_root(paths).join(format!("{cycle_id}-lane-timeline.json"));
    write_json(
        &output,
        &json!({
            "items": events.iter().map(|item| json!({
                "ts": item.get("ts").cloned().unwrap_or(Value::Null),
                "event_type": item.get("event_type").cloned().unwrap_or(Value::Null),
                "lane_id": item.get("payload").and_then(|p| p.get("lane_id")).cloned().unwrap_or(Value::Null),
                "status_hint": item.get("event_type").cloned().unwrap_or(Value::Null),
            })).collect::<Vec<_>>()
        }),
    )?;
    Ok(output)
}

pub fn build_chronicle_dialogue_projection(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let mut briefs = Vec::new();
    for brief in cycle_briefs(paths, cycle_id)? {
        briefs.push(json!({
            "brief_id": brief.get("brief_id").cloned().unwrap_or(Value::Null),
            "cycle_id": brief.get("cycle_id").cloned().unwrap_or(Value::Null),
            "open_questions": brief.get("open_questions").cloned().unwrap_or_else(|| json!([])),
            "recommended_actions": brief.get("recommended_actions").cloned().unwrap_or_else(|| json!([])),
            "strategy_advice": brief.get("strategy_advice").cloned().unwrap_or_else(|| json!({})),
        }));
    }
    let output = viz_root(paths).join(format!("{cycle_id}-chronicle-dialogue.json"));
    write_json(&output, &json!({ "briefs": briefs }))?;
    Ok(output)
}

pub fn build_report_workflow_projection(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let output = viz_root(paths).join(format!("{cycle_id}-report-workflow.json"));
    write_json(
        &output,
        &json!({
            "steps": [
                { "key": "outline", "status": "pending" },
                { "key": "sections", "status": "pending" },
                { "key": "full-report", "status": "pending" }
            ]
        }),
    )?;
    Ok(output)
}

pub fn build_aggregate_metrics_projection(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let cycle_state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    let cycle_state = if cycle_state_path.exists() {
        read_json(&cycle_state_path)?
    } else {
        json!({})
    };
    let output = viz_root(paths).join(format!("{cycle_id}-aggregate-metrics.json"));
    write_json(
        &output,
        &json!({
            "cycle_id": cycle_state.get("cycle_id").cloned().unwrap_or(Value::Null),
            "status": cycle_state.get("status").cloned().unwrap_or(Value::Null),
            "lane_counts": cycle_state.get("lane_counts").cloned().unwrap_or_else(|| json!({})),
            "aggregate_metrics": cycle_state.get("aggregate_metrics").cloned().unwrap_or_else(|| json!({})),
        }),
    )?;
    Ok(output)
}

pub fn build_all_projections(paths: &AppPaths, cycle_id: &str) -> Result<Vec<PathBuf>> {
    Ok(vec![
        build_workgraph_projection(paths, cycle_id)?,
        build_lane_timeline_projection(paths, cycle_id)?,
        build_chronicle_dialogue_projection(paths, cycle_id)?,
        build_report_workflow_projection(paths, cycle_id)?,
        build_aggregate_metrics_projection(paths, cycle_id)?,
    ])
}

pub(crate) fn next_revision(dir: &Path, prefix: &str, suffix: &str) -> Result<usize> {
    let mut max_revision = 0usize;
    if dir.exists() {
        for entry in read_dir(dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(prefix) || !name.ends_with(suffix) {
                continue;
            }
            let middle = name
                .trim_start_matches(prefix)
                .trim_end_matches(suffix)
                .trim_start_matches('v');
            if let Ok(value) = middle.parse::<usize>() {
                max_revision = max_revision.max(value);
            }
        }
    }
    Ok(max_revision + 1)
}
