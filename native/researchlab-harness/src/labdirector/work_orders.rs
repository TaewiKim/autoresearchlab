#![allow(unused_imports)]
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use super::problem_selection::clip_text;

// --- the director's plan, kept ----------------------------------------------------
//
// MEASURED ON cycle-a-20260919, 2026-11-10. Director 1913 was the one
// productive decision of the week: with the reference sources finally on disk it
// ordered two things, a bounded novelty audit of the successor candidate and the
// preparation of the reproduction anchor. Nineteen minutes later director 1914 was
// opened for an unrelated reason (a dormant lead put to it), answered that, and
// listed no next actions. The dispatcher read `next_actions` from the NEWEST
// completed director only, so 1913's orders stopped existing. Eight more directors
// followed, each opened by a different administrative trigger, each ending
// `restart` with nothing to do, and the cycle went idle with the plan that would
// have moved it sitting in an older result file.
//
// The same hour showed the other half. The analyst that prepared the anchor
// declared, correctly, three capabilities as the engineer's to provision
// (gym_pusht, pymunk and diffusers are not installed; the checkpoint's loader
// revision is absent). Engineer lanes exist, carry a provisioning contract, and by
// owner decision (2026-09-19) reach the package indexes. Nothing routes a declared
// requirement to one: a follow-up engineer is opened only for a simulation order or
// a runner audit, and the director's own action list did not offer the role. So
// every lane restated "the environment is missing" and no lane was ever asked to
// install it.
//
// A work order is an instruction that stands until it is carried out. This ledger
// records every dispatchable next action a director issues, and every unmet
// capability an analyst hands to the engineer, when it is issued; the dispatcher
// works from the ledger, so a later director that says nothing about an order
// leaves it in force. An order ends when a lane completes it, when a later
// director issues the same kind of order to the same role (the newer wording
// wins), when a director cancels it by id, when the lead it was issued under
// changes, or when it has stood too long. While orders are being carried out the
// plan's routine director requeries hold off, and when they finish one director is
// asked with the results in view.

const LEDGER_VERSION: u64 = 1;
const MAX_ORDERS_KEPT: usize = 240;
pub(crate) const CAPABILITY_PROVISIONING_ACTION: &str = "capability_provisioning_followup";
pub(crate) const CANCEL_WORK_ORDER_ACTION: &str = "cancel_work_order";

fn env_hours(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(default)
}

/// How far back the first reading of a cycle looks for orders already issued.
fn bootstrap_hours() -> i64 {
    env_hours("RESEARCHLAB_WORK_ORDER_BOOTSTRAP_HOURS", 24)
}

/// An order nobody completed in this long has stopped describing the cycle.
fn max_age_hours() -> i64 {
    env_hours("RESEARCHLAB_WORK_ORDER_MAX_AGE_HOURS", 14 * 24)
}

/// Lanes that may end without completing an order before it is handed back.
fn max_attempts() -> usize {
    env_hours("RESEARCHLAB_WORK_ORDER_MAX_ATTEMPTS", 3).max(1) as usize
}

/// How long an order in progress holds off the plan's routine director requeries.
fn hold_hours() -> i64 {
    env_hours("RESEARCHLAB_WORK_ORDER_HOLD_HOURS", 6)
}

pub(crate) fn work_orders_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-work-orders.json"))
}

/// The (role, action type) pairs a director's next action may be dispatched as.
///
/// This was an inline `matches!` in the dispatcher. The engineer pair is the
/// addition: without it a director had no way to ask for an environment.
pub(crate) fn work_order_dispatchable(role: &str, action_type: &str) -> bool {
    matches!(
        (role, action_type),
        ("analyst", "methods_followup")
            | ("lab-runner", "methods_followup")
            | ("chronicle", "chronicle_evidence_request_followup")
            | ("scout", "data_acquisition_followup")
            | ("scout", "novelty_followup")
            // MEASURED ON cycle-a-20260919, 2026-09-30: completed
            // directors repeatedly requested independent procedure adjudication,
            // but the allowlist discarded both gatekeeper action shapes.
            | ("gatekeeper", "novelty_followup")
            | ("gatekeeper", "gate_restart_followup")
            | ("analyst", "impact_followup")
            | ("engineer", CAPABILITY_PROVISIONING_ACTION)
    )
}

fn parse_time(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// What the cycle is working on, as far as an order's validity is concerned.
fn lead_key(paths: &AppPaths, cycle_id: &str) -> String {
    let Ok(lead) = read_json(&state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"))) else {
        return "none".to_string();
    };
    if lead.get("status").and_then(Value::as_str) == Some("withdrawn") {
        return "withdrawn".to_string();
    }
    let statement = lead
        .pointer("/selected_hypothesis/statement")
        .or_else(|| lead.pointer("/lab_director_decision/selected_hypothesis/statement"))
        .or_else(|| lead.get("statement"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if statement.is_empty() {
        "none".to_string()
    } else {
        format!("lead-{}", &sha256_hex(statement.as_bytes())[..12])
    }
}

fn order_id(issued_by: &str, role: &str, action_type: &str, description: &str) -> String {
    let digest = sha256_hex(format!("{issued_by}\n{role}\n{action_type}\n{}", description.trim()).as_bytes());
    format!("wo-{}", &digest[..10])
}

fn empty_ledger() -> Value {
    json!({"version": LEDGER_VERSION, "watermark": Value::Null, "capability_watermark": Value::Null, "capability_source": Value::Null, "issuers": {}, "orders": []})
}

fn load_ledger(paths: &AppPaths, cycle_id: &str) -> Value {
    read_json(&work_orders_path(paths, cycle_id))
        .ok()
        .filter(|ledger| ledger.get("orders").is_some_and(Value::is_array))
        .unwrap_or_else(empty_ledger)
}

fn orders(ledger: &Value) -> &[Value] {
    ledger.get("orders").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn orders_mut(ledger: &mut Value) -> &mut Vec<Value> {
    if !ledger.get("orders").is_some_and(Value::is_array) {
        ledger["orders"] = json!([]);
    }
    ledger["orders"].as_array_mut().expect("orders is an array")
}

fn is_standing(order: &Value) -> bool {
    text(order, "status") == "standing"
}

fn is_open(order: &Value) -> bool {
    is_standing(order) && order.get("done_at").map_or(true, Value::is_null)
}

fn close(order: &mut Value, status: &str, reason: String) {
    order["status"] = json!(status);
    order["closed_reason"] = json!(reason);
    order["closed_at"] = json!(now_iso());
}

/// The director payload of a lane result, in either shape the runtime writes.
fn director_payload(result_path: &Path) -> Option<Value> {
    if fs::metadata(result_path).ok()?.len() > 5 * 1024 * 1024 {
        return None;
    }
    let result = read_json(result_path).ok()?;
    result
        .get("extracted_json")
        .filter(|value| value.is_object())
        .or_else(|| result.get("lab_director_requery").filter(|value| value.is_object()))
        .cloned()
}

/// What a dispatched action needs from the decision that issued it.
fn issuer_stub(payload: &Value) -> Value {
    json!({
        "requery_decision": payload.get("requery_decision").cloned().unwrap_or(Value::Null),
        "decision_status": payload.get("decision_status").cloned().unwrap_or(Value::Null),
        "rationale": clip_text(payload.get("rationale"), 2400),
        "selected_hypothesis": payload.get("selected_hypothesis").cloned().unwrap_or(Value::Null),
        "replacement_hypotheses": payload.get("replacement_hypotheses").cloned().unwrap_or_else(|| json!([])),
        "validation_changes": payload.get("validation_changes").cloned().unwrap_or_else(|| json!([])),
    })
}

/// Record one director decision: its cancellations, then its orders.
fn ingest_director(ledger: &mut Value, lane_id: &str, completed_at: &str, payload: &Value, lead: &str) -> bool {
    let actions: Vec<Value> = payload
        .get("next_actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .chain(rebuttal_experiment_actions(payload))
        .collect();
    let mut changed = false;
    for action in &actions {
        if text(action, "type") != CANCEL_WORK_ORDER_ACTION {
            continue;
        }
        let description = text(action, "description").to_string();
        for order in orders_mut(ledger).iter_mut() {
            if is_standing(order) && description.contains(text(order, "order_id")) && !text(order, "order_id").is_empty() {
                close(order, "cancelled", format!("cancelled by {lane_id}: {}", description.chars().take(300).collect::<String>()));
                changed = true;
            }
        }
    }
    let mut issued = 0usize;
    for action in &actions {
        let role = text(action, "preferred_role");
        let action_type = text(action, "type");
        let description = text(action, "description").trim();
        if description.is_empty() || !work_order_dispatchable(role, action_type) {
            continue;
        }
        let id = order_id(lane_id, role, action_type, description);
        if orders(ledger).iter().any(|order| text(order, "order_id") == id) {
            continue;
        }
        // The newer wording of the same kind of order replaces the older one.
        for order in orders_mut(ledger).iter_mut() {
            if is_open(order)
                && text(order, "role") == role
                && text(order, "type") == action_type
                && text(order, "issued_by") != lane_id
                && text(order, "source") == "lab-director"
            {
                close(order, "superseded", format!("{lane_id} issued a newer {role} {action_type} order ({id})"));
            }
        }
        let mut record = json!({
            "order_id": id,
            "source": "lab-director",
            "brief_id": format!("labdirector-next-action-{lane_id}"),
            "issued_by": lane_id,
            "issued_at": completed_at,
            "recorded_at": now_iso(),
            "role": role,
            "type": action_type,
            "description": description,
            "lead_key": lead,
            "status": "standing",
            "done_at": Value::Null,
            "done_lanes": [],
            "reported_at": Value::Null,
        });
        for key in ["answers_objection", "target_rubric"] {
            if let Some(value) = action.get(key) {
                record[key] = value.clone();
            }
        }
        orders_mut(ledger).push(record);
        issued += 1;
        changed = true;
    }
    if issued > 0 {
        ledger["issuers"][lane_id] = issuer_stub(payload);
    }
    changed
}

/// When a lane finished: what its final status says, else when that file was written.
///
/// MEASURED ON cycle-a-20260919, 2026-11-10: the large cycle's lane index
/// carries no `completed_at` for any of its 7,199 completed lanes, so the time has
/// to come from the lane. The file's mtime is the cheap first cut (one stat); the
/// recorded time decides, because a repair pass rewrites old files and an mtime
/// alone would make a month-old decision look new.
fn lane_completed_after(lane_dir: &Path, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let final_status = lane_dir.join("final-status.json");
    let written: DateTime<Utc> = fs::metadata(&final_status).and_then(|meta| meta.modified()).ok()?.into();
    if written <= after {
        return None;
    }
    let status = read_json(&final_status).ok()?;
    if status.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    let completed_at = parse_time(status.get("completed_at")).unwrap_or(written);
    (completed_at > after).then_some(completed_at)
}

/// The completed lanes of `role` that finished after `after`, oldest first.
fn completed_role_lanes_after(paths: &AppPaths, cycle_id: &str, role: &str, after: DateTime<Utc>) -> Result<Vec<(DateTime<Utc>, String, PathBuf)>> {
    let mut found = Vec::new();
    if let Some(lanes) = completed_followup_lane_dirs_for_role_from_state(paths, cycle_id, role)? {
        for lane in lanes {
            let completed_at = match lane.completed_at {
                Some(at) if at > after => Some(at),
                Some(_) => None,
                None => lane_completed_after(&lane.lane_dir, after),
            };
            if let Some(completed_at) = completed_at {
                found.push((completed_at, lane.lane_id, lane.lane_dir));
            }
        }
    } else if let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        // A small cycle keeps no lane index; its lanes are few enough to read.
        for entry in entries.flatten() {
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id.contains(role) {
                continue;
            }
            if let Some(completed_at) = lane_completed_after(&entry.path(), after) {
                found.push((completed_at, lane_id, entry.path()));
            }
        }
    }
    found.retain(|(_, _, lane_dir)| {
        read_role_plan_index_fields(&lane_dir.join("role-plan.json"))
            .ok()
            .flatten()
            .is_some_and(|plan| plan.role.as_deref() == Some(role))
    });
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(found)
}

struct EndedLane {
    lane_id: String,
    role: String,
    action_type: String,
    completed: bool,
}

/// The lanes opened for `order` that ended, completed or not, among the ended
/// lanes of its brief.
///
/// Every order of one director shares that director's brief, so the action type
/// tells them apart. The role does not have to match: the dispatcher hands a
/// lab-runner's `methods_followup` to an analyst first when the design is not yet
/// executable (1913's reproduction order was carried out by analyst 1544), and an
/// order re-issued until its named role completes it is the loop this ledger ends.
/// The role decides only between two orders of one type from one director.
fn lanes_of_order(order: &Value, lanes: &[EndedLane], sibling_roles: &BTreeSet<String>, completed: bool) -> Vec<String> {
    let role = text(order, "role");
    let wanted = text(order, "type");
    let same_type = |lane: &&EndedLane| {
        lane.completed == completed
            && (lane.action_type == wanted
                || (wanted == "methods_followup" && lane.action_type == "labdirector_comparator_validation_followup"))
    };
    let exact: Vec<String> = lanes.iter().filter(same_type).filter(|lane| lane.role == role).map(|lane| lane.lane_id.clone()).collect();
    if !exact.is_empty() {
        return exact;
    }
    lanes
        .iter()
        .filter(same_type)
        .filter(|lane| !sibling_roles.contains(&lane.role))
        .map(|lane| lane.lane_id.clone())
        .collect()
}

/// Ended follow-up lanes by the brief they were opened for.
///
/// A lane opened for an order has a role plan written after the order was issued,
/// so one stat rules out every older lane: on a cycle with 8,600 ended lanes this
/// reads a handful of role plans, not all of them.
fn ended_lanes_by_brief(paths: &AppPaths, cycle_id: &str, briefs: &BTreeSet<String>, since: DateTime<Utc>) -> Result<BTreeMap<String, Vec<EndedLane>>> {
    let mut found: BTreeMap<String, Vec<EndedLane>> = BTreeMap::new();
    if briefs.is_empty() {
        return Ok(found);
    }
    let mut note = |lane_id: &str, lane_dir: &Path, completed: bool| -> Result<()> {
        let role_plan_path = lane_dir.join("role-plan.json");
        let written: Option<DateTime<Utc>> = fs::metadata(&role_plan_path).and_then(|meta| meta.modified()).ok().map(Into::into);
        if !written.is_some_and(|written| written >= since) {
            return Ok(());
        }
        if let Some(fields) = read_role_plan_index_fields(&role_plan_path)? {
            if let Some(brief) = fields.source_brief_id.filter(|brief| briefs.contains(brief)) {
                found.entry(brief).or_default().push(EndedLane {
                    lane_id: lane_id.to_string(),
                    role: fields.role.unwrap_or_default(),
                    action_type: fields.action_type.unwrap_or_default(),
                    completed,
                });
            }
        }
        Ok(())
    };
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if !lane_id.starts_with("followup-") || !matches!(status, "completed" | "failed" | "aborted") {
                continue;
            }
            note(lane_id, &lane_root(paths, cycle_id, lane_id), status == "completed")?;
        }
        return Ok(found);
    }
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return Ok(found);
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let Ok(status) = read_json(&lane_dir.join("final-status.json")) else { continue };
        let status = status.get("status").and_then(Value::as_str).unwrap_or("");
        if !matches!(status, "completed" | "failed" | "aborted") {
            continue;
        }
        let lane_id = entry.file_name().to_string_lossy().to_string();
        note(&lane_id, &lane_dir, status == "completed")?;
    }
    Ok(found)
}

fn capability_unmet(requirement: &Value) -> bool {
    let owner = requirement.get("owner_role").and_then(Value::as_str).unwrap_or("engineer");
    if owner != "engineer" {
        return false;
    }
    let status = requirement.get("status").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
    !matches!(status.as_str(), "available" | "satisfied" | "provisioned" | "verified" | "ready" | "installed" | "present")
}

/// The newest analyst lane that finished after `after` and left a handoff.
fn newest_analyst_handoff(paths: &AppPaths, cycle_id: &str, after: DateTime<Utc>) -> Result<Option<(String, DateTime<Utc>, PathBuf)>> {
    Ok(completed_role_lanes_after(paths, cycle_id, "analyst", after)?
        .into_iter()
        .rev()
        .find_map(|(at, lane_id, lane_dir)| {
            let handoff = lane_dir.join("analyst-handoff.json");
            handoff.is_file().then_some((lane_id, at, handoff))
        }))
}

/// An engineer order for what the newest analyst handoff says does not run here.
fn ingest_capability_requirements(paths: &AppPaths, cycle_id: &str, ledger: &mut Value, lead: &str) -> Result<bool> {
    let after = parse_time(ledger.get("capability_watermark")).unwrap_or_else(|| Utc::now() - chrono::Duration::hours(bootstrap_hours()));
    let Some((lane_id, finished, handoff_path)) = newest_analyst_handoff(paths, cycle_id, after)? else {
        return Ok(false);
    };
    let completed_at = finished.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    ledger["capability_watermark"] = json!(completed_at);
    ledger["capability_source"] = json!(lane_id);
    if fs::metadata(&handoff_path).map(|meta| meta.len()).unwrap_or(u64::MAX) > 5 * 1024 * 1024 {
        return Ok(true);
    }
    let handoff = read_json(&handoff_path).unwrap_or(Value::Null);
    let unmet: Vec<String> = handoff
        .get("capability_requirements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|requirement| requirement.is_object() && capability_unmet(requirement))
        .map(|requirement| {
            let name = ["capability_id", "tool", "requirement", "capability"]
                .iter()
                .filter_map(|key| requirement.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(" / ");
            let status = requirement.get("status").and_then(Value::as_str).unwrap_or("not stated");
            format!("{name} [{status}]")
        })
        .collect();
    if unmet.is_empty() {
        return Ok(true);
    }
    let description = format!(
        "Provision what the analyst's design declared and does not run here yet. The handoff at {} lists these engineer-owned capability_requirements as not available: {}. Read each entry's version_or_interface, input_contract, required_outputs and evidence there. By owner decision an engineer lane -- and only an engineer lane -- may install open-source packages and fetch released code and models from the approved package indexes, code hosts and model hubs, so a requirement that an earlier lane could only report as missing is yours to install: create or reuse an isolated runtime under the cycle's tool cache, prove each capability with the smallest command that exercises it end to end, and record the interpreter path and versions so later lanes can run against it. Report exactly what could not be provisioned and why. You do not choose the science and you do not run the validation itself.",
        handoff_path.display(),
        unmet.join("; ")
    );
    let id = order_id(&lane_id, "engineer", CAPABILITY_PROVISIONING_ACTION, &description);
    for order in orders_mut(ledger).iter_mut() {
        if is_open(order) && text(order, "source") == "analyst-handoff" {
            close(order, "superseded", format!("{lane_id} declared the requirements anew ({id})"));
        }
    }
    orders_mut(ledger).push(json!({
        "order_id": id,
        "source": "analyst-handoff",
        "brief_id": format!("capability-requirements-{lane_id}"),
        "issued_by": lane_id,
        "issued_at": completed_at,
        "recorded_at": now_iso(),
        "role": "engineer",
        "type": CAPABILITY_PROVISIONING_ACTION,
        "description": description,
        "handoff_path": handoff_path.display().to_string(),
        "unmet": unmet,
        "lead_key": lead,
        "status": "standing",
        "done_at": Value::Null,
        "done_lanes": [],
        "reported_at": Value::Null,
    }));
    Ok(true)
}

/// Bring the ledger up to date and return it. Cheap when nothing happened.
pub(crate) fn refresh_work_orders(paths: &AppPaths, cycle_id: &str) -> Result<Value> {
    let mut ledger = load_ledger(paths, cycle_id);
    let mut changed = false;
    let now = Utc::now();
    let lead = lead_key(paths, cycle_id);

    // Orders issued under a lead that is no longer the lead answer a question the
    // cycle has stopped asking.
    for order in orders_mut(&mut ledger).iter_mut() {
        if is_open(order) && text(order, "lead_key") != lead {
            let was = text(order, "lead_key").to_string();
            close(order, "lead_changed", format!("issued under {was}; the cycle is now on {lead}"));
            changed = true;
        }
    }

    let watermark = parse_time(ledger.get("watermark")).unwrap_or_else(|| now - chrono::Duration::hours(bootstrap_hours()));
    let mut newest = watermark;
    for (completed_at, lane_id, lane_dir) in completed_role_lanes_after(paths, cycle_id, "lab-director", watermark)? {
        newest = newest.max(completed_at);
        let Some(payload) = director_payload(&lane_dir.join("result.json")) else { continue };
        let stamp = completed_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        changed |= ingest_director(&mut ledger, &lane_id, &stamp, &payload, &lead);
    }
    if parse_time(ledger.get("watermark")) != Some(newest) {
        ledger["watermark"] = json!(newest.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        changed = true;
    }

    changed |= ingest_capability_requirements(paths, cycle_id, &mut ledger, &lead)?;

    // What has been carried out, and what has stood too long.
    let open_briefs: BTreeSet<String> = orders(&ledger).iter().filter(|order| is_open(order)).map(|order| text(order, "brief_id").to_string()).collect();
    let oldest_open = orders(&ledger)
        .iter()
        .filter(|order| is_open(order))
        .filter_map(|order| parse_time(order.get("issued_at")))
        .min()
        .unwrap_or(now);
    let ended = ended_lanes_by_brief(paths, cycle_id, &open_briefs, oldest_open - chrono::Duration::minutes(5))?;
    let max_age = chrono::Duration::hours(max_age_hours());
    // The roles of the other open orders of the same director and type.
    let open_roles: Vec<(String, String, String)> = orders(&ledger)
        .iter()
        .filter(|order| is_open(order))
        .map(|order| (text(order, "brief_id").to_string(), text(order, "type").to_string(), text(order, "role").to_string()))
        .collect();
    for order in orders_mut(&mut ledger).iter_mut() {
        if !is_open(order) {
            continue;
        }
        let siblings: BTreeSet<String> = open_roles
            .iter()
            .filter(|(brief, action_type, role)| brief == text(order, "brief_id") && action_type == text(order, "type") && role != text(order, "role"))
            .map(|(_, _, role)| role.clone())
            .collect();
        let lanes = ended.get(text(order, "brief_id")).map(Vec::as_slice).unwrap_or(&[]);
        let carried_out = lanes_of_order(order, lanes, &siblings, true);
        let gave_up = lanes_of_order(order, lanes, &siblings, false);
        if !carried_out.is_empty() {
            order["done_at"] = json!(now_iso());
            order["done_lanes"] = json!(carried_out);
            order["outcome"] = json!("carried_out");
            changed = true;
        } else if gave_up.len() >= max_attempts() {
            // MEASURED ON cycle-a-20260919: one analyst action reached
            // attempt 239. An order that three lanes could not complete goes back
            // to the director with what happened, instead of to a fourth lane.
            order["done_at"] = json!(now_iso());
            order["done_lanes"] = json!(gave_up);
            order["outcome"] = json!("not_carried_out");
            changed = true;
        } else if parse_time(order.get("issued_at")).is_some_and(|issued| now - issued > max_age) {
            close(order, "expired", format!("not carried out within {} hours", max_age_hours()));
            changed = true;
        }
    }

    let kept = orders(&ledger).len();
    if kept > MAX_ORDERS_KEPT {
        let drop = kept - MAX_ORDERS_KEPT;
        let mut dropped = 0usize;
        orders_mut(&mut ledger).retain(|order| {
            if dropped < drop && !is_standing(order) {
                dropped += 1;
                false
            } else {
                true
            }
        });
        changed = true;
    }
    if changed {
        let live: BTreeSet<String> = orders(&ledger).iter().map(|order| text(order, "issued_by").to_string()).collect();
        if let Some(issuers) = ledger.get_mut("issuers").and_then(Value::as_object_mut) {
            issuers.retain(|lane_id, _| live.contains(lane_id));
        }
        ledger["updated_at"] = json!(now_iso());
        write_json(&work_orders_path(paths, cycle_id), &ledger)?;
    }
    Ok(ledger)
}

/// What the dispatcher reads instead of the newest director's `next_actions`:
/// one payload per director that still has orders standing, newest first.
///
/// `newest` is what the old reader returned. A payload the ledger has recorded is
/// rebuilt from the ledger, so an order another role already carried out is marked
/// and not issued twice; a payload the ledger does not know passes through as is.
pub(crate) fn standing_work_order_payloads(paths: &AppPaths, cycle_id: &str, newest: Vec<(String, Value)>) -> Vec<(String, Value)> {
    let Ok(ledger) = refresh_work_orders(paths, cycle_id) else {
        return newest;
    };
    let newest_lane = newest.first().map(|(lane_id, _)| lane_id.clone());
    let mut by_issuer: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut issued_at: BTreeMap<String, String> = BTreeMap::new();
    for order in orders(&ledger) {
        if !is_standing(order) || text(order, "source") != "lab-director" {
            continue;
        }
        let issuer = text(order, "issued_by").to_string();
        let mut action = json!({
            "type": order.get("type"),
            "preferred_role": order.get("role"),
            "description": order.get("description"),
            "work_order_id": order.get("order_id"),
            "work_order_done": !is_open(order),
            "work_order_from_earlier_director": newest_lane.as_deref() != Some(issuer.as_str()),
        });
        for key in ["answers_objection", "target_rubric"] {
            if let Some(value) = order.get(key) {
                action[key] = value.clone();
            }
        }
        issued_at.insert(issuer.clone(), text(order, "issued_at").to_string());
        by_issuer.entry(issuer).or_default().push(action);
    }
    let mut payloads = Vec::new();
    for (lane_id, payload) in newest {
        match by_issuer.remove(&lane_id) {
            Some(actions) => {
                let mut rebuilt = payload;
                rebuilt["next_actions"] = Value::Array(actions);
                // The ledger already holds them as orders.
                rebuilt["rebuttal_experiments"] = json!([]);
                payloads.push((lane_id, rebuilt));
            }
            None if orders(&ledger).iter().any(|order| text(order, "issued_by") == lane_id) => {
                // Known to the ledger and nothing of it stands: nothing to dispatch.
                let mut rebuilt = payload;
                rebuilt["next_actions"] = json!([]);
                rebuilt["rebuttal_experiments"] = json!([]);
                payloads.push((lane_id, rebuilt));
            }
            None => payloads.push((lane_id, payload)),
        }
    }
    let mut earlier: Vec<(String, Vec<Value>)> = by_issuer.into_iter().collect();
    earlier.sort_by(|a, b| issued_at.get(&b.0).cmp(&issued_at.get(&a.0)));
    for (lane_id, actions) in earlier {
        if actions.iter().all(|action| action.get("work_order_done").and_then(Value::as_bool) == Some(true)) {
            continue;
        }
        let mut payload = ledger.pointer(&format!("/issuers/{}", lane_id.replace('~', "~0").replace('/', "~1"))).cloned().unwrap_or_else(|| json!({}));
        payload["next_actions"] = Value::Array(actions);
        payloads.push((lane_id, payload));
    }
    payloads
}

/// The engineer orders an analyst handoff's unmet requirements stand as.
pub(crate) fn append_capability_provisioning_actions(paths: &AppPaths, cycle_id: &str, ranked_actions: &mut Vec<Value>) {
    let ledger = load_ledger(paths, cycle_id);
    for order in orders(&ledger) {
        if !is_open(order) || text(order, "source") != "analyst-handoff" {
            continue;
        }
        let brief_id = text(order, "brief_id");
        if ranked_actions.iter().any(|action| action.get("brief_id").and_then(Value::as_str) == Some(brief_id)) {
            continue;
        }
        trace_order(&json!({"work_order_id": order.get("order_id")}), "queued");
        ranked_actions.push(json!({
            "brief_id": brief_id,
            "type": CAPABILITY_PROVISIONING_ACTION,
            "preferred_role": "engineer",
            "description": order.get("description"),
            "priority": "critical",
            "priority_score": 280,
            "work_order_id": order.get("order_id"),
            "analysis_request": {
                "source": "analyst-handoff-capability-requirements",
                "handoff_path": order.get("handoff_path"),
                "unmet_capability_requirements": order.get("unmet"),
            },
            "blocker_reasons": ["the analyst handoff declares capabilities the engineer owns as not available here"],
        }));
    }
}

// --- where an order got to in the dispatcher -----------------------------------------
//
// MEASURED ON cycle-a-20260919, 2026-11-10: the scout order stood open for
// an hour of passes and no lane was opened for it. The dispatcher has some forty
// places an action can be dropped and says nothing at any of them, so "why was this
// not dispatched" could only be answered by reading the function against the state
// by hand -- the question this cycle has had to ask most often. An order's last
// stage in each dispatch is written next to the ledger.

static ORDER_TRACE: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, String>>> = std::sync::OnceLock::new();

fn order_trace() -> &'static std::sync::Mutex<BTreeMap<String, String>> {
    ORDER_TRACE.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

/// Record how far a work order's action got. A no-op for any other action.
pub(crate) fn trace_order(action: &Value, stage: &str) {
    let Some(order_id) = action.get("work_order_id").and_then(Value::as_str) else {
        return;
    };
    if let Ok(mut trace) = order_trace().lock() {
        trace.insert(order_id.to_string(), stage.to_string());
    }
}

pub(crate) fn work_order_trace_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-work-order-dispatch-trace.json"))
}

/// Write the stages of this dispatch and start the next one clean.
pub(crate) fn flush_order_trace(paths: &AppPaths, cycle_id: &str, outcome: &str) {
    let stages = order_trace().lock().map(|mut trace| std::mem::take(&mut *trace)).unwrap_or_default();
    let _ = write_json(
        &work_order_trace_path(paths, cycle_id),
        &json!({"at": now_iso(), "dispatch": outcome, "last_stage_by_order": stages}),
    );
}

/// Whether work a director ordered is still being carried out.
///
/// The plan's routine requeries (a dormant lead put to the director, a gate
/// restart) hold off while it is: each of them opens a director that decides
/// without the result it is waiting for. Bounded by `hold_hours`, so an order
/// nothing can dispatch does not silence the director for good.
pub(crate) fn work_orders_in_flight(paths: &AppPaths, cycle_id: &str) -> bool {
    let hold = chrono::Duration::hours(hold_hours());
    if hold.is_zero() {
        return false;
    }
    let now = Utc::now();
    orders(&load_ledger(paths, cycle_id))
        .iter()
        // From when the ledger took the order on, not from when it was issued: an
        // order found on first reading has been dispatchable only since then.
        .any(|order| {
            is_open(order)
                && parse_time(order.get("recorded_at"))
                    .or_else(|| parse_time(order.get("issued_at")))
                    .is_some_and(|since| now - since < hold)
        })
}

/// MemTotal, MemAvailable and SwapFree of a /proc/meminfo text, in MiB.
fn meminfo_mib(meminfo: &str) -> Option<(u64, u64, u64)> {
    let field = |name: &str| {
        meminfo
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            .map(|kib| kib / 1024)
    };
    Some((field("MemTotal:")?, field("MemAvailable:")?, field("SwapFree:").unwrap_or(0)))
}

/// The machine's memory as the harness measures it, outside any lane.
///
/// MEASURED ON cycle-a-20260919, 2026-11-10. Engineer 1257 read 1.65 GB
/// available while the previous lane's cycle refresh (2.7 GB resident) was still
/// running, stopped on it, and director 1926 cancelled the order as "exhausted
/// under the measured memory ceiling". The reading was the harness's own
/// transient; at rest the same machine had 3.4 GB available. A director sizing or
/// cancelling work on memory needs the harness's reading and what it includes,
/// not only one lane's first minute.
fn host_memory_facts(paths: &AppPaths, cycle_id: &str) -> Value {
    let Some((total, available, swap_free)) = fs::read_to_string("/proc/meminfo").ok().as_deref().and_then(meminfo_mib) else {
        return Value::Null;
    };
    let refresh_running = paths.runtime_root.join("state").join(format!("{cycle_id}-refresh-cycle.lock")).exists();
    json!({
        "measured_at": now_iso(),
        "measured_by": "the harness, outside any lane sandbox",
        "mem_total_mib": total,
        "mem_available_mib": available,
        "swap_free_mib": swap_free,
        "cycle_refresh_running_at_measurement": refresh_running,
        "what_this_includes": "The harness's own processes are inside these numbers. Its cycle refresh takes several GB for about a minute after each lane ends and shows as low mem_available while it runs; a provisioning (engineer) lane is not started until that refresh has finished, so a lane's first reading is no longer taken under it. A memory reading recorded by a lane that started before 2026-11-10T09:20Z may have been taken under it. The machine's total is a limit the owner set.",
    })
}

/// Whether lanes can use the GPU, and how. See runtime::gpu_jobs.
fn gpu_route_fact() -> Value {
    match crate::runtime::gpu_jobs::gpu_jobs_unavailable_reason() {
        None => json!({
            "available": true,
            "how": "Engineer lanes run GPU work through the harness's GPU job runner (drivers/gpu/gpu_job.py): the harness executes the job outside the lane's sandbox with the GPU, a read-only filesystem except the lane's own directories, and no network. Order GPU work from an engineer (capability_provisioning_followup, or a simulation order).",
            "what_a_lane_report_of_no_gpu_means": "A lane's sandbox has no GPU device by construction, so `torch.cuda.is_available() == False` or \"GPU access blocked\" recorded INSIDE a lane says nothing about this machine. Reports of that kind made before 2026-11-10 are sandbox readings, not host facts.",
        }),
        Some(reason) => json!({"available": false, "why": reason}),
    }
}

fn gpu_route_announced_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-gpu-route-announced.json"))
}

/// Whether a director is owed the news that lanes can now use the GPU.
///
/// The same rule as the reference assets (labdirector::reference_assets): a
/// change in what the director can order is a reason to ask it once, when no
/// lead is at work, and never a reason to loop it. MEASURED ON
/// cycle-a-20260919: every candidate that needed a trained or evaluated
/// policy was weighed against lanes reporting no GPU, and the cycle stood without
/// a plan when the route was built; nothing else would have told it.
pub(crate) fn gpu_route_announcement_due(paths: &AppPaths, cycle_id: &str, available: bool) -> bool {
    if !available || gpu_route_announced_path(paths, cycle_id).exists() {
        return false;
    }
    // A cycle that has not started deciding has nobody to tell yet.
    let Ok(lead) = read_json(&state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"))) else {
        return false;
    };
    lead.get("status").and_then(Value::as_str) == Some("withdrawn")
}

pub(crate) fn announce_gpu_route(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !gpu_route_announcement_due(paths, cycle_id, crate::runtime::gpu_jobs::gpu_jobs_available()) {
        return Ok(Vec::new());
    }
    let message = "Lanes on this host can now run GPU work. Until now every lane's sandbox hid the GPU device, so each lane that looked recorded no GPU (\"torch.cuda.is_available() is False\", \"NVML reported GPU access blocked\"); those were readings of the sandbox, not of the machine, which has a GPU. An engineer lane now hands GPU jobs to the harness, which runs them outside the lane's sandbox with the GPU, a read-only filesystem except the lane's own directories, and no network (see work_orders.gpu_route and work_orders.host_memory in your context). Earlier decisions that struck, sized or cancelled work on the absence of a GPU were reached without this. Decide what, if anything, it changes: if work you set aside is now executable, order it (an engineer capability_provisioning_followup can provision, probe the GPU and measure cost first); if nothing changes, say precisely what is still missing.";
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let item = json!({
        "type": "supervisor_instruction",
        "payload": {"issue_code": "gpu_route_available", "severity": "process_attention", "message": message}
    });
    let lanes = spawn_supervisor_labdirector_followup(paths, cycle_id, &objective, &item)?;
    if !lanes.is_empty() {
        write_json(
            &gpu_route_announced_path(paths, cycle_id),
            &json!({"announced_at": now_iso(), "lanes": lanes.iter().filter_map(|lane| lane.get("lane_id").cloned()).collect::<Vec<_>>()}),
        )?;
    }
    Ok(lanes)
}

/// The orders as every director lane sees them.
pub(crate) fn work_orders_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let ledger = load_ledger(paths, cycle_id);
    let brief = |order: &Value| {
        json!({
            "order_id": order.get("order_id"),
            "issued_by": order.get("issued_by"),
            "issued_at": order.get("issued_at"),
            "role": order.get("role"),
            "type": order.get("type"),
            "description": clip_text(order.get("description"), 700),
            "state": if is_open(order) {
                "in progress or waiting to be dispatched"
            } else if text(order, "outcome") == "not_carried_out" {
                "could not be carried out: the lanes listed ended without completing it"
            } else {
                "carried out"
            },
            "carried_out_by": order.get("done_lanes"),
        })
    };
    let standing: Vec<Value> = orders(&ledger).iter().filter(|order| is_standing(order)).map(brief).collect();
    let closed: Vec<Value> = orders(&ledger)
        .iter()
        .rev()
        .filter(|order| !is_standing(order))
        .take(6)
        .map(|order| json!({"order_id": order.get("order_id"), "role": order.get("role"), "type": order.get("type"), "status": order.get("status"), "why": order.get("closed_reason")}))
        .collect();
    json!({
        "standing": standing,
        "recently_closed": closed,
        "host_memory": host_memory_facts(paths, cycle_id),
        "gpu_route": gpu_route_fact(),
        "rule": "A next action you issue is a standing work order: it stays in force until a lane carries it out, however many director lanes run in between. Do not re-issue an order listed under `standing` unless you want its wording replaced; a new order for the same role and type replaces the older one. To withdraw one, add a next action {\"type\": \"cancel_work_order\", \"preferred_role\": \"lab-director\", \"description\": \"<order_id>: why\"}. Returning an empty next_actions list cancels nothing.",
        "capability_route": "When a design needs software, an environment, a loader revision or a checkpoint that is not installed here, that is an order, not a blocker to restate: issue {\"type\": \"capability_provisioning_followup\", \"preferred_role\": \"engineer\", \"description\": \"what must run, at which versions, and the command that would prove it\"}. By owner decision engineer lanes -- and only engineer lanes -- may install open-source packages and fetch released code and models from the approved package indexes, code hosts and model hubs. Requirements an analyst handoff declares as engineer-owned and unavailable are ordered automatically.",
    })
}

/// When a lane's agent was launched. The invocation record is written at launch,
/// after the role plan's last refresh, so a director launched after the ledger
/// recorded an order done has that order, and who carried it out, in its context.
fn lane_launched_at(lane_dir: &Path) -> Option<DateTime<Utc>> {
    ["invocation.json", "prompt.txt"]
        .iter()
        .find_map(|name| fs::metadata(lane_dir.join(name)).and_then(|meta| meta.modified()).ok())
        .map(DateTime::<Utc>::from)
}

fn lane_terminal_status(lane_dir: &Path) -> Option<String> {
    read_json(&lane_dir.join("final-status.json"))
        .ok()?
        .get("status")?
        .as_str()
        .filter(|status| matches!(*status, "completed" | "failed" | "aborted"))
        .map(str::to_string)
}

fn lane_contract(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Option<LaneContract> {
    let value = read_json(&lane_root(paths, cycle_id, lane_id).join("lane-contract.json")).ok()?;
    serde_json::from_value(value).ok()
}

/// A lane that will never decide anything: it ended without completing, it is
/// gone, or the dependency gates hold it on a blocker nothing clears.
///
/// The last is the one that matters. Such a lane stays `pending` on disk for
/// good by design (`DependencyBlocker::is_permanently_closed`), so anything that
/// asks "is a lane already carrying this?" by status alone is answered yes for
/// ever by a lane the scheduler has already said it will never run.
fn lane_will_not_run(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> bool {
    match lane_terminal_status(&lane_root(paths, cycle_id, lane_id)).as_deref() {
        Some("completed") => return false,
        Some(_) => return true,
        None => {}
    }
    if lane_process_is_alive(paths, cycle_id, lane_id) {
        return false;
    }
    let Some(contract) = lane_contract(paths, cycle_id, lane_id) else {
        return true;
    };
    dependency_blocker_for_lane(paths, cycle_id, &contract)
        .ok()
        .flatten()
        .is_some_and(|reason| DependencyBlocker::describe(reason).is_permanently_closed())
}

/// A director lane that is running, or pending with nothing holding it. It will
/// be launched after the finished orders were recorded, so it decides with them
/// in view; a second lane opened beside it would be closed as its duplicate.
fn director_about_to_decide(paths: &AppPaths, cycle_id: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(Some(statuses)) = cached_large_cycle_lane_statuses(paths, cycle_id) {
        for lane in statuses {
            let unfinished = matches!(lane.get("status").and_then(Value::as_str), Some("pending" | "prepared" | "running"));
            if unfinished && lane.get("role").and_then(Value::as_str) == Some("lab-director") {
                candidates.extend(lane.get("lane_id").and_then(Value::as_str).map(str::to_string));
            }
        }
    } else if let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) {
        candidates.extend(entries.flatten().map(|entry| entry.file_name().to_string_lossy().to_string()).filter(|lane_id| lane_id.contains("lab-director")));
    }
    candidates.into_iter().find(|lane_id| {
        if lane_terminal_status(&lane_root(paths, cycle_id, lane_id)).is_some() {
            return false;
        }
        if lane_process_is_alive(paths, cycle_id, lane_id) {
            return true;
        }
        lane_contract(paths, cycle_id, lane_id).is_some_and(|contract| matches!(dependency_blocker_for_lane(paths, cycle_id, &contract), Ok(None)))
    })
}

fn lane_list(order: &Value, key: &str) -> Vec<String> {
    order.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// Carried out (or given up on) and not yet in front of a director.
fn awaiting_report(order: &Value) -> bool {
    is_standing(order) && !is_open(order) && order.get("reported_at").map_or(true, Value::is_null)
}

/// An order is reported when a director who could see its result has decided.
///
/// `decided` are completed director lanes with the time each was launched. One
/// launched after the order was recorded done had it in its context
/// (`work_orders_director_context` lists it as carried out, with the lanes); so
/// did the lane the result was announced to, whatever the clocks say.
fn confirm_reports(ledger: &mut Value, decided: &[(DateTime<Utc>, String)]) -> bool {
    let mut changed = false;
    for order in orders_mut(ledger).iter_mut() {
        if !awaiting_report(order) {
            continue;
        }
        let Some(done_at) = parse_time(order.get("done_at")) else {
            continue;
        };
        let announced = lane_list(order, "announced_to");
        let Some((_, lane_id)) = decided.iter().find(|(launched_at, lane_id)| *launched_at >= done_at || announced.contains(lane_id)) else {
            continue;
        };
        order["reported_at"] = json!(now_iso());
        order["reported_to"] = json!([lane_id]);
        order["report_confirmed"] = json!(true);
        // Reported work has been handed back; it no longer stands.
        order["status"] = json!("done");
        changed = true;
    }
    changed
}

/// Take back a report that was recorded as made to a lane that never ran.
///
/// MEASURED ON cycle-a-20260919, 2026-11-11/12. Until then an order was
/// marked reported the moment a director lane was *created* for it. Director 1939
/// was created for scout 744's result at 20:27:56Z, in the same pass as director
/// 1938; 1938 ran first and completed at 20:31:45Z, one second after 1939's role
/// plan was last refreshed, and the dependency gate closed 1939 for good as
/// `blocked-by-completed-labdirector-requery`. The ledger said "reported to 1939".
/// Worse, 1939 stayed `pending`, and the spawn's own duplicate check -- one open
/// lane per `supervisor-instruction-work_order_results_available` -- found it on
/// every later pass: scout 746 finished at 00:01Z on the 12th and no director was
/// opened for it for the next twelve hours (743 `skipped_existing` events).
fn reopen_undelivered_reports(ledger: &mut Value, completed: &dyn Fn(&str) -> bool, will_not_run: &dyn Fn(&str) -> bool) -> bool {
    let mut changed = false;
    for order in orders_mut(ledger).iter_mut() {
        if text(order, "status") != "done" || order.get("report_confirmed").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let lanes = lane_list(order, "reported_to");
        if lanes.is_empty() {
            continue;
        }
        if lanes.iter().any(|lane_id| completed(lane_id)) {
            order["report_confirmed"] = json!(true);
            changed = true;
        } else if lanes.iter().all(|lane_id| will_not_run(lane_id)) {
            order["status"] = json!("standing");
            order["announced_to"] = json!(lanes);
            order["reported_at"] = Value::Null;
            order["reported_to"] = Value::Null;
            changed = true;
        }
    }
    changed
}

/// Ask one director when ordered work has been carried out and not yet reported.
///
/// "Reported" is a fact about a director, not about this function: an order is
/// reported once a director launched after it was done has completed
/// (`confirm_reports`). Opening a lane only *announces* it. An announcement whose
/// lane will never run is made again, to a new lane, up to the attempt cap; one
/// whose lane is still to run is waited for.
///
/// Waits for the orders still in progress so the director decides once with the
/// whole result, unless the finished ones have waited `hold_hours` already.
pub(crate) fn announce_work_order_results(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    let mut ledger = refresh_work_orders(paths, cycle_id)?;
    let save = |ledger: &mut Value| -> Result<()> {
        ledger["updated_at"] = json!(now_iso());
        write_json(&work_orders_path(paths, cycle_id), ledger)
    };
    let completed = |lane_id: &str| lane_terminal_status(&lane_root(paths, cycle_id, lane_id)).as_deref() == Some("completed");
    let will_not_run = |lane_id: &str| lane_will_not_run(paths, cycle_id, lane_id);
    let mut changed = reopen_undelivered_reports(&mut ledger, &completed, &will_not_run);

    let earliest_done = orders(&ledger).iter().filter(|order| awaiting_report(order)).filter_map(|order| parse_time(order.get("done_at"))).min();
    if let Some(earliest_done) = earliest_done {
        let decided: Vec<(DateTime<Utc>, String)> = completed_role_lanes_after(paths, cycle_id, "lab-director", earliest_done)?
            .into_iter()
            .filter_map(|(_, lane_id, lane_dir)| lane_launched_at(&lane_dir).map(|launched_at| (launched_at, lane_id)))
            .collect();
        changed |= confirm_reports(&mut ledger, &decided);
    }
    let finished: Vec<Value> = orders(&ledger).iter().filter(|order| awaiting_report(order)).cloned().collect();
    // An announcement already with a lane that can still run is waited for.
    let announced_and_waiting = |order: &Value| lane_list(order, "announced_to").iter().any(|lane_id| !will_not_run(lane_id));
    let attempts = |order: &Value| order.get("announce_attempts").and_then(Value::as_u64).unwrap_or(0) as usize;
    let to_announce: Vec<Value> = finished.iter().filter(|order| !announced_and_waiting(order) && attempts(order) < max_attempts()).cloned().collect();
    let hold = chrono::Duration::hours(hold_hours());
    let now = Utc::now();
    let waited_out = to_announce.iter().any(|order| parse_time(order.get("done_at")).is_some_and(|done| now - done >= hold));
    if to_announce.is_empty()
        || finished.iter().any(|order| announced_and_waiting(order))
        || (work_orders_in_flight(paths, cycle_id) && !waited_out)
        || director_about_to_decide(paths, cycle_id).is_some()
    {
        if changed {
            save(&mut ledger)?;
        }
        return Ok(Vec::new());
    }
    let describe = |order: &Value| {
        let lanes: Vec<String> = lane_list(order, "done_lanes").iter().map(|lane_id| format!(".research-lab/lanes/{cycle_id}/{lane_id}/result.json")).collect();
        let outcome = if text(order, "outcome") == "not_carried_out" {
            "COULD NOT BE CARRIED OUT (these lanes ended without completing it; read why before re-issuing it)"
        } else {
            "carried out"
        };
        format!(
            "[{}] {} {} ordered by {}: \"{}\" -- {outcome}; read {}",
            text(order, "order_id"),
            text(order, "role"),
            text(order, "type"),
            text(order, "issued_by"),
            text(order, "description").chars().take(260).collect::<String>(),
            lanes.join(", ")
        )
    };
    let still_open: Vec<String> = orders(&ledger).iter().filter(|order| is_open(order)).map(|order| format!("[{}] {} {}", text(order, "order_id"), text(order, "role"), text(order, "type"))).collect();
    let message = format!(
        "Work that was ordered has ended and no director has decided with it in view. {}. {}Read the results before deciding: they are the evidence the earlier decisions said was missing. Say what they establish, what they do not, and issue the next orders; an order still standing stays in force without being repeated (see work_orders in your context).",
        to_announce.iter().map(describe).collect::<Vec<_>>().join(" | "),
        if still_open.is_empty() { String::new() } else { format!("Still in progress: {}. ", still_open.join(", ")) }
    );
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    // Each announcement is its own piece of news, so each has its own brief: the
    // ledger decides whether one is owed, not a lane left over from an earlier one.
    let instance = format!("{}-{}", text(&to_announce[0], "order_id"), attempts(&to_announce[0]) + 1);
    let item = json!({
        "type": "supervisor_instruction",
        "payload": {"issue_code": "work_order_results_available", "instance": instance, "severity": "process_attention", "message": message}
    });
    let lanes = spawn_supervisor_labdirector_followup(paths, cycle_id, &objective, &item)?;
    if lanes.is_empty() {
        if changed {
            save(&mut ledger)?;
        }
        return Ok(lanes);
    }
    let announced: BTreeSet<String> = to_announce.iter().map(|order| text(order, "order_id").to_string()).collect();
    let announced_to: Vec<Value> = lanes.iter().filter_map(|lane| lane.get("lane_id").cloned()).collect();
    for order in orders_mut(&mut ledger).iter_mut() {
        if announced.contains(text(order, "order_id")) {
            // Announced, not reported: it stands, carried out, until a director decides.
            let earlier = lane_list(order, "announced_to");
            order["announced_to"] = json!(earlier.into_iter().map(Value::String).chain(announced_to.iter().cloned()).collect::<Vec<_>>());
            order["announced_at"] = json!(now_iso());
            order["announce_attempts"] = json!(attempts(order) + 1);
        }
    }
    save(&mut ledger)?;
    Ok(lanes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AppPaths) {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        fs::create_dir_all(state_root(&paths)).unwrap();
        (temp, paths)
    }

    fn director(next_actions: Value) -> Value {
        json!({"requery_decision": "restart", "decision_status": "final", "rationale": "r", "next_actions": next_actions})
    }

    fn open_ids(ledger: &Value) -> Vec<String> {
        orders(ledger).iter().filter(|order| is_open(order)).map(|order| format!("{}:{}", text(order, "issued_by"), text(order, "role"))).collect()
    }

    // The measured failure: 1913 ordered a scout audit and a reproduction, and
    // 1914..1922 said nothing about either.
    #[test]
    fn an_order_stands_through_later_directors_that_do_not_mention_it() {
        let mut ledger = empty_ledger();
        let plan = director(json!([
            {"type": "novelty_followup", "preferred_role": "scout", "description": "audit the allocation procedure"},
            {"type": "methods_followup", "preferred_role": "lab-runner", "description": "prepare the release reproduction"},
            {"type": "gate_restart_followup", "preferred_role": "lab-director", "description": "not dispatchable from here"},
        ]));
        assert!(ingest_director(&mut ledger, "followup-lab-director-1913", "2026-11-10T00:56:56Z", &plan, "withdrawn"));
        assert!(!ingest_director(&mut ledger, "followup-lab-director-1914", "2026-11-10T01:15:03Z", &director(json!([])), "withdrawn"));
        assert_eq!(open_ids(&ledger), vec!["followup-lab-director-1913:scout", "followup-lab-director-1913:lab-runner"]);
        // Reading the same decision again adds nothing.
        assert!(!ingest_director(&mut ledger, "followup-lab-director-1913", "2026-11-10T00:56:56Z", &plan, "withdrawn"));
        assert_eq!(orders(&ledger).len(), 2);
    }

    #[test]
    fn a_newer_order_of_the_same_kind_replaces_the_older_and_a_cancel_withdraws_by_id() {
        let mut ledger = empty_ledger();
        ingest_director(&mut ledger, "d1", "2026-11-10T00:00:00Z", &director(json!([
            {"type": "novelty_followup", "preferred_role": "scout", "description": "audit, first wording"},
            {"type": "methods_followup", "preferred_role": "lab-runner", "description": "prepare the reproduction"},
        ])), "withdrawn");
        ingest_director(&mut ledger, "d2", "2026-11-10T01:00:00Z", &director(json!([
            {"type": "novelty_followup", "preferred_role": "scout", "description": "audit, sharper wording"},
        ])), "withdrawn");
        assert_eq!(open_ids(&ledger), vec!["d1:lab-runner", "d2:scout"]);
        let superseded = orders(&ledger).iter().find(|order| text(order, "status") == "superseded").unwrap();
        assert_eq!(text(superseded, "issued_by"), "d1");

        let runner_id = orders(&ledger).iter().find(|order| text(order, "role") == "lab-runner").map(|order| text(order, "order_id").to_string()).unwrap();
        ingest_director(&mut ledger, "d3", "2026-11-10T02:00:00Z", &director(json!([
            {"type": "cancel_work_order", "preferred_role": "lab-director", "description": format!("{runner_id}: the anchor is no longer the plan")},
        ])), "withdrawn");
        assert_eq!(open_ids(&ledger), vec!["d2:scout"]);
    }

    #[test]
    fn rebuttal_experiments_stand_as_orders_too() {
        let mut ledger = empty_ledger();
        let mut payload = director(json!([]));
        payload["rebuttal_experiments"] = json!([{"answers_objection": "no held-out seed", "target_rubric": "reproducibility", "experiment": "re-run on 5 held-out seeds", "preferred_role": "lab-runner"}]);
        assert!(ingest_director(&mut ledger, "d1", "2026-11-10T00:00:00Z", &payload, "lead-abc"));
        assert_eq!(open_ids(&ledger), vec!["d1:lab-runner"]);
        assert_eq!(orders(&ledger)[0]["answers_objection"], json!("no held-out seed"));
    }

    #[test]
    fn the_dispatcher_is_handed_every_director_with_orders_standing() {
        let (_temp, paths) = fixture();
        let cycle = "wo";
        let mut ledger = empty_ledger();
        // A watermark in the future: this test hands the ledger its decisions.
        ledger["watermark"] = json!("2999-01-01T00:00:00Z");
        let now = now_iso();
        ingest_director(&mut ledger, "d1", &now, &director(json!([
            {"type": "novelty_followup", "preferred_role": "scout", "description": "audit"},
            {"type": "methods_followup", "preferred_role": "lab-runner", "description": "reproduce"},
        ])), "none");
        // The runner order was carried out (by whichever role took it).
        orders_mut(&mut ledger)[1]["done_at"] = json!(now);
        write_json(&work_orders_path(&paths, cycle), &ledger).unwrap();

        let newest = vec![("d9".to_string(), director(json!([])))];
        let payloads = standing_work_order_payloads(&paths, cycle, newest);
        assert_eq!(payloads.len(), 2, "{payloads:?}");
        assert_eq!(payloads[0].0, "d9");
        assert_eq!(payloads[1].0, "d1");
        let actions = payloads[1].1["next_actions"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0]["work_order_done"], json!(false));
        assert_eq!(actions[0]["work_order_from_earlier_director"], json!(true));
        assert_eq!(actions[1]["work_order_done"], json!(true));
        assert_eq!(payloads[1].1["requery_decision"], json!("restart"));
        assert!(work_orders_in_flight(&paths, cycle));

        // Once everything of a director is carried out it is no longer handed over.
        orders_mut(&mut ledger)[0]["done_at"] = json!(now);
        write_json(&work_orders_path(&paths, cycle), &ledger).unwrap();
        let payloads = standing_work_order_payloads(&paths, cycle, vec![("d9".to_string(), director(json!([])))]);
        assert_eq!(payloads.len(), 1);
        assert!(!work_orders_in_flight(&paths, cycle));
    }

    #[test]
    fn orders_end_when_the_lead_they_were_issued_under_changes() {
        let (_temp, paths) = fixture();
        let cycle = "wo";
        let mut ledger = empty_ledger();
        ledger["watermark"] = json!("2999-01-01T00:00:00Z");
        ingest_director(&mut ledger, "d1", &now_iso(), &director(json!([
            {"type": "novelty_followup", "preferred_role": "scout", "description": "audit"},
        ])), "withdrawn");
        write_json(&work_orders_path(&paths, cycle), &ledger).unwrap();
        let lead_path = state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json"));
        write_json(&lead_path, &json!({"status": "withdrawn"})).unwrap();
        assert_eq!(open_ids(&refresh_work_orders(&paths, cycle).unwrap()).len(), 1);
        write_json(&lead_path, &json!({"status": "active", "selected_hypothesis": {"statement": "a new lead"}})).unwrap();
        let ledger = refresh_work_orders(&paths, cycle).unwrap();
        assert!(open_ids(&ledger).is_empty());
        assert_eq!(text(&orders(&ledger)[0], "status"), "lead_changed");
    }

    #[test]
    fn an_order_three_lanes_could_not_complete_goes_back_instead_of_to_a_fourth() {
        let order = json!({"role": "engineer", "type": "capability_provisioning_followup"});
        let lane = |lane_id: &str, role: &str, action_type: &str, completed: bool| EndedLane {
            lane_id: lane_id.to_string(),
            role: role.to_string(),
            action_type: action_type.to_string(),
            completed,
        };
        let lanes = vec![
            lane("e1", "engineer", "capability_provisioning_followup", false),
            lane("e2", "engineer", "capability_provisioning_followup", false),
            lane("s1", "scout", "novelty_followup", true),
        ];
        let none = BTreeSet::new();
        assert!(lanes_of_order(&order, &lanes, &none, true).is_empty(), "another order's lane is not this one's");
        assert_eq!(lanes_of_order(&order, &lanes, &none, false), vec!["e1", "e2"]);
        assert!(max_attempts() >= 1);
        // A lane of another role counts unless a sibling order of that role exists.
        let taken_by_analyst = vec![lane("a1", "analyst", "capability_provisioning_followup", true)];
        assert_eq!(lanes_of_order(&order, &taken_by_analyst, &none, true), vec!["a1"]);
        let siblings: BTreeSet<String> = ["analyst".to_string()].into_iter().collect();
        assert!(lanes_of_order(&order, &taken_by_analyst, &siblings, true).is_empty());
    }

    fn carried_out(order_id: &str, done_at: &str) -> Value {
        json!({"order_id": order_id, "role": "scout", "type": "novelty_followup", "status": "standing", "outcome": "carried_out", "done_at": done_at, "done_lanes": ["followup-scout-746"], "reported_at": null})
    }

    fn at(iso: &str) -> DateTime<Utc> {
        parse_time(Some(&json!(iso))).unwrap()
    }

    // OWNER REPORT 2026-11-12 (a progress check): nothing had run for twelve hours.
    #[test]
    fn an_order_is_reported_when_a_director_launched_after_it_was_done_has_decided() {
        let mut ledger = empty_ledger();
        orders_mut(&mut ledger).push(carried_out("wo-a", "2026-11-12T00:01:35Z"));
        // A director already running when the scout finished decided without it.
        assert!(!confirm_reports(&mut ledger, &[(at("2026-11-11T23:59:00Z"), "followup-lab-director-1".to_string())]));
        assert!(awaiting_report(&orders(&ledger)[0]));
        // One launched afterwards had it in its context, whoever asked for that lane.
        assert!(confirm_reports(&mut ledger, &[(at("2026-11-12T00:05:00Z"), "followup-lab-director-2".to_string())]));
        let order = &orders(&ledger)[0];
        assert_eq!(text(order, "status"), "done");
        assert_eq!(order["reported_to"], json!(["followup-lab-director-2"]));
        assert_eq!(order["report_confirmed"], json!(true));

        // The lane it was announced to counts whatever the clocks say.
        let mut announced = carried_out("wo-b", "2026-11-12T00:01:35Z");
        announced["announced_to"] = json!(["followup-lab-director-3"]);
        orders_mut(&mut ledger).push(announced);
        assert!(confirm_reports(&mut ledger, &[(at("2026-11-12T00:01:00Z"), "followup-lab-director-3".to_string())]));
        assert_eq!(orders(&ledger)[1]["reported_to"], json!(["followup-lab-director-3"]));
    }

    // Director 1939: recorded as told, closed by the gates as a duplicate, never run.
    #[test]
    fn a_report_recorded_to_a_lane_that_never_ran_is_owed_again() {
        let mut ledger = empty_ledger();
        let mut told = carried_out("wo-lost", "2026-11-11T20:27:45Z");
        told["status"] = json!("done");
        told["reported_at"] = json!("2026-11-11T20:27:56Z");
        told["reported_to"] = json!(["followup-lab-director-1939"]);
        let mut delivered = told.clone();
        delivered["order_id"] = json!("wo-delivered");
        delivered["reported_to"] = json!(["followup-lab-director-1936"]);
        let mut pending = told.clone();
        pending["order_id"] = json!("wo-pending");
        pending["reported_to"] = json!(["followup-lab-director-2000"]);
        orders_mut(&mut ledger).extend([told, delivered, pending]);

        let completed = |lane_id: &str| lane_id.ends_with("1936");
        let will_not_run = |lane_id: &str| lane_id.ends_with("1939");
        assert!(reopen_undelivered_reports(&mut ledger, &completed, &will_not_run));
        let by_id = |ledger: &Value, id: &str| orders(ledger).iter().find(|order| text(order, "order_id") == id).cloned().unwrap();
        let lost = by_id(&ledger, "wo-lost");
        assert!(awaiting_report(&lost), "{lost}");
        assert_eq!(lost["announced_to"], json!(["followup-lab-director-1939"]));
        assert_eq!(by_id(&ledger, "wo-delivered")["report_confirmed"], json!(true));
        // A lane still to run is neither confirmed nor taken back.
        let waiting = by_id(&ledger, "wo-pending");
        assert_eq!(text(&waiting, "status"), "done");
        assert!(waiting.get("report_confirmed").is_none());
        // Settled: a second reading changes nothing.
        assert!(!reopen_undelivered_reports(&mut ledger, &|_| false, &will_not_run));

        // Director 1938 was launched after the scout finished and did decide.
        assert!(confirm_reports(&mut ledger, &[(at("2026-11-11T20:28:15Z"), "followup-lab-director-1938".to_string())]));
        assert_eq!(by_id(&ledger, "wo-lost")["reported_to"], json!(["followup-lab-director-1938"]));
    }

    #[test]
    fn a_result_is_announced_to_a_new_lane_when_the_last_one_will_not_run() {
        let (_temp, paths) = fixture();
        let cycle = "report";
        let mut ledger = empty_ledger();
        ledger["watermark"] = json!("2999-01-01T00:00:00Z");
        ledger["capability_watermark"] = json!("2999-01-01T00:00:00Z");
        orders_mut(&mut ledger).push(carried_out("wo-2861c14092", &now_iso()));
        write_json(&work_orders_path(&paths, cycle), &ledger).unwrap();
        let awaiting = |paths: &AppPaths| load_ledger(paths, cycle)["orders"][0].clone();

        let first = announce_work_order_results(&paths, cycle).unwrap();
        assert_eq!(first.len(), 1, "{first:?}");
        let first_lane = first[0]["lane_id"].as_str().unwrap().to_string();
        let order = awaiting(&paths);
        assert!(awaiting_report(&order), "announced is not reported: {order}");
        assert_eq!(order["announced_to"], json!([first_lane]));
        // The lane is still to run: nothing more is opened beside it.
        assert!(announce_work_order_results(&paths, cycle).unwrap().is_empty());

        // It ends without deciding. The result is announced again, to a new lane,
        // although the first lane's brief is still on disk.
        write_json(&lane_root(&paths, cycle, &first_lane).join("final-status.json"), &json!({"lane_id": first_lane, "status": "aborted", "completed_at": now_iso()})).unwrap();
        let second = announce_work_order_results(&paths, cycle).unwrap();
        assert_eq!(second.len(), 1, "{second:?}");
        let second_lane = second[0]["lane_id"].as_str().unwrap().to_string();
        assert_ne!(first_lane, second_lane);
        assert_ne!(first[0]["source_brief_id"], second[0]["source_brief_id"]);
        assert_eq!(awaiting(&paths)["announce_attempts"], json!(2));

        // That one runs and completes: reported, and nothing further is opened.
        let second_dir = lane_root(&paths, cycle, &second_lane);
        fs::write(second_dir.join("invocation.json"), "{}").unwrap();
        write_json(&second_dir.join("final-status.json"), &json!({"lane_id": second_lane, "status": "completed", "completed_at": (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339()})).unwrap();
        assert!(announce_work_order_results(&paths, cycle).unwrap().is_empty());
        let order = awaiting(&paths);
        assert_eq!(text(&order, "status"), "done", "{order}");
        assert_eq!(order["reported_to"], json!([second_lane]));
    }

    #[test]
    fn the_gpu_route_is_announced_once_and_only_to_a_cycle_without_a_lead() {
        let (_temp, paths) = fixture();
        let cycle = "gpu";
        let lead = state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json"));
        assert!(!gpu_route_announcement_due(&paths, cycle, true), "no decision yet: nobody to tell");
        write_json(&lead, &json!({"status": "active", "selected_hypothesis": {"statement": "a lead at work"}})).unwrap();
        assert!(!gpu_route_announcement_due(&paths, cycle, true), "a lead at work is not interrupted");
        write_json(&lead, &json!({"status": "withdrawn"})).unwrap();
        assert!(gpu_route_announcement_due(&paths, cycle, true));
        assert!(!gpu_route_announcement_due(&paths, cycle, false), "no route, no news");
        write_json(&gpu_route_announced_path(&paths, cycle), &json!({"announced_at": now_iso()})).unwrap();
        assert!(!gpu_route_announcement_due(&paths, cycle, true), "once");
    }

    #[test]
    fn host_memory_is_read_in_mib() {
        let meminfo = "MemTotal:        6067616 kB
MemFree:          166000 kB
MemAvailable:    3452000 kB
SwapTotal:       8388608 kB
SwapFree:        5543000 kB
";
        assert_eq!(meminfo_mib(meminfo), Some((5925, 3371, 5413)));
        assert_eq!(meminfo_mib("MemTotal: 10 kB
"), None);
    }

    #[test]
    fn only_requirements_the_engineer_owns_and_that_do_not_run_are_unmet() {
        assert!(capability_unmet(&json!({"owner_role": "engineer", "status": "missing_dependencies"})));
        assert!(capability_unmet(&json!({"status": "unavailable_not_provisioned"})));
        assert!(!capability_unmet(&json!({"owner_role": "engineer", "status": "available"})));
        assert!(!capability_unmet(&json!({"owner_role": "analyst", "status": "missing"})));
    }

    #[test]
    fn the_director_context_names_the_orders_and_the_engineer_route() {
        let (_temp, paths) = fixture();
        let cycle = "wo";
        let mut ledger = empty_ledger();
        ingest_director(&mut ledger, "d1", &now_iso(), &director(json!([
            {"type": "capability_provisioning_followup", "preferred_role": "engineer", "description": "install gym_pusht and prove an episode steps"},
        ])), "none");
        write_json(&work_orders_path(&paths, cycle), &ledger).unwrap();
        let context = work_orders_director_context(&paths, cycle);
        assert_eq!(context["standing"].as_array().unwrap().len(), 1);
        assert_eq!(context["standing"][0]["role"], json!("engineer"));
        assert!(context["capability_route"].as_str().unwrap().contains("capability_provisioning_followup"));
        assert!(context["rule"].as_str().unwrap().contains("cancel_work_order"));
    }
}
