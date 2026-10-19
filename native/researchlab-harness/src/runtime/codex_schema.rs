use serde_json::{json, Value};

pub(crate) fn codex_output_schema(role: &str, action_type: &str) -> Option<Value> {
    // An expert-selection stage answers in its own strict shape, whatever the
    // role running it (labdirector::problem_selection): a panel reviewer is a
    // gatekeeper by role and must not be held to the gate-review schema.
    if let Some(schema) = crate::labdirector::expert_selection_output_schema(action_type) {
        return Some(schema);
    }
    // MEASURED ON cycle-a-20260919, 2026-10-17: three
    // runner_result_interpretation_followup lanes were forced through the
    // pre-run Analyst schema. That schema forbade lab_director_validation_report
    // and required a new blueprint, so every "interpretation" produced another
    // executable handoff and the post-run gate could never be cleared.
    if role == "analyst" && action_type == "runner_result_interpretation_followup" {
        return Some(json!({
            "type": "object",
            "required": ["lab_director_validation_report"],
            "properties": {
                "lab_director_validation_report": {
                    "type": "object",
                    "required": [
                        "runner_lane_id",
                        "gate_ready",
                        "hypothesis_decision",
                        "effect_direction",
                        "effect_strength",
                        "controls",
                        "negative_controls",
                        "confounder_assessment",
                        "falsification_assessment",
                        "protocol_deviations",
                        "failure_modes",
                        "artifacts",
                        "summary",
                        "revised_handoff_required",
                        "revision_reason"
                    ],
                    "properties": {
                        "runner_lane_id": { "type": "string" },
                        "gate_ready": { "type": "boolean" },
                        "hypothesis_decision": { "type": "string" },
                        "effect_direction": { "type": "string" },
                        "effect_strength": { "type": "string" },
                        "controls": { "type": "array", "items": { "type": "string" } },
                        "negative_controls": { "type": "array", "items": { "type": "string" } },
                        "confounder_assessment": { "type": "string" },
                        "falsification_assessment": { "type": "string" },
                        "protocol_deviations": { "type": "array", "items": { "type": "string" } },
                        "failure_modes": { "type": "array", "items": { "type": "string" } },
                        "artifacts": { "type": "array", "items": { "type": "string" } },
                        "summary": { "type": "string" },
                        "revised_handoff_required": { "type": "boolean" },
                        "revision_reason": { "type": ["string", "null"] }
                    },
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        }));
    }
    if role == "gatekeeper" {
        Some(json!({
            "type": "object",
            "required": [
                "reviewer_id",
                "reviewer_focus_rubric",
                "reviewer_standard",
                "verdict",
                "summary",
                "rubric",
                "major_objections",
                "same_family_alternatives",
                "cross_family_alternatives",
                "family_switch_recommendations",
                "switch_triggers",
                "incumbent_rejection_reasons",
                "better_alternative_hypotheses",
                "missing_validations",
                "required_response_from_lab_director",
                "blocker_adjudications",
                "restart_recommended",
                "recommended_actions"
            ],
            "properties": {
                "reviewer_id": { "type": "string" },
                "reviewer_focus_rubric": { "type": "string" },
                "reviewer_standard": { "type": "string" },
                "verdict": { "type": "string", "enum": ["approve", "challenge", "reject"] },
                "summary": { "type": "string" },
                "rubric": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "score": { "type": "number" },
                            "reasons": { "type": "array", "items": { "type": "string" } },
                            "applicable": { "type": "boolean" }
                        },
                        "required": ["name", "score", "reasons", "applicable"],
                        "additionalProperties": false
                    }
                },
                "major_objections": { "type": "array", "items": { "type": "string" } },
                "same_family_alternatives": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "statement": { "type": "string" },
                            "why_better": { "type": "string" }
                        },
                        "required": ["statement", "why_better"],
                        "additionalProperties": false
                    }
                },
                "cross_family_alternatives": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "statement": { "type": "string" },
                            "family_root": { "type": "string" },
                            "why_better": { "type": "string" }
                        },
                        "required": ["statement", "family_root", "why_better"],
                        "additionalProperties": false
                    }
                },
                "family_switch_recommendations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "from_family": { "type": "string" },
                            "to_family": { "type": "string" },
                            "reason": { "type": "string" }
                        },
                        "required": ["from_family", "to_family", "reason"],
                        "additionalProperties": false
                    }
                },
                "switch_triggers": { "type": "array", "items": { "type": "string" } },
                "incumbent_rejection_reasons": { "type": "array", "items": { "type": "string" } },
                "better_alternative_hypotheses": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "statement": { "type": "string" },
                            "why_better": { "type": "string" }
                        },
                        "required": ["statement", "why_better"],
                        "additionalProperties": false
                    }
                },
                "missing_validations": { "type": "array", "items": { "type": "string" } },
                "required_response_from_lab_director": { "type": "array", "items": { "type": "string" } },
                "blocker_adjudications": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "blocker": { "type": "string" },
                            "decision": { "type": "string", "enum": ["uphold", "remove", "resolved", "superseded", "downgrade"] },
                            "rationale": { "type": "string" },
                            "target_rubric": { "type": "string" },
                            "evidence_refs": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["blocker", "decision", "rationale", "target_rubric", "evidence_refs"],
                        "additionalProperties": false
                    }
                },
                "restart_recommended": { "type": "boolean" },
                "recommended_actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string" },
                            "description": { "type": "string" },
                            "preferred_role": { "type": "string" }
                        },
                        "required": ["type", "description", "preferred_role"],
                        "additionalProperties": false
                    }
                }
            },
            "additionalProperties": false
        }))
    } else if role == "lab-director" && action_type == "lab_director_requery_followup" {
        Some(json!({
            "type": "object",
            "required": [
                "requery_decision",
                "decision_status",
                "summary",
                "rationale",
                "replacement_hypotheses",
                "validation_changes",
                "gate_blocker_review_requests",
                "next_actions",
                "experiment_request_decisions",
                "research_problem",
                "selected_hypothesis",
                "chronicle_requests",
                "simulation_orders"
            ],
            "properties": {
                "requery_decision": { "type": "string", "enum": ["uphold", "replace", "restart", "defer_for_chronicle"] },
                "decision_status": { "type": ["string", "null"] },
                "summary": { "type": "string" },
                "rationale": { "type": "string" },
                "replacement_hypotheses": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "statement": { "type": "string" },
                            "why_selected": { "type": "string" },
                            // The Method-persistence rule states that these two
                            // are "where this rule is counted". Neither was in
                            // this schema, and the entry closes
                            // `additionalProperties`, so neither could be
                            // emitted: 0 of 244 replacements naming a question
                            // was arithmetic, not a director judgement.
                            "research_problem_question": { "type": ["string", "null"] },
                            "methods_tried": {
                                "type": ["array", "null"],
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "approach": { "type": ["string", "null"] },
                                        "outcome": { "type": ["string", "null"] },
                                        "what_it_rules_out": { "type": ["string", "null"] }
                                    },
                                    "required": ["approach", "outcome", "what_it_rules_out"],
                                    "additionalProperties": false
                                }
                            },
                            "retires_the_question": { "type": ["boolean", "string", "null"] },
                            "primary_family": { "type": ["string", "null"] },
                            "supporting_literature_edges": { "type": ["array", "null"], "items": { "type": "string" } },
                            "supporting_data_graph_edges": { "type": ["array", "null"], "items": { "type": "string" } },
                            "validation_data_status": { "type": ["string", "null"] },
                            "dataset_or_accession": { "type": ["string", "null"] },
                            // A replacement can become the lead, so it answers to
                            // the same field-landscape gate as selected_hypothesis.
                            "landscape_open_problem_id": { "type": ["string", "null"] },
                            "landscape_paper_ids": { "type": ["array", "null"], "items": { "type": "string" } },
                            // And to the expert-selection gate: the candidate of
                            // the slate it is (labdirector::problem_selection).
                            "slate_candidate_id": { "type": ["string", "null"] }
                        },
                        "required": [
                            "statement",
                            "why_selected",
                            "research_problem_question",
                            "methods_tried",
                            "retires_the_question",
                            "primary_family",
                            "supporting_literature_edges",
                            "supporting_data_graph_edges",
                            "validation_data_status",
                            "dataset_or_accession",
                            "landscape_open_problem_id",
                            "landscape_paper_ids",
                            "slate_candidate_id"
                        ],
                        "additionalProperties": false
                    }
                },
                // Every field below is demanded by the output contract this role
                // is handed. None was in this schema, and the schema closes
                // `additionalProperties`, so none could be emitted however often
                // it was asked.
                "experiment_request_decisions": {
                    "type": ["array", "null"],
                    "items": {
                        "type": "object",
                        "properties": {
                            "claim_it_would_support": { "type": "string" },
                            "decision": { "type": "string", "enum": ["adopt", "decline"] },
                            "reason": { "type": "string" }
                        },
                        "required": ["claim_it_would_support", "decision", "reason"],
                        "additionalProperties": false
                    }
                },
                "research_problem": {
                    "type": ["object", "null"],
                    "properties": {
                        "question": { "type": ["string", "null"] },
                        "source": { "type": ["string", "null"] },
                        "why_not_already_answered": { "type": ["string", "null"] },
                        "evidence_of_absence": { "type": ["array", "null"], "items": { "type": "string" } },
                        "who_or_what_it_blocks": { "type": ["string", "null"] },
                        "answerable_here_because": { "type": ["string", "null"] },
                        "instrument_gap": { "type": ["string", "null"] },
                        "methods_tried": {
                            "type": ["array", "null"],
                            "items": {
                                "type": "object",
                                "properties": {
                                    "method": { "type": ["string", "null"] },
                                    "outcome": { "type": ["string", "null"] },
                                    "evidence": { "type": ["string", "null"] },
                                    "why_the_next_method_differs": { "type": ["string", "null"] }
                                },
                                "required": ["method", "outcome", "evidence", "why_the_next_method_differs"],
                                "additionalProperties": false
                            }
                        },
                        "problem_retirement": { "type": ["string", "null"] }
                    },
                    "required": [
                        "question",
                        "source",
                        "why_not_already_answered",
                        "evidence_of_absence",
                        "who_or_what_it_blocks",
                        "answerable_here_because",
                        "instrument_gap",
                        "methods_tried",
                        "problem_retirement"
                    ],
                    "additionalProperties": false
                },
                "selected_hypothesis": {
                    "type": ["object", "null"],
                    "properties": {
                        "statement": { "type": ["string", "null"] },
                        "answers_research_problem": { "type": ["string", "null"] },
                        "primary_family": { "type": ["string", "null"] },
                        "dataset_or_accession": { "type": ["string", "null"] },
                        "validation_data_status": { "type": ["string", "null"] },
                        "supporting_literature_edges": { "type": ["array", "null"], "items": { "type": "string" } },
                        "supporting_data_graph_edges": { "type": ["array", "null"], "items": { "type": "string" } },
                        "same_dataset_reference_papers": { "type": ["array", "null"], "items": { "type": "string" } },
                        "reference_methods_baseline": { "type": ["string", "null"] },
                        // The hypothesis_contract in policy.rs demanded twelve
                        // fields. Nine of them were not in this object, and the
                        // object closes `additionalProperties`, so a director
                        // that tried to obey would have had its whole result
                        // rejected. It obeyed what it could and the other nine
                        // requirements vanished without a word -- including the
                        // three that keep the science honest.
                        //
                        // MEASURED ON cycle-g-v91: the artifact carried
                        // statement, primary_family and supporting_data_graph_edges
                        // and nothing else the contract asked for. Reading it, I
                        // reported that the director had cited no literature. It
                        // had; the citations were under the name the schema
                        // enforces. The contract was asking for a second name.
                        //
                        // Nullable and required, which is the convention already
                        // set by research_problem_question above: the model must
                        // acknowledge the field, and may answer null honestly
                        // rather than inventing one.
                        "falsification_conditions": { "type": ["array", "null"], "items": { "type": "string" } },
                        "rival_mechanisms": { "type": ["array", "null"], "items": { "type": "string" } },
                        "candidate_hypothesis_ranking": {
                            "type": ["array", "null"],
                            "items": {
                                "type": "object",
                                "properties": {
                                    "statement": { "type": ["string", "null"] },
                                    "expected_impact_score": { "type": ["number", "null"] },
                                    "validation_data_availability_score": { "type": ["number", "null"] },
                                    "validation_data_blockers": { "type": ["array", "null"], "items": { "type": "string" } },
                                    "why_not_selected": { "type": ["string", "null"] }
                                },
                                "required": ["statement", "expected_impact_score", "validation_data_availability_score", "validation_data_blockers", "why_not_selected"],
                                "additionalProperties": false
                            }
                        },
                        "identification_strategy": {
                            "type": ["object", "null"],
                            "properties": {
                                "design": { "type": ["string", "null"] },
                                "outcome": { "type": ["string", "null"] },
                                "estimands": { "type": ["array", "null"], "items": { "type": "string" } },
                                "validation_data_status": { "type": ["string", "null"] },
                                "materialized_dataset": { "type": ["string", "null"] }
                            },
                            "required": ["design", "outcome", "estimands", "validation_data_status", "materialized_dataset"],
                            "additionalProperties": false
                        },
                        "trend_positioning": { "type": ["string", "null"] },
                        "attention_concentration_basis": { "type": ["string", "null"] },
                        "research_trend_analysis_path": { "type": ["string", "null"] },
                        // The field-landscape gate (labdirector::field_landscape):
                        // the projection applies a selection only when these name
                        // an open problem of the valid landscape and cite enough
                        // of its papers, one of them frontier work. Nullable so a
                        // director without a landscape can say so honestly -- the
                        // selection is then refused with the reason, not dropped
                        // by the schema.
                        "landscape_open_problem_id": { "type": ["string", "null"] },
                        "landscape_paper_ids": { "type": ["array", "null"], "items": { "type": "string" } },
                        // The expert-selection gate (labdirector::problem_selection):
                        // once engaged for the cycle, the lead is the owner's pick
                        // from the slate, named here.
                        "slate_candidate_id": { "type": ["string", "null"] },
                        "chronicle_dialogue": { "type": ["array", "null"], "items": { "type": "string" } }
                    },
                    "required": [
                        "statement",
                        "answers_research_problem",
                        "primary_family",
                        "dataset_or_accession",
                        "validation_data_status",
                        "supporting_literature_edges",
                        "supporting_data_graph_edges",
                        "same_dataset_reference_papers",
                        "reference_methods_baseline",
                        "falsification_conditions",
                        "rival_mechanisms",
                        "candidate_hypothesis_ranking",
                        "identification_strategy",
                        "trend_positioning",
                        "attention_concentration_basis",
                        "research_trend_analysis_path",
                        "landscape_open_problem_id",
                        "landscape_paper_ids",
                        "slate_candidate_id",
                        "chronicle_dialogue"
                    ],
                    "additionalProperties": false
                },
                "chronicle_requests": {
                    "type": ["array", "null"],
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string" },
                            "why_needed_for_decision": { "type": ["string", "null"] },
                            "source_scope": { "type": ["array", "null"], "items": { "type": "string" } },
                            "priority": { "type": ["string", "null"] }
                        },
                        "required": ["question", "why_needed_for_decision", "source_scope", "priority"],
                        "additionalProperties": false
                    }
                },
                // The LabDirector designs the simulation and orders it
                // (cycle-b-20260918, 2026-09-18: the owner assigned simulation
                // orchestration to the LabDirector; an analyst-declared request let
                // the analyst choose the experiment). Null when the cycle's data is
                // not simulator-generated; otherwise one engineer lane runs each
                // order and the analyst analyses the episodes.csv it writes.
                "simulation_orders": {
                    "type": ["array", "null"],
                    "items": {
                        "type": "object",
                        "properties": {
                            "request_id": { "type": "string" },
                            "simulator_backend": { "type": "string" },
                            "interpreter_path": { "type": "string" },
                            "scenario": { "type": "string" },
                            "conditions": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "factor": { "type": "string" },
                                        "levels": { "type": "array", "items": { "type": "string" } }
                                    },
                                    "required": ["factor", "levels"],
                                    "additionalProperties": false
                                }
                            },
                            "seeds": { "type": "array", "items": { "type": "integer" } },
                            "episodes_per_condition": { "type": "integer" },
                            "step_or_time_budget": { "type": "string" },
                            "emitted_columns": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": { "type": "string" },
                                        "unit": { "type": "string" },
                                        "meaning": { "type": "string" }
                                    },
                                    "required": ["name", "unit", "meaning"],
                                    "additionalProperties": false
                                }
                            },
                            "output_path": { "type": "string" },
                            "hypothesis_link": { "type": "string" }
                        },
                        "required": [
                            "request_id",
                            "simulator_backend",
                            "interpreter_path",
                            "scenario",
                            "conditions",
                            "seeds",
                            "episodes_per_condition",
                            "step_or_time_budget",
                            "emitted_columns",
                            "output_path",
                            "hypothesis_link"
                        ],
                        "additionalProperties": false
                    }
                },
                "validation_changes": { "type": "array", "items": { "type": "string" } },
                "gate_blocker_review_requests": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "request_id": { "type": "string" },
                            "blocker": { "type": "string" },
                            "target_rubric": { "type": "string" },
                            "requested_action": { "type": "string", "enum": ["reconsider", "remove", "downgrade", "mark_resolved", "supersede"] },
                            "rationale": { "type": "string" },
                            "evidence_refs": { "type": "array", "items": { "type": "string" } },
                            "replacement_blocker": { "type": ["string", "null"] }
                        },
                        "required": ["request_id", "blocker", "target_rubric", "requested_action", "rationale", "evidence_refs", "replacement_blocker"],
                        "additionalProperties": false
                    }
                },
                "next_actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string" },
                            "description": { "type": "string" },
                            "preferred_role": { "type": "string" }
                        },
                        "required": ["type", "description", "preferred_role"],
                        "additionalProperties": false
                    }
                }
            },
            "additionalProperties": false
        }))
    } else if role == "analyst" {
        Some(with_handoff_readiness(json!({
            "type": "object",
            "required": [
                "summary",
                "primary_hypothesis_id",
                "candidate_primary_families",
                "candidate_estimands",
                "open_source_agent_discovery",
                "selected_open_source_analysis_agent",
                "rival_dags",
                "confounders",
                "falsification_ideas",
                "evidence_gaps",
                "analysis_lane_proposals",
                "analyst_quality_standard",
                "derived_indicators",
                "handoff_checks",
                "validation_code_blueprints",
                "self_review"
            ],
            "properties": {
                "summary": { "type": "string" },
                "primary_hypothesis_id": { "type": "string" },
                "candidate_primary_families": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "family": { "type": "string" },
                            "why_competitive": { "type": "string" },
                            "priority": { "type": "string" }
                        },
                        "required": ["family", "why_competitive", "priority"],
                        "additionalProperties": false
                    }
                },
                "candidate_estimands": { "type": "array", "items": { "type": "string" } },
                "open_source_agent_discovery": {
                    "type": "object",
                    "properties": {
                        "query_log": { "type": "array", "items": { "type": "string" } },
                        "candidates": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "url": { "type": "string" },
                                    "license": { "type": "string" },
                                    "domain": { "type": "string" },
                                    "fit_score": { "type": "number" },
                                    "reuse_decision": { "type": "string" },
                                    "download_command": { "type": ["string", "null"] },
                                    "local_path": { "type": ["string", "null"] },
                                    "setup_commands": { "type": "array", "items": { "type": "string" } },
                                    "smoke_test_command": { "type": ["string", "null"] },
                                    "application_command": { "type": ["string", "null"] },
                                    "expected_outputs": { "type": "array", "items": { "type": "string" } },
                                    "debug_attempts": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "command": { "type": "string" },
                                                "status": { "type": "string" },
                                                "stderr_excerpt": { "type": "string" },
                                                "fix_or_blocker": { "type": "string" }
                                            },
                                            "required": ["command", "status", "stderr_excerpt", "fix_or_blocker"],
                                            "additionalProperties": false
                                        }
                                    },
                                    "evidence": { "type": "string" }
                                },
                                "required": ["name", "url", "license", "domain", "fit_score", "reuse_decision", "download_command", "local_path", "setup_commands", "smoke_test_command", "application_command", "expected_outputs", "debug_attempts", "evidence"],
                                "additionalProperties": false
                            }
                        },
                        "selected_agent": {
                            "type": ["object", "null"],
                            "properties": {
                                "name": { "type": "string" },
                                "url": { "type": "string" },
                                "reuse_decision": { "type": "string" },
                                "local_path": { "type": ["string", "null"] },
                                "smoke_test_command": { "type": ["string", "null"] },
                                "application_command": { "type": ["string", "null"] },
                                "reason": { "type": "string" }
                            },
                            "required": ["name", "url", "reuse_decision", "local_path", "smoke_test_command", "application_command", "reason"],
                            "additionalProperties": false
                        },
                        "rejection_summary": { "type": "string" }
                    },
                    "required": ["query_log", "candidates", "selected_agent", "rejection_summary"],
                    "additionalProperties": false
                },
                "selected_open_source_analysis_agent": {
                    "type": ["object", "null"],
                    "properties": {
                        "name": { "type": "string" },
                        "url": { "type": "string" },
                        "reuse_decision": { "type": "string" },
                        "local_path": { "type": ["string", "null"] },
                        "smoke_test_command": { "type": ["string", "null"] },
                        "application_command": { "type": ["string", "null"] },
                        "reason": { "type": "string" }
                    },
                    "required": ["name", "url", "reuse_decision", "local_path", "smoke_test_command", "application_command", "reason"],
                    "additionalProperties": false
                },
                "rival_dags": { "type": "array", "items": { "type": "string" } },
                "confounders": { "type": "array", "items": { "type": "string" } },
                "falsification_ideas": { "type": "array", "items": { "type": "string" } },
                "evidence_gaps": { "type": "array", "items": { "type": "string" } },
                "analysis_lane_proposals": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": { "type": "string" },
                            "target_family": { "type": "string" },
                            "decision_value": { "type": "string" }
                        },
                        "required": ["description", "target_family", "decision_value"],
                        "additionalProperties": false
                    }
                },
                "analyst_quality_standard": {
                    "type": "object",
                    "properties": {
                        "minimum_blueprints_passed": { "type": "integer", "minimum": 1 },
                        "require_no_blueprint_failures": { "type": "boolean" },
                        "require_all_handoff_checks_pass": { "type": "boolean" },
                        "require_all_handoff_checks_resolved": { "type": "boolean" },
                        "required_validation_checks": { "type": "array", "items": { "type": "string" } },
                        "minimum_method_appropriateness_score": { "type": ["number", "null"] },
                        "minimum_analysis_accuracy_score": { "type": ["number", "null"] },
                        "minimum_external_agent_runs_passed": { "type": ["integer", "null"] },
                        "allow_inconclusive_for_gate_review": { "type": "boolean" },
                        "rationale": { "type": "string" }
                    },
                    "required": ["minimum_blueprints_passed", "require_no_blueprint_failures", "require_all_handoff_checks_pass", "require_all_handoff_checks_resolved", "required_validation_checks", "minimum_method_appropriateness_score", "minimum_analysis_accuracy_score", "minimum_external_agent_runs_passed", "allow_inconclusive_for_gate_review", "rationale"],
                    "additionalProperties": false
                },
                "derived_indicators": {
                    "type": "array",
                    "description": "New columns the analyst proposes to synthesize from existing ones — ratios, deltas, z-scores, interactions, residuals, composites, or anything the hypothesis calls for that is not already in the dataset. Each entry must be computable from source_columns via a clear formula and must be produced by at least one validation-code blueprint.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "snake_case identifier used as the new column name" },
                            "formula_description": { "type": "string", "description": "concise natural-language or pseudocode description of how to compute the indicator from the source columns" },
                            "source_columns": { "type": "array", "items": { "type": "string" }, "description": "existing columns the indicator depends on" },
                            "rationale": { "type": "string", "description": "why this derived indicator improves identification or tests a hypothesis that raw columns cannot" },
                            "unit": { "type": "string", "description": "unit of the derived indicator (e.g., 'percentage_points', 'ratio', 'z_score', 'delta_per_year'); use 'unitless' if truly unitless" },
                            "direction": { "type": "string", "enum": ["positive", "negative", "mixed", "n/a"], "description": "expected direction of association with the primary outcome under the hypothesis" },
                            "blueprint_id_reference": { "type": "string", "description": "id of the validation_code_blueprint that computes this indicator" }
                        },
                        "required": ["name", "formula_description", "source_columns", "rationale", "unit", "direction", "blueprint_id_reference"],
                        "additionalProperties": false
                    }
                },
                "handoff_checks": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "check_id": { "type": "string" },
                            "goal": { "type": "string" },
                            "dataset": { "type": "string" },
                            "outcome": { "type": "string" },
                            "exposures": { "type": "array", "items": { "type": "string" } },
                            "adjustment_set": { "type": "array", "items": { "type": "string" } },
                            "fixed_effects": { "type": "array", "items": { "type": "string" } },
                            "sample_filters": { "type": "array", "items": { "type": "string" } },
                            "model_family": { "type": "string" },
                            // The semantic names the validation script reads, each
                            // with the dataset column that holds it. Pairs, not a
                            // map: a strict response schema cannot hold free keys.
                            // The analysis driver turns them into the dict the
                            // script receives as spec["column_mapping"].
                            "column_mapping": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "key": { "type": "string" },
                                        "column": { "type": "string" }
                                    },
                                    "required": ["key", "column"],
                                    "additionalProperties": false
                                }
                            },
                            "success_criteria": {
                                "type": "object",
                                "properties": {
                                    "expected_sign": { "type": "string" },
                                    "p_value_max": { "type": "number" },
                                    "minimum_effect_description": { "type": "string" }
                                },
                                "required": ["expected_sign", "p_value_max", "minimum_effect_description"],
                                "additionalProperties": false
                            },
                            "failure_criteria": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": [
                            "check_id",
                            "goal",
                            "dataset",
                            "outcome",
                            "exposures",
                            "adjustment_set",
                            "fixed_effects",
                            "sample_filters",
                            "model_family",
                            "column_mapping",
                            "success_criteria",
                            "failure_criteria"
                        ],
                        "additionalProperties": false
                    }
                },
                "validation_code_blueprints": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "blueprint_id": { "type": "string" },
                            "check_id": { "type": "string" },
                            "language": { "type": "string" },
                            "entrypoint": { "type": "string" },
                            "code": { "type": "string" },
                            "code_file": { "type": ["string", "null"] },
                            "dependencies": { "type": "array", "items": { "type": "string" } },
                            "execution_notes": { "type": "array", "items": { "type": "string" } },
                            "review_focus": { "type": "array", "items": { "type": "string" } },
                            "review_status": { "type": "string" }
                        },
                        "required": [
                            "blueprint_id",
                            "check_id",
                            "language",
                            "entrypoint",
                            "code",
                            "code_file",
                            "dependencies",
                            "execution_notes",
                            "review_focus",
                            "review_status"
                        ],
                        "additionalProperties": false
                    }
                },
                "self_review": {
                    "type": "object",
                    "properties": {
                        "review_status": { "type": "string" },
                        "summary": { "type": "string" },
                        "assumption_checks": { "type": "array", "items": { "type": "string" } },
                        "failure_modes": { "type": "array", "items": { "type": "string" } },
                        "requested_revisions": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": [
                        "review_status",
                        "summary",
                        "assumption_checks",
                        "failure_modes",
                        "requested_revisions"
                    ],
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        })))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_required_matches_properties(schema: &Value, path: &str) {
        if let Some(properties) = schema.get("properties").and_then(|value| value.as_object()) {
            let mut property_keys: Vec<String> = properties.keys().cloned().collect();
            property_keys.sort();
            let mut required_keys: Vec<String> = schema
                .get("required")
                .and_then(|value| value.as_array())
                .expect("object schema with properties must declare required")
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .expect("required entries must be strings")
                        .to_string()
                })
                .collect();
            required_keys.sort();
            assert_eq!(
                required_keys, property_keys,
                "{path}: required must list every property for strict Codex response schemas"
            );

            for (key, child) in properties {
                assert_required_matches_properties(child, &format!("{path}.{key}"));
            }
        }

        if let Some(items) = schema.get("items") {
            assert_required_matches_properties(items, &format!("{path}[]"));
        }
    }

    /// The subset of JSON Schema these strict response schemas use: type (single or
    /// list), properties + required + additionalProperties=false, and items.
    fn conforms(schema: &Value, value: &Value) -> bool {
        let type_ok = |name: &str| match name {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => false,
        };
        let typed = match schema.get("type") {
            Some(Value::String(name)) => type_ok(name),
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).any(type_ok),
            _ => true,
        };
        if !typed {
            return false;
        }
        if let (Some(object), Some(properties)) = (
            value.as_object(),
            schema.get("properties").and_then(Value::as_object),
        ) {
            let required_present = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(Value::as_str).all(|key| object.contains_key(key)))
                .unwrap_or(true);
            let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
            if !required_present || (closed && object.keys().any(|key| !properties.contains_key(key))) {
                return false;
            }
            return object
                .iter()
                .all(|(key, child)| properties.get(key).map(|s| conforms(s, child)).unwrap_or(true));
        }
        if let (Some(items), Some(schema_items)) = (value.as_array(), schema.get("items")) {
            return items.iter().all(|item| conforms(schema_items, item));
        }
        true
    }

    // cycle-b-20260918: the LabDirector orders the simulation. The schema
    // closes additionalProperties, so without this field an order could not be
    // emitted at all; null keeps a cycle without a simulator unchanged.
    #[test]
    fn lab_director_schema_takes_simulation_orders_or_null() {
        let schema = codex_output_schema("lab-director", "lab_director_requery_followup")
            .expect("lab-director requery schema");
        let orders = &schema["properties"]["simulation_orders"];
        assert!(conforms(orders, &Value::Null));
        assert!(conforms(
            orders,
            &json!([{
                "request_id": "grasp_friction_sweep",
                "simulator_backend": "mujoco",
                "interpreter_path": "C:/py/python.exe",
                "scenario": "parallel gripper lifts a box",
                "conditions": [{"factor": "friction", "levels": ["0.4", "0.8"]}],
                "seeds": [1, 2, 3],
                "episodes_per_condition": 20,
                "step_or_time_budget": "2000 physics steps",
                "emitted_columns": [{"name": "lift_success", "unit": "bool", "meaning": "box above 5 cm at end"}],
                "output_path": ".research-lab/datasets/c/simulations/grasp_friction_sweep/episodes.csv",
                "hypothesis_link": "success falls with friction iff the slip mechanism holds"
            }])
        ));
        assert!(!conforms(orders, &json!([{"request_id": "missing-the-rest"}])));
        let analyst = codex_output_schema("analyst", "pivot_followup").expect("analyst schema");
        assert!(
            analyst["properties"].get("simulation_request").is_none(),
            "the analyst no longer designs simulations"
        );
    }

    // MEASURED ON cycle-b-20260918, 2026-09-19. The analyst prompt says a
    // handoff check MUST carry the column_mapping its script reads, and this
    // schema had no such field with additionalProperties false, so no analyst
    // could send one. followup-runner-70..76 all died on "handoff check requires
    // a non-empty column_mapping" before computing anything.
    #[test]
    fn an_analyst_handoff_check_can_carry_its_column_mapping() {
        let analyst = codex_output_schema("analyst", "pivot_followup").expect("analyst schema");
        let check = &analyst["properties"]["handoff_checks"]["items"];
        let mapping = &check["properties"]["column_mapping"];
        assert_eq!(mapping["type"], json!("array"));
        assert_eq!(mapping["items"]["required"], json!(["key", "column"]));
        assert!(check["required"]
            .as_array()
            .unwrap()
            .contains(&json!("column_mapping")));
        assert_required_matches_properties(&analyst, "analyst");
    }

    // MEASURED ON cycle-b-20260918, 2026-09-18/19: the lead was chosen by the
    // most ready instrument. The projection now applies a selection only when it
    // names a landscape open problem and cites landscape papers, so the strict
    // schema must let both the lead and a replacement carry them.
    #[test]
    fn a_lead_can_carry_its_field_landscape_references() {
        let schema = codex_output_schema("lab-director", "lab_director_requery_followup")
            .expect("lab-director requery schema");
        for (path, object) in [
            ("selected_hypothesis", &schema["properties"]["selected_hypothesis"]),
            (
                "replacement_hypotheses[]",
                &schema["properties"]["replacement_hypotheses"]["items"],
            ),
        ] {
            let required = object["required"].as_array().expect("required");
            for field in ["landscape_open_problem_id", "landscape_paper_ids"] {
                assert!(object["properties"].get(field).is_some(), "{path} cannot carry {field}");
                assert!(required.contains(&json!(field)), "{path}.{field} is not required");
            }
            assert!(conforms(&object["properties"]["landscape_paper_ids"], &json!(["doi:10.1/a"])));
            assert!(conforms(&object["properties"]["landscape_paper_ids"], &Value::Null));
            assert!(conforms(&object["properties"]["landscape_open_problem_id"], &json!("op_1")));
        }
        assert_required_matches_properties(&schema, "lab-director-requery");
    }

    // cycle-b-20260919, 2026-09-19: once the expert selection is engaged the
    // lead must name the slate candidate it is, so both the lead and a
    // replacement must be able to carry it through the strict schema.
    #[test]
    fn a_lead_can_carry_its_slate_candidate_id() {
        let schema = codex_output_schema("lab-director", "lab_director_requery_followup")
            .expect("lab-director requery schema");
        for object in [
            &schema["properties"]["selected_hypothesis"],
            &schema["properties"]["replacement_hypotheses"]["items"],
        ] {
            assert!(object["properties"].get("slate_candidate_id").is_some());
            assert!(object["required"].as_array().unwrap().contains(&json!("slate_candidate_id")));
            assert!(conforms(&object["properties"]["slate_candidate_id"], &json!("cand_0")));
            assert!(conforms(&object["properties"]["slate_candidate_id"], &Value::Null));
        }
        assert_required_matches_properties(&schema, "lab-director-requery");
    }

    // A panel reviewer runs as a gatekeeper but is not a gate review: its action
    // decides the schema, and every stage schema is strict.
    #[test]
    fn expert_selection_stages_answer_in_their_own_strict_schemas_whatever_the_role() {
        for (role, action, marker) in [
            ("lab-director", "expert_field_beliefs_map", "beliefs"),
            ("lab-director", "expert_candidate_slate", "candidates"),
            ("gatekeeper", "expert_panel_review", "reviews"),
            ("lab-director", "expert_feasibility_audit", "assessments"),
        ] {
            let schema = codex_output_schema(role, action).expect(action);
            assert!(schema["properties"].get(marker).is_some(), "{action}");
            assert!(schema["properties"].get("verdict").is_none(), "{action} got the gate-review schema");
            assert_required_matches_properties(&schema, action);
        }
        // The gate review itself is unchanged.
        let gate = codex_output_schema("gatekeeper", "independent_gate_review_followup").unwrap();
        assert!(gate["properties"].get("verdict").is_some());
    }

    #[test]
    fn gatekeeper_schema_is_strict_required_complete() {
        let schema = codex_output_schema("gatekeeper", "independent_gate_review_followup")
            .expect("gatekeeper schema");
        assert_required_matches_properties(&schema, "gatekeeper");
    }

    #[test]
    fn lab_director_requery_schema_is_strict_required_complete() {
        let schema = codex_output_schema("lab-director", "lab_director_requery_followup")
            .expect("lab-director requery schema");
        assert_required_matches_properties(&schema, "lab-director-requery");
    }

    // A field the prompt demands and the schema forbids cannot be answered. This
    // asserts the two agree on the fields whose absence was measured: the
    // experiment decisions the author waits on, and the two the
    // Method-persistence rule is counted in.
    #[test]
    fn lab_director_requery_schema_carries_the_contract_fields() {
        let schema = codex_output_schema("lab-director", "lab_director_requery_followup")
            .expect("lab-director requery schema");
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("properties");
        for field in [
            "experiment_request_decisions",
            "research_problem",
            "selected_hypothesis",
            "chronicle_requests",
            "decision_status",
        ] {
            assert!(
                properties.contains_key(field),
                "the prompt demands `{field}` and the schema closes additionalProperties"
            );
        }

        let replacement = properties
            .get("replacement_hypotheses")
            .and_then(|value| value.get("items"))
            .and_then(|value| value.get("properties"))
            .and_then(Value::as_object)
            .expect("replacement_hypotheses items");
        for field in ["research_problem_question", "methods_tried", "retires_the_question"] {
            assert!(
                replacement.contains_key(field),
                "the Method-persistence rule is counted in `{field}`, so an entry must be able to carry it"
            );
        }

        let requery = properties
            .get("requery_decision")
            .and_then(|value| value.get("enum"))
            .and_then(Value::as_array)
            .expect("requery_decision enum");
        assert!(
            requery.iter().any(|value| value == "defer_for_chronicle"),
            "the prompt instructs requery_decision=defer_for_chronicle"
        );
    }
}

/// Adds `handoff_readiness` to the analyst schema after the literal is built:
/// the literal is at serde_json's macro recursion limit, and one more property
/// inside it stops the crate compiling.
///
/// MEASURED ON cycle-a-20260919, 2026-09-28: this strict schema had no
/// way to state readiness. The harness read it from `analysis_design_memo`,
/// which the schema forbids, and filled in `ready_for_runner: false` when it was
/// absent -- so all 163 handoffs on the cycle were "not ready", including
/// analysts whose summaries said "the handoff is ready", and every lab-runner
/// waited on a handoff that could not exist.
fn with_handoff_readiness(mut schema: Value) -> Value {
    schema["properties"]["handoff_readiness"] = json!({
        "type": "object",
        "description": "Your own verdict on whether a lab-runner may execute this handoff now. true only when every input the validation_code_blueprints read already exists and the design is final; false when you are deferring (no matching bundle, a missing capability, an unresolved design question), with the reason. A runner will not execute a handoff that is not ready_for_runner.",
        "required": ["ready_for_runner", "reason"],
        "properties": {
            "ready_for_runner": { "type": "boolean" },
            "reason": { "type": "string" }
        },
        "additionalProperties": false
    });
    if let Some(required) = schema["required"].as_array_mut() {
        required.push(json!("handoff_readiness"));
    }
    schema
}
