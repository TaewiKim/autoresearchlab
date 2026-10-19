#![allow(unused_imports)]
use super::*;
use crate::labdirector::context::compact_deliberation_for_prompt;

const APPROVED_SCHOLARLY_NETWORK_POLICY: &str = "approved-scholarly-metadata-v1";

fn approved_scholarly_metadata_policy(policy: Option<&str>) -> bool {
    policy == Some(APPROVED_SCHOLARLY_NETWORK_POLICY)
}

fn effective_scout_followup_action<'a>(
    role: &str,
    action_type: &'a str,
    policy: Option<&str>,
) -> &'a str {
    if role == "scout"
        && action_type == "data_acquisition_followup"
        && approved_scholarly_metadata_policy(policy)
    {
        "reasoning_literature_scout"
    } else {
        action_type
    }
}

fn approved_scholarly_literature_scout_model_route() -> Value {
    crate::labdirector::policy::literature_scout_model_route()
}

fn approved_scholarly_dataset_inquiry_focus() -> Value {
    json!({
        "focus_id": "dataset_evaluation_feasibility_evidence",
        "purpose": "Find scholarly evidence on datasets, benchmarks, evaluation protocols, and feasibility constraints that directly inform the objective's hypotheses.",
        "allowed_evidence_scope": "approved scholarly metadata sources and the current cycle's local snapshot only",
        "forbidden_operations": [
            "external dataset downloads",
            "dataset registry/browser probing",
            "Hugging Face, Zenodo, or other unapproved network retrieval"
        ],
        "decision_rule": "Record unavailable datasets or benchmarks as feasibility gaps with next search decisions; do not substitute an external download."
    })
}

/// The lead the gatekeeper is being asked to score, in the terms it is scored on.
///
/// The gatekeeper prompt asks "does the reasoning graph still indicate missing
/// falsification, rival-explanation, or moderator tests" -- and was handed
/// neither the lead's stated falsification conditions nor its rival mechanisms.
/// The hypothesis statement itself was not in the prompt either; the only
/// `"statement"` in 88 KB was the output template's own placeholder.
///
/// MEASURED ON cycle-g-v91, 2026-09-13: `falsification` appears nineteen times
/// in a gatekeeper prompt, `rival_mechanism` zero times, and
/// `candidate_hypothesis_ranking` zero. The director had by then written all
/// three into the hypothesis artifact. A judge asked whether the falsification
/// is adequate, and never shown it, is scoring its own ignorance -- novelty 58
/// and technical_quality 34 were the honest output of that.
///
/// Read from the artifact rather than restated, so it is whatever the director
/// actually decided, and empty when there is no lead yet.
pub(crate) fn current_lead_under_review(paths: &AppPaths, cycle_id: &str) -> Value {
    let path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let Ok(hypothesis) = read_json(&path) else {
        return Value::Null;
    };
    let selected = hypothesis
        .get("selected_hypothesis")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| hypothesis.clone());
    let pick = |key: &str| {
        selected
            .get(key)
            .cloned()
            .or_else(|| hypothesis.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    json!({
        "statement": pick("statement"),
        "answers_research_problem": pick("answers_research_problem"),
        "primary_family": pick("primary_family"),
        // The three the prompt asks about and never carried.
        "falsification_conditions": pick("falsification_conditions"),
        "rival_mechanisms": pick("rival_mechanisms"),
        "candidate_hypothesis_ranking": pick("candidate_hypothesis_ranking"),
        "supporting_literature_edges": pick("supporting_literature_edges"),
        "supporting_data_graph_edges": pick("supporting_data_graph_edges"),
        "reference_methods_baseline": pick("reference_methods_baseline"),
        "trend_positioning": pick("trend_positioning"),
        "source_artifact": path.display().to_string(),
        "generated_by": hypothesis.get("generated_by").cloned().unwrap_or(Value::Null),
        "note": "The lead as its author stated it. Score novelty and technical_quality against THESE terms: an inadequate falsification condition or an unanswered rival mechanism is a finding about the lead, and their absence here means the director did not supply them -- which is itself the finding.",
    })
}

pub fn followup_task_markdown(
    cycle_id: &str,
    objective: &str,
    role: &str,
    source_brief_id: &str,
    description: &str,
    hypotheses: &[String],
) -> String {
    let mut lines = vec![
        format!("# Autonomous Follow-up Task for {role}"),
        String::new(),
        format!("- cycle_id: {cycle_id}"),
        format!("- objective: {objective}"),
        format!("- source_brief_id: {source_brief_id}"),
        format!("- role: {role}"),
        format!("- task: {description}"),
    ];
    // Phase 1 data fetcher (docs/data-fetcher-2026-04-28.md §E):
    // analyst followups (pivot, brainstorm, recovery, …) verify the
    // lab-director hypothesis on the same code path as the base
    // analyst, so they need the same `pick_dataset_for_hypothesis`
    // directive. Without this, followup-analyst lanes silently fall
    // back to no-dataset analysis and the
    // `dataset_root`/`column_mapping` handoff fields stay null even
    // when cycle-scoped fetched bundles are available.
    if role == "analyst" {
        // Prior work before design. The `reference` stage that opens the JS
        // analysis_loop never reaches a follow-up lane, and every analyst lane
        // in a running cycle is one — see reference_first_directive.
        lines.push(crate::labdirector::policy::reference_first_directive(cycle_id));
        lines.push(crate::labdirector::policy::pick_dataset_for_hypothesis_directive().to_string());
        lines.push(crate::labdirector::policy::open_source_analysis_agent_directive().to_string());
        // The design discipline the JS analyst plan had been carrying to nobody
        // -- see analysis_design_discipline_directive.
        lines.push(
            crate::labdirector::policy::analysis_design_discipline_directive().to_string(),
        );
        lines.push(crate::labdirector::policy::analyst_research_notes_directive(cycle_id));
        // Follow-up analysts author most of this cycle's blueprints but never
        // received the JS-side validation profile (blueprint_rules +
        // column_mapping_contract), so those authoring rules were silently
        // undelivered — see blueprint_authoring_directive.
        lines.push(crate::labdirector::policy::blueprint_authoring_directive(
            objective,
        ));
        // Report which claim elements the authored blueprint actually establishes,
        // so an over-scoped lead is caught here and not at the gate — see
        // claim_coverage_directive.
        lines.push(crate::labdirector::policy::claim_coverage_directive().to_string());
        // Feasibility cannot be judged against an undisclosed wall clock — see
        // compute_budget_directive.
        lines.push(crate::labdirector::policy::compute_budget_directive().to_string());
    }
    if role == "author" {
        // Every author lane in a running cycle is a follow-up, and this path
        // carried no author directive at all -- only the generic header and the
        // action description. See author_claim_discipline_directive.
        lines.push(
            crate::labdirector::policy::author_claim_discipline_directive().to_string(),
        );
    }
    if role == "engineer" {
        // The provisioning half of what the analyst directive used to carry --
        // see engineer_provisioning_directive.
        lines.push(crate::labdirector::policy::engineer_provisioning_directive(
            cycle_id,
        ));
        // An engineer sent to run one of the LabDirector's simulation orders (the
        // brief names it, and the role plan carries it in planner_metadata).
        if source_brief_id.starts_with("simulation-")
            || description.contains("simulation order")
        {
            lines.push(crate::labdirector::policy::simulation_execution_directive(
                cycle_id,
            ));
        }
        // An engineer sent to audit how a completed lane's result was produced.
        if source_brief_id.starts_with("execution-audit-") {
            lines.push(crate::labdirector::policy::engineer_execution_audit_directive(
                cycle_id,
            ));
        }
    }
    if role == "lab-director" {
        // Nothing downstream infers the family any more (see
        // lead_family_declaration_directive), so the director must declare it.
        lines.push(crate::labdirector::policy::lead_family_declaration_directive().to_string());
        // Scope the claim to the evidence the cycle can produce — see
        // claim_evidence_scope_directive.
        lines.push(crate::labdirector::policy::claim_evidence_scope_directive().to_string());
        // The field survey, which reached only the base lane until now. Novelty
        // is scored on whether a lead answers an open problem with a method the
        // field has not already proposed against it, so a director with no
        // survey is being asked to be novel against nothing.
        lines.push(crate::labdirector::policy::research_trend_survey_directive(cycle_id));
        // cycle-b-20260918, 2026-09-18: the owner assigned simulation
        // orchestration to the LabDirector; an analyst-declared request let the
        // analyst choose the experiment. See simulation_orders_directive.
        lines.push(crate::labdirector::policy::simulation_orders_directive(cycle_id));
        let lower_description = description.to_lowercase();
        let notes_write_forbidden = source_brief_id == "direct_researcher_instruction"
            || lower_description.contains("do not write or modify lab-director-research-notes")
            || lower_description.contains("do not write or modify research notes")
            || lower_description.contains("do not update research notes");
        if notes_write_forbidden {
            lines.push(format!(
                "- research_notes_write_policy: forbidden for this adjudication. You may read the existing LabDirector research notes at .research-lab/state/{cycle_id}-lab-director-research-notes.md and .research-lab/state/{cycle_id}-lab-director-research-notes.json as context, but do not write, modify, refresh, summarize into, or append to either research-notes file. Return the decision only in this lane's output/result JSON."
            ));
        } else {
            lines.push(lab_director_research_notes_directive(cycle_id));
        }
        lines.push(format!(
            "- kg_first_hypothesis_scope: make the research-wide decision from role_plan.planner_metadata.chronicle_decision_digest plus the LabDirector research notes. Do NOT read or inline the full KG artifacts, full state directory, review-map manifest tree, or full lane tree. If a specific evidence detail is missing, ask Chronicle for `.research-lab/state/{cycle_id}-chronicle-decision-digest.json` refresh or open exactly one named source_ref from the digest. If validation data is not materialized, still select a digest-supported hypothesis and set `validation_data_status=needs_materialization`; same-dataset baseline and executable materialization are validation-stage blockers, not hypothesis-stage prerequisites. Process stages are advisory safety rails; a LabDirector override requires a recorded `stage_gate_override` rationale, and a lane held on a `waiting-for-` dependency blocker is released by a recorded `dependency_gate_override` naming that exact blocker string with a rationale. Neither can override forbidden dataset reuse."
        ));
        // FIX-AD: fail-closed exception to the "materialization is a validation-
        // stage concern" rule above. "Not materialized yet" is deferrable;
        // "confirmed UNOBTAINABLE" is disqualifying at the hypothesis stage.
        lines.push(format!(
            "- dataset_materialization_failclosed_exception: the rule that deferred materialization to validation-stage applies ONLY while a dataset is plausibly obtainable. If the evidence shows a lead's declared dataset/accession has been REPEATEDLY ATTEMPTED AND CONFIRMED UNOBTAINABLE — e.g. scouts could not materialize it after multiple attempts and completed runners have been validating that lead on a MISMATCHED substitute dataset via dataset override (degraded, non-promotable results), or role_plan.planner_metadata / strategy-decision reports `scout_materialization_failclosed` for it — then that lead is DISQUALIFIED at the hypothesis stage: do NOT select it, do NOT uphold it, and do NOT keep requesting its materialization. You MUST replace it with a structurally distinct hypothesis family whose dataset is ALREADY materialized (one of the cycle's fetched data bundles). Upholding a confirmed-unobtainable lead is never valid — it can never reach robust cross-source validation."
        ));
        lines.push(format!(
            "- materialized_lead_binding_contract: a lead can only be gate-scored and validated once it is BOUND to a MATERIALIZED dataset (a fetched bundle listed in role_plan.planner_metadata.candidate_datasets). A lead with NO dataset_or_accession, or one whose dataset is not among the cycle's fetched bundles, gives the gate an EMPTY scope — it cannot be scored, validation cannot start, and promotion stays at zero no matter how long you wait. When fetched bundles already exist for THIS cycle, do NOT leave the lead dataset-less and do NOT keep deferring on a not-yet-materialized accession: BIND the lead now to one of the already-materialized datasets — pick the one whose data best supports your hypothesis using validation_promotion_ranking and candidate_datasets — and set `dataset_or_accession` (plus `selected_hypothesis.dataset_or_accession` and `identification_strategy.dataset_or_accession`) to that materialized accession. You choose WHICH materialized dataset and which hypothesis; the only requirement is that the lead resolves to a dataset that actually exists so the gate has something to evaluate. This is not a forbidden-dataset rule and does not change any gate threshold — it just ensures your chosen lead is evaluable."
        ));
        lines.push(
            crate::labdirector::policy::lab_director_hypothesis_gate_efficiency_directive()
                .to_string(),
        );
        lines.push("- gate_blocker_review_request_contract: If a gate blocker remains only because reviewer memory is stale, the claim has been narrowed, newer validation evidence resolves it, or a sharper blocker should replace it, do not silently drop it. Emit `gate_blocker_review_requests` with the exact blocker text, target_rubric, requested_action, rationale, and evidence_refs so an independent gatekeeper can adjudicate removal, downgrade, supersession, or continued blocking.".to_string());
        lines.push("- lab_director_chronicle_dialogue_contract: You may freely ask Chronicle for crucial missing clues before finalizing a decision. When an important paper, baseline, source_ref, confounder map, variable definition, or contradiction is missing, do not guess. Emit `decision_status=needs_chronicle_evidence` and `chronicle_requests` with precise questions, why each answer changes the decision, and the compact source scope Chronicle should inspect. After Chronicle responds, adjudicate the answer and either ask a sharper follow-up or issue the final keep/replace/restart decision.".to_string());
    }
    if role == "gatekeeper" {
        lines.push("- score_the_lead_as_its_author_stated_it: `role_plan.planner_metadata.current_lead_under_review` carries the hypothesis under review in the terms you are scoring it on -- its statement, its own falsification_conditions, its own rival_mechanisms, the candidates it passed over, and the literature and data edges it cites. Judge novelty and technical_quality against THOSE, not against a reconstruction from the graph. A falsification condition that could not distinguish the hypothesis from its rival is a finding; a rival mechanism the evidence does not rule out is a finding; and a field that is null means the director did not supply it, which is also a finding. Say which of the three you used.".to_string());
        lines.push("- blocker_adjudication_contract: If role_plan.planner_metadata.review_action.lab_director_blocker_review_requests or role_plan.lab_director_blocker_review_requests is present, adjudicate each challenged blocker independently. Return `blocker_adjudications` with decision `uphold`, `remove`, `resolved`, `superseded`, or `downgrade`; only remove/downgrade blockers supported by supplied evidence, current-scope mismatch, or a sharper replacement blocker.".to_string());
    }
    if role == "chronicle" {
        lines.push(chronicle_direct_corpus_interaction_directive(cycle_id));
        if source_brief_id.starts_with("followup-lab-director-")
            || description.contains("LabDirector asks")
            || description.contains("LabDirector requested")
        {
            lines.push("- lab_director_question_answer_contract: Answer LabDirector's specific evidence request, not a generic cycle summary. Search only compact cycle-scoped source_refs/artifacts needed for the question; return the key clue, source paths, contradictions, confidence, and what LabDirector should decide differently if the clue is confirmed or absent.".to_string());
        }
        if source_brief_id == "hypothesis-gate-chronicle-deliberation"
            || description.contains("Gatekeeper")
            || description.contains("gatekeeper")
        {
            lines.push("- chronicle_gate_deliberation_contract: do not merely summarize the review. Stage an explicit scientific debate for LabDirector: reconstruct the Gatekeeper objections, compare at least three mechanism families for the current lead/dataset context, list evidence for/against each, identify missing same-dataset baseline facts, define variables/confounders required for a decisive analysis, and end with decision-ready options (keep incumbent, mechanistic pivot, or re-query/search) plus the evidence that would falsify each option.".to_string());
        }
    }
    if role == "lab-director" && source_brief_id == "strategy_pivot" {
        lines.push("- pivot_hypothesis_replacement_contract: the current lead has failed the gate or produced no supported claim delta. Do not patch the same weak claim unless the review evidence says it is salvageable. First read role_plan.previous_review_context and role_plan.chronicle_research_context, identify the decisive limitations, then either demote the incumbent or replace it with a procedure-distinct, falsifiable hypothesis family. Return JSON with `requery_decision`, `replacement_hypotheses`, `rationale`, `validation_changes`, `required_validation_before_promotion`, and `next_actions`; each replacement must name its typed evidence route, executable procedure, measured quantity, rival mechanism, strongest simple baseline, and falsification criterion.".to_string());
    }
    if role == "lab-director"
        && (source_brief_id.contains("gate")
            || source_brief_id == "strategy_pivot"
            || description.contains("gate")
            || description.contains("Gatekeeper"))
    {
        lines.push("- gatekeeper_rejection_response_contract: answer the latest Gatekeeper reject/defer explicitly before any validation or document promotion. Compare at least five executable procedure signatures, name the closest verified primary prior art and strongest simple baseline for each viable candidate, and state the exact novelty delta, estimand, boundary, falsification condition, evidence route, and transportability limit. Do not revive stale next_actions that target a superseded artifact or hypothesis.".to_string());
        lines.push("- pivot_patience_contract: continue an incumbent only while a named blocker can be closed without changing its mechanism or executed procedure. Close concrete missing evidence and reporting artifacts on the same lead, but do not optimize a self-score or repeat the same experiment under new wording. Pivot when the closest-prior-art comparison removes the novelty delta, a decisive result falsifies the mechanism, the required evidence route is unavailable, or the strongest simple baseline matches it within the prespecified useful-effect margin. In `rationale`, state which blocker changed, cite the evidence, and keep unresolved scientific scores unknown rather than inflating them.".to_string());
    }
    if !hypotheses.is_empty() {
        lines.push(String::new());
        lines.push("## Assigned Hypotheses".to_string());
        for hypothesis in hypotheses {
            lines.push(format!("- {hypothesis}"));
        }
    }
    lines.join("\n")
}

fn search_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    for key in [
        "question",
        "statement",
        "label",
        "name",
        "field",
        "domain",
        "primary_family",
    ] {
        if let Some(text) = value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn push_unique_search_label(labels: &mut Vec<String>, value: String) {
    if value.trim().is_empty()
        || labels
            .iter()
            .any(|item| item.eq_ignore_ascii_case(value.trim()))
    {
        return;
    }
    labels.push(value.trim().to_string());
}

fn search_labels_at(value: &Value, key: &str, labels: &mut Vec<String>) {
    let Some(candidate) = value.get(key) else {
        return;
    };
    if let Some(items) = candidate.as_array() {
        for item in items {
            if let Some(label) = search_text(Some(item)) {
                push_unique_search_label(labels, label);
            }
        }
    } else if let Some(label) = search_text(Some(candidate)) {
        push_unique_search_label(labels, label);
    }
}

pub(crate) fn build_native_scout_search_agent_contract(
    objective: &str,
    description: &str,
    hypotheses: &[String],
    candidate_hypotheses: &[Value],
    planner_metadata: &Value,
) -> Value {
    let mut hypothesis_entries = Vec::new();
    let mut seen_statements: Vec<String> = Vec::new();
    for (index, statement) in hypotheses.iter().enumerate() {
        if statement.trim().is_empty()
            || seen_statements
                .iter()
                .any(|item| item.eq_ignore_ascii_case(statement.trim()))
        {
            continue;
        }
        seen_statements.push(statement.trim().to_string());
        hypothesis_entries.push(json!({
            "hypothesis_id": format!("assigned-hypothesis-{}", index + 1),
            "statement": statement.trim(),
            "status": "candidate"
        }));
    }
    for (index, candidate) in candidate_hypotheses.iter().enumerate() {
        let Some(statement) = candidate
            .get("statement")
            .and_then(Value::as_str)
            .or_else(|| candidate.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if seen_statements
            .iter()
            .any(|item| item.eq_ignore_ascii_case(statement))
        {
            continue;
        }
        seen_statements.push(statement.to_string());
        let candidate_id = candidate
            .get("hypothesis_id")
            .and_then(Value::as_str)
            .or_else(|| candidate.get("id").and_then(Value::as_str))
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("candidate-hypothesis-{}", index + 1));
        hypothesis_entries.push(json!({
            "hypothesis_id": candidate_id,
            "statement": statement,
            "status": candidate.get("status").cloned().unwrap_or_else(|| json!("candidate"))
        }));
    }
    if hypothesis_entries.is_empty() {
        hypothesis_entries.push(json!({
            "hypothesis_id": "objective-under-specification",
            "statement": objective,
            "status": "pending_problem_formulation"
        }));
    }
    hypothesis_entries.truncate(8);

    let formulated_problem = planner_metadata
        .get("research_problem")
        .and_then(|value| search_text(Some(value)))
        .or_else(|| {
            planner_metadata
                .get("research_problem_question")
                .and_then(|value| search_text(Some(value)))
        });
    // Mirrors the JavaScript contract: a raw objective is marked as such, so the
    // journal states its own question instead of copying the objective.
    let research_problem_source = if formulated_problem.is_some() {
        "planning_context"
    } else {
        "objective_text"
    };
    let research_problem = formulated_problem.unwrap_or_else(|| objective.trim().to_string());

    let mut facet_labels = Vec::new();
    for key in [
        "research_scopes",
        "research_scope",
        "search_scopes",
        "required_field_facets",
        "field_facets",
        "focus_fields",
    ] {
        search_labels_at(planner_metadata, key, &mut facet_labels);
    }
    for candidate in candidate_hypotheses {
        for key in ["primary_family", "family", "field", "domain", "discipline"] {
            search_labels_at(candidate, key, &mut facet_labels);
        }
    }
    let facets_were_explicit = !facet_labels.is_empty();
    if facet_labels.is_empty() {
        let concise_objective: String = objective.chars().take(240).collect();
        push_unique_search_label(
            &mut facet_labels,
            format!("objective-defined field scope: {concise_objective}"),
        );
    }
    facet_labels.truncate(8);
    let hypothesis_ids: Vec<Value> = hypothesis_entries
        .iter()
        .filter_map(|item| item.get("hypothesis_id").cloned())
        .collect();
    let facets: Vec<Value> = facet_labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            json!({
                "facet_id": format!("field-{}", index + 1),
                "label": label,
                "status": if facets_were_explicit { "pending_evidence" } else { "pending_scope_definition" },
                "hypothesis_ids": hypothesis_ids.clone()
            })
        })
        .collect();

    json!({
        "contract_version": "adaptive-search-agent-v1",
        "agent_kind": "hypothesis_conditioned_literature_agent",
        "research_problem": research_problem,
        "research_problem_source": research_problem_source,
        "task_instruction": description,
        "hypotheses": hypothesis_entries,
        "required_field_facets": facets,
        "required_inquiry_intents": [
            "hypothesis_direct",
            "closest_prior_art",
            "backward_citation",
            "forward_citation",
            "adversarial"
        ],
        "journal_schema": {
            "version": "adaptive-search-agent-journal-v1",
            "required_fields": ["research_problem", "search_rounds", "coverage", "synthesis"],
            "completion_required_fields": [
                "coverage.unanswered_questions", "synthesis.next_search_decisions",
                "synthesis.saturation.termination_reason"
            ],
            // An open question or coverage gap may be a string (a literature
            // question) or {question, kind, reason, searched_in_round_ids}; only
            // `literature` items keep the search open (src/agents/scout/search_agent.js).
            "open_item_kinds": ["literature", "experiment", "host_capability", "literature_exhausted"],
            "round_required_fields": [
                "round_id", "inquiry_intent", "hypothesis_ids", "facet_ids",
                "question", "reason", "query", "source", "parent_paper_ids",
                "result_ids", "reading_decisions", "evidence_accepted_ids"
            ],
            "reading_decision_required_fields": [
                "paper_id", "abstract_read_in_full", "decision", "hypothesis_ids",
                "facet_ids", "study_evidence", "method_evidence", "outcome_evidence",
                "limitations", "reason"
            ]
        },
        "round_schema": {
            "required_fields": [
                "round_id", "inquiry_intent", "question", "reason", "query",
                "source", "parent_paper_ids", "result_ids", "reading_decisions",
                "evidence_accepted_ids"
            ],
            "allowed_inquiry_intents": [
                "hypothesis_direct", "closest_prior_art", "backward_citation",
                "forward_citation", "adversarial", "cross_field_bridge"
            ],
            "reading_decision_schema": [
                "paper_id", "abstract_read_in_full", "decision", "hypothesis_ids",
                "facet_ids", "reason"
            ],
            "cross_field_bridge_schema": [
                "classification", "applicability_reason", "changed_execution_element"
            ],
            "rule": "A result is a candidate only. Accepted evidence requires a directly_relevant full-abstract reading decision bound to a named hypothesis and field facet."
        },
        "source_diversity_policy": {
            "minimum_distinct_source_types": 2,
            "requirement": "Use sources appropriate to the objective and record each inquiry source; source counts and result counts cannot establish coverage."
        },
        "query_evolution_policy": {
            "initial_inquiries": 2,
            "rule": "After reading each round, derive the next query from a specific limitation, contradiction, missing comparator, or citation edge; fixed keyword-list execution is invalid.",
            "citation_parent_ids_required": true,
            "adversarial_inquiry_required": true
        },
        "evidence_policy": {
            "full_abstract_required": true,
            "accepted_ids_must_be_screened": true,
            "claim_binding_required": true,
            "pending_or_excluded_is_not_evidence": true
        },
        "coverage_policy": {
            "required_facet_evidence": "Each objective-specific field facet needs screened evidence bound to a named hypothesis or an explicit unresolved gap.",
            "no_fixed_paper_minimum": true,
            "no_count_based_coverage": true,
            "no_count_based_completion": true,
            "saturation_rule": "State which decision-critical gap stopped changing across genuinely different inquiries; counts alone never establish saturation."
        },
        "completion_policy": {
            "finalization_is_screening_only": true,
            "forbid_search_complete_when": [
                "search_rounds_empty", "required_inquiry_intent_missing",
                "required_field_facet_unresolved", "accepted_evidence_unread",
                "next_search_decision_unresolved", "field_scope_still_pending_definition"
            ],
            "incomplete_status": "insufficient_corpus"
        },
        "outputs": {
            "journal_path": "search-agent-journal.json",
            "synthesis_path": "search-agent-synthesis.json",
            "synthesis_required_fields": [
                "claim_paper_links", "closest_prior_art", "next_search_decisions",
                "coverage_gaps", "saturation"
            ]
        }
    })
}

fn prior_astra_route_count(paths: &AppPaths, cycle_id: &str) -> usize {
    let lanes_root = cycle_lanes_root(paths, cycle_id);
    let Ok(entries) = read_dir(lanes_root) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(ToString::to_string))
        .filter_map(|lane_id| read_json(&lane_role_plan_path(paths, cycle_id, &lane_id)).ok())
        .filter(|plan| {
            plan.get("model_route")
                .and_then(|route| route.get("model"))
                .and_then(Value::as_str)
                == Some("gpt-6-astra")
        })
        .count()
}

pub(crate) fn write_followup_role_plan(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    role: &str,
    assigned_model: &str,
    objective: &str,
    source_brief_id: &str,
    description: &str,
    action_type: &str,
    hypotheses: &[String],
    candidate_hypotheses: &[Value],
    schema_quality: Option<&Value>,
    reasoning_graph: Option<&Value>,
    data_graph: Option<&Value>,
    open_validation_gaps: &[Value],
    planner_metadata: Value,
) -> Result<PathBuf> {
    let dataset_selection = if role == "lab-runner" {
        latest_dataset_selection(paths, cycle_id)?
    } else {
        None
    };
    let role_plan_path = lane_role_plan_path(paths, cycle_id, lane_id);
    let mut planner_metadata = if planner_metadata.is_object() {
        planner_metadata
    } else {
        json!({})
    };
    let requested_action_type = action_type;
    let approved_scholarly_data_followup = role == "scout"
        && action_type == "data_acquisition_followup"
        && approved_scholarly_metadata_policy(
            std::env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY")
                .ok()
                .as_deref(),
        );
    let action_type = effective_scout_followup_action(
        role,
        action_type,
        std::env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY")
            .ok()
            .as_deref(),
    );
    if approved_scholarly_data_followup {
        planner_metadata["requested_action_type"] = json!(requested_action_type);
        planner_metadata["approved_scholarly_network_policy"] =
            json!(APPROVED_SCHOLARLY_NETWORK_POLICY);
        planner_metadata["forbid_external_dataset_downloads"] = json!(true);
    }
    if role == "lab-director" {
        let notes_write_forbidden = planner_metadata
            .get("notes_write_policy")
            .and_then(Value::as_str)
            .map(|policy| policy.contains("forbid"))
            .unwrap_or(false)
            || source_brief_id == "direct_researcher_instruction"
            || description
                .to_lowercase()
                .contains("do not write or modify lab-director-research-notes");
        planner_metadata["research_notes_contract"] =
            lab_director_research_notes_contract(paths, cycle_id);
        if notes_write_forbidden {
            planner_metadata["research_notes_contract"]["must_update_before_completion"] =
                json!(false);
            planner_metadata["research_notes_contract"]["write_policy"] =
                json!("forbidden_for_this_adjudication");
            planner_metadata["research_notes_contract"]["decision_location"] =
                json!("lane_output_and_result_json_only");
        }
        planner_metadata["chronicle_decision_digest"] =
            compact_chronicle_decision_digest(paths, cycle_id);
        // For a computer-graphics objective the gatekeeper-rejection response
        // One wording, not two. This branched on a domain label into a rendering
        // vocabulary or an omics one, and the second branch was the default: a
        // robotics, compiler or economics cycle was told to bound "subtype,
        // purity, stromal abundance, sampling-region, batch" and offered
        // antigen-presentation mechanisms as its examples. Stripping both
        // vocabularies leaves the same four requirements, which is the evidence
        // that the label was never carrying anything but wording.
        let same_dataset_baseline_emit =
            "name the published baseline that was evaluated on the same inputs, the readout it reported, and the quantitative delta being claimed against it";
        let executable_design_emit =
            "list the compared methods or arms, the inputs they run on, the primary metric and how it is computed against a reference, the cost or budget metric, the setting the comparison sweeps, and the negative-control or falsification tests";
        let confounder_plan_emit =
            "state what is held fixed across the compared arms, what could still differ between them without being the mechanism you are claiming, and how each of those is measured or bounded";
        // Examples are the strongest way to smuggle a field back in, so there
        // are none: the shape is stated instead, and the candidates come from
        // the cycle's own retrieved literature.
        let mechanism_family_examples = json!([
            "each family must name the MECHANISM it claims, in the vocabulary of this objective's own field, drawn from the retrieved literature rather than from any list supplied here"
        ]);
        planner_metadata["gatekeeper_rejection_response_contract"] = json!({
            "required_when_gate_failed": true,
            "scope": "answer the latest Gatekeeper reject/defer before any runner, author, or document-stage promotion",
            "must_not_do": [
                "reuse stale prior LabDirector next_actions that target a blocked non-selected dataset",
                "keep the broad latent-state hypothesis unchanged without a written family competition and falsification rationale",
                "promote validation patches that do not bind real current-dataset variables to an explicit outcome/proxy"
            ],
            "must_emit": {
                "family_reranking": "rank at least three mechanism-level hypothesis families and explain why the winner beats the incumbent and rivals",
                "same_dataset_baseline": same_dataset_baseline_emit,
                "executable_design": executable_design_emit,
                "confounder_plan": confounder_plan_emit,
                "transportability_plan": "name an independent external dataset if one is materialized, otherwise specify transportability/sensitivity logic and what remains blocked"
            },
            "mechanism_family_examples": mechanism_family_examples
        });
        planner_metadata["lab_director_chronicle_dialogue_contract"] = json!({
            "purpose": "LabDirector may request targeted Chronicle evidence during decision-making when a crucial clue is missing.",
            "lab_director_may_emit": {
                "decision_status": "needs_chronicle_evidence",
                "chronicle_requests": [{
                    "question": "precise evidence question Chronicle should answer",
                    "why_needed_for_decision": "which keep/replace/restart decision this could change",
                    "source_scope": ["compact digest source_ref, paper, artifact, or named state file to inspect"],
                    "priority": "critical|high|medium"
                }]
            },
            "chronicle_response_policy": "Chronicle answers the requested clue with compact evidence and source paths; LabDirector then adjudicates and may ask another sharper question or finalize the decision.",
            "do_not": [
                "force LabDirector to decide when a material clue is missing",
                "treat Chronicle as a one-shot static memo only",
                "let Chronicle override LabDirector's final research-wide decision"
            ]
        });
        planner_metadata["kg_first_hypothesis_contract"] = json!({
            "required_order": "literature/data search -> KG generation -> hypothesis generation -> validation materialization/analysis",
            "gate_mode": "advisory_order_with_recorded_lab_director_override",
            "decision_digest_input": state_root(paths).join(format!("{cycle_id}-chronicle-decision-digest.json")),
            "bounded_read_policy": "Use Chronicle's compact decision digest plus lab-director research notes. Do not read the full KG, full state directory, or enumerate the full .research-lab/lanes tree. If evidence is missing, ask Chronicle for a refreshed digest or open exactly one named source_ref.",
            "forbidden_context_inputs": ["full_literature_graph_inline", "full_data_graph_inline", "full_lane_tree", "unbounded_state_directory_dump"],
            "lab_director_authority": "Process stages are recommendations and safety rails. LabDirector may override an advisory gate only by recording a stage_gate_override with rationale; a dependency blocker holding a lane (any reason beginning `waiting-for-`) is released the same way, by recording a `dependency_gate_override` that names that exact blocker string, sets approved=true, and gives a rationale -- a blanket or wildcard target releases nothing. Hard constraints such as forbidden dataset reuse remain non-overridable by either.",
            "hypothesis_stage": {
                "requires_materialized_validation_bundle": false,
                "forbidden_dataset_accessions": effective_forbidden_dataset_terms(paths, cycle_id, objective),
                "allowed_dataset_node_policy": "candidate dataset nodes with metadata.materialized=false are valid for hypothesis selection when forbidden_reuse is not true"
            },
            "validation_stage": {
                "materialization_required_before_analysis": true,
                "same_dataset_baseline_required_before_analysis": true
            }
        });
        planner_metadata["hypothesis_gate_efficiency_mandate"] = json!({
            "primary_goal": "pass the independent hypothesis gate with the minimum valid time and token spend",
            "triage_order": [
                "read current hypothesis-gate blockers",
                "map each blocker to the smallest missing artifact or reviewer action",
                "reuse existing validation, negative-control, sensitivity, external-validation failed-attempt, promotion, and gate-review artifacts when scientifically applicable",
                "spawn only the next role needed to close the blocker"
            ],
            "avoid": [
                "broad repeated scout searches after failed-attempt evidence already closes external validation",
                "new LabDirector requery loops when a targeted gatekeeper/rubric review is the missing action",
                "runner reruns unless the latest blocker requires new execution evidence",
                "hypothesis replacement unless latest scientific review rejects the current claim"
            ],
            "targeted_gatekeeper_shortcut": "If the remaining blocker is stale or missing technical_quality or strobe_reporting_completeness for the current hypothesis, request the smallest targeted gatekeeper review rather than opening new discovery or analysis branches.",
            "gate_blocker_review_request_policy": {
                "allowed": true,
                "purpose": "ask an independent gatekeeper to reconsider, remove, downgrade, mark resolved, or supersede an unresolved blocker when LabDirector has concrete evidence that it is stale, mis-scoped, or resolved",
                "must_emit": ["gate_blocker_review_requests"],
                "must_not": "silently remove reviewer objections without independent gatekeeper adjudication"
            },
            "quality_guardrail": "Do not lower scientific standards; remove wasted exploration and duplicate attempts only."
        });
        if let Some(existing_notes) = lab_director_existing_research_notes_context(paths, cycle_id)?
        {
            planner_metadata["research_notes_context"] = existing_notes;
        }
        if let Some(deliberation) = latest_completed_chronicle_gate_deliberation(paths, cycle_id) {
            planner_metadata["chronicle_gate_deliberation_context"] =
                compact_deliberation_for_prompt(&deliberation);
        }
        planner_metadata["chronicle_evidence_responses"] =
            completed_chronicle_evidence_context(paths, cycle_id);
    }
    if role == "chronicle" {
        planner_metadata["direct_corpus_interaction_contract"] =
            chronicle_direct_corpus_interaction_contract(paths, cycle_id);
        // Asked of every dispatched chronicle lane, not just the base one. See
        // the contract's own note: 0 of 100 follow-up lanes on v89 carried it.
        planner_metadata["literature_relevance_review"] =
            chronicle_literature_relevance_contract(paths, cycle_id);
        planner_metadata["lab_director_decision_digest_contract"] = json!({
            "required": true,
            "path": state_root(paths).join(format!("{cycle_id}-chronicle-decision-digest.json")),
            "audience": "lab-director",
            "purpose": "Give LabDirector decision-ready options, blockers, tradeoffs, and source_refs without dumping full KG or full lane context.",
            "max_inline_bytes": 12_000,
            "must_include": [
                "current_question",
                "candidate_decisions",
                "recommended_default",
                "key_evidence_edges_compact",
                "candidate_datasets_compact",
                "active_blockers",
                "targeted_source_refs"
            ],
            "must_not_include": ["full KG", "full lane list", "raw result dumps", "unbounded tool output"]
        });
    }
    if role == "lab-runner" {
        planner_metadata["runner_execution_contract"] = json!({
            "analysis_protocol_required": true,
            "runner_execution_report_required": true,
            "post_run_review_required": true,
            "role_boundary": {
                "lab_runner": "execute the Analyst-authored protocol only; do not author new scientific conclusions or silently change the analysis plan",
                "analyst": "owns scientific protocol design and post-run interpretation",
                "lab_director": "owns final research decision after Analyst post-run interpretation"
            },
            "must_emit_or_preserve": [
                "analyst_handoff_path",
                "validation_summary",
                "handoff_check_resolutions",
                "quality_gates",
                "blueprint_executions",
                "external_agent_runs",
                "protocol_deviations"
            ],
            "gate_policy": "runner completion alone never unlocks gate review; Analyst must complete runner_result_interpretation_followup or LabDirector must adjudicate degraded execution"
        });
    }
    if role == "analyst"
        && matches!(
            action_type,
            "methods_followup"
                | "labdirector_comparator_validation_followup"
                | "runner_result_interpretation_followup"
                | "external_validation_analysis_followup"
        )
    {
        planner_metadata["analysis_protocol_contract"] = json!({
            "analysis_protocol_required": action_type != "runner_result_interpretation_followup",
            "post_run_review_required": true,
            "must_define_before_runner": [
                "hypothesis_id_or_statement",
                "estimand",
                "exposure_variables",
                "outcome_or_proxy",
                "covariates",
                "comparator_models",
                "negative_controls",
                "falsification_criteria",
                "support_reject_downscope_rules",
                "required_runner_artifacts"
            ],
            "post_run_review_required_fields": [
                "lab_director_validation_report.hypothesis_decision",
                "lab_director_validation_report.effect_direction",
                "lab_director_validation_report.controls",
                "lab_director_validation_report.negative_controls",
                "lab_director_validation_report.confounder_assessment",
                "lab_director_validation_report.protocol_deviations",
                "lab_director_validation_report.failure_modes",
                "lab_director_validation_report.artifacts"
            ],
            "gate_policy": "LabDirector/Gatekeeper cannot consume LabRunner output until Analyst either emits a lab_director_validation_report or issues a revised executable handoff"
        });
    }
    if let Some(selection) = dataset_selection {
        if let Some(dataset_root) = selection.get("dataset_root") {
            planner_metadata["dataset_root"] = dataset_root.clone();
        }
        if let Some(mapping) = selection
            .get("selected_dataset_bundle")
            .and_then(|item| item.get("dataset_mapping"))
        {
            planner_metadata["dataset_mapping"] = mapping.clone();
        }
        if let Some(bundle) = selection.get("selected_dataset_bundle") {
            planner_metadata["selected_dataset_bundle"] = bundle.clone();
        }
        if let Some(candidates) = selection.get("dataset_candidates") {
            planner_metadata["dataset_candidates"] = candidates.clone();
        }
    }
    // Phase 1 data fetcher (docs/data-fetcher-2026-04-28.md §E):
    // surface every cycle-scoped bundle the scout fetched into
    // ``planner_metadata.candidate_datasets`` so the analyst can match
    // hypothesis x_variable / y_variable against
    // ``candidate_datasets[].csvs[].columns`` and declare a
    // ``dataset_root`` + ``column_mapping`` in the handoff. Lab-runner
    // also receives the list for traceability even though its
    // ``dataset_root`` is normally fixed by the analyst handoff.
    if role == "analyst" || role == "lab-runner" {
        let forbidden_dataset_terms = effective_forbidden_dataset_terms(paths, cycle_id, objective);
        let candidate_datasets = cycle_fetched_data_bundles(paths, cycle_id)
            .into_iter()
            .filter(|bundle| {
                !value_contains_forbidden_dataset_term(bundle, &forbidden_dataset_terms)
            })
            .collect::<Vec<_>>();
        if role == "analyst" {
            let reference_resources = cycle_reference_resources(paths, cycle_id);
            let agent_mandate = open_source_analysis_agent_mandate_for_context(
                objective,
                &candidate_datasets,
                &reference_resources,
            );
            // The same decision as the pre-launch refresh, made in the same
            // place. Both producers used to write `true` whenever a mandate
            // existed, which is a different claim from the mandate's own
            // `mandatory` -- see open_source_discovery_requirement.
            let (discovery_required, discovery_because) =
                crate::labdirector::policy::open_source_discovery_requirement(
                    &agent_mandate,
                    action_type.contains("runner_failure_recovery"),
                );
            planner_metadata["open_source_analysis_agent_mandate"] = agent_mandate;
            planner_metadata["require_open_source_analysis_agent_discovery"] = json!(discovery_required);
            planner_metadata["open_source_discovery_required_because"] = json!(discovery_because);
            planner_metadata["analyst_research_notes_contract"] = json!({
                "markdown_path": state_root(paths).join(format!("{cycle_id}-analyst-research-notes.md")),
                "json_path": state_root(paths).join(format!("{cycle_id}-analyst-research-notes.json")),
                "must_read_before_design": true,
                "must_preserve_core_reasoning": true,
                "must_update_after_material_validation_decision": true,
                "include_only": [
                    "current_validation_focus",
                    "analysis_reasoning_log",
                    "decision_critical_evidence_snapshot",
                    "open_methodological_blockers",
                    "rejected_or_deferred_designs",
                    "dataset_and_tool_context",
                    "falsification_criteria",
                    "next_actions",
                    "handoff_for_next_analyst"
                ],
                "exclude": [
                    "raw_lane_logs",
                    "full_table_previews",
                    "routine_status_counters",
                    "duplicate_blocker_dumps"
                ]
            });
            if !forbidden_dataset_terms.is_empty() {
                planner_metadata["forbidden_dataset_terms"] = json!(forbidden_dataset_terms);
            }
        }
        if !candidate_datasets.is_empty() {
            planner_metadata["candidate_datasets"] = Value::Array(candidate_datasets);
        }
    }
    if !candidate_hypotheses.is_empty() && role != "gatekeeper" {
        planner_metadata["candidate_hypotheses"] = Value::Array(candidate_hypotheses.to_vec());
    }
    if role != "gatekeeper" && role != "lab-director" {
        if let Some(schema_quality) = schema_quality {
            if !schema_quality.is_null() {
                planner_metadata["schema_quality"] = schema_quality.clone();
            }
        }
        if let Some(reasoning_graph) = reasoning_graph {
            if !reasoning_graph.is_null() {
                planner_metadata["reasoning_graph"] = reasoning_graph.clone();
            }
        }
        if let Some(data_graph) = data_graph {
            if !data_graph.is_null() {
                planner_metadata["data_graph"] = data_graph.clone();
            }
        }
    }
    // For analyst-role plans, stitch the two graphs into a single
    // ``knowledge_graph`` digest so the analyst can reason about exposures /
    // outcomes / mechanisms holistically when proposing derived indicators.
    // The two sub-graphs remain individually available for compatibility.
    if role == "analyst" {
        let reasoning_ref = reasoning_graph.cloned().unwrap_or(Value::Null);
        let data_ref = data_graph.cloned().unwrap_or(Value::Null);
        if !reasoning_ref.is_null() || !data_ref.is_null() {
            planner_metadata["knowledge_graph"] = json!({
                "reasoning_graph": reasoning_ref,
                "data_graph": data_ref,
                "usage_hint": "Use the reasoning_graph for paper/theory-derived relationships and the data_graph for empirical regularities already tested. Propose derived_indicators that resolve edges marked unresolved or contrast rival paths between the same exposure-outcome pair."
            });
        }
    }
    if !open_validation_gaps.is_empty() && role != "gatekeeper" {
        planner_metadata["open_validation_gaps"] =
            compact_open_validation_gaps(open_validation_gaps);
    }
    planner_metadata["hypothesis_generation_basis"] = if role == "lab-director" {
        json!("chronicle-decision-digest-first")
    } else {
        json!("reasoning-graph-and-data-graph-first")
    };
    planner_metadata["cross_paper_reasoning"] = json!({
        "goal_conditioned_retrieval": {
            "enabled": true,
            "objective_binding": "scientist-goal-and-preferences-first"
        },
        "structured_critique": {
            "dimensions": ["correctness", "novelty", "quality"],
            "deep_verification_mode": "assumption-tree"
        },
        "comparative_reasoning": {
            "ranking_mode": "pairwise-scientific-debate"
        },
        "similarity_aware_competition": {
            "enabled": true,
            "policy": "compare nearby hypotheses more often before selecting a lead"
        },
        "recombination": {
            "enabled": true,
            "policy": "combine compatible evidence fragments across papers into new hypothesis families"
        }
    });
    if planner_metadata.get("frontier_catalog").is_none() {
        planner_metadata["frontier_catalog"] = json!({
            "primary_variable_families": build_frontier_catalog(candidate_hypotheses),
        });
    }
    let mut focus_families = Value::Null;
    let mut focus_outcomes = Value::Null;
    let mut analysis_goals = Value::Null;
    let mut validation_profile = Value::Null;
    if role == "lab-runner" {
        let reasoning_claim_count = planner_metadata
            .get("reasoning_graph")
            .and_then(|item| item.get("claim_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let data_hypothesis_count = planner_metadata
            .get("data_graph")
            .and_then(|item| item.get("hypothesis_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let gap_statements = reasoning_gap_hypothesis_statements(open_validation_gaps);
        if !gap_statements.is_empty() {
            analysis_goals = json!(gap_statements);
        } else if reasoning_claim_count > 0 || data_hypothesis_count > 0 {
            analysis_goals = json!([
                format!(
                    "Use the reasoning graph to validate or close explicit claim/test gaps (claims={}, data_hypotheses={}).",
                    reasoning_claim_count, data_hypothesis_count
                ),
                "Prefer tests that strengthen data-grounded hypotheses before expanding literature-only variants.",
            ]);
        }
        if let Some(literature_signal) = latest_analyst_literature_signal(paths, cycle_id)? {
            if let Some(frontier_catalog) = literature_signal.get("frontier_catalog") {
                planner_metadata["frontier_catalog"] = frontier_catalog.clone();
            }
            if let Some(candidate_primary_families) =
                literature_signal.get("candidate_primary_families")
            {
                planner_metadata["candidate_primary_families"] = candidate_primary_families.clone();
            }
            let scenario_labels = scenario_labels_from_value(&literature_signal);
            let discovered_queries = discovered_queries_from_value(&literature_signal);
            if !scenario_labels.is_empty() {
                planner_metadata["hypothesis_scenarios"] = literature_signal
                    .get("hypothesis_scenarios")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                planner_metadata["scenario_labels"] = json!(scenario_labels.clone());
                focus_families =
                    Value::Array(focus_families_for_runner(&scenario_labels, action_type));
                if analysis_goals.is_null() {
                    analysis_goals = Value::Array(analysis_goals_for_runner(&scenario_labels));
                }
            }
            if !discovered_queries.is_empty() {
                planner_metadata["discovered_queries"] = json!(discovered_queries);
            }
        }
        if let Some(handoff_signal) = latest_analyst_handoff_signal(paths, cycle_id)? {
            if let Some(payload) = handoff_signal.get("payload") {
                planner_metadata["analyst_handoff"] = payload.clone();
            }
            if let Some(path) = handoff_signal.get("path") {
                planner_metadata["analyst_handoff_path"] = path.clone();
            }
        }
        focus_outcomes = Value::Array(focus_outcomes_for_runner(hypotheses));
        validation_profile = match action_type {
            "novelty_followup" => json!("scenario-validation"),
            "methods_followup" => json!("methods-deepening"),
            "data_acquisition_followup" => json!("data-expansion"),
            _ => json!("followup-validation"),
        };
    } else if role == "scout" && action_type == "data_acquisition_followup" {
        let target_rubric = planner_metadata
            .get("target_rubric")
            .and_then(Value::as_str)
            .unwrap_or("");
        let source_mode = planner_metadata
            .get("source_discovery_mode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let fetch_policy = planner_metadata
            .get("fetch_policy")
            .and_then(Value::as_str)
            .unwrap_or("");
        let materialization_fetch = target_rubric == "validation_materialization_gate"
            || source_brief_id == "stage-gate-validation-materialization"
            || matches!(
                source_mode,
                "external-validation-search" | "validation-materialization-fetch"
            )
            || matches!(fetch_policy, "fetch" | "materialize" | "required");
        if planner_metadata.get("source_discovery_mode").is_none() {
            planner_metadata["source_discovery_mode"] = if materialization_fetch {
                json!("validation-materialization-fetch")
            } else {
                json!("expand-open-data-search")
            };
        }
        if planner_metadata.get("source_selection_strategy").is_none() {
            planner_metadata["source_selection_strategy"] = if materialization_fetch {
                json!("validation-target-driven")
            } else {
                json!("semantic-target-driven")
            };
        }
        if materialization_fetch && planner_metadata.get("fetch_policy").is_none() {
            planner_metadata["fetch_policy"] = json!("fetch");
        }
        if materialization_fetch && planner_metadata.get("materialization_contract").is_none() {
            planner_metadata["materialization_contract"] = json!({
                "mode": "fetch_discovered_or_selected_accessions",
                "acceptance_criteria": [
                    "attempt bundle fetch/materialization for open accession-bearing candidates",
                    "write fetched bundles to the cycle-scoped data-bundles index",
                    "if no bundle is fetchable, write failed-attempt evidence with candidate URLs and provider errors"
                ],
                "do_not_return_discovery_only_when_accessions_exist": true
            });
        }
        if planner_metadata.get("dataset_discovery_contract").is_none() {
            planner_metadata["dataset_discovery_contract"] =
                dataset_discovery_contract(objective);
        }
        if planner_metadata.get("forbidden_dataset_terms").is_none() {
            planner_metadata["forbidden_dataset_terms"] = json!(effective_forbidden_dataset_terms(
                paths, cycle_id, objective
            ));
        }
        if planner_metadata.get("dataset_requirements").is_none() {
            planner_metadata["dataset_requirements"] = if materialization_fetch {
                json!([
                    "open accession-bearing source with direct downloadable matrix or table",
                    "sample metadata / phenotype schema sufficient for validation",
                    "materialized files indexed under .research-lab/datasets/<cycle_id>/ with manifest.json",
                ])
            } else {
                json!([
                    "open license or openly accessible source",
                    "analysis-ready tabular, matrix, text, image, graph, or other modality-appropriate structure when available",
                    "variables that strengthen hypothesis testing, confound control, subgroup coverage, or external validation",
                ])
            };
        }
        planner_metadata["duplicate_detection"] = json!("manifest-and-target-set");
        planner_metadata["provider_diversity_goal"] = json!("soft-preference-only");
    } else if role == "scout" && action_type == "external_validation_followup" {
        planner_metadata["source_discovery_mode"] = json!("external-validation-search");
        planner_metadata["source_selection_strategy"] = json!("validation-target-driven");
        planner_metadata["dataset_requirements"] = json!([
            "open license or openly accessible source",
            "sufficient variables, metadata, or measurement structure to challenge the promoted claim",
            "independent, orthogonal, subgroup-resolved, or stricter sensitivity validation potential",
        ]);
        planner_metadata["validation_plan"] = planner_metadata
            .get("review_action")
            .and_then(|item| item.get("validation_plan"))
            .cloned()
            .unwrap_or(Value::Null);
        planner_metadata["validation_objective"] = planner_metadata
            .get("review_action")
            .and_then(|item| item.get("validation_objective"))
            .cloned()
            .unwrap_or(Value::Null);
        planner_metadata["failed_attempt_policy"] = json!("write a concrete failed-attempt artifact if no accessible or mappable validation source exists");
    } else if role == "gatekeeper" || role == "lab-director" {
        // The lead in the terms it is scored on. See current_lead_under_review:
        // the prompt asked about falsification and rival explanations and
        // carried neither, so the judge was scoring its own reconstruction.
        planner_metadata["current_lead_under_review"] =
            current_lead_under_review(paths, cycle_id);
        planner_metadata["gate_review_mode"] = json!("independent-challenge");
        planner_metadata["lab_director_requery"] = json!(role == "lab-director");
        planner_metadata["challenge_questions"] = planner_metadata
            .get("challenge_questions")
            .cloned()
            .unwrap_or_else(|| json!([]));
    }
    let mut document_review_context = Value::Null;
    // What the author asked the programme to run. The director decides;
    // the analyst designs it only after that, so the manuscript never sets
    // the agenda. Only pending requests are carried -- a decided one is
    // history rather than a question.
    let pending_experiment_requests = {
        let ledger_path =
            state_root(paths).join(format!("{cycle_id}-experiment-requests.json"));
        if ledger_path.exists() {
            let ledger = read_json(&ledger_path)?;
            let rows = ledger
                .get("requests")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Value::Array(
                rows.into_iter()
                    .filter(|row| row.get("decision").map(Value::is_null).unwrap_or(true))
                    .collect(),
            )
        } else {
            json!([])
        }
    };
    // A sub-gate's blockers and actions are a SUBSET of the parent's -- measured
    // on cycle-g-v89: the three sub-gates contributed 4 + 5 + 1 blockers and the
    // parent held exactly those ten, with every sub-gate action byte-identical to
    // a parent one. Carrying them as indices keeps the attribution and drops the
    // second copy. Anything the parent does not hold is kept verbatim rather than
    // dropped, so this can only ever be lossless.
    fn subgate_reference(parent: Option<&Value>, sub: Option<&Value>) -> Value {
        let Some(sub_items) = sub.and_then(Value::as_array) else {
            return sub.cloned().unwrap_or_else(|| json!([]));
        };
        let parent_items = parent.and_then(Value::as_array).cloned().unwrap_or_default();
        let mut indices = Vec::new();
        let mut unmatched = Vec::new();
        for item in sub_items {
            match parent_items.iter().position(|candidate| candidate == item) {
                Some(index) => indices.push(json!(index)),
                None => unmatched.push(item.clone()),
            }
        }
        let mut reference = serde_json::Map::new();
        reference.insert("parent_indices".to_string(), Value::Array(indices));
        if !unmatched.is_empty() {
            reference.insert("not_in_parent".to_string(), Value::Array(unmatched));
        }
        Value::Object(reference)
    }

    // Replace a sub-gate's duplicated arrays with references into the parent.
    // `drop_keys` additionally removes payload owned by another role.
    fn project_subgate(gate: Option<&Value>, parent: &Value, drop_keys: &[&str]) -> Value {
        let Some(object) = gate.and_then(Value::as_object) else {
            return gate.cloned().unwrap_or(Value::Null);
        };
        let mut projected = serde_json::Map::new();
        for (key, value) in object {
            if drop_keys.contains(&key.as_str()) {
                continue;
            }
            match key.as_str() {
                "blockers" | "recommended_followup_actions" => {
                    projected.insert(
                        key.clone(),
                        subgate_reference(parent.get(key), Some(value)),
                    );
                }
                _ => {
                    projected.insert(key.clone(), value.clone());
                }
            }
        }
        Value::Object(projected)
    }

    let mut author_deliverables = Value::Null;
    let mut reference_verification_policy = Value::Null;
    if role == "author" || role == "illustrator" {
        let report_review_path = state_root(paths).join(format!("{cycle_id}-report-review.json"));
        let paper_review_path = state_root(paths).join(format!("{cycle_id}-paper-review.json"));
        let report_review = if report_review_path.exists() {
            read_json(&report_review_path)?
        } else {
            Value::Null
        };
        let paper_review = if paper_review_path.exists() {
            read_json(&paper_review_path)?
        } else {
            Value::Null
        };
        document_review_context = json!({
            "report": {
                "score": report_review.get("report_score").cloned().unwrap_or(Value::Null),
                "gate_passed": report_review.get("report_gate_passed").cloned().unwrap_or(Value::Null),
                "blockers": report_review.get("report_blockers").cloned().unwrap_or_else(|| json!([])),
                "comments": report_review
                    .get("report_review_comments")
                    .or_else(|| report_review.get("section_review_comments"))
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            },
            "paper": {
                "score": paper_review.get("paper_score").cloned().unwrap_or(Value::Null),
                "raw_score": paper_review.get("paper_raw_score").cloned().unwrap_or(Value::Null),
                "gate_passed": paper_review.get("paper_gate_passed").cloned().unwrap_or(Value::Null),
                "blockers": paper_review.get("paper_blockers").cloned().unwrap_or_else(|| json!([])),
                "paper_path": paper_review.get("paper_path").cloned().unwrap_or(Value::Null),
                "comments": paper_review
                    .get("paper_review_comments")
                    .or_else(|| paper_review.get("section_review_comments"))
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                "analysis_requests": paper_review.get("analysis_requests").cloned().unwrap_or_else(|| json!([])),
                "reference_requests": paper_review.get("reference_requests").cloned().unwrap_or_else(|| json!([])),
                "figure_production_requests": paper_review.get("figure_production_requests").cloned().unwrap_or_else(|| json!([])),
                // Projected below, once the parent arrays they index into exist.
                "author_gate": Value::Null,
                "figure_gate": Value::Null,
                "paper_integration_gate": Value::Null,
                "paper_gate_status": paper_review.get("paper_gate_status").cloned().unwrap_or(Value::Null),
                "recommended_followup_actions": paper_review.get("recommended_followup_actions").cloned().unwrap_or_else(|| json!([])),
            }
        });
        // The figure gate is the illustrator's (`owner_role: illustrator`) and was
        // being shipped whole into every author prompt: 31.4 KB of verification
        // requests carrying generator paths and verdict contracts, evidence
        // checks, a verdict store, and a production-request list identical to the
        // paper-level one in 65 of 65 lanes. The author keeps the gate's verdict
        // and the work assigned to it, not the illustrator's execution detail.
        const ILLUSTRATOR_EXECUTION_DETAIL: &[&str] = &[
            "figure_verification_requests",
            "figure_evidence_checks",
            "figure_verdict_store",
            "figure_production_requests",
        ];
        if let Some(paper) = document_review_context.get_mut("paper") {
            let parent = paper.clone();
            for gate in ["author_gate", "figure_gate", "paper_integration_gate"] {
                let source = paper_review.get(gate);
                let drop_keys: &[&str] = if gate == "figure_gate" && role == "author" {
                    ILLUSTRATOR_EXECUTION_DETAIL
                } else {
                    &[]
                };
                paper[gate] = project_subgate(source, &parent, drop_keys);
            }
        }
        planner_metadata["document_review_context"] = document_review_context.clone();
    }
    if role == "author" {
        author_deliverables = json!([
            "review-comment response map",
            "review-driven manuscript revisions",
            "additional analysis artifacts when papergate requests them",
            "verified high-impact reference refresh when papergate requests it",
            "updated paper JSON/Markdown/TeX artifacts that address papergate blockers",
        ]);
        reference_verification_policy = json!({
            "enabled": true,
            "trigger": "papergate reference_requests or reference-related blocker_reasons",
            "required_outputs": [
                "reference_verification_table.csv",
                "high_impact_reference_refresh.md",
                "updated_document_reference_context.json"
            ],
            "acceptance_criteria": [
                "verify every manuscript article reference through a resolvable persistent identifier -- a DOI, or the registry identifier this field uses -- or through the landing-page URL the record was retrieved from, naming the source that returned it",
                // A fixed list of journal names is wrong for every domain nobody
                // thought to enumerate -- these were biomedical venues reaching a
                // computer-graphics cycle twice per author prompt. The cycle
                // already derives its target venue and that venue's norms from
                // recorded evidence; cite those instead of a list written here.
                "prefer references from the venues the recorded venue standard identifies as this field's leading ones, judged by what the cycle actually recorded about the target venue rather than by any list of journal names",
                "keep the primary dataset citation separate from contextual high-impact article references",
                "do not cite unverifiable metadata-only references as authoritative support"
            ]
        });
        planner_metadata["reference_verification_policy"] = reference_verification_policy.clone();
    }
    let previous_review_context_raw = planner_metadata
        .get("previous_review_context")
        .cloned()
        .or_else(|| {
            planner_metadata
                .get("review_action")
                .and_then(|item| item.get("previous_review_context"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let chronicle_research_context_raw = planner_metadata
        .get("chronicle_research_context")
        .cloned()
        .or_else(|| {
            planner_metadata
                .get("review_action")
                .and_then(|item| item.get("chronicle_research_context"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let previous_review_context = if role == "gatekeeper" || role == "lab-director" {
        compact_json_context(&previous_review_context_raw, 256 * 1024)
    } else {
        Value::Null
    };
    let chronicle_research_context = if role == "lab-director" {
        compact_json_context(&chronicle_research_context_raw, 8 * 1024)
    } else if role == "gatekeeper" {
        compact_json_context(&chronicle_research_context_raw, 64 * 1024)
    } else {
        Value::Null
    };
    if role != "gatekeeper" {
        if planner_metadata.get("open_validation_gaps").is_some() {
            planner_metadata["open_validation_gaps"] =
                compact_open_validation_gaps(open_validation_gaps);
        }
        if planner_metadata.get("previous_review_context").is_some() {
            planner_metadata["previous_review_context"] =
                compact_json_context(&previous_review_context_raw, 64 * 1024);
        }
        if planner_metadata.get("chronicle_research_context").is_some() {
            planner_metadata["chronicle_research_context"] =
                compact_json_context(&chronicle_research_context_raw, 64 * 1024);
        }
        if role == "lab-director" {
            if let Some(object) = planner_metadata.as_object_mut() {
                object.remove("reasoning_graph");
                object.remove("data_graph");
                object.remove("knowledge_graph");
            }
        }
        if planner_metadata.get("reasoning_graph").is_some() {
            let reasoning_graph = planner_metadata
                .get("reasoning_graph")
                .cloned()
                .unwrap_or(Value::Null);
            planner_metadata["reasoning_graph"] =
                compact_json_context(&reasoning_graph, 256 * 1024);
        }
        if planner_metadata.get("data_graph").is_some() {
            let data_graph = planner_metadata
                .get("data_graph")
                .cloned()
                .unwrap_or(Value::Null);
            planner_metadata["data_graph"] = compact_json_context(&data_graph, 256 * 1024);
        }
        if planner_metadata.get("knowledge_graph").is_some() {
            let knowledge_graph = planner_metadata
                .get("knowledge_graph")
                .cloned()
                .unwrap_or(Value::Null);
            planner_metadata["knowledge_graph"] =
                compact_json_context(&knowledge_graph, 256 * 1024);
        }
        if let Some(object) = planner_metadata.as_object_mut() {
            for key in [
                "previous_review_context",
                "chronicle_research_context",
                "reasoning_graph",
                "data_graph",
                "knowledge_graph",
                "open_validation_gaps",
            ] {
                if let Some(value) = object.get(key).cloned() {
                    let approx = serde_json::to_vec(&value)
                        .map(|bytes| bytes.len())
                        .unwrap_or(0);
                    if approx > 512 * 1024 {
                        object.insert(key.to_string(), compact_json_context(&value, 64 * 1024));
                    }
                }
            }
        }
    }
    let open_source_analysis_agent_discovery = if role == "analyst" {
        planner_metadata
            .get("open_source_analysis_agent_mandate")
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let (impact_first_hypothesis_mandate, hypothesis_generation_policy) =
        promote_impact_first_hypothesis_mandate(role, &mut planner_metadata);
    let dataset_root = role_plan_dataset_root(&planner_metadata);
    let estimated_prompt_bytes = objective.len()
        + description.len()
        + hypotheses.iter().map(String::len).sum::<usize>()
        + serde_json::to_vec(candidate_hypotheses)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
        + serde_json::to_vec(&planner_metadata)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
    // Reserve Astra for no more than two high-value decisions in a cycle: one
    // candidate synthesis and one decisive adjudication. Routine follow-ups
    // remain on Luna/Terra/Sol even if their prose happens to mention novelty.
    let allow_astra = prior_astra_route_count(paths, cycle_id) < 2;
    let model_route = if approved_scholarly_data_followup {
        approved_scholarly_literature_scout_model_route()
    } else {
        crate::labdirector::policy::model_route_parameter(
            role,
            if assigned_model == "python-external-driver" {
                "external-driver"
            } else if assigned_model == "native-readonly-runtime" {
                "native-readonly"
            } else {
                "codex-agent"
            },
            action_type,
            description,
            estimated_prompt_bytes,
            candidate_hypotheses.len(),
            allow_astra,
            // No lead recorded yet: this is the cycle's opening direction.
            !state_root(paths)
                .join(format!("{cycle_id}-lab-director-hypothesis.json"))
                .exists(),
            assigned_model,
        )
    };
    let routed_assigned_model = model_route
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(assigned_model)
        .to_string();
    let mut scout_search_agent_contract = if role == "scout"
        && !matches!(
            action_type,
            // A deep read reads full texts; it runs no adaptive search (labdirector::sota_cards).
            // Nor does the deterministic frontier harvest (labdirector::frontier_harvest).
            "data_acquisition_followup"
                | "reasoning_data_scout"
                | crate::labdirector::SOTA_DEEP_READ_ACTION
                | crate::labdirector::FRONTIER_HARVEST_ACTION
        ) {
        planner_metadata
            .get("search_agent_contract")
            .cloned()
            .or_else(|| {
                planner_metadata
                    .get("review_action")
                    .and_then(|action| action.get("search_agent_contract"))
                    .cloned()
            })
            .or_else(|| {
                Some(build_native_scout_search_agent_contract(
                    objective,
                    description,
                    hypotheses,
                    candidate_hypotheses,
                    &planner_metadata,
                ))
            })
    } else {
        None
    };
    if approved_scholarly_data_followup {
        if let Some(contract) = scout_search_agent_contract.as_mut() {
            contract["inquiry_focus"] = approved_scholarly_dataset_inquiry_focus();
        }
    }
    // A role does the task it was given. With the decision only in a header
    // clause, thirteen consecutive lanes did their requery and said nothing about
    // the experiments; the task text named a contribution question and nothing
    // else. When requests are pending the task LEADS with the decision, and the
    // original task follows it.
    let task_leads_with_decision = {
        let pending_count = pending_experiment_requests
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0);
        // The DIRECTOR owns this decision and no other role can make it. Without
        // this gate the prefix went onto every lane with a pending request:
        // followup-runner-129 was handed "FIRST: decide the 2 experiment
        // request(s)" ahead of the execution it actually existed to run.
        if pending_count == 0 || role != "lab-director" {
            description.to_string()
        } else {
            format!(
                "FIRST: decide the {} experiment request(s) in `pending_experiment_requests` and return `experiment_request_decisions` with adopt or decline and a reason for each. This lane is not complete without them. THEN: {}",
                pending_count, description
            )
        }
    };

    let mut role_plan = json!({
        "lane_id": lane_id,
        "role": role,
        // First, because a decision buried 66 KB into a 204 KB prompt was
        // answered by none of seven consecutive lanes. Nothing was truncated --
        // the cap is 650 KB -- it was simply read past.
        "pending_experiment_requests": pending_experiment_requests,
        "source": "lab-director-followup",
        "assigned_model": routed_assigned_model,
        "model_route": model_route,
        "objective": objective,
        "source_brief_id": source_brief_id,
        "action_type": action_type,
        "requested_action_type": if approved_scholarly_data_followup { json!(requested_action_type) } else { Value::Null },
        "followup_description": task_leads_with_decision,
        "assigned_hypotheses": hypotheses,
        "focus_families": focus_families,
        "focus_outcomes": focus_outcomes,
        "analysis_goals": analysis_goals,
        "validation_profile": validation_profile,
        "deliverables": author_deliverables,
        "reference_verification_policy": reference_verification_policy,
        "document_review_context": document_review_context,
        "previous_review_context": previous_review_context,
        "chronicle_research_context": chronicle_research_context,
        "open_source_analysis_agent_discovery": open_source_analysis_agent_discovery,
        "impact_first_hypothesis_mandate": impact_first_hypothesis_mandate,
        "hypothesis_generation_policy": hypothesis_generation_policy,
        "planner_metadata": planner_metadata,
        "dataset_root": dataset_root,
    });
    if let Some(search_agent_contract) = scout_search_agent_contract {
        let lane_dir = role_plan_path.parent().unwrap_or_else(|| Path::new("."));
        role_plan["search_agent_contract"] = search_agent_contract;
        role_plan["search_agent_journal_path"] = json!(lane_dir.join("search-agent-journal.json"));
        role_plan["search_agent_synthesis_path"] =
            json!(lane_dir.join("search-agent-synthesis.json"));
    }
    if (role == "lab-director" && action_type == "gate_restart_followup")
        || (role == "analyst"
            && matches!(
                action_type,
                "methods_followup" | "pivot_followup" | "gate_restart_followup"
            ))
    {
        if let Some(gate_restart_policy) = gate_restart_policy_from_review(paths, cycle_id) {
            // Stored ONCE, at the top level. The whole role plan is rendered into
            // the prompt, so a second copy under planner_metadata is paid for in
            // input tokens twice and read by nothing — no code in this repo ever
            // reads `planner_metadata.gate_restart_policy`, and no instruction
            // text names it.
            //
            // MEASURED ON cycle-g-v79: the two copies were byte-identical in 76
            // of 179 lab-director lanes, at 122KB each in the largest, 0.9MB of
            // pure duplication across the cycle. LabDirector prompts are the
            // single biggest input line in the system (179 lanes, 303KB average,
            // 539KB peak, 53% of all prompt bytes).
            role_plan["gate_restart_policy"] = gate_restart_policy.clone();
            if role == "analyst" {
                role_plan["planner_metadata"]["gate_reject_scientific_validation_contract"] = json!({
                    "status": "mandatory_when_gate_verdict_reject",
                    "minimum_candidate_family_count": 3,
                    "incumbent_reuse_policy": "forbidden_as_primary; benchmark_or_negative_control_only",
                    "required_per_family_fields": [
                        "biological_mechanism",
                        "schema_backed_exposure_or_derived_indicator",
                        "schema_backed_outcome_or_proxy",
                        "confounders_or_batch_fields",
                        "negative_controls",
                        "falsification_criterion",
                        "failure_threshold_for_abandonment"
                    ],
                    "runner_handoff_gate": "do_not_emit_ready_for_runner unless every handoff_check maps to dataset columns or explicit derived indicators and includes null/negative-control logic",
                    "gate_review_path": gate_restart_policy.get("gate_review_path").cloned().unwrap_or(Value::Null),
                    "gate_score": gate_restart_policy.get("gate_score").cloned().unwrap_or(Value::Null),
                    "gate_verdict": gate_restart_policy.get("gate_verdict").cloned().unwrap_or(Value::Null),
                    "review_comment_manifest": gate_restart_policy.get("review_comment_manifest").cloned().unwrap_or(Value::Null)
                });
            }
        }
    }
    attach_lab_director_context_controls(paths, cycle_id, &mut role_plan)?;
    write_json(&role_plan_path, &role_plan)?;
    // FIX-PROV (causal stamping, foundation for message-bound provenance): record a minimal causal
    // envelope so a faithful happens-before graph can be built. The existing lane data records
    // review->decision edges (lab_director_response_lane_id) but NOT decision->decision lineage, so a
    // reconstructed closure collapses to {active} (shadow audit). Parent = the lead decision lane that
    // is CURRENT at this lane's creation (lab-director-hypothesis.json generated_by): successive
    // decisions chain, and every follow-up points at the decision under which it was spawned.
    // created_at is the logical clock. Best-effort: never fail lane creation on a stamping error.
    {
        // generated_by is normally the lead decision lane id, but a harness realignment (FIX-C) sets
        // it to a non-lane marker; in that case fall back to the newest lab-director lane so the
        // decision lineage stays connected (otherwise the causal closure collapses to {active}).
        let lane_like = |value: &str| {
            value.starts_with("followup-")
                && value
                    .rsplit('-')
                    .next()
                    .map(|tail| !tail.is_empty() && tail.chars().all(|ch| ch.is_ascii_digit()))
                    .unwrap_or(false)
        };
        let parent_message_id =
            read_json(&state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json")))
                .ok()
                .and_then(|hypothesis| {
                    hypothesis
                        .get("generated_by")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .filter(|parent| parent != lane_id && lane_like(parent))
                .or_else(|| {
                    let mut best: Option<(u64, String)> = None;
                    if let Ok(entries) = read_dir(cycle_lanes_root(paths, cycle_id)) {
                        for entry in entries.flatten() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if name == lane_id || !name.starts_with("followup-lab-director-") {
                                continue;
                            }
                            if let Some(num) = name
                                .rsplit('-')
                                .next()
                                .and_then(|tail| tail.parse::<u64>().ok())
                            {
                                if best.as_ref().map(|(b, _)| num > *b).unwrap_or(true) {
                                    best = Some((num, name));
                                }
                            }
                        }
                    }
                    best.map(|(_, name)| name)
                });
        let parents = parent_message_id
            .as_ref()
            .map(|parent| vec![Value::String(parent.clone())])
            .unwrap_or_default();
        let provenance = json!({
            "message_id": lane_id,
            "run_id": cycle_id,
            "task_id": role,
            "parent_message_id": parent_message_id,
            "parents": parents,
            "created_at": now_iso(),
            "stamped_by": "dispatch_causal_stamp_v1",
        });
        let provenance_path = lane_root(paths, cycle_id, lane_id).join("provenance.json");
        let _ = write_json(&provenance_path, &provenance);
    }
    annotate_contract_queue_role_plan(
        paths,
        cycle_id,
        lane_id,
        &role_plan_path,
        action_type,
        source_brief_id,
    )?;
    Ok(role_plan_path)
}

pub(crate) fn candidate_hypothesis_statements(action: &Value) -> Vec<String> {
    action
        .get("candidate_hypotheses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            item.get("statement")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| item.as_str().map(ToString::to_string))
        })
        .filter(|item| !item.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod native_scout_search_contract_tests {
    use super::*;

    #[test]
    fn approved_policy_upgrades_data_followup_to_literature_scout_with_durable_focus() {
        assert_eq!(
            effective_scout_followup_action(
                "scout",
                "data_acquisition_followup",
                Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
            ),
            "reasoning_literature_scout"
        );
        assert_eq!(
            effective_scout_followup_action("scout", "data_acquisition_followup", None),
            "data_acquisition_followup"
        );
        let focus = approved_scholarly_dataset_inquiry_focus();
        assert_eq!(
            focus["focus_id"],
            json!("dataset_evaluation_feasibility_evidence")
        );
        assert_eq!(
            focus["allowed_evidence_scope"],
            json!(
                "approved scholarly metadata sources and the current cycle's local snapshot only"
            )
        );
        assert!(focus["forbidden_operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "external dataset downloads"));
        // It reads and judges every full abstract: not the cheap tier.
        let route = approved_scholarly_literature_scout_model_route();
        assert_ne!(
            route["model"],
            json!(crate::labdirector::policy::CODEX_LUNA_MODEL)
        );
        assert_ne!(route["reasoning_effort"], json!("low"));
    }

    #[test]
    fn contract_is_hypothesis_conditioned_and_count_free() {
        let contract = build_native_scout_search_agent_contract(
            "When does delayed assistance change user intent inference?",
            "Find direct and adversarial prior art.",
            &["Assistance latency changes the value of clarification.".to_string()],
            &[json!({"primary_family": "shared autonomy", "field": "human-computer interaction"})],
            &json!({"research_scopes": ["robot control", "interaction timing"]}),
        );
        assert_eq!(
            contract["contract_version"],
            json!("adaptive-search-agent-v1")
        );
        assert_eq!(
            contract["query_evolution_policy"]["initial_inquiries"],
            json!(2)
        );
        assert_eq!(
            contract["coverage_policy"]["no_count_based_completion"],
            json!(true)
        );
        assert!(contract["required_inquiry_intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "backward_citation"));
        assert!(contract["required_inquiry_intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "adversarial"));
        let facets = contract["required_field_facets"].as_array().unwrap();
        assert!(facets.iter().any(|item| item["label"] == "robot control"));
        assert!(facets
            .iter()
            .any(|item| item["label"] == "interaction timing"));
    }

    #[test]
    fn unspecified_facets_are_derived_from_the_objective_not_a_robot_template() {
        let contract = build_native_scout_search_agent_contract(
            "Estimate a phase transition in polymer crystallization.",
            "Find the closest procedure.",
            &[],
            &[],
            &json!({}),
        );
        let label = contract["required_field_facets"][0]["label"]
            .as_str()
            .unwrap();
        assert!(label.contains("polymer crystallization"));
        assert!(!label.contains("robot control"));
        assert_eq!(
            contract["required_field_facets"][0]["status"],
            json!("pending_scope_definition")
        );
        // No question was formulated, so the objective is marked as raw text the
        // journal does not have to reproduce.
        assert_eq!(contract["research_problem_source"], json!("objective_text"));

        let formulated = build_native_scout_search_agent_contract(
            "Estimate a phase transition in polymer crystallization.",
            "Find the closest procedure.",
            &[],
            &[],
            &json!({"research_problem": "Which cooling rate shifts the crystallization onset?"}),
        );
        assert_eq!(formulated["research_problem_source"], json!("planning_context"));
    }
}
