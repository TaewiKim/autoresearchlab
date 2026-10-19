#![allow(unused_imports)]
use super::*;

pub(crate) fn compact_lab_director_notes_content(content: &Value, path: &Path) -> Value {
    let latest_decision = content
        .get("latest_lab_director_decision")
        .map(|decision| {
            json!({
                "lane_id": decision.get("lane_id").cloned().unwrap_or(Value::Null),
                "requery_decision": decision.get("requery_decision").cloned().unwrap_or(Value::Null),
                "summary": decision.get("summary").cloned().unwrap_or(Value::Null),
                "rationale": decision.get("rationale").and_then(Value::as_str).map(|text| truncate_string(text, 900)),
                "next_actions": array_prefix(decision.get("next_actions"), 6),
            })
        })
        .unwrap_or(Value::Null);
    let resolved_count = array_len(content.get("resolved_or_superseded_blockers"));
    json!({
        "format": "json_compact",
        "path": path.display().to_string(),
        "full_context_ref": path.display().to_string(),
        "content_policy": "compact handoff only; do not inline or reread the full notebook unless a specific missing detail is needed",
        "updated_at": content.get("updated_at").cloned().unwrap_or(Value::Null),
        "generated_by": content.get("generated_by").cloned().unwrap_or(Value::Null),
        "current_lead_hypothesis": content.get("current_lead_hypothesis").cloned().unwrap_or(Value::Null),
        "latest_lab_director_decision": latest_decision,
        "evidence_snapshot": content.get("evidence_snapshot").cloned().unwrap_or(Value::Null),
        "active_blockers": array_prefix(content.get("open_blockers"), 8),
        "resolved_or_superseded_summary": {
            "count": resolved_count,
            "examples": array_prefix(content.get("resolved_or_superseded_blockers"), 4),
        },
        "communication_quality": content.get("communication_quality").cloned().unwrap_or(Value::Null),
        "dataset_and_tool_context": content.get("dataset_and_tool_context").cloned().unwrap_or(Value::Null),
        "next_actions": array_prefix(content.get("next_actions"), 8),
        "handoff_for_next_lab_director": content.get("handoff_for_next_lab_director").cloned().unwrap_or(Value::Null),
    })
}

pub(crate) fn compact_agent_communication_digest_content(content: &Value, path: &Path) -> Value {
    json!({
        "format": "agent_communication_digest_compact",
        "path": path.display().to_string(),
        "full_context_ref": path.display().to_string(),
        "content_policy": "read this compact digest first; use source_paths only for targeted follow-up reads",
        "updated_at": content.get("updated_at").cloned().unwrap_or(Value::Null),
        "current_focus": content.get("current_focus").cloned().unwrap_or(Value::Null),
        "communication_diagnosis": array_prefix(content.get("communication_diagnosis"), 8),
        "active_blockers": array_prefix(content.get("active_blockers"), 8),
        "resolved_or_superseded_summary": {
            "count": array_len(content.get("resolved_or_superseded_blockers")),
            "examples": array_prefix(content.get("resolved_or_superseded_blockers"), 3),
        },
        "handoffs": content.get("handoffs").cloned().unwrap_or(Value::Null),
        "role_boundaries": array_prefix(content.get("role_boundaries"), 6),
        "timeline": array_prefix(content.get("timeline"), 8),
        "source_paths": content.get("source_paths").cloned().unwrap_or(Value::Null),
    })
}

pub(crate) fn lab_director_agent_communication_digest_context(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let digest_path = state_root(paths).join(format!("{cycle_id}-agent-communication-digest.json"));
    if !digest_path.exists() {
        return Ok(None);
    }
    if fs::metadata(&digest_path)
        .map(|metadata| metadata.len() > 1_000_000)
        .unwrap_or(false)
    {
        return Ok(Some(json!({
            "format": "agent_communication_digest_oversized",
            "path": digest_path.display().to_string(),
            "content_policy": "digest is oversized; read by targeted jq queries only",
        })));
    }
    let content = read_json(&digest_path)?;
    Ok(Some(compact_agent_communication_digest_content(
        &content,
        &digest_path,
    )))
}

pub(crate) fn lab_director_cycle_memory_context(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let memory_root = paths.runtime_root.join("memory").join(cycle_id);
    let summary_path = memory_root.join("memory_summary.md");
    if !summary_path.exists() {
        return Ok(None);
    }
    let memory_path = memory_root.join("MEMORY.md");
    let raw_path = memory_root.join("raw_memories.md");
    let index_path = memory_root.join("memory-index.json");
    let rollout_summaries_dir = memory_root.join("rollout_summaries");
    Ok(Some(json!({
        "format": "cycle_memory_compact",
        "memory_root": memory_root.display().to_string(),
        "memory_summary_path": summary_path.display().to_string(),
        "memory_path": memory_path.display().to_string(),
        "raw_memories_path": raw_path.display().to_string(),
        "memory_index_path": index_path.display().to_string(),
        "rollout_summaries_dir": rollout_summaries_dir.display().to_string(),
        "read_path_policy": {
            "read_order": [
                "memory_summary_excerpt",
                "memory_excerpt",
                "agent_communication_digest_context",
                "targeted source paths only"
            ],
            "do_not_read_raw_memories_by_default": true,
            "do_not_inline_full_notebooks": true,
            "target_rollout_summaries_by_lane_id": true
        },
        "memory_summary_excerpt": json_file_window_text(&summary_path, 8_000)?,
        "memory_excerpt": if memory_path.exists() {
            json_file_window_text(&memory_path, 6_000)?
        } else {
            String::new()
        },
    })))
}

pub(crate) fn read_jsonl_newest_first(path: &Path, limit: usize) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .take(limit)
        .collect()
}

pub(crate) fn compact_mailbox_message(message: &Value) -> Value {
    json!({
        "message_id": message.get("message_id").cloned().unwrap_or(Value::Null),
        // The channel IS the relationship: who is speaking to whom, about what
        // kind of thing. It replaces author_role/target_role/sequence, which
        // described the mailbox's own bookkeeping rather than the conversation.
        "channel": message.get("channel").cloned().unwrap_or(Value::Null),
        "from_role": message.get("from_role").cloned().unwrap_or(Value::Null),
        "kind": message.get("kind").cloned().unwrap_or(Value::Null),
        "open_request": message.get("open").cloned().unwrap_or(Value::Null),
        "asks_for": message.get("asks_for").cloned().unwrap_or(Value::Null),
        "decision": message.get("decision").cloned().unwrap_or(Value::Null),
        "queued_at": message.get("queued_at").cloned().unwrap_or(Value::Null),
        // How many times this has already been put in front of somebody. A
        // request that keeps arriving undecided is the thing that used to be
        // invisible: nothing recorded a delivery, so nothing could say it.
        "delivered_count": message.get("delivered_count").cloned().unwrap_or(Value::Null),
        "source_ref": message.get("source_ref").cloned().unwrap_or(Value::Null),
        "subject": message
            .get("subject")
            .and_then(Value::as_str)
            .map(|text| truncate_string(text, 900))
            .unwrap_or_default(),
        // Was 6_000. The payload is most of the bytes and the subject carries
        // the point -- see agent_mailbox_context.
        "payload": compact_json_context(&message.get("payload").cloned().unwrap_or(Value::Null), 2_500),
    })
}

/// The LabDirector reads a summary; the code keeps the original.
///
/// Owner decision 2026-08-13: reading every raw artifact is worse for the
/// decision, not better. These helpers compact at the PROMPT boundary only —
/// `latest_completed_lab_runner_context` and the deliberation record are still
/// returned in full to the Rust callers that drill into them (gate-readiness,
/// handoff-identity, hypothesis-statement extraction all read fields inside
/// `analyst_handoff`), so summarising at the source would have broken them.
///
/// MEASURED ON cycle-g-v79, across 179 lab-director role plans:
///   chronicle_gate_deliberation_context  5.33 MB — 99% of it one `summary` string
///   latest_completed_lab_runner_context  4.19 MB — 32KB of 39KB is `analyst_handoff`,
///                                                  inlined beside the path to it
/// against chronicle_decision_digest, the actual summary, at 1.38 MB.
///
/// Every compaction leaves the path in place, so the director can still read the
/// original when it needs a specific detail.
pub(crate) fn compact_deliberation_for_prompt(deliberation: &Value) -> Value {
    let mut out = deliberation.clone();
    if let Some(summary) = deliberation.get("summary").and_then(Value::as_str) {
        let kept = truncate_string(summary, 6_000);
        let truncated = kept.len() < summary.len();
        out["summary"] = json!(kept);
        out["summary_compacted"] = json!(truncated);
        if truncated {
            out["summary_original_chars"] = json!(summary.len());
            out["content_policy"] = json!(
                "summary is truncated; read result_path for the full deliberation when a specific detail is needed"
            );
        }
    }
    out
}

/// Keep what the director decides on; drop the handoff blob it already has a
/// path to. See `compact_deliberation_for_prompt` for the measurement.
pub(crate) fn compact_runner_context_for_prompt(context: &Value) -> Value {
    let mut out = context.clone();
    let handoff = context
        .get("analyst_handoff")
        .cloned()
        .unwrap_or(Value::Null);
    if handoff.is_null() {
        return out;
    }
    let count = |key: &str| {
        handoff
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0)
    };
    let text = |key: &str| {
        handoff
            .get(key)
            .and_then(Value::as_str)
            .map(|value| truncate_string(value, 1_200))
    };
    out["analyst_handoff"] = json!({
        "format": "analyst_handoff_digest",
        "full_context_ref": context.get("analyst_handoff_path").cloned().unwrap_or(Value::Null),
        "content_policy": "digest only; read analyst_handoff_path for the full plan when a specific check or blueprint matters",
        "status": handoff.get("status").cloned().unwrap_or(Value::Null),
        "primary_hypothesis_id": handoff.get("primary_hypothesis_id").cloned().unwrap_or(Value::Null),
        "summary": text("summary"),
        "reason": text("reason"),
        "handoff_check_count": count("handoff_checks"),
        "validation_code_blueprint_count": count("validation_code_blueprints"),
        "hypothesis_statement": handoff
            .get("column_mapping")
            .and_then(|item| item.get("hypothesis_statement"))
            .and_then(Value::as_str)
            .map(|value| truncate_string(value, 1_200)),
    });
    out
}

/// Two workarounds for an identity the mailbox did not have.
///
/// `mailbox_snapshot_shape_key` collapsed successive snapshots of one running
/// status by comparing the KEY SET of their payloads, because each snapshot had
/// an empty kind and a freshly-worded summary and so looked like a new message.
/// Measured on cycle-g-v79: eight pending messages in a director's mailbox, all
/// from `supervisor`, all the same shape, 31.8 KB of payload against 3.3 KB of
/// summary, only the newest describing the present.
///
/// A bus message is identified by its channel and the thing being discussed, so
/// a standing channel has exactly ONE message whose content refreshes in place.
/// There are no same-shape repeats left to collapse, and deduping is the
/// message id.
fn mailbox_message_dedupe_key(message: &Value) -> String {
    message
        .get("message_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default()
}

/// The mailbox addressed to one role.
///
/// The projection has always been written per target role, and only the
/// director's was ever read. So the author's own messages existed on disk and
/// reached nothing, which is the delivery half of "the author and the director
/// are not talking": adding a message to the ledger without this is adding it
/// to a file nobody opens.
///
/// A role reads the mailbox addressed to IT, never another role's. The
/// director's inbox carries the supervisor's operational reporting and its own
/// blocker classification, and handing that to another role would hand it the
/// director's decisions.
pub(crate) fn agent_mailbox_context(
    paths: &AppPaths,
    cycle_id: &str,
    role: &str,
) -> Option<Value> {
    let bus_root = paths.runtime_root.join("messages").join(cycle_id);
    let mailbox_path = bus_root.join(format!("{role}.jsonl"));
    let ledger_path = bus_root.join("bus-ledger.json");
    if !mailbox_path.exists() {
        return None;
    }
    let messages = read_jsonl_newest_first(&mailbox_path, 20);
    let mut seen = HashSet::new();
    let mut delivered_ids = Vec::new();
    let mut owed = Vec::new();
    let mut informing = Vec::new();
    for message in messages.iter() {
        if !seen.insert(mailbox_message_dedupe_key(message)) {
            continue;
        }
        let compact = compact_mailbox_message(message);
        if let Some(id) = message.get("message_id").and_then(Value::as_str) {
            delivered_ids.push(id.to_string());
        }
        // The distinction the old mailbox did not make. A request is something
        // this role owes an answer on; a standing message is context. Marking
        // both `trigger_turn` and `pending` is how a status line ended up
        // looking like an unanswered instruction, and how an eight-day-old
        // message kept being delivered as current.
        if message.get("open").and_then(Value::as_bool) == Some(true) {
            if owed.len() < 6 {
                owed.push(compact);
            }
        } else if informing.len() < 3 {
            informing.push(compact);
        }
    }
    record_mailbox_delivery(paths, cycle_id, role, &delivered_ids);
    Some(json!({
        "addressed_to": role,
        "format": "message_bus_compact",
        "mailbox_path": mailbox_path.display().to_string(),
        "ledger_path": ledger_path.display().to_string(),
        "content_policy": "`you_owe_an_answer` are open requests from another role: answer each one with a decision AND a reason, in this turn, or say what you are waiting on. `informing_you` is context nobody owes you an answer for. Use ledger_path only for audit.",
        "open_request_count": owed.len(),
        "you_owe_an_answer": owed,
        "informing_you": informing,
    }))
}

/// Record that these messages were put in front of this role.
///
/// `delivery_state` used to have a READER and no writer: nothing anywhere in
/// this system set `acknowledged_at` or `consumed_at`, so every message stayed
/// pending forever and "was this delivered?" had no answer but re-reading a
/// prompt. Append-only, never fatal -- a receipt is evidence about a delivery
/// that already happened, and losing one must not cost a lane its context. It
/// is a separate file from the ledger because lanes refresh concurrently and
/// this runtime has already lost a cycle to one torn write.
fn record_mailbox_delivery(paths: &AppPaths, cycle_id: &str, role: &str, message_ids: &[String]) {
    if message_ids.is_empty() {
        return;
    }
    let now = now_iso();
    let lines = message_ids
        .iter()
        .map(|id| json!({ "message_id": id, "delivered_to": role, "delivered_at": now }).to_string())
        .collect::<Vec<_>>();
    // One write for the batch, into this hour's segment of the receipts.
    let _ = crate::core::support::segmented_log::delivery_receipt_log(paths, cycle_id).append_line(&lines.join("\n"));
}

#[cfg(test)]
mod mailbox_context_tests {
    use super::*;
    use serde_json::json;


    // A bus message identifies itself; that is what replaced the workaround.
    #[test]
    fn dedupe_is_the_message_id() {
        let a = json!({ "message_id": "supervisor->lab-director:focus#director-focus", "subject": "one wording" });
        let b = json!({ "message_id": "supervisor->lab-director:focus#director-focus", "subject": "another wording" });
        assert_eq!(
            mailbox_message_dedupe_key(&a),
            mailbox_message_dedupe_key(&b),
            "the same message reworded is still the same message",
        );
        let other = json!({ "message_id": "author->lab-director:manuscript-blocker#x" });
        assert_ne!(mailbox_message_dedupe_key(&a), mailbox_message_dedupe_key(&other));
    }

    // Three tests for mailbox_snapshot_shape_key stood here: that differently
    // worded snapshots of one status collapse to a key, that a different author
    // or payload shape does not, and that a bare message is never collapsed.
    // They were testing a workaround for an identity a mailbox message did not
    // have. A bus message is identified by its channel and its subject, so a
    // standing channel holds exactly one message and there is nothing left to
    // collapse. The behaviour they protected is now a property of the identity
    // rather than a repair applied after the fact, and it is asserted in
    // tests/message_bus.test.js ("a standing message is one message whose
    // content refreshes").
}
