//! The cycle's commitments: what directors have bound later directors to.
//!
//! A director that accepts an amendment, declares a prerequisite met or fixes a
//! term of the validation is making a statement meant to hold after it is gone.
//! Until now such a statement lived in that director's `validation_changes` and
//! in the notebook the next director rewrites, so it lasted as long as someone
//! happened to repeat it.
//!
//! MEASURED ON cycle-a-20260919: director 2011 accepted pilot seeds
//! [100,101] on 2026-11-16 and director 2016 declared the host-accounting
//! prerequisite met on 11-18; neither statement was anywhere in director 2067's
//! context three days later.
//!
//! Here a commitment is a record with an id, the lane that made it and the time
//! from which it holds. A director changes the set only by naming what it
//! changes -- `add`, `supersede` (an id, with the new claim) or `withdraw` (an
//! id) -- and the harness applies those updates in the order the directors
//! finished. Nothing is deleted: a commitment that ends keeps its claim, its end
//! time and the reason, which is how a memory stays consistent when facts change
//! (Zep's validity intervals, Rasmussen et al. 2025; Mem0's explicit
//! add/update/delete, Chhikara et al. 2025). The set in force is handed to every
//! director.

use super::*;

const MIN_CLAIM_CHARS: usize = 20;
const MAX_CLAIM_CHARS: usize = 400;
const MAX_IN_FORCE_SHOWN: usize = 40;
const ENDED_SHOWN: usize = 6;
const FEEDBACK_KEPT: usize = 8;

pub(crate) fn commitments_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-commitments.json"))
}

fn empty_register(cycle_id: &str) -> Value {
    json!({"cycle_id": cycle_id, "commitments": [], "feedback": [], "updated_at": Value::Null})
}

pub(crate) fn load_commitments(paths: &AppPaths, cycle_id: &str) -> Value {
    read_json(&commitments_path(paths, cycle_id))
        .ok()
        .filter(|value| value.get("commitments").is_some_and(Value::is_array))
        .unwrap_or_else(|| empty_register(cycle_id))
}

fn one_line(value: Option<&Value>, max_chars: usize) -> String {
    let text = value.and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(max_chars).collect()
}

fn claim_id(claim: &str) -> String {
    let normalized: String = claim.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    format!("cm-{}", &crate::labdirector::sota_cards::sha256_hex(normalized.as_bytes())[..8])
}

fn in_force(commitment: &Value) -> bool {
    commitment.get("status").and_then(Value::as_str) == Some("in_force")
}

/// Apply one director's `commitment_updates` to the register. Returns whether the
/// register changed. An update that cannot be applied changes nothing and is kept
/// as feedback for the next director.
pub(crate) fn apply_commitment_updates(register: &mut Value, lane_id: &str, at: &str, updates: &[Value]) -> bool {
    let mut changed = false;
    let mut feedback: Vec<Value> = Vec::new();
    for update in updates {
        let op = update.get("op").and_then(Value::as_str).unwrap_or("");
        let target = one_line(update.get("id"), 40);
        let claim = one_line(update.get("claim"), MAX_CLAIM_CHARS);
        let reason = one_line(update.get("reason"), 300);
        let commitments = register["commitments"].as_array_mut().expect("commitments is an array");
        let refuse = |why: String, feedback: &mut Vec<Value>| feedback.push(json!({"by": lane_id, "at": at, "op": op, "id": target, "not_applied": why}));
        match op {
            "add" | "supersede" => {
                if claim.chars().count() < MIN_CLAIM_CHARS {
                    refuse(format!("the claim must be a full statement of at least {MIN_CLAIM_CHARS} characters"), &mut feedback);
                    continue;
                }
                let id = claim_id(&claim);
                if op == "supersede" {
                    let Some(position) = commitments.iter().position(|item| in_force(item) && item.get("id").and_then(Value::as_str) == Some(target.as_str())) else {
                        refuse(format!("no commitment in force has the id '{target}'; name the id of the commitment this replaces"), &mut feedback);
                        continue;
                    };
                    commitments[position]["status"] = json!("superseded");
                    commitments[position]["invalid_at"] = json!(at);
                    commitments[position]["ended_by"] = json!(lane_id);
                    commitments[position]["superseded_by"] = json!(id);
                    commitments[position]["end_reason"] = json!(reason);
                    changed = true;
                }
                if commitments.iter().any(|item| in_force(item) && item.get("id").and_then(Value::as_str) == Some(id.as_str())) {
                    continue; // the same claim is already in force
                }
                let basis: Vec<Value> = update
                    .get("basis")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .take(4)
                    .map(|item| json!(item.chars().take(240).collect::<String>()))
                    .collect();
                commitments.push(json!({
                    "id": id,
                    "claim": claim,
                    "status": "in_force",
                    "made_by": lane_id,
                    "valid_from": at,
                    "invalid_at": Value::Null,
                    "basis": basis,
                    "replaces": if op == "supersede" { json!(target) } else { Value::Null },
                }));
                changed = true;
            }
            "withdraw" => {
                let Some(position) = commitments.iter().position(|item| in_force(item) && item.get("id").and_then(Value::as_str) == Some(target.as_str())) else {
                    refuse(format!("no commitment in force has the id '{target}'"), &mut feedback);
                    continue;
                };
                if reason.is_empty() {
                    refuse("withdrawing a commitment needs the reason".to_string(), &mut feedback);
                    continue;
                }
                commitments[position]["status"] = json!("withdrawn");
                commitments[position]["invalid_at"] = json!(at);
                commitments[position]["ended_by"] = json!(lane_id);
                commitments[position]["end_reason"] = json!(reason);
                changed = true;
            }
            _ => refuse("op must be add, supersede or withdraw".to_string(), &mut feedback),
        }
    }
    if !feedback.is_empty() {
        let kept = register["feedback"].as_array_mut().expect("feedback is an array");
        kept.extend(feedback);
        let excess = kept.len().saturating_sub(FEEDBACK_KEPT);
        kept.drain(..excess);
        changed = true;
    }
    if changed {
        register["updated_at"] = json!(at);
    }
    changed
}

/// Read one completed director's updates into the stored register.
pub(crate) fn record_director_commitments(paths: &AppPaths, cycle_id: &str, lane_id: &str, at: &str, payload: &Value) -> Result<()> {
    let Some(updates) = payload.get("commitment_updates").and_then(Value::as_array).filter(|updates| !updates.is_empty()) else {
        return Ok(());
    };
    let mut register = load_commitments(paths, cycle_id);
    if apply_commitment_updates(&mut register, lane_id, at, updates) {
        write_json(&commitments_path(paths, cycle_id), &register)?;
    }
    Ok(())
}

/// What every director lane is given: the commitments in force, the ones that
/// ended most recently, and any update of a predecessor that could not be applied.
pub(crate) fn commitments_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let register = load_commitments(paths, cycle_id);
    let all = register["commitments"].as_array().cloned().unwrap_or_default();
    let mut standing: Vec<Value> = all
        .iter()
        .filter(|item| in_force(item))
        .map(|item| json!({"id": item.get("id"), "claim": item.get("claim"), "since": item.get("valid_from"), "by": item.get("made_by"), "basis": item.get("basis")}))
        .collect();
    standing.reverse();
    let total = standing.len();
    standing.truncate(MAX_IN_FORCE_SHOWN);
    let mut ended: Vec<Value> = all
        .iter()
        .filter(|item| !in_force(item))
        .map(|item| json!({"id": item.get("id"), "claim": item.get("claim"), "status": item.get("status"), "ended": item.get("invalid_at"), "by": item.get("ended_by"), "why": item.get("end_reason"), "superseded_by": item.get("superseded_by")}))
        .collect();
    ended.reverse();
    ended.truncate(ENDED_SHOWN);
    json!({
        "in_force": standing,
        "in_force_total": total,
        "recently_ended": ended,
        "updates_not_applied": register.get("feedback").cloned().unwrap_or_else(|| json!([])),
        "recorded_in": format!(".research-lab/state/{cycle_id}-commitments.json"),
        "rule": "These are the commitments earlier directors made for the cycle: amendments accepted, prerequisites declared met, terms of the validation fixed. Each holds from `since` until a later director ends it BY ID; they are not suggestions and they do not lapse because you did not repeat them. Work within them. To bind your successors to something, emit it in `commitment_updates` as {\"op\": \"add\", \"claim\": \"one full sentence that stands on its own\", \"basis\": [paths]}; to change one, {\"op\": \"supersede\", \"id\": \"cm-...\", \"claim\": \"the new statement\", \"reason\": \"what changed\"}; to end one, {\"op\": \"withdraw\", \"id\": \"cm-...\", \"reason\": \"why\"}. A statement that contradicts a commitment in force without naming its id changes nothing. `validation_changes` describes this decision only; what must hold afterwards goes here.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register() -> Value {
        empty_register("c")
    }

    fn standing(register: &Value) -> Vec<String> {
        register["commitments"].as_array().unwrap().iter().filter(|item| in_force(item)).map(|item| item["claim"].as_str().unwrap().to_string()).collect()
    }

    // MEASURED: director 2011's accepted pilot seeds were gone from the context
    // three days and fifty directors later.
    #[test]
    fn a_commitment_holds_until_a_later_director_ends_it_by_id() {
        let mut register = register();
        assert!(apply_commitment_updates(&mut register, "followup-lab-director-2011", "2026-11-16T01:23:49Z", &[
            json!({"op": "add", "claim": "Pilot runs use seeds [100,101], two repeats; the eight confirmation seeds are unchanged.", "basis": ["lanes/followup-engineer-1269/result.json"]}),
        ]));
        // Fifty directors say nothing about it: it is still in force.
        for index in 0..50 {
            assert!(!apply_commitment_updates(&mut register, &format!("d{index}"), "2026-11-18T00:00:00Z", &[]));
        }
        assert_eq!(standing(&register).len(), 1);
        let id = register["commitments"][0]["id"].as_str().unwrap().to_string();

        // Saying the opposite without naming it changes nothing and is told back.
        apply_commitment_updates(&mut register, "d60", "2026-11-19T00:00:00Z", &[
            json!({"op": "supersede", "id": "cm-unknown", "claim": "Pilot runs use seeds [0,1] as first ordered.", "reason": "simpler"}),
        ]);
        assert_eq!(standing(&register), vec!["Pilot runs use seeds [100,101], two repeats; the eight confirmation seeds are unchanged."]);
        assert!(register["feedback"][0]["not_applied"].as_str().unwrap().contains("no commitment in force has the id"));

        // Naming it replaces it, and the old one is kept with its end.
        assert!(apply_commitment_updates(&mut register, "d61", "2026-11-20T00:00:00Z", &[
            json!({"op": "supersede", "id": id, "claim": "Pilot runs use seeds [200,201,202], three repeats.", "reason": "two seeds gave too wide an interval"}),
        ]));
        assert_eq!(standing(&register), vec!["Pilot runs use seeds [200,201,202], three repeats."]);
        let old = &register["commitments"][0];
        assert_eq!(old["status"], json!("superseded"));
        assert_eq!(old["invalid_at"], json!("2026-11-20T00:00:00Z"));
        assert_eq!(old["end_reason"], json!("two seeds gave too wide an interval"));
        assert_eq!(old["superseded_by"], register["commitments"][1]["id"]);
    }

    #[test]
    fn the_same_claim_is_recorded_once_and_a_withdrawal_needs_its_reason() {
        let mut register = register();
        let claim = "The Push-T release reproduction (334/500) is the anchor for later comparisons.";
        apply_commitment_updates(&mut register, "d1", "2026-11-18T05:05:36Z", &[json!({"op": "add", "claim": claim})]);
        apply_commitment_updates(&mut register, "d2", "2026-11-19T00:00:00Z", &[json!({"op": "add", "claim": format!("  {claim}  ")})]);
        assert_eq!(register["commitments"].as_array().unwrap().len(), 1);
        let id = register["commitments"][0]["id"].as_str().unwrap().to_string();
        apply_commitment_updates(&mut register, "d3", "2026-11-20T00:00:00Z", &[json!({"op": "withdraw", "id": id, "reason": ""})]);
        assert_eq!(standing(&register).len(), 1, "a withdrawal without a reason is not applied");
        apply_commitment_updates(&mut register, "d4", "2026-11-21T00:00:00Z", &[json!({"op": "withdraw", "id": id, "reason": "the evaluator was found to differ from the release"})]);
        assert!(standing(&register).is_empty());
        assert_eq!(register["commitments"][0]["status"], json!("withdrawn"));
        // Too short to stand on its own.
        apply_commitment_updates(&mut register, "d5", "2026-11-21T01:00:00Z", &[json!({"op": "add", "claim": "use seeds"})]);
        assert!(standing(&register).is_empty());
    }
}
