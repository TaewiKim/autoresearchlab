#![allow(unused_imports)]
use super::*;

pub(crate) fn dispatch_pivot_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    stage_gate_blocks_pivot: bool,
    external_validation_required: bool,
    analyst_handoff_action_pending: bool,
    completed_labdirector_methods_handoff_present: bool,
    selected_hypotheses: &[Value],
    ranked_hypotheses: &[Value],
    reasoning_gap_statements: &[String],
    scout_materialization_recovery: &Option<Value>,
    existing_action_counts: &HashMap<String, usize>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let strategy_path = state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
    let pivot_strategy = if strategy_path.exists() {
        let strategy = read_json(&strategy_path).unwrap_or(Value::Null);
        if strategy.get("mode").and_then(Value::as_str) == Some("pivot") {
            Some(strategy)
        } else {
            None
        }
    } else {
        None
    };
    let pivot_strategy_overrides_stage_gate_blocks = pivot_strategy
        .as_ref()
        .map(|strategy| {
            strategy
                .get("forced")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || matches!(
                    strategy.get("source").and_then(Value::as_str),
                    Some("supervisor_stagnation_recovery") | Some("forced_pivot_cli")
                )
        })
        .unwrap_or(false);
    let pivot_stage_gate_permits_recovery =
        !stage_gate_blocks_pivot || pivot_strategy_overrides_stage_gate_blocks;
    let pivot_has_selected_labdirector_hypothesis = selected_hypotheses.iter().any(|item| {
        item.get("source").and_then(Value::as_str) == Some("lab-director-hypothesis")
            || item.get("state").and_then(Value::as_str) == Some("lab-director-selected")
    });
    if !external_validation_required && pivot_stage_gate_permits_recovery {
        if let Some(strategy) = pivot_strategy.as_ref() {
            let reason = strategy
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("strategy pivot");
            let pivot_source = strategy.get("source").and_then(Value::as_str).unwrap_or("");
            let review_context = pivot_review_context(paths, cycle_id)?;
            let chronicle_context =
                pivot_chronicle_context(reason, selected_hypotheses, ranked_hypotheses, plan_ctx);
            let pivot_decision_time = strategy_decision_timestamp(&strategy_path, strategy);
            let labdirector_requery_completed_for_pivot =
                completed_labdirector_requery_at_or_after_latest_pivot_evidence(
                    paths,
                    cycle_id,
                    pivot_decision_time,
                )?;
            // FIX-AD: a forced data-materialization fail-closed pivot must not be
            // suppressed by `labdirector_requery_completed_for_pivot` — the
            // runner-recovery requery lanes keep completing with "uphold" of the
            // unmaterializable lead, which would otherwise satisfy that gate every
            // pass and starve the forced pivot forever. Bypass the suppression
            // while the pivot is forced; the natural stop is the lead changing
            // (then the fail-closed detector returns None and FIX-AD stops
            // refreshing the pivot). Anti-spam is the lab-director role cap +
            // pivot-before-recovery precedence (one forced pivot lane per pass).
            let forced_dataset_pivot = pivot_source == "scout_materialization_failclosed";
            if created.len() < max_new_lanes
                && !analyst_handoff_action_pending
                && !completed_labdirector_methods_handoff_present
                && (forced_dataset_pivot || !labdirector_requery_completed_for_pivot)
                && followup_role_available(
                    role_availability,
                    "lab-director",
                    "lab_director_requery_followup",
                    created_by_role,
                    created_by_action,
                )
            {
                dispatch_pivot_labdirector_requery(
                    paths,
                    cycle_id,
                    reason,
                    pivot_source,
                    pivot_decision_time,
                    plan_ctx,
                    selected_hypotheses,
                    reasoning_gap_statements,
                    &review_context,
                    &chronicle_context,
                    existing_action_counts,
                    created,
                    existing_signatures,
                    created_by_role,
                    created_by_action,
                )?;
            }
            if created.len() < max_new_lanes
                && !analyst_handoff_action_pending
                && !completed_labdirector_methods_handoff_present
                && !pivot_has_selected_labdirector_hypothesis
                && followup_role_available(
                    role_availability,
                    "scout",
                    "data_acquisition_followup",
                    created_by_role,
                    created_by_action,
                )
            {
                dispatch_pivot_scout_data_acquisition(
                    paths,
                    cycle_id,
                    reason,
                    plan_ctx,
                    scout_materialization_recovery,
                    &review_context,
                    &chronicle_context,
                    existing_action_counts,
                    created,
                    existing_signatures,
                    created_by_role,
                    created_by_action,
                )?;
            }
        }
    }
    if created.len() < max_new_lanes
        && !external_validation_required
        && pivot_stage_gate_permits_recovery
        && !analyst_handoff_action_pending
        && !pivot_has_selected_labdirector_hypothesis
        && !selected_hypotheses.is_empty()
        && followup_role_available(
            role_availability,
            "analyst",
            "pivot_followup",
            created_by_role,
            created_by_action,
        )
    {
        if let Some(strategy) = pivot_strategy.as_ref() {
            let mode = strategy.get("mode").and_then(Value::as_str).unwrap_or("");
            if mode == "pivot" {
                let reason = strategy
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("strategy pivot");
                let review_context = pivot_review_context(paths, cycle_id)?;
                let chronicle_context = pivot_chronicle_context(
                    reason,
                    selected_hypotheses,
                    ranked_hypotheses,
                    plan_ctx,
                );
                dispatch_pivot_analyst_handoff(
                    paths,
                    cycle_id,
                    reason,
                    plan_ctx,
                    &review_context,
                    &chronicle_context,
                    existing_action_counts,
                    created,
                    existing_signatures,
                    created_by_role,
                    created_by_action,
                )?;
            }
        }
    }
    Ok(())
}

pub(crate) fn pivot_review_context(paths: &AppPaths, cycle_id: &str) -> Result<Value> {
    let mut ctx = json!({});
    for (name, file_name) in [
        (
            "conclusion_review",
            format!("{cycle_id}-conclusion-review.json"),
        ),
        (
            "approval_review",
            format!("{cycle_id}-approval-review.json"),
        ),
        ("gate_review", format!("{cycle_id}-gate-review.json")),
        (
            "hypothesis_ledger",
            format!("{cycle_id}-hypothesis-ledger.json"),
        ),
    ] {
        let path = state_root(paths).join(file_name);
        if path.exists() {
            ctx[name] = read_json(&path)?;
        }
    }
    Ok(ctx)
}

pub(crate) fn pivot_chronicle_context(
    reason: &str,
    selected_hypotheses: &[Value],
    ranked_hypotheses: &[Value],
    plan_ctx: &DispatchPlanContext<'_>,
) -> Value {
    json!({
        "pivot_reason": reason,
        "previous_selected_hypotheses": selected_hypotheses,
        "previous_ranked_hypotheses": ranked_hypotheses,
        "derivable_hypothesis_candidates": plan_ctx.candidate_hypotheses,
        "open_validation_gaps": plan_ctx.open_validation_gaps,
        "schema_quality": plan_ctx.schema_quality,
        "reasoning_graph": plan_ctx.reasoning_graph,
        "data_graph": plan_ctx.data_graph,
        "instruction": "Use this context to avoid regenerating the same weak family. Propose pivot hypotheses from the literature_graph + data_graph first. Then, before validation design/promotion, identify same-dataset or closest-comparable reference papers and extract their methods/endpoints/covariates/limitations as the baseline to improve, challenge, or extend.",
    })
}

pub(crate) fn dispatch_pivot_labdirector_requery(
    paths: &AppPaths,
    cycle_id: &str,
    reason: &str,
    pivot_source: &str,
    pivot_decision_time: Option<DateTime<Utc>>,
    plan_ctx: &DispatchPlanContext<'_>,
    selected_hypotheses: &[Value],
    reasoning_gap_statements: &[String],
    review_context: &Value,
    chronicle_context: &Value,
    existing_action_counts: &HashMap<String, usize>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let dataset_failclosed = pivot_source == "scout_materialization_failclosed";
    // Ledger gate (owner option D). The dataset fail-closed pivot is EXEMPT:
    // the lead's declared dataset is proven unobtainable, refining it in place
    // is physically impossible, and the forced demote is data governance
    // (FIX-AG) that must stand. Every other strategy pivot must respect a
    // ledger DENY — the stagnation detector can say "signature flat" while the
    // ledger says the lead's binding rubric is still climbing; the ledger is
    // the per-lead source of truth, and it releases automatically via
    // lead_stalled_pivot_permitted when the lead genuinely plateaus.
    let ledger_deny = if dataset_failclosed {
        None
    } else {
        ledger_denies_pivot(paths, cycle_id)
    };
    let attempt = next_dispatch_action_attempt(
        "lab-director",
        "lab_director_requery_followup",
        existing_action_counts,
        created_by_action,
    );
    let mut pivot_scope = selected_hypotheses
        .iter()
        .filter_map(|item| item.get("statement").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for statement in reasoning_gap_statements.iter() {
        if !pivot_scope.contains(statement) {
            pivot_scope.push(statement.clone());
        }
    }
    pivot_scope.truncate(8);
    let failclosed_clause = if dataset_failclosed {
        " FAIL-CLOSED DATA CONSTRAINT: the current lead's declared dataset/accession has been confirmed UNOBTAINABLE - scouts could not materialize it and completed runners have been validating the lead on a MISMATCHED substitute dataset via dataset override, which yields only degraded, non-promotable evidence. Do NOT uphold this lead and do NOT keep requesting materialization of the same dataset; 'uphold' is NOT a valid decision here. You MUST demote the failed lead and select a structurally distinct replacement hypothesis family whose dataset is ALREADY materialized (choose from the materialized datasets in chronicle/review context)."
    } else {
        ""
    };
    let pivot_requery_description = match ledger_deny.as_deref() {
        Some(deny_reason) => format!(
            "The latest strategy decision requested a pivot ('{reason}'), but the progress ledger DENIES abandoning the protected lead this round.{clause} Read Chronicle context and the prior gate blockers, then improve the PROTECTED lead in place with a concrete validation package. [pivot lab-director attempt {attempt}]",
            clause = ledger_keep_refining_clause(deny_reason)
        ),
        None => format!(
            "LabDirector must pivot before any more document or validation convergence: the latest strategy decision says '{reason}'.{failclosed_clause} Read Chronicle context, prior gate/conclusion blockers, runner degradation, and materialized datasets; then demote the failed lead or issue a structurally distinct replacement hypothesis package with concrete validation requirements. [pivot lab-director attempt {attempt}]"
        ),
    };
    let task_body = followup_task_markdown(
        cycle_id,
        plan_ctx.objective,
        "lab-director",
        "strategy_pivot",
        &pivot_requery_description,
        &pivot_scope,
    );
    let signature = followup_task_signature(&task_body);
    if existing_signatures.contains(&signature) {
        return Ok(());
    }
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-lab-director-")?;
    let contract_path = create_lane_contract(
        paths,
        cycle_id,
        &lane_id,
        "lab-director",
        "codex-agent",
        "read-write-scoped",
        &task_body,
    )?;
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "lab-director",
        assigned_model_for_role("lab-director", "codex-agent"),
        plan_ctx.objective,
        "strategy_pivot",
        &pivot_requery_description,
        "lab_director_requery_followup",
        &pivot_scope,
        plan_ctx.candidate_hypotheses,
        Some(plan_ctx.schema_quality),
        Some(plan_ctx.reasoning_graph),
        Some(plan_ctx.data_graph),
        plan_ctx.open_validation_gaps,
        json!({
            "priority_source": "strategy_pivot",
            "preferred_role": "lab-director",
            "effective_role": "lab-director",
            "pivot_reason": reason,
            "pivot_strategy_decided_at": pivot_decision_time.map(|item| item.to_rfc3339()).unwrap_or_else(|| "unknown".to_string()),
            "requires_new_hypothesis_family": true,
            "must_demote_or_replace_failed_lead": true,
            "must_issue_replacement_hypotheses": true,
            "dataset_failclosed": dataset_failclosed,
            "uphold_decision_forbidden": dataset_failclosed,
            "must_select_materialized_dataset": dataset_failclosed,
            "must_emit_required_validation_before_promotion": true,
            "forbid_document_stage_until_replacement_validated": true,
            "pivot_requery_policy": {
                "decision_rule": "If the incumbent limitations are decisive, do not refine around them; pivot to a new materialized, falsifiable hypothesis family.",
                "minimum_output_fields": [
                    "requery_decision",
                    "replacement_hypotheses",
                    "rationale",
                    "validation_changes",
                    "required_validation_before_promotion",
                    "next_actions"
                ],
                "replacement_hypothesis_requirements": [
                    "selected dataset or its identifier",
                    "exposure or mechanism family",
                    "outcome/readout",
                    "same-dataset or closest-reference baseline before validation design",
                    "rival mechanisms",
                    "falsification criteria",
                    "executable analyst/lab-runner validation requirements"
                ]
            },
            "previous_review_context": review_context.clone(),
            "chronicle_research_context": chronicle_context.clone(),
        }),
    )?;
    existing_signatures.insert(signature);
    *created_by_role
        .entry("lab-director".to_string())
        .or_insert(0) += 1;
    *created_by_action
        .entry("lab-director::lab_director_requery_followup".to_string())
        .or_insert(0) += 1;
    created.push(json!({
        "lane_id": lane_id,
        "role": "lab-director",
        "contract_path": contract_path,
        "source_brief_id": "strategy_pivot",
        "role_plan_path": role_plan_path,
    }));
    Ok(())
}

pub(crate) fn dispatch_pivot_scout_data_acquisition(
    paths: &AppPaths,
    cycle_id: &str,
    reason: &str,
    plan_ctx: &DispatchPlanContext<'_>,
    scout_materialization_recovery: &Option<Value>,
    review_context: &Value,
    chronicle_context: &Value,
    existing_action_counts: &HashMap<String, usize>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let attempt = next_dispatch_action_attempt(
        "scout",
        "data_acquisition_followup",
        existing_action_counts,
        created_by_action,
    );
    let materialization_recovery = scout_materialization_recovery.clone();
    let recovered_fetched_bundle_count = materialization_recovery
        .as_ref()
        .and_then(|item| item.get("totals"))
        .and_then(|totals| totals.get("fetched_bundle_count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if recovered_fetched_bundle_count > 0 {
        return Ok(());
    }
    let materialization_fetch_required = materialization_recovery.is_some();
    let scout_description = if materialization_fetch_required {
        format!(
            "LabDirector pivoted the cycle (reason: '{reason}'), and recent scouts repeatedly found accession-bearing candidates without materializing bundles. Stop scheduling another discovery-only loop: fetch/materialize the best open accession-bearing candidates into cycle-scoped bundles before the next validation pass. [pivot materialization attempt {attempt}]"
        )
    } else {
        format!(
            "LabDirector pivoted the cycle (reason: '{reason}'). Re-run targeted literature and public-dataset KG-seed discovery together using compact repository-native queries: surface named datasets or benchmarks from the objective's own field, dataset schema clues, and literature-backed variables that can support a structurally new hypothesis family before validation materialization. [pivot data-acquisition attempt {attempt}]"
        )
    };
    let scout_task_body = followup_task_markdown(
        cycle_id,
        plan_ctx.objective,
        "scout",
        "strategy_pivot",
        &scout_description,
        &[],
    );
    let scout_signature = followup_task_signature(&scout_task_body);
    if existing_signatures.contains(&scout_signature) {
        return Ok(());
    }
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
    let contract_path = create_lane_contract(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        "external-driver",
        "driver-exec",
        &scout_task_body,
    )?;
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        assigned_model_for_role("scout", "external-driver"),
        plan_ctx.objective,
        "strategy_pivot",
        &scout_description,
        "data_acquisition_followup",
        &[],
        &[],
        Some(plan_ctx.schema_quality),
        Some(plan_ctx.reasoning_graph),
        Some(plan_ctx.data_graph),
        plan_ctx.open_validation_gaps,
        json!({
            "priority_source": "strategy_pivot",
            "preferred_role": "scout",
            "effective_role": "scout",
            "pivot_reason": reason,
            "target_rubric": if materialization_fetch_required { json!("validation_materialization_gate") } else { Value::Null },
            "source_discovery_mode": if materialization_fetch_required { json!("validation-materialization-fetch") } else { json!("literature-and-dataset-coupled-pivot") },
            "source_selection_strategy": if materialization_fetch_required { json!("validation-target-driven") } else { json!("semantic-target-driven") },
            "fetch_policy": if materialization_fetch_required { json!("fetch") } else { Value::Null },
            "materialization_recovery": materialization_recovery.unwrap_or(Value::Null),
            "dataset_discovery_contract": dataset_discovery_contract(plan_ctx.objective),
            "forbidden_dataset_terms": forbidden_dataset_terms_from_text(plan_ctx.objective),
            "must_surface_named_cohorts_or_accessions": true,
            "must_return_schema_clues_for_design_selector": true,
            "must_find_same_dataset_reference_papers_before_validation": true,
            "must_extract_reference_analysis_methods": true,
            "previous_review_context": review_context.clone(),
            "chronicle_research_context": chronicle_context.clone(),
        }),
    )?;
    existing_signatures.insert(scout_signature);
    *created_by_role.entry("scout".to_string()).or_insert(0) += 1;
    *created_by_action
        .entry("scout::data_acquisition_followup".to_string())
        .or_insert(0) += 1;
    created.push(json!({
        "lane_id": lane_id,
        "role": "scout",
        "contract_path": contract_path,
        "source_brief_id": "strategy_pivot",
        "role_plan_path": role_plan_path,
    }));
    Ok(())
}

pub(crate) fn dispatch_pivot_analyst_handoff(
    paths: &AppPaths,
    cycle_id: &str,
    reason: &str,
    plan_ctx: &DispatchPlanContext<'_>,
    review_context: &Value,
    chronicle_context: &Value,
    existing_action_counts: &HashMap<String, usize>,
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    let attempt = next_dispatch_action_attempt(
        "analyst",
        "pivot_followup",
        existing_action_counts,
        created_by_action,
    );
    let pivot_description = format!(
        "Chronicle pivoted the cycle (reason: '{reason}'). Generate at least one rival hypothesis family that is structurally distinct from the prior lead - different exposure, different mechanism, or different measurement channel - and emit one executable handoff check for lab-runner. [pivot analyst attempt {attempt}]"
    );
    let pivot_task_body = followup_task_markdown(
        cycle_id,
        plan_ctx.objective,
        "analyst",
        "strategy_pivot",
        &pivot_description,
        &[],
    );
    let pivot_signature = followup_task_signature(&pivot_task_body);
    if existing_signatures.contains(&pivot_signature) {
        return Ok(());
    }
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-analyst-")?;
    let contract_path = create_lane_contract(
        paths,
        cycle_id,
        &lane_id,
        "analyst",
        "external-driver",
        "driver-exec",
        &pivot_task_body,
    )?;
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "analyst",
        assigned_model_for_role("analyst", "external-driver"),
        plan_ctx.objective,
        "strategy_pivot",
        &pivot_description,
        "pivot_followup",
        &[],
        &[],
        Some(plan_ctx.schema_quality),
        Some(plan_ctx.reasoning_graph),
        Some(plan_ctx.data_graph),
        plan_ctx.open_validation_gaps,
        json!({
            "priority_source": "strategy_pivot",
            "preferred_role": "analyst",
            "effective_role": "analyst",
            "pivot_reason": reason,
            "previous_review_context": review_context.clone(),
            "chronicle_research_context": chronicle_context.clone(),
        }),
    )?;
    existing_signatures.insert(pivot_signature);
    *created_by_role.entry("analyst".to_string()).or_insert(0) += 1;
    *created_by_action
        .entry("analyst::pivot_followup".to_string())
        .or_insert(0) += 1;
    created.push(json!({
        "lane_id": lane_id,
        "role": "analyst",
        "contract_path": contract_path,
        "source_brief_id": "strategy_pivot",
        "role_plan_path": role_plan_path,
    }));
    Ok(())
}
