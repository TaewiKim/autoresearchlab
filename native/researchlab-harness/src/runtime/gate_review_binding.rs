use anyhow::Result;
use serde_json::{json, Value};
use std::fs;

use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{lane_role_plan_path, read_json, write_json};

pub(super) fn attach_analysis_contract(handoff: &mut Value, plan: Option<&Value>) {
    if let Some(binding) = plan.and_then(|value| value.pointer("/planner_metadata/analysis_contract")) {
        handoff["analysis_contract"] = binding.clone();
        // The explicit current ID declares the intended primary claim. Copy
        // its canonical text mechanically rather than requiring an LLM to
        // reproduce prose verbatim. Preserve authored targets for audit, and
        // never rewrite an old/different primary ID or executed script.
        if handoff.get("primary_hypothesis_id") == binding.get("contract_id") {
            if let Some(statement) = binding.get("statement").and_then(Value::as_str) {
                let mut targets = handoff.get("validation_targets").and_then(Value::as_array).cloned().unwrap_or_default();
                if !targets.iter().any(|target| target.get("claim_text").and_then(Value::as_str) == Some(statement)) {
                    targets.insert(0, json!({"target_hypothesis_id": binding["contract_id"], "claim_text": statement, "projection_source": "canonical_analysis_contract"}));
                    handoff["validation_targets"] = json!(targets);
                }
            }
        }
    }
}

fn rebind(plan: &mut Value, gate: &Value, hypothesis: &Value) -> bool {
    let target = plan.pointer("/planner_metadata/target_rubric")
        .and_then(Value::as_str).unwrap_or("");
    let Some(action) = gate.get("recommended_followup_actions").and_then(Value::as_array)
        .and_then(|actions| actions.iter().find(|action|
            action.get("preferred_role").and_then(Value::as_str) == Some("gatekeeper")
            && action.get("target_rubric").and_then(Value::as_str) == Some(target))) else { return false; };
    let key = action.get("gate_review_lead_key").and_then(Value::as_str).unwrap_or("");
    let validation = action.get("latest_validation_lane_id").cloned().unwrap_or(Value::Null);
    if key.is_empty() { return false; }
    let selected = hypothesis.get("selected_hypothesis").or_else(|| hypothesis.get("lead_hypothesis")).unwrap_or(hypothesis);
    if let (Some(reviewed), Some(current)) = (
        gate.pointer("/current_hypothesis_identity/primary_family").and_then(Value::as_str),
        selected.get("primary_family").and_then(Value::as_str),
    ) {
        if reviewed != current { return false; }
    }
    let Some(statement) = selected.get("statement").and_then(Value::as_str) else { return false; };
    if plan.pointer("/planner_metadata/gate_review_lead_key").and_then(Value::as_str) == Some(key)
        && plan.pointer("/planner_metadata/latest_validation_lane_id") == Some(&validation)
        && plan.pointer("/planner_metadata/current_lead_under_review/statement").and_then(Value::as_str) == Some(statement) {
        return false;
    }
    plan["assigned_hypotheses"] = json!([statement]);
    plan["followup_description"] = action.get("description").cloned().unwrap_or(Value::Null);
    for field in ["gate_review_lead_key", "latest_validation_lane_id", "latest_validation_summary",
        "candidate_hypotheses", "validation_results", "previous_review_context", "previous_review_summary",
        "chronicle_research_context", "reference_literature_summary", "reviewer_must_read_context",
        "lab_director_blocker_review_requests", "review_standard", "review_mode", "challenge_questions"] {
        plan["planner_metadata"][field] = action.get(field).cloned().unwrap_or(Value::Null);
    }
    plan["planner_metadata"]["current_lead_under_review"] = selected.clone();
    plan["planner_metadata"]["review_action"] = action.clone();
    plan["planner_metadata"]["blocker_reasons"] = json!([]);
    true
}

pub(super) fn bind_current_review(paths: &AppPaths, contract: &LaneContract, plan: Option<Value>) -> Result<Option<Value>> {
    if contract.role == "analyst" {
        let script = paths.project_root.join("src/policy/analysis_contract.js");
        if script.is_file() {
            let status = std::process::Command::new("node").arg(script)
                .arg(&paths.project_root).arg(&contract.cycle_id).arg(&contract.lane_id)
                .current_dir(&paths.project_root).output()?;
            anyhow::ensure!(status.status.success(), "analysis contract binding failed: {}", String::from_utf8_lossy(&status.stderr));
            return Ok(Some(read_json(&lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id))?));
        }
    }
    if contract.role != "gatekeeper" { return Ok(plan); }
    let Some(mut plan) = plan else { return Ok(None); };
    let state = paths.runtime_root.join("state");
    let Ok(gate) = read_json(&state.join(format!("{}-gate-review.json", contract.cycle_id))) else { return Ok(Some(plan)); };
    let Ok(hypothesis) = read_json(&state.join(format!("{}-lab-director-hypothesis.json", contract.cycle_id))) else { return Ok(Some(plan)); };
    if rebind(&mut plan, &gate, &hypothesis) {
        write_json(&lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id), &plan)?;
        let objective = plan.get("objective").and_then(Value::as_str).unwrap_or("");
        let statement = plan.pointer("/planner_metadata/current_lead_under_review/statement").and_then(Value::as_str).unwrap_or("");
        let description = plan.get("followup_description").and_then(Value::as_str).unwrap_or("");
        fs::write(&contract.task_file, format!("# Current independent review\n\n{objective}\n\n## Current lead\n{statement}\n\n## Review assignment\n{description}\n\nRead planner_metadata.current_lead_under_review and latest_validation_summary. Score only this lead and its bound validation artifacts. Retired-family reviews are historical context, not active findings. Do not waive actual current scientific blockers.\n"))?;
    }
    Ok(Some(plan))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaching_contract_preserves_authored_hypothesis_for_preflight_comparison() {
        let plan = json!({"planner_metadata": {"analysis_contract": {"contract_id": "current", "statement": "each policy vs retrieval"}}});
        let mut handoff = json!({"primary_hypothesis_id": "old", "validation_targets": [{"claim_text": "mean policy vs BC"}]});
        attach_analysis_contract(&mut handoff, Some(&plan));
        assert_eq!(handoff["analysis_contract"]["contract_id"], "current");
        assert_eq!(handoff["primary_hypothesis_id"], "old");
        assert_eq!(handoff["validation_targets"][0]["claim_text"], "mean policy vs BC");
    }

    #[test]
    fn exact_current_id_gets_a_canonical_target_without_erasing_authored_text() {
        let plan = json!({"planner_metadata": {"analysis_contract": {"contract_id": "current", "statement": "each policy vs retrieval"}}});
        let mut handoff = json!({"primary_hypothesis_id": "current", "validation_targets": [{"claim_text": "shortened author description"}]});
        attach_analysis_contract(&mut handoff, Some(&plan));
        assert_eq!(handoff["validation_targets"][0]["claim_text"], "each policy vs retrieval");
        assert_eq!(handoff["validation_targets"][1]["claim_text"], "shortened author description");
        attach_analysis_contract(&mut handoff, Some(&plan));
        assert_eq!(handoff["validation_targets"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn queued_review_is_rebound_to_current_lead_and_executed_analysis() {
        let mut plan = json!({"assigned_hypotheses": ["retired support-removal claim"],
            "planner_metadata": {"target_rubric": "novelty", "gate_review_lead_key": "old",
                "latest_validation_lane_id": "runner-232", "previous_review_context": {"unresolved_blockers": ["old claim failed"]}}});
        let gate = json!({"recommended_followup_actions": [{"preferred_role": "gatekeeper", "target_rubric": "novelty",
            "gate_review_lead_key": "new", "latest_validation_lane_id": "runner-current", "description": "review factorial",
            "validation_results": {"validation_results": [{"lane_id": "runner-current"}]},
            "previous_review_context": {"unresolved_blockers": []}}]});
        let hypothesis = json!({"selected_hypothesis": {"statement": "current factorial claim", "primary_family": "factorial"}});
        assert!(rebind(&mut plan, &gate, &hypothesis));
        assert_eq!(plan["assigned_hypotheses"], json!(["current factorial claim"]));
        assert_eq!(plan["planner_metadata"]["latest_validation_lane_id"], "runner-current");
        assert_eq!(plan["planner_metadata"]["current_lead_under_review"]["primary_family"], "factorial");
        assert_eq!(plan["planner_metadata"]["previous_review_context"]["unresolved_blockers"], json!([]));
        assert!(!rebind(&mut plan, &gate, &hypothesis));
    }

    #[test]
    fn missing_current_validation_rebinds_the_claim_without_inventing_evidence() {
        let mut plan = json!({"planner_metadata": {"target_rubric": "novelty"}});
        let gate = json!({"recommended_followup_actions": [{"preferred_role": "gatekeeper", "target_rubric": "novelty", "gate_review_lead_key": "new"}]});
        assert!(rebind(&mut plan, &gate, &json!({"statement": "current claim"})));
        assert_eq!(plan["assigned_hypotheses"], json!(["current claim"]));
        assert!(plan["planner_metadata"]["latest_validation_lane_id"].is_null());
        assert!(plan["planner_metadata"]["latest_validation_summary"].is_null());
    }

    #[test]
    fn a_lead_change_after_gate_refresh_cannot_relabel_old_evidence() {
        let mut plan = json!({"planner_metadata": {"target_rubric": "novelty"}});
        let before = plan.clone();
        let gate = json!({"current_hypothesis_identity": {"primary_family": "retired"},
            "recommended_followup_actions": [{"preferred_role": "gatekeeper", "target_rubric": "novelty",
                "gate_review_lead_key": "old", "latest_validation_lane_id": "runner-old"}]});
        assert!(!rebind(&mut plan, &gate, &json!({"selected_hypothesis": {"statement": "new claim", "primary_family": "current"}})));
        assert_eq!(plan, before);
    }
}
