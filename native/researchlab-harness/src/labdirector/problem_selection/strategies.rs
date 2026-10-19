#![allow(unused_imports)]
use super::*;

// --- origin strategies ------------------------------------------------------------
//
// OWNER DECISION 2026-10-06: a slate written under one strategy is one bet made
// eight times. Until now every candidate had to deny a named belief of the field
// (Davis 1971), so a slate was eight belief denials whose decisive experiments
// were all controlled comparisons of the same kind. The owner named three more
// ways a problem worth a programme is found, each fitting a different state of
// the field:
//   * method_leap -- the subfield is still immature, so raising performance
//     matters, but through a mechanism the field has not tried; refining the
//     approaches already published is not a candidate;
//   * bottleneck_transfer -- the bottleneck is one everybody names and the
//     published attacks on it have stalled; the breakthrough is a concept
//     imported from another discipline or from a natural system;
//   * latent_bottleneck -- a demand or bottleneck nobody has named yet, read off
//     what papers work around, assume, or leave unmeasured; the most novelty and
//     the most room, and the most work to uncover.
// The field map (stage 1) now records what each strategy needs: a maturity
// reading per subfield, the named bottlenecks with the approaches already tried
// against them, and the latent signals. The slate (stage 2) must spread across
// at least `min_slate_strategies` of the four, and every candidate carries the
// basis its strategy demands, checked here against the map and the cards. The
// panel, the novelty scout and the owner see the strategy with the candidate.

pub(crate) const BELIEF_DENIAL: &str = "belief_denial";
pub(crate) const METHOD_LEAP: &str = "method_leap";
pub(crate) const BOTTLENECK_TRANSFER: &str = "bottleneck_transfer";
pub(crate) const LATENT_BOTTLENECK: &str = "latent_bottleneck";

pub(crate) const MATURITY_LEVELS: &[&str] = &["immature", "maturing", "mature"];

#[derive(Clone, Copy, Debug)]
pub(crate) struct OriginStrategy {
    pub(crate) id: &'static str,
    pub(crate) fits_when: &'static str,
    pub(crate) candidate_carries: &'static str,
    pub(crate) weak_when: &'static str,
}

pub(crate) const ORIGIN_STRATEGIES: &[OriginStrategy] = &[
    OriginStrategy {
        id: BELIEF_DENIAL,
        fits_when: "the field treats something as settled that a result could deny or sharply qualify (Davis 1971)",
        candidate_carries: "target_belief_id from field_beliefs.beliefs, belief_statement verbatim, papers_holding_belief from its held_by",
        weak_when: "the denial is of something nobody believes, or the panel can call the outcome",
    },
    OriginStrategy {
        id: METHOD_LEAP,
        fits_when: "the subfield is immature or maturing (field_beliefs.subfield_maturity), so a large performance gain still changes what the field does -- but only through a mechanism the field has not tried",
        candidate_carries: "method_leap.new_mechanism (what the method does that no card's method does) and method_leap.departs_from: the card approaches it deliberately does NOT follow and what it drops",
        weak_when: "the subfield is mature (gains there are incremental), or the 'new' method recombines the approaches it departs from",
    },
    OriginStrategy {
        id: BOTTLENECK_TRANSFER,
        fits_when: "a bottleneck everybody names (field_beliefs.known_bottlenecks) whose published attacks have stalled; the way through is a concept imported from another discipline or a natural system",
        candidate_carries: "bottleneck_transfer.bottleneck_id from the map, the imported concept, its source_field (the discipline or natural system), mechanism_mapping (how the concept's mechanism meets the bottleneck's cause) and why_untried_here",
        weak_when: "the concept is one of the bottleneck's approaches_tried under another name, or it addresses the symptom rather than the cause",
    },
    OriginStrategy {
        id: LATENT_BOTTLENECK,
        fits_when: "a demand or bottleneck nobody has named: papers work around it, assume it away, or leave it unmeasured (field_beliefs.latent_signals, and the cards' setups, unstated_assumptions and stated_limitations)",
        candidate_carries: "latent_bottleneck.demand, why_unnamed, and evidence: at least two cards' own evidence_refs showing the workaround, the assumption or the missing measurement",
        weak_when: "the demand is already named in the literature, or practitioners would not recognise it once it is named",
    },
];

pub(crate) fn origin_strategy_ids() -> Vec<&'static str> {
    ORIGIN_STRATEGIES.iter().map(|strategy| strategy.id).collect()
}

/// The catalogue, as every stage lane is handed it.
pub(crate) fn strategy_catalogue() -> Value {
    json!(ORIGIN_STRATEGIES
        .iter()
        .map(|strategy| json!({
            "origin_strategy": strategy.id,
            "fits_when": strategy.fits_when,
            "candidate_carries": strategy.candidate_carries,
            "weak_when": strategy.weak_when,
        }))
        .collect::<Vec<_>>())
}

/// A candidate's declared strategy. One written before strategies existed
/// denied a belief, so that is the default.
pub(crate) fn candidate_origin_strategy(candidate: &Value) -> String {
    selection_text(candidate.get("origin_strategy"))
        .map(selection_key)
        .unwrap_or_else(|| BELIEF_DENIAL.to_string())
}

/// The strategies the published map can support. method_leap and
/// latent_bottleneck draw on the cards themselves and are always open; the
/// other two need their targets mapped.
pub(crate) fn strategies_available(map: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    if !selection_array(map, "beliefs").is_empty() {
        out.push(BELIEF_DENIAL);
    }
    out.push(METHOD_LEAP);
    if !selection_array(map, "known_bottlenecks").is_empty() {
        out.push(BOTTLENECK_TRANSFER);
    }
    out.push(LATENT_BOTTLENECK);
    out
}

/// How many distinct strategies the slate must use: the configured floor, never
/// more than the map makes possible.
pub(crate) fn required_slate_strategies(map: &Value, config: &ExpertSelectionConfig) -> usize {
    config.min_slate_strategies.min(strategies_available(map).len())
}

/// Why a card reference does not support anything: the paper is not a card, or
/// the reference is not one the card carries.
pub(crate) fn card_reference_problem(cards: &ExpertCards, paper_id: &str, evidence_ref: Option<&str>) -> Option<String> {
    let Some(card) = cards.card(paper_id) else {
        return Some(format!("'{paper_id}' is not a SOTA card of this cycle"));
    };
    let Some(evidence_ref) = evidence_ref else {
        return Some(format!("the reference to '{paper_id}' has no evidence_ref"));
    };
    let known = expert_card_evidence_refs(card);
    if !known.is_empty() && !known.contains(evidence_ref) {
        return Some(format!("evidence_ref '{evidence_ref}' is not one the card for '{paper_id}' carries"));
    }
    None
}

fn map_entry<'a>(map: &'a Value, list: &str, id_key: &str, id: &str) -> Option<&'a Value> {
    let key = selection_key(id);
    selection_array(map, list)
        .iter()
        .find(|entry| selection_text(entry.get(id_key)).is_some_and(|found| selection_key(found) == key))
}

pub(crate) fn map_subfield_maturity<'a>(map: &'a Value, subfield_id: &str) -> Option<&'a str> {
    map_entry(map, "subfield_maturity", "subfield_id", subfield_id)
        .and_then(|entry| selection_text(entry.get("maturity")))
}

fn belief_basis(candidate: &Value, map: &Value) -> Result<(), String> {
    let Some(belief_id) = selection_text(candidate.get("target_belief_id")) else {
        return Err("target_belief_id is empty -- a belief_denial candidate must deny a named belief".to_string());
    };
    let Some(belief) = map_entry(map, "beliefs", "belief_id", belief_id) else {
        return Err(format!("target_belief_id '{belief_id}' is not in the field-beliefs map"));
    };
    let holders: BTreeSet<String> = selection_array(belief, "held_by")
        .iter()
        .filter_map(|support| selection_text(support.get("paper_id")))
        .map(selection_key)
        .collect();
    let named_holders = selection_strings(candidate, "papers_holding_belief")
        .into_iter()
        .filter(|paper| holders.contains(&selection_key(paper)))
        .count();
    if named_holders == 0 {
        return Err(format!(
            "papers_holding_belief names none of the papers the map shows holding '{belief_id}'"
        ));
    }
    Ok(())
}

fn method_leap_basis(candidate: &Value, map: &Value, cards: &ExpertCards) -> Result<(), String> {
    let basis = candidate.get("method_leap").filter(|value| value.is_object()).ok_or_else(|| {
        "method_leap is null -- a method_leap candidate must say what its mechanism does that no card's method does, and which card approaches it departs from".to_string()
    })?;
    if selection_text(basis.get("new_mechanism")).is_none() {
        return Err("method_leap.new_mechanism is empty".to_string());
    }
    let departures = selection_array(basis, "departs_from")
        .iter()
        .filter(|item| {
            selection_text(item.get("approach")).is_some()
                && selection_text(item.get("paper_id")).is_some_and(|paper| cards.card(paper).is_some())
        })
        .count();
    if departures == 0 {
        return Err(
            "method_leap.departs_from names no card approach -- a new method is new against something published; name the card and the approach it drops"
                .to_string(),
        );
    }
    if let Some(subfield) = selection_text(candidate.get("subfield_id")) {
        if map_subfield_maturity(map, subfield) == Some("mature") {
            return Err(format!(
                "method_leap in subfield '{subfield}', which the map rates mature: performance gains there are incremental; choose another strategy for it, or map it otherwise with evidence"
            ));
        }
    }
    Ok(())
}

fn bottleneck_transfer_basis(candidate: &Value, map: &Value) -> Result<(), String> {
    let basis = candidate.get("bottleneck_transfer").filter(|value| value.is_object()).ok_or_else(|| {
        "bottleneck_transfer is null -- a bottleneck_transfer candidate must name the mapped bottleneck and the concept it imports".to_string()
    })?;
    let Some(bottleneck_id) = selection_text(basis.get("bottleneck_id")) else {
        return Err("bottleneck_transfer.bottleneck_id is empty".to_string());
    };
    let Some(bottleneck) = map_entry(map, "known_bottlenecks", "bottleneck_id", bottleneck_id) else {
        return Err(format!("bottleneck_transfer.bottleneck_id '{bottleneck_id}' is not in the field-beliefs map"));
    };
    for key in ["concept", "source_field", "mechanism_mapping", "why_untried_here"] {
        if selection_text(basis.get(key)).is_none() {
            return Err(format!("bottleneck_transfer.{key} is empty"));
        }
    }
    let concept = selection_key(selection_text(basis.get("concept")).unwrap_or(""));
    let repeated = selection_strings(bottleneck, "approaches_tried")
        .into_iter()
        .map(|tried| selection_key(&tried))
        .find(|tried| !tried.is_empty() && (tried == &concept || tried.contains(&concept) || concept.contains(tried)));
    if let Some(tried) = repeated {
        return Err(format!(
            "bottleneck_transfer.concept '{concept}' is one of the approaches already tried against '{bottleneck_id}' ('{tried}') -- a breakthrough imports a concept the field has not applied"
        ));
    }
    Ok(())
}

fn latent_bottleneck_basis(candidate: &Value, map: &Value, cards: &ExpertCards, min_evidence: usize) -> Result<(), String> {
    let basis = candidate.get("latent_bottleneck").filter(|value| value.is_object()).ok_or_else(|| {
        "latent_bottleneck is null -- a latent_bottleneck candidate must state the unnamed demand and show it in the cards' own text".to_string()
    })?;
    for key in ["demand", "why_unnamed"] {
        if selection_text(basis.get(key)).is_none() {
            return Err(format!("latent_bottleneck.{key} is empty"));
        }
    }
    if let Some(signal_id) = selection_text(basis.get("latent_signal_id")) {
        if map_entry(map, "latent_signals", "signal_id", signal_id).is_none() {
            return Err(format!("latent_bottleneck.latent_signal_id '{signal_id}' is not in the field-beliefs map"));
        }
    }
    let mut papers = BTreeSet::new();
    let mut problems = Vec::new();
    for item in selection_array(basis, "evidence") {
        let Some(paper_id) = selection_text(item.get("paper_id")) else {
            continue;
        };
        match card_reference_problem(cards, paper_id, selection_text(item.get("evidence_ref"))) {
            Some(problem) => problems.push(problem),
            None if selection_text(item.get("observation")).is_some() => {
                papers.insert(selection_key(paper_id));
            }
            None => problems.push(format!("the evidence from '{paper_id}' records no observation")),
        }
    }
    if papers.len() < min_evidence {
        return Err(format!(
            "latent_bottleneck.evidence shows the demand in {} card(s) through verifiable evidence_refs, at least {} required -- an unnamed bottleneck is read off several papers' workarounds, not asserted{}",
            papers.len(),
            min_evidence,
            if problems.is_empty() { String::new() } else { format!(" ({})", problems.join("; ")) }
        ));
    }
    Ok(())
}

/// Why the candidate's basis does not match its strategy, or nothing when it
/// does. Every strategy's basis is checked against the published map and the
/// cards, never against the candidate's own prose.
pub(crate) fn strategy_basis_problem(
    candidate: &Value,
    map: &Value,
    cards: &ExpertCards,
    config: &ExpertSelectionConfig,
) -> Option<String> {
    let strategy = candidate_origin_strategy(candidate);
    let checked = match strategy.as_str() {
        BELIEF_DENIAL => belief_basis(candidate, map),
        METHOD_LEAP => method_leap_basis(candidate, map, cards),
        BOTTLENECK_TRANSFER => bottleneck_transfer_basis(candidate, map),
        LATENT_BOTTLENECK => latent_bottleneck_basis(candidate, map, cards, config.latent_min_evidence),
        other => Err(format!(
            "origin_strategy '{other}' is not one of {}",
            origin_strategy_ids().join("|")
        )),
    };
    checked.err().map(|problem| format!("[{strategy}] {problem}"))
}

/// The strategies a set of candidates uses, with counts, in catalogue order.
pub(crate) fn strategy_mix(candidates: &[Value]) -> Vec<(String, usize)> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in candidates {
        *counts.entry(candidate_origin_strategy(candidate)).or_default() += 1;
    }
    let mut ordered: Vec<(String, usize)> = origin_strategy_ids()
        .into_iter()
        .filter_map(|id| counts.remove(id).map(|count| (id.to_string(), count)))
        .collect();
    ordered.extend(counts.into_iter());
    ordered
}

pub(crate) fn strategy_mix_text(candidates: &[Value]) -> String {
    let mix = strategy_mix(candidates);
    if mix.is_empty() {
        return "-".to_string();
    }
    mix.iter()
        .map(|(id, count)| format!("{id} x{count}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The strategy's basis, as the owner card and the director see it: one object
/// named after the strategy, or the belief fields for a denial.
pub(crate) fn candidate_strategy_basis(candidate: &Value) -> Value {
    match candidate_origin_strategy(candidate).as_str() {
        METHOD_LEAP => candidate.get("method_leap").cloned().unwrap_or(Value::Null),
        BOTTLENECK_TRANSFER => candidate.get("bottleneck_transfer").cloned().unwrap_or(Value::Null),
        LATENT_BOTTLENECK => candidate.get("latent_bottleneck").cloned().unwrap_or(Value::Null),
        _ => json!({
            "target_belief_id": candidate.get("target_belief_id").cloned().unwrap_or(Value::Null),
            "belief_statement": candidate.get("belief_statement").cloned().unwrap_or(Value::Null),
            "papers_holding_belief": candidate.get("papers_holding_belief").cloned().unwrap_or_else(|| json!([])),
        }),
    }
}

/// One line of a strategy's basis for the owner's markdown.
pub(crate) fn strategy_basis_line(candidate: &Value, map: &Value) -> String {
    let text = |value: Option<&Value>| selection_text(value).unwrap_or("-").to_string();
    match candidate_origin_strategy(candidate).as_str() {
        METHOD_LEAP => {
            let basis = candidate.get("method_leap").unwrap_or(&Value::Null);
            let departures: Vec<String> = selection_array(basis, "departs_from")
                .iter()
                .map(|item| format!("{} ({})", text(item.get("approach")), text(item.get("paper_id"))))
                .collect();
            format!(
                "new mechanism: {}; departs from: {}",
                text(basis.get("new_mechanism")),
                if departures.is_empty() { "-".to_string() } else { departures.join("; ") }
            )
        }
        BOTTLENECK_TRANSFER => {
            let basis = candidate.get("bottleneck_transfer").unwrap_or(&Value::Null);
            let bottleneck_id = text(basis.get("bottleneck_id"));
            let statement = map_entry(map, "known_bottlenecks", "bottleneck_id", &bottleneck_id)
                .and_then(|entry| selection_text(entry.get("statement")))
                .unwrap_or("-");
            format!(
                "bottleneck `{bottleneck_id}` ({statement}); imports {} from {}: {}",
                text(basis.get("concept")),
                text(basis.get("source_field")),
                text(basis.get("mechanism_mapping"))
            )
        }
        LATENT_BOTTLENECK => {
            let basis = candidate.get("latent_bottleneck").unwrap_or(&Value::Null);
            let evidence: Vec<String> = selection_array(basis, "evidence")
                .iter()
                .map(|item| format!("{}: {}", text(item.get("paper_id")), text(item.get("observation"))))
                .collect();
            format!(
                "unnamed demand: {}; why unnamed: {}; seen in: {}",
                text(basis.get("demand")),
                text(basis.get("why_unnamed")),
                if evidence.is_empty() { "-".to_string() } else { evidence.join("; ") }
            )
        }
        _ => {
            let belief_id = text(candidate.get("target_belief_id"));
            let statement = map_entry(map, "beliefs", "belief_id", &belief_id)
                .and_then(|entry| selection_text(entry.get("statement")))
                .or_else(|| selection_text(candidate.get("belief_statement")))
                .unwrap_or("-");
            format!(
                "belief `{belief_id}` it would overturn: {statement} (held by: {})",
                selection_strings(candidate, "papers_holding_belief").join(", ")
            )
        }
    }
}
