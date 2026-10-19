#![allow(unused_imports)]
use super::*;

pub(crate) fn spawn_direct_researcher_labdirector_followup(
    paths: &AppPaths,
    cycle_id: &str,
    objective: &str,
    latest_user_message: &str,
    latest_user_item: Option<&Value>,
) -> Result<Vec<Value>> {
    let trimmed = latest_user_message.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let description = format!(
        "Direct researcher instruction for LabDirector adjudication: {trimmed}\n\nReturn the answer only in this lane output/result JSON. Do not write or modify lab-director-research-notes for this adjudication. Compare the named evidence sources directly; if the instruction asks for a lead decision, choose the active scientific lead and explain validation feasibility, endpoint/metadata availability, novelty delta over same-dataset baseline, falsifiability, and closure/benchmark-only status."
    );
    let task_body = followup_task_markdown(
        cycle_id,
        objective,
        "lab-director",
        "direct_researcher_instruction",
        &description,
        &[],
    );
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
        objective,
        "direct_researcher_instruction",
        &description,
        "lab_director_requery_followup",
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "direct_researcher_instruction",
            "preferred_role": "lab-director",
            "effective_role": "lab-director",
            "direct_researcher_instruction": trimmed,
            "direct_researcher_message": latest_user_item.cloned().unwrap_or_else(|| json!({})),
            "notes_write_policy": "forbid_for_this_adjudication",
            "research_notes_policy": {
                "may_read_existing_notes": true,
                "must_not_write_or_modify_notes": true,
                "decision_location": "lane_output_and_result_json_only"
            },
            "minimum_output_fields": [
                "decision",
                "active_lead",
                "rationale",
                "validation_feasibility",
                "endpoint_metadata_availability",
                "novelty_delta",
                "falsifiability",
                "benchmark_or_closure_status",
                "next_actions"
            ]
        }),
    )?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_direct_researcher_followup_spawned",
        json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "contract_path": contract_path,
            "role_plan_path": role_plan_path,
            "notes_write_policy": "forbid_for_this_adjudication",
            "ts": now_iso(),
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "lab-director",
        "contract_path": contract_path,
        "source_brief_id": "direct_researcher_instruction",
        "role_plan_path": role_plan_path,
        "notes_write_policy": "forbid_for_this_adjudication",
    })])
}

pub(crate) fn supervisor_instruction_text(item: &Value) -> String {
    let payload = item.get("payload").unwrap_or(item);
    payload
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("requested_action")
                .and_then(|value| value.get("prompt"))
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("issue_code").and_then(Value::as_str))
        .unwrap_or("Supervisor process escalation requires LabDirector adjudication.")
        .trim()
        .to_string()
}

pub(crate) fn open_followup_action_from_source_lane(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    source_brief_id: &str,
    legacy_source_brief_id: Option<&str>,
) -> Result<Option<String>> {
    if source_brief_id.trim().is_empty() {
        return Ok(None);
    }
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        let role_lane_fragment = role.replace('-', "-");
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if lane_id.is_empty() {
                continue;
            }
            let lane_role_matches = lane.get("role").and_then(Value::as_str) == Some(role);
            if !lane_role_matches
                && !lane_id.starts_with(&role_lane_fragment)
                && !lane_id.starts_with(&format!("followup-{role_lane_fragment}"))
            {
                continue;
            }
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(status, "completed" | "failed" | "aborted" | "cancelled") {
                continue;
            }
            let lane_dir = lane_root(paths, cycle_id, lane_id);
            let role_plan_path = lane_dir.join("role-plan.json");
            if !role_plan_path.exists() {
                continue;
            }
            let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
                continue;
            };
            if role_plan.role.as_deref() != Some(role)
                || role_plan.action_type.as_deref() != Some(action_type)
            {
                continue;
            }
            let source_matches = role_plan.source_brief_id.as_deref() == Some(source_brief_id)
                || legacy_source_brief_id
                    .map(|legacy| role_plan.source_brief_id.as_deref() == Some(legacy))
                    .unwrap_or(false);
            if source_matches {
                return Ok(Some(lane_id.to_string()));
            }
        }
        return Ok(None);
    }
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let role_plan_path = lane_dir.join("role-plan.json");
        if !role_plan_path.exists() {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some(role)
            || role_plan.action_type.as_deref() != Some(action_type)
        {
            continue;
        }
        let source_matches = role_plan.source_brief_id.as_deref() == Some(source_brief_id)
            || legacy_source_brief_id
                .map(|legacy| role_plan.source_brief_id.as_deref() == Some(legacy))
                .unwrap_or(false);
        if !source_matches {
            continue;
        }
        let final_status_path = lane_dir.join("final-status.json");
        if final_status_path.exists() {
            let Some(final_status) = read_lane_final_status(&final_status_path)? else {
                continue;
            };
            if matches!(
                final_status.get("status").and_then(Value::as_str),
                Some("completed" | "failed" | "aborted" | "cancelled")
            ) {
                continue;
            }
        }
        return Ok(Some(lane_id));
    }
    Ok(None)
}

pub(crate) fn spawn_supervisor_labdirector_followup(
    paths: &AppPaths,
    cycle_id: &str,
    objective: &str,
    supervisor_item: &Value,
) -> Result<Vec<Value>> {
    let payload = supervisor_item.get("payload").unwrap_or(supervisor_item);
    let message = supervisor_instruction_text(supervisor_item);
    if message.trim().is_empty() {
        return Ok(Vec::new());
    }
    let issue_code = payload
        .get("issue_code")
        .and_then(Value::as_str)
        .unwrap_or("supervisor_process_escalation");
    let severity = payload
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("process_attention");
    let source_brief_id = format!("supervisor-instruction-{issue_code}");
    if issue_code == "gate_score_stagnation"
        && gatekeeper_pending_rubric_reviews_exist(paths, cycle_id)?
    {
        append_event(
            &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
            "labdirector_supervisor_followup_skipped_gatekeeper_first",
            json!({
                "cycle_id": cycle_id,
                "issue_code": issue_code,
                "source_brief_id": source_brief_id,
                "reason": "gate_score_stagnation_requires_pending_gatekeeper_rubric_review_before_labdirector_requery",
                "supervisor_scope": "process_escalation_only",
                "ts": now_iso(),
            }),
        )?;
        return Ok(Vec::new());
    }
    if let Some(existing_lane_id) = open_followup_action_from_source_lane(
        paths,
        cycle_id,
        "lab-director",
        "lab_director_requery_followup",
        &source_brief_id,
        Some("supervisor_process_escalation"),
    )? {
        append_event(
            &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
            "labdirector_supervisor_followup_skipped_existing",
            json!({
                "cycle_id": cycle_id,
                "existing_lane_id": existing_lane_id,
                "issue_code": issue_code,
                "source_brief_id": source_brief_id,
                "supervisor_scope": "process_escalation_only",
                "ts": now_iso(),
            }),
        )?;
        return Ok(Vec::new());
    }
    let description = format!(
        "Supervisor process escalation for LabDirector adjudication: issue_code={issue_code}, severity={severity}. Message: {message}\n\nRole boundary: Supervisor is reporting a process/evidence-routing stall only and is not authoring an analysis plan, dataset choice, workflow choice, or scientific conclusion. LabDirector must inspect the current evidence state from bounded context refs, author the scientific corrective decision, update LabDirector research notes, and assign the next role if more evidence is warranted."
    );
    let task_body = followup_task_markdown(
        cycle_id,
        objective,
        "lab-director",
        "supervisor_process_escalation",
        &description,
        &[],
    );
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
        objective,
        &source_brief_id,
        &description,
        "lab_director_requery_followup",
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "supervisor_process_escalation",
            "preferred_role": "lab-director",
            "effective_role": "lab-director",
            "supervisor_scope": "process_escalation_only",
            "supervisor_must_not_author_analysis_plan": true,
            "lab_director_must_author_research_instruction": true,
            "supervisor_instruction": payload.clone(),
            "research_notes_policy": {
                "may_read_existing_notes": true,
                "must_update_notes_with_decision": true,
                "decision_location": "lab_director_research_notes_and_lane_result"
            },
            "minimum_output_fields": [
                "decision_status",
                "requery_decision",
                "summary",
                "rationale",
                "selected_hypothesis",
                "validation_changes",
                "next_actions"
            ]
        }),
    )?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_supervisor_followup_spawned",
        json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "contract_path": contract_path,
            "role_plan_path": role_plan_path,
            "issue_code": issue_code,
            "source_brief_id": source_brief_id,
            "supervisor_scope": "process_escalation_only",
            "ts": now_iso(),
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "lab-director",
        "contract_path": contract_path,
        "source_brief_id": source_brief_id,
        "role_plan_path": role_plan_path,
        "supervisor_scope": "process_escalation_only",
    })])
}

pub(crate) fn gatekeeper_pending_rubric_reviews_exist(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
    if !gate_review_path.exists() {
        return Ok(false);
    }
    let gate_review = read_json(&gate_review_path)?;
    Ok(gate_review
        .get("gatekeeper_pending_rubrics")
        .and_then(Value::as_array)
        .map(|rubrics| {
            rubrics.iter().any(|rubric| {
                rubric
                    .as_str()
                    .map(|item| !item.trim().is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false))
}

/// Every completed director lane's answer, filtered by ROLE and by nothing else.
///
/// There used to be an allowlist of action types here -- in two copies, a
/// primary branch and a fallback, which is how this repo loses changes. It was
/// the reason cycle-g-v91 stood still: three `blocking_lane_recovery_planning`
/// lanes each answered with a precise plan ("dispatch exactly one replacement
/// scout to review and finalize scout-02's existing 21-candidate queue with a
/// fresh hash-matched journal; do not rerun search"), and all three were dropped
/// because the action type was not one of two literals. The cycle sat at
/// `running: 0, pending: 15` for six hours with the decision that would have
/// moved it sitting in a result file.
///
/// The first fix added a third literal to the list. That was the wrong shape of
/// fix: it repaired one action type and left the next one to fail the same way,
/// silently, whenever somebody adds a director action and does not know this
/// list exists. So the list is gone.
///
/// Nothing is lost by removing it. `next_actions` is a REQUIRED field of the
/// lab-director output contract, so it is what every director lane emits
/// whatever it was opened for; the role check above keeps non-director lanes
/// out, and the consumer already skips a payload that carries no `next_actions`.
/// Filtering on top of that only decided which of the director's answers were
/// allowed to be heard.
pub(crate) fn completed_labdirector_requery_payloads(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Vec<(String, Value)>> {
    let mut latest_candidate: Option<(DateTime<Utc>, String, PathBuf)> = None;
    if let Some(lanes) =
        completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, "lab-director")?
    {
        for lane in lanes {
            let role_plan_path = lane.lane_dir.join("role-plan.json");
            let result_path = lane
                .result_path
                .clone()
                .unwrap_or_else(|| lane.lane_dir.join("result.json"));
            if !role_plan_path.exists() || !result_path.exists() {
                continue;
            }
            let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
                continue;
            };
            if role_plan.role.as_deref() != Some("lab-director") {
                continue;
            }
            let completed_at = lane.completed_at.or_else(|| {
                let final_status_path = lane.lane_dir.join("final-status.json");
                fs::metadata(&final_status_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .map(DateTime::<Utc>::from)
            });
            let Some(completed_at) = completed_at else {
                continue;
            };
            if latest_candidate
                .as_ref()
                .map(|(current_at, _, _)| completed_at > *current_at)
                .unwrap_or(true)
            {
                latest_candidate = Some((completed_at, lane.lane_id, result_path));
            }
        }
        let Some((_, lane_id, result_path)) = latest_candidate else {
            return Ok(Vec::new());
        };
        if fs::metadata(&result_path)?.len() > 5 * 1024 * 1024 {
            return Ok(Vec::new());
        }
        let result = read_json(&result_path)?;
        let payload = result
            .get("extracted_json")
            .filter(|value| value.is_object())
            .cloned()
            .or_else(|| {
                result
                    .get("lab_director_requery")
                    .filter(|value| value.is_object())
                    .cloned()
            });
        return Ok(payload
            .map(|payload| vec![(lane_id, payload)])
            .unwrap_or_default());
    }
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.contains("lab-director") {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !role_plan_path.exists() || !final_status_path.exists() || !result_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("lab-director") {
            continue;
        }
        let Some(completed_at) = final_status_completed_at(&final_status_path, &final_status)
        else {
            continue;
        };
        if latest_candidate
            .as_ref()
            .map(|(current_at, _, _)| completed_at > *current_at)
            .unwrap_or(true)
        {
            latest_candidate = Some((completed_at, lane_id, result_path));
        }
    }
    let Some((_, lane_id, result_path)) = latest_candidate else {
        return Ok(Vec::new());
    };
    if fs::metadata(&result_path)?.len() > 5 * 1024 * 1024 {
        return Ok(Vec::new());
    }
    let result = read_json(&result_path)?;
    let payload = result
        .get("extracted_json")
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| {
            result
                .get("lab_director_requery")
                .filter(|value| value.is_object())
                .cloned()
        });
    Ok(payload
        .map(|payload| vec![(lane_id, payload)])
        .unwrap_or_default())
}

pub(crate) fn labdirector_requery_payload_has_hypothesis(payload: &Value) -> bool {
    let selected_statement = payload
        .get("selected_hypothesis")
        .and_then(|item| item.get("statement"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .is_some();
    let replacement_hypotheses = payload
        .get("replacement_hypotheses")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    selected_statement || replacement_hypotheses
}

pub(crate) fn final_status_completed_at(
    final_status_path: &Path,
    final_status: &Value,
) -> Option<DateTime<Utc>> {
    final_status
        .get("completed_at")
        .and_then(Value::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
        .or_else(|| {
            fs::metadata(final_status_path)
                .and_then(|meta| meta.modified())
                .ok()
                .map(DateTime::<Utc>::from)
        })
}

pub(crate) fn parse_state_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

#[derive(Clone)]
pub(crate) struct CompletedRoleLane {
    pub(crate) lane_id: String,
    pub(crate) lane_dir: PathBuf,
    pub(crate) completed_at: Option<DateTime<Utc>>,
    pub(crate) result_path: Option<PathBuf>,
}

pub(crate) fn completed_followup_lane_dirs_for_role_from_state(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
) -> Result<Option<Vec<CompletedRoleLane>>> {
    let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? else {
        return Ok(None);
    };
    let role_lane_fragment = role.replace('-', "-");
    let mut lanes = Vec::new();
    for lane in lane_statuses {
        if lane.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let lane_id = lane
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if lane_id.is_empty() {
            continue;
        }
        let lane_role_matches = lane.get("role").and_then(Value::as_str) == Some(role);
        if !lane_role_matches
            && !lane_id.starts_with(&role_lane_fragment)
            && !lane_id.starts_with(&format!("followup-{role_lane_fragment}"))
        {
            continue;
        }
        let completed_at = parse_state_timestamp(lane.get("completed_at").unwrap_or(&Value::Null))
            .or_else(|| parse_state_timestamp(lane.get("updated_at").unwrap_or(&Value::Null)));
        let result_path = lane
            .get("result_path")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        lanes.push(CompletedRoleLane {
            lane_id: lane_id.clone(),
            lane_dir: lane_root(paths, cycle_id, &lane_id),
            completed_at,
            result_path,
        });
    }
    Ok(Some(lanes))
}

pub(crate) fn latest_completed_followup_action_at(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    source_brief_id: Option<&str>,
) -> Result<Option<DateTime<Utc>>> {
    let mut latest: Option<DateTime<Utc>> = None;
    if let Some(lanes) = completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, role)? {
        for lane in lanes {
            let role_plan_path = lane.lane_dir.join("role-plan.json");
            if !role_plan_path.exists() {
                continue;
            }
            let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
                continue;
            };
            if role_plan.role.as_deref() != Some(role)
                || role_plan.action_type.as_deref() != Some(action_type)
            {
                continue;
            }
            if let Some(source_brief_id) = source_brief_id {
                if role_plan.source_brief_id.as_deref() != Some(source_brief_id) {
                    continue;
                }
            }
            let completed_at = lane.completed_at.or_else(|| {
                let final_status_path = lane.lane_dir.join("final-status.json");
                fs::metadata(&final_status_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .map(DateTime::<Utc>::from)
            });
            if let Some(completed_at) = completed_at {
                if latest.map(|current| completed_at > current).unwrap_or(true) {
                    latest = Some(completed_at);
                }
            }
        }
        return Ok(latest);
    }
    let role_lane_fragment = role.replace('-', "-");
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.starts_with(&role_lane_fragment)
            && !lane_id.starts_with(&format!("followup-{role_lane_fragment}"))
        {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !role_plan_path.exists() || !final_status_path.exists() {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some(role)
            || role_plan.action_type.as_deref() != Some(action_type)
        {
            continue;
        }
        if let Some(source_brief_id) = source_brief_id {
            if role_plan.source_brief_id.as_deref() != Some(source_brief_id) {
                continue;
            }
        }
        let Some(completed_at) = final_status_completed_at(&final_status_path, &final_status)
        else {
            continue;
        };
        if latest.map(|current| completed_at > current).unwrap_or(true) {
            latest = Some(completed_at);
        }
    }
    Ok(latest)
}

pub(crate) fn chronicle_evidence_newer_than_labdirector_requery(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let latest_chronicle = latest_completed_followup_action_at(
        paths,
        cycle_id,
        "chronicle",
        "chronicle_evidence_request_followup",
        None,
    )?;
    let latest_labdirector = latest_completed_followup_action_at(
        paths,
        cycle_id,
        "lab-director",
        "lab_director_requery_followup",
        None,
    )?;
    Ok(
        matches!((latest_chronicle, latest_labdirector), (Some(chronicle), Some(labdirector)) if chronicle > labdirector),
    )
}

pub(crate) fn completed_gate_labdirector_requery_exists(paths: &AppPaths, cycle_id: &str) -> bool {
    if let Ok(Some(lanes)) =
        completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, "lab-director")
    {
        for lane in lanes {
            let role_plan_path = lane.lane_dir.join("role-plan.json");
            let result_path = lane
                .result_path
                .clone()
                .unwrap_or_else(|| lane.lane_dir.join("result.json"));
            if !role_plan_path.is_file() || !result_path.is_file() {
                continue;
            }
            let Ok(Some(role_plan)) = read_role_plan_index_fields(&role_plan_path) else {
                continue;
            };
            if role_plan.role.as_deref() != Some("lab-director")
                || role_plan.action_type.as_deref() != Some("lab_director_requery_followup")
                || role_plan.source_brief_id.as_deref()
                    != Some("hypothesis-gate-labdirector-requery")
            {
                continue;
            }
            let Ok(result) = read_json(&result_path) else {
                continue;
            };
            let payload = result
                .get("extracted_json")
                .filter(|value| value.is_object())
                .or_else(|| {
                    result
                        .get("lab_director_requery")
                        .filter(|value| value.is_object())
                });
            if payload
                .map(labdirector_requery_payload_has_hypothesis)
                .unwrap_or(false)
            {
                return true;
            }
        }
        return false;
    }
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return false;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() || !result_path.is_file() {
            continue;
        }
        let Ok(Some(role_plan)) = read_role_plan_index_fields(&role_plan_path) else {
            continue;
        };
        if role_plan.role.as_deref() != Some("lab-director")
            || role_plan.action_type.as_deref() != Some("lab_director_requery_followup")
            || role_plan.source_brief_id.as_deref() != Some("hypothesis-gate-labdirector-requery")
        {
            continue;
        }
        let Ok(final_status) = read_json(&final_status_path) else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) == Some("completed") {
            let Ok(result) = read_json(&result_path) else {
                continue;
            };
            let payload = result
                .get("extracted_json")
                .filter(|value| value.is_object())
                .or_else(|| {
                    result
                        .get("lab_director_requery")
                        .filter(|value| value.is_object())
                });
            if payload
                .map(labdirector_requery_payload_has_hypothesis)
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

pub(crate) fn completed_followup_action_from_sqlite_queue(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    source_brief_id: &str,
) -> Option<bool> {
    if source_brief_id.trim().is_empty() {
        return Some(false);
    }
    let db_path = paths.runtime_root.join("queues").join("pipeline.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let cycle_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pipeline_queue WHERE cycle_id = ?1",
            rusqlite::params![cycle_id],
            |row| row.get(0),
        )
        .ok()?;
    if cycle_rows == 0 {
        // Preserve compatibility with pre-queue artifacts and unit fixtures that
        // have lane files but no SQLite mirror row yet.
        return None;
    }
    let action_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pipeline_queue \
             WHERE cycle_id = ?1 AND role = ?2 AND action_type = ?3",
            rusqlite::params![cycle_id, role, action_type],
            |row| row.get(0),
        )
        .ok()?;
    if action_rows == 0 {
        return None;
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pipeline_queue \
             WHERE cycle_id = ?1 AND role = ?2 AND action_type = ?3 \
               AND source_brief_id = ?4 AND status = 'completed'",
            rusqlite::params![cycle_id, role, action_type, source_brief_id],
            |row| row.get(0),
        )
        .ok()?;
    Some(count > 0)
}

pub(crate) fn completed_followup_action_from_state_exists(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
    action_type: &str,
    source_brief_id: &str,
) -> Result<Option<bool>> {
    if source_brief_id.trim().is_empty() {
        return Ok(Some(false));
    }
    let Some(lanes) = completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, role)?
    else {
        return Ok(None);
    };
    for lane in lanes {
        let role_plan_path = lane.lane_dir.join("role-plan.json");
        if !role_plan_path.exists() {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() == Some(role)
            && role_plan.action_type.as_deref() == Some(action_type)
            && role_plan.source_brief_id.as_deref() == Some(source_brief_id)
        {
            return Ok(Some(true));
        }
    }
    Ok(Some(false))
}
