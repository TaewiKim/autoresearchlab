// What a context block may cost in a prompt, and where the rest of it stays.
//
// There was no such thing before this module, in the sense that matters: there
// was a cap TABLE, nine keys long, and it ran inside
// `attach_lab_director_context_controls` behind
//
//     if role != "lab-director" { return Ok(()); }
//
// so six of the eight roles were never capped at all. Measured on cycle-g-v89,
// counting only keys that table already named: the gatekeeper broke
// `review_action` on 373 of 374 plans, `chronicle_research_context` on 368 and
// `previous_review_context` on 245; the analyst broke `validation_results` on 84
// and `review_action` on 132; the lab-runner broke `review_action` on 78. Not
// one of those was a cap that failed. The cap was never reached.
//
// Two more things were wrong with capping where it was:
//
//   * it capped `planner_metadata` and not the role plan. Of the biggest blocks
//     in the cycle, `document_review_context` sat at the top level on 1,099
//     plans and in both places on 293; `cycle_memory_context` and
//     `agent_communication_digest_context` were top-level ONLY. A cap on one of
//     two placements is half a cap -- and worse, trimming one copy makes the two
//     differ, which stops `drop_duplicated_planner_metadata` from collapsing
//     them and renders both.
//
//   * `compact_json_context` did not compact anything. Over its limit it threw
//     the value away and left `{truncated, approx_bytes, reason}`, where the
//     reason says "use cycle state artifacts for full detail" and names no
//     artifact. A reader that hits one has lost the content and has not been
//     told where it went.
//
// So: one budget, applied once, at the boundary every plan crosses exactly
// once -- the prompt. Both placements together. Over the limit a block keeps as
// much of itself as fits, says which of its own fields did not fit, and carries
// the path to the untouched plan on disk. The plan file is never rewritten, so
// that path is always good.

use std::path::Path;

use serde_json::{json, Map, Value};

/// The per-block budget, in bytes of compact JSON.
///
/// Sized from the cycle rather than from taste. Each figure sits at or above
/// what that block normally weighs on cycle-g-v89, so the budget bites the tail
/// and not the common case: `chronicle_research_context` averages 2.3 KB against
/// a 12 KB budget, `gate_reviewer_context` 14.4 KB against 24 KB. Where it does
/// bite, it is biting something that had already run away -- `gate_restart_policy`
/// averaged 94.7 KB and reached 128.9 KB, `document_review_context` reached
/// 122.2 KB on an ILLUSTRATOR lane, and `review_action` reached 168.7 KB.
///
/// A block not named here is not budgeted. That is deliberate: an unmeasured cap
/// is a guess about what a role can afford to lose.
pub(crate) const CONTEXT_BUDGET: &[(&str, usize)] = &[
    ("document_review_context", 48 * 1024),
    ("review_action", 48 * 1024),
    ("gate_restart_policy", 48 * 1024),
    ("analyst_handoff", 48 * 1024),
    ("analysis_request", 32 * 1024),
    ("validation_results", 32 * 1024),
    ("cycle_memory_context", 32 * 1024),
    ("research_notes_context", 32 * 1024),
    ("gate_reviewer_context", 24 * 1024),
    ("agent_communication_digest_context", 16 * 1024),
    ("latest_completed_lab_runner_context", 16 * 1024),
    ("chronicle_gate_deliberation_context", 12 * 1024),
    ("chronicle_research_context", 12 * 1024),
    ("previous_review_context", 12 * 1024),
    ("open_source_analysis_agent_mandate", 12 * 1024),
    ("blocker_reasons", 12 * 1024),
    ("challenge_questions", 12 * 1024),
];

/// What the budget did, so the caller can say it in the prompt rather than
/// letting content change size silently.
#[derive(Debug, Default)]
pub(crate) struct BudgetOutcome {
    pub(crate) trimmed: Vec<String>,
    pub(crate) elided: Vec<String>,
    pub(crate) bytes_saved: usize,
}

impl BudgetOutcome {
    pub(crate) fn is_empty(&self) -> bool {
        self.trimmed.is_empty() && self.elided.is_empty()
    }
}

pub(crate) fn json_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map(|bytes| bytes.len()).unwrap_or(0)
}

fn budget_for(key: &str) -> Option<usize> {
    CONTEXT_BUDGET
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, max)| *max)
}

/// Where the whole block still is. The prompt boundary never rewrites the plan
/// on disk, so this path resolves for the life of the cycle.
fn full_value_ref(role_plan_path: Option<&Path>, json_path: &str) -> Value {
    match role_plan_path {
        Some(path) => json!({ "file": path.display().to_string(), "json_path": json_path }),
        None => json!({ "json_path": json_path }),
    }
}

/// Keep what fits and say what did not.
///
/// An object keeps whole fields in its own order while the budget lasts. A field
/// too big to keep whole is trimmed INTO what is left rather than dropped: one
/// oversized field is the usual case, not the exception, and dropping it whole
/// is the same cliff this module exists to remove. Measured: an author's
/// `document_review_context` is one 99 KB `paper` beside a 3 KB `report`, so
/// keeping only whole fields would hand the author the report and none of the
/// review it has to answer. An array keeps a leading run and says how many items
/// it left behind. A string is cut on a character boundary. In every case the
/// result carries the path to the whole thing.
/// What the `context_budget` note costs, so the trimmer spends a budget it
/// actually has. A round guess is how a cap ends up over its own cap: the note
/// carries the plan path and can name every field it left out.
fn note_reserve(source: &Value, keys: impl Iterator<Item = usize>) -> usize {
    let base = json_bytes(&json!({
        "context_budget": {
            "fields_not_shown": [],
            "fields_shortened": [],
            "items_not_shown": 0,
            "items_total": 0,
            "characters_not_shown": 0,
            "full_value_in": source,
            "reason": "this block is over its prompt budget; what is here is the part that fit",
        }
    }));
    base + keys.map(|len| len + 4).sum::<usize>() + 64
}

fn trim_to_budget(value: &Value, max_bytes: usize, source: Value) -> Value {
    // Below this there is no room for a head worth reading, only for the note
    // saying it is missing.
    const SMALLEST_USEFUL_HEAD: usize = 1_024;

    match value {
        Value::Object(fields) => {
            // Cheapest first, so a verdict is never lost to a comment blob that
            // happened to sort before it. serde_json orders a map by key unless
            // the preserve_order feature is on, so field order here is alphabet,
            // not intent -- spending the budget in that order is spending it at
            // random.
            let mut by_cost: Vec<(&String, &Value, usize)> = fields
                .iter()
                .map(|(key, field)| (key, field, json_bytes(field) + key.len() + 4))
                .collect();
            by_cost.sort_by_key(|(_, _, cost)| *cost);

            let mut spent = note_reserve(&source, fields.keys().map(String::len));
            let mut too_big: Vec<&String> = Vec::new();
            for (key, _, cost) in &by_cost {
                if spent + cost <= max_bytes {
                    spent += cost;
                } else {
                    too_big.push(key);
                }
            }
            if too_big.is_empty() {
                return value.clone();
            }
            // What is left is shared evenly, so one huge field cannot take the
            // whole remainder and leave the next one nothing.
            let share = max_bytes.saturating_sub(spent) / too_big.len();

            let mut kept = Map::new();
            let mut dropped: Vec<String> = Vec::new();
            let mut shortened: Vec<String> = Vec::new();
            for (key, field) in fields {
                if !too_big.contains(&key) {
                    kept.insert(key.clone(), field.clone());
                    continue;
                }
                let room = share.saturating_sub(key.len() + 4);
                if room >= SMALLEST_USEFUL_HEAD {
                    kept.insert(key.clone(), trim_to_budget(field, room, source.clone()));
                    shortened.push(key.clone());
                } else {
                    dropped.push(key.clone());
                }
            }
            kept.insert(
                "context_budget".to_string(),
                json!({
                    "fields_not_shown": dropped,
                    "fields_shortened": shortened,
                    "full_value_in": source,
                    "reason": "this block is over its prompt budget; what is here is the part that fit",
                }),
            );
            debug_assert!(
                json_bytes(&Value::Object(kept.clone())) <= max_bytes,
                "trimmed block is still over its budget",
            );
            Value::Object(kept)
        }
        Value::Array(items) => {
            let mut kept: Vec<Value> = Vec::new();
            let mut spent = note_reserve(&source, std::iter::empty());
            for item in items {
                let cost = json_bytes(item) + 2;
                if spent + cost > max_bytes {
                    break;
                }
                spent += cost;
                kept.push(item.clone());
            }
            if kept.len() == items.len() {
                return value.clone();
            }
            let remaining = items.len() - kept.len();
            kept.push(json!({
                "context_budget": {
                    "items_not_shown": remaining,
                    "items_total": items.len(),
                    "full_value_in": source,
                    "reason": "this list is over its prompt budget; the entries above are the ones that fit",
                }
            }));
            Value::Array(kept)
        }
        Value::String(text) => {
            let keep = max_bytes.saturating_sub(note_reserve(&source, std::iter::empty()) + 16);
            let mut cut = String::new();
            for ch in text.chars() {
                if cut.len() + ch.len_utf8() > keep {
                    break;
                }
                cut.push(ch);
            }
            if cut.len() == text.len() {
                return value.clone();
            }
            json!({
                "text": cut,
                "context_budget": {
                    "characters_not_shown": text.chars().count() - cut.chars().count(),
                    "full_value_in": source,
                    "reason": "this text is over its prompt budget",
                },
            })
        }
        // A number or a bool cannot be over budget, and null has nothing to keep.
        other => other.clone(),
    }
}

/// A nested block byte-identical to a sibling block in the same plan.
///
/// MEASURED ON cycle-g-v89: 21.46 MB of 160.5 MB of role plans -- 13.4% -- is a
/// block nested one level inside another block and byte-identical to a block
/// sitting beside it. `review_action` alone re-carries `analysis_request` (5.64
/// MB over 206 plans), `validation_results` (3.07 MB over 450),
/// `impact_first_hypothesis_mandate`, `previous_review_summary`,
/// `hypothesis_generation_policy` and `reference_literature_summary`;
/// `gate_reviewer_context` re-carries `chronicle_research_context` and
/// `previous_review_context` on 373 plans each.
///
/// `drop_duplicated_planner_metadata` cannot see any of it: it compares a
/// top-level key against the planner_metadata key of the same name, which is
/// depth one, and this is depth two.
///
/// Replacing the nested copy costs no information at all. The block it points at
/// is in the same prompt, and the path to the plan on disk is there either way.
fn elide_nested_copies(
    role_plan: &mut Value,
    role_plan_path: Option<&Path>,
    outcome: &mut BudgetOutcome,
) {
    let Some(object) = role_plan.as_object() else {
        return;
    };
    // What a sibling name resolves to in the plan the model will read, and where
    // the reader should be sent to find it.
    let mut siblings: Map<String, Value> = Map::new();
    let mut where_it_is: Map<String, Value> = Map::new();
    for (key, value) in object {
        if key == "planner_metadata" {
            continue;
        }
        siblings.insert(key.clone(), value.clone());
        where_it_is.insert(key.clone(), json!(format!("$.{key}")));
    }
    if let Some(metadata) = object.get("planner_metadata").and_then(Value::as_object) {
        for (key, value) in metadata {
            if !siblings.contains_key(key) {
                siblings.insert(key.clone(), value.clone());
                where_it_is.insert(key.clone(), json!(format!("$.planner_metadata.{key}")));
            }
        }
    }

    let mut replacements: Vec<(Vec<String>, String, Value, usize)> = Vec::new();
    let scan = |parent_path: Vec<String>,
                parent_key: &str,
                parent: &Value,
                out: &mut Vec<(Vec<String>, String, Value, usize)>| {
        let Some(children) = parent.as_object() else {
            return;
        };
        for (child_key, child) in children {
            // A block is not a copy of itself, and only a structure is worth
            // pointing at -- a shared scalar is cheaper inline than as a pointer.
            if child_key == parent_key || !matches!(child, Value::Object(_) | Value::Array(_)) {
                continue;
            }
            if json_bytes(child) < 512 {
                continue;
            }
            if siblings.get(child_key) == Some(child) {
                let pointer = where_it_is
                    .get(child_key)
                    .cloned()
                    .unwrap_or_else(|| json!(format!("$.{child_key}")));
                out.push((
                    parent_path.clone(),
                    child_key.clone(),
                    pointer,
                    json_bytes(child),
                ));
            }
        }
    };

    for (key, value) in object {
        if key == "planner_metadata" {
            continue;
        }
        scan(vec![key.clone()], key, value, &mut replacements);
    }
    if let Some(metadata) = object.get("planner_metadata").and_then(Value::as_object) {
        for (key, value) in metadata {
            scan(
                vec!["planner_metadata".to_string(), key.clone()],
                key,
                value,
                &mut replacements,
            );
        }
    }

    for (parent_path, child_key, pointer, bytes) in replacements {
        // A JSON pointer rather than a walk: stepping with `get_mut` in a loop
        // keeps the first borrow alive past the loop, which the borrow checker
        // rejects, and the escaping here is the one RFC 6901 asks for.
        let json_pointer: String = parent_path
            .iter()
            .map(|step| format!("/{}", step.replace('~', "~0").replace('/', "~1")))
            .collect();
        let Some(parent) = role_plan
            .pointer_mut(&json_pointer)
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        parent.insert(
            child_key.clone(),
            json!({
                "same_as": pointer,
                "omitted_bytes": bytes,
                "full_value_in": full_value_ref(role_plan_path, pointer.as_str().unwrap_or("$")),
                "reason": "identical to the block this points at, in this same role plan; it is not repeated here",
            }),
        );
        outcome.elided.push(format!("{}.{}", parent_path.join("."), child_key));
        outcome.bytes_saved += bytes;
    }
}

/// Apply the budget to a role plan on its way into a prompt.
///
/// Both placements of a key move together, so a key that is byte-identical at
/// the top level and under `planner_metadata` stays byte-identical and
/// `drop_duplicated_planner_metadata` can still collapse it.
pub(crate) fn apply_prompt_context_budget(
    mut role_plan: Value,
    role_plan_path: Option<&Path>,
) -> (Value, BudgetOutcome) {
    let mut outcome = BudgetOutcome::default();
    if !role_plan.is_object() {
        return (role_plan, outcome);
    }

    elide_nested_copies(&mut role_plan, role_plan_path, &mut outcome);

    let mut budgeted: Map<String, Value> = Map::new();
    if let Some(object) = role_plan.as_object() {
        for (key, value) in object {
            let Some(max_bytes) = budget_for(key) else {
                continue;
            };
            if json_bytes(value) <= max_bytes {
                continue;
            }
            let source = full_value_ref(role_plan_path, &format!("$.{key}"));
            budgeted.insert(key.clone(), trim_to_budget(value, max_bytes, source));
        }
        if let Some(metadata) = object.get("planner_metadata").and_then(Value::as_object) {
            for (key, value) in metadata {
                if budgeted.contains_key(key) {
                    continue;
                }
                let Some(max_bytes) = budget_for(key) else {
                    continue;
                };
                if json_bytes(value) <= max_bytes {
                    continue;
                }
                let source =
                    full_value_ref(role_plan_path, &format!("$.planner_metadata.{key}"));
                budgeted.insert(key.clone(), trim_to_budget(value, max_bytes, source));
            }
        }
    }

    for (key, trimmed) in budgeted {
        let before_top = role_plan.get(&key).map(json_bytes).unwrap_or(0);
        let before_meta = role_plan
            .get("planner_metadata")
            .and_then(|meta| meta.get(&key))
            .map(json_bytes)
            .unwrap_or(0);
        let after = json_bytes(&trimmed);
        if let Some(object) = role_plan.as_object_mut() {
            if object.contains_key(&key) {
                object.insert(key.clone(), trimmed.clone());
                outcome.bytes_saved += before_top.saturating_sub(after);
            }
        }
        if let Some(metadata) = role_plan
            .get_mut("planner_metadata")
            .and_then(Value::as_object_mut)
        {
            if metadata.contains_key(&key) {
                metadata.insert(key.clone(), trimmed);
                outcome.bytes_saved += before_meta.saturating_sub(after);
            }
        }
        outcome.trimmed.push(key);
    }
    outcome.trimmed.sort();
    outcome.elided.sort();
    (role_plan, outcome)
}

/// One line for the prompt, so a role knows a block was shortened and where the
/// rest is rather than inferring it from a block that looks complete.
pub(crate) fn budget_note(outcome: &BudgetOutcome) -> String {
    if outcome.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    if !outcome.trimmed.is_empty() {
        parts.push(format!(
            "shortened to their prompt budget: {}",
            outcome.trimmed.join(", ")
        ));
    }
    if !outcome.elided.is_empty() {
        parts.push(format!(
            "{} repeated block(s) replaced by a pointer to the copy already in this plan",
            outcome.elided.len()
        ));
    }
    format!(
        "\nContext budget: {}. Every shortened block names the fields it left out and the role-plan.json path that still holds all of it; open that file if you need what is missing.",
        parts.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn plan_path() -> PathBuf {
        PathBuf::from("/opt/researchlab/.research-lab/lanes/c/lane-1/role-plan.json")
    }

    #[test]
    fn a_nested_block_identical_to_a_sibling_becomes_a_pointer() {
        // cycle-g-v89: review_action.analysis_request was byte-identical to the
        // sibling analysis_request on 206 plans, 5.64 MB of pure repetition that
        // drop_duplicated_planner_metadata cannot see because it is depth two.
        let body = json!({ "question": "x".repeat(2_000), "estimand": "ate" });
        let plan = json!({
            "role": "analyst",
            "analysis_request": body,
            "review_action": { "type": "methods_followup", "analysis_request": body },
        });
        let (out, outcome) = apply_prompt_context_budget(plan, Some(&plan_path()));
        let nested = &out["review_action"]["analysis_request"];
        assert_eq!(nested["same_as"], json!("$.analysis_request"));
        assert!(nested["omitted_bytes"].as_u64().unwrap() > 2_000);
        // The block it points at is untouched, so nothing was lost.
        assert_eq!(out["analysis_request"], body);
        assert_eq!(outcome.elided, vec!["review_action.analysis_request"]);
        assert!(outcome.bytes_saved > 2_000);
    }

    #[test]
    fn a_nested_block_that_differs_from_its_sibling_is_left_alone() {
        let plan = json!({
            "analysis_request": { "question": "a".repeat(1_000) },
            "review_action": { "analysis_request": { "question": "b".repeat(1_000) } },
        });
        let (out, outcome) = apply_prompt_context_budget(plan.clone(), Some(&plan_path()));
        assert_eq!(out["review_action"]["analysis_request"], plan["review_action"]["analysis_request"]);
        assert!(outcome.elided.is_empty());
    }

    #[test]
    fn an_over_budget_block_keeps_a_head_of_its_biggest_field_not_none_of_it() {
        // The old compactor replaced the whole value with {truncated, approx_bytes,
        // reason} and named no artifact, so a reader lost the content AND the way
        // back to it. Keeping only the fields that fit WHOLE has the same effect
        // whenever one field is the block: an author's document_review_context is
        // a 99 KB `paper` beside a 3 KB `report`.
        let plan = json!({
            "role": "author",
            "document_review_context": {
                "report": { "verdict": "revise" },
                "paper": { "comments": "c".repeat(90 * 1024) },
            },
        });
        let (out, outcome) = apply_prompt_context_budget(plan, Some(&plan_path()));
        let block = &out["document_review_context"];
        assert_eq!(block["report"]["verdict"], json!("revise"));
        // The big field is still there, shortened, not gone.
        assert!(block.get("paper").is_some(), "the review the author must answer was dropped");
        assert_eq!(block["context_budget"]["fields_shortened"], json!(["paper"]));
        assert_eq!(block["context_budget"]["fields_not_shown"], json!([]));
        assert_eq!(
            block["context_budget"]["full_value_in"]["file"],
            json!(plan_path().display().to_string())
        );
        assert!(json_bytes(block) <= 48 * 1024);
        assert_eq!(outcome.trimmed, vec!["document_review_context"]);
    }

    #[test]
    fn both_placements_are_trimmed_together_so_the_dedupe_still_fires() {
        // Trimming one copy and not the other makes them differ, which stops
        // drop_duplicated_planner_metadata collapsing them and renders BOTH.
        let block = json!({ "keep": "k", "bulk": "z".repeat(40 * 1024) });
        let plan = json!({
            "role": "author",
            "document_review_context": block,
            "planner_metadata": { "document_review_context": block },
        });
        let (out, _) = apply_prompt_context_budget(plan, Some(&plan_path()));
        assert_eq!(
            out["document_review_context"],
            out["planner_metadata"]["document_review_context"],
        );
    }

    #[test]
    fn the_budget_applies_whatever_the_role_is() {
        // The cap table used to sit behind `if role != "lab-director" { return }`,
        // so the gatekeeper broke review_action on 373 of its 374 plans.
        for role in ["gatekeeper", "analyst", "lab-runner", "chronicle", "author"] {
            let plan = json!({
                "role": role,
                "review_action": { "type": "t", "bulk": "z".repeat(60 * 1024) },
            });
            let (out, outcome) = apply_prompt_context_budget(plan, Some(&plan_path()));
            assert!(
                json_bytes(&out["review_action"]) <= 48 * 1024,
                "{role} was not budgeted",
            );
            assert_eq!(outcome.trimmed, vec!["review_action"], "{role}");
        }
    }

    #[test]
    fn a_block_within_its_budget_is_returned_byte_for_byte() {
        let plan = json!({
            "role": "scout",
            "chronicle_research_context": { "notes": ["a", "b"] },
            "untracked_key": { "bulk": "z".repeat(80 * 1024) },
        });
        let (out, outcome) = apply_prompt_context_budget(plan.clone(), Some(&plan_path()));
        assert_eq!(out, plan);
        assert!(outcome.is_empty());
    }

    #[test]
    fn an_over_budget_list_keeps_a_leading_run_and_counts_the_rest() {
        let items: Vec<Value> = (0..400)
            .map(|i| json!({ "blocker": format!("{i}-{}", "x".repeat(200)) }))
            .collect();
        let plan = json!({ "role": "author", "blocker_reasons": items });
        let (out, _) = apply_prompt_context_budget(plan, Some(&plan_path()));
        let list = out["blocker_reasons"].as_array().unwrap();
        assert!(list.len() < 400);
        let tail = list.last().unwrap();
        assert!(tail["context_budget"]["items_not_shown"].as_u64().unwrap() > 0);
        assert_eq!(tail["context_budget"]["items_total"], json!(400));
    }

    #[test]
    fn the_note_says_what_happened_and_where_the_rest_is() {
        let outcome = BudgetOutcome {
            trimmed: vec!["review_action".to_string()],
            elided: vec!["review_action.validation_results".to_string()],
            bytes_saved: 10,
        };
        let note = budget_note(&outcome);
        assert!(note.contains("review_action"));
        assert!(note.contains("role-plan.json"));
        assert!(budget_note(&BudgetOutcome::default()).is_empty());
    }
}
