#![allow(unused_imports)]
use super::*;

pub fn review_labdirector_inbox(paths: &AppPaths, cycle_id: &str) -> Result<Option<Value>> {
    let inbox = crate::core::support::segmented_log::labdirector_inbox_log(paths, cycle_id);
    if inbox.is_empty() {
        return Ok(None);
    }

    // Every item, oldest first, across the hourly segments. The cursor below
    // counts items, so it means the same thing however the inbox is cut.
    let mut lines = Vec::new();
    inbox.for_each_line(|line| lines.push(line.to_string()))?;

    // Compute CYCLE-TOTAL aggregate metrics from the FULL inbox regardless of
    // cursor position. This fixes the revision P1-2 cursor-sensitivity bug:
    // earlier the decision trigger only saw the unread slice, so a claim-delta
    // that landed in an earlier review pass became invisible to the final
    // strategy decision. We persist the totals to a per-cycle file so
    // downstream consumers (researcher_view, final_claim_package) can read
    // canonical counts.
    let cycle_metrics = compute_cycle_aggregate_metrics(&lines);
    write_cycle_aggregate_metrics(paths, cycle_id, &cycle_metrics)?;

    let cursor_path = crate::core::support::labdirector_cursor_path(paths, cycle_id);
    let cursor = if cursor_path.exists() {
        read_json(&cursor_path)?
            .get("offset")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    } else {
        0
    };
    if cursor >= lines.len() {
        return Ok(None);
    }

    let new_items = lines[cursor..]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let report_items = new_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("chronicle_report"))
        .map(normalized_chronicle_report_item)
        .collect::<Vec<_>>();
    let failure_items = new_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("lane_failure_notice"))
        .cloned()
        .collect::<Vec<_>>();
    let user_items = new_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("user_message"))
        .cloned()
        .collect::<Vec<_>>();
    let user_message_count = user_items.len();
    let supervisor_items = new_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("supervisor_instruction"))
        .cloned()
        .collect::<Vec<_>>();
    let supervisor_instruction_count = supervisor_items.len();

    let control_items = new_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("control_command"))
        .cloned()
        .collect::<Vec<_>>();
    let mut processed_control_commands: Vec<Value> = Vec::new();
    for item in &control_items {
        let payload = item.get("payload").cloned().unwrap_or_else(|| json!({}));
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let args = payload
            .get("args")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let outcome = match command.as_str() {
            "pause" => {
                let reason = if args.is_empty() {
                    "researcher issued /pause".to_string()
                } else {
                    args.clone()
                };
                write_pause_marker(paths, cycle_id, &reason)?;
                json!({"command": "pause", "result": "paused", "reason": reason})
            }
            "resume" => {
                clear_pause_marker(paths, cycle_id)?;
                json!({"command": "resume", "result": "resumed"})
            }
            "stop" => {
                let reason = if args.is_empty() {
                    "researcher issued /stop".to_string()
                } else {
                    args.clone()
                };
                write_termination_code(
                    paths,
                    cycle_id,
                    "researcher_requested_stop",
                    "researcher_intervention",
                    &reason,
                    payload.clone(),
                )?;
                json!({"command": "stop", "result": "termination_requested", "reason": reason})
            }
            "retry" | "skip" | "prioritize" => json!({
                "command": command,
                "result": "acknowledged",
                "args": args,
                "note": "semantic handling is not yet wired; the inbox entry is recorded for audit and the LLM can react on the next review",
            }),
            other => json!({"command": other, "result": "unknown"}),
        };
        processed_control_commands.push(outcome.clone());
        append_event(
            &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
            "labdirector_command_ack",
            json!({
                "cycle_id": cycle_id,
                "command": command,
                "args": args,
                "result": outcome,
                "ts": now_iso(),
            }),
        )?;
    }
    let latest_user_message = user_items
        .iter()
        .rev()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|payload| payload.get("message"))
                .and_then(Value::as_str)
        })
        .next()
        .unwrap_or("")
        .to_string();
    let objective = cycle_objective(paths, cycle_id);
    let spawned_researcher_instruction_lanes =
        if user_message_count > 0 && !latest_user_message.trim().is_empty() {
            spawn_direct_researcher_labdirector_followup(
                paths,
                cycle_id,
                &objective,
                &latest_user_message,
                user_items.last(),
            )?
        } else {
            Vec::new()
        };
    let spawned_supervisor_instruction_lanes = if let Some(latest_supervisor_item) =
        supervisor_items.last()
    {
        spawn_supervisor_labdirector_followup(paths, cycle_id, &objective, latest_supervisor_item)?
    } else {
        Vec::new()
    };
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
    let recommended_action_count = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("recommended_action_count"))
                .and_then(Value::as_u64)
        })
        .sum::<u64>();
    let rubric_targets = report_items
        .iter()
        .flat_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("rubric_targets"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|item| item.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    let assigned_models = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("role_plan_summary"))
                .and_then(|p| p.get("assigned_model"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let critical_questions =
        critical_questions_for_reports(&report_items.iter().collect::<Vec<_>>());
    let requested_more_info = !critical_questions.is_empty();
    let interpretation_schemas = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("interpretation_schema"))
                .cloned()
        })
        .collect::<Vec<_>>();
    let parse_warnings = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("parse_warning"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let raw_output_samples = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("raw_output"))
                .and_then(Value::as_str)
                .map(|text| text.chars().take(400).collect::<String>())
        })
        .collect::<Vec<_>>();
    let fallback_payloads = report_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|p| p.get("fallback_payload"))
                .cloned()
        })
        .collect::<Vec<_>>();
    let chronicle_response = build_chronicle_response(
        cycle_id,
        &report_items.iter().collect::<Vec<_>>(),
        &critical_questions,
    );
    let timeout_notice_count = failure_items
        .iter()
        .filter(|item| {
            item.get("payload")
                .and_then(|payload| payload.get("failure_category"))
                .and_then(Value::as_str)
                == Some("timeout")
        })
        .count();
    let token_pressure_notice_count = failure_items
        .iter()
        .filter(|item| {
            item.get("payload")
                .and_then(|payload| payload.get("token_pressure"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .count();
    let failure_lane_ids = failure_items
        .iter()
        .filter_map(|item| {
            item.get("payload")
                .and_then(|payload| payload.get("lane_id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let recommended_recovery_actions = failure_items
        .iter()
        .flat_map(|item| failure_notice_actions(item.get("payload").unwrap_or(item)))
        .collect::<Vec<_>>();
    let spawned_followup_lanes = if token_pressure_notice_count > 0 {
        Vec::new()
    } else {
        spawn_failure_recovery_followups(paths, cycle_id, &failure_items)?
    };

    let (mode, reason) = if token_pressure_notice_count > 0 {
        (
            "wait",
            "Codex token or quota pressure was reported; pause retries until pacing backoff clears",
        )
    } else if timeout_notice_count > 0 {
        (
            "refine",
            "recent lanes timed out; issue targeted recovery retries and trim scope before the next pass",
        )
    } else if report_items.is_empty() && failure_items.is_empty() && user_message_count > 0 {
        (
            "hold",
            "researcher guidance received; waiting for the next lane outputs while preserving the current plan",
        )
    } else if supervisor_instruction_count > 0 {
        (
            "refine",
            "supervisor process escalation requires a LabDirector-authored research decision",
        )
    } else if claim_delta_count == 0 {
        ("pivot", "new Chronicle reports contain no claim deltas")
    } else if open_question_count > 0 || recommended_action_count > 0 {
        (
            "refine",
            "Chronicle reports contain unresolved questions or follow-up actions",
        )
    } else {
        ("hold", "recent Chronicle reports are stable")
    };
    let labdirector_response = if user_message_count > 0 {
        let next_step = if !spawned_researcher_instruction_lanes.is_empty() {
            format!(
                "I spawned {} direct LabDirector adjudication lane(s) for the researcher instruction and will keep the research notes unchanged for that adjudication.",
                spawned_researcher_instruction_lanes.len()
            )
        } else if !spawned_followup_lanes.is_empty() {
            format!(
                "I spawned {} recovery follow-up lane(s) and will watch their outputs before changing the cycle direction.",
                spawned_followup_lanes.len()
            )
        } else if requested_more_info && !critical_questions.is_empty() {
            format!(
                "I still need stronger Chronicle answers on: {}.",
                critical_questions.join("; ")
            )
        } else if open_question_count > 0 {
            format!(
                "There are still {} open Chronicle question(s), so I am keeping the cycle in {} mode.",
                open_question_count, mode
            )
        } else if report_items.is_empty() && failure_items.is_empty() {
            "No new lane reports landed yet, so I recorded your guidance and will re-check on the next review pass.".to_string()
        } else {
            "I incorporated your note into the current review state and will keep monitoring the active lanes.".to_string()
        };
        json!({
            "cycle_id": cycle_id,
            "message": format!(
                "Received your note: \"{}\" Objective: {}. Current mode: {}. Reason: {}. {}",
                latest_user_message, objective, mode, reason, next_step
            ),
            "latest_user_message": latest_user_message,
            "objective": objective,
            "mode": mode,
            "reason": reason,
            "reports_seen": report_items.len(),
            "failure_notice_count": failure_items.len(),
        })
    } else {
        Value::Null
    };

    let decision = json!({
        "ts": now_iso(),
        "cycle_id": cycle_id,
        "mode": mode,
        "reason": reason,
        "reports_seen": report_items.len(),
        "claim_delta_count": claim_delta_count,
        "open_question_count": open_question_count,
        "recommended_action_count": recommended_action_count,
        "rubric_targets": rubric_targets,
        "assigned_models": assigned_models,
        "lane_ids": report_items.iter().filter_map(|item| item.get("payload").and_then(|p| p.get("lane_id")).and_then(Value::as_str)).collect::<Vec<_>>(),
        "failure_notice_count": failure_items.len(),
        "failure_lane_ids": failure_lane_ids,
        "timeout_notice_count": timeout_notice_count,
        "token_pressure_notice_count": token_pressure_notice_count,
        "user_message_count": user_message_count,
        "latest_user_message": latest_user_message,
        "supervisor_instruction_count": supervisor_instruction_count,
        "control_command_count": processed_control_commands.len(),
        "control_commands": processed_control_commands,
        "cycle_paused": is_cycle_paused(paths, cycle_id),
        "cycle_aggregate_metrics": cycle_metrics,
        "recommended_recovery_actions": recommended_recovery_actions,
        "spawned_followup_lanes": spawned_followup_lanes,
        "spawned_researcher_instruction_lanes": spawned_researcher_instruction_lanes,
        "spawned_supervisor_instruction_lanes": spawned_supervisor_instruction_lanes,
        "requested_more_info": requested_more_info,
        "critical_questions": critical_questions,
        "interpretation_schemas": interpretation_schemas,
        "parse_warnings": parse_warnings,
        "raw_output_samples": raw_output_samples,
        "fallback_payloads": fallback_payloads,
        "chronicle_response": chronicle_response,
        "labdirector_response": labdirector_response,
    });

    write_json(
        &cursor_path,
        &json!({
            "offset": lines.len(),
            "updated_at": now_iso(),
        }),
    )?;
    crate::core::support::append_labdirector_decision(paths, cycle_id, &decision)?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_challenge",
        json!({
            "cycle_id": cycle_id,
            "critical_questions": decision.get("critical_questions").cloned().unwrap_or_else(|| json!([])),
            "reports_seen": report_items.len(),
        }),
    )?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "chronicle_response",
        decision
            .get("chronicle_response")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )?;
    if user_message_count > 0 {
        append_event(
            &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
            "labdirector_response",
            decision
                .get("labdirector_response")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )?;
    }
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "labdirector_decision",
        decision.clone(),
    )?;
    Ok(Some(decision))
}

pub fn labdirector_plan_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    plans_root(paths).join(format!("{cycle_id}-labdirector-plan.json"))
}
