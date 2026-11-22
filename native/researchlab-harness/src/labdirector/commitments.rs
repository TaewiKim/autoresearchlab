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
//!
//! A director may still not write one. MEASURED 2026-11-22, same cycle: of the
//! fourteen directors after the register existed, one emitted an update; the
//! other thirteen restated their standing terms in `validation_changes` at every
//! decision ("Preserve visual pilot seeds [100,101] and unused visual
//! confirmation seeds [0-7]" in each of 2079-2084), which is the repetition the
//! register exists to make unnecessary. So the harness reads the terms too: one
//! that three directors in a row state for the same lead is recorded as a
//! commitment in the latest director's words, marked as recorded by the harness,
//! and from then on it holds whether or not anyone repeats it.

use super::*;

const MIN_CLAIM_CHARS: usize = 20;
const MAX_CLAIM_CHARS: usize = 400;
const MAX_IN_FORCE_SHOWN: usize = 40;
const ENDED_SHOWN: usize = 6;
const FEEDBACK_KEPT: usize = 8;
/// How many directors in a row must state a term before the harness records it.
const RESTATED_BY: usize = 3;
/// Word overlap (Jaccard) at which two wordings are the same term. MEASURED:
/// director 2086 reworded the seeds term of 2084 and 2085 ("the reserved ...,
/// and the historical panel's retirement") to an overlap of 0.65.
const SAME_TERM: f64 = 0.6;

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

/// A validation term, cut into the sentences it is made of. Directors join a
/// standing term to a new one in a single item, so the sentence is what repeats.
fn sentences(item: &str) -> Vec<String> {
    let text = item.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    for index in 0..chars.len() {
        let ends = matches!(chars[index], '.' | '!' | '?')
            && chars.get(index + 1) == Some(&' ')
            && chars.get(index + 2).is_some_and(|next| next.is_uppercase());
        if ends {
            out.push(chars[start..=index].iter().collect::<String>());
            start = index + 2;
        }
    }
    if start < chars.len() {
        out.push(chars[start..].iter().collect::<String>());
    }
    out.into_iter().map(|sentence| sentence.trim().to_string()).filter(|sentence| !sentence.is_empty()).collect()
}

fn words(text: &str) -> std::collections::BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn same_term(left: &str, right: &str) -> bool {
    let (left, right) = (words(left), words(right));
    if left.is_empty() || right.is_empty() {
        return false;
    }
    let shared = left.intersection(&right).count();
    shared as f64 / (left.len() + right.len() - shared) as f64 >= SAME_TERM
}

/// Whether a term is said by a text, as the whole of it or as one of its sentences.
fn said_by(term: &str, text: &str) -> bool {
    same_term(term, text) || sentences(text).iter().any(|sentence| same_term(term, sentence))
}

fn lead_family(payload: &Value) -> String {
    let Some(selected) = payload.get("selected_hypothesis").filter(|selected| selected.is_object()) else {
        return String::new();
    };
    ["primary_family", "family", "hypothesis_family", "lead_family", "family_id"]
        .iter()
        .find_map(|key| selected.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Record the validation terms this director states that the directors just
/// before it stated too. `terms` is its `validation_changes`; the register keeps
/// the terms of the directors before it. Returns whether the register changed.
pub(crate) fn record_restated_terms(register: &mut Value, lane_id: &str, at: &str, family: &str, terms: &[String]) -> bool {
    // A director that selected no lead states the terms of no lead: it neither
    // restates anything nor breaks a run of restatements.
    if family.is_empty() {
        return false;
    }
    let window: Vec<Value> = register.get("recent_terms").and_then(Value::as_array).cloned().unwrap_or_default();
    let prior: Vec<(String, Vec<String>)> = window
        .iter()
        .map(|entry| {
            let stated = entry.get("terms").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            (entry.get("lane_id").and_then(Value::as_str).unwrap_or("").to_string(), stated)
        })
        .collect();
    let same_lead = window.iter().all(|entry| entry.get("family").and_then(Value::as_str) == Some(family));
    let fits = |text: &str| (MIN_CLAIM_CHARS..=MAX_CLAIM_CHARS).contains(&text.chars().count());
    let mut restated: Vec<String> = Vec::new();
    if same_lead && prior.len() + 1 >= RESTATED_BY {
        for term in terms {
            // The whole item where the whole item repeats, so that a sentence
            // leaning on the one before it keeps it; otherwise each sentence.
            let whole = term.split_whitespace().collect::<Vec<_>>().join(" ");
            let whole_repeats = fits(&whole) && prior.iter().all(|(_, stated)| stated.iter().any(|earlier| same_term(&whole, earlier)));
            let candidates = if whole_repeats { vec![whole] } else { sentences(&whole) };
            for candidate in candidates {
                let stated_before = prior.iter().all(|(_, stated)| stated.iter().any(|earlier| said_by(&candidate, earlier)));
                if fits(&candidate) && stated_before && !restated.iter().any(|kept| said_by(&candidate, kept)) {
                    restated.push(candidate);
                }
            }
        }
    }
    let mut lanes: Vec<Value> = prior.iter().map(|(lane, _)| json!(lane)).collect();
    lanes.push(json!(lane_id));
    let commitments = register["commitments"].as_array_mut().expect("commitments is an array");
    let mut recorded = false;
    for claim in restated {
        let covered = commitments.iter().any(|item| {
            in_force(item)
                && item.get("lead_family").and_then(Value::as_str).is_none_or(|scope| scope == family)
                && item.get("claim").and_then(Value::as_str).is_some_and(|standing| said_by(&claim, standing))
        });
        if covered {
            continue;
        }
        commitments.push(json!({
            "id": claim_id(&claim),
            "claim": claim,
            "status": "in_force",
            "made_by": lane_id,
            "valid_from": at,
            "invalid_at": Value::Null,
            "basis": [],
            "replaces": Value::Null,
            "recorded_by": "harness",
            "restated_by": lanes,
            "lead_family": family,
        }));
        recorded = true;
    }
    let mut kept = window;
    kept.push(json!({"lane_id": lane_id, "at": at, "family": family, "terms": terms}));
    let excess = kept.len().saturating_sub(RESTATED_BY - 1);
    kept.drain(..excess);
    register["recent_terms"] = Value::Array(kept);
    if recorded {
        register["updated_at"] = json!(at);
    }
    true
}

/// Read one completed director into the stored register: the updates it wrote,
/// then the terms it restated without writing one.
pub(crate) fn record_director_commitments(paths: &AppPaths, cycle_id: &str, lane_id: &str, at: &str, payload: &Value) -> Result<()> {
    let mut register = load_commitments(paths, cycle_id);
    let updates = payload.get("commitment_updates").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut changed = !updates.is_empty() && apply_commitment_updates(&mut register, lane_id, at, &updates);
    let terms: Vec<String> = payload
        .get("validation_changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|term| !term.contains("research-notes") && !term.to_lowercase().contains("notes saved"))
        .map(|term| term.chars().take(1200).collect())
        .take(12)
        .collect();
    changed |= record_restated_terms(&mut register, lane_id, at, &lead_family(payload), &terms);
    if changed {
        write_json(&commitments_path(paths, cycle_id), &register)?;
    }
    Ok(())
}

/// What every director lane is given: the commitments in force, the ones that
/// ended most recently, and any update of a predecessor that could not be applied.
pub(crate) fn commitments_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let register = load_commitments(paths, cycle_id);
    let all = register["commitments"].as_array().cloned().unwrap_or_default();
    // A term the harness recorded is a term of the lead it was stated for. While
    // another lead stands it waits, in force, and it returns with its own lead.
    let current_family = register
        .get("recent_terms")
        .and_then(Value::as_array)
        .and_then(|window| window.last())
        .and_then(|entry| entry.get("family"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let of_this_lead = |item: &Value| item.get("lead_family").and_then(Value::as_str).is_none_or(|scope| current_family.is_empty() || scope == current_family);
    let waiting = all.iter().filter(|item| in_force(item) && !of_this_lead(item)).count();
    let mut standing: Vec<Value> = all
        .iter()
        .filter(|item| in_force(item) && of_this_lead(item))
        .map(|item| {
            if item.get("recorded_by").and_then(Value::as_str) == Some("harness") {
                json!({"id": item.get("id"), "claim": item.get("claim"), "since": item.get("valid_from"), "recorded_by": "harness", "restated_by": item.get("restated_by")})
            } else {
                json!({"id": item.get("id"), "claim": item.get("claim"), "since": item.get("valid_from"), "by": item.get("made_by"), "basis": item.get("basis")})
            }
        })
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
        "in_force_for_other_leads": waiting,
        "recently_ended": ended,
        "updates_not_applied": register.get("feedback").cloned().unwrap_or_else(|| json!([])),
        "recorded_in": format!(".research-lab/state/{cycle_id}-commitments.json"),
        "rule": format!("These are the commitments earlier directors made for the cycle: amendments accepted, prerequisites declared met, terms of the validation fixed. Each holds from `since` until a later director ends it BY ID; they are not suggestions and they do not lapse because you did not repeat them. Work within them. To bind your successors to something, emit it in `commitment_updates` as {{\"op\": \"add\", \"claim\": \"one full sentence that stands on its own\", \"basis\": [paths]}}; to change one, {{\"op\": \"supersede\", \"id\": \"cm-...\", \"claim\": \"the new statement\", \"reason\": \"what changed\"}}; to end one, {{\"op\": \"withdraw\", \"id\": \"cm-...\", \"reason\": \"why\"}}. A statement that contradicts a commitment in force without naming its id changes nothing. `validation_changes` is what THIS decision asks for next; a term that must keep holding is written here once, and a commitment in force is not restated there. A term that {RESTATED_BY} directors in a row state for the same lead is recorded here by the harness in the last one's words (`recorded_by`: harness); when one of those is no longer right, supersede or withdraw it by id."),
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

    fn restate(register: &mut Value, lane: &str, family: &str, terms: &[&str]) {
        let terms: Vec<String> = terms.iter().map(|term| term.to_string()).collect();
        record_restated_terms(register, lane, "2026-11-22T06:00:00Z", family, &terms);
    }

    // MEASURED: directors 2079-2084 each restated the pilot seeds inside a
    // different item of `validation_changes`, and none wrote a commitment.
    #[test]
    fn a_term_three_directors_in_a_row_state_is_recorded_once_in_the_last_ones_words() {
        let mut register = register();
        let family = "cross_architecture_support_distance_curves";
        restate(&mut register, "followup-lab-director-2082", family, &[
            "After a qualified candidate is frozen, allocate two verified unused compact-state held-out development seeds. Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].",
            "For a later authorized xArm7 check, preselect one in-support and one out-of-support reset matched on independent reference feasibility and action demand. Use the same distance scale and endpoint tolerances.",
        ]);
        restate(&mut register, "followup-lab-director-2083", family, &[
            "Archive both failed compact-state qualifications as development evidence. Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].",
            "For a later xArm7 plan, preselect one in-support and one out-of-support reset matched on independent feasibility and action demand. Use the same distance definition and endpoint tolerances.",
        ]);
        assert!(standing(&register).is_empty(), "two statements are not yet a standing term");
        restate(&mut register, "followup-lab-director-2084", family, &[
            "Run the identical pilot and ordered diagnostic grid once. Archive the exact-anchor results as development evidence.",
            "After all five arms qualify, freeze the recipe. Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].",
            "For a later xArm7 plan, preselect one in-support and one out-of-support reset matched on independent feasibility and action demand. Use the same distance definition and endpoint tolerances.",
        ]);
        assert_eq!(standing(&register), vec![
            // The sentence that repeats, not the item it happened to sit in.
            "Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].",
            // The whole item where the whole item repeats: its second sentence leans on the first.
            "For a later xArm7 plan, preselect one in-support and one out-of-support reset matched on independent feasibility and action demand. Use the same distance definition and endpoint tolerances.",
        ]);
        let seeds = &register["commitments"][0];
        assert_eq!(seeds["recorded_by"], json!("harness"));
        assert_eq!(seeds["restated_by"], json!(["followup-lab-director-2082", "followup-lab-director-2083", "followup-lab-director-2084"]));
        // A fourth and fifth director saying it again add nothing.
        for lane in ["d2085", "d2086"] {
            restate(&mut register, lane, family, &["Preserve visual pilot seeds [100,101] and the unused visual confirmation seeds [0-7]."]);
        }
        assert_eq!(standing(&register).len(), 2);
        // And it holds when they stop saying it, until one of them ends it by id.
        for lane in ["d2087", "d2088", "d2089"] {
            restate(&mut register, lane, family, &["Run the confirmation once the recipe is frozen."]);
        }
        assert_eq!(standing(&register).len(), 3, "the new repeated term joins; the seeds remain");
        let id = seeds_id(&register);
        apply_commitment_updates(&mut register, "d2090", "2026-11-23T00:00:00Z", &[json!({"op": "withdraw", "id": id, "reason": "the visual panel was retired with its seeds"})]);
        assert!(!standing(&register).iter().any(|claim| claim.contains("pilot seeds")));
    }

    #[test]
    fn a_reworded_term_is_the_same_term_and_a_different_one_is_not() {
        let earlier = "Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].";
        assert!(same_term(earlier, "Preserve the reserved visual pilot seeds [100,101], unused visual confirmation seeds [0-7], and the historical panel's retirement."));
        assert!(!same_term(earlier, "Use the existing compact-state development seeds only for corrective qualification."));
        assert!(said_by(earlier, "Archive both failed qualifications as development evidence. Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7]."));
    }

    fn seeds_id(register: &Value) -> String {
        register["commitments"].as_array().unwrap().iter().find(|item| item["claim"].as_str().unwrap().contains("pilot seeds")).unwrap()["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_restated_term_is_not_recorded_across_leads_or_over_a_commitment_that_says_it() {
        let term = "Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].";
        // A change of lead between the statements: the run starts again.
        let mut register = register();
        restate(&mut register, "d1", "latent_schedule", &[term]);
        restate(&mut register, "d2", "latent_schedule", &[term]);
        restate(&mut register, "d3", "support_distance_curves", &[term]);
        assert!(standing(&register).is_empty());
        restate(&mut register, "d4", "support_distance_curves", &[term]);
        // A director with no lead neither restates nor interrupts.
        restate(&mut register, "d5", "", &[]);
        restate(&mut register, "d6", "support_distance_curves", &[term]);
        assert_eq!(standing(&register).len(), 1);

        // A director that wrote the commitment itself is not doubled by the harness.
        let mut register = self::register();
        apply_commitment_updates(&mut register, "d1", "2026-11-22T00:00:00Z", &[json!({"op": "add", "claim": "Visual pilot seeds [100,101] and unused visual confirmation seeds [0-7] are preserved. The compact-state seeds are separate."})]);
        for lane in ["d2", "d3", "d4"] {
            restate(&mut register, lane, "support_distance_curves", &[term]);
        }
        assert_eq!(register["commitments"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_term_recorded_for_one_lead_waits_while_another_lead_stands() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        fs::create_dir_all(state_root(&paths)).unwrap();
        let payload = |family: &str, terms: &[&str]| json!({"selected_hypothesis": {"statement": "a lead", "primary_family": family}, "validation_changes": terms, "commitment_updates": null});
        let term = "Preserve visual pilot seeds [100,101] and unused visual confirmation seeds [0-7].";
        for (index, lane) in ["d1", "d2", "d3"].iter().enumerate() {
            record_director_commitments(&paths, "c", lane, &format!("2026-11-22T0{index}:00:00Z"), &payload("Support distance curves", &[term])).unwrap();
        }
        let shown = commitments_director_context(&paths, "c");
        assert_eq!(shown["in_force_total"], json!(1));
        assert_eq!(shown["in_force"][0]["recorded_by"], json!("harness"));
        record_director_commitments(&paths, "c", "d4", "2026-11-22T04:00:00Z", &payload("latent_schedule", &["Fit the latent schedule on the released split."])).unwrap();
        let shown = commitments_director_context(&paths, "c");
        assert_eq!((shown["in_force_total"].clone(), shown["in_force_for_other_leads"].clone()), (json!(0), json!(1)));
        record_director_commitments(&paths, "c", "d5", "2026-11-22T05:00:00Z", &payload("support-distance curves", &["Resume the panel."])).unwrap();
        assert_eq!(commitments_director_context(&paths, "c")["in_force_total"], json!(1));
    }
}
