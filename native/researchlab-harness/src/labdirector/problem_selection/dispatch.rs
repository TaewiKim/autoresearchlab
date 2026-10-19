#![allow(unused_imports)]
use super::*;

// Where the pipeline is, and the one lane (or panel of lanes) it needs next.
// Called once per scheduling pass, right after the field-landscape dispatch.

/// The candidates still competing, derived from the panel ranking, the novelty
/// audits and the feasibility verdicts -- and nothing else.
///
/// `in_play` is the first `need` candidates of the panel's ranking that neither
/// stage has struck. Novelty and feasibility can only strike; the order of what
/// survives is the panel's, always. That is the point: a candidate that is
/// merely convenient to run never overtakes one the panel valued more.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ExpertFunnel {
    pub(crate) ranking: Vec<String>,
    pub(crate) in_play: Vec<String>,
    pub(crate) novelty_pending: Vec<String>,
    pub(crate) feasibility_pending: Vec<String>,
    pub(crate) eligible: Vec<String>,
    pub(crate) eliminated: Vec<(String, String)>,
}

pub(crate) fn expert_funnel(
    ranking: &[String],
    audits: &BTreeMap<String, Value>,
    feasibility: &BTreeMap<String, Value>,
    need: usize,
) -> ExpertFunnel {
    let mut funnel = ExpertFunnel { ranking: ranking.to_vec(), ..Default::default() };
    for id in ranking {
        let key = selection_key(id);
        let audit = audits.get(&key);
        if audit.and_then(|item| item.get("struck")).and_then(Value::as_bool) == Some(true) {
            funnel.eliminated.push((id.clone(), "novelty: already published".to_string()));
            continue;
        }
        let assessment = feasibility.get(&key);
        if assessment.and_then(|item| selection_text(item.get("verdict"))) == Some("fail") {
            funnel.eliminated.push((id.clone(), "feasibility: fail".to_string()));
            continue;
        }
        if funnel.in_play.len() >= need {
            continue;
        }
        funnel.in_play.push(id.clone());
        if audit.is_none() {
            funnel.novelty_pending.push(id.clone());
        } else if assessment.is_none() {
            funnel.feasibility_pending.push(id.clone());
        } else {
            funnel.eligible.push(id.clone());
        }
    }
    funnel
}

#[derive(Clone, Debug)]
pub(crate) struct ExpertProgress {
    pub(crate) stage: &'static str,
    pub(crate) funnel: Option<ExpertFunnel>,
}

pub(crate) fn current_expert_funnel(paths: &AppPaths, cycle_id: &str) -> Option<ExpertFunnel> {
    let panel = published_expert_panel(paths, cycle_id)?;
    let config = expert_selection_config();
    Some(expert_funnel(
        &panel_ranking(&panel),
        &novelty_audits(paths, cycle_id),
        &feasibility_assessments(paths, cycle_id),
        config.owner_top_n,
    ))
}

/// Which stage the cycle is in, read from the published artifacts.
pub(crate) fn expert_selection_progress(paths: &AppPaths, cycle_id: &str) -> ExpertProgress {
    let done = |stage| ExpertProgress { stage, funnel: None };
    if !expert_selection_enabled() {
        return done("disabled");
    }
    if !expert_selection_engaged(paths, cycle_id) {
        return done("not_engaged");
    }
    if recorded_owner_selection(paths, cycle_id).is_some() {
        return done("selected");
    }
    if owner_candidates_path(paths, cycle_id).is_file() {
        return done("awaiting_owner_selection");
    }
    if published_field_beliefs(paths, cycle_id).is_none() {
        return done("field_beliefs");
    }
    if published_candidate_slate(paths, cycle_id).is_none() {
        return done("candidate_slate");
    }
    let Some(funnel) = current_expert_funnel(paths, cycle_id) else {
        return done("expert_panel");
    };
    let stage = if !funnel.novelty_pending.is_empty() {
        "novelty_refutation"
    } else if !funnel.feasibility_pending.is_empty() {
        "feasibility"
    } else {
        "owner_checkpoint"
    };
    ExpertProgress { stage, funnel: Some(funnel) }
}

/// Start the pipeline for a cycle that has no lead yet, once there is a field to
/// select from: a valid landscape (when that gate is on) and SOTA cards.
pub(crate) fn engage_expert_selection(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    if !expert_selection_enabled() {
        return Ok(false);
    }
    if expert_selection_engaged(paths, cycle_id) {
        return Ok(true);
    }
    if cycle_has_lead_file(paths, cycle_id) {
        return Ok(false);
    }
    if field_landscape_gate_enabled() && field_landscape_status(paths, cycle_id).state != "valid" {
        return Ok(false);
    }
    // No silent drop: a harvested frontier candidate still owed a review holds
    // the selection (labdirector::frontier_harvest).
    if !frontier_harvest_block_reasons(paths, cycle_id).is_empty() {
        return Ok(false);
    }
    let cards = expert_cards_status(paths, cycle_id);
    if cards.state != "ready" {
        return Ok(false);
    }
    let config = expert_selection_config();
    update_expert_selection_state(paths, cycle_id, |state| {
        state.insert("engaged_at".to_string(), json!(now_iso()));
        state.insert("sota_cards_path".to_string(), json!(cards.path));
        state.insert("sota_card_count".to_string(), json!(cards.cards.len()));
        state.insert("config".to_string(), config.as_value());
    })?;
    Ok(true)
}

fn stage_role_and_prefix(action: &str) -> (&'static str, &'static str) {
    EXPERT_SELECTION_STAGES
        .iter()
        .find(|(known, _, _)| *known == action)
        .map(|(_, role, prefix)| (*role, *prefix))
        .unwrap_or(("lab-director", "followup-selection-"))
}

/// One more lane of this stage may be opened: none is open, and the stage has
/// not failed `max_attempts` times running -- unless a lead selection was
/// refused since, which earns it one more.
pub(crate) fn stage_dispatch_allowed(
    paths: &AppPaths,
    cycle_id: &str,
    attempt_stage: &str,
    lanes: &[StageLane],
    config: &ExpertSelectionConfig,
) -> bool {
    if lanes.iter().any(|lane| !lane.finished) {
        return false;
    }
    trailing_stage_failures(paths, cycle_id, lanes) < config.max_attempts
        || selection_refused_since_stage_attempt(paths, cycle_id, attempt_stage)
}

fn stage_task_markdown(cycle_id: &str, objective: &str, role: &str, action: &str, description: &str) -> String {
    [
        format!("# Expert problem selection: {action}"),
        String::new(),
        format!("- cycle_id: {cycle_id}"),
        format!("- objective: {objective}"),
        "- source_brief_id: expert-selection".to_string(),
        format!("- role: {role}"),
        format!("- task: {description}"),
        "- the full contract for this stage is role_plan.planner_metadata.expert_selection_contract; return exactly the JSON its output contract describes".to_string(),
    ]
    .join("\n")
}

fn create_stage_lane(
    paths: &AppPaths,
    cycle_id: &str,
    action: &str,
    objective: &str,
    description: &str,
    mut contract_metadata: Value,
) -> Result<Value> {
    let (role, prefix) = stage_role_and_prefix(action);
    let lane_id = next_followup_lane_id(paths, cycle_id, prefix)?;
    let brief_id = "expert-selection";
    contract_metadata["stage"] = json!(action);
    let route = expert_selection_model_route();
    let (contract_path, role_plan_path) = if role == "scout" {
        let task_body = followup_task_markdown(cycle_id, objective, role, brief_id, description, &[]);
        let contract_path =
            create_lane_contract(paths, cycle_id, &lane_id, role, "codex-agent", "read-write-scoped", &task_body)?;
        let role_plan_path = write_followup_role_plan(
            paths,
            cycle_id,
            &lane_id,
            role,
            assigned_model_for_role(role, "codex-agent"),
            objective,
            brief_id,
            description,
            action,
            &[],
            &[],
            None,
            None,
            None,
            &[],
            json!({
                "priority_source": "expert_selection",
                "preferred_role": role,
                "novelty_mode": "idea-refutation",
                "selection_scope": "open",
                "expert_selection_contract": contract_metadata,
            }),
        )?;
        let mut plan = read_json(&role_plan_path)?;
        plan["assigned_model"] = route["model"].clone();
        plan["model_route"] = route;
        write_json(&role_plan_path, &plan)?;
        (contract_path, role_plan_path)
    } else {
        let task_body = stage_task_markdown(cycle_id, objective, role, action, description);
        let contract_path =
            create_lane_contract(paths, cycle_id, &lane_id, role, "codex-agent", "read-write-scoped", &task_body)?;
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &lane_id);
        let mut plan = json!({
            "lane_id": lane_id,
            "role": role,
            "action_type": action,
            "source": "expert-selection",
            "source_brief_id": brief_id,
            "assigned_model": route["model"].clone(),
            "model_route": route,
            "objective": objective,
            "followup_description": description,
            "planner_metadata": {
                "priority_source": "expert_selection",
                "expert_selection_contract": contract_metadata,
            },
        });
        if action == CANDIDATE_SLATE_ACTION {
            strip_host_context(&mut plan);
        }
        write_json(&role_plan_path, &plan)?;
        (contract_path, role_plan_path)
    };
    Ok(json!({
        "lane_id": lane_id,
        "role": role,
        "contract_path": contract_path,
        "source_brief_id": brief_id,
        "role_plan_path": role_plan_path,
        "action_type": action,
    }))
}

fn blind_cards(cards: &ExpertCards) -> Value {
    let mut compact = Value::Array(cards.cards.iter().map(|card| expert_compact_card(card, false)).collect());
    strip_host_context(&mut compact);
    compact
}

fn candidate_brief(candidate: &Value) -> Value {
    let mut brief = candidate.clone();
    strip_host_context(&mut brief);
    brief
}

/// Dispatch whatever the pipeline needs next. Returns the lanes it created.
pub(crate) fn dispatch_expert_selection(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !engage_expert_selection(paths, cycle_id)? {
        return Ok(Vec::new());
    }
    let config = expert_selection_config();
    let progress = expert_selection_progress(paths, cycle_id);
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let cards = expert_cards_status(paths, cycle_id);
    let mut created = Vec::new();
    match progress.stage {
        "field_beliefs" => {
            let lanes = stage_lanes(paths, cycle_id, FIELD_BELIEFS_ACTION);
            if !stage_dispatch_allowed(paths, cycle_id, FIELD_BELIEFS_ACTION, &lanes, &config) {
                return Ok(created);
            }
            let description = "FIELD MAP: from the SOTA cards, state the beliefs this field holds -- each shown held by at least two cards through their load_bearing_beliefs or core_claims and their evidence_refs -- what each rests on, what is untested (missing ablations, uncontrolled confounds), and where papers contradict each other. Then what the other origin strategies need: a maturity reading per subfield, the bottlenecks everybody names with the approaches already tried against them, and the latent signals -- what papers work around, assume away or leave unmeasured without naming.";
            created.push(create_stage_lane(
                paths,
                cycle_id,
                FIELD_BELIEFS_ACTION,
                &instrument_blind_objective(&objective),
                description,
                json!({
                    "attempt": lanes.len() + 1,
                    "previous_attempt": latest_stage_attempt(paths, cycle_id, FIELD_BELIEFS_ACTION),
                    "thresholds": {
                        "belief_min_cards": config.belief_min_cards,
                        "min_beliefs": config.min_beliefs,
                        "min_known_bottlenecks": config.min_known_bottlenecks,
                        "min_latent_signals": config.min_latent_signals,
                    },
                    "strategies": strategy_catalogue(),
                    "sota_cards": blind_cards(&cards),
                    "field_landscape": instrument_blind_landscape(paths, cycle_id),
                }),
            )?);
        }
        "candidate_slate" => {
            let lanes = stage_lanes(paths, cycle_id, CANDIDATE_SLATE_ACTION);
            if !stage_dispatch_allowed(paths, cycle_id, CANDIDATE_SLATE_ACTION, &lanes, &config) {
                return Ok(created);
            }
            let beliefs = published_field_beliefs(paths, cycle_id).unwrap_or(Value::Null);
            let description = format!(
                "CANDIDATE SLATE, instrument-blind: write {}-{} candidate (problem, hypothesis) pairs across at least {} subfields and at least {} origin strategies (deny a named belief; a method leap in an immature subfield through a mechanism the field has not tried; a concept imported from another discipline or a natural system against a bottleneck everybody names; a demand nobody has named yet, read off the cards), each with its strategy's basis, the prediction that differs, why either outcome is informative, the decisive experiment, and the open-source assets from the SOTA cards it builds on. This host's instruments are deliberately not shown: choose by what would change the field, not by what can run here.",
                config.slate_min, config.slate_max, config.min_slate_subfields, required_slate_strategies(&beliefs, &config)
            );
            created.push(create_stage_lane(
                paths,
                cycle_id,
                CANDIDATE_SLATE_ACTION,
                &instrument_blind_objective(&objective),
                &description,
                json!({
                    "attempt": lanes.len() + 1,
                    "previous_attempt": latest_stage_attempt(paths, cycle_id, CANDIDATE_SLATE_ACTION),
                    "thresholds": {
                        "slate_min": config.slate_min,
                        "slate_max": config.slate_max,
                        "min_slate_subfields": config.min_slate_subfields,
                        "min_slate_strategies": required_slate_strategies(&beliefs, &config),
                        "latent_min_evidence": config.latent_min_evidence,
                    },
                    "instrument_blind": true,
                    "strategies": strategy_catalogue(),
                    "strategies_available": strategies_available(&beliefs),
                    "field_beliefs": {
                        "beliefs": beliefs.get("beliefs").cloned().unwrap_or_else(|| json!([])),
                        "contradictions": beliefs.get("contradictions").cloned().unwrap_or_else(|| json!([])),
                        "subfield_maturity": beliefs.get("subfield_maturity").cloned().unwrap_or_else(|| json!([])),
                        "known_bottlenecks": beliefs.get("known_bottlenecks").cloned().unwrap_or_else(|| json!([])),
                        "latent_signals": beliefs.get("latent_signals").cloned().unwrap_or_else(|| json!([])),
                    },
                    "sota_cards": blind_cards(&cards),
                    "field_landscape": instrument_blind_landscape(paths, cycle_id),
                }),
            )?);
        }
        "expert_panel" => {
            let Some(slate) = published_candidate_slate(paths, cycle_id) else {
                return Ok(created);
            };
            let submissions = panel_submissions(paths, cycle_id);
            let beliefs = published_field_beliefs(paths, cycle_id).unwrap_or(Value::Null);
            let candidates: Vec<Value> = slate_candidates(&slate).iter().map(candidate_brief).collect();
            let all_lanes = stage_lanes(paths, cycle_id, EXPERT_PANEL_ACTION);
            let personas = panel_personas(paths, cycle_id, &config);
            fix_panel_personas(paths, cycle_id, &personas)?;
            for (persona_id, persona) in personas {
                if submissions.contains_key(&persona_id) {
                    continue;
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
                let attempt_stage = format!("{EXPERT_PANEL_ACTION}:{persona_id}");
                if !stage_dispatch_allowed(paths, cycle_id, &attempt_stage, &lanes, &config) {
                    continue;
                }
                let description = format!(
                    "EXPERT PANEL REVIEW as {persona}: score every slate candidate independently -- your probability the hypothesis holds, whether a result would change your research, soundness, and the closest prior work you know, by name."
                );
                created.push(create_stage_lane(
                    paths,
                    cycle_id,
                    EXPERT_PANEL_ACTION,
                    &instrument_blind_objective(&objective),
                    &description,
                    json!({
                        "attempt": lanes.len() + 1,
                        "previous_attempt": latest_stage_attempt(paths, cycle_id, &attempt_stage),
                        "persona_id": persona_id,
                        "persona": persona,
                        "independence": "You are one of several reviewers scoring the same slate in separate lanes. Other reviewers' scores are sealed until every reviewer has submitted; do not look for them in the cycle state or in other lanes.",
                        "candidates": candidates,
                        "strategies": strategy_catalogue(),
                        "field_beliefs": beliefs.get("beliefs").cloned().unwrap_or_else(|| json!([])),
                        "known_bottlenecks": beliefs.get("known_bottlenecks").cloned().unwrap_or_else(|| json!([])),
                        "latent_signals": beliefs.get("latent_signals").cloned().unwrap_or_else(|| json!([])),
                        "sota_cards": blind_cards(&cards),
                    }),
                )?);
            }
        }
        "novelty_refutation" => {
            let Some(funnel) = progress.funnel.as_ref() else {
                return Ok(created);
            };
            let lanes = stage_lanes(paths, cycle_id, NOVELTY_REFUTATION_ACTION);
            if !stage_dispatch_allowed(paths, cycle_id, NOVELTY_REFUTATION_ACTION, &lanes, &config) {
                return Ok(created);
            }
            let slate = published_candidate_slate(paths, cycle_id).unwrap_or(Value::Null);
            let panel = published_expert_panel(paths, cycle_id).unwrap_or(Value::Null);
            let targets: Vec<String> = funnel.novelty_pending.iter().take(config.novelty_top_k.max(1)).cloned().collect();
            let candidates: Vec<Value> = targets
                .iter()
                .map(|id| {
                    let row = panel_row(&panel, id);
                    json!({
                        "candidate": slate_candidate(&slate, id).cloned().unwrap_or(Value::Null),
                        "panel_rank": row.and_then(|row| row.get("rank")).cloned().unwrap_or(Value::Null),
                        "reviewer_named_prior_work": row
                            .map(|row| {
                                selection_array(row, "per_reviewer")
                                    .iter()
                                    .map(|review| json!({
                                        "persona": review.get("persona"),
                                        "closest_prior_work": review.get("closest_prior_work"),
                                    }))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect();
            let lane_hint = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
            let description = format!(
                "NOVELTY REFUTATION for {}: search for each candidate's core idea itself (not its topic) in the last {} months on Semantic Scholar and arXiv, starting from the prior work the reviewers named; strike a candidate whose core idea is already published, with the citation. Write {NOVELTY_AUDIT_OUTPUT_FILE}.",
                targets.join(", "),
                config.novelty_window_months
            );
            created.push(create_stage_lane(
                paths,
                cycle_id,
                NOVELTY_REFUTATION_ACTION,
                &objective,
                &description,
                json!({
                    "attempt": lanes.len() + 1,
                    "previous_attempt": latest_stage_attempt(paths, cycle_id, NOVELTY_REFUTATION_ACTION),
                    "candidate_ids": targets,
                    "candidates": candidates,
                    "window_months": config.novelty_window_months,
                    "searched_on_or_after": novelty_window_start(config.novelty_window_months),
                    "output_path": lane_root(paths, cycle_id, &lane_hint).join(NOVELTY_AUDIT_OUTPUT_FILE),
                }),
            )?);
        }
        "feasibility" => {
            let Some(funnel) = progress.funnel.as_ref() else {
                return Ok(created);
            };
            let lanes = stage_lanes(paths, cycle_id, FEASIBILITY_AUDIT_ACTION);
            if !stage_dispatch_allowed(paths, cycle_id, FEASIBILITY_AUDIT_ACTION, &lanes, &config) {
                return Ok(created);
            }
            let slate = published_candidate_slate(paths, cycle_id).unwrap_or(Value::Null);
            let audits = novelty_audits(paths, cycle_id);
            let targets = funnel.feasibility_pending.clone();
            let candidates: Vec<Value> = targets
                .iter()
                .map(|id| {
                    json!({
                        "candidate": slate_candidate(&slate, id).cloned().unwrap_or(Value::Null),
                        "novelty_audit": audits.get(&selection_key(id)).cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            let description = format!(
                "FEASIBILITY for {}: for each candidate, check this host (instrument inventory, {} GB VRAM) and the SOTA cards' open-source assets and local copies; return pass or fail with the cheapest faithful setup and a reproduction anchor -- one number a SOTA card reports, reproduced here before the new experiment. Never a score.",
                targets.join(", "),
                config.host_vram_gb
            );
            created.push(create_stage_lane(
                paths,
                cycle_id,
                FEASIBILITY_AUDIT_ACTION,
                &objective,
                &description,
                json!({
                    "attempt": lanes.len() + 1,
                    "previous_attempt": latest_stage_attempt(paths, cycle_id, FEASIBILITY_AUDIT_ACTION),
                    "candidate_ids": targets,
                    "candidates": candidates,
                    "host": {
                        "vram_gb": config.host_vram_gb,
                        "local_reference_roots": config.local_reference_roots,
                    },
                    "instrument_inventory": instrument_inventory_for_feasibility(paths, cycle_id),
                    "sota_cards": cards.cards.iter().map(|card| expert_compact_card(card, true)).collect::<Vec<_>>(),
                }),
            )?);
        }
        "owner_checkpoint" => {
            if let Some(funnel) = progress.funnel.as_ref() {
                publish_owner_checkpoint(paths, cycle_id, funnel)?;
            }
        }
        "awaiting_owner_selection" => {
            ensure_owner_selection_pause(paths, cycle_id)?;
        }
        _ => {}
    }
    Ok(created)
}

/// The first day of the novelty window, as an ISO date.
pub(crate) fn novelty_window_start(window_months: u32) -> String {
    let days = i64::from(window_months) * 31;
    (Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%d").to_string()
}
