#![allow(unused_imports)]
use super::*;

pub fn build_brief_for_lane(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
) -> Result<ChronicleBrief> {
    let lane_dir = lane_root(paths, cycle_id, lane_id);
    let result_path = lane_dir.join("result.json");
    let final_status_path = lane_dir.join("final-status.json");
    let compact_stats_result_path = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id)
        .join(lane_id)
        .join("result.json");
    let validation_summary_path = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id)
        .join(lane_id)
        .join("validation-summary.json");
    let analysis_trace_path = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id)
        .join(lane_id)
        .join("analysis-trace.json");
    let summary_path = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id)
        .join(lane_id)
        .join("summary.md");
    let result = read_result_for_brief(
        &result_path,
        &compact_stats_result_path,
        &validation_summary_path,
    )?;
    let final_status = read_json(&final_status_path).unwrap_or_else(|_| json!({}));
    let role_plan_summary = lane_role_plan_summary(paths, cycle_id, lane_id);

    if matches!(
        result.get("driver").and_then(Value::as_str),
        Some("literature-hypothesis-driver") | Some("literature-search-driver")
    ) {
        let claims = result
            .get("claims")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let hypotheses = result
            .get("hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let papers = result
            .get("papers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let themes = result
            .get("themes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let claim_deltas = claims
            .iter()
            .map(|claim| {
                let evidence_artifacts = vec![result_path.clone()];
                json!({
                    "claim_id": claim.get("claim_id").and_then(Value::as_str).unwrap_or("literature-claim"),
                    "previous": "tentative",
                    "current": claim.get("status").and_then(Value::as_str).unwrap_or("exploratory"),
                    "reason": claim.get("statement").and_then(Value::as_str).unwrap_or("literature-derived claim"),
                    "supporting_papers": claim.get("supporting_papers").cloned().unwrap_or_else(|| json!([])),
                    "evidence_paths": existing_path_strings(&evidence_artifacts),
                    "evidence_trace": build_claim_evidence_trace(lane_id, None, &evidence_artifacts),
                })
            })
            .collect::<Vec<_>>();

        let hypothesis_candidates = hypotheses
            .iter()
            .filter_map(|item| {
                item.get("statement")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>();

        let mut recommended_actions = hypotheses
            .iter()
            .map(|item| {
                json!({
                    "type": "literature_followup",
                    "priority": "high",
                    "description": item.get("statement").and_then(Value::as_str).unwrap_or("follow-up literature-derived hypothesis"),
                    "paper_support": item.get("paper_support").cloned().unwrap_or_else(|| json!([])),
                    "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or(Value::Null),
                    "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();

        if recommended_actions.is_empty() && !papers.is_empty() {
            recommended_actions.push(json!({
                "type": "labdirector_literature_synthesis",
                "priority": "high",
                "description": "lab_director should synthesize hypotheses and claims from retrieved papers",
            }));
        }

        let top_papers = papers
            .iter()
            .take(5)
            .map(|paper| {
                json!({
                    "title": paper.get("title").cloned().unwrap_or(Value::Null),
                    "year": paper.get("year").cloned().unwrap_or(Value::Null),
                    "doi": paper.get("doi").cloned().unwrap_or(Value::Null),
                    "abstract_snippet": paper.get("abstract_snippet").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();

        let mut open_questions = themes
            .iter()
            .filter_map(|item| {
                item.get("theme")
                    .and_then(Value::as_str)
                    .map(|theme| format!("literature theme to validate in data: {theme}"))
            })
            .collect::<Vec<_>>();
        if open_questions.is_empty() && !papers.is_empty() {
            open_questions.push(
                "lab_director needs to derive explicit literature-backed hypotheses from retrieved papers"
                    .to_string(),
            );
        }

        let mut brief = ChronicleBrief {
            brief_id: format!("brief-{}", Uuid::new_v4().simple()),
            cycle_id: cycle_id.to_string(),
            claim_deltas,
            lane_summaries: vec![json!({
                "lane_id": lane_id,
                "status": final_status.get("status").and_then(Value::as_str).unwrap_or("unknown"),
                "summary": format!("{lane_id} literature lane completed"),
                "top_papers": top_papers,
                "role_plan": role_plan_summary,
            })],
            open_questions,
            recommended_actions,
            hypothesis_candidates,
            strategy_advice: json!({
                "mode": "refine",
                "reason": "literature-derived hypotheses are available for data validation",
            }),
        };
        enrich_brief_from_structured_result(&mut brief, &result);
        let output =
            chronicle_briefs_root(paths, cycle_id).join(format!("{}.json", brief.brief_id));
        write_json(&output, &serde_json::to_value(&brief)?)?;
        upsert_cycle_brief_index(paths, cycle_id, &brief)?;
        publish_brief_report(paths, &brief, lane_id)?;
        return Ok(brief);
    }

    let correlations = result
        .get("stats")
        .and_then(|item| item.get("correlations"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let evidence_grade = result
        .get("stats")
        .and_then(|item| item.get("evidence_grade"))
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut claim_deltas = Vec::new();
    let mut open_questions = Vec::new();
    let mut recommended_actions = Vec::new();
    let mut hypothesis_candidates = Vec::new();
    // Count how many correlation pairs the stats lane emitted with a real
    // numeric value. Replaces the old `corr_life.is_some() && corr_neonatal.is_some()`
    // gate (which implicitly required the WHO DTP3 analysis) with a generic
    // "at least one correlation observed" gate that works for any domain.
    let mut correlation_pairs_observed = 0usize;
    let selected_hypotheses = result
        .get("selected_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let all_hypotheses = result
        .get("hypothesis_results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected_hypothesis_ids = selected_hypotheses
        .iter()
        .filter_map(|item| item.get("hypothesis_id").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let lane_artifact_paths = vec![
        result_path.clone(),
        validation_summary_path.clone(),
        analysis_trace_path.clone(),
        summary_path.clone(),
        final_status_path.clone(),
    ];
    let common_evidence_paths = existing_path_strings(&lane_artifact_paths);
    let selected_hypothesis_ids_for = |needle: &str| -> Vec<String> {
        let lowered = needle.to_lowercase();
        selected_hypotheses
            .iter()
            .filter(|item| {
                item.get("hypothesis_id")
                    .and_then(Value::as_str)
                    .map(|value| value.to_lowercase().contains(&lowered))
                    .unwrap_or(false)
                    || item
                        .get("statement")
                        .and_then(Value::as_str)
                        .map(|value| value.to_lowercase().contains(&lowered))
                        .unwrap_or(false)
            })
            .filter_map(|item| item.get("hypothesis_id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };

    // Iterate every correlation pair the stats lane reported, rather than only
    // the two WHO-specific keys (`dtp3_vs_life_expectancy`,
    // `dtp3_vs_neonatal_mortality`). Each correlation key follows the convention
    // `<exposure>_vs_<outcome>`, and evidence_grade is looked up per outcome as
    // `<outcome>_link`. Anything below the 0.3 magnitude threshold (or graded
    // `weak`) is demoted to an open question so the planner knows where the
    // evidence is still thin.
    if let Some(correlations_map) = correlations.as_object() {
        for (corr_key, corr_value) in correlations_map {
            let Some(value) = corr_value.as_f64() else {
                continue;
            };
            if !value.is_finite() {
                continue;
            }
            correlation_pairs_observed += 1;
            let outcome_slug = corr_key
                .split_once("_vs_")
                .map(|(_, outcome)| outcome.to_string());
            let grade = outcome_slug
                .as_deref()
                .map(|slug| format!("{slug}_link"))
                .and_then(|key| {
                    evidence_grade
                        .get(&key)
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "weak".to_string());
            let claim_id = format!("claim-{corr_key}");
            let magnitude = value.abs();
            let direction = if value > 0.0 { "positive" } else { "negative" };
            if magnitude > 0.3 && grade != "weak" {
                let hypothesis_needle =
                    outcome_slug.as_deref().unwrap_or_else(|| corr_key.as_str());
                claim_deltas.push(json!({
                    "claim_id": claim_id.clone(),
                    "previous": "tentative",
                    "current": if grade == "robust" { "robust" } else { "exploratory" },
                    "reason": format!(
                        "{direction} association detected for {corr_key} ({value:.3}) with evidence grade {grade}",
                    ),
                    "supporting_lanes": [lane_id],
                    "supporting_hypotheses": selected_hypothesis_ids_for(hypothesis_needle),
                    "supporting_papers": [],
                    "evidence_paths": common_evidence_paths.clone(),
                    "evidence_trace": build_claim_evidence_trace(lane_id, Some(&claim_id), &lane_artifact_paths),
                }));
            } else {
                open_questions.push(format!(
                    "association measured for {corr_key} (ρ={value:.3}, grade={grade}) is weak or unstable",
                ));
            }
        }
    }

    let sufficient_correlations_for_followup = correlation_pairs_observed >= 2;
    if sufficient_correlations_for_followup {
        recommended_actions.push(json!({
            "type": "followup_experiment",
            "priority": "high",
            "description": "run region-stratified analysis and outlier review",
            "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or_else(|| json!("technical_quality")),
            "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
        }));
        recommended_actions.push(json!({
            "type": "followup_literature",
            "priority": "medium",
            "description": "gather papers on moderators, confounds, and differential regional effects",
            "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or_else(|| json!("novelty")),
            "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
        }));
        recommended_actions.push(json!({
            "type": "data_acquisition_followup",
            "priority": "medium",
            "description": "search for additional open datasets that can add confounders, alternate outcomes, subgroup coverage, or stronger external validation for the current hypothesis set",
            "preferred_role": "scout",
            "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or_else(|| json!("technical_quality")),
            "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
        }));
    }

    for item in &selected_hypotheses {
        if let Some(statement) = item.get("statement").and_then(Value::as_str) {
            hypothesis_candidates.push(statement.to_string());
        }
        match item.get("status").and_then(Value::as_str).unwrap_or("weak") {
            "weak" => {
                if let Some(statement) = item.get("statement").and_then(Value::as_str) {
                    open_questions.push(format!("needs stronger evidence: {statement}"));
                }
            }
            "exploratory" | "robust" => {
                if let Some(hypothesis_id) = item.get("hypothesis_id").and_then(Value::as_str) {
                    claim_deltas.push(json!({
                        "claim_id": hypothesis_id,
                        "previous": "tentative",
                        "current": item.get("status").and_then(Value::as_str).unwrap_or("exploratory"),
                        "reason": item.get("statement").and_then(Value::as_str).unwrap_or("hypothesis evaluated by statistics lane"),
                        "supporting_lanes": [lane_id],
                        "supporting_hypotheses": [hypothesis_id],
                        "supporting_papers": [],
                        "evidence_paths": common_evidence_paths,
                        "evidence_trace": build_claim_evidence_trace(lane_id, Some(hypothesis_id), &lane_artifact_paths),
                    }));
                }
            }
            _ => {}
        }
    }

    let weak_families = all_hypotheses
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("weak"))
        .filter_map(|item| item.get("family").and_then(Value::as_str))
        .take(4)
        .collect::<Vec<_>>();
    for family in weak_families {
        recommended_actions.push(json!({
            "type": "followup_experiment",
            "priority": "medium",
            "description": format!("run additional analysis for weak hypothesis family: {family}"),
            "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or_else(|| json!("reproducibility")),
            "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
        }));
    }
    if !open_questions.is_empty() {
        recommended_actions.push(json!({
            "type": "data_acquisition_followup",
            "priority": "high",
            "preferred_role": "scout",
            "description": "search for and add new open-source datasets that can resolve current open questions, cover missing confounders, or test the weak hypothesis families with new variables",
            "target_rubric": role_plan_summary.get("target_rubric").cloned().unwrap_or_else(|| json!("reproducibility")),
            "target_score": role_plan_summary.get("target_score").cloned().unwrap_or(Value::Null),
            "current_score": role_plan_summary.get("current_score").cloned().unwrap_or(Value::Null),
        }));
    }

    let mut brief = ChronicleBrief {
        brief_id: format!("brief-{}", Uuid::new_v4().simple()),
        cycle_id: cycle_id.to_string(),
        claim_deltas,
        lane_summaries: vec![json!({
            "lane_id": lane_id,
            "status": final_status.get("status").and_then(Value::as_str).unwrap_or("unknown"),
            "summary": format!("{lane_id} lane completed"),
            "selected_hypothesis_count": selected_hypotheses.len(),
            "available_hypothesis_count": all_hypotheses.len(),
            "selected_hypothesis_ids": selected_hypothesis_ids,
            "role_plan": role_plan_summary,
        })],
        open_questions,
        recommended_actions,
        hypothesis_candidates,
        strategy_advice: json!({
            "mode": if sufficient_correlations_for_followup { "refine" } else { "hold" },
            "reason": if sufficient_correlations_for_followup { "follow-up regional analysis recommended" } else { "initial signal is stable enough for reporting" },
        }),
    };
    enrich_brief_from_structured_result(&mut brief, &result);
    let output = chronicle_briefs_root(paths, cycle_id).join(format!("{}.json", brief.brief_id));
    write_json(&output, &serde_json::to_value(&brief)?)?;
    upsert_cycle_brief_index(paths, cycle_id, &brief)?;
    publish_brief_report(paths, &brief, lane_id)?;
    Ok(brief)
}

pub(crate) const BRIEF_RESULT_READ_LIMIT_BYTES: u64 = 5 * 1024 * 1024;

pub(crate) fn read_json_if_below(path: &Path, max_bytes: u64) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let size = fs::metadata(path).ok()?.len();
    if size > max_bytes {
        return None;
    }
    read_json(path).ok()
}

pub(crate) fn read_result_for_brief(
    lane_result_path: &Path,
    compact_stats_result_path: &Path,
    validation_summary_path: &Path,
) -> Result<Value> {
    if let Some(result) = read_json_if_below(lane_result_path, BRIEF_RESULT_READ_LIMIT_BYTES) {
        return Ok(result);
    }
    if let Some(result) =
        read_json_if_below(compact_stats_result_path, BRIEF_RESULT_READ_LIMIT_BYTES)
    {
        return Ok(result);
    }
    if let Some(validation_summary) =
        read_json_if_below(validation_summary_path, BRIEF_RESULT_READ_LIMIT_BYTES)
    {
        return Ok(json!({
            "driver": "python-stats-driver",
            "status": "completed_with_compact_validation_summary",
            "validation_summary": validation_summary,
            "summary": "lane result was too large for repeated chronicle brief reads; compact validation summary was used instead",
            "stats": {
                "correlations": {},
                "evidence_grade": {}
            },
            "selected_hypotheses": [],
            "hypothesis_results": []
        }));
    }
    Ok(json!({
        "driver": "large-result-skipped",
        "status": "completed_with_large_result_skipped",
        "summary": "lane result exceeded chronicle brief read limit and no compact stats artifact was available",
    }))
}

pub(crate) fn extract_first_json_object_from_line(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;

    for (idx, &b) in bytes.iter().enumerate() {
        if start.is_none() {
            if b == b'{' {
                start = Some(idx);
                depth = 1;
                in_string = false;
                escape = false;
            }
            continue;
        }

        if in_string {
            if escape {
                escape = false;
                continue;
            }
            match b {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let begin = start?;
                    let candidate = &text[begin..=idx];
                    if let Ok(parsed) = serde_json::from_str::<Value>(candidate) {
                        return Some(parsed);
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }
    None
}

pub fn read_jsonl(path: &Path) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(path)?;
    let mut items = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            items.push(parsed);
            continue;
        }
        if let Some(parsed) = extract_first_json_object_from_line(trimmed) {
            items.push(parsed);
        }
    }
    Ok(items)
}
