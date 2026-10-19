use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use crate::core::model::AppPaths;
use crate::core::support::{read_json, read_json_cached, state_root};

use super::artifact_readiness::{
    chronicle_graph_artifacts_ready, lab_director_hypothesis_is_usable,
};
use super::completed_labdirector_requery_at_or_after;
use super::cycle_objective;
use super::hypothesis_frontier::{
    forbidden_dataset_terms_from_text, value_contains_forbidden_dataset_term,
};
use super::json_window::json_top_level_bool_window;
use super::lane_counts::{completed_data_scout_count, completed_literature_scout_count};

pub(crate) fn conclusion_needs_hypothesis_strategy(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let review_path = state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
    if !review_path.exists() {
        return Ok(false);
    }
    let review = read_json(&review_path)?;
    if review
        .get("conclusion_gate_passed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let needs_requery = review
        .get("recommended_followup_actions")
        .and_then(Value::as_array)
        .map(|actions| {
            actions.iter().any(|action| {
                let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
                let preferred_role = action
                    .get("preferred_role")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let target_rubric = action
                    .get("target_rubric")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                action_type == "lab_director_requery_followup"
                    || action_type.starts_with("hypothesis_regeneration")
                    || (preferred_role == "lab-director" && target_rubric == "hypothesis_strategy")
            })
        })
        .unwrap_or(false);
    if !needs_requery {
        return Ok(false);
    }
    let review_completed_at = review
        .get("reviewed_at")
        .and_then(Value::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
        .or_else(|| {
            fs::metadata(&review_path)
                .and_then(|meta| meta.modified())
                .ok()
                .map(DateTime::<Utc>::from)
        });
    if completed_labdirector_requery_at_or_after(paths, cycle_id, review_completed_at)? {
        return Ok(false);
    }
    Ok(true)
}

/// An explicit owner authorisation to run the DOCUMENT stage on a cycle the gate
/// did not pass.
///
/// cycle-g-v89 measured why this needs to exist and why it must not be a flag
/// flip: 100 runner lanes, 93 of them clean, 27 distinct methods against one
/// research question, every one failing the same preregistered false-safe bound --
/// and technical_quality 98 / reproducibility 86 / clarity 91 against novelty 64
/// and impact 62. Real work, an honest reject.
///
/// Writing `gate_passed: true` would have been one line, and would have asserted
/// something false about prior art that every downstream artifact inherits.
/// cycle-g-v62 is the recorded cost of that shortcut: score 98 and approval-ready
/// on all-null evidence.
///
/// This releases the author and illustrator lanes and nothing else. The gate
/// review keeps its verdict, `hypothesis_gate_passed` keeps returning false, and
/// the authorisation file carries the scores as they stood so the paper can state
/// what was known when the call was made.
pub(crate) fn document_stage_authorized(paths: &AppPaths, cycle_id: &str) -> bool {
    let path = state_root(paths).join(format!("{cycle_id}-document-authorization.json"));
    let value = match read_json(&path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    if value.get("authorized").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    // A reason is required: an authorisation nobody can account for later is the
    // same as a silently loosened gate.
    value
        .get("reason")
        .and_then(Value::as_str)
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

pub(crate) fn hypothesis_gate_passed(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !review_path.exists() {
        return Ok(false);
    }
    if let Some(value) = json_top_level_bool_window(&review_path, "gate_passed")? {
        return Ok(value);
    }
    if let Some(value) = json_top_level_bool_window(&review_path, "hypothesis_gate_passed")? {
        return Ok(value);
    }
    Ok(false)
}

fn compact_text_for_policy(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn collect_gate_review_comments(
    value: &Value,
    comments: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::String(text) => {
            let compact = compact_text_for_policy(text, 360);
            if compact.len() >= 24 && seen.insert(compact.clone()) {
                comments.push(compact);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_gate_review_comments(item, comments, seen);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                let key_lc = key.to_ascii_lowercase();
                let relevant = key_lc.contains("comment")
                    || key_lc.contains("reason")
                    || key_lc.contains("objection")
                    || key_lc.contains("blocker")
                    || key_lc.contains("summary")
                    || key_lc.contains("validation")
                    || key_lc.contains("trigger")
                    || key_lc.contains("alternative")
                    || key_lc.contains("recommendation")
                    || key_lc.contains("action");
                if relevant {
                    collect_gate_review_comments(item, comments, seen);
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn gate_restart_policy_from_review(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !review_path.exists() {
        return None;
    }
    let review = read_json(&review_path).ok()?;
    let gatekeeper_review = review
        .get("gatekeeper_review")
        .cloned()
        .unwrap_or(Value::Null);
    let verdict = review
        .get("verdict")
        .or_else(|| gatekeeper_review.get("verdict"))
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let mut comments = Vec::new();
    let mut seen = HashSet::new();
    for key in [
        "scientific_gate_comments",
        "major_objections",
        "missing_validations",
        "switch_triggers",
        "incumbent_rejection_reasons",
        "same_family_alternatives",
        "cross_family_alternatives",
        "family_switch_recommendations",
        "better_alternative_hypotheses",
        "gatekeeper_review",
        "gatekeeper_reviews_normalized",
        "gatekeeper_reviews",
        "recommended_followup_actions",
        "recommended_actions",
        "blockers",
    ] {
        if let Some(value) = review.get(key) {
            collect_gate_review_comments(value, &mut comments, &mut seen);
        }
    }
    let total_unique = comments.len();
    let examples: Vec<Value> = comments
        .into_iter()
        .take(80)
        .map(|comment| json!(comment))
        .collect();
    Some(json!({
        "source": "native_gate_review_restart_policy",
        "gate_review_path": review_path,
        "gate_score": review.get("score").or_else(|| review.get("gate_score")).or_else(|| review.get("hypothesis_gate_score")).cloned().unwrap_or(Value::Null),
        "gate_verdict": verdict,
        "gate_passed": review.get("gate_passed").or_else(|| review.get("pass")).cloned().unwrap_or(Value::Null),
        "rubric_scores": review.get("rubric").cloned().unwrap_or(Value::Null),
        "major_objections": review.get("major_objections").cloned().unwrap_or_else(|| json!([])),
        "missing_validations": review.get("missing_validations").cloned().unwrap_or_else(|| json!([])),
        "switch_triggers": review.get("switch_triggers").cloned().unwrap_or_else(|| json!([])),
        "incumbent_rejection_reasons": review.get("incumbent_rejection_reasons").cloned().unwrap_or_else(|| json!([])),
        "family_switch_recommendations": review.get("family_switch_recommendations").cloned().unwrap_or_else(|| json!([])),
        "cross_family_alternatives": review.get("cross_family_alternatives").cloned().unwrap_or_else(|| json!([])),
        "better_alternative_hypotheses": review.get("better_alternative_hypotheses").cloned().unwrap_or_else(|| json!([])),
        "gatekeeper_review": gatekeeper_review,
        "review_comment_manifest": {
            "source_path": review_path,
            "total_unique_comment_count": total_unique,
            "compaction": "unique gate review comments compacted to 360 chars; full source JSON path preserved",
            "comments": examples,
        },
        "mandatory_restart_steps": [
            "Treat gatekeeper reject as a hard restart demand, not a same-family patch request.",
            "Restart from literature/data search and rerank at least three mechanism-level families.",
            "Switch away from the rejected incumbent family unless an explicit evidence-backed override is recorded.",
            "Bind the selected new family to named datasets/accessions, same-dataset baselines, explicit exposure/outcome/covariates, and falsification criteria before validation resumes."
        ]
    }))
}

pub(crate) fn explicit_hypothesis_gate_failed(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    let review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !review_path.exists() {
        return Ok(false);
    }
    if let Some(value) = json_top_level_bool_window(&review_path, "hypothesis_gate_passed")? {
        return Ok(!value);
    }
    let review = read_json_cached(&review_path).unwrap_or(Value::Null);
    let restart_recommended = review
        .get("restart_recommended")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let verdict_reject = review.get("verdict").and_then(Value::as_str) == Some("reject");
    if restart_recommended || verdict_reject {
        return Ok(true);
    }

    let gate_passed_false = review.get("gate_passed").and_then(Value::as_bool) == Some(false);
    let low_gate_score = review
        .get("score")
        .or_else(|| review.get("hypothesis_gate_score"))
        .and_then(Value::as_f64)
        .map(|score| score < 50.0)
        .unwrap_or(false);
    let scientific_blockers_present = review
        .get("gate_scientific_blockers")
        .or_else(|| review.get("major_objections"))
        .or_else(|| review.get("missing_validations"))
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let review_actions = review
        .get("recommended_followup_actions")
        .or_else(|| review.get("recommended_actions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let restart_or_requery_requested = review_actions.iter().any(|action| {
        matches!(
            action.get("type").and_then(Value::as_str).unwrap_or(""),
            "gate_restart_followup"
                | "lab_director_requery_followup"
                | "hypothesis_regeneration_followup"
                | "hypothesis_regeneration_synthesis_followup"
        )
    });

    Ok(gate_passed_false
        && (low_gate_score || scientific_blockers_present || restart_or_requery_requested))
}

fn lab_director_stage_gate_override_active(paths: &AppPaths, cycle_id: &str, stage: &str) -> bool {
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let objective = cycle_objective(paths, cycle_id);
    let forbidden_terms = super::effective_forbidden_dataset_terms(paths, cycle_id, &objective);
    if hypothesis_path.exists() {
        if let Ok(hypothesis) = read_json(&hypothesis_path) {
            if value_contains_forbidden_dataset_term(&hypothesis, &forbidden_terms) {
                return false;
            }
            let override_block = hypothesis
                .get("lab_director_stage_gate_override")
                .or_else(|| hypothesis.get("stage_gate_override"));
            if let Some(override_block) = override_block {
                let approved = override_block
                    .get("approved")
                    .or_else(|| override_block.get("decision_override"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let target_stage = override_block
                    .get("stage")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let rationale_present = override_block
                    .get("rationale")
                    .or_else(|| override_block.get("reason"))
                    .and_then(Value::as_str)
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false);
                if approved && target_stage == stage && rationale_present {
                    return true;
                }
            }
        }
    }
    let notes_path = state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json"));
    if !notes_path.exists() {
        return false;
    }
    let Ok(notes) = read_json(&notes_path) else {
        return false;
    };
    if stage == "hypothesis_generation" {
        if let Some(decision) = notes.get("latest_lab_director_decision") {
            if value_contains_forbidden_dataset_term(decision, &forbidden_terms) {
                return false;
            }
            let decision_rationale_present = decision
                .get("rationale")
                .or_else(|| decision.get("summary"))
                .and_then(Value::as_str)
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false);
            let decision_keeps_or_replaces_lead =
                matches!(
                    decision.get("requery_decision").and_then(Value::as_str),
                    Some("uphold") | Some("replace") | Some("select") | Some("selected")
                ) || decision.get("selected_hypothesis").is_some();
            let selected_lead_present = decision
                .get("selected_hypothesis")
                .or_else(|| notes.get("current_lead_hypothesis"))
                .and_then(|lead| {
                    lead.get("statement")
                        .or_else(|| lead.get("hypothesis"))
                        .and_then(Value::as_str)
                })
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false);
            if decision_rationale_present
                && decision_keeps_or_replaces_lead
                && selected_lead_present
            {
                return true;
            }
        }
    }
    notes
        .get("latest_lab_director_decision")
        .and_then(|decision| decision.get("stage_gate_override"))
        .map(|override_block| {
            !value_contains_forbidden_dataset_term(override_block, &forbidden_terms)
                && !notes
                    .get("latest_lab_director_decision")
                    .is_some_and(|decision| {
                        value_contains_forbidden_dataset_term(decision, &forbidden_terms)
                    })
                && override_block
                    .get("approved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && override_block.get("stage").and_then(Value::as_str) == Some(stage)
                && override_block
                    .get("rationale")
                    .and_then(Value::as_str)
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

pub(crate) fn validation_materialization_gate_passed(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    if !lab_director_hypothesis_is_usable(paths, cycle_id, &hypothesis_path) {
        return Ok(false);
    }
    let hypothesis = read_json(&hypothesis_path).unwrap_or(Value::Null);
    if hypothesis
        .get("validation_data_status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "materialized")
    {
        return Ok(true);
    }
    if hypothesis_dataset_materialized(paths, cycle_id, &hypothesis) {
        return Ok(true);
    }
    let materialized_dataset = hypothesis
        .get("identification_strategy")
        .and_then(|item| item.get("materialized_dataset"))
        .filter(|item| !item.is_null())
        .is_some();
    if materialized_dataset {
        return Ok(true);
    }
    let notes_path = state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json"));
    if notes_path.exists() {
        let notes = read_json(&notes_path).unwrap_or(Value::Null);
        if let Some(lead) = notes.get("current_lead_hypothesis") {
            if lead
                .get("validation_data_status")
                .and_then(Value::as_str)
                .is_some_and(|status| status == "materialized")
                || lead
                    .get("materialized_dataset")
                    .filter(|item| !item.is_null())
                    .is_some()
            {
                return Ok(true);
            }
            if hypothesis_dataset_materialized(paths, cycle_id, lead) {
                return Ok(true);
            }
        }
    }
    // Execution-based materialization (domain-general). The dataset checks above
    // assume validation data is a downloadable accession that lands on disk —
    // true for omics (GEO/PRIDE cohorts), but false for fields whose validation
    // data is GENERATED at run time: computer-graphics cycles render procedural
    // scenes (mitsuba/PBRT), simulations synthesise their own inputs, etc. In
    // those cycles no accession ever lands in runtime/datasets, so the gate could
    // never pass and the gatekeeper/analyst were blocked forever even though the
    // validation experiments had already executed and produced real metrics.
    // If the validation actually ran to completion and emitted numeric results,
    // the validation data was, by definition, materialised.
    if validation_results_executed(paths, cycle_id) {
        return Ok(true);
    }
    Ok(false)
}

/// Does the current lead name validation data that has to be FETCHED before a
/// runner can execute?
///
/// The materialization gate holds analyst / lab-runner / gatekeeper until the
/// lead's validation data exists. That is right when the data is a downloadable
/// accession. It is a deadlock when the data is GENERATED by the run itself:
/// nothing will ever land on disk, and the only escape the gate offers —
/// `validation_results_executed` — requires a COMPLETED lab-runner, which the
/// same gate is blocking.
///
/// MEASURED ON cycle-g-v79. The lead was `status: selected` with
/// `dataset_or_accession: null` and `validation_data_status:
/// needs_materialization`. Over 89 minutes and 66 lanes: 0 of 7 lab-runner and
/// 0 of 8 gatekeeper lanes ever launched, while 28 scout lanes churned. The
/// dispatcher's own skip log named it 16 times for lab-runner alone
/// (`waiting-for-validation-materialization-gate`), and the watchdog halted the
/// cycle on `activity_without_gate_progress` with gate_rounds=0.
///
/// The circle had exactly one door on each side and both were bolted:
/// `lab-runner-01` is the one lane exempt from the rival-analyst-handoff rule,
/// but it carries no role plan so it cannot use the executable-handoff escape;
/// `followup-runner-02` did carry a real 37KB analyst handoff and cleared the
/// materialization gate, and was then held by the rival rule at
/// `analyst_completed=1` — because the second analyst was itself blocked by the
/// materialization gate.
///
/// So: when the lead declares nothing to fetch, the runner is not waiting for
/// data, it IS the data source. A declared accession still gates normally, which
/// keeps the fail-closed behaviour that matters — never run an omics lane
/// against a cohort that has not downloaded.
fn lead_declares_fetchable_dataset(hypothesis: &Value) -> bool {
    fn fetchable(value: Option<&Value>) -> bool {
        let text = match value.and_then(Value::as_str) {
            Some(text) => text.trim(),
            None => return false,
        };
        if text.is_empty() || text.eq_ignore_ascii_case("null") || text.eq_ignore_ascii_case("none")
        {
            return false;
        }
        // Generated-at-run-time data declares its own scheme; there is no fetch.
        //
        // The slashes are optional on purpose. This field is agent-authored free
        // text, and cycle-g-v87's director wrote
        // `procedural:Mitsuba-3.8.0-counterfactual-edit-scenes` -- one colon. The
        // `://` form missed it, the gate read a procedural scene set as a
        // downloadable accession, and 34 analyst/lab-runner/gatekeeper lanes
        // waited two hours for a fetch that could never happen. v85 and v86 had
        // this field null, so their escape worked and it never showed.
        //
        // The colon is still required: `procedural:` names a scheme, while a
        // dataset merely called "procedural-scenes" is not one.
        let lowered = text.to_ascii_lowercase();
        !(lowered.starts_with("procedural:")
            || lowered.starts_with("synthetic:")
            || lowered.starts_with("simulated:"))
    }
    fetchable(hypothesis.get("dataset_or_accession"))
        || fetchable(hypothesis.get("selected_accession"))
        || fetchable(
            hypothesis
                .get("identification_strategy")
                .and_then(|item| item.get("dataset_or_accession")),
        )
        || fetchable(
            hypothesis
                .get("selected_hypothesis")
                .and_then(|item| item.get("dataset_or_accession")),
        )
}

/// True when the materialization gate has nothing left to wait for on this
/// cycle's lead — see `lead_declares_fetchable_dataset`.
pub(crate) fn lead_has_nothing_to_materialize(paths: &AppPaths, cycle_id: &str) -> bool {
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let hypothesis = match read_json(&hypothesis_path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    !lead_declares_fetchable_dataset(&hypothesis)
}

/// True when the cycle's validation experiments have actually executed and
/// produced real numeric output — i.e. at least one validation result reached a
/// completed/succeeded execution status AND carries a non-empty coefficients
/// array. Planning stubs (pending/planned/skipped/failed, or empty coefficients)
/// do NOT count, so this cannot pass the gate on an unexecuted plan.
fn validation_results_executed(paths: &AppPaths, cycle_id: &str) -> bool {
    let results_path = state_root(paths).join(format!("{cycle_id}-validation-results.json"));
    if !results_path.exists() {
        return false;
    }
    let doc = match read_json(&results_path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let results = doc
        .get("validation_results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    results.iter().any(|entry| {
        let status = entry
            .get("execution_status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let executed = (status.starts_with("completed")
            || status == "succeeded"
            || status == "executed"
            || status == "ok")
            && !status.contains("fail")
            && !status.contains("error")
            && !status.contains("skip");
        let has_output = entry
            .get("coefficients")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        executed && has_output
    })
}

fn hypothesis_dataset_materialized(paths: &AppPaths, cycle_id: &str, hypothesis: &Value) -> bool {
    let mut candidates = Vec::new();
    collect_dataset_candidates(hypothesis, &mut candidates);
    candidates.into_iter().any(|candidate| {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return false;
        }
        let as_path = Path::new(trimmed);
        if (as_path.is_absolute() || trimmed.contains('/')) && as_path.exists() {
            return true;
        }
        let slug = trimmed.to_ascii_lowercase();
        let dataset_root = paths
            .runtime_root
            .join("datasets")
            .join(cycle_id)
            .join(slug);
        dataset_root.is_dir()
            && std::fs::read_dir(dataset_root)
                .ok()
                .map(|mut entries| entries.any(|entry| entry.is_ok()))
                .unwrap_or(false)
    })
}

fn collect_dataset_candidates(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let key_matches = matches!(
                    key.as_str(),
                    "dataset_or_accession"
                        | "selected_dataset"
                        | "accession"
                        | "dataset_accession"
                        | "materialized_dataset"
                        | "dataset_root"
                );
                if key_matches {
                    if let Some(text) = child.as_str() {
                        out.push(text.to_string());
                    }
                }
                collect_dataset_candidates(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_dataset_candidates(child, out);
            }
        }
        _ => {}
    }
}

pub(crate) fn research_stage_gate_state(paths: &AppPaths, cycle_id: &str) -> Result<Value> {
    let literature_data_search_passed = completed_literature_scout_count(paths, cycle_id)? >= 1
        && completed_data_scout_count(paths, cycle_id)? >= 1;
    let kg_generation_passed =
        literature_data_search_passed && chronicle_graph_artifacts_ready(paths, cycle_id);
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let hypothesis_gate_failed = explicit_hypothesis_gate_failed(paths, cycle_id)?;
    let hypothesis_gate_override =
        lab_director_stage_gate_override_active(paths, cycle_id, "hypothesis_generation");
    let hypothesis_generation_passed = kg_generation_passed
        && lab_director_hypothesis_is_usable(paths, cycle_id, &hypothesis_path)
        && (!hypothesis_gate_failed || hypothesis_gate_override);
    let validation_materialization_passed =
        hypothesis_generation_passed && validation_materialization_gate_passed(paths, cycle_id)?;

    Ok(json!({
        "required_order": [
            "literature_data_search",
            "kg_generation",
            "hypothesis_generation",
            "validation_materialization_analysis"
        ],
        "mode": "advisory_stage_gates_with_hard_safety_constraints",
        "lab_director_authority": "LabDirector explicit scientific decisions may override advisory process gates when recorded with rationale; hard constraints such as forbidden dataset reuse and missing materialized validation inputs still block downstream execution.",
        "gates": [
            {
                "stage": "literature_data_search",
                "passed": literature_data_search_passed,
                "retry_from_stage": "literature_data_search",
                "on_fail": "rerun literature scout and data scout before KG generation"
            },
            {
                "stage": "kg_generation",
                "passed": kg_generation_passed,
                "retry_from_stage": "literature_data_search",
                "on_fail": "rerun scout search if inputs are missing, otherwise rerun Chronicle KG generation"
            },
            {
                "stage": "hypothesis_generation",
                "passed": hypothesis_generation_passed,
                "explicit_hypothesis_gate_failed": hypothesis_gate_failed,
                "lab_director_override_applied": hypothesis_gate_override,
                "retry_from_stage": if hypothesis_gate_failed { "literature_data_search" } else { "kg_generation" },
                "on_fail": "if the hypothesis gate fails and LabDirector has not recorded a justified override, restart from literature/data search rather than patching only validation"
            },
            {
                "stage": "validation_materialization_analysis",
                "passed": validation_materialization_passed,
                "retry_from_stage": "validation_materialization_analysis",
                "on_fail": "materialize validation data and same-dataset baseline before analyst/lab-runner/gate analysis"
            }
        ]
    }))
}

#[cfg(test)]
mod materialization_gate_tests {
    use super::*;
    use serde_json::json;

    // cycle-g-v79: `dataset_or_accession: null` on a procedural rendering lead
    // held every lab-runner behind a gate only a lab-runner could open.
    #[test]
    fn a_lead_with_no_dataset_has_nothing_to_fetch() {
        assert!(!lead_declares_fetchable_dataset(&json!({
            "dataset_or_accession": Value::Null,
            "validation_data_status": "needs_materialization",
        })));
        assert!(!lead_declares_fetchable_dataset(
            &json!({ "dataset_or_accession": "" })
        ));
        assert!(!lead_declares_fetchable_dataset(
            &json!({ "dataset_or_accession": "  " })
        ));
    }

    // cycle-g-v87: the director wrote the scheme with ONE colon and the gate,
    // which required `://`, read a procedural scene set as a downloadable
    // accession. 34 lanes waited two hours for a fetch that could never happen.
    #[test]
    fn a_scheme_without_slashes_is_still_not_fetchable() {
        for uri in [
            "procedural:Mitsuba-3.8.0-counterfactual-edit-scenes",
            "PROCEDURAL:Mitsuba-3.8.0",
            "synthetic:sim-run-1",
            "simulated:scene-sweep",
        ] {
            assert!(
                !lead_declares_fetchable_dataset(&json!({ "dataset_or_accession": uri })),
                "{uri} names generated data, not a download"
            );
        }
    }

    // The colon is what makes it a scheme. A dataset merely NAMED after the word
    // is a real accession and must still gate.
    #[test]
    fn a_dataset_named_like_a_scheme_still_gates() {
        for uri in [
            "procedural-scene-benchmark-v2",
            "synthetic_data_challenge_2024",
            "GSE322943",
        ] {
            assert!(
                lead_declares_fetchable_dataset(&json!({ "dataset_or_accession": uri })),
                "{uri} is a real accession and must still be fetched"
            );
        }
    }

    #[test]
    fn generated_data_schemes_are_not_fetchable() {
        for uri in [
            "procedural://mitsuba/indoor-3scene",
            "PROCEDURAL://mitsuba/x",
            "synthetic://sim/run",
            "simulated://transport",
        ] {
            assert!(
                !lead_declares_fetchable_dataset(&json!({ "dataset_or_accession": uri })),
                "{uri} is generated at run time, not downloaded"
            );
        }
    }

    #[test]
    fn a_declared_accession_still_gates() {
        // The fail-closed case that must not regress: never run an omics lane
        // against a cohort that has not landed on disk.
        assert!(lead_declares_fetchable_dataset(
            &json!({ "dataset_or_accession": "GSE123456" })
        ));
        assert!(lead_declares_fetchable_dataset(
            &json!({ "selected_accession": "PXD001234" })
        ));
        assert!(lead_declares_fetchable_dataset(&json!({
            "identification_strategy": { "dataset_or_accession": "GSE99999" }
        })));
        assert!(lead_declares_fetchable_dataset(&json!({
            "selected_hypothesis": { "dataset_or_accession": "GSE42" }
        })));
    }
}
