#![allow(unused_imports)]
use super::*;

pub(crate) fn open_independent_gate_review_for_rubric(
    paths: &AppPaths,
    cycle_id: &str,
    target_rubric: &str,
) -> Result<bool> {
    let target_rubric = target_rubric.trim();
    if target_rubric.is_empty() {
        return Ok(false);
    }
    let mut lane_ids = Vec::new();
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        lane_ids.extend(lane_statuses.into_iter().filter_map(|lane| {
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(
                status,
                "completed" | "failed" | "failed_blocking" | "failed_non_blocking" | "aborted"
            ) {
                return None;
            }
            lane.get("lane_id")
                .and_then(Value::as_str)
                .filter(|lane_id| lane_id.starts_with("followup-gatekeeper-"))
                .map(ToString::to_string)
        }));
    } else if let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        for entry in entries.flatten() {
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id.starts_with("followup-gatekeeper-") {
                continue;
            }
            let lane_dir = entry.path();
            if lane_dir.join("final-status.json").exists() {
                continue;
            }
            lane_ids.push(lane_id);
        }
    }

    for lane_id in lane_ids {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &lane_id);
        let Some(role_plan) = read_role_plan_if_compact(&role_plan_path)? else {
            continue;
        };
        let action_type = role_plan
            .get("action_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if action_type != "independent_gate_review_followup" {
            continue;
        }
        let rubric = role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("target_rubric"))
            .or_else(|| role_plan.get("target_rubric"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if rubric == target_rubric {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn inject_gate_reject_followup_actions(
    paths: &AppPaths,
    cycle_id: &str,
    ranked_actions: &mut Vec<Value>,
) -> Result<()> {
    if !explicit_hypothesis_gate_failed(paths, cycle_id)? {
        return Ok(());
    }
    let completed_chronicle_gate_deliberation =
        completed_chronicle_gate_deliberation_exists(paths, cycle_id);
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
                ranked_actions,
                "analyst-handoff",
                "latest-executable-analyst-handoff",
                handoff_path,
                handoff_payload,
                285,
                "latest executable analyst handoff has not been converted into a lab-runner validation pass",
            )?;
        }
    }
    if !completed_chronicle_gate_deliberation
        && !ranked_actions.iter().any(|action| {
            action.get("type").and_then(Value::as_str)
                == Some("chronicle_gate_deliberation_followup")
        })
    {
        ranked_actions.push(json!({
            "brief_id": "hypothesis-gate-chronicle-deliberation",
            "type": "chronicle_gate_deliberation_followup",
            "preferred_role": "chronicle",
            "target_rubric": "hypothesis_strategy",
            "priority": "critical",
            "priority_score": 240,
            "description": "Hypothesis gate failed. Before LabDirector chooses a new plan, conduct a deep Chronicle deliberation over the Gatekeeper review: reconstruct the criticism, debate at least three mechanism-level hypothesis families, identify the same-dataset baseline and missing evidence, and produce decision-ready options for LabDirector rather than a direct validation patch.",
            "candidate_hypotheses": [],
            "recovery_reason": "hypothesis_gate_failed_chronicle_deliberation_required",
        }));
    }
    if completed_chronicle_gate_deliberation
        && !ranked_actions.iter().any(|action| {
            action.get("brief_id").and_then(Value::as_str)
                == Some("hypothesis-gate-labdirector-requery")
        })
    {
        ranked_actions.push(json!({
            "brief_id": "hypothesis-gate-labdirector-requery",
            "type": "gate_restart_followup",
            "preferred_role": "lab-director",
            "target_rubric": "hypothesis_strategy",
            "priority": "high",
            "priority_score": 230,
            "description": "Hypothesis gate failed. After reading Chronicle's gate-deliberation memo, make the research-wide decision: rerank at least three mechanism-level hypothesis families, state keep/replace/restart, and bind the selected family to baseline, variables, confounders, comparators, and transportability plan.",
            "candidate_hypotheses": [],
            "recovery_reason": "hypothesis_gate_failed_labdirector_requery_required",
            "requires_completed_chronicle_gate_deliberation": true,
        }));
    }
    Ok(())
}

// OWNER DECISION 2026-07-10/11 ("change the pivot condition", option D): the JS gate
// followups already honour the hypothesis-progress ledger's supersession
// decision, but the RUST-side dispatchers (the synthesized hypothesis-gate
// restart action and the strategy-pivot requery) still created "restart from
// scratch" director lanes without consulting it. Measured on cycle-g-v56: 60
// restart lanes were created AFTER the JS gating shipped, churning the lead
// (H-VDB -> H-BBRV -> H-CUTE) until the gatekeeper followup budget hit its
// 192 exempt ceiling and independent review stopped. Returns Some(reason)
// when the NEWEST supersession decision in the append-only ledger is a DENY
// (the protected lead is still improving, or inside its strong-validation
// commit window). A missing/unreadable ledger returns None — a fresh cycle
// has no ledger yet and must be able to restart freely.
