#![allow(unused_imports)]
use super::*;

pub(crate) fn collect_brief_priority_inputs(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
    hypothesis_index: &mut HashMap<String, Value>,
) -> Result<()> {
    let brief_index_path = state_root(paths).join(format!("{cycle_id}-brief-index.json"));
    if fs::metadata(&brief_index_path)
        .map(|metadata| metadata.len() > 5 * 1024 * 1024)
        .unwrap_or(false)
    {
        return Ok(());
    }
    for brief in cycle_briefs(paths, cycle_id)? {
        let brief_id = brief
            .get("brief_id")
            .and_then(Value::as_str)
            .unwrap_or("brief");

        for action in brief
            .get("recommended_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("follow-up action");
            let action_type = action
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("followup_experiment");
            let inferred_preferred_role =
                action.get("preferred_role").cloned().unwrap_or_else(|| {
                    let lowered_type = action_type.to_lowercase();
                    let lowered_description = description.to_lowercase();
                    if lowered_type.contains("state_sync")
                        || lowered_type.contains("hypothesis_sync")
                        || lowered_description.contains("shared state")
                    {
                        json!("lab-director")
                    } else if lowered_type.contains("claim_trace")
                        || lowered_type.contains("chronicle")
                        || lowered_description.contains("claim trace")
                    {
                        json!("chronicle")
                    } else if lowered_type.contains("literature")
                        || lowered_type.contains("backfill")
                        || lowered_description.contains("literature")
                    {
                        json!("scout")
                    } else {
                        Value::Null
                    }
                });
            let priority_score = match action
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or("medium")
            {
                "high" => 100,
                "medium" => 60,
                _ => 30,
            };
            let mut priority_action = json!({
                "brief_id": brief_id,
                "description": description,
                "type": action_type,
                "priority_score": priority_score + if action.get("target_rubric").and_then(Value::as_str).is_some() { 15 } else { 0 },
                "preferred_role": inferred_preferred_role,
                "target_rubric": action.get("target_rubric").cloned().unwrap_or(Value::Null),
                "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
            });
            // Literature recovery resumes the source lane's reviewed corpus.
            // Dropping these paths turns a gap-specific inquiry into another
            // full retrieval/review pass when the action reaches the scheduler.
            for key in [
                "source_lane_id",
                "runtime_class",
                "literature_review_source_dir",
                "literature_review_role_plan_path",
                "literature_review_queue_path",
                "search_agent_contract",
                "search_agent_journal_path",
                "search_agent_synthesis_path",
                "search_agent_assessment",
                "search_agent_journal_resume_path",
                "coverage_gaps",
                "next_search_decisions",
            ] {
                if let Some(value) = action.get(key) {
                    priority_action[key] = value.clone();
                }
            }
            priority_actions.push(priority_action);
        }

        for hypothesis in brief
            .get("hypothesis_candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if let Some(statement) = hypothesis.as_str() {
                let lowered = statement.to_lowercase();
                let mut priority_score = 40i64;
                if lowered.contains("primary")
                    || lowered.contains("lead")
                    || lowered.contains("promoted")
                {
                    priority_score += 15;
                }
                if lowered.contains("subgroup")
                    || lowered.contains("region")
                    || lowered.contains("moderate")
                {
                    priority_score += 15;
                }
                if lowered.contains("confound") || lowered.contains("adjust") {
                    priority_score += 10;
                }
                let key = slugify(statement);
                let entry = hypothesis_index.entry(key).or_insert_with(|| {
                    json!({
                        "statement": statement,
                        "priority_score": priority_score,
                        "support_count": 0,
                        "source_brief_ids": [],
                    })
                });
                let support_count = entry
                    .get("support_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + 1;
                entry["support_count"] = json!(support_count);
                let current_priority = entry
                    .get("priority_score")
                    .and_then(Value::as_i64)
                    .unwrap_or(priority_score);
                if priority_score > current_priority {
                    entry["priority_score"] = json!(priority_score);
                }
                let mut source_brief_ids = entry
                    .get("source_brief_ids")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !source_brief_ids
                    .iter()
                    .any(|item| item.as_str() == Some(brief_id))
                {
                    source_brief_ids.push(json!(brief_id));
                }
                entry["source_brief_ids"] = json!(source_brief_ids);
            }
        }
    }
    Ok(())
}

pub(crate) fn collect_literature_summary_hypotheses(
    paths: &AppPaths,
    cycle_id: &str,
    hypothesis_index: &mut HashMap<String, Value>,
) -> Result<()> {
    let literature_summary_path =
        plans_root(paths).join(format!("{cycle_id}-lab-director-literature.json"));
    if !literature_summary_path.exists()
        || fs::metadata(&literature_summary_path)?.len() > 5 * 1024 * 1024
    {
        return Ok(());
    }
    let literature = read_json(&literature_summary_path)?;
    for lane in literature
        .get("lanes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let lane_role = lane.get("role").and_then(Value::as_str).unwrap_or("scout");
        for hypothesis in lane
            .get("hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let statement = hypothesis
                .get("statement")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if statement.is_empty() {
                continue;
            }
            let key = hypothesis
                .get("hypothesis_id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| slugify(&statement));
            let paper_support = hypothesis
                .get("paper_support")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let entry = hypothesis_index.entry(key).or_insert_with(|| {
                json!({
                    "statement": statement,
                    "priority_score": 50,
                    "support_count": 0,
                    "source_brief_ids": [],
                    "paper_examples": [],
                    "support_basis": ["literature"],
                    "evidence_roles": [lane_role],
                    "role_diversity_count": 1,
                    "evidence_quality_score": 40,
                })
            });
            entry["support_count"] = json!(
                entry
                    .get("support_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + 1
            );
            let mut papers = entry
                .get("paper_examples")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for paper in paper_support {
                if !papers.iter().any(|item| item == &paper) {
                    papers.push(paper);
                }
            }
            entry["paper_examples"] = json!(papers);
            let mut roles = entry
                .get("evidence_roles")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !roles.iter().any(|item| item.as_str() == Some(lane_role)) {
                roles.push(json!(lane_role));
            }
            entry["evidence_roles"] = json!(roles.clone());
            entry["role_diversity_count"] = json!(roles.len());
            let quality = 35
                + (entry
                    .get("support_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(4) as i64
                    * 6)
                + (entry
                    .get("paper_examples")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0)
                    .min(4) as i64
                    * 4)
                + (roles.len().min(3) as i64 * 6);
            entry["evidence_quality_score"] = json!(quality.min(100));
        }
    }
    Ok(())
}

pub(crate) fn collect_labdirector_dialogue_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    // The recent hours of the dialogue, up to 10 MB of them. As one file this
    // was skipped whenever the file was larger than 10 MB -- which, on
    // cycle-a-20260919, it was for all but the first minutes after
    // each 64 MB rotation, so chronicle's requested focus was almost never read.
    let dialogue = crate::core::support::segmented_log::labdirector_dialogue_log(paths, cycle_id);
    let mut items = Vec::new();
    for segment in dialogue.newest_within(10 * 1024 * 1024) {
        if fs::metadata(&segment)?.len() > 10 * 1024 * 1024 {
            continue;
        }
        items.extend(read_jsonl(&segment)?);
    }
    for item in items {
        if item.get("event_type").and_then(Value::as_str) != Some("chronicle_response") {
            continue;
        }
        if let Some(payload) = item.get("payload") {
            for focus in payload
                .get("requested_next_focus")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let description = focus.as_str().unwrap_or("chronicle-requested focus area");
                priority_actions.push(json!({
                    "brief_id": "chronicle-response",
                    "description": description,
                    "type": "chronicle_requested_focus",
                    "priority_score": 95,
                    "preferred_role": "analyst",
                    "target_rubric": Value::Null,
                    "target_score": Value::Null,
                    "current_score": Value::Null,
                    "blocker_reasons": payload
                        .get("must_resolve_blockers")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                }));
            }
            for frame in payload
                .get("brainstorm")
                .and_then(|item| item.get("frames"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let description = frame
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("run a structured brainstorming pass");
                let preferred_role = frame
                    .get("preferred_role")
                    .and_then(Value::as_str)
                    .unwrap_or("analyst");
                priority_actions.push(json!({
                    "brief_id": "chronicle-response",
                    "description": description,
                    "type": "chronicle_brainstorm_followup",
                    "priority_score": 104,
                    "preferred_role": preferred_role,
                    "target_rubric": frame.get("target_rubric").cloned().unwrap_or_else(|| json!("novelty")),
                    "target_score": Value::Null,
                    "current_score": Value::Null,
                    "blocker_reasons": payload
                        .get("must_resolve_blockers")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                    "brainstorm_frame": frame.get("frame").cloned().unwrap_or(Value::Null),
                    "brainstorm_question": frame.get("question").cloned().unwrap_or(Value::Null),
                }));
            }
            for evidence_type in payload
                .get("required_evidence_types")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let evidence_type = evidence_type.as_str().unwrap_or("required_evidence");
                let (preferred_role, description, priority_score) = match evidence_type {
                    "robust_analysis_lane" | "confound_or_sensitivity_check" => (
                        "lab-runner",
                        "run a stronger robustness or confound-control analysis to satisfy Chronicle's evidence request",
                        108,
                    ),
                    "literature_backed_rationale" => (
                        "scout",
                        "retrieve more direct supporting literature to satisfy Chronicle's evidence request",
                        102,
                    ),
                    "role_diverse_validation" => (
                        "analyst",
                        "produce cross-role validation so LabDirector can test whether the conclusion is role-diverse",
                        100,
                    ),
                    "claim_to_evidence_trace" => (
                        "chronicle",
                        "tighten claim-to-evidence traceability so LabDirector can inspect each promoted claim critically",
                        94,
                    ),
                    "moderator_or_confound_resolution" => (
                        "analyst",
                        "identify the most decision-relevant moderator or confound still unresolved by Chronicle",
                        98,
                    ),
                    _ => (
                        "analyst",
                        "gather the additional evidence requested by Chronicle",
                        90,
                    ),
                };
                priority_actions.push(json!({
                    "brief_id": "chronicle-response",
                    "description": description,
                    "type": "chronicle_required_evidence",
                    "priority_score": priority_score,
                    "preferred_role": preferred_role,
                    "target_rubric": Value::Null,
                    "target_score": Value::Null,
                    "current_score": Value::Null,
                    "blocker_reasons": payload
                        .get("must_resolve_blockers")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                }));
            }
        }
    }
    Ok(())
}

pub(crate) fn collect_conclusion_review_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let conclusion_review_path =
        state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
    if !conclusion_review_path.exists() {
        return Ok(());
    }
    let conclusion_review = read_json(&conclusion_review_path)?;
    for action in conclusion_review
        .get("recommended_followup_actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let description = action
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("approval-driven follow-up action");
        let action_type = action
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("conclusion_followup");
        let preferred_role = action
            .get("preferred_role")
            .and_then(Value::as_str)
            .unwrap_or("lab-runner");
        let target_rubric = action
            .get("target_rubric")
            .and_then(Value::as_str)
            .unwrap_or("");
        let conclusion_strategy_requery = action_type == "lab_director_requery_followup"
            || (preferred_role == "lab-director" && target_rubric == "hypothesis_strategy");
        let priority_score = if conclusion_strategy_requery {
            10_000
        } else {
            match action
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or("medium")
            {
                "high" => 110,
                "medium" => 70,
                _ => 40,
            }
        };
        let priority = if conclusion_strategy_requery {
            json!("high")
        } else {
            action
                .get("priority")
                .cloned()
                .unwrap_or_else(|| json!("medium"))
        };
        let recovery_reason = if conclusion_strategy_requery {
            json!("conclusion_requires_lab_director_requery")
        } else {
            action
                .get("recovery_reason")
                .cloned()
                .unwrap_or(Value::Null)
        };
        priority_actions.push(json!({
            "brief_id": "conclusion-review",
            "description": description,
            "type": action.get("type").cloned().unwrap_or_else(|| json!("conclusion_followup")),
            "priority": priority,
            "priority_score": priority_score,
            "preferred_role": action.get("preferred_role").cloned().unwrap_or_else(|| json!("lab-runner")),
            "target_rubric": action.get("target_rubric").cloned().unwrap_or(Value::Null),
            "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
            "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
            "candidate_hypotheses": action.get("candidate_hypotheses").cloned().unwrap_or_else(|| json!([])),
            "schema_quality": action.get("schema_quality").cloned().unwrap_or(Value::Null),
            "recovery_reason": recovery_reason,
        }));
    }
    Ok(())
}
