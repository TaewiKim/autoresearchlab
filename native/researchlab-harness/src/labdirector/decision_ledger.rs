//! The cycle's decision ledger: what its directors decided, kept by the harness.
//!
//! Every director lane is a fresh model call. What it knows of the cycle's past
//! is what the harness puts in front of it, and until now that was a notebook
//! each director REWRITES (`<cycle>-lab-director-research-notes.json`) plus the
//! clues a director chose to file.
//!
//! MEASURED ON cycle-a-20260919, 2026-11-21, after 2,078 director lanes:
//! the notebook was 5 KB and its `decision_log` held ONE entry, the latest;
//! `rejected_or_demoted_hypotheses` held five. The cycle memory files are built
//! from that notebook. An experiment the owner had ordered (common_support_pose_v1)
//! was named in the notebook twice at director 2014 and never after 2027, and the
//! lead restored for it was listed among the rejected as if it were the retired
//! panel it replaced. Each rewrite is a lossy summary of a lossy summary.
//!
//! This ledger is not written by a model. After each director lane completes, the
//! harness appends one record taken from the lane's own structured decision: what
//! it decided, the lead it selected, what it ordered and cancelled, the validation
//! terms it changed, and the designs it listed as rejected, with the lane and the
//! time. Records are never edited. What a director is shown is a VIEW computed
//! from all of them: every lead ever selected, every design ever rejected with
//! its latest reason, the commitments in force, the last decisions in full and
//! the older ones rolled up by day -- with the ledger's path for the detail.

use super::work_orders::{completed_role_lanes_after, director_payload, parse_time};
use super::*;
use std::collections::BTreeMap;
use std::io::Write;

/// Director lanes read per refresh. A first reading of a long cycle catches up
/// over a few passes instead of holding one pass for the whole history.
const MAX_LANES_PER_REFRESH: usize = 150;
const RECENT_DECISIONS: usize = 10;
const MAX_REJECTED_SHOWN: usize = 60;
const MAX_COMMITMENTS_SHOWN: usize = 12;
const MAX_LEADS_SHOWN: usize = 16;
const MAX_DAYS_SHOWN: usize = 21;

pub(crate) fn decision_ledger_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-decision-ledger.jsonl"))
}

fn ledger_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-decision-ledger-state.json"))
}

fn clip(value: Option<&Value>, max_chars: usize) -> String {
    let text = match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > max_chars {
        format!("{}…", text.chars().take(max_chars.saturating_sub(1)).collect::<String>())
    } else {
        text
    }
}

fn lead_of(payload: &Value) -> Option<(String, String)> {
    let selected = payload.get("selected_hypothesis")?;
    let statement = match selected {
        Value::String(text) => text.clone(),
        Value::Object(_) => selected.get("statement").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    };
    if statement.trim().is_empty() {
        return None;
    }
    let family = ["primary_family", "family", "hypothesis_family", "lead_family", "family_id"]
        .iter()
        .find_map(|key| selected.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    Some((statement, family))
}

/// The designs a director listed as rejected or demoted, from the notebook copy
/// it left in its own lane.
fn rejected_in_lane(lane_dir: &Path) -> Vec<Value> {
    let Ok(notes) = read_json(&lane_dir.join("lab-director-research-notes.json")) else {
        return Vec::new();
    };
    notes
        .get("rejected_or_demoted_hypotheses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let family = ["family", "hypothesis_family", "name", "hypothesis"]
                .iter()
                .find_map(|key| item.get(*key).and_then(Value::as_str))
                .map(|value| clip(Some(&json!(value)), 120))?;
            if family.is_empty() {
                return None;
            }
            let why = ["reason", "disposition", "why", "rationale"]
                .iter()
                .find_map(|key| item.get(*key))
                .map(|value| clip(Some(value), 200))
                .unwrap_or_default();
            Some(json!({"family": family, "why": why}))
        })
        .take(12)
        .collect()
}

/// One record: what this director decided, in its own structured words.
fn record_for(lane_id: &str, completed_at: &str, lane_dir: &Path, payload: &Value) -> Value {
    let plan = read_json(&lane_dir.join("role-plan.json")).unwrap_or(Value::Null);
    let brief = plan.get("source_brief_id").and_then(Value::as_str).unwrap_or("").to_string();
    let mut orders = Vec::new();
    let mut cancels = Vec::new();
    for action in payload.get("next_actions").and_then(Value::as_array).into_iter().flatten() {
        let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
        if action_type == "cancel_work_order" {
            cancels.push(json!(clip(action.get("description"), 180)));
        } else {
            orders.push(json!({
                "role": action.get("preferred_role").and_then(Value::as_str).unwrap_or(""),
                "type": action_type,
                "what": clip(action.get("description"), 220),
            }));
        }
    }
    // A director also writes where it saved its notes into this list; that is
    // bookkeeping, not a term of the validation.
    let validation_changes: Vec<Value> = payload
        .get("validation_changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| clip(Some(item), 260))
        .filter(|text| !text.is_empty() && !text.contains("research-notes") && !text.to_lowercase().contains("notes saved"))
        .take(8)
        .map(Value::String)
        .collect();
    let lead = lead_of(payload);
    json!({
        "lane_id": lane_id,
        "at": completed_at,
        "brief": brief,
        "from_owner": brief == "direct_researcher_instruction",
        "decision": payload.get("requery_decision").and_then(Value::as_str).unwrap_or(""),
        "lead": lead.as_ref().map(|(statement, _)| clip(Some(&json!(statement)), 300)),
        "lead_family": lead.as_ref().map(|(_, family)| family.clone()).filter(|family| !family.is_empty()),
        "gist": clip(payload.get("rationale"), 520),
        "orders": orders,
        "cancels": cancels,
        "validation_changes": validation_changes,
        "rejected": rejected_in_lane(lane_dir),
    })
}

/// Append the directors that completed since the last reading. Returns how many
/// were added; `max_lanes` bounds one call.
pub(crate) fn refresh_decision_ledger(paths: &AppPaths, cycle_id: &str, max_lanes: usize) -> Result<usize> {
    let state_path = ledger_state_path(paths, cycle_id);
    let state = read_json(&state_path).unwrap_or_else(|_| json!({}));
    let epoch = DateTime::<Utc>::from_timestamp(0, 0).expect("epoch");
    let watermark = parse_time(state.get("watermark")).unwrap_or(epoch);
    let lanes = completed_role_lanes_after(paths, cycle_id, "lab-director", watermark)?;
    if lanes.is_empty() {
        return Ok(0);
    }
    let ledger_path = decision_ledger_path(paths, cycle_id);
    if let Some(parent) = ledger_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&ledger_path)?;
    let mut added = 0usize;
    let mut newest = watermark;
    for (completed_at, lane_id, lane_dir) in lanes.into_iter().take(max_lanes) {
        newest = newest.max(completed_at);
        // A director that produced no structured decision decided nothing to record.
        let Some(payload) = director_payload(&lane_dir.join("result.json")) else { continue };
        let stamp = completed_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let record = record_for(&lane_id, &stamp, &lane_dir, &payload);
        writeln!(file, "{}", serde_json::to_string(&record)?)?;
        added += 1;
    }
    file.flush()?;
    let recorded = state.get("recorded").and_then(Value::as_u64).unwrap_or(0) + added as u64;
    write_json(
        &state_path,
        &json!({
            "cycle_id": cycle_id,
            "watermark": newest.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "recorded": recorded,
            "updated_at": now_iso(),
        }),
    )?;
    Ok(added)
}

/// Start again from the first director lane. For a cycle that predates the ledger.
pub(crate) fn rebuild_decision_ledger(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    let _ = fs::remove_file(decision_ledger_path(paths, cycle_id));
    let _ = fs::remove_file(ledger_state_path(paths, cycle_id));
    let mut total = 0usize;
    loop {
        let added = refresh_decision_ledger(paths, cycle_id, 500)?;
        let behind = {
            let state = read_json(&ledger_state_path(paths, cycle_id)).unwrap_or(Value::Null);
            let watermark = parse_time(state.get("watermark")).unwrap_or_else(Utc::now);
            !completed_role_lanes_after(paths, cycle_id, "lab-director", watermark)?.is_empty()
        };
        total += added;
        if !behind {
            return Ok(total);
        }
    }
}

fn read_records(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    fs::read_to_string(decision_ledger_path(paths, cycle_id))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn family_key(family: &str) -> String {
    family
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The view of the whole ledger a director is given.
pub(crate) fn decision_memory_view(records: &[Value]) -> Value {
    // Every lead a director selected, in order. A lead is identified by its
    // family where it names one: directors reword a standing lead at almost every
    // decision (951 wordings of this cycle's leads), and each rewording is the
    // same lead still standing, not a new one.
    let mut leads: Vec<Value> = Vec::new();
    let mut last_identity = String::new();
    let mut owner_families: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for record in records {
        let lead = text(record, "lead");
        if lead.is_empty() {
            continue;
        }
        let family = text(record, "lead_family");
        let from_owner = record.get("from_owner").and_then(Value::as_bool) == Some(true);
        if from_owner && !family.is_empty() {
            owner_families.insert(family_key(family));
        }
        let identity = if family.is_empty() { lead.to_string() } else { family_key(family) };
        // A lead the owner orders starts its own entry even within a family: it
        // is a new experiment, and its statement must not sit behind the old one.
        let owner_restart = from_owner && leads.last().is_some_and(|standing: &Value| standing["ordered_by_owner"] != json!(true));
        if identity != last_identity || owner_restart {
            leads.push(json!({"at": record.get("at"), "by": record.get("lane_id"), "family": record.get("lead_family"), "statement": clip(Some(&json!(lead)), 220), "ordered_by_owner": from_owner, "kept_through": record.get("lane_id")}));
            last_identity = identity;
        } else if let Some(standing) = leads.last_mut() {
            standing["kept_through"] = record.get("lane_id").cloned().unwrap_or(Value::Null);
            if from_owner {
                standing["ordered_by_owner"] = json!(true);
            }
        }
    }
    // Every design ever listed as rejected or demoted, with the latest reason.
    let mut rejected: BTreeMap<String, Value> = BTreeMap::new();
    for record in records {
        for item in record.get("rejected").and_then(Value::as_array).into_iter().flatten() {
            let family = text(item, "family");
            let key = family_key(family);
            if key.is_empty() {
                continue;
            }
            let entry = rejected.entry(key).or_insert_with(|| json!({"family": family, "first_by": record.get("lane_id"), "first_at": record.get("at"), "times_listed": 0}));
            entry["why"] = item.get("why").cloned().unwrap_or(Value::Null);
            entry["last_by"] = record.get("lane_id").cloned().unwrap_or(Value::Null);
            entry["last_at"] = record.get("at").cloned().unwrap_or(Value::Null);
            entry["times_listed"] = json!(entry["times_listed"].as_u64().unwrap_or(0) + 1);
        }
    }
    // A design the owner ordered is not closed by the reasons recorded against
    // an earlier attempt at it.
    //
    // MEASURED ON cycle-a-20260919: `cross_architecture_support_distance_curves`
    // was listed as rejected 44 times ("withdrawn; the historical estimates remain
    // unidentified") -- the reason belongs to the retired five-policy panel, and
    // the owner had ordered a new panel for the same design.
    for (key, entry) in rejected.iter_mut() {
        if owner_families.contains(key) {
            entry["ordered_by_owner"] = json!(true);
            entry["note"] = json!("The owner ordered a lead of this family. The reason recorded here concerns an earlier attempt at it; it does not close the design.");
        }
    }
    let mut rejected: Vec<Value> = rejected.into_values().collect();
    rejected.sort_by(|a, b| text(b, "last_at").cmp(text(a, "last_at")));
    let rejected_total = rejected.len();
    rejected.truncate(MAX_REJECTED_SHOWN);
    // The validation terms directors changed, newest first, each wording once.
    let mut commitments: Vec<Value> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for record in records.iter().rev() {
        for change in record.get("validation_changes").and_then(Value::as_array).into_iter().flatten() {
            let Some(change) = change.as_str() else { continue };
            if seen.insert(family_key(change)) && commitments.len() < MAX_COMMITMENTS_SHOWN {
                commitments.push(json!({"at": record.get("at"), "by": record.get("lane_id"), "term": change}));
            }
        }
    }
    // The last decisions in full; the older ones by day.
    let recent_from = records.len().saturating_sub(RECENT_DECISIONS);
    let recent: Vec<Value> = records[recent_from..]
        .iter()
        .map(|record| {
            let orders: Vec<String> = record
                .get("orders")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|order| format!("{} {}: {}", text(order, "role"), text(order, "type"), text(order, "what")))
                .collect();
            json!({"at": record.get("at"), "by": record.get("lane_id"), "asked_by": record.get("brief"), "decision": record.get("decision"), "lead": record.get("lead"), "gist": record.get("gist"), "orders": orders, "cancels": record.get("cancels")})
        })
        .collect();
    let mut days: BTreeMap<String, (u64, u64, u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    for record in &records[..recent_from] {
        let day = text(record, "at").chars().take(10).collect::<String>();
        let entry = days.entry(day).or_default();
        entry.0 += 1;
        entry.1 += u64::from(!text(record, "lead").is_empty());
        entry.2 += u64::from(record.get("from_owner").and_then(Value::as_bool) == Some(true));
        for order in record.get("orders").and_then(Value::as_array).into_iter().flatten() {
            entry.3 += 1;
            *entry.4.entry(text(order, "role").to_string()).or_insert(0) += 1;
        }
    }
    let days_total = days.len();
    let by_day: Vec<Value> = days
        .into_iter()
        .rev()
        .take(MAX_DAYS_SHOWN)
        .map(|(day, (decisions, with_lead, from_owner, orders, by_role))| {
            let roles = by_role.iter().map(|(role, count)| format!("{role} {count}")).collect::<Vec<_>>().join(", ");
            json!(format!("{day}: {decisions} decisions ({with_lead} naming a lead, {from_owner} for the owner), {orders} orders [{roles}]"))
        })
        .collect();
    let leads_total = leads.len();
    if leads.len() > MAX_LEADS_SHOWN {
        leads.drain(..leads.len() - MAX_LEADS_SHOWN);
    }
    json!({
        "decisions_recorded": records.len(),
        "first_decision_at": records.first().and_then(|record| record.get("at")),
        "leads_selected": {"total": leads_total, "shown_newest_last": leads},
        "designs_rejected_or_demoted": {"total": rejected_total, "shown_most_recent_first": rejected},
        "validation_terms_changed": commitments,
        "recent_decisions": recent,
        "earlier_decisions_by_day": {"days_total": days_total, "shown_newest_first": by_day},
    })
}

/// What every director lane is given of the cycle's decisions so far.
pub(crate) fn decision_memory_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    // Reading is best effort: a director is never held because its history could
    // not be brought up to date.
    let _ = refresh_decision_ledger(paths, cycle_id, MAX_LANES_PER_REFRESH);
    let records = read_records(paths, cycle_id);
    if records.is_empty() {
        return Value::Null;
    }
    let mut view = decision_memory_view(&records);
    view["ledger_path"] = json!(format!(".research-lab/state/{cycle_id}-decision-ledger.jsonl"));
    view["rule"] = json!("This is the harness's own record of every director decision in this cycle, one line per decision in the ledger file, never rewritten; your notebook is a summary and this is the record. Before you propose, select or order anything: (1) read `designs_rejected_or_demoted` -- a design listed there is not proposed again unless you name the NEW evidence that answers the reason recorded for it; (2) read `leads_selected` -- do not confuse a lead with an earlier one of a similar name, and do not treat an experiment the owner ordered as the panel it replaced: an entry marked `ordered_by_owner` is not closed by the reasons recorded against an earlier attempt; (3) `validation_terms_changed` are commitments in force until a later decision changes them explicitly; (4) `recent_decisions` are what your predecessors just did -- continue their unfinished work before opening a new line. When you need the detail behind a day or a design, read that lane's line in the ledger rather than guessing.");
    view
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision(lane: &str, at: &str, lead: Option<&str>, rejected: &[(&str, &str)], changes: &[&str], owner: bool) -> Value {
        // The family is the first word of the lead, so a reworded lead keeps it.
        let family = lead.map(|text| text.split_whitespace().next().unwrap_or("").to_string());
        json!({
            "lane_id": lane, "at": at, "brief": if owner { "direct_researcher_instruction" } else { "brief" }, "from_owner": owner,
            "decision": "restart", "lead": lead, "lead_family": family, "gist": format!("gist of {lane}"),
            "orders": [{"role": "scout", "type": "novelty_followup", "what": "audit"}], "cancels": [],
            "validation_changes": changes,
            "rejected": rejected.iter().map(|(family, why)| json!({"family": family, "why": why})).collect::<Vec<_>>(),
        })
    }

    // The measured failure: after 2,078 directors the notebook's decision log held
    // one entry and five rejected designs.
    #[test]
    fn nothing_a_director_decided_is_lost_to_a_later_rewrite() {
        let mut records = Vec::new();
        for index in 0..60 {
            let lane = format!("followup-lab-director-{}", 2000 + index);
            let day = 10 + index / 10;
            let rejected_family = format!("design_{}", index % 25);
            records.push(decision(&lane, &format!("2026-11-{day:02}T0{}:00:00Z", index % 10), None, &[(rejected_family.as_str(), "no differentiated claim")], &[], false));
        }
        // The owner's lead, once, in the middle of it all.
        records[20] = decision("followup-lab-director-2009", "2026-11-12T00:47:27Z", Some("common-support coverage panel"), &[], &["pilot seeds [100,101]"], true);
        let view = decision_memory_view(&records);
        assert_eq!(view["decisions_recorded"], json!(60));
        // Every one of the 25 designs is still known, however long ago it was listed.
        assert_eq!(view["designs_rejected_or_demoted"]["total"], json!(25));
        let leads = view["leads_selected"]["shown_newest_last"].as_array().unwrap();
        assert_eq!(leads.len(), 1);
        assert_eq!(leads[0]["statement"], json!("common-support coverage panel"));
        assert_eq!(leads[0]["family"], json!("common-support"));
        assert_eq!(leads[0]["ordered_by_owner"], json!(true));
        assert_eq!(view["validation_terms_changed"][0]["term"], json!("pilot seeds [100,101]"));
        assert_eq!(view["recent_decisions"].as_array().unwrap().len(), RECENT_DECISIONS);
        // The fifty older decisions are not dropped: they are counted by day.
        let by_day: u64 = view["earlier_decisions_by_day"]["shown_newest_first"]
            .as_array()
            .unwrap()
            .iter()
            .map(|day| day.as_str().unwrap().split(": ").nth(1).unwrap().split(' ').next().unwrap().parse::<u64>().unwrap())
            .sum();
        assert_eq!(by_day, 50);
    }

    #[test]
    fn a_design_listed_again_keeps_one_entry_with_its_latest_reason() {
        let records = vec![
            decision("d1", "2026-11-10T00:00:00Z", None, &[("Paired Rendering", "source access unresolved")], &[], false),
            decision("d2", "2026-11-12T00:00:00Z", None, &[("paired_rendering", "published overlap confirmed")], &[], false),
        ];
        let view = decision_memory_view(&records);
        let shown = view["designs_rejected_or_demoted"]["shown_most_recent_first"].as_array().unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["why"], json!("published overlap confirmed"));
        assert_eq!(shown[0]["first_by"], json!("d1"));
        assert_eq!(shown[0]["last_by"], json!("d2"));
        assert_eq!(shown[0]["times_listed"], json!(2));
    }

    // MEASURED: the owner's design sat in the rejected list 44 times, for a reason
    // that belonged to the panel it replaced; and one lead had 951 wordings.
    #[test]
    fn a_reworded_lead_is_one_lead_and_an_owner_ordered_design_is_not_closed() {
        let records = vec![
            decision("d1", "2026-11-06T00:00:00Z", Some("coverage_curves the sealed panel"), &[], &[], false),
            decision("d2", "2026-11-07T00:00:00Z", Some("coverage_curves the sealed panel, reworded"), &[], &[], false),
            decision("d3", "2026-11-10T00:00:00Z", None, &[("coverage_curves", "withdrawn; historical estimates unidentified")], &[], false),
            decision("d4", "2026-11-16T00:00:00Z", Some("coverage_curves a new common-support panel"), &[], &[], true),
            decision("d5", "2026-11-21T00:00:00Z", None, &[("coverage_curves", "withdrawn; historical estimates unidentified"), ("other_design", "no delta")], &[], false),
        ];
        let view = decision_memory_view(&records);
        let leads = view["leads_selected"]["shown_newest_last"].as_array().unwrap();
        assert_eq!(leads.len(), 2, "two wordings of one family are one lead, and the owner's order starts another: {leads:?}");
        assert_eq!(leads[0]["kept_through"], json!("d2"));
        assert_eq!(leads[0]["ordered_by_owner"], json!(false));
        assert_eq!(leads[1]["by"], json!("d4"));
        assert_eq!(leads[1]["ordered_by_owner"], json!(true));
        assert!(leads[1]["statement"].as_str().unwrap().contains("new common-support panel"));
        let rejected = view["designs_rejected_or_demoted"]["shown_most_recent_first"].as_array().unwrap();
        let owners = rejected.iter().find(|item| item["family"] == json!("coverage_curves")).unwrap();
        assert_eq!(owners["ordered_by_owner"], json!(true));
        assert!(owners["note"].as_str().unwrap().contains("does not close the design"));
        let other = rejected.iter().find(|item| item["family"] == json!("other_design")).unwrap();
        assert!(other.get("ordered_by_owner").is_none());
    }

    #[test]
    fn the_view_stays_small_however_long_the_cycle_runs() {
        let records: Vec<Value> = (0..3000)
            .map(|index| {
                let family = format!("design_{index}");
                decision(&format!("followup-lab-director-{index}"), &format!("2026-{:02}-{:02}T00:00:00Z", 1 + (index / 250) % 12, 1 + index % 28), Some(&format!("lead{index} statement")), &[(family.as_str(), "why not")], &["a term"], false)
            })
            .collect();
        let view = decision_memory_view(&records);
        assert_eq!(view["designs_rejected_or_demoted"]["total"], json!(3000));
        assert!(view.to_string().len() < 36_000, "{} bytes", view.to_string().len());
    }
}
