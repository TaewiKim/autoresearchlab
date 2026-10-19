#![allow(unused_imports)]
use super::*;

// The lead gate, the director's hold and what every director lane is told.
//
// Once the pipeline is engaged for a cycle, a lead comes from the slate: the
// first selection must be the owner's pick, named by `slate_candidate_id`, and
// a later replacement must be another owner-vetted candidate. The field-
// landscape gate still applies on top (labdirector::field_landscape), so the
// candidate's landscape_open_problem_id and landscape_paper_ids are carried
// into the lead.

fn open_deep_read_lanes(paths: &AppPaths, cycle_id: &str) -> usize {
    count_open_followup_lanes_by_role_and_action(paths, cycle_id)
        .map(|counts| {
            counts
                .iter()
                .filter(|(key, _)| key.contains("sota_deep_read"))
                .map(|(_, count)| *count)
                .sum()
        })
        .unwrap_or(0)
}

fn open_stage_lanes(paths: &AppPaths, cycle_id: &str) -> usize {
    EXPERT_SELECTION_STAGES
        .iter()
        .map(|(action, _, _)| stage_lanes(paths, cycle_id, action).iter().filter(|lane| !lane.finished).count())
        .sum()
}

/// Whether the pipeline can still move by itself: a stage lane is open, or the
/// stage it is in may dispatch another. A stalled pipeline holds nobody -- a
/// hold with nothing behind it is one nothing can release.
pub(crate) fn expert_selection_can_progress(paths: &AppPaths, cycle_id: &str, progress: &ExpertProgress) -> bool {
    if open_stage_lanes(paths, cycle_id) > 0 {
        return true;
    }
    let config = expert_selection_config();
    let allowed = |action: &str, attempt_stage: &str| {
        let lanes = stage_lanes(paths, cycle_id, action);
        stage_dispatch_allowed(paths, cycle_id, attempt_stage, &lanes, &config)
    };
    match progress.stage {
        "field_beliefs" => allowed(FIELD_BELIEFS_ACTION, FIELD_BELIEFS_ACTION),
        "candidate_slate" => allowed(CANDIDATE_SLATE_ACTION, CANDIDATE_SLATE_ACTION),
        "expert_panel" => {
            let submissions = panel_submissions(paths, cycle_id);
            let all_lanes = stage_lanes(paths, cycle_id, EXPERT_PANEL_ACTION);
            panel_personas(paths, cycle_id, &config).iter().any(|(persona_id, _)| {
                if submissions.contains_key(persona_id) {
                    return false;
                }
                let lanes: Vec<StageLane> = all_lanes
                    .iter()
                    .filter(|lane| {
                        read_json(&lane.role_plan_path)
                            .ok()
                            .and_then(|plan| lane_panel_persona(Some(&plan)))
                            .as_deref()
                            == Some(persona_id.as_str())
                    })
                    .cloned()
                    .collect();
                stage_dispatch_allowed(paths, cycle_id, &format!("{EXPERT_PANEL_ACTION}:{persona_id}"), &lanes, &config)
            })
        }
        "novelty_refutation" => allowed(NOVELTY_REFUTATION_ACTION, NOVELTY_REFUTATION_ACTION),
        "feasibility" => allowed(FEASIBILITY_AUDIT_ACTION, FEASIBILITY_AUDIT_ACTION),
        "owner_checkpoint" | "awaiting_owner_selection" => true,
        _ => false,
    }
}

/// The hold on the OPENING director while candidates are being selected. The
/// caller applies it only while no lead exists.
pub(crate) fn director_expert_selection_wait_reason(paths: &AppPaths, cycle_id: &str) -> Option<String> {
    if !expert_selection_enabled() || cycle_has_lead_file(paths, cycle_id) {
        return None;
    }
    if !expert_selection_engaged(paths, cycle_id) {
        // The SOTA cards the pipeline starts from are still being read.
        let open = open_deep_read_lanes(paths, cycle_id);
        let cards = expert_cards_status(paths, cycle_id);
        return (open > 0 && cards.state != "ready").then(|| {
            format!("waiting-for-expert-selection stage=sota_cards sota_cards={} deep_read_lanes_open={open}", cards.state)
        });
    }
    let progress = expert_selection_progress(paths, cycle_id);
    match progress.stage {
        "selected" | "disabled" | "not_engaged" => None,
        "owner_checkpoint" | "awaiting_owner_selection" => Some(format!(
            "waiting-for-owner-selection path={}",
            owner_selection_path(paths, cycle_id).display()
        )),
        stage => expert_selection_can_progress(paths, cycle_id, &progress).then(|| {
            format!(
                "waiting-for-expert-selection stage={stage} stage_lanes_open={}",
                open_stage_lanes(paths, cycle_id)
            )
        }),
    }
}

/// Why this lead may not be selected under the pipeline, or nothing when it
/// may. `first_selection` is true when no lead of the harness's making exists
/// yet: that one must be the owner's pick; a later replacement may be any
/// owner-vetted candidate.
pub(crate) fn lead_expert_selection_rejection_reasons(
    paths: &AppPaths,
    cycle_id: &str,
    lead: &Value,
    first_selection: bool,
) -> Vec<String> {
    if !expert_selection_engaged(paths, cycle_id) {
        return Vec::new();
    }
    let Some(selection) = recorded_owner_selection(paths, cycle_id) else {
        let progress = expert_selection_progress(paths, cycle_id);
        return vec![format!(
            "expert_selection_pending: no lead may be selected until the owner picks a candidate of the expert-selected slate (pipeline stage: {}; the owner cards are written to {})",
            progress.stage,
            owner_candidates_markdown_path(paths, cycle_id).display()
        )];
    };
    if OwnerDecision::of_selection(Some(&selection)).slate_requirement_lifted() {
        return Vec::new();
    }
    let chosen = selection_text(selection.get("candidate_id")).unwrap_or("").to_string();
    let vetted = owner_candidate_ids(paths, cycle_id);
    let mut reasons = Vec::new();
    let Some(named) = selection_text(lead.get("slate_candidate_id")) else {
        return vec![format!(
            "slate_candidate_id is missing: a lead comes from the expert-selected slate -- set selected_hypothesis.slate_candidate_id to '{chosen}', the owner's pick"
        )];
    };
    if first_selection && selection_key(named) != selection_key(&chosen) {
        reasons.push(format!(
            "slate_candidate_id '{named}' is not the owner's pick '{chosen}'; the first lead is the candidate the owner chose"
        ));
    } else if !first_selection && !vetted.iter().any(|id| selection_key(id) == selection_key(named)) {
        reasons.push(format!(
            "slate_candidate_id '{named}' is not an owner-vetted candidate (one of: {})",
            vetted.join(", ")
        ));
    }
    let candidate = published_candidate_slate(paths, cycle_id)
        .and_then(|slate| slate_candidate(&slate, named).cloned());
    if let Some(expected) = candidate.as_ref().and_then(|candidate| selection_text(candidate.get("landscape_open_problem_id"))) {
        if selection_text(lead.get("landscape_open_problem_id")) != Some(expected) {
            reasons.push(format!(
                "landscape_open_problem_id must be '{expected}', the open problem candidate '{named}' answers"
            ));
        }
    }
    reasons
}

/// What every director lane is handed about the pipeline.
pub(crate) fn expert_selection_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    if !expert_selection_enabled() {
        return json!({"enabled": false});
    }
    let engaged = expert_selection_engaged(paths, cycle_id);
    let progress = expert_selection_progress(paths, cycle_id);
    let selection = recorded_owner_selection(paths, cycle_id);
    json!({
        "enabled": true,
        "engaged": engaged,
        "stage": progress.stage,
        "owner_selection": selection.as_ref().map(|value| {
            let decision = OwnerDecision::of_selection(Some(value));
            json!({
                "candidate_id": value.get("candidate_id"),
                "note": value.get("note"),
                "source": value.get("source"),
                "decision": decision.as_str(),
                "decision_means": decision.lead_rule(),
            })
        }),
        "selected_candidate": selection.as_ref().and_then(|value| value.get("candidate").cloned()).unwrap_or(Value::Null),
        "owner_vetted_candidate_ids": owner_candidate_ids(paths, cycle_id),
        "owner_candidates_markdown_path": owner_candidates_markdown_path(paths, cycle_id),
        "selection_rule": if engaged {
            json!("ENFORCED: no lead is selected until the owner has picked a candidate of the expert-selected slate. Then the lead IS that candidate: set selected_hypothesis.slate_candidate_id to selected_candidate.candidate_id, state its hypothesis (sharpen the wording, never change the claim), copy landscape_open_problem_id and landscape_paper_ids from it, and plan the reproduction anchor first. A later replacement must be another id in owner_vetted_candidate_ids. Anything else is NOT applied; the reason is recorded in field_landscape.last_selection_rejections.")
        } else {
            json!("not engaged for this cycle: the pipeline starts once a valid field landscape and SOTA cards exist and no lead has been chosen")
        },
    })
}
