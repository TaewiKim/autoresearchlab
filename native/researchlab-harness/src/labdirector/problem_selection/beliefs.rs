#![allow(unused_imports)]
use super::*;

// Stage 1: the field's beliefs -- what the field takes as settled, shown held by
// at least two SOTA cards with their evidence_refs, what each rests on, what is
// untested (a missing ablation, an uncontrolled confound) and where papers
// contradict each other. A candidate is only interesting against one of these
// (Davis 1971): the gap map is the list of assumptions a result could deny.
//
// Since 2026-10-06 the map also carries what the other origin strategies need
// (strategies.rs): a maturity reading per subfield, the bottlenecks everybody
// names with the approaches already tried against them, and the latent signals
// -- what papers work around, assume away or leave unmeasured without naming.

/// A stage's deterministic verdict on what a lane returned.
#[derive(Clone, Debug, Default)]
pub(crate) struct ExpertStageValidation {
    pub(crate) valid: bool,
    pub(crate) reasons: Vec<String>,
    pub(crate) warnings: Vec<String>,
}

impl ExpertStageValidation {
    pub(crate) fn as_value(&self) -> Value {
        json!({
            "valid": self.valid,
            "reasons": self.reasons.iter().take(30).collect::<Vec<_>>(),
            "warnings": self.warnings.iter().take(40).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn refused(reason: String) -> Self {
        Self { reasons: vec![reason], ..Default::default() }
    }
}

/// The beliefs that pass, and why the rest did not.
///
/// A belief counts when at least `belief_min_cards` distinct cards hold it, each
/// through an `evidence_ref` that card actually carries (when the card carries
/// any), and when it names what it rests on and at least one untested thing. A
/// paper that is not a card, or a reference the card does not have, supports
/// nothing.
pub(crate) fn validate_field_beliefs(
    output: &Value,
    cards: &ExpertCards,
    open_problem_ids: &BTreeSet<String>,
    config: &ExpertSelectionConfig,
) -> (ExpertStageValidation, Vec<Value>) {
    let mut out = ExpertStageValidation::default();
    let mut accepted = Vec::new();
    let Some(beliefs) = output.get("beliefs").and_then(Value::as_array) else {
        out.reasons.push("beliefs[] is missing".to_string());
        return (out, accepted);
    };
    let mut seen = BTreeSet::new();
    for (index, belief) in beliefs.iter().enumerate() {
        let Some(id) = selection_text(belief.get("belief_id")) else {
            out.warnings.push(format!("beliefs[{index}] has no belief_id"));
            continue;
        };
        if !seen.insert(id.to_string()) {
            out.reasons.push(format!("belief_id '{id}' is used twice"));
            continue;
        }
        if selection_text(belief.get("statement")).is_none() {
            out.warnings.push(format!("{id}: statement is empty"));
            continue;
        }
        let mut holders = BTreeSet::new();
        for support in selection_array(belief, "held_by") {
            let Some(paper_id) = selection_text(support.get("paper_id")) else {
                continue;
            };
            let Some(card) = cards.card(paper_id) else {
                out.warnings.push(format!("{id}: '{paper_id}' is not a SOTA card of this cycle"));
                continue;
            };
            let Some(evidence_ref) = selection_text(support.get("evidence_ref")) else {
                out.warnings.push(format!("{id}: support from '{paper_id}' has no evidence_ref"));
                continue;
            };
            let known = expert_card_evidence_refs(card);
            if !known.is_empty() && !known.contains(evidence_ref) {
                out.warnings.push(format!(
                    "{id}: evidence_ref '{evidence_ref}' is not one the card for '{paper_id}' carries"
                ));
                continue;
            }
            holders.insert(selection_key(paper_id));
        }
        if holders.len() < config.belief_min_cards {
            out.warnings.push(format!(
                "{id}: held by {} card(s) with a verifiable evidence_ref, at least {} required -- a belief of one paper is that paper's claim, not the field's",
                holders.len(),
                config.belief_min_cards
            ));
            continue;
        }
        if selection_text(belief.get("rests_on")).is_none() {
            out.warnings.push(format!("{id}: rests_on is empty -- say what evidence the belief rests on"));
            continue;
        }
        let untested = selection_array(belief, "untested")
            .iter()
            .filter(|item| selection_text(item.get("what")).is_some())
            .count();
        if untested == 0 {
            out.warnings.push(format!(
                "{id}: nothing untested is named -- a belief with no missing ablation or confound is not a target"
            ));
            continue;
        }
        for problem in selection_strings(belief, "landscape_open_problem_ids") {
            if !open_problem_ids.is_empty() && !open_problem_ids.contains(&problem) {
                out.warnings.push(format!("{id}: landscape_open_problem_id '{problem}' is not in the landscape"));
            }
        }
        accepted.push(belief.clone());
    }
    if accepted.len() < config.min_beliefs {
        out.reasons.push(format!(
            "{} belief(s) held by at least {} cards with verifiable evidence_refs, at least {} required",
            accepted.len(),
            config.belief_min_cards,
            config.min_beliefs
        ));
    }
    let (map_reasons, map_warnings, _) = validate_strategy_map(output, cards, config);
    out.reasons.extend(map_reasons);
    out.warnings.extend(map_warnings);
    out.valid = out.reasons.is_empty();
    (out, accepted)
}

/// The card references that hold up: each names a card and a reference the
/// card carries. The rest are explained, by the entry they were made for.
fn verified_card_references(cards: &ExpertCards, refs: &[Value], id: &str, warnings: &mut Vec<String>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for support in refs {
        let Some(paper_id) = selection_text(support.get("paper_id")) else {
            continue;
        };
        match card_reference_problem(cards, paper_id, selection_text(support.get("evidence_ref"))) {
            Some(problem) => warnings.push(format!("{id}: {problem}")),
            None => {
                out.insert(selection_key(paper_id));
            }
        }
    }
    out
}

/// The map's three strategy sections, checked: a maturity reading per subfield
/// with its evidence; the bottlenecks everybody names (at least
/// `belief_min_cards` cards through their own evidence_refs, and the approaches
/// already tried -- an unattacked bottleneck is a latent signal, not a known
/// one); and the latent signals, each read off at least one card's own text with
/// the demand it implies. Entries that fail are dropped with a warning; too few
/// bottlenecks or signals is a reason, so the next attempt is told to look.
pub(crate) fn validate_strategy_map(
    output: &Value,
    cards: &ExpertCards,
    config: &ExpertSelectionConfig,
) -> (Vec<String>, Vec<String>, Value) {
    let mut reasons = Vec::new();
    let mut warnings = Vec::new();

    let mut maturity = Vec::new();
    let mut seen_subfields = BTreeSet::new();
    for (index, entry) in selection_array(output, "subfield_maturity").iter().enumerate() {
        let Some(subfield) = selection_text(entry.get("subfield_id")) else {
            warnings.push(format!("subfield_maturity[{index}] has no subfield_id"));
            continue;
        };
        let Some(level) = selection_text(entry.get("maturity"))
            .map(selection_key)
            .filter(|level| MATURITY_LEVELS.contains(&level.as_str()))
        else {
            warnings.push(format!(
                "subfield_maturity '{subfield}': maturity must be one of {}",
                MATURITY_LEVELS.join("|")
            ));
            continue;
        };
        if selection_text(entry.get("evidence")).is_none() {
            warnings.push(format!("subfield_maturity '{subfield}': evidence is empty -- say what shows the subfield {level}"));
            continue;
        }
        if !seen_subfields.insert(selection_key(subfield)) {
            warnings.push(format!("subfield_maturity '{subfield}' is rated twice"));
            continue;
        }
        let mut entry = entry.clone();
        entry["maturity"] = json!(level);
        maturity.push(entry);
    }

    let mut bottlenecks = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, entry) in selection_array(output, "known_bottlenecks").iter().enumerate() {
        let Some(id) = selection_text(entry.get("bottleneck_id")) else {
            warnings.push(format!("known_bottlenecks[{index}] has no bottleneck_id"));
            continue;
        };
        if !seen.insert(selection_key(id)) {
            warnings.push(format!("bottleneck_id '{id}' is used twice"));
            continue;
        }
        if selection_text(entry.get("statement")).is_none() {
            warnings.push(format!("{id}: statement is empty"));
            continue;
        }
        let namers = verified_card_references(cards, selection_array(entry, "named_by"), id, &mut warnings);
        if namers.len() < config.belief_min_cards {
            warnings.push(format!(
                "{id}: named by {} card(s) with a verifiable evidence_ref, at least {} required -- a bottleneck everybody knows is named by more than one paper",
                namers.len(),
                config.belief_min_cards
            ));
            continue;
        }
        if selection_strings(entry, "approaches_tried").is_empty() {
            warnings.push(format!(
                "{id}: approaches_tried is empty -- a known bottleneck has been attacked; one nobody has attacked is a latent signal"
            ));
            continue;
        }
        if selection_text(entry.get("why_they_stall")).is_none() {
            warnings.push(format!("{id}: why_they_stall is empty"));
            continue;
        }
        bottlenecks.push(entry.clone());
    }

    let mut latent = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, entry) in selection_array(output, "latent_signals").iter().enumerate() {
        let Some(id) = selection_text(entry.get("signal_id")) else {
            warnings.push(format!("latent_signals[{index}] has no signal_id"));
            continue;
        };
        if !seen.insert(selection_key(id)) {
            warnings.push(format!("signal_id '{id}' is used twice"));
            continue;
        }
        let empty = ["observation", "demand_it_implies", "why_unnamed"]
            .into_iter()
            .find(|key| selection_text(entry.get(*key)).is_none());
        if let Some(key) = empty {
            warnings.push(format!("{id}: {key} is empty"));
            continue;
        }
        let seen_in = verified_card_references(cards, selection_array(entry, "seen_in"), id, &mut warnings);
        if seen_in.is_empty() {
            warnings.push(format!(
                "{id}: seen in no card through a verifiable evidence_ref -- a latent signal is read off a paper's own text, not asserted"
            ));
            continue;
        }
        latent.push(entry.clone());
    }

    if bottlenecks.len() < config.min_known_bottlenecks {
        reasons.push(format!(
            "{} known bottleneck(s) named by at least {} cards with verifiable evidence_refs and the approaches tried against them, at least {} required -- the transfer strategy needs a target",
            bottlenecks.len(),
            config.belief_min_cards,
            config.min_known_bottlenecks
        ));
    }
    if latent.len() < config.min_latent_signals {
        reasons.push(format!(
            "{} latent signal(s) seen in a card through a verifiable evidence_ref, at least {} required -- read the cards' setup, unstated_assumptions, stated_limitations and ablations_missing for what papers work around without naming",
            latent.len(),
            config.min_latent_signals
        ));
    }
    (
        reasons,
        warnings,
        json!({
            "subfield_maturity": maturity,
            "known_bottlenecks": bottlenecks,
            "latent_signals": latent,
        }),
    )
}

pub(crate) fn published_field_beliefs(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    read_published(&field_beliefs_path(paths, cycle_id))
}

pub(crate) fn landscape_open_problem_ids(paths: &AppPaths, cycle_id: &str) -> BTreeSet<String> {
    field_landscape_status(paths, cycle_id).validation.open_problem_ids
}

/// Validate and publish a beliefs lane's output. A published map is never
/// replaced; every attempt is recorded for the next one.
pub(crate) fn project_field_beliefs(
    paths: &AppPaths,
    contract: &LaneContract,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    let config = expert_selection_config();
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output = stage_output(payload, &lane_dir, "field-beliefs.json", "beliefs");
    let cards = expert_cards_status(paths, &contract.cycle_id);
    let open_problems = landscape_open_problem_ids(paths, &contract.cycle_id);
    let (validation, accepted) = match output.as_ref() {
        Some(value) => validate_field_beliefs(value, &cards, &open_problems, &config),
        None => (ExpertStageValidation::refused("the lane returned no beliefs[]".to_string()), Vec::new()),
    };
    record_stage_attempt(
        paths,
        &contract.cycle_id,
        FIELD_BELIEFS_ACTION,
        &contract.lane_id,
        validation.valid,
        &validation.reasons,
        &validation.warnings,
    )?;
    let path = field_beliefs_path(paths, &contract.cycle_id);
    if !validation.valid || path.exists() {
        return Ok(None);
    }
    let output = output.unwrap_or(Value::Null);
    let (_, _, strategy_map) = validate_strategy_map(&output, &cards, &config);
    write_json(
        &path,
        &json!({
            "cycle_id": contract.cycle_id,
            "generated_by": contract.lane_id,
            "projected_at": now_iso(),
            "sota_cards_path": cards.path,
            "beliefs": accepted,
            "contradictions": output.get("contradictions").cloned().unwrap_or_else(|| json!([])),
            "subfield_maturity": strategy_map.get("subfield_maturity").cloned().unwrap_or_else(|| json!([])),
            "known_bottlenecks": strategy_map.get("known_bottlenecks").cloned().unwrap_or_else(|| json!([])),
            "latent_signals": strategy_map.get("latent_signals").cloned().unwrap_or_else(|| json!([])),
            "summary": output.get("summary").cloned().unwrap_or(Value::Null),
            "validation": validation.as_value(),
        }),
    )?;
    Ok(Some(path))
}
