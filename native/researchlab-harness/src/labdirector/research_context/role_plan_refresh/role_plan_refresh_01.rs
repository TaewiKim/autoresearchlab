#![allow(unused_imports)]
use super::*;

pub(crate) fn refresh_role_plan_context_before_launch(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
) -> Result<()> {
    if !matches!(
        contract.role.as_str(),
        "lab-director" | "chronicle" | "analyst" | "lab-runner" | "gatekeeper"
    ) {
        return Ok(());
    }
    // An expert-selection stage lane carries exactly the context its stage was
    // dispatched with. The refresh below would hand the slate lane the
    // instrument inventory it must not see, and would turn a panel reviewer
    // (gatekeeper role) into a gate review -- see labdirector::problem_selection.
    if expert_selection_stage_lane(paths, cycle_id, &contract.lane_id) {
        return Ok(());
    }

    let mut candidate_datasets = cycle_fetched_data_bundles(paths, cycle_id);
    // The episodes an engineer generated from the LabDirector's simulation
    // orders, as bundles the pick_dataset path reads unchanged
    // (cycle-b-20260918, 2026-09-18: the owner assigned simulation
    // orchestration to the LabDirector; the analyst analyses, it does not order).
    if contract.role == "analyst" {
        candidate_datasets.extend(simulation_order_bundles(paths, cycle_id)?);
    }
    let reference_resources = cycle_reference_resources(paths, cycle_id);
    if candidate_datasets.is_empty()
        && reference_resources.is_empty()
        && !matches!(
            contract.role.as_str(),
            "lab-director" | "gatekeeper" | "analyst" | "lab-runner"
        )
    {
        return Ok(());
    }

    let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
    let mut role_plan = if role_plan_path.exists() {
        read_json(&role_plan_path)?
    } else {
        json!({})
    };
    if !role_plan.is_object() {
        role_plan = json!({});
    }

    if role_plan.get("lane_id").is_none() {
        role_plan["lane_id"] = json!(contract.lane_id);
    }
    if role_plan.get("role").is_none() {
        role_plan["role"] = json!(contract.role);
    }
    if role_plan.get("source").is_none() {
        role_plan["source"] = json!("dispatch-context-refresh");
    }
    if role_plan.get("objective").is_none() {
        role_plan["objective"] = json!(cycle_objective(paths, cycle_id));
    }
    if contract.role == "lab-runner" {
        recover_lab_runner_handoff_context_from_task(paths, contract, &mut role_plan)?;
    }
    if contract.role == "lab-director" && role_plan.get("action_type").is_none() {
        role_plan["action_type"] = json!("hypothesis_generation");
    }
    if contract.role == "lab-director" {
        let research_notes_contract = lab_director_research_notes_contract(paths, cycle_id);
        role_plan["research_notes_contract"] = research_notes_contract.clone();
        let existing_notes = lab_director_existing_research_notes_context(paths, cycle_id)?;
        if let Some(existing_notes) = existing_notes {
            role_plan["research_notes_context"] = existing_notes.clone();
            let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
            planner_metadata["research_notes_contract"] = research_notes_contract;
            planner_metadata["research_notes_context"] = existing_notes;
        } else {
            let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
            planner_metadata["research_notes_contract"] = research_notes_contract;
        }
        attach_lab_director_context_controls(paths, cycle_id, &mut role_plan)?;
        refresh_lab_director_latest_runner_context(paths, cycle_id, &mut role_plan)?;
        // Refresh the one input the director is told to work from.
        //
        // Both places that set `chronicle_decision_digest` set it only when it is
        // ABSENT -- `planner_metadata["chronicle_decision_digest"] = ...` when the
        // plan is first written, and an `or_insert_with` in the impact mandate. So
        // the digest is computed once, at lane creation, and then carried forward
        // unchanged however long the lane waits. This function exists to refresh a
        // lane's context before it launches, and it refreshed the research notes,
        // the runner context and the dataset bundles -- and not the digest, which
        // is what every director prompt names as the thing to decide from.
        //
        // MEASURED ON cycle-g-v91, 2026-09-13. followup-lab-director-17 was created
        // at 08:10, when no Chronicle digest file existed and the corpus could not
        // be cited. Chronicle wrote the digest at 07:57 and the admitted corpus
        // became citable at 08:36. The lane's plan was rewritten at 08:38 and still
        // carried the 08:10 digest, because every writer of that key declines to
        // overwrite one. A lane that waits hours is told to decide from what was
        // true when it was queued.
        let refreshed_digest = compact_chronicle_decision_digest(paths, cycle_id);
        let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
        planner_metadata["chronicle_decision_digest"] = refreshed_digest;
        // The landscape the lead gate checks, its open problems and citable
        // papers, and why the last selection was refused -- on EVERY director lane,
        // base or follow-up, because the gate applies to all of them.
        let landscape = field_landscape_director_context(paths, cycle_id);
        let landscape_valid = landscape.get("status").and_then(Value::as_str) == Some("valid");
        planner_metadata["field_landscape"] = landscape;
        // The expert-selected candidates, the owner's pick and the slate rule
        // the lead gate applies on top of the landscape's.
        planner_metadata["expert_selection"] = expert_selection_director_context(paths, cycle_id);
        // "Avoid broad repeated scout searches" is an efficiency rule for a cycle
        // that already knows its field. MEASURED ON cycle-b-20260918: with one
        // 2021 review admitted, lab-director-01 wrote "Do not restart broad
        // acquisition" into its own next actions. Before the landscape exists the
        // rule is suspended, where the director reads it.
        if !landscape_valid {
            if let Some(avoid) = planner_metadata
                .get_mut("hypothesis_gate_efficiency_mandate")
                .and_then(|mandate| mandate.get_mut("avoid"))
                .and_then(Value::as_array_mut)
            {
                avoid.retain(|item| {
                    !item
                        .as_str()
                        .map(|text| text.to_ascii_lowercase().contains("broad"))
                        .unwrap_or(false)
                });
            }
            if let Some(mandate) = planner_metadata
                .get_mut("hypothesis_gate_efficiency_mandate")
                .and_then(Value::as_object_mut)
            {
                mandate.insert(
                    "suspended_until_field_landscape_is_valid".to_string(),
                    json!("broad scout acquisition is not wasted exploration while the field landscape is missing or invalid; see planner_metadata.field_landscape.broad_acquisition_override"),
                );
            }
        }
    }
    if contract.role == "chronicle" {
        let direct_corpus_interaction_contract =
            chronicle_direct_corpus_interaction_contract(paths, cycle_id);
        role_plan["direct_corpus_interaction_contract"] =
            direct_corpus_interaction_contract.clone();
        let relevance_contract = chronicle_literature_relevance_contract(paths, cycle_id);
        role_plan["literature_relevance_review"] = relevance_contract.clone();
        let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
        planner_metadata["direct_corpus_interaction_contract"] = direct_corpus_interaction_contract;
        planner_metadata["literature_relevance_review"] = relevance_contract;
    }

    if contract.role == "gatekeeper" {
        let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
        if gate_review_path.exists() {
            let gate_review = read_json(&gate_review_path)?;
            let pending_rubrics = gate_review
                .get("gatekeeper_pending_rubrics")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            let current_target = role_plan
                .get("planner_metadata")
                .and_then(|item| item.get("target_rubric"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !current_target.is_empty()
                && role_plan
                    .get("target_rubric")
                    .and_then(Value::as_str)
                    .is_none()
            {
                role_plan["target_rubric"] = json!(current_target.clone());
            }
            // MEASURED ON cycle-a-20260919, 2026-10-01: 59 unopened
            // gatekeeper lanes accumulated, and this refresh retargeted 58 of
            // them to technical_quality. Once evidence released the dependency
            // gate, all 58 became duplicate reviews of the same rubric. A lane's
            // rubric is dispatch identity; refresh context, never its assignment.
            if current_target.is_empty() {
                if let Some(action) = gate_review
                    .get("recommended_followup_actions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .find(|action| {
                        action.get("type").and_then(Value::as_str)
                            == Some("independent_gate_review_followup")
                            && action
                                .get("target_rubric")
                                .and_then(Value::as_str)
                                .map(|target| {
                                    pending_rubrics.is_empty()
                                        || pending_rubrics.iter().any(|item| item == target)
                                })
                                .unwrap_or(true)
                    })
                {
                    if let Some(action_type) = action.get("type").and_then(Value::as_str) {
                        role_plan["action_type"] = json!(action_type);
                    }
                    if let Some(description) = action.get("description").and_then(Value::as_str) {
                        role_plan["followup_description"] = json!(description);
                    }
                    if let Some(target) = action.get("target_rubric") {
                        role_plan["target_rubric"] = target.clone();
                    }
                    let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
                    planner_metadata["review_action"] = action.clone();
                    if let Some(target) = action.get("target_rubric") {
                        planner_metadata["target_rubric"] = target.clone();
                    }
                    if let Some(target_score) = action.get("target_score") {
                        planner_metadata["target_score"] = target_score.clone();
                    }
                    if let Some(current_score) = action.get("current_score") {
                        planner_metadata["current_score"] = current_score.clone();
                    }
                    if let Some(blockers) = action.get("blocker_reasons") {
                        planner_metadata["blocker_reasons"] = blockers.clone();
                    }
                    if let Some(challenges) = action.get("challenge_questions") {
                        planner_metadata["challenge_questions"] = challenges.clone();
                    }
                }
            }
            // MEASURED ON cycle-a-20260919, 2026-10-13: four queued
            // gate reviews launched after the director replaced the lead, but
            // retained the retired lead, its evidence, and its dispatch-time
            // lead key. All four completed successfully and were correctly
            // superseded by the aggregator, so no queued review could publish
            // a gate round for the current lead. Keep the rubric assignment,
            // but refresh the subject and evidence contract at launch.
            let is_independent_gate_review = role_plan
                .get("action_type")
                .and_then(Value::as_str)
                == Some("independent_gate_review_followup");
            if is_independent_gate_review && !current_target.is_empty() {
                let current_action = gate_review
                    .get("recommended_followup_actions")
                    .and_then(Value::as_array)
                    .and_then(|actions| {
                        actions.iter().find(|action| {
                            action.get("type").and_then(Value::as_str)
                                == Some("independent_gate_review_followup")
                                && action.get("target_rubric").and_then(Value::as_str)
                                    == Some(current_target.as_str())
                        })
                    })
                    .cloned();
                if let Some(action) = current_action {
                    if let Some(description) = action.get("description") {
                        role_plan["followup_description"] = description.clone();
                    }
                    if let Some(candidates) = action
                        .get("candidate_hypotheses")
                        .and_then(Value::as_array)
                    {
                        role_plan["assigned_hypotheses"] = Value::Array(
                            candidates
                                .iter()
                                .filter_map(|candidate| candidate.get("statement").cloned())
                                .collect(),
                        );
                    }
                    let current_lead = current_lead_under_review(paths, cycle_id);
                    let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
                    planner_metadata["current_lead_under_review"] = current_lead;
                    planner_metadata["gate_review_lead_key"] = action
                        .get("gate_review_lead_key")
                        .cloned()
                        .unwrap_or(Value::Null);
                    planner_metadata["review_action"] = action.clone();
                    for key in [
                        "validation_results",
                        "latest_validation_lane_id",
                        "latest_validation_summary",
                    ] {
                        planner_metadata[key] = action.get(key).cloned().unwrap_or(Value::Null);
                    }
                }
            }
            let previous_review_context = role_plan
                .get("previous_review_context")
                .filter(|item| !item.is_null())
                .cloned()
                .or_else(|| gate_review.get("previous_review_context").cloned())
                .or_else(|| {
                    gate_review
                        .get("gate_reviewer_context")
                        .and_then(|item| item.get("previous_review_context"))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            let chronicle_research_context = role_plan
                .get("chronicle_research_context")
                .filter(|item| !item.is_null())
                .cloned()
                .or_else(|| gate_review.get("chronicle_research_context").cloned())
                .or_else(|| {
                    gate_review
                        .get("gate_reviewer_context")
                        .and_then(|item| item.get("chronicle_research_context"))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            let gate_reviewer_context = role_plan
                .get("gate_reviewer_context")
                .filter(|item| !item.is_null())
                .cloned()
                .or_else(|| gate_review.get("gate_reviewer_context").cloned())
                .unwrap_or_else(|| {
                    json!({
                        "previous_review_context": previous_review_context.clone(),
                        "chronicle_research_context": chronicle_research_context.clone(),
                    })
                });
            role_plan["previous_review_context"] = previous_review_context.clone();
            role_plan["chronicle_research_context"] = chronicle_research_context.clone();
            role_plan["gate_reviewer_context"] = gate_reviewer_context.clone();
            let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
            planner_metadata["previous_review_context"] = previous_review_context;
            planner_metadata["chronicle_research_context"] = chronicle_research_context;
            planner_metadata["gate_reviewer_context"] = gate_reviewer_context;
            planner_metadata["reviewer_must_read_context"] =
                json!(["previous_review_context", "chronicle_research_context"]);
        }
    }

    let analyst_agent_mandate = if contract.role == "analyst" {
        Some(open_source_analysis_agent_mandate_for_context(
            role_plan
                .get("objective")
                .and_then(Value::as_str)
                .unwrap_or(""),
            &candidate_datasets,
            &reference_resources,
        ))
    } else {
        None
    };
    if let Some(mandate) = analyst_agent_mandate.as_ref() {
        role_plan["open_source_analysis_agent_discovery"] = mandate.clone();
    }

    // Some cycles CONSTRUCT their validation inputs rather than fetching them,
    // and for those the materialization mandates below must not block analysis
    // on a downloaded bundle or bind the claim to an off-objective one -- that
    // dead end kept the runner from ever dispatching.
    //
    // Whether a cycle constructs its inputs is a MEASURED capability, not a
    // field. This asked the domain classifier and answered "cs", so a cycle in
    // any other field that also generates its own inputs -- a simulation, a
    // synthetic benchmark, a solver sweep -- was told to wait for a bundle that
    // would never arrive. The probe already records the answer: a verified
    // instrument whose question is about building or generating the input in
    // memory is a cycle that makes its own data.
    let generates_own_inputs = instrument_inventory_generates_inputs(paths, cycle_id);

    // Read before the mutable borrow below: a runner failure implicates the
    // selected tool whatever the data's scale.
    let recovering_from_runner_failure = role_plan
        .get("action_type")
        .and_then(Value::as_str)
        .map(|action| action.contains("runner_failure_recovery"))
        .unwrap_or(false);
    let is_director_lane = role_plan.get("role").and_then(Value::as_str) == Some("lab-director");
    {
        let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
        // What this environment was MEASURED to observe. See instrument_probe_plan.js
        // and drivers/analysis/instrument_probe.py: the output contract asks the
        // director to justify answerable_here_because with a verified instrument, and
        // until this key existed there was nothing to verify against.
        planner_metadata["instrument_inventory"] = instrument_inventory_digest(paths, cycle_id);
        // The lead the ledger is currently protecting, delivered to EVERY lane that
        // could pivot away from it - not just to the one recovery-requery path that
        // happened to prepend it to a description.
        //
        // MEASURED on cycle-g-v84: the ledger denied the pivot 45 times
        // ("critical_memory_suppression_blocked_lead_still_improving", protecting
        // hyp:8adfd938 at novelty 38 / technical_quality 35 - the cycle's best), the
        // directive naming that lead WAS published to state, and it reached 3 of 77
        // lane prompts. One lab-director lane out of thirteen. The cycle dropped the
        // protected lead at 14:41 and every later round scored lower: 38/35 -> 24/28
        // -> 18 -> 20, five flat rounds, stagnation halt.
        //
        // This is the fourth time a researchlab rule has looked ignored and turned
        // out never to have been DELIVERED, and the third time the cause was that
        // more than one dispatch path builds the same lane type while only one
        // carries the governance context. Putting it in planner_metadata means it
        // rides the role plan itself, which every path writes.
        if let Some(protection) = lead_protection_payload(paths, cycle_id) {
            planner_metadata["lead_protection"] = protection;
        }
        // OWNER DECISION 2026-10-06, after ScientistTwo (arXiv 2609.19644): a
        // review below the bar there triggers supplementary experiments aimed at
        // the reviewer's objections before anything else. The director gets the
        // gate's binding rubric and objections as a list to answer
        // (rebuttal_targets) and the pilot results of the runner-up candidates
        // it ordered (alternate_pilots), so a replacement starts from a pilot.
        if is_director_lane {
            planner_metadata["research_clues"] = research_clues_payload(paths, cycle_id);
            if let Some(targets) = rebuttal_targets(paths, cycle_id) {
                planner_metadata["rebuttal_targets"] = targets;
            }
            let alternates = alternate_pilots(paths, cycle_id);
            if !alternates.is_empty() {
                planner_metadata["alternate_pilots"] = json!(alternates);
            }
        }
        if let Some(mandate) = analyst_agent_mandate.as_ref() {
            planner_metadata["open_source_analysis_agent_mandate"] = mandate.clone();
            let (required, because) = crate::labdirector::policy::open_source_discovery_requirement(
                mandate,
                recovering_from_runner_failure,
            );
            planner_metadata["require_open_source_analysis_agent_discovery"] = json!(required);
            planner_metadata["open_source_discovery_required_because"] = json!(because);
        }
        if generates_own_inputs {
            if !candidate_datasets.is_empty() {
                planner_metadata["candidate_datasets"] = Value::Array(candidate_datasets.clone());
            }
            planner_metadata["materialized_bundle_mandate"] = json!({
                "active": true,
                "selection_rule": "When the chosen validation generates its data procedurally, construct the required experimental inputs with the selected, verified instrument and compare methods under matched resource budgets. Such a self-contained experiment does not require a downloaded dataset bundle. Do NOT bind the claim to off-objective fetched bundles; record why they do not match. Set identification_strategy.materialized_dataset.mode to procedural only when the blueprint actually generates its inputs, and describe the actual generation method. Otherwise identify the real dataset or benchmark inputs the selected method requires. Declare only the dependencies of the selected tool and emit an executable measurement blueprint for lab-runner; no particular simulator or renderer is required.",
                "analysis_blocked_until_materialized": false,
                "procedural_data_generation_acceptable": true,
                "hypothesis_before_validation": true,
                "require_same_dataset_reference_before_validation": false,
            });
        } else if !candidate_datasets.is_empty() {
            planner_metadata["candidate_datasets"] = Value::Array(candidate_datasets.clone());
            planner_metadata["materialized_bundle_mandate"] = json!({
                "active": true,
                "selection_rule": "If candidate_datasets is non-empty, bind the KG-derived lead hypothesis to the best matching fetched bundle for validation. Do not require same-dataset reference papers before hypothesis generation; retrieve/cite them before analyst validation design and promotion. Record bundle_path, candidate_doi, and required CSV/column families in identification_strategy.materialized_dataset when a matching bundle exists.",
                "hypothesis_source": "literature_graph_plus_data_graph",
                "forbid_literature_only_primary_target": false,
                "require_same_dataset_reference_before_validation": true,
                "reference_method_baseline_required_before_validation": true,
            });
        } else if contract.role == "lab-director" {
            planner_metadata["materialized_bundle_mandate"] = json!({
                "active": false,
                "selection_rule": "No fetched bundle is currently visible. Still select the best data-verifiable hypothesis from the literature_graph + data_graph when those graphs support one; mark validation_data_status=needs_materialization and emit a concrete data_acquisition_followup naming the dataset/accession/cohort needed for validation. Do not defer hypothesis selection solely because the validation bundle is not downloaded yet.",
                "hypothesis_before_validation": true,
                "analysis_blocked_until_materialized": true,
                "require_same_dataset_reference_before_validation": true,
            });
        }
        if !reference_resources.is_empty() {
            planner_metadata["reference_resources"] = Value::Array(reference_resources.clone());
            planner_metadata["reference_resource_mandate"] = json!({
                "active": true,
                "priority": "high",
                "why": "GitHub repositories, data-availability links, and same-paper supplementary resources are high-value provenance for reproducibility, hidden dataset links, preprocessing choices, model baselines, and validation code.",
                "lab_director_instruction": "Use reference_resources when selecting or reframing hypotheses. Prefer executable hypotheses whose reference papers expose reusable data/code; request follow-up if a GitHub/data-availability resource likely contains missing accessions, metadata, or scripts.",
                "analyst_instruction": "Before issuing a handoff, inspect reference_resources and reuse compatible preprocessing, feature engineering, model-selection, and validation ideas. Explicitly cite which repo/data link was reused or why it was rejected.",
                "lab_runner_instruction": "Treat linked code/data as implementation references and provenance, but keep final generated validation code self-contained in the cycle artifacts.",
            });
        }
    }
    if !candidate_datasets.is_empty() && !generates_own_inputs {
        role_plan["materialized_dataset_context"] = json!({
            "candidate_datasets": candidate_datasets,
            "selection_rule": "Treat these fetched bundles as the executable validation data universe for this dispatch. The hypothesis should already come from literature_graph + data_graph; when a fetched bundle matches it, bind the hypothesis to that bundle for analysis. Same-dataset papers/baselines are required before validation design and promotion, not before initial hypothesis generation.",
        });
    }
    if !reference_resources.is_empty() {
        role_plan["reference_resource_context"] = json!({
            "resources": reference_resources,
            "usage_rule": "Actively use these same-paper GitHub/data/supplementary resources rather than merely listing them. Mine them for dataset URLs/accessions, sample metadata, preprocessing scripts, model baselines, validation splits, and reproducibility constraints; cite the resource in hypothesis strategy and analyst handoff when used.",
        });
    }

    {
        let planner_metadata = ensure_object_field(&mut role_plan, "planner_metadata");
        let (impact_first_hypothesis_mandate, hypothesis_generation_policy) =
            promote_impact_first_hypothesis_mandate(&contract.role, planner_metadata);
        if !impact_first_hypothesis_mandate.is_null() {
            role_plan["impact_first_hypothesis_mandate"] = impact_first_hypothesis_mandate;
            role_plan["hypothesis_generation_policy"] = hypothesis_generation_policy;
        }
    }

    write_json(&role_plan_path, &role_plan)?;
    annotate_contract_queue_role_plan(
        paths,
        cycle_id,
        &contract.lane_id,
        &role_plan_path,
        role_plan
            .get("action_type")
            .and_then(Value::as_str)
            .unwrap_or("launch_context_refresh"),
        role_plan
            .get("source_brief_id")
            .and_then(Value::as_str)
            .unwrap_or("launch_context_refresh"),
    )?;
    Ok(())
}

pub(crate) fn handoff_path_from_task_text(text: &str) -> Option<String> {
    let marker = "handoff-validation-plan.json";
    let marker_start = text.find(marker)?;
    let end = marker_start + marker.len();
    let prefix = &text[..end];
    let start = prefix
        .rfind(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}'
                )
        })
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let candidate = prefix[start..end]
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']'));
    if candidate.ends_with(marker) {
        Some(candidate.to_string())
    } else {
        None
    }
}

pub(crate) fn resolve_task_handoff_path(paths: &AppPaths, handoff_path: &str) -> PathBuf {
    let path = PathBuf::from(handoff_path);
    if path.is_absolute() {
        path
    } else {
        paths.project_root.join(path)
    }
}

pub(crate) fn role_plan_value_missing(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .map(|item| item.is_null() || item.as_str().map(str::trim).unwrap_or("").is_empty())
        .unwrap_or(true)
}

pub(crate) fn recover_lab_runner_handoff_context_from_task(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: &mut Value,
) -> Result<()> {
    let task_text = match fs::read_to_string(&contract.task_file) {
        Ok(text) => text,
        Err(_) => return Ok(()),
    };
    let Some(raw_handoff_path) = handoff_path_from_task_text(&task_text) else {
        return Ok(());
    };
    let handoff_path = resolve_task_handoff_path(paths, &raw_handoff_path);
    if !handoff_path.exists() {
        return Ok(());
    }
    let handoff = read_json(&handoff_path)?;
    let handoff_path_text = handoff_path.display().to_string();
    if role_plan_value_missing(role_plan, "source_brief_id") {
        let source_brief_id = if task_text.contains("analyst handoff artifact") {
            "analyst-handoff-artifact"
        } else {
            "analyst-handoff"
        };
        role_plan["source_brief_id"] = json!(source_brief_id);
    }
    if role_plan_value_missing(role_plan, "action_type") {
        role_plan["action_type"] = json!("methods_followup");
    }
    if let Some(dataset_root) = handoff.get("dataset_root").filter(|value| !value.is_null()) {
        if role_plan
            .get("dataset_root")
            .map(Value::is_null)
            .unwrap_or(true)
        {
            role_plan["dataset_root"] = dataset_root.clone();
        }
    }
    let analysis_request = json!({
        "source": "task_handoff_context_recovery",
        "handoff_path": handoff_path_text,
        "analyst_handoff": handoff,
    });
    if role_plan
        .get("analysis_request")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        role_plan["analysis_request"] = analysis_request.clone();
    }
    let planner_metadata = ensure_object_field(role_plan, "planner_metadata");
    if planner_metadata
        .get("analysis_request")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        planner_metadata["analysis_request"] = analysis_request.clone();
    }
    planner_metadata["analyst_handoff_path"] = analysis_request["handoff_path"].clone();
    planner_metadata["analyst_handoff"] = analysis_request["analyst_handoff"].clone();
    if let Some(dataset_root) = analysis_request["analyst_handoff"]
        .get("dataset_root")
        .filter(|value| !value.is_null())
    {
        planner_metadata["dataset_root"] = dataset_root.clone();
    }
    planner_metadata["handoff_context_recovered_from_task"] = json!(true);
    Ok(())
}

pub(crate) fn latest_dataset_selection(paths: &AppPaths, cycle_id: &str) -> Result<Option<Value>> {
    let artifacts_root = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id);
    if !artifacts_root.exists() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in read_dir(&artifacts_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let lane_id = entry.file_name().to_string_lossy().to_string();
        let result_path = entry.path().join("result.json");
        if !result_path.exists() {
            continue;
        }
        let result = read_lane_result_json(&result_path)?;
        let driver = result.get("driver").and_then(Value::as_str).unwrap_or("");
        if driver != "native-readonly-scan" {
            continue;
        }
        let modified_at = fs::metadata(&result_path)
            .and_then(|meta| meta.modified())
            .ok();
        candidates.push((modified_at, lane_id, result));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(candidates.pop().map(|(_, _, result)| result))
}

pub(crate) fn latest_failed_lab_runner_context(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let mut candidates = Vec::new();
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_lab_runner(&lane_id) {
            continue;
        }
        let run_state_path = lane_dir.join("run-state.json");
        let final_status_path = lane_dir.join("final-status.json");
        let lane_result_path = lane_dir.join("result.json");
        if !run_state_path.exists() || !final_status_path.exists() || !lane_result_path.exists() {
            continue;
        }
        let run_state = read_json(&run_state_path)?;
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if run_state.get("role").and_then(Value::as_str) != Some("lab-runner") {
            continue;
        }
        if final_status.get("status").and_then(Value::as_str) != Some("failed") {
            continue;
        }
        let result_path =
            compact_lab_runner_result_path(paths, cycle_id, &lane_id, &lane_dir, &final_status);
        let result = read_json_if_below(&result_path, 5 * 1024 * 1024)?.unwrap_or_else(|| {
            json!({
                "status": "failed",
                "summary": "failed lab-runner result exceeded compact context read limit",
                "result_path": result_path.display().to_string()
            })
        });
        let experiment_result = result
            .get("experiment_result")
            .cloned()
            .or_else(|| result.get("validation_coding_result").cloned())
            .unwrap_or(Value::Null);
        let stderr_path = experiment_result
            .get("stderr_path")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let stderr_excerpt = stderr_path
            .as_ref()
            .filter(|path| path.exists())
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|text| text.chars().take(1200).collect::<String>())
            .unwrap_or_default();
        let lane_id = run_state
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or("lab-runner")
            .to_string();
        let modified_at = fs::metadata(&lane_result_path)
            .and_then(|meta| meta.modified())
            .ok();
        candidates.push((
            modified_at,
            json!({
                "lane_id": lane_id,
                "result_path": result_path.display().to_string(),
                "reason": experiment_result.get("reason").cloned().unwrap_or(Value::Null),
                "returncode": experiment_result.get("returncode").cloned().unwrap_or(Value::Null),
                "script_path": experiment_result.get("script_path").cloned().unwrap_or(Value::Null),
                "stderr_path": experiment_result.get("stderr_path").cloned().unwrap_or(Value::Null),
                "stderr_excerpt": stderr_excerpt,
                "last_message_path": experiment_result.get("last_message_path").cloned().unwrap_or(Value::Null),
                "validation_coding_task": result
                    .get("role_plan")
                    .and_then(|value| value.get("validation_coding_task"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "instruction_handoff_sources": result
                    .get("role_plan")
                    .and_then(|value| value.get("instruction_handoff_sources"))
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                "analyst_handoff_path": result
                    .get("role_plan")
                    .and_then(|value| value.get("planner_metadata"))
                    .and_then(|value| value.get("analyst_handoff_path"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "analyst_handoff": result
                    .get("role_plan")
                    .and_then(|value| value.get("planner_metadata"))
                    .and_then(|value| value.get("analyst_handoff"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }),
        ));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates.pop().map(|(_, result)| result))
}

pub(crate) fn normalized_path_key(path: &str) -> String {
    let path_buf = PathBuf::from(path);
    fs::canonicalize(&path_buf)
        .unwrap_or(path_buf)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn lab_runner_result_analyst_handoff_path(result: &Value) -> Option<&str> {
    result
        .get("role_plan")
        .and_then(|value| value.get("planner_metadata"))
        .and_then(|value| value.get("analyst_handoff_path"))
        .and_then(Value::as_str)
        .or_else(|| {
            result
                .get("planner_metadata")
                .and_then(|value| value.get("analyst_handoff_path"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            result
                .get("role_plan")
                .and_then(|value| value.get("planner_metadata"))
                .and_then(|value| value.get("analysis_request"))
                .and_then(|value| value.get("handoff_path"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            result
                .get("analysis_request")
                .and_then(|value| value.get("handoff_path"))
                .and_then(Value::as_str)
        })
}

pub(crate) fn lab_runner_role_plan_analyst_handoff_path(role_plan: &Value) -> Option<&str> {
    role_plan
        .get("planner_metadata")
        .and_then(|value| value.get("analysis_request"))
        .and_then(|value| value.get("handoff_path"))
        .and_then(Value::as_str)
        .or_else(|| {
            role_plan
                .get("planner_metadata")
                .and_then(|value| value.get("analyst_handoff_path"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            role_plan
                .get("analysis_request")
                .and_then(|value| value.get("handoff_path"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            role_plan
                .get("analyst_handoff_path")
                .and_then(Value::as_str)
        })
}

pub(crate) fn lab_runner_result_is_direct_analyst_handoff(result: &Value) -> bool {
    let source_brief_id = result
        .get("role_plan")
        .and_then(|value| value.get("source_brief_id"))
        .or_else(|| result.get("source_brief_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let action_type = result
        .get("role_plan")
        .and_then(|value| value.get("action_type"))
        .or_else(|| result.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    source_brief_id.starts_with("analyst-handoff") && action_type == "methods_followup"
}

pub(crate) fn lab_runner_role_plan_is_direct_analyst_handoff(role_plan: &Value) -> bool {
    let source_brief_id = role_plan
        .get("source_brief_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let action_type = role_plan
        .get("action_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    source_brief_id.starts_with("analyst-handoff") && action_type == "methods_followup"
}

pub(crate) fn read_json_if_below(path: &Path, max_bytes: u64) -> Result<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(max_bytes + 1);
    if size > max_bytes {
        return Ok(None);
    }
    Ok(Some(read_json(path)?))
}

pub(crate) fn compact_lab_runner_result_path(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    lane_dir: &Path,
    final_status: &Value,
) -> PathBuf {
    let artifact_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id)
        .join(lane_id);
    let artifact_result = artifact_dir.join("result.json");
    if artifact_result.exists() {
        return artifact_result;
    }
    let validation_summary = artifact_dir.join("validation-summary.json");
    if validation_summary.exists() {
        return validation_summary;
    }
    final_status
        .get("result_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| lane_dir.join("result.json"))
}

pub(crate) fn role_plan_references_handoff(
    role_plan_path: &Path,
    handoff_path: &str,
    handoff_key: &str,
) -> Result<Option<bool>> {
    if !role_plan_path.exists() {
        return Ok(None);
    }
    let role_plan = read_json(role_plan_path)?;
    let candidate_paths = [
        role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("analyst_handoff_path"))
            .and_then(Value::as_str),
        role_plan
            .get("planner_metadata")
            .and_then(|value| value.get("analysis_request"))
            .and_then(|value| value.get("handoff_path"))
            .and_then(Value::as_str),
        role_plan
            .get("analysis_request")
            .and_then(|value| value.get("handoff_path"))
            .and_then(Value::as_str),
        role_plan
            .get("analyst_handoff_path")
            .and_then(Value::as_str),
    ];
    let mut saw_structured_reference = false;
    for candidate_path in candidate_paths.into_iter().flatten() {
        saw_structured_reference = true;
        if normalized_path_key(candidate_path) == handoff_key {
            return Ok(Some(true));
        }
    }
    if saw_structured_reference {
        return Ok(Some(false));
    }
    let role_plan_window = json_file_window_text(role_plan_path, 128 * 1024)?;
    if role_plan_window.contains(handoff_path) || role_plan_window.contains(handoff_key) {
        return Ok(Some(true));
    }
    Ok(None)
}

pub(crate) fn file_contains_any_text(path: &Path, needles: &[String]) -> Result<bool> {
    let needles: Vec<&[u8]> = needles
        .iter()
        .filter(|needle| !needle.is_empty())
        .map(|needle| needle.as_bytes())
        .collect();
    if needles.is_empty() {
        return Ok(false);
    }
    let max_needle_len = needles.iter().map(|needle| needle.len()).max().unwrap_or(0);
    let overlap_len = max_needle_len.saturating_sub(1);
    let mut file = fs::File::open(path)?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut overlap: Vec<u8> = Vec::new();
    loop {
        let bytes_read = std::io::Read::read(&mut file, &mut buffer)?;
        if bytes_read == 0 {
            return Ok(false);
        }
        let mut window = Vec::with_capacity(overlap.len() + bytes_read);
        window.extend_from_slice(&overlap);
        window.extend_from_slice(&buffer[..bytes_read]);
        if needles.iter().any(|needle| {
            window
                .windows(needle.len())
                .any(|candidate| candidate == *needle)
        }) {
            return Ok(true);
        }
        if overlap_len == 0 {
            overlap.clear();
        } else if window.len() > overlap_len {
            overlap = window[window.len() - overlap_len..].to_vec();
        } else {
            overlap = window;
        }
    }
}

/// The measured instrument inventory, compacted for a decision.
///
/// WHY A DIGEST AND NOT THE FILE. The probe records every measurement it took -
/// per-probe timings, raw deltas, the error text of each absence - because that
/// is what makes a capability claim checkable afterwards. A director choosing a
/// question needs the CONCLUSIONS: what is verified, what is absent, what a real
/// experiment costs. Shipping the raw record instead was the v79/v80 mistake that
/// pushed the director's own prompt past 3.4MB per gate round.
///
/// WHY THE ABSENT CASE STILL RETURNS A VALUE. A missing key reads to an agent as
/// "no such concept", and cycle-g-v82 shows what the director does when it cannot
/// verify an instrument: it retires the problem. A file that has not been written
/// yet must therefore say NOT PROBED YET, out loud, together with what to do about
/// it.
/// Does a verified instrument say this cycle builds its own inputs?
///
/// Read from the probe's own record, so it answers for any field that generates
/// data instead of fetching it. The signals describe an ACTION -- constructing,
/// generating, simulating, synthesising an input -- and are matched against the
/// instrument's name and the question the probe asked, which is the same text a
/// human reads to know what the probe established.
fn instrument_inventory_generates_inputs(paths: &AppPaths, cycle_id: &str) -> bool {
    const CONSTRUCTION_SIGNALS: &[&str] = &[
        "built in memory",
        "build in memory",
        "construct",
        "constructed",
        "generate",
        "generated",
        "generation",
        "synthes",
        "simulat",
        "procedural",
        "in-code",
    ];
    let path = state_root(paths).join(format!("{cycle_id}-instrument-inventory.json"));
    let inventory: Value = match read_json_if_below(&path, 4 * 1024 * 1024) {
        Ok(Some(value)) => value,
        _ => return false,
    };
    inventory
        .get("instruments")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter().any(|row| {
                let verified = row.get("capability_present").and_then(Value::as_bool) == Some(true)
                    && row.get("probe_ran").and_then(Value::as_bool) == Some(true);
                if !verified {
                    return false;
                }
                let haystack = format!(
                    "{} {}",
                    row.get("instrument").and_then(Value::as_str).unwrap_or(""),
                    row.get("question").and_then(Value::as_str).unwrap_or("")
                )
                .to_ascii_lowercase();
                CONSTRUCTION_SIGNALS
                    .iter()
                    .any(|needle| haystack.contains(needle))
            })
        })
        .unwrap_or(false)
}

fn instrument_inventory_digest(paths: &AppPaths, cycle_id: &str) -> Value {
    let path = state_root(paths).join(format!("{cycle_id}-instrument-inventory.json"));
    let inventory = match read_json_if_below(&path, 4 * 1024 * 1024) {
        Ok(Some(value)) => value,
        _ => {
            return json!({
                "status": "not_probed_yet",
                "meaning": "The instrument probe has not reported for this cycle. This means NOT MEASURED, not NOT POSSIBLE.",
                "required_action": "Keep the research problem. Emit one methods_followup asking a lab-runner lane to run drivers/analysis/instrument_probe.py, and state answerable_here_because provisionally, marked as pending that probe. Do NOT retire a question for want of this file: cycle-g-v82 retired 100 problems in a row on exactly that reasoning and produced zero gate rounds in 5.5 hours."
            });
        }
    };

    let str_list = |key: &str| -> Vec<String> {
        inventory
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let verified = str_list("verified_instruments");
    let unavailable = str_list("unavailable_instruments");
    let quantities = str_list("measurable_quantities");

    // The two probes a director keeps reasoning about: what an experiment costs,
    // and whether path-level telemetry exists. Both are carried verbatim because
    // both were repeatedly ASSUMED in v81 and v82 rather than looked up.
    let mut cost_anchor = Value::Null;
    let mut path_telemetry = Value::Null;
    if let Some(items) = inventory.get("instruments").and_then(Value::as_array) {
        for item in items {
            match item.get("instrument").and_then(Value::as_str) {
                Some("experiment_cost_anchor") => {
                    cost_anchor = item.get("measured").cloned().unwrap_or(Value::Null);
                }
                Some("per_path_telemetry_hooks") => {
                    path_telemetry = item
                        .get("measured")
                        .and_then(|m| m.get("verdict"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                _ => {}
            }
        }
    }

    let simulators = inventory_simulators(&inventory);

    json!({
        "status": if verified.is_empty() { "probed_but_nothing_verified" } else { "measured" },
        "probed_at": inventory.get("probed_at").cloned().unwrap_or(Value::Null),
        "renderer": inventory.get("renderer").cloned().unwrap_or(Value::Null),
        "simulators": simulators,
        "verified_instruments": verified,
        "unavailable_instruments": unavailable,
        "measurable_quantities": quantities,
        "experiment_cost_anchor": cost_anchor,
        "per_path_telemetry": path_telemetry,
        "full_record_path": path.to_string_lossy(),
        "citation_rule": "answerable_here_because must name an entry from verified_instruments or measurable_quantities. If the question needs something in unavailable_instruments, fill instrument_gap: restate the question over a verified observable, or request one probe followup to build the instrument. Never retire a problem for a missing instrument."
    })
}

/// The simulators this machine was MEASURED to run, with the interpreter that ran them.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18: Isaac Sim and MuJoCo both probed
/// clean (`by_backend.*.execution_mode == "simulation"`, `exit_code == 0`), yet every
/// analyst returned `blocked-no-matching-bundle` -- the digest carried only instrument
/// names, so nothing said that the simulator IS the data source, nor which interpreter
/// an engineer would have to run it with. The LabDirector reads this to write its
/// simulation_orders (see simulation_orders_directive).
pub(crate) fn inventory_simulators(inventory: &Value) -> Vec<Value> {
    const SUMMARY_KEYS: &[&str] = &[
        "physics_dt_s",
        "timestep_s",
        "realtime_factor",
        "steps_executed",
        "simulated_seconds",
        "wall_seconds",
    ];
    let Some(backends) = inventory.get("by_backend").and_then(Value::as_object) else {
        return Vec::new();
    };
    let instruments = inventory
        .get("instruments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut simulators = Vec::new();
    for (backend, record) in backends {
        let is_simulation =
            record.get("execution_mode").and_then(Value::as_str) == Some("simulation");
        let clean = record.get("exit_code").and_then(Value::as_i64) == Some(0);
        let interpreter = record
            .get("interpreter_path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty());
        let (true, true, Some(interpreter)) = (is_simulation, clean, interpreter) else {
            continue;
        };
        let prefix = format!("{backend}_");
        let mut verified_instruments = Vec::new();
        let mut measured = serde_json::Map::new();
        for item in &instruments {
            let Some(name) = item.get("instrument").and_then(Value::as_str) else {
                continue;
            };
            let verified = item.get("capability_present").and_then(Value::as_bool) == Some(true)
                && item.get("probe_ran").and_then(Value::as_bool) == Some(true);
            if !verified || !name.starts_with(&prefix) {
                continue;
            }
            verified_instruments.push(json!(name));
            if let Some(fields) = item.get("measured").and_then(Value::as_object) {
                for (key, value) in fields {
                    let wanted = SUMMARY_KEYS.contains(&key.as_str()) || key.ends_with("_version");
                    if wanted && !measured.contains_key(key) {
                        measured.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        if verified_instruments.is_empty() {
            continue;
        }
        simulators.push(json!({
            "backend": backend,
            "interpreter_path": interpreter,
            "verified_instruments": verified_instruments,
            "measured": Value::Object(measured),
        }));
    }
    simulators
}

#[cfg(test)]
mod simulator_digest_tests {
    use super::*;

    #[test]
    fn a_measured_simulator_reaches_the_digest_with_its_interpreter() {
        let inventory = json!({
            "by_backend": {
                "mujoco": {"execution_mode": "simulation", "interpreter_path": "C:\\py\\python.exe", "exit_code": 0},
                "superdex": {"execution_mode": "simulation", "interpreter_path": "D:\\sd\\python.exe", "exit_code": 1},
                "python": {"exit_code": 0}
            },
            "instruments": [
                {"instrument": "mujoco_rigid_body_simulation", "probe_ran": true, "capability_present": true,
                 "measured": {"mujoco_version": "3.10.0", "timestep_s": 0.002, "realtime_factor": 132.9, "start_height_m": 0.5}},
                {"instrument": "mujoco_contact_response", "probe_ran": true, "capability_present": true, "measured": {}},
                {"instrument": "superdex_grasp", "probe_ran": true, "capability_present": false}
            ]
        });
        let simulators = inventory_simulators(&inventory);
        assert_eq!(simulators.len(), 1, "{simulators:?}");
        let entry = &simulators[0];
        assert_eq!(entry["backend"], "mujoco");
        assert_eq!(entry["interpreter_path"], "C:\\py\\python.exe");
        assert_eq!(entry["verified_instruments"].as_array().unwrap().len(), 2);
        assert_eq!(entry["measured"]["mujoco_version"], "3.10.0");
        assert_eq!(entry["measured"]["timestep_s"], 0.002);
        assert!(entry["measured"].get("start_height_m").is_none());
    }
}

/// The director's clue register, as the next director lane is handed it.
///
/// The register is kept by src/reporting/research_clues.js from the
/// `research_clue_updates` in the director's own decisions, and the file carries
/// the view it wants shown (live clues first, the most important first, compact).
/// Delivered on every director lane, empty included: an empty register is the
/// prompt to start one.
fn research_clues_payload(paths: &AppPaths, cycle_id: &str) -> Value {
    let path = state_root(paths).join(format!("{cycle_id}-research-clues.json"));
    let register = read_json_if_below(&path, 2 * 1024 * 1024).ok().flatten();
    let view = register
        .as_ref()
        .and_then(|value| value.get("director_view"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let clues = register
        .as_ref()
        .and_then(|value| value.get("clues"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let live_clues: Vec<&Value> = clues
        .iter()
        .filter(|clue| matches!(clue.get("status").and_then(Value::as_str), Some("open") | Some("in_use")))
        .collect();
    let live = live_clues.len();
    let high = live_clues
        .iter()
        .filter(|clue| clue.get("importance").and_then(Value::as_str) == Some("high"))
        .count();
    // MEASURED ON cycle-a-20260919, 2026-10-29: 30 of the 32 clues the
    // director had recorded were marked high, and asked to re-rank it did not. The
    // owner set a budget (src/reporting/research_clues.js keeps it): at most
    // `high_cap` live clues are high. What the harness did about a request that
    // would break it (recorded as medium, refused, or demoted) is in `feedback`,
    // so the director learns its update was not applied as written.
    let high_cap = register
        .as_ref()
        .and_then(|value| value.get("max_high_live"))
        .and_then(Value::as_u64)
        .unwrap_or(6);
    let feedback = register
        .as_ref()
        .and_then(|value| value.get("feedback"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "register": view,
        "clues_total": clues.len(),
        "clues_live": live,
        "clues_live_high": high,
        "high_cap": high_cap,
        "feedback": feedback,
        "recorded_in": format!(".research-lab/state/{cycle_id}-research-clues.json"),
        "how_to_use": "Your clue register, kept whatever happens to the lead. Read it before you choose, refine, replace or conclude. Record what this round taught that the next lead should not have to find out again in `research_clue_updates` (add a clue, or update one by `clue_id`); resolving or retiring a clue needs a note saying why. At most `high_cap` live clues can be `high`: a new one that does not fit is recorded as medium, and making another high is refused until you lower one -- `feedback` lists what was not applied as you wrote it, and why. See research_clues_duty.",
    })
}

/// The ledger's standing lead-protection decision, if one is active.
///
/// Written by src/reporting/reviews/gate/build.js on every gate build.
///
/// THE SIGNAL IS THE DIRECTIVE, NOT THE VERDICT. The first version of this
/// function delivered only on `decision == "deny"`, reasoning that an `allow` is
/// the ordinary state and repeating it would teach agents to skip the field. That
/// was wrong, and cycle-g-v84 was sitting in the exact case it dropped:
///
///   decision: "allow"
///   reason:   "best_lead_dormant_resume_before_replacing"
///   lead:     hyp:8adfd938   (novelty 38 / technical_quality 35, the cycle best)
///   directive: "THE STRONGEST LEAD THIS CYCLE HAS PRODUCED WAS ABANDONED, NOT
///               DISPROVED ..."
///
/// An `allow` that carries a directive is not permission to do anything, it is
/// permission WITH an instruction - here, resume the abandoned best lead before
/// replacing it, which is precisely what v84 needed to hear. leadProtectionPrefix
/// already returns an empty string for the ordinary quiet allow, so a non-empty
/// directive is itself the "there is something to say" signal. Filtering on the
/// verdict instead threw away the case that mattered.
fn lead_protection_payload(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    let path = state_root(paths).join(format!("{cycle_id}-lead-protection.json"));
    let value = read_json_if_below(&path, 256 * 1024).ok()??;
    let directive = value
        .get("directive")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if directive.is_empty() {
        return None;
    }
    Some(json!({
        "status": "active",
        "reason": value.get("reason").cloned().unwrap_or(Value::Null),
        "protected_lead": value.get("lead").cloned().unwrap_or(Value::Null),
        "directive": directive,
        "decision": value.get("decision").cloned().unwrap_or(Value::Null),
        "rule": "The progress ledger has something to say about which lead this cycle should be working on, and it is in `directive` above. A `deny` means superseding the named lead is refused: keep refining it, and do not promote, score, or hand off a different one. An `allow` that still carries a directive is permission WITH an instruction - most often that the cycle's strongest lead was abandoned rather than disproved and should be resumed before any replacement. Either way, if you believe the named lead is genuinely exhausted, say so with the evidence rather than routing around it."
    }))
}

/// The gate's binding (lowest applicable, reviewed) rubric and the objections a
/// supplementary experiment could answer, while the gate is not passed.
pub(crate) fn rebuttal_targets(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    let gate = read_json_if_below(
        &state_root(paths).join(format!("{cycle_id}-gate-review.json")),
        4 * 1024 * 1024,
    )
    .ok()??;
    if gate.get("gate_passed").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let mut binding: Option<(String, f64)> = None;
    for item in gate.get("rubric").and_then(Value::as_array).into_iter().flatten() {
        if item.get("applicable").and_then(Value::as_bool) == Some(false)
            || item.get("focused_review_missing").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let (Some(name), Some(score)) = (
            item.get("name").and_then(Value::as_str),
            item.get("score").and_then(Value::as_f64),
        ) else {
            continue;
        };
        if score <= 0.0 {
            continue;
        }
        if binding.as_ref().is_none_or(|(_, lowest)| score < *lowest) {
            binding = Some((name.to_string(), score));
        }
    }
    let clip = |text: &str| text.chars().take(600).collect::<String>();
    let mut objections: Vec<String> = Vec::new();
    for key in ["major_objections", "gate_scientific_blockers"] {
        for item in gate.get(key).and_then(Value::as_array).into_iter().flatten() {
            let Some(text) = item.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
                continue;
            };
            // "Bounded by the gatekeeper's critical ... score" restates a number,
            // not an objection an experiment could answer.
            if text.starts_with("Bounded by") || objections.iter().any(|seen| seen == text) {
                continue;
            }
            objections.push(clip(text));
            if objections.len() >= 6 {
                break;
            }
        }
    }
    if binding.is_none() && objections.is_empty() {
        return None;
    }
    Some(json!({
        "binding_rubric": binding.as_ref().map(|(name, _)| name.clone()),
        "binding_score": binding.as_ref().map(|(_, score)| *score),
        "objections": objections,
        "rule": "REBUTTAL BEFORE REPLACEMENT: when you uphold, answer the binding rubric's objection with at least one rebuttal_experiments entry -- the run that would settle it and the number it must show. It is dispatched like next_actions. When you replace instead, say in rationale why no experiment could answer these objections.",
    }))
}

/// Pilot results of the runner-up candidates the director ordered with
/// `pilot_only`, read from their manifests, newest first.
pub(crate) fn alternate_pilots(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    let root = paths.runtime_root.join("datasets").join(cycle_id).join("simulations");
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut found: Vec<(u128, Value)> = Vec::new();
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("manifest.json");
        let Ok(Some(manifest)) = read_json_if_below(&manifest_path, 1024 * 1024) else {
            continue;
        };
        if manifest.get("pilot_only").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let modified = fs::metadata(&manifest_path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);
        let pilot = manifest.get("pilot").cloned().unwrap_or(Value::Null);
        found.push((
            modified,
            json!({
                "request_id": manifest.get("request_id").cloned().unwrap_or_else(|| json!(entry.file_name().to_string_lossy())),
                "for_candidate": manifest.get("for_candidate").cloned().unwrap_or(Value::Null),
                "rows": manifest.get("rows").or_else(|| manifest.get("row_count")).cloned().unwrap_or(Value::Null),
                "passed": pilot.get("passed").cloned().unwrap_or(Value::Null),
                "note": pilot.get("note").cloned().unwrap_or(Value::Null),
                "criteria_results": pilot.get("criteria_results").cloned().unwrap_or_else(|| json!([])),
                "manifest_path": manifest_path.display().to_string(),
            }),
        ));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, value)| value).take(4).collect()
}

#[cfg(test)]
mod rebuttal_and_alternate_pilot_tests {
    use super::*;
    use tempfile::TempDir;

    fn paths_for(root: &Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join(".research-lab").join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        }
    }

    #[test]
    fn rebuttal_targets_name_the_binding_rubric_and_the_answerable_objections() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let gate_path = state_root(&paths).join("c-gate-review.json");
        fs::create_dir_all(gate_path.parent().unwrap()).unwrap();
        // The live shape on 2026-10-06.
        write_json(&gate_path, &json!({
            "gate_passed": false,
            "rubric": [
                {"name": "novelty", "score": 36, "applicable": true},
                {"name": "technical_quality", "score": 38, "applicable": true},
                {"name": "reproducibility", "score": 76, "applicable": true},
                {"name": "impact", "score": 0, "applicable": true, "focused_review_missing": true}
            ],
            "major_objections": ["the premise is adjacent to ALT and MimicGen", "the premise is adjacent to ALT and MimicGen"],
            "gate_scientific_blockers": ["Bounded by the gatekeeper's critical novelty score (36)", "no held-out seed confirms the slope"]
        })).unwrap();
        let targets = rebuttal_targets(&paths, "c").expect("a failed gate has targets");
        assert_eq!(targets["binding_rubric"], json!("novelty"));
        assert_eq!(targets["binding_score"], json!(36.0));
        assert_eq!(targets["objections"], json!(["the premise is adjacent to ALT and MimicGen", "no held-out seed confirms the slope"]));

        write_json(&gate_path, &json!({"gate_passed": true, "rubric": []})).unwrap();
        assert!(rebuttal_targets(&paths, "c").is_none(), "a passed gate needs no rebuttal");
    }

    #[test]
    fn the_clue_register_reaches_the_director_even_when_it_is_empty() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        // Nothing recorded yet: the register is still delivered, as the prompt to start one.
        let empty = research_clues_payload(&paths, "c");
        assert_eq!(empty["clues_total"], json!(0));
        assert_eq!(empty["register"], json!([]));
        assert!(empty["how_to_use"].as_str().unwrap().contains("research_clue_updates"));

        let path = state_root(&paths).join("c-research-clues.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_json(&path, &json!({
            "clues": [
                {"clue_id": "c-1", "status": "open", "importance": "high"},
                {"clue_id": "c-2", "status": "in_use", "importance": "medium"},
                {"clue_id": "c-3", "status": "retired", "importance": "low"}
            ],
            "director_view": [{"clue_id": "c-1", "statement": "x"}, {"clue_id": "c-2", "statement": "y"}]
        })).unwrap();
        let filled = research_clues_payload(&paths, "c");
        assert_eq!(filled["clues_total"], json!(3));
        assert_eq!(filled["clues_live"], json!(2), "retired clues are not live");
        assert_eq!(filled["register"].as_array().unwrap().len(), 2);
        assert_eq!(filled["recorded_in"], json!(".research-lab/state/c-research-clues.json"));
        assert_eq!(filled["clues_live_high"], json!(1));
        assert_eq!(filled["high_cap"], json!(6), "the budget is stated even before the register has said it");
        assert_eq!(filled["feedback"], json!([]));
    }

    #[test]
    fn the_director_is_told_what_was_not_applied_as_it_wrote_it() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let path = state_root(&paths).join("c-research-clues.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let clue = |id: &str, status: &str, importance: &str| json!({"clue_id": id, "status": status, "importance": importance});
        write_json(&path, &json!({
            "clues": [clue("a", "open", "high"), clue("b", "in_use", "high"), clue("c", "retired", "high")],
            "director_view": [],
            "max_high_live": 6,
            "feedback": [
                {"kind": "refused", "clue_id": "x", "lane_id": "followup-lab-director-9", "text": "Clue x could not be made high: 6 live clues already are (a; b). Update one of those to medium or low first."},
                {"kind": "demoted", "clue_id": "y", "lane_id": "harness", "text": "Clue y was set to medium: at most 6 live clues can be high."}
            ]
        })).unwrap();
        let payload = research_clues_payload(&paths, "c");
        assert_eq!(payload["clues_live"], json!(2));
        assert_eq!(payload["clues_live_high"], json!(2), "a retired clue holds no slot");
        assert_eq!(payload["feedback"].as_array().unwrap().len(), 2);
        assert!(payload["feedback"][0]["text"].as_str().unwrap().contains("could not be made high"));
        assert!(payload["how_to_use"].as_str().unwrap().contains("high_cap"));
    }

    #[test]
    fn alternate_pilots_are_read_from_pilot_only_manifests() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let sims = paths.runtime_root.join("datasets").join("c").join("simulations");
        write_json(&sims.join("alt_a").join("manifest.json"), &json!({
            "request_id": "alt_a", "pilot_only": true, "for_candidate": "runner-up A", "rows": 40,
            "pilot": {"passed": false, "note": "floor 0.1 < 0.3", "criteria_results": [{"name": "floor", "passed": false}]}
        })).unwrap();
        write_json(&sims.join("lead").join("manifest.json"), &json!({
            "request_id": "lead", "rows": 4000, "pilot": {"passed": true}
        })).unwrap();
        let alternates = alternate_pilots(&paths, "c");
        assert_eq!(alternates.len(), 1, "{alternates:?}");
        assert_eq!(alternates[0]["request_id"], json!("alt_a"));
        assert_eq!(alternates[0]["for_candidate"], json!("runner-up A"));
        assert_eq!(alternates[0]["passed"], json!(false));
        assert_eq!(alternates[0]["note"], json!("floor 0.1 < 0.3"));
    }
}
