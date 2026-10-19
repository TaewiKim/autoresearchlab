#![allow(unused_imports)]
use super::*;

pub(crate) fn compact_open_validation_gaps(open_validation_gaps: &[Value]) -> Value {
    if open_validation_gaps.is_empty() {
        return Value::Array(Vec::new());
    }
    let examples: Vec<Value> = open_validation_gaps
        .iter()
        .take(8)
        .map(|gap| {
            json!({
                "statement": gap
                    .get("statement")
                    .or_else(|| gap.get("hypothesis"))
                    .or_else(|| gap.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "reason": gap
                    .get("reason")
                    .or_else(|| gap.get("blocker"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "target_rubric": gap.get("target_rubric").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({
        "count": open_validation_gaps.len(),
        "examples": examples,
        "truncated": open_validation_gaps.len() > 8,
    })
}

pub(crate) fn hypothesis_ledger_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-hypothesis-ledger.json"))
}

pub(crate) fn latest_completed_chronicle_gate_deliberation(
    paths: &AppPaths,
    cycle_id: &str,
) -> Option<Value> {
    let mut candidates: Vec<(std::time::SystemTime, PathBuf, PathBuf)> = Vec::new();
    let lanes_dir = cycle_lanes_root(paths, cycle_id);
    let entries = fs::read_dir(lanes_dir).ok()?;
    for entry in entries.flatten() {
        let lane_id = entry.file_name().to_string_lossy().to_string();
        if !lane_id.starts_with("chronicle-") && !lane_id.starts_with("followup-chronicle-") {
            continue;
        }
        let lane_path = entry.path();
        let role_plan_path = lane_path.join("role-plan.json");
        let final_status_path = lane_path.join("final-status.json");
        let result_path = lane_path.join("result.json");
        if !role_plan_path.is_file() || !final_status_path.is_file() || !result_path.is_file() {
            continue;
        }
        let Ok(final_status) = read_json(&final_status_path) else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let Ok(Some(role_plan)) = read_role_plan_index_fields(&role_plan_path) else {
            continue;
        };
        if role_plan.role.as_deref() != Some("chronicle")
            || role_plan.action_type.as_deref() != Some("chronicle_gate_deliberation_followup")
        {
            continue;
        }
        let modified = result_path
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, role_plan_path, result_path));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let (_, role_plan_path, result_path) = candidates.into_iter().next()?;
    let summary = json_file_window_text(&result_path, 16_000).ok()?;
    Some(json!({
        "role_plan_path": role_plan_path,
        "result_path": result_path,
        "summary": summary,
        "summary_truncated_window": true,
        "usage": "LabDirector must adjudicate this Chronicle gate-deliberation memo before selecting, replacing, or validating the next hypothesis.",
    }))
}

pub(crate) fn completed_chronicle_gate_deliberation_exists(
    paths: &AppPaths,
    cycle_id: &str,
) -> bool {
    latest_completed_chronicle_gate_deliberation(paths, cycle_id).is_some()
}

pub(crate) fn lab_director_research_notes_contract(paths: &AppPaths, cycle_id: &str) -> Value {
    let markdown_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.md"));
    let json_path = state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json"));
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
    json!({
        "required": true,
        "markdown_path": markdown_path.display().to_string(),
        "json_path": json_path.display().to_string(),
        "agent_communication_digest_path": digest_path.display().to_string(),
        "cycle_memory_summary_path": memory_summary_path.display().to_string(),
        "cycle_memory_path": memory_path.display().to_string(),
        "must_read_existing_notes": true,
        "must_read_cycle_memory_summary_first": true,
        "must_read_compact_digest_first": true,
        "must_update_before_completion": true,
        "context_budget_policy": {
            "read_cycle_memory_summary_first": true,
            "read_compact_digest_first": true,
            "do_not_inline_full_notebook": true,
            "read_full_artifacts_only_by_targeted_source_path": true,
        },
        "required_sections": [
            "cycle_id",
            "updated_at",
            "current_lead_hypothesis",
            "decision_log",
            "evidence_snapshot",
            "open_blockers",
            "resolved_or_superseded_blockers",
            "communication_quality",
            "rejected_or_demoted_hypotheses",
            "dataset_and_tool_context",
            "next_actions",
            "handoff_for_next_lab_director"
        ],
        "purpose": "Preserve long-running research context across lab-director lanes without relying on chat history."
    })
}

/// Ask Chronicle which of the scout corpus belongs in THIS cycle's field.
///
/// The second of two judgements that admit a paper. The first is per paper --
/// a scout agent reads an abstract and decides `directly_relevant`, and
/// `literature_screening` verifies that receipt. This one is per CORPUS: scout
/// queries pull in every field that shares a method word, so somebody has to
/// say which of them are this cycle's prior art.
///
/// It was written in `src/agents/chronicle/brief_plan.js` and therefore reached
/// the BASE chronicle lane and nothing else. Measured on cycle-g-v89: 1 of 1
/// base chronicle lanes carried it and **0 of 100 follow-up lanes did**, and
/// every chronicle lane a running cycle dispatches is a follow-up. So the
/// admit-list was never requested: v89 emitted an empty one, v90 emitted none,
/// and 252 unranked papers went into a rendering graph -- among them a study of
/// EEG preprocessing.
///
/// The judgement is Chronicle's. This carries the request, the shape, and the
/// path; no domain logic lives here, and none may.
pub(crate) fn chronicle_literature_relevance_contract(
    paths: &AppPaths,
    cycle_id: &str,
) -> Value {
    let artifact_path =
        state_root(paths).join(format!("{cycle_id}-chronicle-literature-relevance.json"));
    json!({
        "required": true,
        "emit_artifact_path": artifact_path,
        "why": "The literature graph is the gatekeeper's novelty baseline, so it must contain this cycle's OWN field. A scout corpus is polluted by shared method words: a term this cycle's methods use is also used by fields it has nothing to do with, and an unranked corpus caps novelty scoring however original the lead is.",
        "how": "Do NOT try to read all of them, and do NOT emit only exclusions -- a partial review that names just the rejects lets every unreviewed paper through. SELECT instead: rank the corpus by relevance to THIS objective (the subject categories the papers carry, venue, title and abstract, citation weight, recency), take roughly the top 150-400, and judge those with your own reasoning. Prefer the field's real prior art: the venues it publishes in, the categories it uses, the named methods the lead competes against, and foundational work that predates those categories. Include genuine cross-disciplinary prior art; exclude papers that merely share a method word.",
        "shape": "{ reviewed_at, cycle_domain, kept_count, dropped_count, kept: [{ id|doi|title }], dropped: [{ id|doi|title, category, reason }] }",
        "admit_list_semantics": "`kept` is an ADMIT-LIST: the graph is built from EXACTLY those papers, identified by doi when present and otherwise by exact title, so anything you do not list is excluded whether or not you examined it.",
        "if_you_cannot_rank_this_pass": "Emit `dropped` only and leave `kept` empty; the builder then falls back to excluding just those rather than treating the corpus as reviewed.",
        "no_keyword_filter": "This decision is yours. The builder only ENFORCES what you emit and applies no domain logic of its own, which is why it cannot be replaced by a term list.",
    })
}

pub(crate) fn chronicle_direct_corpus_interaction_contract(
    paths: &AppPaths,
    cycle_id: &str,
) -> Value {
    let corpus_map_path =
        state_root(paths).join(format!("{cycle_id}-chronicle-dci-corpus-map.json"));
    let evidence_ledger_path =
        state_root(paths).join(format!("{cycle_id}-chronicle-dci-evidence-ledger.json"));
    let checkpoint_path =
        state_root(paths).join(format!("{cycle_id}-chronicle-dci-checkpoint.json"));
    json!({
        "required": true,
        "source_refs": [
            {
                "title": "Beyond Semantic Similarity: Rethinking Retrieval for Agentic Search via Direct Corpus Interaction",
                "arxiv": "2605.05242",
                "url": "https://arxiv.org/abs/2605.05242"
            },
            {
                "name": "DCI-Agent-Lite",
                "url": "https://github.com/DCI-Agent/DCI-Agent-Lite"
            }
        ],
        "corpus_scope": [
            format!(".research-lab/lanes/{cycle_id}/scout-*/result.json"),
            format!(".research-lab/artifacts/stats/{cycle_id}/**/*literature*"),
            format!(".research-lab/artifacts/stats/{cycle_id}/**/handoff-validation-plan.json"),
            format!(".research-lab/artifacts/stats/{cycle_id}/**/validation-summary.json"),
            format!(".research-lab/review-map/{cycle_id}/manifest.json"),
            format!(".research-lab/review-map/{cycle_id}/by-stage/**"),
            format!(".research-lab/review-map/{cycle_id}/by-agent/**"),
            format!(".research-lab/state/{cycle_id}-*.json")
        ],
        "allowed_tools": ["rg", "jq", "sed", "ls", "cat", "short_cycle_scoped_scripts"],
        "forbidden": [
            "whole-repository recursive search",
            "semantic-top-k-only synthesis",
            "uncited trend claims",
            "large unbounded tool output in final message"
        ],
        "required_artifacts": {
            "corpus_map_path": corpus_map_path.display().to_string(),
            "evidence_ledger_path": evidence_ledger_path.display().to_string(),
            "checkpoint_path": checkpoint_path.display().to_string()
        },
        "context_management": {
            "truncate_large_tool_outputs": true,
            "compact_older_probes": true,
            "summarize_checkpoint_for_resume": true
        }
    })
}

pub(crate) fn lab_director_existing_research_notes_context(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let markdown_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.md"));
    let json_path = state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json"));
    if json_path.exists()
        && fs::metadata(&json_path)
            .map(|metadata| metadata.len() <= 1_000_000)
            .unwrap_or(false)
    {
        match read_json(&json_path) {
            Ok(content) => {
                return Ok(Some(compact_lab_director_notes_content(
                    &content, &json_path,
                )));
            }
            Err(err) if markdown_path.exists() => {
                return Ok(Some(json!({
                    "format": "markdown_with_json_parse_error",
                    "json_path": json_path.display().to_string(),
                    "json_parse_error": err.to_string(),
                    "markdown_path": markdown_path.display().to_string(),
                    "excerpt": json_file_window_text(&markdown_path, 8_000)?,
                    "content_policy": "markdown fallback excerpt only; do not inline the full notebook",
                })));
            }
            Err(err) => {
                return Ok(Some(json!({
                    "format": "json_parse_error",
                    "path": json_path.display().to_string(),
                    "parse_error": err.to_string(),
                })));
            }
        }
    }
    if markdown_path.exists() {
        return Ok(Some(json!({
            "format": "markdown",
            "path": markdown_path.display().to_string(),
            "excerpt": json_file_window_text(&markdown_path, 8_000)?,
            "content_policy": "markdown fallback excerpt only; do not inline the full notebook",
        })));
    }
    Ok(None)
}
