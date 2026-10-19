#![allow(unused_imports)]
use super::*;

pub(crate) fn lab_director_context_budget_policy(paths: &AppPaths, cycle_id: &str) -> Value {
    let notes_path = state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json"));
    let digest_path = state_root(paths).join(format!("{cycle_id}-agent-communication-digest.json"));
    let memory_summary_path = paths
        .runtime_root
        .join("memory")
        .join(cycle_id)
        .join("memory_summary.md");
    let memory_path = paths
        .runtime_root
        .join("memory")
        .join(cycle_id)
        .join("MEMORY.md");
    let mailbox_path = paths
        .runtime_root
        .join("messages")
        .join(cycle_id)
        .join("mailbox")
        .join("lab-director.jsonl");
    json!({
        "max_inline_context_bytes": 48_000,
        "max_inline_component_bytes": 12_000,
        "max_research_notes_context_bytes": 24_000,
        "read_order": [
            "cycle_memory_context",
            "agent_mailbox_context",
            "agent_communication_digest_context",
            "research_notes_context",
            "followup_description",
            "active_blockers",
            "source_refs_only_for_full_artifacts"
        ],
        "source_refs": {
            "lab_director_research_notes": notes_path.display().to_string(),
            "agent_communication_digest": digest_path.display().to_string(),
            "agent_mailbox": mailbox_path.display().to_string(),
            "cycle_memory_summary": memory_summary_path.display().to_string(),
            "cycle_memory": memory_path.display().to_string(),
        },
        "full_artifact_policy": "Do not read all state/lane artifacts at once. Start from cycle memory summary, compact digest, and notes; open source_paths one at a time only when the next decision needs that exact evidence.",
        "dedupe_policy": "Treat resolved_or_superseded blockers as history, not active work.",
    })
}

pub(crate) fn context_trace_component(
    name: &str,
    value: Option<&Value>,
    max_inline_bytes: usize,
) -> Value {
    let approx_bytes = value.map(json_approx_bytes).unwrap_or(0);
    let present = value.map(|item| !item.is_null()).unwrap_or(false);
    json!({
        "name": name,
        "present": present,
        "approx_inline_bytes": approx_bytes,
        "max_inline_bytes": max_inline_bytes,
        "over_budget": approx_bytes > max_inline_bytes,
    })
}

pub(crate) fn lab_director_context_input_trace(role_plan: &Value) -> Value {
    let planner = role_plan.get("planner_metadata").unwrap_or(&Value::Null);
    let components = vec![
        context_trace_component(
            "cycle_memory_context",
            role_plan.get("cycle_memory_context"),
            14_000,
        ),
        context_trace_component(
            "agent_mailbox_context",
            role_plan.get("agent_mailbox_context"),
            10_000,
        ),
        context_trace_component(
            "agent_communication_digest_context",
            role_plan.get("agent_communication_digest_context"),
            12_000,
        ),
        context_trace_component(
            "research_notes_context",
            role_plan.get("research_notes_context"),
            24_000,
        ),
        context_trace_component(
            "previous_review_context",
            role_plan.get("previous_review_context"),
            8_000,
        ),
        context_trace_component(
            "chronicle_research_context",
            role_plan.get("chronicle_research_context"),
            8_000,
        ),
        context_trace_component(
            "materialized_dataset_context",
            role_plan.get("materialized_dataset_context"),
            8_000,
        ),
        context_trace_component(
            "reference_resource_context",
            role_plan.get("reference_resource_context"),
            8_000,
        ),
        context_trace_component(
            "planner_metadata.blocker_reasons",
            planner.get("blocker_reasons"),
            4_000,
        ),
        context_trace_component(
            "planner_metadata.challenge_questions",
            planner.get("challenge_questions"),
            4_000,
        ),
        context_trace_component(
            "planner_metadata.validation_results",
            planner.get("validation_results"),
            8_000,
        ),
        context_trace_component(
            "planner_metadata.failed_runner_context",
            planner.get("failed_runner_context"),
            6_000,
        ),
        context_trace_component(
            "planner_metadata.review_action",
            planner.get("review_action"),
            8_000,
        ),
        context_trace_component(
            "planner_metadata.reasoning_graph",
            planner.get("reasoning_graph"),
            8_000,
        ),
        context_trace_component(
            "planner_metadata.data_graph",
            planner.get("data_graph"),
            8_000,
        ),
    ];
    json!({
        "generated_at": now_iso(),
        "role": "lab-director",
        "total_role_plan_inline_bytes": json_approx_bytes(role_plan),
        "components": components,
        "tracking_purpose": "make LabDirector input context auditable and prevent unbounded one-shot reads",
    })
}
