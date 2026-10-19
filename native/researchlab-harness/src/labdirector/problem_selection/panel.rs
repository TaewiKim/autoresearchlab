#![allow(unused_imports)]
use super::*;

// Stage 3: an expert panel. Four or five reviewers, each a different subfield's
// senior researcher, score EVERY candidate independently -- each in its own
// lane, dispatched together, none handed another's scores. The scores are sealed
// in the submissions file until every persona has submitted, and only then
// aggregated, deterministically:
//
//   value = impact x outcome uncertainty x soundness,
//   outcome uncertainty = 1 - |2p - 1|, p = the reviewer's probability the
//   hypothesis holds.
//
// A reviewer who can call the outcome (p near 0 or 1) is saying the result is
// not new; a reviewer whose research would not change is saying it is not
// interesting (Davis 1971). Disagreement between reviewers is reported, never
// averaged away.

/// The most reviewers a panel has (RESEARCHLAB_EXPERT_PANEL_SIZE caps it lower).
pub(crate) const MAX_PANEL_SIZE: usize = 5;
/// The fewest: a field map naming fewer subfields is topped up with the
/// cross-cutting reviewers below.
pub(crate) const MIN_PANEL_SIZE: usize = 4;

/// The panel the first cycles -- all robotics -- ran with. A panel already
/// under way with these reviewers keeps them; a new one is drawn from the
/// cycle's own field map (panel_personas).
pub(crate) const EXPERT_PANEL_PERSONAS: &[(&str, &str)] = &[
    (
        "manipulation_policy_learning",
        "a senior researcher in manipulation policy learning: imitation, diffusion and flow policies, dexterous and contact-rich grasping, large manipulation datasets and their evaluation",
    ),
    (
        "legged_locomotion_rl",
        "a senior researcher in legged locomotion reinforcement learning: massively parallel simulated training, teacher-student and online adaptation, rough-terrain and whole-body control",
    ),
    (
        "safe_contact_rich_control",
        "a senior researcher in safe and contact-rich control: contact modelling, constraint satisfaction, safety filters and certified control through contact",
    ),
    (
        "sim_to_real",
        "a senior researcher in sim-to-real transfer: domain randomization, system identification, simulator fidelity and which simulated metrics predict hardware outcomes",
    ),
    (
        "vla_foundation_models",
        "a senior researcher in vision-language-action and robot foundation models: cross-embodiment pretraining, VLA fine-tuning, scaling behaviour and evaluation protocols",
    ),
];

/// Reviewers no field map names, in the order a short panel takes them.
const CROSS_CUTTING_PERSONAS: &[(&str, &str)] = &[
    (
        "methodology",
        "a senior methodologist: experimental design, confounds, statistical power, and what a result can and cannot show",
    ),
    (
        "adjacent_discipline",
        "a senior researcher from the nearest neighbouring discipline, who knows where this field's assumptions came from and where they have failed elsewhere",
    ),
    (
        "field_generalist",
        "a senior researcher with broad command of the field the objective names: its canonical results, its current frontier and its open disputes",
    ),
    (
        "practitioner",
        "a senior practitioner who applies this field's methods and knows which published results hold up outside the papers",
    ),
];

fn persona_slug(text: &str) -> String {
    let slug: String = text
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    slug.split('_').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("_")
}

fn joined_names(subfield: &Value, key: &str) -> String {
    selection_array(subfield, key)
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("; ")
}

/// One reviewer per subfield of the cycle's field map: the panel is the field's
/// own, whatever the field. Read from the instrument-blind view, so no host
/// detail reaches a reviewer.
fn landscape_personas(paths: &AppPaths, cycle_id: &str) -> Vec<(String, String)> {
    let landscape = instrument_blind_landscape(paths, cycle_id);
    let mut seen = BTreeSet::new();
    let mut personas = Vec::new();
    for subfield in selection_array(&landscape, "subfields") {
        let id = selection_text(subfield.get("subfield_id")).map(persona_slug).unwrap_or_default();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let name = selection_text(subfield.get("name")).unwrap_or(&id).to_string();
        let mut persona = format!("a senior researcher in {name}");
        let approaches = joined_names(subfield, "dominant_approaches");
        let benchmarks = joined_names(subfield, "benchmarks");
        if !approaches.is_empty() {
            persona.push_str(&format!(": its dominant approaches ({approaches})"));
        }
        if !benchmarks.is_empty() {
            persona.push_str(&format!(
                "{} the benchmarks it is judged on ({benchmarks})",
                if approaches.is_empty() { ":" } else { " and" }
            ));
        }
        personas.push((format!("subfield_{id}"), persona));
    }
    personas
}

fn legacy_panel_under_way(paths: &AppPaths, cycle_id: &str) -> bool {
    let legacy = |id: &str| EXPERT_PANEL_PERSONAS.iter().any(|(legacy, _)| *legacy == id);
    panel_submissions(paths, cycle_id).keys().any(|id| legacy(id))
        || stage_lanes(paths, cycle_id, EXPERT_PANEL_ACTION).iter().any(|lane| {
            read_json(&lane.role_plan_path)
                .ok()
                .and_then(|plan| lane_panel_persona(Some(&plan)))
                .is_some_and(|id| legacy(&id))
        })
}

fn saved_panel_personas(paths: &AppPaths, cycle_id: &str) -> Vec<(String, String)> {
    read_json(&expert_panel_personas_path(paths, cycle_id))
        .ok()
        .map(|value| {
            selection_array(&value, "personas")
                .iter()
                .filter_map(|entry| {
                    Some((
                        selection_text(entry.get("persona_id"))?.to_string(),
                        selection_text(entry.get("persona"))?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The panel's reviewers. Fixed when the panel is first dispatched
/// (fix_panel_personas), so a field map refreshed later never changes who must
/// still submit. Until then: the robotics panel for a cycle already reviewing
/// with it, else one reviewer per subfield of the cycle's field map, topped up
/// to MIN_PANEL_SIZE with cross-cutting reviewers.
pub(crate) fn panel_personas(paths: &AppPaths, cycle_id: &str, config: &ExpertSelectionConfig) -> Vec<(String, String)> {
    let saved = saved_panel_personas(paths, cycle_id);
    if !saved.is_empty() {
        return saved;
    }
    let size = config.panel_size.clamp(1, MAX_PANEL_SIZE);
    if legacy_panel_under_way(paths, cycle_id) {
        return EXPERT_PANEL_PERSONAS
            .iter()
            .take(size)
            .map(|(id, persona)| (id.to_string(), persona.to_string()))
            .collect();
    }
    let mut personas = landscape_personas(paths, cycle_id);
    personas.truncate(size);
    for (id, persona) in CROSS_CUTTING_PERSONAS {
        if personas.len() >= MIN_PANEL_SIZE.min(size) {
            break;
        }
        personas.push((id.to_string(), persona.to_string()));
    }
    personas
}

/// Record the reviewers the panel was dispatched with.
pub(crate) fn fix_panel_personas(paths: &AppPaths, cycle_id: &str, personas: &[(String, String)]) -> Result<()> {
    let path = expert_panel_personas_path(paths, cycle_id);
    if path.exists() || personas.is_empty() {
        return Ok(());
    }
    write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "fixed_at": now_iso(),
            "personas": personas
                .iter()
                .map(|(id, persona)| json!({"persona_id": id, "persona": persona}))
                .collect::<Vec<_>>(),
        }),
    )
}

fn unit_score(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
}

/// One reviewer's scores, checked: every slate candidate exactly once, three
/// scores in [0, 1], a critique, and the closest prior work the reviewer knows,
/// NAMED -- "I know of nothing close" is not a review.
pub(crate) fn validate_panel_review(output: &Value, candidate_ids: &[String]) -> (ExpertStageValidation, Vec<Value>) {
    let mut out = ExpertStageValidation::default();
    let wanted: BTreeMap<String, &String> = candidate_ids.iter().map(|id| (selection_key(id), id)).collect();
    let mut reviewed: BTreeMap<String, Value> = BTreeMap::new();
    let Some(reviews) = output.get("reviews").and_then(Value::as_array) else {
        out.reasons.push("reviews[] is missing".to_string());
        return (out, Vec::new());
    };
    for (index, review) in reviews.iter().enumerate() {
        let Some(id) = selection_text(review.get("candidate_id")) else {
            out.warnings.push(format!("reviews[{index}] has no candidate_id"));
            continue;
        };
        let key = selection_key(id);
        let Some(canonical) = wanted.get(&key) else {
            out.warnings.push(format!("'{id}' is not a slate candidate"));
            continue;
        };
        if reviewed.contains_key(&key) {
            out.reasons.push(format!("{id} is scored twice"));
            continue;
        }
        let mut problems = Vec::new();
        let probability = unit_score(review.get("predicted_outcome_probability"));
        let impact = unit_score(review.get("impact"));
        let soundness = unit_score(review.get("soundness"));
        if probability.is_none() {
            problems.push("predicted_outcome_probability must be in [0, 1]");
        }
        if impact.is_none() {
            problems.push("impact must be in [0, 1]");
        }
        if soundness.is_none() {
            problems.push("soundness must be in [0, 1]");
        }
        let prior: Vec<Value> = selection_array(review, "closest_prior_work")
            .iter()
            .filter(|work| selection_text(work.get("title")).is_some())
            .cloned()
            .collect();
        if prior.is_empty() {
            problems.push("closest_prior_work must name at least one work by title");
        }
        if selection_text(review.get("critique")).is_none() {
            problems.push("critique is empty");
        }
        if !problems.is_empty() {
            out.reasons.push(format!("{id}: {}", problems.join("; ")));
            continue;
        }
        reviewed.insert(
            key,
            json!({
                "candidate_id": canonical,
                "predicted_outcome_probability": probability,
                "can_call_it": review.get("can_call_it").cloned().unwrap_or(Value::Null),
                "impact": impact,
                "impact_rationale": review.get("impact_rationale").cloned().unwrap_or(Value::Null),
                "soundness": soundness,
                "soundness_concerns": review.get("soundness_concerns").cloned().unwrap_or_else(|| json!([])),
                "closest_prior_work": prior,
                "critique": review.get("critique").cloned().unwrap_or(Value::Null),
            }),
        );
    }
    for (key, id) in &wanted {
        if !reviewed.contains_key(key) {
            out.reasons.push(format!("{id} is not scored -- every candidate is scored by every reviewer"));
        }
    }
    out.valid = out.reasons.is_empty();
    let ordered = candidate_ids
        .iter()
        .filter_map(|id| reviewed.get(&selection_key(id)).cloned())
        .collect();
    (out, ordered)
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn population_std(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let centre = mean(values);
    (values.iter().map(|value| (value - centre).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

pub(crate) fn outcome_uncertainty(probability: f64) -> f64 {
    1.0 - (2.0 * probability - 1.0).abs()
}

/// The deterministic aggregate over sealed submissions (`persona -> reviews`).
///
/// Per reviewer: value = impact x (1 - |2p - 1|) x soundness; per candidate the
/// mean of those. Ties keep the slate's order. `contested` flags a probability
/// spread of 0.4 or more, or a value spread (population sd) of 0.2 or more;
/// `predictable` flags a mean outcome uncertainty under 0.2 -- the panel can
/// call it, so the result is not new whatever the impact.
pub(crate) fn aggregate_expert_panel(candidate_ids: &[String], submissions: &BTreeMap<String, Vec<Value>>) -> Value {
    let mut rows: Vec<(usize, f64, Value)> = Vec::new();
    for (order, id) in candidate_ids.iter().enumerate() {
        let key = selection_key(id);
        let mut probabilities = Vec::new();
        let mut impacts = Vec::new();
        let mut soundnesses = Vec::new();
        let mut uncertainties = Vec::new();
        let mut values = Vec::new();
        let mut per_reviewer = Vec::new();
        for (persona, reviews) in submissions {
            let Some(review) = reviews
                .iter()
                .find(|review| selection_text(review.get("candidate_id")).is_some_and(|found| selection_key(found) == key))
            else {
                continue;
            };
            let probability = review.get("predicted_outcome_probability").and_then(Value::as_f64).unwrap_or(0.5);
            let impact = review.get("impact").and_then(Value::as_f64).unwrap_or(0.0);
            let soundness = review.get("soundness").and_then(Value::as_f64).unwrap_or(0.0);
            let uncertainty = outcome_uncertainty(probability);
            let value = impact * uncertainty * soundness;
            probabilities.push(probability);
            impacts.push(impact);
            soundnesses.push(soundness);
            uncertainties.push(uncertainty);
            values.push(value);
            per_reviewer.push(json!({
                "persona": persona,
                "predicted_outcome_probability": probability,
                "outcome_uncertainty": round4(uncertainty),
                "impact": impact,
                "soundness": soundness,
                "value": round4(value),
                "can_call_it": review.get("can_call_it").cloned().unwrap_or(Value::Null),
                "impact_rationale": review.get("impact_rationale").cloned().unwrap_or(Value::Null),
                "soundness_concerns": review.get("soundness_concerns").cloned().unwrap_or_else(|| json!([])),
                "closest_prior_work": review.get("closest_prior_work").cloned().unwrap_or_else(|| json!([])),
                "critique": review.get("critique").cloned().unwrap_or(Value::Null),
            }));
        }
        let value = mean(&values);
        let spread = probabilities.iter().cloned().fold(f64::NAN, f64::max)
            - probabilities.iter().cloned().fold(f64::NAN, f64::min);
        let spread = if spread.is_finite() { spread } else { 0.0 };
        let value_std = population_std(&values);
        let mean_uncertainty = mean(&uncertainties);
        rows.push((
            order,
            value,
            json!({
                "candidate_id": id,
                "value": round4(value),
                "reviewers": per_reviewer.len(),
                "mean_probability": round4(mean(&probabilities)),
                "mean_outcome_uncertainty": round4(mean_uncertainty),
                "mean_impact": round4(mean(&impacts)),
                "mean_soundness": round4(mean(&soundnesses)),
                "disagreement": {
                    "probability_spread": round4(spread),
                    "probability_std": round4(population_std(&probabilities)),
                    "value_std": round4(value_std),
                    "contested": spread >= 0.4 || value_std >= 0.2,
                },
                "predictable": !uncertainties.is_empty() && mean_uncertainty < 0.2,
                "per_reviewer": per_reviewer,
            }),
        ));
    }
    rows.sort_by(|left, right| {
        round4(right.1)
            .partial_cmp(&round4(left.1))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.0.cmp(&right.0))
    });
    let mut ranking = Vec::new();
    let mut candidates = Vec::new();
    for (rank, (_, _, mut row)) in rows.into_iter().enumerate() {
        row["rank"] = json!(rank + 1);
        ranking.push(row["candidate_id"].clone());
        candidates.push(row);
    }
    json!({
        "formula": "value = mean over reviewers of impact x (1 - |2p - 1|) x soundness; p = the reviewer's probability the hypothesis holds; ties keep slate order",
        "ranking": ranking,
        "candidates": candidates,
        "personas": submissions.keys().collect::<Vec<_>>(),
    })
}

pub(crate) fn published_expert_panel(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    read_published(&expert_panel_path(paths, cycle_id))
}

pub(crate) fn panel_ranking(panel: &Value) -> Vec<String> {
    selection_strings(panel, "ranking")
}

pub(crate) fn panel_row<'a>(panel: &'a Value, candidate_id: &str) -> Option<&'a Value> {
    let key = selection_key(candidate_id);
    selection_array(panel, "candidates")
        .iter()
        .find(|row| selection_text(row.get("candidate_id")).is_some_and(|id| selection_key(id) == key))
}

/// Sealed submissions by persona.
pub(crate) fn panel_submissions(paths: &AppPaths, cycle_id: &str) -> BTreeMap<String, Value> {
    read_json(&expert_panel_submissions_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("submissions").and_then(Value::as_object).cloned())
        .map(|map| map.into_iter().collect())
        .unwrap_or_default()
}

pub(crate) fn lane_panel_persona(role_plan: Option<&Value>) -> Option<String> {
    role_plan
        .and_then(|plan| plan.pointer("/planner_metadata/expert_selection_contract/persona_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Seal one reviewer's scores; publish the aggregate once every persona of the
/// panel has submitted.
pub(crate) fn project_panel_review(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    let config = expert_selection_config();
    let cycle_id = &contract.cycle_id;
    let lane_dir = lane_root(paths, cycle_id, &contract.lane_id);
    let persona = lane_panel_persona(role_plan).unwrap_or_default();
    let stage = format!("{EXPERT_PANEL_ACTION}:{persona}");
    let Some(slate) = published_candidate_slate(paths, cycle_id) else {
        record_stage_attempt(paths, cycle_id, &stage, &contract.lane_id, false, &["no published slate".to_string()], &[])?;
        return Ok(None);
    };
    let candidate_ids: Vec<String> = slate_candidates(&slate)
        .iter()
        .filter_map(|candidate| selection_text(candidate.get("candidate_id")).map(ToString::to_string))
        .collect();
    let output = stage_output(payload, &lane_dir, "panel-review.json", "reviews");
    let (validation, reviews) = match output.as_ref() {
        Some(value) if !persona.is_empty() => validate_panel_review(value, &candidate_ids),
        Some(_) => (
            ExpertStageValidation { reasons: vec!["the lane carries no reviewer persona".to_string()], ..Default::default() },
            Vec::new(),
        ),
        None => (
            ExpertStageValidation { reasons: vec!["the reviewer returned no reviews[]".to_string()], ..Default::default() },
            Vec::new(),
        ),
    };
    record_stage_attempt(paths, cycle_id, &stage, &contract.lane_id, validation.valid, &validation.reasons, &validation.warnings)?;
    if !validation.valid {
        return Ok(None);
    }
    let mut submissions = panel_submissions(paths, cycle_id);
    if submissions.contains_key(&persona) {
        return Ok(None);
    }
    submissions.insert(
        persona.clone(),
        json!({
            "lane_id": contract.lane_id,
            "submitted_at": now_iso(),
            "reviews": reviews,
            "summary": output.as_ref().and_then(|value| value.get("summary")).cloned().unwrap_or(Value::Null),
        }),
    );
    write_json(
        &expert_panel_submissions_path(paths, cycle_id),
        &json!({
            "cycle_id": cycle_id,
            "sealed_until_every_persona_has_submitted": true,
            "submissions": submissions,
        }),
    )?;
    let personas = panel_personas(paths, cycle_id, &config);
    let complete = personas.iter().all(|(id, _)| submissions.contains_key(id));
    let path = expert_panel_path(paths, cycle_id);
    if !complete || path.exists() {
        return Ok(None);
    }
    let by_persona: BTreeMap<String, Vec<Value>> = personas
        .iter()
        .filter_map(|(id, _)| {
            submissions
                .get(id)
                .map(|entry| (id.to_string(), selection_array(entry, "reviews").to_vec()))
        })
        .collect();
    let mut panel = aggregate_expert_panel(&candidate_ids, &by_persona);
    panel["cycle_id"] = json!(cycle_id);
    panel["projected_at"] = json!(now_iso());
    panel["reviewer_lanes"] = json!(submissions
        .iter()
        .map(|(persona, entry)| json!({"persona": persona, "lane_id": entry.get("lane_id")}))
        .collect::<Vec<_>>());
    write_json(&path, &panel)?;
    Ok(Some(path))
}
