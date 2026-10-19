#![allow(unused_imports)]
use super::*;

pub(crate) fn role_receives_impact_first_hypothesis_mandate(role: &str) -> bool {
    matches!(
        role,
        "lab-director" | "scout" | "analyst" | "gatekeeper" | "falsifier"
    )
}

pub(crate) fn default_impact_first_hypothesis_mandate() -> Value {
    json!({
        "active": true,
        "policy_version": "typed-evidence-admission-v3",
        "selection_rule": "Select exploration candidates from multiple mechanism families, then admit a validation lead only when its typed evidence route, procedure signature, prior-art boundary, estimand, falsification criteria, and smallest useful effect are concrete and traceable. Scores guide prioritization; they never substitute for evidence.",
        "evidence_routes": [
            "literature_frontier", "controlled_simulation", "physical_experiment",
            "human_study", "formal_proof", "observational_dataset", "benchmark"
        ],
        "admission_states": ["exploration_candidate_selected", "validation_lead_ready"],
        "required_candidate_fields": [
            "hypothesis_id",
            "statement",
            "impact_claim",
            "decision_relevance",
            "state_of_art_delta",
            "why_now",
            "novelty_delta_score",
            "expected_impact_score",
            "testability_score",
            "data_feasibility_score",
            "validation_data_availability_score",
            "validation_dataset_accession_or_bundle",
            "validation_variable_mapping",
            "validation_data_blockers",
            "decisive_validation_plan",
            "why_not_merely_audit",
            "research_question", "mechanism", "procedure_signature",
            "closest_prior_art", "prior_art_evidence_scope", "novelty_delta",
            "strongest_inversion", "boring_baseline", "primary_estimand",
            "smallest_useful_effect", "falsification_criteria", "null_contribution",
            "instrument_limitations", "admission_state", "evidence_route",
            "evidence_artifacts", "evidence_provenance",
        ],
        "minimum_initial_scores": {
            "expected_impact_score": null,
            "novelty_delta_score": null,
            "testability_score": null,
            "data_feasibility_score": null,
            "validation_data_availability_score": null
        },
        "demotion_rules": [
            "A reproducibility audit cannot be the lead unless it overturns a high-stakes baseline, exposes a broadly reusable mechanism, or changes a consequential scientific or engineering decision.",
            "A metric drop from a published result is audit evidence, not a high-impact hypothesis by itself.",
            "Candidates with unclear state-of-art delta or unclear decision relevance must be kept as supporting checks, not promoted as the lead.",
            "Candidates without a typed evidence route, procedure signature, and traceable artifact path must remain exploration candidates."
        ],
        "lead_selection_deliverables": [
            "impact-ranked candidate hypothesis table",
            "state-of-art baseline and delta for each candidate",
            "decision-changing validation plan for the selected lead",
            "explicit reason the lead is more than a reproducibility audit",
            "route-specific evidence and provenance ledger"
        ]
    })
}

pub(crate) fn impact_first_hypothesis_policy(mandate: &Value) -> Value {
    json!({
        "mode": "impact-first",
        "mandate_version": mandate
            .get("policy_version")
            .cloned()
            .unwrap_or_else(|| json!("impact-first-v1")),
        "selection_rule": mandate
            .get("selection_rule")
            .cloned()
            .unwrap_or(Value::Null),
        "evidence_routes": mandate
            .get("evidence_routes")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "admission_states": mandate
            .get("admission_states")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "minimum_initial_scores": mandate
            .get("minimum_initial_scores")
            .cloned()
            .unwrap_or(Value::Null),
        "required_candidate_fields": mandate
            .get("required_candidate_fields")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "demotion_rules": mandate
            .get("demotion_rules")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "lead_selection_deliverables": mandate
            .get("lead_selection_deliverables")
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

pub(crate) fn promote_impact_first_hypothesis_mandate(
    role: &str,
    planner_metadata: &mut Value,
) -> (Value, Value) {
    if !role_receives_impact_first_hypothesis_mandate(role) {
        return (Value::Null, Value::Null);
    }
    let mandate = planner_metadata
        .get("impact_first_hypothesis_mandate")
        .cloned()
        .or_else(|| {
            planner_metadata
                .get("review_action")
                .and_then(|item| item.get("impact_first_hypothesis_mandate"))
                .cloned()
        })
        .unwrap_or_else(default_impact_first_hypothesis_mandate);
    if planner_metadata
        .get("impact_first_hypothesis_mandate")
        .is_none()
    {
        planner_metadata["impact_first_hypothesis_mandate"] = mandate.clone();
    }
    let policy = planner_metadata
        .get("hypothesis_generation_policy")
        .cloned()
        .or_else(|| {
            planner_metadata
                .get("review_action")
                .and_then(|item| item.get("hypothesis_generation_policy"))
                .cloned()
        })
        .unwrap_or_else(|| impact_first_hypothesis_policy(&mandate));
    if planner_metadata
        .get("hypothesis_generation_policy")
        .is_none()
    {
        planner_metadata["hypothesis_generation_policy"] = policy.clone();
    }
    if let Some(review_action) = planner_metadata
        .get_mut("review_action")
        .and_then(Value::as_object_mut)
    {
        review_action
            .entry("impact_first_hypothesis_mandate".to_string())
            .or_insert_with(|| mandate.clone());
        review_action
            .entry("hypothesis_generation_policy".to_string())
            .or_insert_with(|| policy.clone());
    }
    (mandate, policy)
}

pub(crate) fn attach_lab_director_context_controls(
    paths: &AppPaths,
    cycle_id: &str,
    role_plan: &mut Value,
) -> Result<()> {
    let role = role_plan
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // The cycle's memory goes to every role that has to decide with it. Measured
    // on cycle-g-v89: the summary's own sentences appeared in the director's
    // prompt and in no other role's, so the author wrote the manuscript with no
    // record of what had been tried or what the best lead was, and the analyst
    // designed experiments the same way -- see the note on this function.
    if matches!(role.as_str(), "lab-director" | "author" | "analyst" | "gatekeeper") {
        if let Some(cycle_memory_context) = lab_director_cycle_memory_context(paths, cycle_id)? {
            role_plan["cycle_memory_context"] = cycle_memory_context;
        }
    }
    // Each role gets the mailbox addressed to IT. The ledger has always written
    // one projection per target role and only the director's was ever read, so
    // the author's messages sat in a file nothing opened -- see
    // agent_mailbox_context.
    if let Some(mailbox_context) = agent_mailbox_context(paths, cycle_id, &role) {
        role_plan["agent_mailbox_context"] = mailbox_context;
    }
    // Everything below is the director's own instrument: the supervisor's
    // operational reporting and the director's blocker classification. Handing
    // those to another role would hand it the director's decisions, and this
    // project's governance is that the director owns pivot and continue.
    if role != "lab-director" {
        return Ok(());
    }
    let policy = lab_director_context_budget_policy(paths, cycle_id);
    role_plan["context_budget_policy"] = policy.clone();
    if let Some(digest_context) = lab_director_agent_communication_digest_context(paths, cycle_id)?
    {
        role_plan["agent_communication_digest_context"] = digest_context;
    }
    if let Some(notes_context) = role_plan.get("research_notes_context").cloned() {
        role_plan["research_notes_context"] = compact_json_context(&notes_context, 24_000);
    }
    for key in ["previous_review_context", "chronicle_research_context"] {
        if let Some(value) = role_plan.get(key).cloned() {
            role_plan[key] = compact_json_context(&value, 8_000);
        }
    }
    if let Some(planner) = role_plan
        .get_mut("planner_metadata")
        .and_then(Value::as_object_mut)
    {
        planner.insert("context_budget_policy".to_string(), policy);
        planner
            .entry("chronicle_decision_digest".to_string())
            .or_insert_with(|| compact_chronicle_decision_digest(paths, cycle_id));
        planner
            .entry("kg_first_hypothesis_contract".to_string())
            .or_insert_with(|| json!({
                "required_order": "literature/data search -> KG generation -> hypothesis generation -> validation materialization/analysis",
                "gate_mode": "advisory_order_with_recorded_lab_director_override",
                "decision_digest_input": state_root(paths).join(format!("{cycle_id}-chronicle-decision-digest.json")),
                "bounded_read_policy": "Use Chronicle's compact decision digest plus lab-director research notes. Do not read the full KG, full state directory, or enumerate the full .research-lab/lanes tree. If evidence is missing, ask Chronicle for a refreshed digest or open exactly one named source_ref.",
                "forbidden_context_inputs": ["full_literature_graph_inline", "full_data_graph_inline", "full_lane_tree", "unbounded_state_directory_dump"],
                "lab_director_authority": "Process stages are recommendations and safety rails. LabDirector may override an advisory gate only by recording a stage_gate_override with rationale; a dependency blocker holding a lane (any reason beginning `waiting-for-`) is released the same way, by recording a `dependency_gate_override` that names that exact blocker string, sets approved=true, and gives a rationale -- a blanket or wildcard target releases nothing. Hard constraints such as forbidden dataset reuse remain non-overridable by either.",
                "hypothesis_stage": {
                    "requires_materialized_validation_bundle": false,
                    "allowed_dataset_node_policy": "candidate dataset nodes with metadata.materialized=false are valid for hypothesis selection when forbidden_reuse is not true"
                },
                "validation_stage": {
                    "materialization_required_before_analysis": true,
                    "same_dataset_baseline_required_before_analysis": true
                }
            }));
        planner.remove("reasoning_graph");
        planner.remove("data_graph");
        planner.remove("knowledge_graph");
        planner.insert(
            "raw_kg_context_policy".to_string(),
            json!({
                "full_kg_inline_allowed": false,
                "full_lane_tree_allowed": false,
                "required_input": "chronicle_decision_digest",
                "fallback": "request Chronicle refresh or read one named source_ref only"
            }),
        );
        for (key, max_bytes) in [
            ("research_notes_context", 8_000usize),
            ("previous_review_context", 6_000usize),
            ("chronicle_research_context", 6_000usize),
            ("validation_results", 8_000usize),
            ("failed_runner_context", 6_000usize),
            ("reference_literature_summary", 6_000usize),
            ("previous_review_summary", 4_000usize),
            ("review_action", 8_000usize),
            ("chronicle_decision_digest", 12_000usize),
        ] {
            if let Some(value) = planner.get(key).cloned() {
                planner.insert(key.to_string(), compact_json_context(&value, max_bytes));
            }
        }
    }
    let trace = lab_director_context_input_trace(role_plan);
    role_plan["context_input_trace"] = trace;
    Ok(())
}
