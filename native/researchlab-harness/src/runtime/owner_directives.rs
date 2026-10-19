//! A recorded channel for the owner to settle a choice a role would otherwise make.
//!
//! The owner has been steering this cycle through me: target a journal rather
//! than a conference, secure novelty before the buyable axes, keep three methods
//! per problem. Each of those reached a lane as text I pasted into a role plan,
//! which means it applied once, to one lane, and left no record of who asked for
//! it or why. A directive that lives in my message and not in the runtime is a
//! directive the next dispatch does not have.
//!
//! So the same shape as the document-stage authorization: a file under state,
//! read fail-closed, requiring both the instruction and the reason for it. An
//! entry missing either is ignored rather than half-applied, because an
//! instruction nobody can account for later is indistinguishable from a
//! preference that leaked in.
//!
//! What a directive can and cannot do is worth being explicit about in the
//! rendered text. It settles a CHOICE the role owns -- which venue, which axis
//! first, how many methods before abandoning a question. It cannot make a role
//! assert a fact it has not verified: told to target a journal, the author picks
//! one and reads that journal's guidelines, and if the guidelines say something
//! inconvenient the guidelines win.

use serde_json::Value;
use std::path::Path;

/// One owner instruction, already validated.
#[derive(Debug, Clone)]
pub(crate) struct OwnerDirective {
    pub(crate) id: String,
    pub(crate) directive: String,
    pub(crate) reason: String,
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// True when the entry names this role, or names no role at all (cycle-wide).
fn applies_to_role(entry: &Value, role: &str) -> bool {
    match entry.get("roles").and_then(Value::as_array) {
        None => true,
        Some(roles) if roles.is_empty() => true,
        Some(roles) => roles
            .iter()
            .filter_map(Value::as_str)
            .any(|item| item.trim().eq_ignore_ascii_case(role)),
    }
}

pub(crate) fn directives_path(cwd: &Path, cycle_id: &str) -> std::path::PathBuf {
    cwd.join(".research-lab")
        .join("state")
        .join(format!("{cycle_id}-owner-directives.json"))
}

/// Read the directives that apply to one role.
///
/// Every failure mode here returns an empty list rather than an error: a lane
/// that cannot read the file must run without directives, not fail to run.
pub(crate) fn owner_directives_for_role(
    cwd: &Path,
    cycle_id: &str,
    role: &str,
) -> Vec<OwnerDirective> {
    let path = directives_path(cwd, cycle_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match value.get("directives").and_then(Value::as_array) {
        Some(entries) => entries,
        None => return Vec::new(),
    };
    entries
        .iter()
        .filter(|entry| applies_to_role(entry, role))
        .filter(|entry| entry.get("retired").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            // Both halves are required. An instruction with no reason cannot be
            // reviewed later, and a reason with no instruction directs nothing.
            let directive = non_empty(entry.get("directive"))?;
            let reason = non_empty(entry.get("reason"))?;
            let id = non_empty(entry.get("id")).unwrap_or_else(|| "owner-directive".to_string());
            Some(OwnerDirective {
                id,
                directive,
                reason,
            })
        })
        .collect()
}

/// Render the directives as a prompt block, or an empty string when there are none.
pub(crate) fn owner_directive_clause(cwd: &Path, cycle_id: &str, role: &str) -> String {
    let directives = owner_directives_for_role(cwd, cycle_id, role);
    if directives.is_empty() {
        return String::new();
    }
    let mut clause = String::from(
        "\n\nOWNER DIRECTIVE (BINDING). The owner of this research programme has \
         recorded the following for your role. A directive settles a choice that is \
         otherwise yours to make, and it outranks your own default preference. It \
         does NOT license asserting anything you have not verified: if a directive \
         sends you somewhere and what you find there contradicts it, follow what you \
         found and say so in your output rather than writing the directive as if it \
         were the finding.",
    );
    for directive in &directives {
        clause.push_str("\n- [");
        clause.push_str(&directive.id);
        clause.push_str("] ");
        clause.push_str(&directive.directive);
        clause.push_str("\n  Owner's reason: ");
        clause.push_str(&directive.reason);
    }
    clause
}
