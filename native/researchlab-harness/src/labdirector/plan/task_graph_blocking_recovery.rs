#![allow(unused_imports)]
use super::*;

/// Open the director lane that a blocking lane failure has been asking for.
///
/// `chronicle/aggregate.rs` already writes the request. When a blocking lane
/// fails it sets `recovery_needed`, `lab_director_attention_required`, and an
/// entry in `lab_director_alerts` naming its owner:
///
///     { "lane": { "lane_id": "scout-02", "status": "failed" },
///       "owner": "lab-director",
///       "reason": "blocking lane failed; keep cycle alive and request recovery planning",
///       "requires_recovery": true, "severity": "error" }
///
/// **Nothing read it.** The only other reference to `lab_director_alerts` in the
/// tree is `reporting/visualizer/shared.js`, which re-writes the field for the
/// researcher view. So the message named its recipient, said what it wanted, and
/// no lane was ever opened for it.
///
/// Measured twice. cycle-g-v90 sat at `failed_blocking: 1, pending: 10,
/// running: 0` with a live supervisor for hours; cycle-g-v91 reached
/// `failed_blocking: 3, pending: 12, running: 0` and its supervisor returned
/// `resume-cycle-complete` every pass while the blocking failures accumulated.
/// In both, a human had to notice.
///
/// This is the same shape as the mailbox's `acknowledged_at`, which had a reader
/// and no writer: a field that records an intention nothing acts on.
///
/// What this does NOT do is decide the recovery. The director owns pivot and
/// continue in this programme, and the alert's own wording is "request recovery
/// planning" -- so the action carries the failed lanes and their recorded
/// failure categories and asks the director to plan. A harness that chose the
/// recovery itself would be the blind retry the watchdog exists to prevent.
pub(crate) fn collect_blocking_failure_recovery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    if !state_path.exists() {
        return Ok(());
    }
    let state = read_json(&state_path)?;
    if state.get("recovery_needed").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let alerts = state
        .get("lab_director_alerts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut lanes: Vec<String> = Vec::new();
    let mut blockers: Vec<String> = Vec::new();
    for alert in &alerts {
        if alert.get("requires_recovery").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let lane = alert.get("lane").cloned().unwrap_or(Value::Null);
        let lane_id = lane
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if lane_id.is_empty() || lanes.iter().any(|item| item == lane_id) {
            continue;
        }
        let role = lane.get("role").and_then(Value::as_str).unwrap_or("unknown");
        // The recorded category, not a guess: the lane already wrote why it
        // stopped, and the director should plan against that rather than a
        // restatement of "it failed".
        let category = lane_failure_category(paths, cycle_id, lane_id)
            .unwrap_or_else(|| "unrecorded".to_string());
        let history = role_history_across_cycles(paths, role, cycle_id)
            .map(|line| format!(" Prior record: {line}."))
            .unwrap_or_default();
        // What the lane itself concluded, when it concluded anything: a
        // recovery planned against "it failed" re-runs the same lane.
        let reasoned = lane_reasoned_blocker(paths, cycle_id, lane_id)
            .map(|line| format!(" It reported: {line}."))
            .unwrap_or_default();
        blockers.push(format!(
            "{lane_id} ({role}) stopped on {category}; it is a blocking lane, so nothing downstream can run until you say what replaces or repairs it.{reasoned}{history}"
        ));
        lanes.push(lane_id.to_string());
    }
    if lanes.is_empty() {
        return Ok(());
    }
    // Only the failures no director has planned for yet are the question.
    let answered = lanes_already_planned_for(paths, cycle_id);
    let mut pending_lanes = Vec::new();
    let mut pending_blockers = Vec::new();
    for (lane_id, blocker) in lanes.iter().zip(blockers.iter()) {
        if !answered.contains(lane_id) {
            pending_lanes.push(lane_id.clone());
            pending_blockers.push(blocker.clone());
        }
    }
    if pending_lanes.is_empty() {
        return Ok(());
    }
    let earlier = lanes.len() - pending_lanes.len();
    let (lanes, blockers) = (pending_lanes, pending_blockers);
    let earlier_note = if earlier > 0 {
        format!(" ({earlier} earlier blocking failure(s) were already answered by recovery plans and are not asked again.)")
    } else {
        String::new()
    };

    priority_actions.push(json!({
        "type": "blocking_lane_recovery_planning",
        "preferred_role": "lab-director",
        "priority": "critical",
        "description": format!(
            "{} blocking lane(s) failed and the cycle cannot dispatch past them: {}. Decide what happens to each -- repair it, replace it with a different approach, or declare the cycle able to proceed without it -- and record the reason. Do not simply re-run a lane that failed for a recorded reason.{earlier_note}",
            lanes.len(),
            lanes.join(", ")
        ),
        "blocker_reasons": blockers,
        "failed_lane_ids": lanes,
        "source": "lab_director_alerts",
    }));
    Ok(())
}

/// Every one of `lanes` has been given to a completed recovery plan.
fn recovery_already_planned_for(paths: &AppPaths, cycle_id: &str, lanes: &[String]) -> bool {
    let answered = lanes_already_planned_for(paths, cycle_id);
    !lanes.is_empty() && lanes.iter().all(|lane_id| answered.contains(lane_id))
}

/// Whether the director has already answered this exact recovery request.
///
/// The request is raised from `recovery_needed`, which stays true for as long
/// as the blocking lanes stay failed -- and they stay failed, because repairing
/// them is what the director is being asked to plan. So the request re-raised
/// on every pass.
///
/// MEASURED ON cycle-g-v91, 2026-09-12: fourteen `blocking_lane_recovery_planning`
/// lanes for the same three failed lanes, each a full model call, each returning
/// the same plan -- "dispatch exactly one replacement scout to review and
/// finalize scout-02's existing 21-candidate queue". They did worse than waste
/// the budget: a critical action every round crowded the dispatch batch, so the
/// scout those plans asked for kept losing its place to yet another request for
/// the plan that had already been given.
///
/// A director who has answered is not asked again for the same thing.
///
/// MEASURED ON cycle-a-20260919, 2026-10-06: the rule used to be "the
/// same SET of lanes", so every new blocking failure reopened the question for
/// every failure before it. Sixty-odd recovery-planning director lanes ran over
/// the cycle, each re-planning the whole accumulated list -- 217, then 218, then
/// 220 ... then 296 lanes, analyst-04 from the first day among them -- because
/// one more analyst had failed. Now a lane a completed recovery plan was given
/// is answered, and only the failures nobody has planned for are asked about.
fn lanes_already_planned_for(paths: &AppPaths, cycle_id: &str) -> std::collections::BTreeSet<String> {
    let mut answered = std::collections::BTreeSet::new();
    let Ok(entries) = read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return answered;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        if !lane_dir.join("final-status.json").exists() {
            continue;
        }
        let Ok(role_plan) = read_json(&lane_dir.join("role-plan.json")) else {
            continue;
        };
        if role_plan.get("action_type").and_then(Value::as_str)
            != Some("blocking_lane_recovery_planning")
        {
            continue;
        }
        // Keyed on `blocker_reasons`, not on `failed_lane_ids`, because only the
        // first is delivered. Each dispatch site copies a fixed set of action
        // fields into planner_metadata and `failed_lane_ids` is not among them,
        // so the action carries it and the plan never sees it -- the same
        // delivery gap this whole file was written about, one level in. Rather
        // than adding the field at fifteen sites and leaving the sixteenth to be
        // found later, this reads what the director was actually given. Each
        // reason opens with the lane it is about ("scout-02 (scout) stopped on
        // ..."); only that first token counts, so a lane named inside another
        // lane's report is not mistaken for an answered one.
        for reason in role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("blocker_reasons"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(lane_id) = reason.split_whitespace().next().filter(|token| !token.is_empty()) {
                answered.insert(lane_id.to_string());
            }
        }
    }
    answered
}

pub(crate) fn simulation_blocker_recovery_description(request_id: &str) -> String {
    format!(
        "The simulation order `{request_id}` cannot materialize on its present execution path. The scheduler has no worker or execution-venue selector for simulation orders, so routing the unchanged order to a different worker is not an actionable recovery. Decide from the engineers' recorded capability evidence: choose a scientifically valid replacement whose declared backend and interpreter are available on the present execution path, or explicitly conclude that the programme is environment-blocked and name the capability a person must provide. Do not reissue the same request/backend with prose or schema changes: it will return to the same incapable venue."
    )
}

/// Give a completed simulation blocker to the role that owns the experiment.
///
/// Engineers return capability blockers as successful, structured reports: the
/// lane completed its diagnostic contract even though the ordered experiment
/// could not execute. Consequently the failed-lane recovery path above cannot
/// see these reports. Once such a report settles the order, only LabDirector may
/// change the method or declare the environment block; silently retrying the
/// same host cannot materialize data.
pub(crate) fn collect_simulation_blocker_recovery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let issued_ms = simulation_order_issued_ms(paths, cycle_id).unwrap_or(0).max(0) as u128;
    for order in latest_lab_director_simulation_orders(paths, cycle_id)? {
        let brief_id = simulation_order_brief_id(&order);
        let request_id = simulation_order_request_id(&order);
        let mut lanes = Vec::new();
        let mut blockers = Vec::new();
        let entries = match fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            let lane_dir = entry.path();
            let lane_id = entry.file_name().to_string_lossy().into_owned();
            let Ok(Some(fields)) = crate::labdirector::followup_counts::read_role_plan_index_fields(
                &lane_dir.join("role-plan.json"),
            ) else {
                continue;
            };
            if fields.action_type.as_deref() != Some(SIMULATION_DATA_GENERATION_ACTION)
                || fields.source_brief_id.as_deref() != Some(brief_id.as_str())
                || (issued_ms > 0
                    && file_modified_ms(&lane_dir.join("role-plan.json"))
                        .is_some_and(|ms| ms < issued_ms))
            {
                continue;
            }
            let terminal = read_json(&lane_dir.join("final-status.json"))
                .ok()
                .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string))
                .is_some_and(|status| !matches!(status.as_str(), "pending" | "running"));
            if !terminal {
                continue;
            }
            let Some(reason) = lane_reasoned_blocker(paths, cycle_id, &lane_id) else {
                continue;
            };
            blockers.push(format!(
                "{lane_id} completed the `{request_id}` diagnostic but could not execute the order: {reason}"
            ));
            lanes.push(lane_id);
        }
        lanes.sort();
        blockers.sort();
        if lanes.is_empty() || recovery_already_planned_for(paths, cycle_id, &lanes) {
            continue;
        }
        // MEASURED ON cycle-a-20260919, 2026-09-30: six simulation
        // lanes and four audits finished at reproduction_anchor while every
        // simulation lane reported no exposed NVIDIA device, Isaac Sim 6.0
        // instead of 6.1, and no compatible Python 3.9/Gym 0.21 anchor. None of
        // those completed blockers entered failed-lane recovery, so the exact
        // same order remained the scheduler's only path to materialization.
        //
        // MEASURED ON cycle-a-20260919, 2026-10-01: three recovery
        // planners chose "route the unchanged order to a different worker".
        // Simulation orders carry no worker/venue selector, so each rephrased
        // order went back to the same GPU-less executor and reproduction_anchor
        // held for 903 minutes. Do not offer a recovery the scheduler cannot
        // represent: the director must choose a locally executable replacement
        // or report the genuine environment block for a person to resolve.
        priority_actions.push(json!({
            "type": "blocking_lane_recovery_planning",
            "preferred_role": "lab-director",
            "priority": "critical",
            "priority_score": 10_000,
            "description": simulation_blocker_recovery_description(&request_id),
            "blocker_reasons": blockers,
            "blocked_lane_ids": lanes,
            "source": "completed_simulation_capability_blocker",
        }));
    }
    Ok(())
}

/// The stall that no failure caused.
///
/// `collect_blocking_failure_recovery_actions` above covers the case where a
/// lane FAILED: the aggregate raises an alert, this opens the decision lane. It
/// cannot cover the other shape, because the aggregate never sees it. A cycle
/// whose lanes are all *pending* on dependency blockers has no failure, no
/// `recovery_needed`, and `pending > 0` -- so `inactive_but_scientifically_open`
/// stays false and the cycle reports `running` while nothing runs.
///
/// cycle-g-v91 reached that state and stayed in it: `running: 0, pending: 15`,
/// twelve of the fifteen held on `waiting-for-literature-scout
/// scout_literature_completed=0`, a count only scout-02 could raise and scout-02
/// could not complete. Every lane was waiting correctly for something that was
/// never going to happen, and the harness had no way to notice that "waiting"
/// and "stopped" had become the same thing.
///
/// The escalation is a REQUEST, never a release. The director is handed each
/// blocker, who could have cleared it, what would have cleared it, and how long
/// it has held -- and decides. A harness that released its own gates on a timer
/// would dispatch lanes past the evidence they exist to consume, which is the
/// blind retry the watchdog was built to stop.
pub(crate) fn collect_dependency_stall_recovery_actions(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) -> Result<()> {
    let Some(stall) = expired_dependency_stall(paths, cycle_id) else {
        return Ok(());
    };
    let blocked = stall
        .get("blocked_lanes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if blocked.is_empty() {
        return Ok(());
    }
    let stalled_seconds = stall
        .get("stalled_seconds")
        .and_then(Value::as_i64)
        .unwrap_or_default();

    let mut lanes: Vec<String> = Vec::new();
    let mut blockers: Vec<String> = Vec::new();
    for item in &blocked {
        let lane_id = item.get("lane_id").and_then(Value::as_str).unwrap_or("");
        if lane_id.is_empty() {
            continue;
        }
        let reason = item.get("reason").and_then(Value::as_str).unwrap_or("");
        let clears_when = item
            .get("clears_when")
            .and_then(Value::as_str)
            .unwrap_or("unrecorded");
        // The prior record answers the question the director actually faces:
        // is this role failing this cycle, or has it been failing all along?
        let history = item
            .get("awaited_role")
            .and_then(Value::as_str)
            .and_then(|role| role_history_across_cycles(paths, role, cycle_id))
            .map(|line| format!(" Prior record: {line}."))
            .unwrap_or_default();
        let owner = item
            .get("awaited_role")
            .and_then(Value::as_str)
            .map(|role| format!("{role} owns it"))
            .unwrap_or_else(|| "no role owns it".to_string());
        blockers.push(format!(
            "{lane_id} is held on {reason} -- {owner}, and it clears when {clears_when}. Nothing has run for {stalled_seconds}s, so that has not happened and on the present course will not.{history}"
        ));
        lanes.push(lane_id.to_string());
    }
    if lanes.is_empty() {
        return Ok(());
    }

    priority_actions.push(json!({
        "type": "blocking_lane_recovery_planning",
        "preferred_role": "lab-director",
        "priority": "critical",
        "description": format!(
            "No lane has run for {}s and all {} pending lane(s) are held on dependency blockers: {}. Decide, for each: change the lead or the plan so the blocker can actually clear, dispatch whatever would clear it, or release the gate by recording a `dependency_gate_override` with the exact blocker string and your rationale. An override is a door, not a rewrite -- forbidden dataset reuse cannot be released this way, and a blanket or wildcard target releases nothing.",
            stalled_seconds,
            lanes.len(),
            lanes.join(", ")
        ),
        "blocker_reasons": blockers,
        "blocked_lane_ids": lanes,
        "stalled_seconds": stalled_seconds,
        "source": "dependency_stall",
    }));
    Ok(())
}

/// How this role has ended in earlier cycles of this programme.
///
/// `state/researchlab.sqlite` held 7,015 task rows across 18 cycles and NOTHING
/// in the tree ever read it -- no `SELECT` from tasks, graph_nodes, graph_edges,
/// artifacts or events anywhere. It was rebuilt on every supervisor pass and
/// queried by nobody.
///
/// This is the first read, and it is put where a decision actually turns on it.
/// A director asked to repair, replace, or proceed without a failed lane is
/// being asked whether this failure is a blip or a pattern, and that question
/// has an answer on disk: the same role in earlier cycles. "scout failed in four
/// of the last five cycles" and "scout has never failed before" call for
/// different decisions, and until now the director could not tell them apart.
///
/// Read-only and failure-tolerant: a missing or unreadable store yields no
/// history, never an error. A recovery request with no history is still a
/// recovery request.
fn role_history_across_cycles(paths: &AppPaths, role: &str, current_cycle: &str) -> Option<String> {
    let db_path = state_root(paths).join("researchlab.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let mut statement = conn
        .prepare(
            "SELECT cycle_id, \
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), \
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) \
             FROM tasks \
             WHERE role = ?1 AND cycle_id <> ?2 \
             GROUP BY cycle_id \
             ORDER BY cycle_id DESC \
             LIMIT 6",
        )
        .ok()?;
    let rows = statement
        .query_map(rusqlite::params![role, current_cycle], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    let cycles_with_failures = rows.iter().filter(|(_, _, failed)| *failed > 0).count();
    let detail = rows
        .iter()
        .map(|(cycle, completed, failed)| format!("{cycle} {completed}ok/{failed}failed"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "{role} in the {} earlier cycle(s) on record: failures in {cycles_with_failures} of them [{detail}]",
        rows.len()
    ))
}

/// What the lane itself recorded as its reason for stopping.
/// What a lane that THOUGHT about its blocker wants the director to know.
///
/// An engineer returns a structured report: which requirement it could not
/// satisfy, the other routes it tried on its own initiative, and -- when the
/// design itself is what blocks it -- the change it would make and what that
/// would cost the claim. Nothing read any of it.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-02
/// reported that the ordered interpreter is denied on this host and that no
/// policy arm named by the design exists to evaluate. The director's recovery
/// request said only "stopped on unrecorded", so the one lane that had actually
/// diagnosed the experiment was the one lane whose diagnosis was dropped.
pub(crate) fn lane_reasoned_blocker(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Option<String> {
    let result = read_json(&cycle_lanes_root(paths, cycle_id).join(lane_id).join("result.json")).ok()?;
    let report = result
        .get("extracted_json")
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| {
            result
                .get("output_last_message")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
        })?;
    let mut parts: Vec<String> = Vec::new();
    for blocker in report
        .get("capability_blockers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .take(3)
    {
        let requirement = blocker
            .get("requirement")
            .and_then(Value::as_str)
            .unwrap_or("a requirement");
        let why = blocker
            .get("why_unsatisfiable")
            .and_then(Value::as_str)
            .unwrap_or("no reason recorded");
        let tried = blocker
            .get("alternatives_tried")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
            + blocker
                .get("attempts")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
        parts.push(format!("it could not get {requirement}: {why} (after {tried} attempt(s))"));
    }
    if let Some(proposal) = report
        .get("proposed_design_change")
        .filter(|value| value.is_object())
    {
        if let Some(change) = proposal
            .get("what_i_would_change")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            let cost = proposal
                .get("what_it_costs_the_claim")
                .and_then(Value::as_str)
                .unwrap_or("cost to the claim not stated");
            parts.push(format!(
                "it proposes changing the design: {change} -- which costs: {cost}. That is yours to accept or refuse"
            ));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

fn lane_failure_category(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Option<String> {
    let run_state = cycle_lanes_root(paths, cycle_id)
        .join(lane_id)
        .join("run-state.json");
    let value = read_json(&run_state).ok()?;
    value
        .get("failure_category")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}
