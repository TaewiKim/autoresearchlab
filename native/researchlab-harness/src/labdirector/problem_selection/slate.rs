#![allow(unused_imports)]
use super::*;

// Stage 2: the candidate slate, written WITHOUT the host in view.
//
// MEASURED ON cycle-b-20260919, 2026-09-19: the director ranked with the
// instrument inventory, the reference repos and a trained SuperDex policy in its
// context, and the problem it could run tonight became the problem worth
// running. So the slate lane is never handed the inventory, instrument_fit,
// local copies, VRAM floors or the host sections of the objective. Feasibility
// is decided later, per candidate, and can only strike -- never reorder.

/// Keys that describe this host rather than the field. Removed, at any depth,
/// from everything the slate lane is handed.
pub(crate) const HOST_CONTEXT_KEYS: &[&str] = &[
    "instrument_fit",
    "instrument_inventory",
    "instruments",
    "local_copy_path",
    "min_vram_gb_eval",
    "min_vram_gb_train",
    "simulation_orders",
    "materialized_bundle_mandate",
    "candidate_datasets",
    "dataset_bundle",
    "materialized_dataset_context",
    "reference_resources",
    "dataset_root",
    "selected_dataset_bundle",
];

pub(crate) fn strip_host_context(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !HOST_CONTEXT_KEYS.contains(&key.as_str()));
            for item in map.values_mut() {
                strip_host_context(item);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_host_context),
        _ => {}
    }
}

/// Section headings that describe the host, matched as whole words so the
/// document title "Robotics ..." is not read as "robots".
const HOST_HEADING_WORDS: &[&str] = &[
    "instrument", "instruments", "host", "hardware", "robots", "robot", "simulator", "simulators",
    "environment", "environments", "compute", "machine", "tools", "assets", "setup", "equipment",
];

/// Phrases that tie a sentence to this host.
const HOST_SENTENCE_MARKERS: &[&str] = &[
    "this pc", "this host", "this machine", "this computer", "simulators below", "instruments below",
    "tools below", "local copy", "rtx ", "vram", "cuda", "headless", ".exe", ".venv", ".zip", "docker",
    ".research-lab", "interpreter",
];

pub(crate) fn text_names_a_local_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.windows(3).any(|window| {
        window[0].is_ascii_alphabetic() && window[1] == b':' && (window[2] == b'/' || window[2] == b'\\')
    }) || text.contains(".research-lab")
}

fn sentence_is_host_specific(sentence: &str) -> bool {
    let lowered = sentence.to_ascii_lowercase();
    text_names_a_local_path(sentence) || HOST_SENTENCE_MARKERS.iter().any(|marker| lowered.contains(marker))
}

fn split_sentences(line: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = line.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        current.push(*ch);
        let boundary = matches!(ch, '.' | '?' | '!' | ';')
            && chars.get(index + 1).map(|next| next.is_whitespace()).unwrap_or(true);
        if boundary {
            sentences.push(std::mem::take(&mut current));
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current);
    }
    sentences
}

/// The objective with everything about this host removed: host sections (by
/// heading, never the title), and every sentence that names a local path, the
/// GPU, a local copy, or "the simulators below".
pub(crate) fn instrument_blind_objective(objective: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut skipping_level: Option<usize> = None;
    let mut removed = 0usize;
    for line in objective.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|c| *c == '#').count();
            if let Some(skip) = skipping_level {
                if level > skip {
                    removed += 1;
                    continue;
                }
                skipping_level = None;
            }
            let words: Vec<String> = trimmed
                .trim_start_matches('#')
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|word| !word.is_empty())
                .map(|word| word.to_ascii_lowercase())
                .collect();
            if level >= 2 && words.iter().any(|word| HOST_HEADING_WORDS.contains(&word.as_str())) {
                skipping_level = Some(level);
                removed += 1;
                continue;
            }
            out.push(line.to_string());
            continue;
        }
        if skipping_level.is_some() {
            if !trimmed.is_empty() {
                removed += 1;
            }
            continue;
        }
        let kept: Vec<String> = split_sentences(line)
            .into_iter()
            .filter(|sentence| {
                let host = sentence_is_host_specific(sentence);
                if host {
                    removed += 1;
                }
                !host
            })
            .collect();
        if kept.is_empty() && !line.trim().is_empty() {
            continue;
        }
        out.push(kept.join("").trim_end().to_string());
    }
    let mut text = out.join("\n").trim().to_string();
    if removed > 0 {
        text.push_str("\n\n[instrument-blind: host sections and host-specific sentences were removed; the subfields to cover are the field landscape's]");
    }
    text
}

/// The landscape as the slate sees it: subfields, open problems and papers,
/// without instrument_fit or anything a refused selection said.
pub(crate) fn instrument_blind_landscape(paths: &AppPaths, cycle_id: &str) -> Value {
    let full = field_landscape_director_context(paths, cycle_id);
    let mut view = json!({
        "status": full.get("status").cloned().unwrap_or(Value::Null),
        "subfields": full.get("subfields").cloned().unwrap_or_else(|| json!([])),
        "open_problems": full.get("open_problems").cloned().unwrap_or_else(|| json!([])),
        "papers": full.get("papers").cloned().unwrap_or_else(|| json!([])),
        "min_lead_citations": full.get("min_lead_citations").cloned().unwrap_or(Value::Null),
        "frontier_year": full.get("frontier_year").cloned().unwrap_or(Value::Null),
    });
    strip_host_context(&mut view);
    view
}

fn candidate_text_fields(candidate: &Value) -> String {
    let mut text = String::new();
    for key in ["problem", "hypothesis", "differing_prediction", "decisive_experiment", "belief_statement"] {
        if let Some(value) = selection_text(candidate.get(key)) {
            text.push_str(value);
            text.push('\n');
        }
    }
    for key in ["informative_either_way", "method_leap", "bottleneck_transfer", "latent_bottleneck"] {
        if let Some(value) = candidate.get(key).filter(|value| !value.is_null()) {
            text.push_str(&value.to_string());
            text.push('\n');
        }
    }
    text
}

/// The candidates that pass, in the slate's own order.
///
/// Each declares an origin strategy and carries that strategy's basis, checked
/// against the published map (`map`: beliefs, subfield_maturity,
/// known_bottlenecks, latent_signals) and the cards; says what it predicts
/// differently and why either outcome is informative; names the decisive
/// experiment; and builds on at least one open-source asset a card names. A
/// candidate that names a local path has seen the host and is refused. The
/// slate as a whole must spread across subfields and across strategies.
pub(crate) fn validate_candidate_slate(
    output: &Value,
    map: &Value,
    cards: &ExpertCards,
    open_problem_ids: &BTreeSet<String>,
    config: &ExpertSelectionConfig,
) -> (ExpertStageValidation, Vec<Value>) {
    let mut out = ExpertStageValidation::default();
    let mut accepted = Vec::new();
    let Some(candidates) = output.get("candidates").and_then(Value::as_array) else {
        out.reasons.push("candidates[] is missing".to_string());
        return (out, accepted);
    };
    let assets = expert_all_card_assets(cards);
    let mut seen = BTreeSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let Some(id) = selection_text(candidate.get("candidate_id")) else {
            out.warnings.push(format!("candidates[{index}] has no candidate_id"));
            continue;
        };
        if id.eq_ignore_ascii_case(OWNER_RELEASE_CANDIDATE_ID) {
            out.warnings.push(format!("candidate_id '{id}' is reserved"));
            continue;
        }
        if !seen.insert(selection_key(id)) {
            out.reasons.push(format!("candidate_id '{id}' is used twice"));
            continue;
        }
        let missing: Vec<&str> = ["subfield_id", "problem", "hypothesis", "differing_prediction", "decisive_experiment"]
            .into_iter()
            .filter(|key| selection_text(candidate.get(*key)).is_none())
            .collect();
        if !missing.is_empty() {
            out.warnings.push(format!("{id}: empty {}", missing.join(", ")));
            continue;
        }
        if let Some(problem) = strategy_basis_problem(candidate, map, cards, config) {
            out.warnings.push(format!("{id}: {problem}"));
            continue;
        }
        let informative = candidate.get("informative_either_way").unwrap_or(&Value::Null);
        if selection_text(informative.get("if_confirmed")).is_none() || selection_text(informative.get("if_refuted")).is_none() {
            out.warnings.push(format!(
                "{id}: informative_either_way must say what each outcome would teach -- a result that only matters one way is a bet, not an experiment"
            ));
            continue;
        }
        let mut matched_assets = 0usize;
        for asset in selection_array(candidate, "open_source_assets") {
            let url = selection_text(asset.get("url")).unwrap_or("");
            let name = selection_text(asset.get("name")).unwrap_or("");
            if expert_find_card_asset(&assets, url, name).is_some() {
                matched_assets += 1;
            } else {
                out.warnings.push(format!(
                    "{id}: asset '{}' is not one a SOTA card names",
                    if url.is_empty() { name } else { url }
                ));
            }
        }
        if matched_assets == 0 {
            out.warnings.push(format!(
                "{id}: builds on no open-source code, checkpoint, dataset or environment a SOTA card names -- leverage is a selection criterion"
            ));
            continue;
        }
        if let Some(problem_id) = selection_text(candidate.get("landscape_open_problem_id")) {
            if !open_problem_ids.is_empty() && !open_problem_ids.contains(problem_id) {
                out.warnings.push(format!("{id}: landscape_open_problem_id '{problem_id}' is not in the landscape"));
                continue;
            }
        } else if !open_problem_ids.is_empty() {
            out.warnings.push(format!("{id}: landscape_open_problem_id is empty; the lead gate needs it"));
            continue;
        }
        if text_names_a_local_path(&candidate_text_fields(candidate)) {
            out.warnings.push(format!("{id}: names a local path -- the slate is written without the host in view"));
            continue;
        }
        accepted.push(candidate.clone());
    }
    if accepted.len() > config.slate_max {
        out.warnings.push(format!(
            "{} valid candidates; only the first {} are kept",
            accepted.len(),
            config.slate_max
        ));
        accepted.truncate(config.slate_max);
    }
    let subfields: BTreeSet<String> = accepted
        .iter()
        .map(|candidate| selection_text(candidate.get("subfield_id")).unwrap_or("").to_ascii_lowercase())
        .collect();
    if accepted.len() < config.slate_min {
        out.reasons.push(format!(
            "{} valid candidate(s), at least {} required",
            accepted.len(),
            config.slate_min
        ));
    }
    if subfields.len() < config.min_slate_subfields {
        out.reasons.push(format!(
            "valid candidates span {} subfield(s), at least {} required -- the slate competes across the field, not within one corner of it",
            subfields.len(),
            config.min_slate_subfields
        ));
    }
    let strategies: BTreeSet<String> = accepted.iter().map(candidate_origin_strategy).collect();
    let required = required_slate_strategies(map, config);
    if strategies.len() < required {
        out.reasons.push(format!(
            "valid candidates use {} origin strateg{} ({}), at least {} required of those the map supports ({}) -- one strategy is one bet made {} times",
            strategies.len(),
            if strategies.len() == 1 { "y" } else { "ies" },
            strategies.iter().cloned().collect::<Vec<_>>().join(", "),
            required,
            strategies_available(map).join(", "),
            accepted.len()
        ));
    }
    out.valid = out.reasons.is_empty();
    (out, accepted)
}

pub(crate) fn published_candidate_slate(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    read_published(&candidate_slate_path(paths, cycle_id))
}

pub(crate) fn slate_candidates(slate: &Value) -> Vec<Value> {
    selection_array(slate, "candidates").to_vec()
}

pub(crate) fn slate_candidate<'a>(slate: &'a Value, candidate_id: &str) -> Option<&'a Value> {
    let key = selection_key(candidate_id);
    selection_array(slate, "candidates")
        .iter()
        .find(|candidate| selection_text(candidate.get("candidate_id")).is_some_and(|id| selection_key(id) == key))
}

pub(crate) fn project_candidate_slate(
    paths: &AppPaths,
    contract: &LaneContract,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    let config = expert_selection_config();
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output = stage_output(payload, &lane_dir, "candidate-slate.json", "candidates");
    let map = published_field_beliefs(paths, &contract.cycle_id).unwrap_or_else(|| json!({}));
    let cards = expert_cards_status(paths, &contract.cycle_id);
    let open_problems = landscape_open_problem_ids(paths, &contract.cycle_id);
    let (validation, accepted) = match output.as_ref() {
        Some(value) => validate_candidate_slate(value, &map, &cards, &open_problems, &config),
        None => (ExpertStageValidation::refused("the lane returned no candidates[]".to_string()), Vec::new()),
    };
    record_stage_attempt(
        paths,
        &contract.cycle_id,
        CANDIDATE_SLATE_ACTION,
        &contract.lane_id,
        validation.valid,
        &validation.reasons,
        &validation.warnings,
    )?;
    let path = candidate_slate_path(paths, &contract.cycle_id);
    if !validation.valid || path.exists() {
        return Ok(None);
    }
    write_json(
        &path,
        &json!({
            "cycle_id": contract.cycle_id,
            "generated_by": contract.lane_id,
            "projected_at": now_iso(),
            "instrument_blind": true,
            "strategy_mix": strategy_mix(&accepted)
                .into_iter()
                .map(|(strategy, count)| json!({"origin_strategy": strategy, "candidates": count}))
                .collect::<Vec<_>>(),
            "candidates": accepted,
            "summary": output.as_ref().and_then(|value| value.get("summary")).cloned().unwrap_or(Value::Null),
            "validation": validation.as_value(),
        }),
    )?;
    Ok(Some(path))
}
