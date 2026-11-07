#![allow(unused_imports)]
use super::*;

// --- a second round of selection after a lead is withdrawn --------------------------
//
// MEASURED ON cycle-a-20260919, 2026-11-06. The lead was withdrawn and its
// director ended with `requery_decision: restart` and no replacement: "no eligible
// successor has arrived", the fixed panel could not identify the claim. The
// pipeline had run once, on 2026-09-19, and ended in an owner selection that is
// still on disk, so every stage reads as done. Nothing opens a successor search,
// the supervisor's "decision stalled" requests collapse onto answered ids, and the
// cycle sat for eight hours with no lane running and nothing it could start.
//
// A withdrawn lead whose director restarted is the field telling the cycle that the
// slate it chose from is spent. This opens the next round: the stage artifacts and
// the owner's selection of the spent round are set aside (renamed, never deleted),
// the stage lanes of that round stop counting toward the attempt caps, and the new
// slate is told what the last round tried and why it failed, so it cannot hand
// back the same dead end. The round still ends at the owner's checkpoint: the
// choice of what to pursue stays the owner's.

/// Every artifact a round publishes, set aside when the round is spent.
fn round_artifact_paths(paths: &AppPaths, cycle_id: &str) -> Vec<PathBuf> {
    vec![
        field_beliefs_path(paths, cycle_id),
        candidate_slate_path(paths, cycle_id),
        expert_panel_path(paths, cycle_id),
        expert_panel_personas_path(paths, cycle_id),
        expert_panel_submissions_path(paths, cycle_id),
        novelty_audit_path(paths, cycle_id),
        candidate_feasibility_path(paths, cycle_id),
        owner_candidates_path(paths, cycle_id),
        owner_candidates_markdown_path(paths, cycle_id),
        owner_selection_path(paths, cycle_id),
        expert_selection_attempts_path(paths, cycle_id),
    ]
}

fn lead_file_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"))
}

/// The lane ids of spent rounds. They stay on disk as the record; they no longer
/// count as this round's attempts or open work.
pub(crate) fn retired_selection_lane_ids(paths: &AppPaths, cycle_id: &str) -> BTreeSet<String> {
    expert_selection_state(paths, cycle_id)
        .get("retired_lane_ids")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(ToString::to_string)).collect())
        .unwrap_or_default()
}

/// What the last spent round tried, handed to the stages of the next one.
pub(crate) fn previous_round_context(paths: &AppPaths, cycle_id: &str) -> Value {
    expert_selection_state(paths, cycle_id)
        .get("rounds")
        .and_then(Value::as_array)
        .and_then(|rounds| rounds.last().cloned())
        .unwrap_or(Value::Null)
}

fn withdrawn_lead_summary(lead: &Value) -> Value {
    let decision = lead.get("lab_director_decision").unwrap_or(&Value::Null);
    let problem = decision.get("research_problem").unwrap_or(&Value::Null);
    json!({
        "withdrawn_by": lead.get("generated_by"),
        "question_retained": problem.get("question"),
        "why_not_already_answered": problem.get("why_not_already_answered"),
        "instrument_gap": problem.get("instrument_gap"),
        "methods_tried": problem.get("methods_tried").cloned().unwrap_or_else(|| json!([])),
        "director_rationale": clip_text(decision.get("rationale"), 1500),
        "withdrawn_hypothesis": lead.get("withdrawn_hypothesis").cloned().unwrap_or(Value::Null),
    })
}

/// Open the next selection round when the lead is withdrawn and its director
/// restarted. Idempotent per withdrawal: one round per withdrawing lane.
pub(crate) fn reopen_selection_for_withdrawn_lead(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    if !expert_selection_engaged(paths, cycle_id) {
        return Ok(false);
    }
    let Ok(lead) = read_json(&lead_file_path(paths, cycle_id)) else {
        return Ok(false);
    };
    if lead.get("status").and_then(Value::as_str) != Some("withdrawn") {
        return Ok(false);
    }
    let restarted = lead.get("requery_decision").and_then(Value::as_str) == Some("restart")
        || lead
            .pointer("/lab_director_decision/requery_decision")
            .and_then(Value::as_str)
            == Some("restart");
    if !restarted {
        return Ok(false);
    }
    // A round still running has nothing to reopen; only a finished one is spent.
    if recorded_owner_selection(paths, cycle_id).is_none() {
        return Ok(false);
    }
    let withdrawn_by = lead.get("generated_by").and_then(Value::as_str).unwrap_or("").to_string();
    let state = expert_selection_state(paths, cycle_id);
    let rounds = state.get("rounds").and_then(Value::as_array).cloned().unwrap_or_default();
    if rounds
        .last()
        .and_then(|round| round.get("reopened_for").and_then(Value::as_str))
        .is_some_and(|reopened_for| reopened_for == withdrawn_by)
    {
        return Ok(false);
    }

    let round = rounds.len() + 1;
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut set_aside = Vec::new();
    for path in round_artifact_paths(paths, cycle_id) {
        if !path.exists() {
            continue;
        }
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let target = path.with_file_name(format!("{name}.round{round}-superseded-{stamp}.bak"));
        fs::rename(&path, &target)?;
        set_aside.push(json!(target));
    }

    let mut retired: BTreeSet<String> = retired_selection_lane_ids(paths, cycle_id);
    for (action, _, _) in EXPERT_SELECTION_STAGES {
        retired.extend(stage_lanes(paths, cycle_id, action).into_iter().map(|lane| lane.lane_id));
    }
    let spent_candidates = state.get("owner_candidate_ids").cloned().unwrap_or_else(|| json!([]));
    let spent_selection = state.get("owner_selection").cloned().unwrap_or(Value::Null);
    let record = json!({
        "round": round,
        "reopened_at": now_iso(),
        "reopened_for": withdrawn_by,
        "reason": "the lead was withdrawn and its director restarted without a replacement",
        "spent_round": {
            "owner_candidate_ids": spent_candidates,
            "owner_selection": spent_selection,
        },
        "withdrawn_lead": withdrawn_lead_summary(&lead),
        "instruction": "The previous round's slate produced a lead that could not be identified on its panel. Candidates must not repeat a method listed under methods_tried or the withdrawn hypothesis, and each must state why it avoids the identification failure the director recorded.",
        "set_aside": set_aside,
    });
    update_expert_selection_state(paths, cycle_id, move |state| {
        state.remove("owner_selection");
        state.remove("owner_candidate_ids");
        state.remove("owner_candidates_published_at");
        let history = state.entry("rounds".to_string()).or_insert_with(|| json!([]));
        if let Some(items) = history.as_array_mut() {
            items.push(record);
        }
        state.insert("round".to_string(), json!(round));
        state.insert("retired_lane_ids".to_string(), json!(retired));
    })?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "expert_selection_round_reopened",
        json!({"cycle_id": cycle_id, "round": round, "withdrawn_by": withdrawn_by}),
    )?;
    Ok(true)
}
