#![allow(unused_imports)]
use super::*;

// Strict response schemas for the stage lanes that answer in their final
// message. Every object lists every property as required and closes
// additionalProperties, as Codex strict mode demands; optional values are
// nullable instead. The novelty auditor is a literature scout and writes its
// audit as a file, so it has no schema here.

fn string() -> Value {
    json!({"type": "string"})
}

fn nullable_string() -> Value {
    json!({"type": ["string", "null"]})
}

fn strings() -> Value {
    json!({"type": "array", "items": {"type": "string"}})
}

fn object(properties: Value) -> Value {
    let required: Vec<String> = properties
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn nullable_object(properties: Value) -> Value {
    let mut schema = object(properties);
    schema["type"] = json!(["object", "null"]);
    schema
}

fn array_of(items: Value) -> Value {
    json!({"type": "array", "items": items})
}

fn field_beliefs_schema() -> Value {
    object(json!({
        "beliefs": array_of(object(json!({
            "belief_id": string(),
            "subfield_id": nullable_string(),
            "statement": string(),
            "held_by": array_of(object(json!({
                "paper_id": string(),
                "evidence_ref": string(),
                "claim": string(),
            }))),
            "rests_on": string(),
            "untested": array_of(object(json!({
                "what": string(),
                "why_it_matters": string(),
                "paper_id": nullable_string(),
            }))),
            "landscape_open_problem_ids": strings(),
        }))),
        "contradictions": array_of(object(json!({
            "between": strings(),
            "about": string(),
            "belief_id": nullable_string(),
            "evidence_refs": strings(),
        }))),
        "subfield_maturity": array_of(object(json!({
            "subfield_id": string(),
            "maturity": {"type": "string", "enum": MATURITY_LEVELS},
            "evidence": string(),
            "dominant_approach": string(),
        }))),
        "known_bottlenecks": array_of(object(json!({
            "bottleneck_id": string(),
            "subfield_id": nullable_string(),
            "statement": string(),
            "named_by": array_of(object(json!({
                "paper_id": string(),
                "evidence_ref": string(),
            }))),
            "approaches_tried": strings(),
            "why_they_stall": string(),
        }))),
        "latent_signals": array_of(object(json!({
            "signal_id": string(),
            "subfield_id": nullable_string(),
            "observation": string(),
            "seen_in": array_of(object(json!({
                "paper_id": string(),
                "evidence_ref": string(),
            }))),
            "demand_it_implies": string(),
            "why_unnamed": string(),
        }))),
        "summary": string(),
    }))
}

fn candidate_slate_schema() -> Value {
    object(json!({
        "candidates": array_of(object(json!({
            "candidate_id": string(),
            "subfield_id": string(),
            "problem": string(),
            "hypothesis": string(),
            "origin_strategy": {"type": "string", "enum": origin_strategy_ids()},
            "target_belief_id": nullable_string(),
            "belief_statement": nullable_string(),
            "papers_holding_belief": strings(),
            "method_leap": nullable_object(json!({
                "new_mechanism": string(),
                "departs_from": array_of(object(json!({
                    "paper_id": string(),
                    "approach": string(),
                    "what_is_dropped": string(),
                }))),
            })),
            "bottleneck_transfer": nullable_object(json!({
                "bottleneck_id": string(),
                "concept": string(),
                "source_field": string(),
                "mechanism_mapping": string(),
                "why_untried_here": string(),
            })),
            "latent_bottleneck": nullable_object(json!({
                "demand": string(),
                "why_unnamed": string(),
                "latent_signal_id": nullable_string(),
                "evidence": array_of(object(json!({
                    "paper_id": string(),
                    "evidence_ref": string(),
                    "observation": string(),
                }))),
            })),
            "differing_prediction": string(),
            "informative_either_way": object(json!({
                "if_confirmed": string(),
                "if_refuted": string(),
            })),
            "decisive_experiment": string(),
            "open_source_assets": array_of(object(json!({
                "kind": string(),
                "name": string(),
                "url": string(),
                "from_card_paper_id": string(),
            }))),
            "landscape_open_problem_id": nullable_string(),
            "landscape_paper_ids": strings(),
        }))),
        "summary": string(),
    }))
}

fn expert_panel_schema() -> Value {
    object(json!({
        "reviewer_persona": string(),
        "reviews": array_of(object(json!({
            "candidate_id": string(),
            "predicted_outcome_probability": {"type": "number"},
            "can_call_it": string(),
            "impact": {"type": "number"},
            "impact_rationale": string(),
            "soundness": {"type": "number"},
            "soundness_concerns": strings(),
            "closest_prior_work": array_of(object(json!({
                "title": string(),
                "venue_year": nullable_string(),
                "paper_id": nullable_string(),
                "overlap": string(),
            }))),
            "critique": string(),
        }))),
        "summary": string(),
    }))
}

fn feasibility_schema() -> Value {
    object(json!({
        "assessments": array_of(object(json!({
            "candidate_id": string(),
            "verdict": {"type": "string", "enum": ["pass", "fail"]},
            "blockers": strings(),
            "cheapest_faithful_setup": string(),
            "assets": array_of(object(json!({
                "kind": string(),
                "name": string(),
                "url": nullable_string(),
                "local_path": nullable_string(),
                "license": nullable_string(),
                "license_ok": {"type": "boolean"},
                "min_vram_gb": {"type": ["number", "null"]},
                "verified_locally": {"type": "boolean"},
                "used": {"type": "boolean"},
            }))),
            "peak_vram_gb": {"type": ["number", "null"]},
            "vram_reduction": nullable_string(),
            "reproduction_anchor": nullable_object(json!({
                "paper_id": string(),
                "claim": string(),
                "metric": string(),
                "reported_value": string(),
                "evidence_ref": nullable_string(),
                "setup": string(),
                "expected_cost": string(),
            })),
            "experiment_plan": strings(),
            "cost": object(json!({
                "wall_clock_hours": {"type": ["number", "null"]},
                "gpu_hours": {"type": ["number", "null"]},
                "notes": string(),
            })),
        }))),
        "summary": string(),
    }))
}

/// The strict response schema for a stage action, whatever the lane's role.
pub(crate) fn expert_selection_output_schema(action_type: &str) -> Option<Value> {
    match action_type {
        FIELD_BELIEFS_ACTION => Some(field_beliefs_schema()),
        CANDIDATE_SLATE_ACTION => Some(candidate_slate_schema()),
        EXPERT_PANEL_ACTION => Some(expert_panel_schema()),
        FEASIBILITY_AUDIT_ACTION => Some(feasibility_schema()),
        _ => None,
    }
}
