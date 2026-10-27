use anyhow::Result;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{now_iso, read_json, state_root, write_json};

// --- lead hold ------------------------------------------------------------------
//
// A lead is not replaced before it has been tested.
//
// MEASURED ON cycle-g-v91, 2026-09-14. Directors 66, 67, 68 and 69 replaced the
// lead four times in three and a half hours. Every gate review in that window
// rejected, and the newest said it plainly: "no supplied validation executes it;
// existing results belong to an earlier lead". Runners were producing numbers the
// whole time -- for the lead before. Replayed against the cycle's own lanes, 8 of
// the last 10 replacements happened before any gate round had reviewed evidence a
// runner produced after the lead was chosen. The lead-protection directive said
// so in prose; nothing at the one place a lead is written read it.
//
// The hold is released by what the lead itself produced, never by a clock the
// director can wait out:
//   * a runner that executed a handoff written AFTER the lead was selected, and
//     produced evidence, and a gatekeeper that completed after that runner; or
//   * such a runner validly falsifying it; or
//   * the lead having held RESEARCHLAB_LEAD_HOLD_GATE_ROUNDS gate rounds anyway,
//     so a lead nobody can validate cannot freeze the cycle (0 disables the hold).
// A refused replacement is kept in the lead file under `replacement_deferred`,
// where the next director reads it, instead of being thrown away.

const DEFAULT_LEAD_HOLD_GATE_ROUNDS: u64 = 4;

fn lead_hold_record_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-lead-hold.json"))
}

/// Keep the lead this projection just wrote, for the next projection to hold.
fn write_lead_hold_record(paths: &AppPaths, contract: &LaneContract, lead: &Value) -> Result<()> {
    write_json(
        &lead_hold_record_path(paths, &contract.cycle_id),
        &json!({
            "cycle_id": contract.cycle_id,
            "written_by": contract.lane_id,
            "written_at": now_iso(),
            "lead": lead,
        }),
    )
}
const DEFERRED_REPLACEMENTS_KEPT: usize = 5;
const LANE_RESULT_READ_LIMIT_BYTES: u64 = 16 * 1024 * 1024;

fn lead_hold_gate_rounds() -> u64 {
    std::env::var("RESEARCHLAB_LEAD_HOLD_GATE_ROUNDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_LEAD_HOLD_GATE_ROUNDS)
}

fn epoch_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok().map(epoch_ms)
}

fn read_json_bounded(path: &Path) -> Option<Value> {
    let size = fs::metadata(path).ok()?.len();
    if size > LANE_RESULT_READ_LIMIT_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// (gate round in force at `at_ms`, latest gate round), from the watchdog history.
fn gate_rounds_at(paths: &AppPaths, cycle_id: &str, at_ms: u64) -> (Option<u64>, Option<u64>) {
    let history = state_root(paths).join(format!("{cycle_id}-watchdog-history.jsonl"));
    let Ok(text) = fs::read_to_string(history) else {
        return (None, None);
    };
    let mut at_selection = None;
    let mut latest = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(round) = row.get("gate_rounds").and_then(Value::as_u64) else {
            continue;
        };
        latest = Some(round);
        if row.get("epoch_ms").and_then(Value::as_u64).is_some_and(|ms| ms <= at_ms) {
            at_selection = Some(round);
        }
    }
    (at_selection, latest)
}

/// Gate rounds recorded since `since_ms`, counted the way the progress watchdog
/// counts them: one per gate decision written to the hypothesis-progress log
/// (`memory_type: decision` carrying a rubric). That log exists whether or not
/// the watchdog ever ran, so the hold ceiling stays reachable without
/// watchdog-history.jsonl.
///
/// Not completed gatekeeper lanes. MEASURED ON cycle-a-20260919,
/// 2026-10-01: after the lead was selected at 19:50Z, eight gatekeeper lanes
/// completed -- rubric re-reviews and gate-restart challenges -- while one gate
/// decision was recorded. Counting lanes released a four-round hold after a
/// single round.
fn gate_decisions_since(paths: &AppPaths, cycle_id: &str, since_ms: u64) -> Option<u64> {
    let log = state_root(paths).join(format!("{cycle_id}-hypothesis-progress.jsonl"));
    let text = fs::read_to_string(log).ok()?;
    let rounds = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row.get("memory_type").and_then(Value::as_str) == Some("decision"))
        .filter(|row| row.pointer("/content/rubric").is_some())
        .filter_map(|row| {
            let stamp = row
                .get("ts")
                .or_else(|| row.pointer("/content/ts"))
                .and_then(Value::as_str)?;
            chrono::DateTime::parse_from_rfc3339(stamp)
                .ok()
                .map(|time| time.timestamp_millis())
        })
        .filter(|ms| *ms >= since_ms as i64)
        .count();
    Some(rounds as u64)
}

fn runner_handoff_path(role_plan: &Value) -> Option<&str> {
    let metadata = role_plan.get("planner_metadata");
    metadata
        .and_then(|value| value.get("analyst_handoff_path"))
        .or_else(|| metadata.and_then(|value| value.get("analysis_request")).and_then(|value| value.get("handoff_path")))
        .or_else(|| role_plan.get("analysis_request").and_then(|value| value.get("handoff_path")))
        .or_else(|| role_plan.get("analyst_handoff_path"))
        .and_then(Value::as_str)
}

fn preselection_handoff_matches_materialized_lead(handoff: &Path, existing: &Value) -> bool {
    let materialized = existing.get("validation_data_status").and_then(Value::as_str)
        == Some("materialized")
        || existing
            .pointer("/identification_strategy/validation_data_status")
            .and_then(Value::as_str)
            == Some("materialized");
    if !materialized {
        return false;
    }
    let dataset = existing
        .pointer("/identification_strategy/dataset_or_accession")
        .or_else(|| existing.get("dataset_or_accession"))
        .and_then(Value::as_str);
    dataset.is_some_and(|dataset| {
        read_json_bounded(handoff)
            .is_some_and(|value| value_mentions_accession(&value, Some(dataset)))
    })
}

fn execution_produced_evidence(execution: &Value) -> bool {
    match execution.get("produced_evidence").and_then(Value::as_bool) {
        Some(flag) => flag,
        // Results written before the driver recorded the flag: a finished
        // execution that emitted metrics is what they could prove.
        None => {
            execution.get("status").and_then(Value::as_str) == Some("completed")
                && execution
                    .get("metrics")
                    .and_then(Value::as_object)
                    .is_some_and(|metrics| !metrics.is_empty())
        }
    }
}

fn result_declares_falsification(result: &Value) -> bool {
    let declares = |item: &Value| {
        item.get("resolution_status").and_then(Value::as_str) == Some("valid_falsification")
            || item.get("valid_falsification_result").and_then(Value::as_bool) == Some(true)
    };
    let summary = result.get("validation_summary").unwrap_or(&Value::Null);
    summary
        .get("handoff_check_resolutions")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(declares))
        || result
            .get("blueprint_executions")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|execution| execution.get("metrics").is_some_and(|metrics| declares(metrics)))
            })
}

fn result_declares_design_invalid(result: &Value) -> bool {
    result
        .get("blueprint_executions")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|execution| {
                execution.get("status").and_then(Value::as_str) == Some("completed")
                    && execution
                        .pointer("/metrics/resolution_status")
                        .and_then(Value::as_str)
                        == Some("not_estimable_design_invalid")
            })
        })
}

#[derive(Debug, Default, PartialEq)]
struct LeadEvidence {
    /// First runner, by completion, that executed a post-selection handoff and measured something.
    evidence_runner: Option<String>,
    falsified_by: Option<String>,
    design_invalidated_by: Option<String>,
    gated_by: Option<String>,
    execution_blocker: Option<String>,
    blocker_gated_by: Option<String>,
}

fn completed_final_status_ms(lane_dir: &Path) -> Option<u64> {
    let path = lane_dir.join("final-status.json");
    let status = read_json_bounded(&path)?;
    if status.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    modified_ms(&path)
}

fn simulation_blocker_matches_lead(role_plan: &Value, result: &Value, existing: &Value) -> bool {
    if role_plan.get("action_type").and_then(Value::as_str)
        != Some(crate::labdirector::SIMULATION_DATA_GENERATION_ACTION)
    {
        return false;
    }
    let order = role_plan
        .pointer("/planner_metadata/simulation_order")
        .filter(|value| value.is_object());
    let order_path = order
        .and_then(|value| value.get("output_path"))
        .and_then(Value::as_str);
    let lead_path = existing
        .pointer("/identification_strategy/dataset_or_accession")
        .or_else(|| existing.get("dataset_or_accession"))
        .and_then(Value::as_str);
    if order_path.zip(lead_path).is_none_or(|(order, lead)| order != lead) {
        return false;
    }
    let Some(request_id) = order
        .and_then(|value| value.get("request_id"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let payload = result.get("extracted_json").unwrap_or(result);
    let has_blocker = payload
        .get("capability_blockers")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    has_blocker
        && payload
            .get("simulation_outputs")
            .and_then(Value::as_array)
            .is_some_and(|outputs| {
                outputs.iter().any(|output| {
                    output.get("request_id").and_then(Value::as_str) == Some(request_id)
                        && output.get("rows").and_then(Value::as_u64) == Some(0)
                        && output
                            .get("return_code")
                            .and_then(Value::as_i64)
                            .is_some_and(|code| code != 0)
                })
            })
}

fn gatekeeper_reviewed_lead(role_plan: &Value, statement: &str) -> bool {
    role_plan
        .pointer("/planner_metadata/current_lead_under_review/statement")
        .and_then(Value::as_str)
        .is_some_and(|reviewed| reviewed.trim() == statement.trim())
}

fn gatekeeper_result_is_decision(result: &Value) -> bool {
    let payload = result.get("extracted_json").unwrap_or(result);
    payload
        .get("rubric")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        && payload.get("verdict").and_then(Value::as_str).is_some()
}

fn lead_evidence_since(
    paths: &AppPaths,
    cycle_id: &str,
    selected_ms: u64,
    existing: &Value,
) -> LeadEvidence {
    let lanes_root = paths.runtime_root.join("lanes").join(cycle_id);
    let Ok(entries) = fs::read_dir(&lanes_root) else {
        return LeadEvidence::default();
    };
    let mut evidence: Option<(u64, String)> = None;
    let mut falsified_by = None;
    let mut design_invalidated_by = None;
    let mut gatekeepers: Vec<(u64, String)> = Vec::new();
    let mut matching_gatekeepers: Vec<(u64, String)> = Vec::new();
    let mut execution_blocker: Option<(u64, String)> = None;
    let statement = hypothesis_statement(existing).unwrap_or_default();
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        let lane_id = entry.file_name().to_string_lossy().to_string();
        let Some(done_ms) = completed_final_status_ms(&lane_dir) else {
            continue;
        };
        if lane_id.contains("gatekeeper") {
            if done_ms < selected_ms {
                continue;
            }
            gatekeepers.push((done_ms, lane_id));
            if read_json_bounded(&lane_dir.join("role-plan.json")).is_some_and(|plan| {
                gatekeeper_reviewed_lead(&plan, &statement)
                    && read_json_bounded(&lane_dir.join("result.json"))
                        .is_some_and(|result| gatekeeper_result_is_decision(&result))
            })
            {
                matching_gatekeepers.push((
                    done_ms,
                    entry.file_name().to_string_lossy().to_string(),
                ));
            }
            continue;
        }
        let Some(role_plan) = read_json_bounded(&lane_dir.join("role-plan.json")) else {
            continue;
        };
        let Some(result) = read_json_bounded(&lane_dir.join("result.json")) else {
            continue;
        };
        // MEASURED ON cycle-a-20260919, 2026-10-04: the selected
        // simulation returned a structured zero-row blocker and an independent
        // gatekeeper reviewed that exact lead, but the hold only looked for
        // `runner` lanes with analyst handoffs. The director's replacements
        // could therefore never become the executable lead.
        if simulation_blocker_matches_lead(&role_plan, &result, existing) {
            if execution_blocker.as_ref().is_none_or(|(ms, _)| done_ms < *ms) {
                execution_blocker = Some((done_ms, lane_id.clone()));
            }
            continue;
        }
        if !lane_id.contains("runner") {
            continue;
        }
        let handoff_is_for_this_lead = runner_handoff_path(&role_plan).is_some_and(|handoff| {
            let handoff = Path::new(handoff);
            modified_ms(handoff).is_some_and(|handoff_ms| handoff_ms >= selected_ms)
                // MEASURED ON cycle-a-20260919, 2026-10-05:
                // lead 425 selected the already-materialized Runner-140 claim
                // and explicitly prohibited rerunning it. The hold discarded
                // that runner solely because selection came later, so even an
                // exact-lead rejection by gatekeeper 219 could never release it.
                || preselection_handoff_matches_materialized_lead(handoff, existing)
        });
        if !handoff_is_for_this_lead {
            continue;
        }
        // MEASURED ON cycle-a-20260919, 2026-10-26: runner 777
        // correctly stopped at a registered validity gate and recorded
        // not_estimable_design_invalid. Because that fail-closed result sets
        // produced_evidence=false, the hold saw no execution and indefinitely
        // deferred the director's prospective replacement design.
        if done_ms >= selected_ms
            && design_invalidated_by.is_none()
            && result_declares_design_invalid(&result)
        {
            design_invalidated_by = Some(lane_id.clone());
        }
        let measured = result
            .get("blueprint_executions")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(execution_produced_evidence));
        if !measured {
            continue;
        }
        if done_ms >= selected_ms
            && falsified_by.is_none()
            && result_declares_falsification(&result)
        {
            falsified_by = Some(lane_id.clone());
        }
        if evidence.as_ref().is_none_or(|(ms, _)| done_ms < *ms) {
            evidence = Some((done_ms, lane_id));
        }
    }
    let gated_by = evidence.as_ref().and_then(|(evidence_ms, _)| {
        let reviews = if *evidence_ms < selected_ms {
            &matching_gatekeepers
        } else {
            &gatekeepers
        };
        reviews
            .iter()
            .filter(|(ms, _)| ms > evidence_ms)
            .min_by_key(|(ms, _)| *ms)
            .map(|(_, lane_id)| lane_id.clone())
    });
    let blocker_gated_by = execution_blocker.as_ref().and_then(|(blocker_ms, _)| {
        matching_gatekeepers
            .iter()
            .filter(|(ms, _)| ms > blocker_ms)
            .min_by_key(|(ms, _)| *ms)
            .map(|(_, lane_id)| lane_id.clone())
    });
    LeadEvidence {
        evidence_runner: evidence.map(|(_, lane_id)| lane_id),
        falsified_by,
        design_invalidated_by,
        gated_by,
        execution_blocker: execution_blocker.map(|(_, lane_id)| lane_id),
        blocker_gated_by,
    }
}

/// Why this replacement may proceed, or None while the current lead is held.
fn lead_hold_release(
    paths: &AppPaths,
    cycle_id: &str,
    existing: &Value,
    hypothesis_path: &Path,
) -> (Option<String>, Value) {
    let hold_rounds = lead_hold_gate_rounds();
    if hold_rounds == 0 {
        return (Some("lead_hold_disabled".to_string()), Value::Null);
    }
    // A lead this projection wrote before the hold existed is dated by its file:
    // the last time the projection wrote it. An uphold rewrites that too, which
    // can only make the hold stricter, and the round ceiling still bounds it. A
    // lead from anywhere else carries no selection date to hold it by.
    let written_by_this_projection = existing.get("projection_source").and_then(Value::as_str)
        == Some("lab_director_lane_result");
    let Some(selected_ms) = existing
        .get("selected_at_epoch_ms")
        .and_then(Value::as_u64)
        .or_else(|| written_by_this_projection.then(|| modified_ms(hypothesis_path)).flatten())
    else {
        return (Some("current_lead_predates_the_hold".to_string()), Value::Null);
    };
    let evidence = lead_evidence_since(paths, cycle_id, selected_ms, existing);
    let (round_at_selection, latest_round) = gate_rounds_at(paths, cycle_id, selected_ms);
    let selected_round = existing
        .get("selected_at_gate_round")
        .and_then(Value::as_u64)
        .or(round_at_selection);
    let rounds_held = selected_round
        .zip(latest_round)
        .map(|(selected, latest)| latest.saturating_sub(selected))
        // MEASURED ON cycle-a-20260919, 2026-10-01: watchdog-history
        // .jsonl did not exist, so the documented four-round ceiling stayed
        // null forever and thirteen restart followups could not release the
        // lead. Without the watchdog's aggregate, the gate decisions it is
        // computed from are read directly (gate_decisions_since).
        .or_else(|| gate_decisions_since(paths, cycle_id, selected_ms));
    let status = json!({
        "selected_at_epoch_ms": selected_ms,
        "selected_at_gate_round": selected_round,
        "gate_rounds_held": rounds_held,
        "hold_gate_rounds": hold_rounds,
        "evidence_runner": evidence.evidence_runner,
        "gated_by": evidence.gated_by,
        "falsified_by": evidence.falsified_by,
        "design_invalidated_by": evidence.design_invalidated_by,
        "execution_blocker": evidence.execution_blocker,
        "blocker_gated_by": evidence.blocker_gated_by,
    });
    let reason = if evidence.falsified_by.is_some() {
        Some("lead_falsified_by_its_own_validation")
    } else if evidence.design_invalidated_by.is_some() {
        Some("lead_design_invalidated_by_its_own_validation")
    } else if evidence.gated_by.is_some() {
        Some("lead_evidence_reviewed_by_gate")
    } else if evidence.blocker_gated_by.is_some() {
        Some("lead_execution_blocker_reviewed_by_gate")
    } else if rounds_held.is_some_and(|held| held >= hold_rounds) {
        Some("lead_hold_round_ceiling_reached")
    } else {
        None
    };
    (reason.map(ToString::to_string), status)
}

fn compact_nonempty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn hypothesis_statement(value: &Value) -> Option<String> {
    compact_nonempty_string(value.get("statement"))
        .or_else(|| compact_nonempty_string(value.get("hypothesis")))
        .or_else(|| compact_nonempty_string(value.get("claim")))
}

fn embedded_key_value(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(&prefix).map(str::trim))
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn lead_string_field(lead: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = compact_nonempty_string(lead.get(*key)) {
            return Some(value);
        }
    }
    let why_selected = compact_nonempty_string(lead.get("why_selected"))
        .or_else(|| compact_nonempty_string(lead.get("why_better_than_reference_baseline")))?;
    for key in keys {
        if let Some(value) = embedded_key_value(&why_selected, key) {
            return Some(value);
        }
    }
    None
}

fn infer_accession_from_text(text: &str) -> Option<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .map(str::trim)
        .find_map(|token| {
            let upper = token.to_ascii_uppercase();
            let digits = upper.strip_prefix("GSE")?;
            if digits.len() >= 3 && digits.chars().all(|ch| ch.is_ascii_digit()) {
                Some(upper)
            } else {
                None
            }
        })
}

fn infer_accession_from_value(value: &Value) -> Option<String> {
    value
        .as_str()
        .and_then(infer_accession_from_text)
        .or_else(|| {
            serde_json::to_string(value)
                .ok()
                .and_then(|text| infer_accession_from_text(&text))
        })
}

fn value_mentions_accession(value: &Value, accession: Option<&str>) -> bool {
    let Some(accession) = accession.map(str::trim).filter(|item| !item.is_empty()) else {
        return true;
    };
    let haystack = value
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default());
    haystack
        .to_ascii_lowercase()
        .contains(&accession.to_ascii_lowercase())
}

fn materialized_dataset_for_lead(
    existing: &Value,
    lead: &Value,
    dataset_or_accession: &Value,
) -> Value {
    let dataset = dataset_or_accession.as_str();
    let candidates = [
        lead.get("materialized_dataset"),
        lead.get("identification_strategy")
            .and_then(|item| item.get("materialized_dataset")),
        existing
            .get("identification_strategy")
            .and_then(|item| item.get("materialized_dataset")),
        existing.get("materialized_dataset"),
    ];
    for candidate in candidates.into_iter().flatten() {
        // MEASURED ON cycle-a-20260919, 2026-10-03: four director
        // requeries returned the contract's nested string dataset path, but the
        // projection only accepted top-level objects and kept the live status at
        // needs_materialization after the 20,000-row bundle had been analysed.
        if (candidate.is_object() || candidate.is_string())
            && value_mentions_accession(candidate, dataset)
        {
            return candidate.clone();
        }
    }
    Value::Null
}

fn lab_director_structured_payload(payload: &Value) -> Option<&Value> {
    ["extracted_json", "lab_director_requery"]
        .iter()
        .filter_map(|key| payload.get(*key))
        .find(|value| value.is_object())
        .or_else(|| {
            if payload.get("selected_hypothesis").is_some()
                || payload.get("replacement_hypotheses").is_some()
                || payload.get("current_lead_hypothesis").is_some()
            {
                Some(payload)
            } else {
                None
            }
        })
}

fn select_lab_director_hypothesis(decision: &Value) -> Option<&Value> {
    let requery_decision = compact_nonempty_string(
        decision
            .get("requery_decision")
            .or_else(|| decision.get("decision")),
    )
    .map(|item| item.to_ascii_lowercase());
    let may_replace_current_lead = matches!(
        requery_decision.as_deref(),
        Some("replace") | Some("restart") | None
    );
    decision
        .get("selected_hypothesis")
        .filter(|value| hypothesis_statement(value).is_some())
        .or_else(|| {
            decision
                .get("current_lead_hypothesis")
                .filter(|value| hypothesis_statement(value).is_some())
        })
        .or_else(|| {
            if may_replace_current_lead {
                decision
                    .get("replacement_hypotheses")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|item| hypothesis_statement(item).is_some())
                    })
            } else {
                None
            }
        })
}

/// The family a lead belongs to is the LabDirector's judgment, declared on the
/// lead. This reads that declaration; it does not guess one from the prose.
///
/// It used to guess, from hardcoded keyword lists, and keyword lists misfire. On
/// cycle-g-v73 the marker `"tan"` (tumour-associated neutrophils) matched inside
/// **s-tan-dard** in "Residual Path Integrals and standard control variates do
/// not appear to execute this stopping policy", so a Mitsuba rendering lead was
/// stamped `tumor_immune_resistance` — which points novelty scoring at a
/// biomedical corpus. Worse, that positive match returned BEFORE the stale-label
/// guard below, so the guard could not undo it. Word boundaries would only delay
/// the next collision, and no keyword list covers a domain nobody listed yet.
///
/// A lead that declares no family projects `null`; the previous family is
/// inherited only while we are still on the SAME lead, so a new hypothesis never
/// silently adopts its predecessor's domain.
fn infer_primary_family(lead: &Value, existing: &Value, allow_existing_fallback: bool) -> Value {
    if let Some(family) = lead_string_field(lead, &["primary_family", "family_root", "family"]) {
        return json!(family);
    }
    let existing_family = existing
        .get("primary_family")
        .or_else(|| existing.get("family_root"))
        .and_then(Value::as_str);
    let same_lead = match (
        hypothesis_statement(lead),
        existing.get("statement").and_then(Value::as_str),
    ) {
        (Some(next), Some(prev)) => next.trim() == prev.trim(),
        _ => false,
    };
    if allow_existing_fallback && same_lead {
        existing_family
            .map(|family| json!(family))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

/// Record the `simulation_orders` a completed LabDirector lane answered with.
///
/// cycle-b-20260918, 2026-09-18: the owner assigned simulation orchestration
/// to the LabDirector; an analyst-declared request let the analyst choose the
/// experiment. The orders ride the director's accepted lead decision and are
/// read by the engineer dispatch, the analyst gate and the analyst's
/// candidate_datasets.
pub(crate) fn project_lab_director_simulation_orders(
    paths: &AppPaths,
    contract: &LaneContract,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    if contract.role != "lab-director" {
        return Ok(None);
    }
    let Some(decision) = lab_director_structured_payload(payload) else {
        return Ok(None);
    };
    if let Some(proposed_lead) = select_lab_director_hypothesis(decision) {
        let proposed_statement = hypothesis_statement(proposed_lead);
        let selected = read_json(
            &state_root(paths).join(format!(
                "{}-lab-director-hypothesis.json",
                contract.cycle_id
            )),
        )
        .ok()
        .is_some_and(|lead| {
            // An uphold keeps the canonical statement and records this director's
            // wording as its newest restatement; the decision is still this lane's.
            let upheld_in_its_words = lead
                .get("upheld_restatements")
                .and_then(Value::as_array)
                .and_then(|items| items.last())
                .is_some_and(|last| {
                    last.get("lane_id").and_then(Value::as_str) == Some(contract.lane_id.as_str())
                        && last.get("statement").and_then(Value::as_str).map(str::to_string) == proposed_statement
                });
            lead.get("generated_by").and_then(Value::as_str) == Some(contract.lane_id.as_str())
                && (hypothesis_statement(&lead) == proposed_statement || upheld_in_its_words)
        });
        // MEASURED ON cycle-a-20260919, 2026-10-02: Director-326's
        // replacement was deferred by the lead hold, but its `simulation_orders:
        // null` was projected independently and withdrew the protected lead's
        // order. Three completed simulation lanes then left progress at
        // `lead_selected`. Orders and lead identity are one decision: a rejected
        // replacement cannot mutate either half.
        if !selected {
            return Ok(None);
        }
    }
    crate::labdirector::record_lab_director_simulation_orders(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        decision,
    )
}

/// Every reason the lead gates refuse this lead: the field landscape's (when
/// that gate is on) and then the expert selection's (once engaged for the
/// cycle; see labdirector::problem_selection).
fn lead_selection_gate_reasons(
    paths: &AppPaths,
    cycle_id: &str,
    lead: &Value,
    first_selection: bool,
) -> Vec<String> {
    let mut reasons = if crate::labdirector::field_landscape_gate_enabled() {
        crate::labdirector::lead_landscape_rejection_reasons(
            lead,
            &crate::labdirector::field_landscape_status(paths, cycle_id),
            &crate::labdirector::field_landscape_thresholds(),
        )
    } else {
        Vec::new()
    };
    reasons.extend(crate::labdirector::lead_expert_selection_rejection_reasons(
        paths,
        cycle_id,
        lead,
        first_selection,
    ));
    reasons
}

fn lead_set_aside_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!(
        "{cycle_id}-lab-director-hypothesis.rejected-by-field-landscape.json"
    ))
}

/// A lead file this director lane wrote itself, while its result selected nothing.
///
/// The base director task tells the agent to write the lead file directly, and
/// cycle-g-v91 showed agents doing it on their own. A lead that reaches the file
/// that way never passes through the landscape gate, so when the gate would refuse
/// it, it is set aside and the refusal recorded like any other. Only a file written
/// during THIS lane (after its execution context) and not by this projection or the
/// hold is touched; a lead from before the lane is left alone.
fn refuse_lead_written_during_lane(paths: &AppPaths, contract: &LaneContract) -> Result<()> {
    if !crate::labdirector::field_landscape_gate_enabled()
        && !crate::labdirector::expert_selection_engaged(paths, &contract.cycle_id)
    {
        return Ok(());
    }
    let hypothesis_path = state_root(paths).join(format!(
        "{}-lab-director-hypothesis.json",
        contract.cycle_id
    ));
    let lane_started_ms = modified_ms(
        &crate::core::support::lane_root(paths, &contract.cycle_id, &contract.lane_id)
            .join("execution-context.json"),
    );
    let written_ms = modified_ms(&hypothesis_path);
    let (Some(started), Some(written)) = (lane_started_ms, written_ms) else {
        return Ok(());
    };
    if written < started || lead_hold_record_path(paths, &contract.cycle_id).exists() {
        return Ok(());
    }
    let Ok(file) = read_json(&hypothesis_path) else {
        return Ok(());
    };
    if file.get("projection_source").and_then(Value::as_str) == Some("lab_director_lane_result") {
        return Ok(());
    }
    let lead = file
        .get("selected_hypothesis")
        .filter(|value| hypothesis_statement(value).is_some())
        .unwrap_or(&file);
    let Some(statement) = hypothesis_statement(lead) else {
        return Ok(());
    };
    let reasons = lead_selection_gate_reasons(paths, &contract.cycle_id, lead, true);
    if reasons.is_empty() {
        return Ok(());
    }
    crate::labdirector::record_lead_selection_rejection(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        &statement,
        &json!("written_to_lead_file_directly"),
        &reasons,
    )?;
    fs::rename(&hypothesis_path, lead_set_aside_path(paths, &contract.cycle_id))?;
    Ok(())
}

pub(crate) fn project_lab_director_payload_to_hypothesis(
    paths: &AppPaths,
    contract: &LaneContract,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    if contract.role != "lab-director" {
        return Ok(None);
    }
    let Some(decision) = lab_director_structured_payload(payload) else {
        refuse_lead_written_during_lane(paths, contract)?;
        return Ok(None);
    };
    note_uphold_without_rebuttal(paths, contract, decision);
    let Some(lead) = select_lab_director_hypothesis(decision) else {
        refuse_lead_written_during_lane(paths, contract)?;
        return Ok(None);
    };
    let Some(statement) = hypothesis_statement(lead) else {
        refuse_lead_written_during_lane(paths, contract)?;
        return Ok(None);
    };

    let hypothesis_path = state_root(paths).join(format!(
        "{}-lab-director-hypothesis.json",
        contract.cycle_id
    ));
    // The lead this projection last wrote, kept where no agent is asked to write.
    //
    // MEASURED ON cycle-g-v91, 2026-09-14. followup-lab-director-75 deleted the
    // lead file and added its own with file_change at 15:32 -- no statement at the
    // top level, a made-up updated_at -- and when this projection ran two minutes
    // later there was no current lead left to hold, so the replacement went
    // through unchecked and the deferral record went with the file. The same
    // delete-and-add erased the lead on 2026-09-13. A hold that reads its baseline
    // from a file an agent can rewrite does not hold, so the baseline is this
    // record whenever it exists; the lead file is only the fallback for a cycle
    // that predates it.
    let hold_record_path = lead_hold_record_path(paths, &contract.cycle_id);
    let held_lead = read_json(&hold_record_path)
        .ok()
        .and_then(|record| record.get("lead").cloned())
        .filter(|lead| hypothesis_statement(lead).is_some());
    let existing_is_held = held_lead.is_some();
    let existing = held_lead
        .unwrap_or_else(|| {
            if hypothesis_path.exists() {
                read_json(&hypothesis_path).unwrap_or_else(|_| json!({}))
            } else {
                json!({})
            }
        });
    // A decision about a lead that another director replaced while this lane
    // was deciding is a decision about something no longer on the table.
    //
    // MEASURED ON cycle-a-20260919, 2026-10-02. followup-lab-director-335
    // started at 12:23 on one lead; -334 replaced it at 12:54; -335 finished at
    // 13:03 and "upheld" the lead it had been shown, and this projection wrote it
    // back over -334's choice. The lead flipped twice in five minutes while an
    // engineer ran -334's order. The current lead's selection time is set only
    // when its identity changes, so a lead selected by another lane after this
    // lane started means this lane's view was stale: nothing is projected (and so
    // no order either; see project_lab_director_simulation_orders), and the next
    // director decides on the lead as it is.
    let lane_started_ms = modified_ms(
        &crate::core::support::lane_root(paths, &contract.cycle_id, &contract.lane_id)
            .join("execution-context.json"),
    );
    let current_selected_ms = existing.get("selected_at_epoch_ms").and_then(Value::as_u64);
    let current_selected_by = existing.get("generated_by").and_then(Value::as_str);
    if let (Some(started), Some(selected)) = (lane_started_ms, current_selected_ms) {
        if selected > started && current_selected_by != Some(contract.lane_id.as_str()) {
            crate::chronicle::reporting::append_event(
                &crate::core::support::harness_notices_path(paths, &contract.cycle_id),
                "labdirector_decision_stale",
                json!({
                    "lane_id": contract.lane_id,
                    "lane_started_ms": started,
                    "current_lead_selected_ms": selected,
                    "current_lead_selected_by": current_selected_by,
                    "proposed_statement": statement,
                }),
            )?;
            return Ok(None);
        }
    }
    let dataset_or_accession = lead_string_field(lead, &["dataset_or_accession", "accession"])
        .or_else(|| infer_accession_from_text(&statement))
        .or_else(|| infer_accession_from_value(lead))
        .map(Value::String)
        .or_else(|| {
            let existing_statement = existing
                .get("selected_hypothesis")
                .and_then(hypothesis_statement)
                .or_else(|| hypothesis_statement(&existing))
                .unwrap_or_default();
            let statement_changed = !existing_statement.trim().is_empty()
                && !existing_statement
                    .trim()
                    .eq_ignore_ascii_case(statement.trim());
            if statement_changed {
                None
            } else {
                existing.get("dataset_or_accession").cloned()
            }
        })
        .unwrap_or(Value::Null);
    let existing_statement = existing
        .get("selected_hypothesis")
        .and_then(hypothesis_statement)
        .or_else(|| hypothesis_statement(&existing))
        .unwrap_or_default();
    let statement_changed = !existing_statement.trim().is_empty()
        && !existing_statement
            .trim()
            .eq_ignore_ascii_case(statement.trim());
    let existing_dataset = existing
        .get("identification_strategy")
        .and_then(|item| item.get("dataset_or_accession"))
        .or_else(|| existing.get("dataset_or_accession"))
        .and_then(Value::as_str);
    let projected_dataset = dataset_or_accession.as_str();
    let dataset_changed = existing_dataset
        .zip(projected_dataset)
        .map(|(existing, projected)| !existing.eq_ignore_ascii_case(projected))
        .unwrap_or_else(|| {
            statement_changed && existing_dataset.is_some() && projected_dataset.is_none()
        });
    let existing_family = existing.get("primary_family").and_then(Value::as_str);
    let projected_family = lead_string_field(lead, &["primary_family", "family_root", "family"]);
    let upheld_in_place = decision
        .get("requery_decision")
        .or_else(|| decision.get("decision"))
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("uphold"))
        && existing_dataset
            .zip(projected_dataset)
            .is_some_and(|(existing, projected)| existing.eq_ignore_ascii_case(projected))
        && existing_family
            .zip(projected_family.as_deref())
            .is_some_and(|(existing, projected)| existing.eq_ignore_ascii_case(projected));
    // MEASURED ON cycle-a-20260919, 2026-10-06: five directors
    // upheld the selected forced-disturbance family and its exact simulation
    // path while sharpening the claim wording. Treating every wording change
    // as a replacement held their orders behind evidence only those orders
    // could create, so five downstream Analysts all found no matching bundle.
    let identity_changed = dataset_changed || (statement_changed && !upheld_in_place);
    // The field landscape comes before the lead. See labdirector::field_landscape.
    //
    // MEASURED ON cycle-b-20260918, 2026-09-18/19: the lead was chosen by the
    // most ready instrument and never checked against the field -- 290 papers
    // admitted, none of the manipulation, VLA or locomotion SOTA among them. A
    // first selection and every replacement must now answer an open problem of a
    // valid landscape and cite its papers; an uphold of the lead this projection
    // already wrote is not a selection. A lead an agent wrote into the file itself
    // is not one this projection wrote, so re-stating it is a selection too.
    let existing_written_here = existing_is_held
        || existing.get("projection_source").and_then(Value::as_str)
            == Some("lab_director_lane_result");
    let selecting = existing_statement.trim().is_empty() || identity_changed || !existing_written_here;
    if selecting
        && (crate::labdirector::field_landscape_gate_enabled()
            || crate::labdirector::expert_selection_engaged(paths, &contract.cycle_id))
    {
        // The first lead of the harness's making must be the owner's pick; a
        // later replacement may be any owner-vetted candidate.
        let first_selection = existing_statement.trim().is_empty() || !existing_written_here;
        let reasons = lead_selection_gate_reasons(paths, &contract.cycle_id, lead, first_selection);
        if !reasons.is_empty() {
            let requery_decision = decision
                .get("requery_decision")
                .or_else(|| decision.get("decision"))
                .cloned()
                .unwrap_or(Value::Null);
            crate::labdirector::record_lead_selection_rejection(
                paths,
                &contract.cycle_id,
                &contract.lane_id,
                &statement,
                &requery_decision,
                &reasons,
            )?;
            if existing_written_here && !existing_statement.trim().is_empty() {
                // Same shape as the lead hold below: the refused replacement is
                // kept where the next director reads it, and the current lead is
                // written back over whatever an agent left in the file.
                let mut kept = existing.clone();
                let mut deferred: Vec<Value> = kept
                    .get("replacement_deferred")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                deferred.push(json!({
                    "lane_id": contract.lane_id,
                    "deferred_at": now_iso(),
                    "requery_decision": requery_decision,
                    "statement": statement,
                    "rationale": decision.get("rationale").cloned().unwrap_or(Value::Null),
                    "reason": "field_landscape_gate",
                    "landscape_gate_reasons": reasons,
                    "released_when": "the replacement names an open_problem_id of a valid field landscape and cites enough of its papers, one of them frontier work",
                }));
                let skip = deferred.len().saturating_sub(DEFERRED_REPLACEMENTS_KEPT);
                kept["replacement_deferred"] = Value::Array(deferred.into_iter().skip(skip).collect());
                write_json(&hypothesis_path, &kept)?;
                write_lead_hold_record(paths, contract, &kept)?;
                return Ok(Some(hypothesis_path));
            }
            // No lead of this projection's making: nothing is selected. A lead file
            // the director wrote itself with this very statement is set aside, so
            // the refused selection does not take effect through the back door.
            if hypothesis_path.exists()
                && read_json(&hypothesis_path)
                    .ok()
                    .and_then(|file| {
                        file.get("selected_hypothesis")
                            .and_then(hypothesis_statement)
                            .or_else(|| hypothesis_statement(&file))
                    })
                    .is_some_and(|written| written.trim().eq_ignore_ascii_case(statement.trim()))
            {
                fs::rename(&hypothesis_path, lead_set_aside_path(paths, &contract.cycle_id))?;
            }
            return Ok(None);
        }
    }
    let now_ms = epoch_ms(SystemTime::now());
    let mut hold_released_by: Option<String> = None;
    if identity_changed && !existing_statement.trim().is_empty() {
        let (release, hold_status) =
            lead_hold_release(paths, &contract.cycle_id, &existing, &hypothesis_path);
        match release {
            Some(reason) => hold_released_by = Some(reason),
            None => {
                let mut kept = existing.clone();
                let mut deferred: Vec<Value> = kept
                    .get("replacement_deferred")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                deferred.push(json!({
                    "lane_id": contract.lane_id,
                    "deferred_at": now_iso(),
                    "requery_decision": decision.get("requery_decision").or_else(|| decision.get("decision")).cloned().unwrap_or(Value::Null),
                    "statement": statement,
                    "rationale": decision.get("rationale").cloned().unwrap_or(Value::Null),
                    "reason": "the current lead has no gate-reviewed evidence of its own yet",
                    "released_when": "a runner executes a handoff written for the current lead and a gatekeeper completes after it, that evidence validly falsifies the lead, or the lead has held the configured number of gate rounds",
                    "hold": hold_status,
                }));
                let skip = deferred.len().saturating_sub(DEFERRED_REPLACEMENTS_KEPT);
                kept["replacement_deferred"] = Value::Array(deferred.into_iter().skip(skip).collect());
                for key in ["selected_at_epoch_ms", "selected_at_gate_round"] {
                    if kept.get(key).is_none_or(Value::is_null) {
                        kept[key] = hold_status.get(key).cloned().unwrap_or(Value::Null);
                    }
                }
                // Writes the held lead back over whatever an agent left in the
                // file; the archive pass keeps that version too.
                write_json(&hypothesis_path, &kept)?;
                write_lead_hold_record(paths, contract, &kept)?;
                return Ok(Some(hypothesis_path));
            }
        }
    }
    // When the lead itself changes, its hold starts now; an uphold keeps the date
    // the lead was chosen, not the date it was last confirmed.
    let (selected_at_epoch_ms, selected_at_gate_round, replacement_deferred) = if identity_changed {
        (
            json!(now_ms),
            json!(gate_rounds_at(paths, &contract.cycle_id, now_ms).1),
            json!([]),
        )
    } else {
        (
            existing
                .get("selected_at_epoch_ms")
                .cloned()
                .filter(|value| !value.is_null())
                .unwrap_or_else(|| json!(modified_ms(&hypothesis_path).unwrap_or(now_ms))),
            existing.get("selected_at_gate_round").cloned().unwrap_or(Value::Null),
            existing.get("replacement_deferred").cloned().unwrap_or_else(|| json!([])),
        )
    };
    let materialized_dataset =
        materialized_dataset_for_lead(&existing, lead, &dataset_or_accession);
    let mut identification_strategy = if dataset_changed {
        json!({})
    } else {
        existing
            .get("identification_strategy")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    };
    let has_materialized_dataset = !materialized_dataset.is_null();
    if has_materialized_dataset {
        identification_strategy["materialized_dataset"] = materialized_dataset;
    } else if let Some(strategy) = identification_strategy.as_object_mut() {
        strategy.remove("materialized_dataset");
    }
    if !dataset_or_accession.is_null() {
        identification_strategy["dataset_or_accession"] = dataset_or_accession.clone();
    }
    identification_strategy["restart_frame"] = json!("lab_director_selected_hypothesis");

    let lead_validation_status = lead_string_field(lead, &["validation_data_status"]);
    let validation_data_status = if has_materialized_dataset {
        lead_validation_status
            .map(Value::String)
            .unwrap_or_else(|| json!("materialized"))
    } else {
        lead_validation_status
            .filter(|status| !status.eq_ignore_ascii_case("materialized"))
            .map(Value::String)
            .unwrap_or_else(|| json!("needs_materialization"))
    };
    identification_strategy["validation_data_status"] = validation_data_status.clone();

    // An uphold keeps the claim the analysis contract is made of.
    //
    // The contract (src/policy/analysis_contract.js) is the lead's statement,
    // estimands, falsification conditions, rival mechanisms and scope, hashed;
    // a runner refuses a handoff written against any other. MEASURED ON
    // cycle-a-20260919, 2026-10-15: four directors in a row upheld the
    // paired-threshold lead, each re-wording it ("{0.10, ..., 0.16}" became
    // "0.10 through 0.16"). Each wording was a new contract, every executable
    // handoff went stale, the registered operational spec dropped off, and the
    // runners the directors asked for failed preflight one after another with
    // analysis_contract_mismatch. An uphold is the same lead: its canonical
    // fields stay as they were, and the director's wording is kept beside them,
    // where the next director reads it. Changing the claim is a replacement.
    let mut lead_value = lead.clone();
    let mut upheld_restatements = existing
        .get("upheld_restatements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let canonical = existing.get("selected_hypothesis").filter(|value| value.is_object());
    let statement = match canonical {
        Some(canonical) if upheld_in_place && !identity_changed && statement_changed => {
            upheld_restatements.push(json!({
                "lane_id": contract.lane_id,
                "restated_at": now_iso(),
                "statement": statement,
                "identification_strategy": lead.get("identification_strategy").cloned().unwrap_or(Value::Null),
                "falsification_conditions": lead.get("falsification_conditions").cloned().unwrap_or(Value::Null),
                "rival_mechanisms": lead.get("rival_mechanisms").cloned().unwrap_or(Value::Null),
            }));
            for field in [
                "statement",
                "hypothesis_statement",
                "identification_strategy",
                "falsification_conditions",
                "rival_mechanisms",
                "claim_scope_narrowed_from",
            ] {
                match canonical.get(field) {
                    Some(value) => lead_value[field] = value.clone(),
                    None => {
                        if let Some(object) = lead_value.as_object_mut() {
                            object.remove(field);
                        }
                    }
                }
            }
            existing_statement.clone()
        }
        _ => statement,
    };
    let skip = upheld_restatements.len().saturating_sub(DEFERRED_REPLACEMENTS_KEPT);
    let upheld_restatements: Vec<Value> = if identity_changed {
        Vec::new()
    } else {
        upheld_restatements.into_iter().skip(skip).collect()
    };
    let lead = &lead_value;

    let hypothesis_id = if identity_changed {
        lead.get("hypothesis_id").cloned().unwrap_or(Value::Null)
    } else {
        lead.get("hypothesis_id")
            .or_else(|| existing.get("hypothesis_id"))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let projected = json!({
        "status": "selected",
        "statement": statement,
        "primary_family": infer_primary_family(lead, &existing, !dataset_changed),
        "hypothesis_id": hypothesis_id,
        "dataset_or_accession": dataset_or_accession,
        "validation_data_status": validation_data_status,
        "selected_hypothesis": lead,
        "identification_strategy": identification_strategy,
        "same_dataset_reference_papers": lead.get("same_dataset_reference_papers").cloned().unwrap_or_else(|| json!([])),
        "reference_methods_baseline": lead.get("reference_methods_baseline").cloned().unwrap_or(Value::Null),
        "why_selected": lead.get("why_selected").or_else(|| lead.get("why_better_than_reference_baseline")).cloned().unwrap_or(Value::Null),
        "lab_director_decision": {
            "lane_id": contract.lane_id,
            "requery_decision": decision.get("requery_decision").or_else(|| decision.get("decision")).cloned().unwrap_or(Value::Null),
            "summary": decision.get("summary").cloned().unwrap_or(Value::Null),
            "rationale": decision.get("rationale").cloned().unwrap_or(Value::Null),
            "validation_changes": decision.get("validation_changes").cloned().unwrap_or_else(|| json!([])),
            "next_actions": decision.get("next_actions").cloned().unwrap_or_else(|| json!([])),
        },
        "updated_at": now_iso(),
        "generated_by": contract.lane_id,
        "projection_source": "lab_director_lane_result",
        "selected_at_epoch_ms": selected_at_epoch_ms,
        "selected_at_gate_round": selected_at_gate_round,
        "lead_hold_released_by": if identity_changed {
            hold_released_by.map(Value::String).unwrap_or_else(|| json!("first_selection"))
        } else {
            existing.get("lead_hold_released_by").cloned().unwrap_or(Value::Null)
        },
        "replacement_deferred": replacement_deferred,
        "upheld_restatements": upheld_restatements,
    });
    write_json(&hypothesis_path, &projected)?;
    write_lead_hold_record(paths, contract, &projected)?;
    Ok(Some(hypothesis_path))
}

/// An uphold that answers none of the gate's objections, recorded for the owner
/// and the supervisor (harness notices). Not refused: the decision stands, the
/// omission is what the record says. See rebuttal_targets.
fn note_uphold_without_rebuttal(paths: &AppPaths, contract: &LaneContract, decision: &Value) {
    if decision.get("requery_decision").and_then(Value::as_str) != Some("uphold") {
        return;
    }
    let role_plan = read_json(&crate::core::support::lane_role_plan_path(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
    ))
    .unwrap_or(Value::Null);
    let Some(targets) = role_plan.pointer("/planner_metadata/rebuttal_targets") else {
        return;
    };
    let answered = decision
        .get("rebuttal_experiments")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("experiment")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            })
        });
    if answered {
        return;
    }
    let _ = crate::chronicle::reporting::append_event(
        &crate::core::support::harness_notices_path(paths, &contract.cycle_id),
        "director_upheld_without_rebuttal",
        json!({
            "lane_id": contract.lane_id,
            "binding_rubric": targets.get("binding_rubric").cloned().unwrap_or(Value::Null),
            "objections": targets.get("objections").cloned().unwrap_or(Value::Null),
        }),
    );
}
