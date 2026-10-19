use serde_json::{json, Value};

use crate::core::support::now_iso;

pub(crate) fn critical_questions_for_reports(report_items: &[&Value]) -> Vec<String> {
    let mut questions = Vec::new();
    let claim_delta_count = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("claim_delta_count"))
                .and_then(Value::as_u64)
        })
        .sum::<u64>();
    let open_question_count = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("open_question_count"))
                .and_then(Value::as_u64)
        })
        .sum::<u64>();
    let recommendation_count = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("recommended_action_count"))
                .and_then(Value::as_u64)
        })
        .sum::<u64>();

    if claim_delta_count == 0 {
        questions.push(
            "Which specific hypotheses failed to produce claim deltas, and what missing evidence would most likely change that outcome?".to_string(),
        );
    }
    if open_question_count > 0 {
        questions.push(
            "Which open questions materially weaken the current conclusion, and which lanes should resolve them first?".to_string(),
        );
    }
    if recommendation_count > claim_delta_count.max(1) {
        questions.push(
            "Why do recommended actions still dominate the signal, and which unresolved confounds or evidence gaps are driving that?".to_string(),
        );
    }

    let weak_lanes = report_items
        .iter()
        .filter_map(|item| item.get("payload"))
        .filter(|payload| {
            payload
                .get("claim_delta_count")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == 0
        })
        .filter_map(|payload| payload.get("lane_id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if !weak_lanes.is_empty() {
        questions.push(format!(
            "Chronicle should justify why lanes [{}] did not strengthen the research conclusion and what stronger evidence should be requested next.",
            weak_lanes.join(", ")
        ));
    }

    if questions.is_empty() {
        questions.push(
            "Which parts of the current evidence base are strongest, and where should LabDirector remain skeptical before promoting the conclusion?".to_string(),
        );
    }

    questions.push(
        "Do the current hypotheses merely restate known baseline relationships, and which alternative mechanisms, moderators, partitions, measurement channels, or threshold effects would make the research materially more original?".to_string(),
    );

    questions
}

fn brainstorm_hypothesis_frames(report_items: &[&Value]) -> Vec<Value> {
    let lane_ids = report_items
        .iter()
        .filter_map(|item| item.get("payload"))
        .filter_map(|payload| payload.get("lane_id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let scope = if lane_ids.is_empty() {
        "current cycle evidence"
    } else {
        "current cycle evidence and weak lanes"
    };

    vec![
        json!({
            "frame": "alternative-mechanism",
            "question": format!("What causal, measurement, or system mechanism beyond the obvious baseline could explain the signal observed in {scope}?"),
            "prompt": "Infer the current state of the art from the collected papers and the knowledge graph, then generate alternative mechanisms, measurement channels, cohort partitions, or technical artifacts that go beyond that baseline.",
            "preferred_role": "analyst",
            "target_rubric": "novelty",
        }),
        json!({
            "frame": "moderator-map",
            "question": "Which moderators could split the result into more original sub-findings?",
            "prompt": "Use the paper set and the knowledge graph to infer the current state of the art, then propose domain-appropriate moderators, cohort partitions, measurement strata, or context variables that create a materially more original result.",
            "preferred_role": "analyst",
            "target_rubric": "novelty",
        }),
        json!({
            "frame": "partition-and-threshold",
            "question": "Which thresholds, partitions, or non-linear regimes could reveal a stronger and less obvious pattern?",
            "prompt": "Infer the state-of-the-art baseline from the current literature graph, then search for threshold effects, nonlinear regimes, lag structure, subgroup partitions, or measurement-defined strata that surpass it.",
            "preferred_role": "scout",
            "target_rubric": "novelty",
        }),
        json!({
            "frame": "counterfactual-and-rival",
            "question": "What rival explanation would survive if the current lead hypothesis is wrong?",
            "prompt": "Use the papers and reasoning graph to infer the strongest existing explanations, then list rival explanations that should be tested before treating the current result as genuinely novel.",
            "preferred_role": "analyst",
            "target_rubric": "novelty",
        }),
        json!({
            "frame": "high-upside-bet",
            "question": "What is the highest-upside but still plausible hypothesis family that could materially raise originality if validated?",
            "prompt": "Infer the state-of-the-art ceiling from the collected paper data and the knowledge graph, then suggest one high-upside research angle tied to policy relevance, equity, or heterogeneous treatment effects that could clear that bar.",
            "preferred_role": "scout",
            "target_rubric": "novelty",
        }),
    ]
}

pub(crate) fn build_chronicle_response(
    cycle_id: &str,
    report_items: &[&Value],
    questions: &[String],
) -> Value {
    let strongest_lanes = report_items
        .iter()
        .filter_map(|item| item.get("payload"))
        .filter(|payload| {
            payload
                .get("claim_delta_count")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
        })
        .map(|payload| {
            json!({
                "lane_id": payload.get("lane_id").cloned().unwrap_or(Value::Null),
                "claim_delta_count": payload.get("claim_delta_count").cloned().unwrap_or(Value::Null),
                "open_question_count": payload.get("open_question_count").cloned().unwrap_or(Value::Null),
                "rubric_targets": payload.get("rubric_targets").cloned().unwrap_or_else(|| json!([])),
            })
        })
        .collect::<Vec<_>>();
    let skeptical_points = report_items
        .iter()
        .filter_map(|item| item.get("payload"))
        .filter(|payload| {
            payload
                .get("open_question_count")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
                || payload
                    .get("recommended_action_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > payload
                        .get("claim_delta_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
        })
        .map(|payload| {
            let lane_id = payload
                .get("lane_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let open_questions = payload
                .get("open_question_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let recommended_actions = payload
                .get("recommended_action_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            format!(
                "{lane_id}: open_questions={open_questions}, recommended_actions={recommended_actions}"
            )
        })
        .collect::<Vec<_>>();
    let required_evidence_types = if strongest_lanes.is_empty() {
        vec![
            "robust_analysis_lane".to_string(),
            "literature_backed_rationale".to_string(),
            "confound_or_sensitivity_check".to_string(),
        ]
    } else {
        vec![
            "role_diverse_validation".to_string(),
            "claim_to_evidence_trace".to_string(),
            "moderator_or_confound_resolution".to_string(),
        ]
    };
    let mut must_resolve_blockers = Vec::new();
    if strongest_lanes.is_empty() {
        must_resolve_blockers.push(
            "no lane has yet produced a strong enough claim delta to justify confident promotion"
                .to_string(),
        );
    }
    if !skeptical_points.is_empty() {
        must_resolve_blockers.push(
            "some lanes still produce more unresolved questions or actions than stable evidence"
                .to_string(),
        );
    }
    if must_resolve_blockers.is_empty() {
        must_resolve_blockers.push(
            "claim promotion still requires stronger cross-role evidence before LabDirector should trust the conclusion"
                .to_string(),
        );
    }
    let brainstorm = brainstorm_hypothesis_frames(report_items);

    json!({
        "ts": now_iso(),
        "cycle_id": cycle_id,
        "type": "chronicle_response",
        "summary": if skeptical_points.is_empty() {
            "Chronicle sees some supported progress, but recommends maintaining skepticism around claim promotion until stronger lane diversity and fewer unresolved actions are visible."
        } else {
            "Chronicle confirms partial progress but agrees that unresolved evidence gaps still block confident claim promotion."
        },
        "requested_questions": questions,
        "strongest_evidence_lanes": strongest_lanes,
        "skeptical_points": skeptical_points,
        "required_evidence_types": required_evidence_types,
        "must_resolve_blockers": must_resolve_blockers,
        "brainstorm": {
            "method": "structured cross-paper hypothesis brainstorming",
            "goal": "increase originality by forcing alternative mechanisms, moderators, partitions, threshold effects, rival explanations, one high-upside bet, and recombinations across papers",
            "cross_paper_reasoning": {
                "goal_conditioned_retrieval": "retrieve papers against the scientist objective and preferences, not undirected paper volume",
                "structured_critique": ["correctness", "novelty", "quality"],
                "deep_verification": "assumption-tree",
                "comparative_reasoning": "pairwise scientific debate over absolute scoring when ranking close hypotheses",
                "similarity_aware_competition": "compare nearby hypotheses more often so small scientific differences are exposed",
                "recombination": "combine compatible evidence fragments across papers into new hypothesis families"
            },
            "frames": brainstorm,
        },
        "requested_next_focus": [
            "trace each promoted claim to at least one robust analysis lane and one literature-backed rationale",
            "reduce open questions before treating the current conclusion as stable",
            "ask for explicit confound and robustness explanations when action counts remain high",
            "challenge whether the current hypothesis set is too obvious, and search for more original moderator, partition, equity, or threshold explanations",
        ],
    })
}
