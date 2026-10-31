#![allow(unused_imports)]
use super::*;

/// Who can clear a dependency blocker, and what happens when nobody can.
///
/// Every prompt in this programme tells the LabDirector that "process stages are
/// advisory safety rails; a LabDirector override requires a recorded
/// `stage_gate_override` rationale". The override is real and carefully written
/// -- `stage_gates::lab_director_stage_gate_override_active` demands approval, a
/// named target, a non-empty rationale, and refuses outright when a forbidden
/// dataset term appears anywhere in the decision.
///
/// MEASURED: it had ONE call site, `hypothesis_generation`. The dependency gates
/// -- twenty distinct `waiting-for-*` holds, the ones that actually froze
/// cycle-g-v90 and cycle-g-v91 -- had zero override paths, zero timeouts and
/// zero grace periods between them. The harness promised the director a door and
/// then blocked it at the doors it had not built one for.
///
/// Worse, that state does not read as stalled. `chronicle/aggregate.rs` raises
/// `inactive_but_scientifically_open` only when `pending == 0`; cycle-g-v91 sat
/// at `running: 0, pending: 15`, so the cycle reported `running` while nothing
/// could move and nothing could decide to move differently. The dispatcher set
/// `waiting_on_running_lane = true` for every `waiting-for-*` reason, including
/// in rounds where no lane was running at all.
///
/// This module gives every blocker three things it did not have:
///
///   1. a named party who could clear it, and what would clear it;
///   2. a recorded LabDirector override that releases it, on the same terms the
///      stage gate already accepts -- approved, named, reasoned, and never over
///      a forbidden dataset;
///   3. an expiry: a blocker nobody can clear escalates to a decision instead of
///      holding forever.
///
/// What it deliberately does NOT do is release anything by itself. A timeout
/// that dispatches a lane past its evidence is the blind retry the watchdog
/// exists to prevent. The expiry produces a *decision request*; the director
/// still decides, and the release is only ever the director's, recorded.
#[derive(Debug, Clone)]
pub(crate) struct DependencyBlocker {
    /// The display string the gates have always returned, unchanged.
    pub(crate) reason: String,
    /// The role whose completion would clear this, when one party owns it.
    pub(crate) awaited_role: Option<String>,
    /// What would have to become true, in words a director can act on.
    pub(crate) clears_when: String,
}

impl DependencyBlocker {
    pub(crate) fn describe(reason: String) -> Self {
        let (awaited_role, clears_when) = blocker_descriptor(&reason);
        Self {
            reason,
            awaited_role: awaited_role.map(ToString::to_string),
            clears_when: clears_when.to_string(),
        }
    }

    /// A lane that is not waiting for anything, because it is finished.
    ///
    /// `blocked-by-completed-gatekeeper-review` and its siblings are not holds;
    /// they are lanes the cycle has decided will never run, and they sit in the
    /// pending list forever by design. Counting them as a stall would report a
    /// cycle that is quietly finishing as a cycle that has died -- the live
    /// cycle-g-v91 record had exactly two of them among fifteen, and a cycle
    /// whose only remaining "blocked" lanes were of this kind would have raised
    /// a decision request with nothing to decide.
    pub(crate) fn is_permanently_closed(&self) -> bool {
        self.awaited_role.is_none() && self.clears_when.starts_with("nothing")
    }

    pub(crate) fn as_value(&self) -> Value {
        json!({
            "reason": self.reason,
            "awaited_role": self.awaited_role,
            "clears_when": self.clears_when,
        })
    }
}

/// Every blocker this tree can emit, and who owns it.
///
/// A blocker string used to carry only a count -- `scout_literature_completed=0`
/// says the number is zero and not one word about who is supposed to make it
/// one. On cycle-g-v91 the answer was nobody: scout-02 could not finish, so
/// twelve lanes waited on a number that could not change, and the reason they
/// were given contained no hint of that.
///
/// These are this system's own vocabulary, not any field's, and adding a gate
/// without adding it here is caught by
/// `tests::blocker_release::every_blocker_names_who_can_clear_it`.
const BLOCKER_OWNERS: &[(&str, Option<&str>, &str)] = &[
    (
        "waiting-for-literature-scout-before-kg",
        Some("scout"),
        "a literature scout lane completes, so the knowledge graph has a corpus to build from",
    ),
    (
        "waiting-for-literature-scout",
        Some("scout"),
        "a literature scout lane completes",
    ),
    (
        "waiting-for-data-scout-before-kg",
        Some("scout"),
        "a data scout lane completes, so the knowledge graph has candidate sources",
    ),
    (
        "waiting-for-chronicle-graphs",
        Some("chronicle"),
        "chronicle emits the literature graph, the data graph and the trend summary",
    ),
    (
        "waiting-for-chronicle",
        Some("chronicle"),
        "a chronicle lane completes",
    ),
    (
        "waiting-for-field-landscape",
        Some("scout"),
        "the open field-landscape scout finishes and its landscape is published, valid or not",
    ),
    (
        "waiting-for-expert-selection",
        Some("lab-director"),
        "the open expert-selection stage lane (SOTA deep read, field beliefs, slate, panel, novelty or feasibility) finishes and the next stage is dispatched, or the stage exhausts its attempts",
    ),
    (
        "waiting-for-owner-selection",
        // A person, not a lane: the owner writes <cycle>-owner-selection.json.
        Some("owner"),
        "the owner picks one of the expert-selected candidates, or the configured owner-selection timeout passes",
    ),
    (
        "waiting-for-lab-director-hypothesis",
        Some("lab-director"),
        "the LabDirector writes the cycle hypothesis artifact",
    ),
    (
        "waiting-for-hypothesis-strategy",
        Some("lab-director"),
        "the LabDirector answers the conclusion review's request for a hypothesis strategy, or the owner authorises the document stage",
    ),
    (
        "waiting-for-new-lead-evidence",
        Some("lab-runner"),
        "a runner produces evidence after the last gate round, or the lead changes, so the review has something the last round did not read",
    ),
    (
        "waiting-for-hypothesis-gate",
        Some("gatekeeper"),
        "a gate round passes, or the owner authorises the document stage",
    ),
    (
        "waiting-for-validation-materialization-gate",
        Some("scout"),
        "the chosen lead's validation data is fetched, or the lead is changed to one that generates its data at run time",
    ),
    (
        "waiting-for-core-experiments",
        Some("lab-runner"),
        "a lab-runner lane completes an execution",
    ),
    (
        "waiting-for-core-analysis",
        Some("analyst"),
        "an analyst lane completes",
    ),
    (
        "waiting-for-upstream-evidence",
        Some("analyst"),
        "both a literature scout and an analyst lane complete",
    ),
    (
        "waiting-for-rival-analyst-handoffs",
        Some("analyst"),
        "a second analyst lane completes, so the runner has rival handoffs to weigh",
    ),
    (
        "waiting-for-analyst-handoff-reroute",
        Some("analyst"),
        "an analyst supplies the handoff this runner was rerouted to wait for",
    ),
    (
        "waiting-for-latest-analyst-handoff-runner",
        // The RUNNER, not the analyst. This blocker fires when no completed
        // lab-runner is gate-ready AND no runner context matches the latest
        // executable handoff; the handoff already exists, so the analyst has
        // nothing left to do and cannot clear it.
        //
        // MEASURED ON cycle-g-v91, 2026-09-14: ten gatekeepers held here for
        // four hours while the owner read `analyst`. Once the dispatch order
        // began promoting the awaited role, that mis-assignment promoted
        // analysts -- who answered by emitting NEWER handoffs, moving the
        // `latest` the blocker names and resetting the wait each time.
        Some("lab-runner"),
        "a lab-runner executes that exact handoff, or any completed runner is gate-ready",
    ),
    (
        "waiting-for-analyst-post-run-review",
        Some("analyst"),
        "an analyst reviews what the completed run produced",
    ),
    (
        "waiting-for-analyst-handoff",
        Some("analyst"),
        "an analyst lane completes and emits a handoff",
    ),
    (
        "waiting-for-data-acquisition",
        Some("analyst"),
        "an analyst emits a handoff carrying an executable blueprint",
    ),
    (
        "waiting-for-simulation-data",
        Some("engineer"),
        "an engineer lane runs the LabDirector's simulation order and writes its episodes.csv and manifest.json",
    ),
    (
        "waiting-for-runner-execution-report",
        Some("lab-runner"),
        "the runner records what its execution produced",
    ),
    (
        "waiting-for-labdirector-runner-recovery",
        Some("lab-director"),
        "the LabDirector decides what happens to the failed runner",
    ),
    (
        "blocked-by-completed-labdirector-requery",
        None,
        "nothing -- this lane duplicates a requery that already completed, and is meant to stay closed",
    ),
    (
        "blocked-by-completed-gatekeeper-review",
        None,
        "nothing -- this review already completed with no pending rubrics, and is meant to stay closed",
    ),
    (
        "planning-only-scope",
        None,
        "nothing -- execution is disabled for this cycle by scope, which is an owner setting",
    ),
];

/// Longest prefix wins, so `waiting-for-chronicle-graphs` is never read as
/// `waiting-for-chronicle`. Sorting by length rather than relying on table order
/// is deliberate: a table whose correctness depends on the order entries happen
/// to be written in mislabels quietly the first time somebody appends to it.
pub(crate) fn blocker_descriptor(reason: &str) -> (Option<&'static str>, &'static str) {
    let mut best: Option<&(&str, Option<&str>, &str)> = None;
    for entry in BLOCKER_OWNERS {
        if !reason.starts_with(entry.0) {
            continue;
        }
        if best.map(|current| entry.0.len() > current.0.len()).unwrap_or(true) {
            best = Some(entry);
        }
    }
    match best {
        Some(entry) => (entry.1, entry.2),
        None => (
            None,
            "unrecorded -- this gate was added without naming who can clear it",
        ),
    }
}

/// A recorded LabDirector release of one dependency blocker.
///
/// Accepted on exactly the terms `stage_gate_override` is already accepted on,
/// because the director was already told those terms: an explicit approval, the
/// blocker it applies to, and a rationale that is not empty. Forbidden dataset
/// terms void it here as they do there -- an override is a door, not a rewrite,
/// and the hard constraints stay hard.
///
/// The match is a prefix, so a director may release `waiting-for-literature-scout`
/// without having to reproduce the live count in the string. It is not a
/// wildcard: an empty or `*` target releases nothing, because a blanket release
/// is indistinguishable from turning the gates off, and the point of this is to
/// let the director move a specific cycle past a specific dead end.
pub(crate) fn dependency_gate_override_for(
    paths: &AppPaths,
    cycle_id: &str,
    reason: &str,
) -> Option<Value> {
    let objective = cycle_objective(paths, cycle_id);
    let forbidden_terms = super::effective_forbidden_dataset_terms(paths, cycle_id, &objective);

    let candidates = [
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json")),
        state_root(paths).join(format!("{cycle_id}-lab-director-research-notes.json")),
    ];
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let Ok(document) = read_json(&path) else {
            continue;
        };
        if value_contains_forbidden_dataset_term(&document, &forbidden_terms) {
            continue;
        }
        let blocks = [
            document.get("dependency_gate_override").cloned(),
            document
                .get("latest_lab_director_decision")
                .and_then(|decision| decision.get("dependency_gate_override"))
                .cloned(),
        ];
        for block in blocks.into_iter().flatten() {
            for entry in override_entries(&block) {
                if override_entry_releases(&entry, reason, &forbidden_terms) {
                    return Some(entry);
                }
            }
        }
    }
    None
}

/// One override, or a list of them -- a director releasing two dead ends in one
/// decision should not have to write two decisions.
fn override_entries(block: &Value) -> Vec<Value> {
    match block {
        Value::Array(items) => items.clone(),
        Value::Object(_) => vec![block.clone()],
        _ => Vec::new(),
    }
}

fn override_entry_releases(entry: &Value, reason: &str, forbidden_terms: &[String]) -> bool {
    if value_contains_forbidden_dataset_term(entry, forbidden_terms) {
        return false;
    }
    let approved = entry
        .get("approved")
        .or_else(|| entry.get("decision_override"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !approved {
        return false;
    }
    let rationale_present = entry
        .get("rationale")
        .or_else(|| entry.get("reason_for_override"))
        .and_then(Value::as_str)
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false);
    if !rationale_present {
        return false;
    }
    let target = entry
        .get("blocker")
        .or_else(|| entry.get("dependency_blocker"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    // A blanket release is not an override; it is the gates turned off.
    if target.is_empty() || target == "*" || target == "all" {
        return false;
    }
    reason.starts_with(target)
}

/// Append the release to the cycle's own record.
///
/// A decision that moved the cycle and left no trace is the unreconstructable
/// decision this programme's own paper argues against, and an override is
/// exactly the decision somebody will want to reconstruct later: the cycle went
/// past a gate, and the only question that matters afterwards is who said it
/// could and why.
pub(crate) fn record_dependency_gate_release(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    blocker: &DependencyBlocker,
    override_entry: &Value,
) {
    let path = state_root(paths).join(format!("{cycle_id}-dependency-gate-overrides.json"));
    let mut releases = read_json(&path)
        .ok()
        .and_then(|value| value.get("releases").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let already_recorded = releases.iter().any(|item| {
        item.get("lane_id").and_then(Value::as_str) == Some(lane_id)
            && item.get("blocker").and_then(Value::as_str) == Some(blocker.reason.as_str())
    });
    if already_recorded {
        return;
    }
    releases.push(json!({
        "recorded_at": now_iso(),
        "lane_id": lane_id,
        "blocker": blocker.reason,
        "awaited_role": blocker.awaited_role,
        "clears_when": blocker.clears_when,
        "rationale": override_entry
            .get("rationale")
            .or_else(|| override_entry.get("reason_for_override"))
            .cloned()
            .unwrap_or(Value::Null),
        "released_by": "lab-director",
    }));
    let _ = write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "updated_at": now_iso(),
            "releases": releases,
        }),
    );
}

/// The stall that reports itself as `running`.
///
/// Written by the dispatch loop when a round launches nothing, has nothing
/// running, and skipped at least one lane on a dependency blocker. That is the
/// cycle-g-v90 and cycle-g-v91 shape exactly, and no existing signal names it:
/// the watchdog's flatline rules look at activity, and the chronicle aggregate
/// requires `pending == 0` before it will call a cycle open-but-inactive.
pub(crate) fn dependency_stall_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-dependency-stall.json"))
}

pub(crate) fn record_dependency_stall(
    paths: &AppPaths,
    cycle_id: &str,
    blocked: &[(String, DependencyBlocker)],
) {
    let path = dependency_stall_path(paths, cycle_id);
    // A lane held on a blocker nothing can clear is not waiting; it is closed.
    let blocked = blocked
        .iter()
        .filter(|(_, blocker)| !blocker.is_permanently_closed())
        .cloned()
        .collect::<Vec<_>>();
    let blocked = blocked.as_slice();
    if blocked.is_empty() {
        clear_dependency_stall(paths, cycle_id);
        return;
    }
    // A stall keeps its first_seen across rounds, because the age is the whole
    // signal -- a blocker seen once is a cycle working, and the same blocker
    // unchanged for an hour with nothing running is a cycle that has stopped.
    let previous = read_json(&path).ok();
    let previous_signature = previous
        .as_ref()
        .and_then(|value| value.get("signature").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let signature = stall_signature(blocked);
    let first_seen = if previous_signature == signature {
        previous
            .as_ref()
            .and_then(|value| value.get("first_seen").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };
    let first_seen = if first_seen.is_empty() {
        now_iso()
    } else {
        first_seen
    };
    let _ = write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "first_seen": first_seen,
            "last_seen": now_iso(),
            "signature": signature,
            "blocked_lanes": blocked
                .iter()
                .map(|(lane_id, blocker)| {
                    let mut item = blocker.as_value();
                    item["lane_id"] = json!(lane_id);
                    item
                })
                .collect::<Vec<_>>(),
        }),
    );
}

pub(crate) fn clear_dependency_stall(paths: &AppPaths, cycle_id: &str) {
    let path = dependency_stall_path(paths, cycle_id);
    if path.exists() {
        let _ = fs::remove_file(path);
    }
}

/// The same reasons holding the same kinds of lane is the same stall. A cycle
/// whose blockers change is making progress of a kind, even when no lane has
/// launched yet, so it should not accumulate age.
///
/// MEASURED ON cycle-a-20260919, 2026-10-31: the signature named every
/// held lane, and each supervisor pass added one more analyst waiting for the
/// same missing hypothesis. The signature changed every 38 minutes, `first_seen`
/// restarted every time, and a stall that had lasted 13 hours never reached the
/// hour that escalates it. A lane joining a blocker that already holds others is
/// the stall growing, not the cycle moving, so lanes are not part of the identity.
fn stall_signature(blocked: &[(String, DependencyBlocker)]) -> String {
    let mut parts = blocked
        .iter()
        .map(|(_, blocker)| format!("{}|{}", blocker.awaited_role.as_deref().unwrap_or(""), blocker.reason))
        .collect::<Vec<_>>();
    parts.sort();
    parts.dedup();
    parts.join("\n")
}

/// How long a cycle may sit with nothing running and every lane held before the
/// harness asks the director to decide.
///
/// Runtime-configurable, and defaulted rather than fixed: the right number
/// depends on how long this programme's lanes take, which is a property of the
/// cycle and not of the code. The default is deliberately long -- an hour is
/// shorter than every stall measured here (v90 sat for hours, v91 for six) and
/// long enough that a slow round is never mistaken for a dead one.
pub(crate) fn dependency_stall_escalation_seconds() -> i64 {
    std::env::var("RESEARCHLAB_DEPENDENCY_STALL_ESCALATION_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(3600)
}

/// The stall, if it has lasted long enough to be one.
pub(crate) fn expired_dependency_stall(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    let stall = read_json(&dependency_stall_path(paths, cycle_id)).ok()?;
    let first_seen = stall.get("first_seen").and_then(Value::as_str)?;
    let first_seen = DateTime::parse_from_rfc3339(first_seen).ok()?.with_timezone(&Utc);
    let age = Utc::now().signed_duration_since(first_seen).num_seconds();
    if age < dependency_stall_escalation_seconds() {
        return None;
    }
    let mut stall = stall;
    stall["stalled_seconds"] = json!(age);
    Some(stall)
}
