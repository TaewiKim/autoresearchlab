#![allow(unused_imports)]
use super::*;

pub fn rewrite_task_graph(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let mut priority_actions = Vec::new();
    let mut hypothesis_index: HashMap<String, Value> = HashMap::new();

    collect_brief_priority_inputs(
        paths,
        cycle_id,
        &mut priority_actions,
        &mut hypothesis_index,
    )?;

    collect_literature_summary_hypotheses(paths, cycle_id, &mut hypothesis_index)?;
    collect_labdirector_dialogue_actions(paths, cycle_id, &mut priority_actions)?;

    collect_conclusion_review_actions(paths, cycle_id, &mut priority_actions)?;
    push_runner_post_run_gate_actions(paths, cycle_id, &mut priority_actions)?;

    collect_labdirector_requery_actions(
        paths,
        cycle_id,
        &mut priority_actions,
        &mut hypothesis_index,
    )?;

    let (gate_objection_texts, gate_alternative_hypotheses) =
        collect_gate_review_actions(paths, cycle_id, &mut priority_actions)?;

    for (review_name, path_name, bonus) in [
        (
            "report-review",
            format!("{cycle_id}-report-review.json"),
            18i64,
        ),
        (
            "paper-review",
            format!("{cycle_id}-paper-review.json"),
            16i64,
        ),
    ] {
        let review_path = state_root(paths).join(path_name);
        if !review_path.exists() {
            continue;
        }
        let review = read_json(&review_path)?;
        for action in review
            .get("recommended_followup_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("document-quality follow-up action");
            // "critical" fell through to the bottom branch and scored 56, below
            // every lab-director action in the queue, so a gate-required
            // manuscript fix waited behind 370 of them and never ran. A blocker
            // the document gate will not pass without outranks another round of
            // the review that raised it.
            let gate_required = action
                .get("required_for_gate")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let priority_score = if gate_required {
                9_900
            } else {
                match action
                    .get("priority")
                    .and_then(Value::as_str)
                    .unwrap_or("medium")
                {
                    "critical" => 9_900,
                    "high" => 100 + bonus,
                    "medium" => 70 + bonus,
                    _ => 40 + bonus,
                }
            };
            priority_actions.push(json!({
                "brief_id": review_name,
                "description": description,
                "type": action.get("type").cloned().unwrap_or_else(|| json!("document_followup")),
                "priority_score": priority_score,
                "preferred_role": action.get("preferred_role").cloned().unwrap_or_else(|| json!("author")),
                "target_rubric": action.get("target_rubric").cloned().unwrap_or(Value::Null),
                "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                "target_document": action.get("target_document").cloned().unwrap_or(Value::Null),
                // The dispatcher reads this to decide whether a standing
                // document blocker may be retried; without it the exception
                // it gates can never fire.
                "required_for_gate": action.get("required_for_gate").cloned().unwrap_or(json!(false)),
                "review_action": action.clone(),
                "analysis_request": action.get("analysis_request").cloned().unwrap_or(Value::Null),
                "reference_request": action.get("reference_request").cloned().unwrap_or(Value::Null),
                "figure_production_request": action.get("figure_production_request").cloned().unwrap_or(Value::Null),
            }));
        }
    }

    let mut analyst_result_candidates = Vec::new();
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.starts_with("analyst-") && !lane_id.starts_with("followup-analyst-") {
            continue;
        }
        let result_path = lane_dir.join("result.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !result_path.exists() || !final_status_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let result_size = fs::metadata(&result_path)?.len();
        if result_size > 1 * 1024 * 1024 {
            continue;
        }
        let modified_at = fs::metadata(&result_path)
            .and_then(|meta| meta.modified())
            .ok();
        analyst_result_candidates.push((modified_at, lane_id, result_path));
    }
    analyst_result_candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, lane_id, result_path) in analyst_result_candidates.into_iter().take(20) {
        let result = read_json(&result_path)?;
        for action in result
            .get("recommended_followup_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("analyst-requested analysis follow-up");
            let priority_score = match action
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or("medium")
            {
                "high" => 104,
                "medium" => 72,
                _ => 42,
            };
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": description,
                "type": action.get("type").cloned().unwrap_or_else(|| json!("confound_or_sensitivity_check")),
                "priority_score": priority_score,
                "preferred_role": action.get("preferred_role").cloned().unwrap_or_else(|| json!("lab-runner")),
                "target_rubric": Value::Null,
                "target_score": Value::Null,
                "current_score": Value::Null,
                "blocker_reasons": json!(["analyst-identified data-graph validation gap"]),
                "candidate_hypotheses": json!([]),
                "schema_quality": Value::Null,
                "reasoning_graph": Value::Null,
                "data_graph": Value::Null,
                "open_validation_gaps": json!([]),
                "challenge_questions": json!([]),
            }));
        }
    }

    if let Some(handoff_signal) = latest_analyst_handoff_signal(paths, cycle_id)? {
        let handoff_path = handoff_signal
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("latest analyst handoff")
            .to_string();
        let handoff_payload = handoff_signal
            .get("payload")
            .cloned()
            .unwrap_or(Value::Null);
        if analyst_handoff_is_executable(&handoff_payload) {
            push_analyst_handoff_followup_action(
                paths,
                cycle_id,
                &mut priority_actions,
                "analyst-handoff",
                "latest-executable-analyst-handoff",
                handoff_path,
                handoff_payload,
                285,
                "latest executable analyst handoff has not been converted into a lab-runner validation pass",
            )?;
        } else if let Some(revision) =
            crate::runtime::handoff_seal::seal_rejection_revision_action(&handoff_path, &handoff_payload)
        {
            // A handoff the harness could not seal goes back to the analyst with
            // the reason. `analyst-handoff-revision` was already honoured
            // downstream -- it holds runners back while it is pending -- but
            // nothing produced it, so a refused handoff simply sat unexecuted.
            priority_actions.push(revision);
        }
    }

    let analyst_handoff_action_present = priority_actions.iter().any(|action| {
        action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff")
            || action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff-artifact")
            || action.get("brief_id").and_then(Value::as_str) == Some("analyst-handoff-revision")
    });
    if !analyst_handoff_action_present {
        let artifacts_dir = paths
            .runtime_root
            .join("artifacts")
            .join("stats")
            .join(cycle_id);
        let mut handoff_candidates: Vec<(Option<std::time::SystemTime>, String, Value)> =
            Vec::new();
        if artifacts_dir.exists() {
            for entry in read_dir(&artifacts_dir)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let lane_id = entry.file_name().to_string_lossy().to_string();
                if !lane_id.contains("analyst") {
                    continue;
                }
                let handoff_path = entry.path().join("handoff-validation-plan.json");
                if !handoff_path.exists() {
                    continue;
                }
                let payload = read_json(&handoff_path)?;
                if !analyst_handoff_is_executable(&payload) {
                    continue;
                }
                let modified_at = fs::metadata(&handoff_path)
                    .and_then(|meta| meta.modified())
                    .ok();
                handoff_candidates.push((modified_at, handoff_path.display().to_string(), payload));
            }
        }
        handoff_candidates.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some((_, handoff_path, handoff_payload)) = handoff_candidates.pop() {
            push_analyst_handoff_followup_action(
                paths,
                cycle_id,
                &mut priority_actions,
                "analyst-handoff-artifact",
                "latest-executable-analyst-handoff-artifact",
                handoff_path,
                handoff_payload,
                284,
                "executable analyst handoff artifact has not been converted into a lab-runner validation pass",
            )?;
        }
    }

    let mut ledger_schema_quality = Value::Null;
    let mut ledger_reasoning_graph = Value::Null;
    let mut ledger_data_graph = Value::Null;
    let mut ledger_open_validation_gaps: Vec<Value> = Vec::new();
    let mut ledger_derived_candidates: Vec<Value> = Vec::new();
    let ledger_path = hypothesis_ledger_path(paths, cycle_id);
    let mut priority_hypotheses = if ledger_path.exists()
        && fs::metadata(&ledger_path)
            .map(|metadata| metadata.len() <= 5 * 1024 * 1024)
            .unwrap_or(false)
    {
        let ledger = read_json(&ledger_path)?;
        ledger_schema_quality = ledger.get("schema_quality").cloned().unwrap_or(Value::Null);
        ledger_reasoning_graph = ledger
            .get("knowledge_graph")
            .and_then(|item| item.get("reasoning_graph"))
            .cloned()
            .unwrap_or(Value::Null);
        ledger_data_graph = ledger
            .get("knowledge_graph")
            .and_then(|item| item.get("data_graph"))
            .cloned()
            .unwrap_or(Value::Null);
        ledger_derived_candidates = ledger
            .get("derivable_hypothesis_candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        ledger_open_validation_gaps = ledger
            .get("hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item.get("unresolved_gaps")
                    .and_then(Value::as_array)
                    .map(|items| !items.is_empty())
                    .unwrap_or(false)
            })
            .take(10)
            .collect::<Vec<_>>();
        let mut hypotheses = ledger
            .get("focus_hypotheses")
            .or_else(|| ledger.get("hypotheses"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item.get("state").and_then(Value::as_str) != Some("retired")
                    && item.get("statement").and_then(Value::as_str).is_some()
            })
            .map(|mut item| {
                let impact_score = hypothesis_impact_score(&item);
                let data_verifiability_score = hypothesis_data_verifiability_score(&item);
                let reasoning_graph_score = hypothesis_reasoning_graph_score(&item);
                let selection_score = hypothesis_selection_score(&item);
                item["impact_score"] = json!(impact_score);
                item["data_verifiability_score"] = json!(data_verifiability_score);
                item["reasoning_graph_score"] = json!(reasoning_graph_score);
                item["selection_score"] = json!(selection_score);
                item["source"] = json!("hypothesis-ledger");
                item
            })
            .collect::<Vec<_>>();
        for mut item in ledger_derived_candidates.iter().cloned() {
            let statement = item.get("statement").and_then(Value::as_str).unwrap_or("");
            if statement.is_empty() {
                continue;
            }
            let impact_score = hypothesis_impact_score(&item);
            let data_verifiability_score = hypothesis_data_verifiability_score(&item);
            let reasoning_graph_score = hypothesis_reasoning_graph_score(&item);
            let selection_score = hypothesis_selection_score(&item);
            item["hypothesis_id"] = item
                .get("candidate_id")
                .cloned()
                .unwrap_or_else(|| json!(format!("derived-{}", slugify(statement))));
            item["support_count"] = json!(0);
            item["impact_score"] = json!(impact_score);
            item["data_verifiability_score"] = json!(data_verifiability_score);
            item["reasoning_graph_score"] = json!(reasoning_graph_score);
            item["selection_score"] = json!(selection_score);
            item["scientific_score_status"] = json!(if impact_score == 0 {
                "independent_impact_and_novelty_assessment_required"
            } else {
                "independently_assessed"
            });
            item["source"] = json!("derivable-hypothesis-candidate");
            item["state"] = json!("derived-candidate");
            hypotheses.push(item);
        }
        hypotheses
    } else {
        hypothesis_index
            .into_values()
            .map(|mut item| {
                let impact_score = hypothesis_impact_score(&item);
                let data_verifiability_score = hypothesis_data_verifiability_score(&item);
                let reasoning_graph_score = hypothesis_reasoning_graph_score(&item);
                let selection_score = hypothesis_selection_score(&item);
                item["impact_score"] = json!(impact_score);
                item["data_verifiability_score"] = json!(data_verifiability_score);
                item["reasoning_graph_score"] = json!(reasoning_graph_score);
                item["selection_score"] = json!(selection_score);
                item["scientific_score_status"] =
                    json!("independent_impact_and_novelty_assessment_required");
                item["source"] = json!("brief-derived");
                item
            })
            .collect::<Vec<_>>()
    };

    let lab_director_hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    if lab_director_hypothesis_is_usable(paths, cycle_id, &lab_director_hypothesis_path) {
        let lab_director_hypothesis = read_json(&lab_director_hypothesis_path)?;
        let selected = lab_director_hypothesis
            .get("selected_hypothesis")
            .cloned()
            .filter(|item| item.is_object())
            .unwrap_or(Value::Null);
        let statement = selected
            .get("statement")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if !statement.is_empty() {
            let statement_norm = normalized_text(&statement);
            let family_root = selected
                .get("family_root")
                .or_else(|| selected.get("family"))
                .or_else(|| selected.get("primary_family"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| infer_family_root(&statement));
            if let Some(existing) = priority_hypotheses.iter_mut().find(|item| {
                item.get("statement")
                    .and_then(Value::as_str)
                    .map(|existing| normalized_text(existing) == statement_norm)
                    .unwrap_or(false)
            }) {
                if existing
                    .get("family_root")
                    .and_then(Value::as_str)
                    .map(|value| value.is_empty() || value == "unclassified_family")
                    .unwrap_or(true)
                {
                    existing["family_root"] = json!(family_root);
                }
                existing["source"] = json!("lab-director-hypothesis");
                existing["state"] = json!("lab-director-selected");
                existing["support_count"] = existing
                    .get("support_count")
                    .cloned()
                    .unwrap_or_else(|| json!(1));
                existing["priority_score"] = existing
                    .get("priority_score")
                    .cloned()
                    .unwrap_or_else(|| json!(118));
                existing["selection_score"] = existing
                    .get("selection_score")
                    .cloned()
                    .unwrap_or_else(|| json!(hypothesis_selection_score(existing)));
            } else {
                let mut item = selected.clone();
                item["hypothesis_id"] = item
                    .get("hypothesis_id")
                    .cloned()
                    .unwrap_or_else(|| json!(format!("lab-director-{}", slugify(&statement))));
                item["statement"] = json!(statement.clone());
                item["family_root"] = json!(family_root);
                item["source"] = json!("lab-director-hypothesis");
                item["state"] = json!("lab-director-selected");
                item["support_count"] = item
                    .get("support_count")
                    .cloned()
                    .unwrap_or_else(|| json!(1));
                item["impact_score"] = item
                    .get("impact_score")
                    .cloned()
                    .unwrap_or_else(|| json!(hypothesis_impact_score(&item)));
                item["data_verifiability_score"] = item
                    .get("data_verifiability_score")
                    .cloned()
                    .unwrap_or_else(|| json!(hypothesis_data_verifiability_score(&item)));
                item["reasoning_graph_score"] = item
                    .get("reasoning_graph_score")
                    .cloned()
                    .unwrap_or_else(|| json!(hypothesis_reasoning_graph_score(&item)));
                item["selection_score"] = item
                    .get("selection_score")
                    .cloned()
                    .unwrap_or_else(|| json!(hypothesis_selection_score(&item)));
                item["scientific_score_status"] = item
                    .get("scientific_score_status")
                    .cloned()
                    .unwrap_or_else(|| json!("independent_impact_and_novelty_assessment_required"));
                item["priority_score"] = item
                    .get("priority_score")
                    .cloned()
                    .unwrap_or_else(|| json!(118));
                priority_hypotheses.push(item);
            }
        }
    }

    for alternative in gate_alternative_hypotheses.iter() {
        if alternative.trim().is_empty() {
            continue;
        }
        let alt_norm = normalized_text(alternative);
        let already_present = priority_hypotheses.iter().any(|item| {
            item.get("statement")
                .and_then(Value::as_str)
                .map(|statement| normalized_text(statement) == alt_norm)
                .unwrap_or(false)
        });
        if already_present {
            continue;
        }
        let mut alternative = json!({
            "hypothesis_id": format!("gate-alt-{}", slugify(alternative)),
            "statement": alternative,
            "support_count": 0,
            "priority_score": 90,
            "source": "gate-review-alternative",
            "state": "gate-review-candidate",
            "family_root": infer_family_root(alternative),
            "source_brief_ids": ["gate-review"],
            "scientific_score_status": "independent_impact_and_novelty_assessment_required",
        });
        alternative["impact_score"] = json!(hypothesis_impact_score(&alternative));
        alternative["data_verifiability_score"] =
            json!(hypothesis_data_verifiability_score(&alternative));
        alternative["reasoning_graph_score"] =
            json!(hypothesis_reasoning_graph_score(&alternative));
        alternative["selection_score"] = json!(hypothesis_selection_score(&alternative));
        priority_hypotheses.push(alternative);
    }

    let mut family_counts: HashMap<String, i64> = HashMap::new();
    for item in priority_hypotheses.iter_mut() {
        let statement = item.get("statement").and_then(Value::as_str).unwrap_or("");
        if statement.is_empty() {
            continue;
        }
        let family_root = item
            .get("family_root")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                item.get("family")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| infer_family_root(statement));
        item["family_root"] = json!(family_root.clone());
        *family_counts.entry(family_root).or_insert(0) += 1;
    }
    let rival_family_count = family_counts
        .keys()
        .filter(|item| item.as_str() != "unclassified_family")
        .count() as i64;

    for item in priority_hypotheses.iter_mut() {
        let statement = item
            .get("statement")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if statement.is_empty() {
            continue;
        }
        let family_root = item
            .get("family_root")
            .and_then(Value::as_str)
            .unwrap_or("unclassified_family")
            .to_string();
        let gate_penalty = statement_penalty(&statement, &gate_objection_texts);
        let family_penalty = family_penalty_for_root(&family_root, &gate_objection_texts);
        let root_penalty = root_variable_convergence_penalty(
            &statement,
            &gate_objection_texts,
            &gate_alternative_hypotheses,
        );
        let gate_bonus = alternative_bonus(&statement, &gate_alternative_hypotheses);
        let saturation_penalty = family_counts
            .get(&family_root)
            .copied()
            .unwrap_or(0)
            .saturating_sub(1)
            .min(4)
            * 4;
        let incumbent_penalty = if item.get("source").and_then(Value::as_str)
            == Some("hypothesis-ledger")
            && item.get("state").and_then(Value::as_str) == Some("promoted-to-claim")
        {
            14
        } else {
            0
        };
        let selection_score = item
            .get("selection_score")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let priority_score = item
            .get("priority_score")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let total_penalty =
            gate_penalty + family_penalty + root_penalty + saturation_penalty + incumbent_penalty;
        item["gate_reviewer_penalty"] = json!(gate_penalty);
        item["gate_reviewer_bonus"] = json!(gate_bonus);
        item["family_penalty"] = json!(family_penalty);
        item["root_variable_penalty"] = json!(root_penalty);
        item["family_saturation_penalty"] = json!(saturation_penalty);
        item["incumbent_inertia_penalty"] = json!(incumbent_penalty);
        let mut adjusted_selection = (selection_score - total_penalty + gate_bonus).clamp(0, 100);
        let adjusted_priority = (priority_score - total_penalty + gate_bonus).clamp(0, 140);
        // Cap the selection score of any classified incumbent family when
        // there are not yet three rival families in the frontier, so the
        // planner is nudged toward rival exploration regardless of domain.
        // (Previously hardcoded to `immunization_coverage` only.)
        if rival_family_count < 3 && !family_root.is_empty() && family_root != "unclassified_family"
        {
            adjusted_selection = adjusted_selection.min(70);
            item["rival_underexploration_cap"] = json!(70);
        }
        item["selection_score"] = json!(adjusted_selection);
        item["priority_score"] = json!(adjusted_priority);
        if total_penalty >= 24 {
            item["state"] = json!("gate-rejected-candidate");
        }
    }

    // Phase 1 data fetcher (docs/data-fetcher-2026-04-28.md §E):
    // structural fallback for the case where chronicle names open
    // datasets in the hypothesis but does not emit a matching
    // ``data_acquisition_followup`` recommended_action. Without this
    // injection the fetcher path never fires for medical / engineering
    // prompts where chronicle treats the named cohorts as "verify
    // variable coverage" targets rather than "fetch these files"
    // jobs — which is exactly what stranded v23-fetch-fix-verify and
    // v22 at promotion=0 with data_evidence=0.
    inject_data_acquisition_fallback_action(paths, cycle_id, &mut priority_actions);

    priority_actions.sort_by(|a, b| {
        b["priority_score"]
            .as_i64()
            .cmp(&a["priority_score"].as_i64())
    });
    priority_hypotheses.sort_by(|a, b| {
        b["selection_score"]
            .as_i64()
            .cmp(&a["selection_score"].as_i64())
            .then_with(|| {
                b["support_count"]
                    .as_u64()
                    .cmp(&a["support_count"].as_u64())
            })
            .then_with(|| {
                b["priority_score"]
                    .as_i64()
                    .cmp(&a["priority_score"].as_i64())
            })
    });
    let convergence_mode = planner_convergence_mode(paths, cycle_id);
    let selected_count = match convergence_mode.as_str() {
        "explore" => 4usize,
        "focus" => 3usize,
        _ => 1usize,
    };
    let reserve_count = match convergence_mode.as_str() {
        "explore" => 12usize,
        "focus" => 10usize,
        _ => 8usize,
    };
    let selectable_hypotheses = if priority_hypotheses
        .iter()
        .any(|item| item.get("state").and_then(Value::as_str) != Some("gate-rejected-candidate"))
    {
        priority_hypotheses
            .iter()
            .filter(|item| {
                item.get("state").and_then(Value::as_str) != Some("gate-rejected-candidate")
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        priority_hypotheses.clone()
    };
    let nonfallback_selectable_hypotheses = selectable_hypotheses
        .iter()
        .filter(|item| is_nonfallback_hypothesis_candidate(item))
        .cloned()
        .collect::<Vec<_>>();
    let selected_hypotheses = selectable_hypotheses
        .iter()
        .filter(|item| is_nonfallback_hypothesis_candidate(item))
        .take(selected_count)
        .cloned()
        .collect::<Vec<_>>();
    let selected_hypotheses = if selected_hypotheses.is_empty() {
        nonfallback_selectable_hypotheses
            .iter()
            .take(selected_count)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        selected_hypotheses
    };
    let fallback_candidate_count = selectable_hypotheses
        .len()
        .saturating_sub(nonfallback_selectable_hypotheses.len());
    let objective = cycle_objective(paths, cycle_id);
    let stage_gate_state =
        enforce_stage_gate_recovery_actions(paths, cycle_id, &mut priority_actions, &objective)?;
    enforce_zero_nonfallback_hypothesis_recovery_actions(
        &mut priority_actions,
        &selected_hypotheses,
        &objective,
    );
    // Literature lanes that stop at pending_review/no_admitted_evidence are
    // intentionally finalized as failed. Chronicle only builds briefs for
    // completed lanes, so their recovery recommendation cannot arrive through
    // collect_brief_priority_inputs. Re-inject it after both recovery filters:
    // each filter retains a narrow action allowlist and would otherwise discard
    // these two literature-specific action types.
    collect_failed_literature_recovery_actions(paths, cycle_id, &mut priority_actions)?;
    // Same position and the same reason: a LabDirector simulation order is not a
    // Chronicle brief, and the recovery filters above would discard its action type.
    collect_simulation_generation_actions(paths, cycle_id, &mut priority_actions)?;
    // Same position and the same reason: an audit of how a result was produced is
    // not a Chronicle brief either.
    collect_runner_execution_audit_actions(paths, cycle_id, &mut priority_actions)?;
    // Same position and the same reason: the analysts' proposals are not a
    // Chronicle brief, and they are the only way out of a plan whose every other
    // action is a duplicate.
    collect_analysis_proposal_decision_actions(paths, cycle_id, &mut priority_actions)?;
    let reserve_hypotheses = priority_hypotheses
        .iter()
        .filter(|item| {
            !selected_hypotheses
                .iter()
                .any(|selected| selected.get("statement") == item.get("statement"))
        })
        .take(reserve_count)
        .cloned()
        .collect::<Vec<_>>();

    let plan = json!({
        "cycle_id": cycle_id,
        "generated_at": now_iso(),
        "priority_actions": priority_actions,
        "selected_hypotheses": selected_hypotheses,
        "priority_hypotheses": reserve_hypotheses,
        "frontier_catalog": {
            "primary_variable_families": build_frontier_catalog(&priority_hypotheses),
        },
        "derivable_hypothesis_candidates": ledger_derived_candidates,
        "schema_quality": ledger_schema_quality,
        "reasoning_graph": ledger_reasoning_graph,
        "data_graph": ledger_data_graph,
        "stage_gate_state": stage_gate_state,
        "open_validation_gaps": ledger_open_validation_gaps,
        "planner_summary": {
            "action_count": priority_actions.len(),
            "hypothesis_count": priority_hypotheses.len(),
            "selected_hypothesis_count": selected_hypotheses.len(),
            "fallback_hypothesis_candidate_count": fallback_candidate_count,
            "fallback_hypothesis_policy": "unclassified/generic fallback hypotheses are not selectable; regenerate classified falsifiable families from literature/data graph before analyst handoff",
            "convergence_mode": convergence_mode,
            "hypothesis_generation_basis": "reasoning-graph-and-data-graph-first",
        }
    });
    let output = labdirector_plan_path(paths, cycle_id);
    write_json(&output, &plan)?;
    Ok(output)
}

/// Same-class literature failures tolerated in one recovery lineage before
/// another resume stops being offered.
const MAX_LITERATURE_RECOVERY_FAILURES: usize = 3;

/// Stable terminal class for a failed literature attempt. Paper counts and the
/// exact validation-error list are progress diagnostics, not a new failure.
fn literature_recovery_failure_class(result: &Value) -> String {
    result
        .get("failure_category")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| result.get("status").and_then(Value::as_str))
        .unwrap_or("failed_literature_recovery")
        .to_string()
}

fn literature_resume_outcome(result: &Value) -> String {
    let papers = result
        .get("paper_count")
        .and_then(Value::as_u64)
        .map(|count| count.to_string())
        .unwrap_or_default();
    let mut errors: Vec<&str> = result
        .get("search_agent_assessment")
        .and_then(|assessment| assessment.get("errors"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    errors.sort_unstable();
    format!("{papers}|{}", errors.join(","))
}

fn is_literature_resume_lane(lane_dir: &Path) -> bool {
    read_json(&lane_dir.join("role-plan.json"))
        .ok()
        .and_then(|plan| plan.get("action_type").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|action| {
            matches!(action.as_str(), "adaptive_search_followup" | "abstract_review_followup")
        })
}

fn literature_recovery_root(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> String {
    let mut current = lane_id.to_string();
    let mut seen = HashSet::new();
    while seen.insert(current.clone()) {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &current);
        let Ok(role_plan) = read_json(&role_plan_path) else {
            break;
        };
        if !matches!(
            role_plan.get("action_type").and_then(Value::as_str),
            Some("adaptive_search_followup" | "abstract_review_followup")
        ) {
            break;
        }
        let Some(parent) = role_plan
            .get("source_brief_id")
            .and_then(Value::as_str)
            .filter(|parent| !parent.trim().is_empty())
        else {
            break;
        };
        if !lane_role_plan_path(paths, cycle_id, parent).is_file() {
            break;
        }
        current = parent.to_string();
    }
    current
}

fn literature_recovery_failure_count(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    failure_class: &str,
) -> usize {
    let mut current = lane_id.to_string();
    let mut seen = HashSet::new();
    let mut failures = 0;
    while seen.insert(current.clone()) {
        let lane_dir = lane_root(paths, cycle_id, &current);
        let failed = read_json(&lane_dir.join("final-status.json"))
            .ok()
            .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string))
            .as_deref()
            == Some("failed");
        if failed {
            if let Ok(result) = read_lane_result_json(&lane_dir.join("result.json")) {
                if literature_recovery_failure_class(&result) == failure_class {
                    failures += 1;
                }
            }
        }
        let Ok(role_plan) = read_json(&lane_dir.join("role-plan.json")) else {
            break;
        };
        if !matches!(
            role_plan.get("action_type").and_then(Value::as_str),
            Some("adaptive_search_followup" | "abstract_review_followup")
        ) {
            break;
        }
        let Some(parent) = role_plan
            .get("source_brief_id")
            .and_then(Value::as_str)
            .filter(|parent| !parent.trim().is_empty())
        else {
            break;
        };
        if !lane_role_plan_path(paths, cycle_id, parent).is_file() {
            break;
        }
        current = parent.to_string();
    }
    failures
}

fn latest_literature_recovery_sources(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<HashSet<String>> {
    let mut newest_by_root: HashMap<String, (String, String)> = HashMap::new();
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !final_status_path.is_file()
            || !result_path.is_file()
            || fs::metadata(&result_path)
                .map(|metadata| metadata.len() > 5 * 1024 * 1024)
                .unwrap_or(true)
        {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("failed") {
            continue;
        }
        let result = read_lane_result_json(&result_path)?;
        let recommends_recovery = result
            .get("recommended_actions")
            .and_then(Value::as_array)
            .is_some_and(|actions| {
                actions.iter().any(|action| {
                    matches!(
                        action.get("type").and_then(Value::as_str),
                        Some("adaptive_search_followup" | "abstract_review_followup")
                    )
                })
            });
        if !recommends_recovery {
            continue;
        }
        let root = literature_recovery_root(paths, cycle_id, &lane_id);
        let completed_at = final_status
            .get("completed_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let candidate = (completed_at, lane_id.clone());
        if newest_by_root
            .get(&root)
            .map(|newest| &candidate > newest)
            .unwrap_or(true)
        {
            newest_by_root.insert(root, candidate);
        }
    }
    Ok(newest_by_root
        .into_values()
        .map(|(_, lane_id)| lane_id)
        .collect())
}

pub(crate) fn collect_failed_literature_recovery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    // A resume inherits its predecessor's journal. When that journal can never
    // validate, every resume ends in the same terminal class and recommends
    // itself again. Counts and individual validation errors can still change.
    //
    // MEASURED ON cycle-b-20260917d, 2026-09-17. The first literature scout
    // ran without network and wrote rounds that fail validation; nine resume
    // scouts in thirty minutes each ended `insufficient_corpus` on the same three
    // papers and the same nine journal errors, with lab-director lanes between
    // them, and nothing downstream ever started. Stop offering a resume that has
    // already produced the same terminal failure this many times.
    let mut identical_resume_failures: HashMap<String, usize> = HashMap::new();
    for (_, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let failed = read_json(&lane_dir.join("final-status.json"))
            .ok()
            .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string))
            .as_deref()
            == Some("failed");
        if !failed || !is_literature_resume_lane(&lane_dir) {
            continue;
        }
        let result_path = lane_dir.join("result.json");
        if fs::metadata(&result_path)
            .map(|metadata| metadata.len() > 5 * 1024 * 1024)
            .unwrap_or(true)
        {
            continue;
        }
        if let Ok(result) = read_lane_result_json(&result_path) {
            *identical_resume_failures
                .entry(literature_resume_outcome(&result))
                .or_insert(0) += 1;
        }
    }
    // MEASURED ON cycle-a-20260919, 2026-09-20. followup-scout-16,
    // -19, and -22 all replayed followup-scout-11's original abstract-review
    // checkpoint. Every failed result remained a priority action, and the
    // attempt suffix made each replay's task signature new. Keep independent
    // recovery roots, but resume only their newest durable checkpoint.
    let latest_recovery_sources = latest_literature_recovery_sources(paths, cycle_id)?;
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !final_status_path.exists()
            || !result_path.exists()
            || fs::metadata(&result_path)
                .map(|metadata| metadata.len() > 5 * 1024 * 1024)
                .unwrap_or(true)
        {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("failed") {
            continue;
        }
        if !latest_recovery_sources.contains(&lane_id) {
            continue;
        }
        let result = read_lane_result_json(&result_path)?;
        let failure_class = literature_recovery_failure_class(&result);
        // MEASURED ON cycle-a-20260919, 2026-10-06.
        // followup-scout-241, -258, and -260 all ended in
        // adaptive_literature_search_incomplete, but their paper counts rose
        // from 11 to 20 to 27. The volatile exact-outcome key never reached the
        // cap, so count the stable terminal class along this recovery ancestry.
        let lineage_failure_count = literature_recovery_failure_count(
            paths,
            cycle_id,
            &lane_id,
            &failure_class,
        );
        if identical_resume_failures
            .get(&literature_resume_outcome(&result))
            .copied()
            .unwrap_or(0)
            >= MAX_LITERATURE_RECOVERY_FAILURES
            || lineage_failure_count >= MAX_LITERATURE_RECOVERY_FAILURES
        {
            continue;
        }
        for action in result
            .get("recommended_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
            if !matches!(
                action_type,
                "adaptive_search_followup" | "abstract_review_followup"
            ) {
                continue;
            }
            let source_lane_id = action
                .get("source_lane_id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&lane_id);
            if priority_actions.iter().any(|existing| {
                existing.get("type").and_then(Value::as_str) == Some(action_type)
                    && existing
                        .get("source_lane_id")
                        .and_then(Value::as_str)
                        .or_else(|| existing.get("brief_id").and_then(Value::as_str))
                        == Some(source_lane_id)
            }) {
                continue;
            }
            let priority_score = match action
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or("high")
            {
                "high" | "critical" => 225,
                "medium" => 180,
                _ => 140,
            };
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("Resume the failed literature lane from its saved search and abstract-review artifacts.");
            let mut recovery = action.clone();
            recovery["brief_id"] = json!(source_lane_id);
            recovery["source_lane_id"] = json!(source_lane_id);
            recovery["description"] = json!(description);
            recovery["priority_score"] = json!(priority_score);
            // These recovery actions are executable only by a reasoning Scout;
            // normalize older or partially written payloads to the current
            // native Codex lane contract.
            recovery["preferred_role"] = json!("scout");
            recovery["runtime_class"] = json!("codex-agent");
            priority_actions.push(recovery);
        }
    }
    Ok(())
}

/// Send an engineer to audit how each completed lab-runner's result was produced.
///
/// The analyst is already required to interpret a runner's numbers, and the
/// engineer already repairs a runner that failed. A run that SUCCEEDED was
/// reviewed by nobody for whether it did what it claimed -- and the gate's own
/// check asks only whether validation results EXIST, not whether anyone found
/// them sound.
///
/// One audit lane per runner lane, opened once its result is on disk, and never
/// for a lane whose audit already ran.
pub(crate) fn collect_runner_execution_audit_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let lanes = match fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
            .collect::<Vec<_>>(),
        Err(_) => return Ok(()),
    };
    let audited: std::collections::BTreeSet<String> = lanes
        .iter()
        .filter_map(|(_, lane_dir)| {
            // Index fields only. This runs over every lane on every pass, and a
            // role plan on this cycle averages 162 KB across 630 of them;
            // read_role_plan_index_fields reads the first 64 KB and caches by
            // size and mtime, where read_json parses all of it every time. See
            // simulation_order_progress for the measurement.
            let fields = crate::labdirector::followup_counts::read_role_plan_index_fields(
                &lane_dir.join("role-plan.json"),
            )
            .ok()
            .flatten()?;
            if fields.action_type.as_deref() != Some(RUNNER_EXECUTION_AUDIT_ACTION) {
                return None;
            }
            // The brief id, which every role plan carries. Reading the target
            // out of planner_metadata looked tidier and matched nothing, so
            // every pass re-opened an audit for a lane already audited:
            // MEASURED ON cycle-a-20260919, 2026-09-21, ten runners
            // audited twice over, twenty lanes for ten answers.
            fields.source_brief_id
        })
        .collect();
    for (lane_id, lane_dir) in lanes {
        // Any lane that PRODUCED a result, not only a lab-runner. The engineer
        // that runs a simulation order is the biggest producer in this harness
        // and it was auditing everyone but itself.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-22.
        // coverage_decay_planar_push_power_v2 recorded 31,262 episodes and
        // 31 hours of simulated time against 69 seconds of wall time. Nobody
        // was asked whether that was possible.
        let produced_a_result = super::lane_identity::lane_id_looks_like_lab_runner(&lane_id)
            || crate::labdirector::followup_counts::read_role_plan_index_fields(
                &lane_dir.join("role-plan.json"),
            )
            .ok()
            .flatten()
            .is_some_and(|fields| {
                fields.action_type.as_deref() == Some(SIMULATION_DATA_GENERATION_ACTION)
            });
        if !produced_a_result {
            continue;
        }

        // Only a run that finished and left something behind: a failed runner is
        // the engineer's to repair, which is a different action.
        let final_status = read_json(&lane_dir.join("final-status.json")).ok();
        let finished = final_status
            .as_ref()
            .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string));
        if finished.as_deref() != Some("completed") {
            continue;
        }
        // A lane the owner stopped before it ran left nothing to audit.
        //
        // MEASURED ON cycle-a-20260919, 2026-10-02: the owner stopped
        // followup-engineer-247 before its 70-seed sweep began, pending a question
        // to the LabDirector; the stop is recorded as completed/owner_stopped so
        // the order settles. The next plan queued an engineer to audit how that
        // lane "produced its result".
        if final_status
            .as_ref()
            .and_then(|status| status.get("failure_category").and_then(Value::as_str))
            == Some("owner_stopped")
        {
            continue;
        }
        let brief_id = format!("execution-audit-{lane_id}");
        if audited.contains(&brief_id) {
            continue;
        }
        if priority_actions
            .iter()
            .any(|action| action.get("brief_id").and_then(Value::as_str) == Some(brief_id.as_str()))
        {
            continue;
        }
        priority_actions.push(json!({
            "type": RUNNER_EXECUTION_AUDIT_ACTION,
            "preferred_role": followup_role_for_action(RUNNER_EXECUTION_AUDIT_ACTION).unwrap_or("engineer"),
            "runtime_class": "codex-agent",
            "brief_id": brief_id,
            "priority": "high",
            "priority_score": 220,
            "description": format!(
                "Audit how lab-runner lane `{lane_id}` produced its result: whether the tool, version, config and checkpoint the handoff named are the ones that ran, whether anything fell back silently, whether the reported work is possible in the recorded wall time and hardware, whether the outputs cover what was declared, and whether the design's positive control actually worked. Return the verdict with its evidence; do not interpret the numbers and do not re-run anything."
            ),
            "audit_target": {
                "lane_id": lane_id,
                "lane_dir": lane_dir.to_string_lossy(),
                "result_path": lane_dir.join("result.json").to_string_lossy(),
                "role_plan_path": lane_dir.join("role-plan.json").to_string_lossy(),
            },
        }));
    }
    Ok(())
}

/// FNV-1a, 64-bit. A stable key for a set of names: std's DefaultHasher is free
/// to change between Rust releases, and a key that changed on a rebuild would
/// re-issue a decision the director had already made.
fn stable_key(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Ask the LabDirector to decide on the lanes the analysts have asked for.
///
/// `analysis_lane_proposals` was write-only until 09b39d5 surfaced it in the
/// director's digest -- and surfacing turned out not to be enough. That digest is
/// written only by chronicle lanes, and on cycle-a-20260919 on
/// 2026-09-27 no chronicle lane could be created either: every one of the plan's
/// 252 actions was a review already run dozens of times, the duplicate guard
/// suppressed all of them, and eight passes produced `created_followups: []`.
/// The information had a place to be shown and nothing to carry it there.
///
/// So this is an ACTION, not a note, and the one action in that plan that is not
/// a duplicate of anything. It asks; it does not choose. The director reads what
/// is outstanding and issues what should run -- through `simulation_orders`, the
/// channel that is proven to dispatch an engineer -- or declines it and says why.
///
/// Keyed on the SET of outstanding families. The same set is asked about once:
/// if the director declines, the question is not put again until an analyst
/// proposes something new. A new family is a new question, so it gets a new
/// lane. One open at a time (role_availability), so it cannot pile up.
pub(crate) fn collect_analysis_proposal_decision_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let action_type = crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION;
    let outstanding = crate::labdirector::context::outstanding_analysis_proposals(paths, cycle_id);
    if outstanding.rows.is_empty() {
        return Ok(());
    }
    let mut families: Vec<String> = outstanding
        .rows
        .iter()
        .filter_map(|(_, _, proposal)| {
            proposal.get("target_family").and_then(Value::as_str).map(str::to_string)
        })
        .collect();
    families.sort();
    families.dedup();
    // The owner's standing choice is part of the question. MEASURED ON
    // cycle-a-20260919, 2026-09-28: the owner re-chose (release, same
    // question, new method) after frozen-v5 falsified the first pick; the
    // re-selection was recorded within 20 seconds, and then nothing ran -- this
    // set of proposals had already been put to the director under the OLD pick,
    // so the key matched and the question was not asked again. A new owner
    // decision changes what the director must decide, so it is a new question.
    let owner_selection =
        crate::labdirector::problem_selection::recorded_owner_selection(paths, cycle_id);
    let owner_key = owner_selection
        .as_ref()
        .map(|selection| {
            format!(
                "{}@{}",
                selection.get("candidate_id").and_then(Value::as_str).unwrap_or(""),
                selection.get("selected_at").and_then(Value::as_str).unwrap_or(""),
            )
        })
        .unwrap_or_default();
    let brief_id = format!(
        "analysis-proposals-{}",
        stable_key(&format!("{}\u{2}{owner_key}", families.join("\u{1}")))
    );

    if priority_actions
        .iter()
        .any(|action| action.get("brief_id").and_then(Value::as_str) == Some(brief_id.as_str()))
    {
        return Ok(());
    }
    // Asked already? Index fields only, for the reason
    // collect_runner_execution_audit_actions gives: this runs over every lane on
    // every pass.
    if let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        let already_asked = entries.flatten().any(|entry| {
            crate::labdirector::followup_counts::read_role_plan_index_fields(
                &entry.path().join("role-plan.json"),
            )
            .ok()
            .flatten()
            .is_some_and(|fields| {
                fields.action_type.as_deref() == Some(action_type)
                    && fields.source_brief_id.as_deref() == Some(brief_id.as_str())
            })
        });
        if already_asked {
            return Ok(());
        }
    }

    let proposals: Vec<Value> = outstanding
        .rows
        .iter()
        .take(12)
        .map(|(_, lane_id, proposal)| {
            json!({
                "proposed_by_lane": lane_id,
                "target_family": proposal.get("target_family").cloned().unwrap_or(Value::Null),
                "description": proposal.get("description").cloned().unwrap_or(Value::Null),
                "decision_value": proposal.get("decision_value").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    // The owner's standing decision, in the owner's words, so the director
    // decides under it rather than under the pick it replaced.
    let owner_direction = owner_selection
        .as_ref()
        .map(|selection| {
            let candidate = selection.get("candidate_id").and_then(Value::as_str).unwrap_or("");
            let note = selection.get("note").and_then(Value::as_str).unwrap_or("");
            if candidate.eq_ignore_ascii_case("release") {
                format!(" The owner has RELEASED the choice of lead to you, with this direction: \"{note}\" Choose the design that follows it.")
            } else {
                format!(" The owner's standing pick is `{candidate}`: \"{note}\"")
            }
        })
        .unwrap_or_default();
    priority_actions.push(json!({
        "type": action_type,
        "preferred_role": followup_role_for_action(action_type).unwrap_or("lab-director"),
        "runtime_class": "codex-agent",
        "brief_id": brief_id,
        "priority": "critical",
        "priority_score": 240,
        "description": format!(
            "The analysts have proposed lanes that no plan has run: {} proposal(s) across {} target families, the newest per family attached as `analysis_proposals`. Several analyst gate standards name one of these as a PREREQUISITE -- until it runs, no amount of review satisfies that gate, and every handoff stays ready_for_runner=false. Decide which to issue. To run one, put it in `simulation_orders`: that is the channel that dispatches an engineer, and it is how a reproduction, a simulation, or an audit of a dataset snapshot gets done. To decline one, say which and why in your summary. You own this choice; the harness only put the question in front of you.{owner_direction}",
            outstanding.proposals_seen,
            families.len(),
        ),
        "analysis_proposals": proposals,
        "owner_selection": owner_selection.clone().unwrap_or(Value::Null),
    }));
    Ok(())
}

/// Send an engineer to run each of the LabDirector's simulation orders.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18: the cycle's data was to come
/// from Isaac Sim / MuJoCo, both probed clean, and nothing ever dispatched the
/// engineer who would run them -- every analyst deferred on
/// `blocked-no-matching-bundle` and every lab-runner waited on a handoff. The
/// owner then assigned simulation orchestration to the LabDirector; an
/// analyst-declared request let the analyst choose the experiment. Each order in
/// the newest director result now gets exactly one engineer lane per request id
/// while its episodes.csv + manifest.json are missing.
pub(crate) fn collect_simulation_generation_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    for order in latest_lab_director_simulation_orders(paths, cycle_id)? {
        let brief_id = simulation_order_brief_id(&order);
        if priority_actions
            .iter()
            .any(|action| action.get("brief_id").and_then(Value::as_str) == Some(brief_id.as_str()))
        {
            continue;
        }
        // One lane per order: an open or completed engineer lane already owns it,
        // and repeated failures are the director's to resolve.
        if simulation_order_progress(paths, cycle_id, &order)?
            != SimulationOrderProgress::NeedsEngineer
        {
            continue;
        }
        let request_id = simulation_order_request_id(&order);
        let (csv_path, manifest_path) = simulation_order_output_paths(paths, &order)
            .map(|(csv, manifest)| (json!(csv), json!(manifest)))
            .unwrap_or((Value::Null, Value::Null));
        let backend = order
            .get("simulator_backend")
            .and_then(Value::as_str)
            .unwrap_or("the ordered simulator");
        // What was wrong with the last attempt's data, in the words of the check
        // that rejected it: a successor that is not told simply repeats it.
        let unusable = simulation_order_unusable_reason(paths, &order)
            .map(|reason| format!(" THE PREVIOUS ATTEMPT'S DATA WAS REJECTED: {reason}. Find out why before you sweep again -- verify in support first, where a working policy reproduces its own demonstrations, and fix the build or return the blocker with your proposal."))
            .unwrap_or_default();
        let pilot = crate::labdirector::simulation_orders::simulation_order_pilot(&order);
        let pilot_only = crate::labdirector::simulation_orders::simulation_order_is_pilot_only(&order);
        let pilot_clause = if pilot_only {
            format!(
                " PILOT ONLY: this order pilots a runner-up candidate for the director. Run exactly the pilot slice {pilot} (its seeds and episodes_per_condition, every condition), evaluate each of its `criteria` on the pilot's episodes.csv, and STOP: write episodes.csv and manifest.json with `pilot_only: true`, `pilot: {{seeds, episodes_per_condition, criteria_results: [{{name, observed, threshold, passed}}], passed, note}}` and `for_candidate` copied from the order. Do not run the full sweep."
            )
        } else {
            format!(
                " PILOT FIRST (enforced: data without a passing `pilot` record is not accepted): before the full sweep run the pilot slice {pilot} -- its seeds at its episodes_per_condition over every condition -- and evaluate each of its `criteria` on the pilot's own episodes.csv. Record `pilot: {{seeds, episodes_per_condition, criteria_results: [{{name, observed, threshold, passed}}], passed, note}}` in manifest.json. Run the full sweep ONLY if every criterion passed (and the arms work in support); otherwise do not sweep -- return a blocker that quotes the pilot's numbers and what they say about the design, so the director decides before the budget is spent."
            )
        };
        priority_actions.push(json!({
            "type": SIMULATION_DATA_GENERATION_ACTION,
            "preferred_role": followup_role_for_action(SIMULATION_DATA_GENERATION_ACTION).unwrap_or("engineer"),
            "runtime_class": "codex-agent",
            "brief_id": brief_id,
            "priority": if pilot_only { "medium" } else { "high" },
            // A runner-up's pilot queues behind the lead's own order.
            "priority_score": if pilot_only { 200 } else { 230 },
            "description": format!(
                "Run the LabDirector's simulation order `{request_id}` exactly as ordered with {backend}; write episodes.csv and manifest.json at its output_path so the analyst can analyse it. Return a blocker rather than changing the design.{pilot_clause}{unusable}"
            ),
            "simulation_order": order,
            "simulation_output_csv": csv_path,
            "simulation_output_manifest": manifest_path,
        }));
    }
    Ok(())
}

#[cfg(test)]
mod simulation_generation_action_tests {
    use super::*;
    use tempfile::TempDir;

    fn test_paths(runtime_root: &Path) -> AppPaths {
        AppPaths {
            project_root: runtime_root.parent().unwrap_or(runtime_root).to_path_buf(),
            runtime_root: runtime_root.to_path_buf(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        }
    }

    fn order(cycle_id: &str) -> Value {
        json!({
            "request_id": "grasp_sweep",
            "simulator_backend": "mujoco",
            "interpreter_path": "C:/py/python.exe",
            "scenario": "gripper lifts a box",
            "conditions": [{"factor": "friction", "levels": ["0.4", "0.8"]}],
            "seeds": [1, 2],
            "episodes_per_condition": 10,
            "step_or_time_budget": "2000 steps",
            "emitted_columns": [{"name": "lift_success", "unit": "bool", "meaning": "lifted"}],
            "output_path": format!(".research-lab/datasets/{cycle_id}/simulations/grasp_sweep/episodes.csv"),
            "hypothesis_link": "success falls with friction iff slip dominates",
        })
    }

    fn write_director_orders(paths: &AppPaths, cycle_id: &str, lane_id: &str, orders: Value) {
        record_lab_director_simulation_orders(paths, cycle_id, lane_id, &json!({"simulation_orders": orders}))
            .unwrap();
    }

    #[test]
    fn a_director_order_without_its_csv_sends_one_engineer() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order";
        fs::create_dir_all(state_root(&paths)).unwrap();
        // The same order twice in one result is still one order.
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id), order(cycle_id)]));

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!(actions[0]["type"], SIMULATION_DATA_GENERATION_ACTION);
        assert_eq!(actions[0]["preferred_role"], "engineer");
        assert_eq!(actions[0]["runtime_class"], "codex-agent");
        assert_eq!(actions[0]["brief_id"], "simulation-grasp_sweep");
        assert_eq!(actions[0]["simulation_order"]["request_id"], "grasp_sweep");
        assert_eq!(actions[0]["simulation_order"]["hypothesis_link"], "success falls with friction iff slip dominates");

        // The same pass does not queue it twice.
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");

        // A later pass, with an engineer lane already open for it, adds none.
        let engineer = "followup-engineer-01";
        create_lane_contract(&paths, cycle_id, engineer, "engineer", "codex-agent", "read-write-scoped", "run it")
            .unwrap();
        write_json(
            &lane_root(&paths, cycle_id, engineer).join("role-plan.json"),
            &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
        )
        .unwrap();
        let mut later = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut later).unwrap();
        assert!(later.is_empty(), "{later:?}");
    }

    #[test]
    fn an_engineer_lane_the_index_has_not_seen_yet_still_owns_its_order() {
        // cycle-b-20260918: two engineers for one order, six seconds apart,
        // because the second pass read a cached index that lacked the first.
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-unindexed";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        // Only the lane directory and its role plan: no contract index entry.
        let lane_dir = lane_root(&paths, cycle_id, "followup-engineer-01");
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
        )
        .unwrap();
        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert!(actions.is_empty(), "a second engineer was queued: {actions:?}");
        // And the engineer that runs it is first in line for a worker slot.
        assert_eq!(
            crate::labdirector::pending_lane_action_priority(
                Some(&json!({"action_type": SIMULATION_DATA_GENERATION_ACTION})),
                false,
            ),
            0
        );
    }

    // MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-01
    // ended `completed` with no episodes.csv; the order counted as settled, so
    // no engineer was dispatched again, the runner blocked for missing data,
    // and the LabDirector re-ran novelty adjudications for fifteen hours.
    #[test]
    fn an_engineer_that_completed_without_the_data_does_not_end_the_order() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-empty-completion";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        create_lane_contract(&paths, cycle_id, "followup-engineer-01", "engineer", "codex-agent", "read-write-scoped", "run it")
            .unwrap();
        let dir = lane_root(&paths, cycle_id, "followup-engineer-01");
        write_json(
            &dir.join("role-plan.json"),
            &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
        )
        .unwrap();
        write_json(&dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "the order stayed settled after an empty completion: {actions:?}");
    }

    #[test]
    fn two_failed_engineers_end_the_order() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-failed";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        for (index, engineer) in ["followup-engineer-01", "followup-engineer-02"].iter().enumerate() {
            create_lane_contract(&paths, cycle_id, engineer, "engineer", "codex-agent", "read-write-scoped", "run it")
                .unwrap();
            let dir = lane_root(&paths, cycle_id, engineer);
            write_json(
                &dir.join("role-plan.json"),
                &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
            )
            .unwrap();
            write_json(&dir.join("final-status.json"), &json!({"status": "failed"})).unwrap();
            let mut actions = Vec::new();
            collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
            assert_eq!(actions.len(), usize::from(index == 0), "after {} failure(s): {actions:?}", index + 1);
        }
    }

    #[test]
    fn a_completed_capability_blocker_ends_blind_simulation_retries() {
        // MEASURED ON cycle-a-20260919, 2026-09-30: six completed
        // simulation_data_generation_followup lanes all reported that the
        // ordered RGB run had no exposed NVIDIA device. Because completion was
        // counted only as a generic attempt, the unchanged order kept returning
        // to the same host instead of reaching LabDirector for a decision.
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-capability-blocked";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        let lane_id = "followup-engineer-01";
        let lane_dir = lane_root(&paths, cycle_id, lane_id);
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "role": "engineer",
                "action_type": SIMULATION_DATA_GENERATION_ACTION,
                "source_brief_id": "simulation-grasp_sweep",
            }),
        )
        .unwrap();
        write_json(&lane_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        write_json(
            &lane_dir.join("result.json"),
            &json!({"extracted_json": {
                "capability_blockers": [{
                    "requirement": "GPU RGB rendering",
                    "attempts": [{"command": "nvidia-smi", "error": "no device"}],
                    "alternatives_tried": [{"approach": "CPU physics", "outcome": "no RGB"}],
                    "why_unsatisfiable": "No NVIDIA device is exposed on this host."
                }]
            }}),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert!(actions.is_empty(), "the terminal blocker was blindly retried: {actions:?}");
        assert_eq!(
            simulation_order_progress(&paths, cycle_id, &order(cycle_id)).unwrap(),
            SimulationOrderProgress::Settled,
        );
    }

    #[test]
    fn an_order_whose_csv_and_manifest_exist_sends_no_engineer() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-done";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        let out = paths
            .runtime_root
            .join("datasets")
            .join(cycle_id)
            .join("simulations")
            .join("grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("episodes.csv"), "friction,seed,lift_success\n0.4,1,1\n0.8,1,0\n").unwrap();
        // A run that showed its arms work where they must; without this record
        // the data is rejected unread and the order is re-issued.
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": {
                    "passed": true,
                    "arms": [{"name": "gripper", "in_support_success_rate": 0.8, "episodes": 10}]
                }
            }),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert!(actions.is_empty(), "{actions:?}");
    }

    #[test]
    fn a_reissued_order_sends_an_engineer_for_outputs_from_the_rejected_attempt() {
        // MEASURED ON cycle-a-20260919, 2026-09-21: LabDirector
        // rejected a stand-in pilot and reissued the same request, but its old
        // CSV and manifest permanently suppressed the replacement engineer.
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-reissued";
        fs::create_dir_all(state_root(&paths)).unwrap();
        let simulation_order = order(cycle_id);
        let out = paths
            .runtime_root
            .join("datasets")
            .join(cycle_id)
            .join("simulations")
            .join("grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(
            out.join("episodes.csv"),
            "friction,seed,lift_success\n0.4,1,1\n0.8,1,0\n",
        )
        .unwrap();
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": {
                    "passed": true,
                    "arms": [{"name": "gripper", "in_support_success_rate": 0.8, "episodes": 10}]
                }
            }),
        )
        .unwrap();
        for index in 1..=2 {
            let lane_id = format!("followup-engineer-{index:02}");
            let lane_dir = lane_root(&paths, cycle_id, &lane_id);
            write_json(
                &lane_dir.join("role-plan.json"),
                &json!({
                    "role": "engineer",
                    "action_type": SIMULATION_DATA_GENERATION_ACTION,
                    "source_brief_id": "simulation-grasp_sweep",
                }),
            )
            .unwrap();
            write_json(
                &lane_dir.join("final-status.json"),
                &json!({"status": "completed"}),
            )
            .unwrap();
        }
        write_json(
            &simulation_orders_record_path(&paths, cycle_id),
            &json!({
                "generated_by": "followup-lab-director-02",
                "updated_at": "2999-09-21T15:28:22Z",
                "simulation_orders": [simulation_order],
            }),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "the stale pilot still settled the reissued order: {actions:?}");
        assert_eq!(actions[0]["preferred_role"], "engineer");
    }

    // The owner, 2026-09-21: "does the engineer review lab-runner output too?" It did
    // not. The analyst interpreted the numbers and the engineer only ever saw a
    // runner that FAILED, so a successful run was checked by nobody for whether
    // it did what it claimed.
    #[test]
    fn a_completed_lab_runner_gets_one_engineer_audit() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "runner-audit";
        fs::create_dir_all(state_root(&paths)).unwrap();
        let runner_dir = lane_root(&paths, cycle_id, "followup-runner-01");
        write_json(&runner_dir.join("role-plan.json"), &json!({"role": "lab-runner"})).unwrap();
        write_json(&runner_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        // A runner that failed is a repair, not an audit: a different action.
        let failed_dir = lane_root(&paths, cycle_id, "followup-runner-02");
        write_json(&failed_dir.join("role-plan.json"), &json!({"role": "lab-runner"})).unwrap();
        write_json(&failed_dir.join("final-status.json"), &json!({"status": "failed"})).unwrap();

        let mut actions = Vec::new();
        collect_runner_execution_audit_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!(actions[0]["type"], RUNNER_EXECUTION_AUDIT_ACTION);
        assert_eq!(actions[0]["preferred_role"], "engineer");
        assert_eq!(actions[0]["audit_target"]["lane_id"], "followup-runner-01");

        // The engineer's own simulation lane is audited on the same terms.
        let sim_dir = lane_root(&paths, cycle_id, "followup-engineer-02");
        write_json(
            &sim_dir.join("role-plan.json"),
            &json!({"role": "engineer", "action_type": SIMULATION_DATA_GENERATION_ACTION}),
        )
        .unwrap();
        write_json(&sim_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        let mut with_sim = Vec::new();
        collect_runner_execution_audit_actions(&paths, cycle_id, &mut with_sim).unwrap();
        assert_eq!(with_sim.len(), 2, "the engineer audits everyone but itself: {with_sim:?}");

        // Once its audit lane exists, the runner is not audited again.
        let audit_dir = lane_root(&paths, cycle_id, "followup-engineer-01");
        write_json(
            &audit_dir.join("role-plan.json"),
            &json!({
                "role": "engineer",
                "action_type": RUNNER_EXECUTION_AUDIT_ACTION,
                // The field a dispatched lane really carries.
                "source_brief_id": "execution-audit-followup-runner-01",
                "planner_metadata": {"audit_target": {"lane_id": "followup-runner-01"}},
            }),
        )
        .unwrap();
        let mut again = Vec::new();
        collect_runner_execution_audit_actions(&paths, cycle_id, &mut again).unwrap();
        assert_eq!(again.len(), 1, "only the unaudited simulation lane is left: {again:?}");
        assert_eq!(again[0]["audit_target"]["lane_id"], "followup-engineer-02");

        // 2026-10-02: a simulation lane the owner stopped before it ran is not audited.
        let stopped_dir = lane_root(&paths, cycle_id, "followup-engineer-03");
        write_json(
            &stopped_dir.join("role-plan.json"),
            &json!({"role": "engineer", "action_type": SIMULATION_DATA_GENERATION_ACTION}),
        )
        .unwrap();
        write_json(
            &stopped_dir.join("final-status.json"),
            &json!({"status": "completed", "failure_category": "owner_stopped"}),
        )
        .unwrap();
        let mut with_stopped = Vec::new();
        collect_runner_execution_audit_actions(&paths, cycle_id, &mut with_stopped).unwrap();
        assert!(
            with_stopped.iter().all(|action| action["audit_target"]["lane_id"] != "followup-engineer-03"),
            "an owner-stopped lane was queued for an execution audit: {with_stopped:?}",
        );
    }

    // OWNER DECISION 2026-10-06: the engineer is told to pilot first; a
    // runner-up's pilot-only order queues behind the lead's order and holds no
    // analyst.
    #[test]
    fn the_engineer_is_told_to_pilot_first_and_a_runner_up_pilot_queues_behind() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "pilot-first";
        fs::create_dir_all(state_root(&paths)).unwrap();
        let mut alternate = order(cycle_id);
        alternate["request_id"] = json!("grasp_sweep_alt");
        alternate["output_path"] = json!(format!(".research-lab/datasets/{cycle_id}/simulations/grasp_sweep_alt/episodes.csv"));
        alternate["pilot_only"] = json!(true);
        alternate["for_candidate"] = json!("a runner-up: slip dominates only at high friction");
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id), alternate]));

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 2, "{actions:?}");
        let lead = &actions[0];
        let description = lead["description"].as_str().unwrap();
        assert!(description.contains("PILOT FIRST"), "{description}");
        assert!(description.contains("\"seeds\":[1,2]"), "the default pilot slice is spelled out: {description}");
        assert_eq!(lead["priority_score"], json!(230));
        let runner_up = &actions[1];
        let description = runner_up["description"].as_str().unwrap();
        assert!(description.contains("PILOT ONLY"), "{description}");
        assert!(description.contains("Do not run the full sweep"), "{description}");
        assert_eq!(runner_up["priority_score"], json!(200));

        // The runner-up's unrun pilot holds no analyst.
        assert_eq!(
            simulation_data_wait_reason(&paths, cycle_id).unwrap().as_deref(),
            Some("waiting-for-simulation-data request_id=grasp_sweep (engineer)"),
        );
    }

    // cycle-a-20260919: a lane the harness swept up after a restart
    // never ran the order, so it must not spend one of its attempts.
    #[test]
    fn a_lane_the_restart_swept_up_is_not_an_attempt() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-orphan";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        for (lane_id, status) in [
            ("followup-engineer-01", json!({"status": "aborted", "reason": "orphaned running lane detected during status reconciliation"})),
            ("followup-engineer-02", json!({"status": "aborted", "reason": "orphaned running lane detected during status reconciliation"})),
        ] {
            let lane_dir = lane_root(&paths, cycle_id, lane_id);
            write_json(
                &lane_dir.join("role-plan.json"),
                &json!({
                    "role": "engineer",
                    "action_type": SIMULATION_DATA_GENERATION_ACTION,
                    "source_brief_id": "simulation-grasp_sweep",
                }),
            )
            .unwrap();
            write_json(&lane_dir.join("final-status.json"), &status).unwrap();
        }

        // Two swept-up lanes, and the order still needs its first real attempt.
        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "the restart spent the order's attempts: {actions:?}");
    }

    // cycle-a-20260919, 2026-09-22: 31,262 episodes over 11 of the
    // design's 90 cells. Every arm passed in support and the outcome varied, so
    // both other checks admitted it -- and no contrast at matched distance could
    // be computed from it.
    #[test]
    fn a_run_that_records_cells_still_to_go_does_not_answer_the_order() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-partial";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        let out = paths
            .runtime_root
            .join("datasets")
            .join(cycle_id)
            .join("simulations")
            .join("grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("episodes.csv"), "friction,seed,lift_success
0.4,1,1
0.8,1,0
").unwrap();
        let passing_in_support = json!({
            "passed": true,
            "arms": [{"name": "gripper", "in_support_success_rate": 0.8, "episodes": 10}]
        });
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": passing_in_support,
                "completed_cells": ["a"],
                "remaining_cells": ["b", "c"],
            }),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        let description = actions[0]["description"].as_str().unwrap_or_default();
        assert!(description.contains("still to run"), "{description}");

        // The same run with nothing left to do answers the order.
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": passing_in_support,
                "completed_cells": ["a", "b", "c"],
                "remaining_cells": [],
            }),
        )
        .unwrap();
        let mut done = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut done).unwrap();
        assert!(done.is_empty(), "{done:?}");
    }

    #[test]
    fn a_running_short_manifest_keeps_the_data_producing_action_open() {
        // MEASURED ON cycle-a-20260919, 2026-10-04: progress waited at
        // experiment_data for post-bundle analysis while the selected manifest
        // still said running with 8,360/19,200 rows. Its `complete_cells` field
        // bypassed the older remaining-cells check, suppressing every engineer.
        const CYCLE: &str = "cycle-a-20260919";
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(
            &paths,
            CYCLE,
            "followup-lab-director-399",
            json!([order(CYCLE)]),
        );
        let out = paths
            .runtime_root
            .join("datasets")
            .join(CYCLE)
            .join("simulations")
            .join("grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(
            out.join("episodes.csv"),
            "friction,seed,lift_success\n0.4,1,1\n0.8,1,0\n",
        )
        .unwrap();
        write_json(
            &out.join("manifest.json"),
            &json!({
                "status": "running",
                "rows": 8360,
                "expected_rows": 19200,
                "complete_cells": ["seed=0", "seed=1", "seed=2", "seed=3"],
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": {
                    "passed": true,
                    "arms": [{"name": "gripper", "in_support_success_rate": 0.8, "episodes": 10}]
                }
            }),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, CYCLE, &mut actions).unwrap();
        assert_eq!(
            actions.len(),
            1,
            "the partial bundle still suppressed its resume: {actions:?}"
        );
        assert_eq!(actions[0]["type"], SIMULATION_DATA_GENERATION_ACTION);
        assert!(
            actions[0]["description"]
                .as_str()
                .unwrap_or_default()
                .contains("rows=8360 of 19200 expected"),
            "the successor was not told why the existing bundle needs resuming: {actions:?}"
        );
    }

    // cycle-a-20260919: 4500 episodes in which every arm failed in
    // support. The files existed; the order must not count as answered.
    #[test]
    fn an_order_whose_arms_failed_in_support_sends_another_engineer() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-order-degenerate";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        let out = paths
            .runtime_root
            .join("datasets")
            .join(cycle_id)
            .join("simulations")
            .join("grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("episodes.csv"), "friction,seed,lift_success\n0.4,1,1\n0.8,1,0\n").unwrap();
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": {
                    "passed": true,
                    "arms": [{"name": "diffusion_policy", "in_support_success_rate": 0.0, "episodes": 300}]
                }
            }),
        )
        .unwrap();

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        let description = actions[0]["description"].as_str().unwrap_or_default();
        assert!(
            description.contains("THE PREVIOUS ATTEMPT'S DATA WAS REJECTED"),
            "the successor is not told what was wrong: {description}"
        );
    }

    // An analyst's handoff is not an order: only the LabDirector designs the run.
    #[test]
    fn no_director_order_sends_no_engineer() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "sim-no-order";
        fs::create_dir_all(state_root(&paths)).unwrap();
        let analyst = "followup-analyst-01";
        create_lane_contract(&paths, cycle_id, analyst, "analyst", "codex-agent", "read-write-scoped", "design")
            .unwrap();
        let dir = lane_root(&paths, cycle_id, analyst);
        write_json(&dir.join("final-status.json"), &json!({"lane_id": analyst, "status": "completed"})).unwrap();
        write_json(&dir.join("handoff-validation-plan.json"), &json!({"status": "ready", "simulation_request": order(cycle_id)}))
            .unwrap();
        // A later director that answers null withdraws an earlier one's orders.
        write_director_orders(&paths, cycle_id, "followup-lab-director-01", json!([order(cycle_id)]));
        write_director_orders(&paths, cycle_id, "followup-lab-director-02", Value::Null);

        let mut actions = Vec::new();
        collect_simulation_generation_actions(&paths, cycle_id, &mut actions).unwrap();
        assert!(actions.is_empty(), "{actions:?}");
    }

    fn write_analyst_proposal(paths: &AppPaths, cycle_id: &str, lane_id: &str, family: &str) {
        let dir = cycle_lanes_root(paths, cycle_id).join(lane_id);
        fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        write_json(
            &dir.join("result.json"),
            &json!({"extracted_json": {"analysis_lane_proposals": [{
                "target_family": family,
                "description": format!("run {family}"),
                "decision_value": "unblocks the gate",
            }]}}),
        )
        .unwrap();
    }

    // MEASURED ON cycle-a-20260919, 2026-09-27: eight passes,
    // 252 priority actions, created_followups: []. The analysts had proposed
    // the prerequisite 349 times into a field nothing read; this is the action
    // that finally puts it in front of the director.
    #[test]
    fn the_analysts_proposals_become_one_decision_for_the_director() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "proposal-decision";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-01", "same_benchmark_reproduction_anchor");
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-02", "schema_identity_audit");
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-03", "schema_identity_audit");

        let mut actions = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut actions).unwrap();
        assert_eq!(actions.len(), 1, "one decision, not one lane per proposal: {actions:?}");
        let action = &actions[0];
        assert_eq!(action["type"], crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION);
        assert_eq!(action["preferred_role"], "lab-director");
        let families: std::collections::BTreeSet<&str> = action["analysis_proposals"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["target_family"].as_str())
            .collect();
        assert_eq!(
            families.into_iter().collect::<Vec<_>>(),
            vec!["same_benchmark_reproduction_anchor", "schema_identity_audit"],
            "newest per family: three proposals over two families are two rows",
        );
    }

    #[test]
    fn a_question_the_director_was_already_asked_is_not_asked_again() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "proposal-decision-once";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-01", "same_benchmark_reproduction_anchor");

        let mut first = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut first).unwrap();
        let brief_id = first[0]["brief_id"].as_str().unwrap().to_string();

        // The director lane that answered it, as dispatch writes one. A director
        // that DECLINED must not be asked the same question every pass.
        let asked = cycle_lanes_root(&paths, cycle_id).join("followup-lab-director-01");
        fs::create_dir_all(&asked).unwrap();
        fs::write(
            asked.join("role-plan.json"),
            format!(
                "{{
  \"role\": \"lab-director\",
  \"action_type\": \"{}\",
  \"source_brief_id\": \"{}\"
}}
",
                crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION,
                brief_id,
            ),
        )
        .unwrap();
        let mut again = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut again).unwrap();
        assert!(again.is_empty(), "the same set of proposals was put to the director twice: {again:?}");

        // A NEW family is a new question.
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-02", "schema_identity_audit");
        let mut new_question = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut new_question).unwrap();
        assert_eq!(new_question.len(), 1, "a new proposal family was never put to the director");
        assert_ne!(new_question[0]["brief_id"].as_str().unwrap(), brief_id);
    }

    // MEASURED ON cycle-a-20260919, 2026-09-28: the owner re-chose
    // after frozen-v5, the re-selection was recorded in 20 seconds, and nothing
    // ran -- the same proposals had been put to the director under the old pick.
    #[test]
    fn an_owner_re_decision_puts_the_question_to_the_director_again() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle_id = "proposal-decision-owner";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_analyst_proposal(&paths, cycle_id, "followup-analyst-01", "state_support_metric_intervention");
        let set_owner = |candidate: &str, at: &str| {
            crate::labdirector::problem_selection::update_expert_selection_state(&paths, cycle_id, |state| {
                state.insert(
                    "owner_selection".to_string(),
                    json!({"candidate_id": candidate, "selected_at": at, "note": "same question, new method"}),
                );
            })
            .unwrap();
        };
        set_owner("shared_coverage_decay", "2026-09-20T00:20:00Z");
        let mut before = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut before).unwrap();
        let old_key = before[0]["brief_id"].as_str().unwrap().to_string();

        set_owner("release", "2026-09-28T01:27:45Z");
        let mut after = Vec::new();
        collect_analysis_proposal_decision_actions(&paths, cycle_id, &mut after).unwrap();
        assert_eq!(after.len(), 1);
        assert_ne!(after[0]["brief_id"].as_str().unwrap(), old_key, "the owner's re-decision was not a new question");
        let description = after[0]["description"].as_str().unwrap();
        assert!(description.contains("RELEASED"), "the director is not told the owner released the choice: {description}");
        assert!(description.contains("same question, new method"), "the owner's direction did not reach the director");
    }
}
