#![allow(unused_imports)]
use super::*;

// Stage 6: the owner checkpoint. The survivors, in the panel's order, are
// written as cards the owner can read in one sitting, and lead selection pauses
// on a marker of its own block type until the owner writes
// `<cycle>-owner-selection.json` {candidate_id, note}. The maintainer lists
// `owner_selection` among its waiting pause types: a person is being waited on,
// nothing is broken. RESEARCHLAB_OWNER_SELECTION_TIMEOUT_MINUTES, when set,
// proceeds with the panel's first survivor after that long; unset, it waits.

fn belief_for(beliefs: &Value, belief_id: &str) -> Value {
    selection_array(beliefs, "beliefs")
        .iter()
        .find(|belief| selection_text(belief.get("belief_id")) == Some(belief_id))
        .cloned()
        .unwrap_or(Value::Null)
}

/// One owner card, assembled from every stage's published artifact.
pub(crate) fn owner_candidate_card(paths: &AppPaths, cycle_id: &str, candidate_id: &str, rank: usize) -> Value {
    let slate = published_candidate_slate(paths, cycle_id).unwrap_or(Value::Null);
    let panel = published_expert_panel(paths, cycle_id).unwrap_or(Value::Null);
    let beliefs = published_field_beliefs(paths, cycle_id).unwrap_or(Value::Null);
    let candidate = slate_candidate(&slate, candidate_id).cloned().unwrap_or(Value::Null);
    let belief_id = selection_text(candidate.get("target_belief_id")).unwrap_or("");
    let row = panel_row(&panel, candidate_id).cloned().unwrap_or(Value::Null);
    let key = selection_key(candidate_id);
    let novelty = novelty_audits(paths, cycle_id).remove(&key).unwrap_or(Value::Null);
    let feasibility = feasibility_assessments(paths, cycle_id).remove(&key).unwrap_or(Value::Null);
    json!({
        "owner_rank": rank,
        "candidate_id": candidate_id,
        "origin_strategy": candidate_origin_strategy(&candidate),
        "strategy_basis": candidate_strategy_basis(&candidate),
        "strategy_basis_line": strategy_basis_line(&candidate, &beliefs),
        "belief_overturned": belief_for(&beliefs, belief_id),
        "problem": candidate.get("problem").cloned().unwrap_or(Value::Null),
        "hypothesis": candidate.get("hypothesis").cloned().unwrap_or(Value::Null),
        "differing_prediction": candidate.get("differing_prediction").cloned().unwrap_or(Value::Null),
        "informative_either_way": candidate.get("informative_either_way").cloned().unwrap_or(Value::Null),
        "decisive_experiment": candidate.get("decisive_experiment").cloned().unwrap_or(Value::Null),
        "subfield_id": candidate.get("subfield_id").cloned().unwrap_or(Value::Null),
        "landscape_open_problem_id": candidate.get("landscape_open_problem_id").cloned().unwrap_or(Value::Null),
        "landscape_paper_ids": candidate.get("landscape_paper_ids").cloned().unwrap_or_else(|| json!([])),
        "papers_holding_belief": candidate.get("papers_holding_belief").cloned().unwrap_or_else(|| json!([])),
        "open_source_assets": candidate.get("open_source_assets").cloned().unwrap_or_else(|| json!([])),
        "panel": row,
        "novelty_audit": novelty,
        "feasibility": feasibility.clone(),
        "reproduction_anchor": feasibility.get("reproduction_anchor").cloned().unwrap_or(Value::Null),
        "experiment_plan": feasibility.get("experiment_plan").cloned().unwrap_or_else(|| json!([])),
        "cheapest_faithful_setup": feasibility.get("cheapest_faithful_setup").cloned().unwrap_or(Value::Null),
        "cost": feasibility.get("cost").cloned().unwrap_or(Value::Null),
    })
}

fn text_of(value: &Value) -> String {
    match value {
        Value::Null => "-".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn number_of(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_f64)
        .map(|number| format!("{number:.2}"))
        .unwrap_or_else(|| "-".to_string())
}

/// The owner cards as Markdown, one section per candidate.
pub(crate) fn owner_candidates_markdown(cycle_id: &str, candidates: &[Value], eliminated: &[Value], selection_path: &Path) -> String {
    let mut lines = vec![
        format!("# Owner checkpoint: {cycle_id}"),
        String::new(),
        "The panel's best candidates that survived the novelty search and the feasibility check, in the panel's order. Feasibility only struck candidates; it never reordered them.".to_string(),
        String::new(),
    ];
    if candidates.is_empty() {
        lines.push("**No candidate survived.** Every candidate in play was struck as already published or failed feasibility (see below).".to_string());
        lines.push(String::new());
    } else {
        lines.push(format!("Strategy mix among the survivors: {}.", strategy_mix_text(candidates)));
        lines.push(String::new());
    }
    for card in candidates {
        let panel = card.get("panel").unwrap_or(&Value::Null);
        lines.push(format!(
            "## {}. `{}` -- {}",
            text_of(card.get("owner_rank").unwrap_or(&Value::Null)),
            text_of(card.get("candidate_id").unwrap_or(&Value::Null)),
            text_of(card.get("hypothesis").unwrap_or(&Value::Null))
        ));
        lines.push(String::new());
        lines.push(format!(
            "- **Origin strategy:** `{}` -- {}",
            text_of(card.get("origin_strategy").unwrap_or(&Value::Null)),
            text_of(card.get("strategy_basis_line").unwrap_or(&Value::Null))
        ));
        lines.push(format!("- **Problem:** {}", text_of(card.get("problem").unwrap_or(&Value::Null))));
        lines.push(format!("- **Prediction that differs:** {}", text_of(card.get("differing_prediction").unwrap_or(&Value::Null))));
        let informative = card.get("informative_either_way").unwrap_or(&Value::Null);
        lines.push(format!(
            "- **Informative either way:** if confirmed -- {}; if refuted -- {}",
            text_of(informative.get("if_confirmed").unwrap_or(&Value::Null)),
            text_of(informative.get("if_refuted").unwrap_or(&Value::Null))
        ));
        lines.push(format!("- **Decisive experiment:** {}", text_of(card.get("decisive_experiment").unwrap_or(&Value::Null))));
        let disagreement = panel.get("disagreement").unwrap_or(&Value::Null);
        lines.push(format!(
            "- **Panel:** value {} (rank {}); mean P(holds) {}, outcome uncertainty {}, impact {}, soundness {}; probability spread {}{}{}",
            number_of(panel.get("value")),
            text_of(panel.get("rank").unwrap_or(&Value::Null)),
            number_of(panel.get("mean_probability")),
            number_of(panel.get("mean_outcome_uncertainty")),
            number_of(panel.get("mean_impact")),
            number_of(panel.get("mean_soundness")),
            number_of(disagreement.get("probability_spread")),
            if disagreement.get("contested") == Some(&Value::Bool(true)) { " -- CONTESTED" } else { "" },
            if panel.get("predictable") == Some(&Value::Bool(true)) { " -- PREDICTABLE (the panel can call it)" } else { "" },
        ));
        for review in selection_array(panel, "per_reviewer") {
            let prior: Vec<String> = selection_array(review, "closest_prior_work")
                .iter()
                .filter_map(|work| selection_text(work.get("title")).map(ToString::to_string))
                .collect();
            lines.push(format!(
                "  - *{}*: P(holds) {}, impact {}, soundness {}. {} Closest prior work: {}.",
                text_of(review.get("persona").unwrap_or(&Value::Null)),
                number_of(review.get("predicted_outcome_probability")),
                number_of(review.get("impact")),
                number_of(review.get("soundness")),
                text_of(review.get("critique").unwrap_or(&Value::Null)),
                if prior.is_empty() { "-".to_string() } else { prior.join("; ") }
            ));
        }
        let novelty = card.get("novelty_audit").unwrap_or(&Value::Null);
        let closest: Vec<String> = selection_array(novelty, "closest_works")
            .iter()
            .filter_map(|work| {
                selection_text(work.get("title")).map(|title| {
                    format!("{title} ({})", text_of(work.get("year").unwrap_or(&Value::Null)))
                })
            })
            .collect();
        lines.push(format!(
            "- **Novelty audit:** {}. Closest: {}",
            text_of(novelty.get("verdict").unwrap_or(&Value::Null)),
            if closest.is_empty() { "-".to_string() } else { closest.join("; ") }
        ));
        let assets: Vec<String> = selection_array(card, "open_source_assets")
            .iter()
            .map(|asset| {
                format!(
                    "{} {}",
                    text_of(asset.get("kind").unwrap_or(&Value::Null)),
                    selection_text(asset.get("url")).or_else(|| selection_text(asset.get("name"))).unwrap_or("-")
                )
            })
            .collect();
        lines.push(format!("- **Open-source assets:** {}", if assets.is_empty() { "-".to_string() } else { assets.join("; ") }));
        let anchor = card.get("reproduction_anchor").unwrap_or(&Value::Null);
        lines.push(format!(
            "- **Reproduction anchor (first, on this host):** {} -- {} = {} ({})",
            text_of(anchor.get("paper_id").unwrap_or(&Value::Null)),
            text_of(anchor.get("metric").unwrap_or(&Value::Null)),
            text_of(anchor.get("reported_value").unwrap_or(&Value::Null)),
            text_of(anchor.get("setup").unwrap_or(&Value::Null))
        ));
        lines.push(format!("- **Cheapest faithful setup:** {}", text_of(card.get("cheapest_faithful_setup").unwrap_or(&Value::Null))));
        let plan = selection_strings(card, "experiment_plan");
        lines.push(format!("- **Experiment plan:** {}", if plan.is_empty() { "-".to_string() } else { plan.join(" -> ") }));
        lines.push(format!("- **Cost:** {}", text_of(card.get("cost").unwrap_or(&Value::Null))));
        lines.push(String::new());
    }
    if !eliminated.is_empty() {
        lines.push("## Struck on the way".to_string());
        lines.push(String::new());
        for item in eliminated {
            lines.push(format!(
                "- `{}`: {}",
                text_of(item.get("candidate_id").unwrap_or(&Value::Null)),
                text_of(item.get("reason").unwrap_or(&Value::Null))
            ));
        }
        lines.push(String::new());
    }
    lines.push("## How to choose".to_string());
    lines.push(String::new());
    lines.push(format!(
        "Write `{}` as `{{\"candidate_id\": \"<one of the ids above>\", \"note\": \"why\"}}`. The cycle resumes on its own and the LabDirector sets the lead from that candidate. `\"candidate_id\": \"{OWNER_RELEASE_CANDIDATE_ID}\"` lifts the slate requirement instead (the lead then answers only to the field-landscape gate).",
        selection_path.display()
    ));
    lines.join("\n") + "\n"
}

/// Write the owner cards and pause lead selection on them.
pub(crate) fn publish_owner_checkpoint(paths: &AppPaths, cycle_id: &str, funnel: &ExpertFunnel) -> Result<PathBuf> {
    let path = owner_candidates_path(paths, cycle_id);
    if path.is_file() {
        ensure_owner_selection_pause(paths, cycle_id)?;
        return Ok(path);
    }
    let config = expert_selection_config();
    let candidates: Vec<Value> = funnel
        .eligible
        .iter()
        .take(config.owner_top_n)
        .enumerate()
        .map(|(index, id)| owner_candidate_card(paths, cycle_id, id, index + 1))
        .collect();
    let audits = novelty_audits(paths, cycle_id);
    let eliminated: Vec<Value> = funnel
        .eliminated
        .iter()
        .map(|(id, reason)| {
            let citation = audits
                .get(&selection_key(id))
                .and_then(|audit| audit.get("citation"))
                .cloned()
                .unwrap_or(Value::Null);
            json!({"candidate_id": id, "reason": reason, "citation": citation})
        })
        .collect();
    let selection_path = owner_selection_path(paths, cycle_id);
    let markdown_path = owner_candidates_markdown_path(paths, cycle_id);
    write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "published_at": now_iso(),
            "exhausted": candidates.is_empty(),
            "candidates": candidates,
            "eliminated": eliminated,
            "panel_ranking": funnel.ranking,
            "markdown_path": markdown_path,
            "selection_path": selection_path,
            "selection_format": {"candidate_id": "one of candidates[].candidate_id, or 'release'", "note": "why"},
        }),
    )?;
    fs::write(&markdown_path, owner_candidates_markdown(cycle_id, &candidates, &eliminated, &selection_path))?;
    update_expert_selection_state(paths, cycle_id, |state| {
        state.insert("owner_candidates_published_at".to_string(), json!(now_iso()));
        state.insert("owner_candidate_ids".to_string(), json!(funnel.eligible.iter().take(config.owner_top_n).collect::<Vec<_>>()));
    })?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "expert_selection_owner_checkpoint",
        json!({"cycle_id": cycle_id, "owner_candidates_path": path, "candidates": funnel.eligible}),
    )?;
    ensure_owner_selection_pause(paths, cycle_id)?;
    Ok(path)
}

pub(crate) fn owner_candidate_ids(paths: &AppPaths, cycle_id: &str) -> Vec<String> {
    read_json(&owner_candidates_path(paths, cycle_id))
        .ok()
        .map(|value| {
            selection_array(&value, "candidates")
                .iter()
                .filter_map(|card| selection_text(card.get("candidate_id")).map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn recorded_owner_selection(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    expert_selection_state(paths, cycle_id)
        .get("owner_selection")
        .filter(|value| value.is_object())
        .cloned()
}

fn read_pause(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    read_json(&shared_pause_marker_path(paths, cycle_id)).ok()
}

fn is_owner_pause(marker: &Value) -> bool {
    marker.get("block_type").and_then(Value::as_str) == Some(OWNER_SELECTION_BLOCK)
}

/// Pause lead selection on the owner, unless the choice is already recorded or
/// another pause stands (it is not this code's to overwrite).
pub(crate) fn ensure_owner_selection_pause(paths: &AppPaths, cycle_id: &str) -> Result<()> {
    if recorded_owner_selection(paths, cycle_id).is_some() || is_cycle_paused(paths, cycle_id) {
        return Ok(());
    }
    let config = expert_selection_config();
    let markdown_path = owner_candidates_markdown_path(paths, cycle_id);
    let selection_path = owner_selection_path(paths, cycle_id);
    let paused_at = Utc::now();
    write_json(
        &shared_pause_marker_path(paths, cycle_id),
        &json!({
            "cycle_id": cycle_id,
            "status": "blocked",
            "block_type": OWNER_SELECTION_BLOCK,
            "manual_resume_required": false,
            "reason": format!(
                "Lead selection is waiting for the owner to choose among the expert-selected candidates in {}.",
                markdown_path.display()
            ),
            "resume_condition": format!(
                "Write {} as {{\"candidate_id\": \"...\", \"note\": \"...\"}}; the cycle resumes on its own.",
                selection_path.display()
            ),
            "source": "expert-selection",
            "owner_candidates_path": owner_candidates_path(paths, cycle_id),
            "owner_candidates_markdown_path": markdown_path,
            "selection_path": selection_path,
            "timeout_minutes": config.owner_timeout_minutes,
            "auto_proceed_at": config
                .owner_timeout_minutes
                .map(|minutes| (paused_at + chrono::Duration::minutes(minutes as i64)).to_rfc3339()),
            "paused_at": paused_at.to_rfc3339(),
        }),
    )?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "expert_selection_owner_pause",
        json!({"cycle_id": cycle_id, "selection_path": selection_path}),
    )?;
    Ok(())
}

fn record_owner_selection(paths: &AppPaths, cycle_id: &str, candidate_id: &str, note: &Value, source: &str) -> Result<Value> {
    let card = if candidate_id.eq_ignore_ascii_case(OWNER_RELEASE_CANDIDATE_ID) {
        Value::Null
    } else {
        read_json(&owner_candidates_path(paths, cycle_id))
            .ok()
            .and_then(|value| {
                selection_array(&value, "candidates")
                    .iter()
                    .find(|card| {
                        selection_text(card.get("candidate_id")).is_some_and(|id| selection_key(id) == selection_key(candidate_id))
                    })
                    .cloned()
            })
            .unwrap_or(Value::Null)
    };
    let canonical = selection_text(card.get("candidate_id")).unwrap_or(candidate_id).to_string();
    let selection = json!({
        "candidate_id": canonical,
        "note": note,
        "source": source,
        "selected_at": now_iso(),
        "decision": OwnerDecision::of_candidate_id(candidate_id).as_str(),
        "candidate": card,
    });
    let recorded = selection.clone();
    update_expert_selection_state(paths, cycle_id, move |state| {
        state.insert("owner_selection".to_string(), recorded);
    })?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "expert_selection_owner_selected",
        json!({"cycle_id": cycle_id, "candidate_id": canonical, "source": source}),
    )?;
    Ok(selection)
}

/// The owner changing their mind, through the same file they chose with.
///
/// MEASURED ON cycle-a-20260919, 2026-09-28. The owner picked
/// `shared_coverage_decay` on 2026-09-20 with a note asking that the single shared
/// curve be treated "as a falsifiable special case rather than an assumption".
/// Frozen-v5 did exactly that and falsified it: Diffusion Policy minus chunked BC
/// -0.2506, familywise 95% CI [-0.4179, -0.0833], wholly outside the +-0.05
/// margin. The director then retired the method and asked for a new owner pick
/// -- and nothing could ever ask. `ensure_owner_selection_pause` returns early
/// once any selection is recorded, and `release_owner_selection_pause` only reads
/// the file while no selection is recorded. A pick, once made, was permanent,
/// even after its own experiment answered it. The cycle idled, every plan action
/// a duplicate, with the next decision belonging to someone who had no way to
/// make it.
///
/// So the file is the owner's standing word: when it names a different valid
/// choice from the recorded one, the newer choice is recorded. The superseded
/// pick is kept, with what replaced it, because it is the record of a decision.
pub(crate) fn apply_owner_reselection(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    let Some(recorded) = recorded_owner_selection(paths, cycle_id) else {
        return Ok(false);
    };
    let Ok(selection) = read_json(&owner_selection_path(paths, cycle_id)) else {
        return Ok(false);
    };
    let chosen = selection_text(selection.get("candidate_id")).unwrap_or("").to_string();
    if chosen.is_empty() {
        return Ok(false);
    }
    let recorded_id = selection_text(recorded.get("candidate_id")).unwrap_or("");
    // The note is part of the owner's word, not decoration on it. MEASURED ON
    // cycle-a-20260919, 2026-09-28: the owner's `release` note told
    // the director to treat chunked BC "only as a ceiling diagnostic", which held
    // for included support (0.997) and not for removal, where BC at 0.899 against
    // Diffusion Policy at 0.395 was the experiment's largest effect. The owner
    // corrected the note with the choice unchanged -- and a check on the
    // candidate id alone would have ignored the correction.
    let note_changed = selection.get("note") != recorded.get("note");
    if selection_key(recorded_id) == selection_key(&chosen) && !note_changed {
        return Ok(false);
    }
    let allowed = owner_candidate_ids(paths, cycle_id);
    let valid = chosen.eq_ignore_ascii_case(OWNER_RELEASE_CANDIDATE_ID)
        || allowed.iter().any(|id| selection_key(id) == selection_key(&chosen));
    if !valid {
        return Ok(false);
    }
    let superseded = json!({
        "selection": recorded,
        "superseded_at": now_iso(),
        "superseded_by": chosen,
    });
    update_expert_selection_state(paths, cycle_id, move |state| {
        let history = state
            .entry("superseded_owner_selections".to_string())
            .or_insert_with(|| json!([]));
        if let Some(items) = history.as_array_mut() {
            items.push(superseded);
        }
    })?;
    record_owner_selection(
        paths,
        cycle_id,
        &chosen,
        selection.get("note").unwrap_or(&Value::Null),
        "owner_reselection",
    )?;
    Ok(true)
}

/// Called while the run loop waits on a pause. Lifts an `owner_selection` pause
/// once the owner has chosen a candidate, or once the configured timeout has
/// passed (then the panel's first survivor is taken). Any other pause is left
/// alone. Returns whether the pause was lifted.
pub(crate) fn release_owner_selection_pause(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    release_owner_selection_pause_after(paths, cycle_id, expert_selection_config().owner_timeout_minutes)
}

pub(crate) fn release_owner_selection_pause_after(
    paths: &AppPaths,
    cycle_id: &str,
    timeout_minutes: Option<u64>,
) -> Result<bool> {
    let Some(marker) = read_pause(paths, cycle_id).filter(is_owner_pause) else {
        return Ok(false);
    };
    if recorded_owner_selection(paths, cycle_id).is_none() {
        let allowed = owner_candidate_ids(paths, cycle_id);
        let selection_path = owner_selection_path(paths, cycle_id);
        if let Ok(selection) = read_json(&selection_path) {
            let chosen = selection_text(selection.get("candidate_id")).unwrap_or("").to_string();
            let valid = chosen.eq_ignore_ascii_case(OWNER_RELEASE_CANDIDATE_ID)
                || allowed.iter().any(|id| selection_key(id) == selection_key(&chosen));
            if !valid {
                let error = format!(
                    "owner-selection candidate_id '{chosen}' is not one of: {} (or '{OWNER_RELEASE_CANDIDATE_ID}')",
                    allowed.join(", ")
                );
                if marker.get("selection_error").and_then(Value::as_str) != Some(error.as_str()) {
                    let mut marker = marker.clone();
                    marker["selection_error"] = json!(error);
                    write_json(&shared_pause_marker_path(paths, cycle_id), &marker)?;
                }
                return Ok(false);
            }
            record_owner_selection(
                paths,
                cycle_id,
                &chosen,
                selection.get("note").unwrap_or(&Value::Null),
                "owner",
            )?;
        } else {
            let paused_at = marker
                .get("paused_at")
                .and_then(Value::as_str)
                .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok());
            let timed_out = match (timeout_minutes, paused_at) {
                (Some(minutes), Some(at)) => {
                    Utc::now().signed_duration_since(at.with_timezone(&Utc)) >= chrono::Duration::minutes(minutes as i64)
                }
                _ => false,
            };
            if !timed_out {
                return Ok(false);
            }
            let chosen = allowed
                .first()
                .cloned()
                .unwrap_or_else(|| OWNER_RELEASE_CANDIDATE_ID.to_string());
            let note = json!(format!(
                "auto-proceeded with the panel's first surviving candidate after {} minute(s) without an owner selection",
                timeout_minutes.unwrap_or(0)
            ));
            write_json(
                &selection_path,
                &json!({"candidate_id": chosen, "note": note, "source": "auto_timeout", "written_at": now_iso()}),
            )?;
            record_owner_selection(paths, cycle_id, &chosen, &note, "auto_timeout")?;
        }
    }
    clear_pause_marker(paths, cycle_id)?;
    Ok(true)
}
