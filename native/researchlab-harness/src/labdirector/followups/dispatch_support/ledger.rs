#![allow(unused_imports)]
use super::*;

pub(crate) fn ledger_denies_pivot(paths: &AppPaths, cycle_id: &str) -> Option<String> {
    let path = state_root(paths).join(format!("{cycle_id}-hypothesis-progress.jsonl"));
    let content = fs::read_to_string(&path).ok()?;
    let mut latest: Option<(String, String)> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("event_type").and_then(Value::as_str) != Some("lead_supersession_decision") {
            continue;
        }
        let decision = value.get("decision").cloned().unwrap_or(Value::Null);
        latest = Some((
            decision
                .get("decision")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            decision
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ));
    }
    match latest {
        Some((decision, reason)) if decision == "deny" => Some(if reason.is_empty() {
            "ledger_denies_pivot".to_string()
        } else {
            reason
        }),
        _ => None,
    }
}

// The in-place instruction used when the ledger denies a pivot. Mirrors the JS
// keep-refining requery (reviews/gate/actions.js) so every dispatcher tells
// the director the same thing instead of contradicting the JS-side guard.
pub(crate) fn ledger_keep_refining_clause(reason: &str) -> String {
    format!(
        " LEDGER PIVOT DENY ({reason}): the append-only hypothesis-progress ledger shows the protected best-so-far lead is STILL IMPROVING (or inside its commit window: a lead's first two novelty-reviewed gate rounds, novelty_refinement_window, or a strong validation's strong_validation_commit_window). Do NOT demote it, do NOT select a replacement family, and do NOT restart hypothesis generation this round. KEEP the protected lead and raise ONLY its binding (lowest) rubric in place: strengthen soundness with new validation, or escalate novelty/impact via mechanism sharpening, head-to-head runs against the reviewer's named prior-art baselines, and a contribution reframe. A pivot becomes permitted automatically once the ledger reports lead_stalled_pivot_permitted (binding rubric flat across consecutive reviewed rounds) or a strictly better candidate appears."
    )
}

pub(crate) fn completed_followup_source_key(
    role: &str,
    action_type: &str,
    source_brief_id: &str,
) -> String {
    format!("{role}::{action_type}::{source_brief_id}")
}
