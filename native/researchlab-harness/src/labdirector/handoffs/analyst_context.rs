#![allow(unused_imports)]
use super::*;

pub(crate) fn role_plan_dataset_root(planner_metadata: &Value) -> Value {
    planner_metadata
        .get("dataset_root")
        .cloned()
        .unwrap_or(Value::Null)
}

pub(crate) fn latest_analyst_literature_signal(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let mut candidates = Vec::new();
    let completed_analyst_lanes = cached_completed_lanes_for_role(paths, cycle_id, "analyst")?;
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_analyst(&lane_id) {
            continue;
        }
        let result_path = lane_dir.join("result.json");
        if !result_path.exists() {
            continue;
        }
        if let Some(completed_lanes) = completed_analyst_lanes.as_ref() {
            if !completed_lanes.contains(&lane_id) {
                continue;
            }
        } else {
            let run_state_path = lane_dir.join("run-state.json");
            let final_status_path = lane_dir.join("final-status.json");
            if !run_state_path.exists() || !final_status_path.exists() {
                continue;
            }
            let run_state = read_json(&run_state_path)?;
            let Some(final_status) = read_lane_final_status(&final_status_path)? else {
                continue;
            };
            if final_status.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            if run_state.get("role").and_then(Value::as_str) != Some("analyst") {
                continue;
            }
        }
        let result = read_lane_result_json(&result_path)?;
        if result.get("driver").and_then(Value::as_str) != Some("literature-search-driver") {
            continue;
        }
        let modified_at = fs::metadata(&result_path)
            .and_then(|meta| meta.modified())
            .ok();
        candidates.push((modified_at, result));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates.pop().map(|(_, result)| result))
}

pub(crate) fn push_handoff_candidate_with_time(
    candidates: &mut Vec<(Option<SystemTime>, PathBuf)>,
    seen_paths: &mut HashSet<String>,
    handoff_path: PathBuf,
    candidate_time: Option<SystemTime>,
) {
    let key = handoff_path.to_string_lossy().to_string();
    if !seen_paths.insert(key) || !handoff_path.exists() {
        return;
    }
    candidates.push((candidate_time, handoff_path));
}

pub(crate) fn lane_status_time(lane: &Value) -> Option<SystemTime> {
    lane.get("completed_at")
        .and_then(Value::as_str)
        .or_else(|| lane.get("updated_at").and_then(Value::as_str))
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| SystemTime::from(parsed.with_timezone(&Utc)))
}

pub(crate) fn lane_dir_time(lane_dir: &Path) -> Option<SystemTime> {
    for file_name in ["final-status.json", "run-state.json"] {
        let path = lane_dir.join(file_name);
        let Ok(value) = read_json(&path) else {
            continue;
        };
        if let Some(parsed) = lane_status_time(&value) {
            return Some(parsed);
        }
    }
    None
}

pub(crate) fn lane_numeric_suffix(lane_id: &str) -> u64 {
    lane_id
        .rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<u64>().ok())
        .unwrap_or(0)
}

/// The analyst lane number a handoff path belongs to, or 0 when it names none.
fn handoff_path_lane_number(path: &Path) -> u64 {
    path.to_string_lossy()
        .split(['/', '\\'])
        .filter(|part| part.contains("analyst"))
        .map(lane_numeric_suffix)
        .max()
        .unwrap_or(0)
}

/// Oldest-first order for handoff candidates: by time, then by lane NUMBER.
///
/// The tiebreak used to be the path text. MEASURED ON cycle-g-v91, 2026-09-14:
/// the cached lane index carries no completion time, so every candidate tied on
/// time and the path decided -- and "followup-analyst-95" sorts after
/// "followup-analyst-103" as text. Once the cycle passed analyst 99, no newer
/// handoff could ever be selected: analysts 100-103 each completed an executable
/// handoff, the harness kept offering analyst-95's already-consumed one, and no
/// runner lane was created for an hour.
pub(crate) fn handoff_candidate_order(
    a: &(Option<SystemTime>, PathBuf),
    b: &(Option<SystemTime>, PathBuf),
) -> std::cmp::Ordering {
    a.0.cmp(&b.0)
        .then_with(|| handoff_path_lane_number(&a.1).cmp(&handoff_path_lane_number(&b.1)))
        .then_with(|| a.1.cmp(&b.1))
}

#[cfg(test)]
mod handoff_candidate_order_tests {
    use super::*;

    fn candidate(lane: &str, time: Option<u64>) -> (Option<SystemTime>, PathBuf) {
        (
            time.map(|secs| SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs)),
            PathBuf::from(format!("/runtime/lanes/cycle/{lane}/handoff-validation-plan.json")),
        )
    }

    #[test]
    fn without_times_a_higher_lane_number_is_newer_whatever_its_text_order() {
        let mut candidates = vec![
            candidate("followup-analyst-103", None),
            candidate("followup-analyst-95", None),
            candidate("followup-analyst-99", None),
            candidate("followup-analyst-100", None),
        ];
        candidates.sort_by(handoff_candidate_order);
        let newest = candidates.pop().unwrap();
        assert!(newest.1.to_string_lossy().contains("followup-analyst-103"), "{newest:?}");
    }

    #[test]
    fn a_recorded_time_still_decides_before_the_lane_number() {
        let mut candidates = vec![
            candidate("followup-analyst-103", Some(100)),
            candidate("followup-analyst-95", Some(200)),
        ];
        candidates.sort_by(handoff_candidate_order);
        assert!(candidates.pop().unwrap().1.to_string_lossy().contains("followup-analyst-95"));
    }
}

pub(crate) fn analyst_signal_lane_numeric_suffix(signal: &Value) -> u64 {
    signal
        .get("path")
        .and_then(Value::as_str)
        .map(|path| {
            path.split(['/', '\\'])
                .filter(|part| part.contains("analyst"))
                .map(lane_numeric_suffix)
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

pub(crate) fn newer_analyst_handoff_signal(
    left: Option<Value>,
    right: Option<Value>,
) -> Option<Value> {
    match (left, right) {
        (Some(left), Some(right)) => {
            if analyst_signal_lane_numeric_suffix(&right)
                > analyst_signal_lane_numeric_suffix(&left)
            {
                Some(right)
            } else {
                Some(left)
            }
        }
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub(crate) fn collect_note_handoff_candidate(
    candidates: &mut Vec<(Option<SystemTime>, PathBuf)>,
    seen_paths: &mut HashSet<String>,
    item: &Value,
) {
    let Some(raw_path) = item.get("handoff_path").and_then(Value::as_str) else {
        return;
    };
    if raw_path.trim().is_empty() {
        return;
    }
    let key = raw_path.to_string();
    if !seen_paths.insert(key) {
        return;
    }
    let updated_at = item
        .get("updated_at")
        .and_then(Value::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| SystemTime::from(parsed.with_timezone(&Utc)));
    candidates.push((updated_at, PathBuf::from(raw_path)));
}

/// A handoff whose every check declares it does not test the current lead.
///
/// `_render_quality_checks_and_blueprints` emits one fixed adaptive-vs-uniform
/// experiment regardless of the hypothesis and stamps the lead's id onto it, so
/// a generic baseline cannot be told from a real design by name. Since 88b4b52
/// those checks carry `hypothesis_bound: false`, which is what this reads. A
/// handoff that says nothing counts as bound, so anything predating the marker
/// behaves exactly as before.
///
/// WHY IT MATTERS. cycle-g-v81 authored bp_tail_proxy_stale_reuse_v2 - a real
/// test of the lead - at 06:27:43, and two generic template handoffs landed at
/// 06:29:06 and 06:29:18. Selection is by recency, so 95 seconds buried the only
/// design that tested the hypothesis, and the gate scored technical_quality=12
/// on "Zero aligned validation results are available".
pub(crate) fn analyst_handoff_is_generic_baseline(payload: &Value) -> bool {
    let checks = match payload.get("handoff_checks").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items,
        _ => return false,
    };
    checks
        .iter()
        .all(|check| check.get("hypothesis_bound").and_then(Value::as_bool) == Some(false))
}

// Did this handoff come from a lane that was designing an experiment the
// programme ADOPTED? The lane's own role plan carries `author_requested_experiment`
// as its action type, which `adoptedExperimentFollowupActions` sets when an
// adopted request becomes analyst work. Reading that is a structural link: no
// claim text is compared, so rewording cannot break it.
pub(crate) fn analyst_handoff_is_adopted_experiment(handoff_path: &Path) -> bool {
    let Some(lane_dir) = handoff_path.parent() else {
        return false;
    };
    let role_plan_path = lane_dir.join("role-plan.json");
    let Ok(role_plan) = read_json(&role_plan_path) else {
        return false;
    };
    role_plan.get("action_type").and_then(Value::as_str) == Some("author_requested_experiment")
}

pub(crate) fn latest_analyst_handoff_signal_from_notes(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let notes_path = state_root(paths).join(format!("{cycle_id}-analyst-research-notes.json"));
    if !notes_path.exists() {
        return Ok(None);
    }
    let notes = read_json(&notes_path)?;
    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();
    if let Some(item) = notes.get("latest_analyst_memo") {
        collect_note_handoff_candidate(&mut candidates, &mut seen_paths, item);
    }
    if let Some(items) = notes
        .get("recent_analyst_memos_index")
        .and_then(Value::as_array)
    {
        for item in items.iter().take(12) {
            collect_note_handoff_candidate(&mut candidates, &mut seen_paths, item);
        }
    }
    // Newest first, with the same lane-number tiebreak as the other scans.
    candidates.sort_by(|a, b| handoff_candidate_order(b, a));
    let current_accessions = current_hypothesis_geo_accessions(paths, cycle_id);
    let mut generic_fallback: Option<Value> = None;
    // An experiment the programme committed to outranks one that merely arrived
    // later. Newest-first order still decides among adopted experiments; it just
    // no longer lets an unrelated newer handoff displace all of them.
    for (_, handoff_path) in &candidates {
        if !handoff_path.exists() || !analyst_handoff_is_adopted_experiment(handoff_path) {
            continue;
        }
        let payload = read_json(handoff_path)?;
        if analyst_handoff_targets_current_hypothesis(&payload, &current_accessions)
            && !analyst_handoff_is_generic_baseline(&payload)
        {
            return Ok(Some(json!({
                "path": handoff_path.display().to_string(),
                "payload": payload,
                "selected_because": "adopted experiment outranks handoff recency",
            })));
        }
    }
    for (_, handoff_path) in candidates {
        if !handoff_path.exists() {
            continue;
        }
        let payload = read_json_cached(&handoff_path)?;
        if analyst_handoff_targets_current_hypothesis(&payload, &current_accessions) {
            // Skip what cannot be run and keep looking. The caller used to apply
            // this test AFTER selection and return empty-handed, so one schema
            // gate at the front of the queue stopped every executable handoff
            // behind it -- the plan carried zero lab-runner actions while an
            // adopted experiment sat ready.
            if !analyst_handoff_is_executable(&payload) {
                continue;
            }
            // Remember a generic baseline, do not return it yet: a real design
            // authored EARLIER must still win over a newer template.
            if analyst_handoff_is_generic_baseline(&payload) {
                if generic_fallback.is_none() {
                    generic_fallback = Some(json!({
                        "path": handoff_path.display().to_string(),
                        "payload": payload,
                    }));
                }
                continue;
            }
            return Ok(Some(json!({
                "path": handoff_path.display().to_string(),
                "payload": payload,
            })));
        }
    }
    Ok(generic_fallback)
}

pub(crate) fn latest_analyst_handoff_signal_from_large_state(
    paths: &AppPaths,
    cycle_id: &str,
    artifacts_dir: &Path,
    lane_statuses: Vec<Value>,
) -> Result<Option<Value>> {
    let mut analyst_lanes = lane_statuses
        .into_iter()
        .filter_map(|lane| {
            if lane.get("status").and_then(Value::as_str) != Some("completed") {
                return None;
            }
            let lane_id = lane.get("lane_id").and_then(Value::as_str)?.to_string();
            let role_matches = lane.get("role").and_then(Value::as_str) == Some("analyst")
                || lane_id_looks_like_analyst(&lane_id);
            if !role_matches {
                return None;
            }
            // MEASURED ON cycle-a-20260919, 2026-10-03: the large
            // cycle index omitted completed_at. Analyst-299 finished at 09:08
            // with the first executable post-bundle handoff, but the suffix
            // tiebreak selected older analyst-301 (finished 07:12), whose
            // handoff already had a runner. Recover the completion time from
            // the lane's durable final status before using creation order.
            let completed_at = lane_status_time(&lane)
                .or_else(|| lane_dir_time(&lane_root(paths, cycle_id, &lane_id)));
            Some((completed_at, lane_id))
        })
        .collect::<Vec<_>>();
    analyst_lanes.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| lane_numeric_suffix(&b.1).cmp(&lane_numeric_suffix(&a.1)))
            .then_with(|| b.1.cmp(&a.1))
    });
    let scan_limit = env::var("RESEARCHLAB_ANALYST_HANDOFF_SCAN_LIMIT")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(24);

    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();
    for (lane_time, lane_id) in analyst_lanes.into_iter().take(scan_limit) {
        let lane_dir = lane_root(paths, cycle_id, &lane_id);
        let role_plan_path = lane_dir.join("role-plan.json");
        let role_fields = read_role_plan_index_fields(&role_plan_path)?;
        if role_fields
            .as_ref()
            .and_then(|fields| fields.action_type.as_deref())
            == Some("runner_result_interpretation_followup")
            && role_plan_path.exists()
            && interpretation_handoff_is_resolved_report(&read_json(&role_plan_path)?)
            && !handoff_carries_execution_seal(&lane_dir.join("handoff-validation-plan.json"))
        {
            continue;
        }
        push_handoff_candidate_with_time(
            &mut candidates,
            &mut seen_paths,
            lane_dir.join("handoff-validation-plan.json"),
            lane_time,
        );
        push_handoff_candidate_with_time(
            &mut candidates,
            &mut seen_paths,
            artifacts_dir
                .join(&lane_id)
                .join("handoff-validation-plan.json"),
            lane_time,
        );
    }

    candidates.sort_by(handoff_candidate_order);
    let current_accessions = current_hypothesis_geo_accessions(paths, cycle_id);
    let mut generic_fallback: Option<Value> = None;
    while let Some((_, handoff_path)) = candidates.pop() {
        let payload = read_json_cached(&handoff_path)?;
        if analyst_handoff_targets_current_hypothesis(&payload, &current_accessions) {
            // Skip what cannot be run and keep looking. The caller used to apply
            // this test AFTER selection and return empty-handed, so one schema
            // gate at the front of the queue stopped every executable handoff
            // behind it -- the plan carried zero lab-runner actions while an
            // adopted experiment sat ready.
            if !analyst_handoff_is_executable(&payload) {
                continue;
            }
            // Remember a generic baseline, do not return it yet: a real design
            // authored EARLIER must still win over a newer template.
            if analyst_handoff_is_generic_baseline(&payload) {
                if generic_fallback.is_none() {
                    generic_fallback = Some(json!({
                        "path": handoff_path.display().to_string(),
                        "payload": payload,
                    }));
                }
                continue;
            }
            return Ok(Some(json!({
                "path": handoff_path.display().to_string(),
                "payload": payload,
            })));
        }
    }
    Ok(generic_fallback)
}

/// Whether a handoff names what it executes (`handoff_seal.execution_id`).
///
/// The resolved-report rule below guesses that an interpretation lane only
/// reports, from its source runner having passed cleanly. A sealed handoff
/// needs no guess: it is identified by its execution, and running an execution
/// that a runner already served is refused by
/// runtime::handoff_seal::execution_served_by. So the guess is kept for
/// unsealed handoffs only.
///
/// MEASURED ON cycle-a-20260919, 2026-10-15: followup-analyst-843
/// interpreted followup-runner-322, which had passed 2 of 2 blueprints, and
/// issued a repaired executable handoff for the current lead -- a different
/// execution (420b4053...) from anything run. The guess filed it as a report,
/// the picker fell back to analyst-842's older handoff, and four directors in a
/// row asked for 843's to be run.
pub(crate) fn handoff_carries_execution_seal(path: &Path) -> bool {
    read_json(path)
        .ok()
        .and_then(|handoff| {
            handoff
                .pointer("/handoff_seal/execution_id")
                .and_then(Value::as_str)
                .map(|id| !id.trim().is_empty())
        })
        .unwrap_or(false)
}

pub(crate) fn interpretation_handoff_is_resolved_report(role_plan: &Value) -> bool {
    let action_type = role_plan
        .get("action_type")
        .or_else(|| {
            role_plan
                .get("action")
                .and_then(|value| value.get("action_type"))
        })
        .and_then(Value::as_str)
        .unwrap_or("");
    if action_type != "runner_result_interpretation_followup" {
        return false;
    }
    let validation_results = role_plan
        .get("planner_metadata")
        .and_then(|value| value.get("validation_results"))
        .or_else(|| {
            role_plan
                .get("analysis_request")
                .and_then(|value| value.get("runner_context"))
        })
        .unwrap_or(&Value::Null);
    let blueprints_failed = validation_results
        .get("blueprints_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let analyst_standard_satisfied = validation_results
        .get("analyst_quality_standard")
        .or_else(|| {
            validation_results
                .get("validation_summary")
                .and_then(|value| value.get("analyst_quality_standard"))
        })
        .and_then(|value| value.get("satisfied"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let all_checks_resolved = validation_results
        .get("handoff_check_resolutions")
        .or_else(|| {
            validation_results
                .get("validation_summary")
                .and_then(|value| value.get("handoff_check_resolutions"))
        })
        .and_then(Value::as_array)
        .map(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    item.get("resolved")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
        })
        .unwrap_or(false);
    analyst_standard_satisfied && blueprints_failed == 0 && all_checks_resolved
}

pub(crate) fn latest_analyst_handoff_signal(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Value>> {
    let artifacts_dir = paths
        .runtime_root
        .join("artifacts")
        .join("stats")
        .join(cycle_id);
    let notes_signal = latest_analyst_handoff_signal_from_notes(paths, cycle_id)?;
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        let indexed_signal = latest_analyst_handoff_signal_from_large_state(
            paths,
            cycle_id,
            &artifacts_dir,
            lane_statuses,
        )?;
        return Ok(newer_analyst_handoff_signal(notes_signal, indexed_signal));
    }
    let lane_dirs = lane_dirs_from_contract_index(paths, cycle_id)?;
    if lane_dirs.is_empty() && !artifacts_dir.exists() {
        return Ok(notes_signal);
    }
    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();
    let completed_analyst_lanes = cached_completed_lanes_for_role(paths, cycle_id, "analyst")?;
    let have_indexed_lanes = !lane_dirs.is_empty();
    if have_indexed_lanes {
        for (lane_id, lane_dir) in lane_dirs {
            if !lane_id_looks_like_analyst(&lane_id) {
                continue;
            }
            if let Some(completed_lanes) = completed_analyst_lanes.as_ref() {
                if !completed_lanes.contains(&lane_id) {
                    continue;
                }
            } else {
                let run_state_path = lane_dir.join("run-state.json");
                let final_status_path = lane_dir.join("final-status.json");
                if !run_state_path.exists() || !final_status_path.exists() {
                    continue;
                }
                let run_state = read_json(&run_state_path)?;
                let Some(final_status) = read_lane_final_status(&final_status_path)? else {
                    continue;
                };
                if final_status.get("status").and_then(Value::as_str) != Some("completed") {
                    continue;
                }
                if run_state.get("role").and_then(Value::as_str) != Some("analyst") {
                    continue;
                }
            }
            let role_plan_path = lane_dir.join("role-plan.json");
            if role_plan_path.exists()
                && interpretation_handoff_is_resolved_report(&read_json(&role_plan_path)?)
                && !handoff_carries_execution_seal(&lane_dir.join("handoff-validation-plan.json"))
            {
                continue;
            }
            let lane_time = lane_dir_time(&lane_dir);
            push_handoff_candidate_with_time(
                &mut candidates,
                &mut seen_paths,
                lane_dir.join("handoff-validation-plan.json"),
                lane_time,
            );
            push_handoff_candidate_with_time(
                &mut candidates,
                &mut seen_paths,
                artifacts_dir
                    .join(&lane_id)
                    .join("handoff-validation-plan.json"),
                lane_time,
            );
        }
    }
    if !have_indexed_lanes && artifacts_dir.exists() {
        for entry in read_dir(&artifacts_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let artifact_dir = entry.path();
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id_looks_like_analyst(&lane_id) {
                continue;
            }
            let lane_dir = paths
                .runtime_root
                .join("lanes")
                .join(cycle_id)
                .join(&lane_id);
            if let Some(completed_lanes) = completed_analyst_lanes.as_ref() {
                if !completed_lanes.contains(&lane_id) {
                    continue;
                }
            } else {
                let lane_final_status = lane_dir.join("final-status.json");
                if !lane_final_status.exists() {
                    continue;
                }
                let Some(final_status) = read_lane_final_status(&lane_final_status)? else {
                    continue;
                };
                if final_status.get("status").and_then(Value::as_str) != Some("completed") {
                    continue;
                }
            }
            let role_plan_path = lane_dir.join("role-plan.json");
            if role_plan_path.exists()
                && interpretation_handoff_is_resolved_report(&read_json(&role_plan_path)?)
                && !handoff_carries_execution_seal(&artifact_dir.join("handoff-validation-plan.json"))
            {
                continue;
            }
            let lane_time = lane_dir_time(&lane_dir);
            push_handoff_candidate_with_time(
                &mut candidates,
                &mut seen_paths,
                artifact_dir.join("handoff-validation-plan.json"),
                lane_time,
            );
        }
    }
    candidates.sort_by(handoff_candidate_order);
    let current_accessions = current_hypothesis_geo_accessions(paths, cycle_id);
    let mut generic_fallback: Option<Value> = None;
    while let Some((_, handoff_path)) = candidates.pop() {
        let payload = read_json_cached(&handoff_path)?;
        if analyst_handoff_targets_current_hypothesis(&payload, &current_accessions) {
            // Skip what cannot be run and keep looking. The caller used to apply
            // this test AFTER selection and return empty-handed, so one schema
            // gate at the front of the queue stopped every executable handoff
            // behind it -- the plan carried zero lab-runner actions while an
            // adopted experiment sat ready.
            if !analyst_handoff_is_executable(&payload) {
                continue;
            }
            // Remember a generic baseline, do not return it yet: a real design
            // authored EARLIER must still win over a newer template.
            if analyst_handoff_is_generic_baseline(&payload) {
                if generic_fallback.is_none() {
                    generic_fallback = Some(json!({
                        "path": handoff_path.display().to_string(),
                        "payload": payload,
                    }));
                }
                continue;
            }
            let indexed_signal = Some(json!({
                "path": handoff_path.display().to_string(),
                "payload": payload,
            }));
            return Ok(newer_analyst_handoff_signal(notes_signal, indexed_signal));
        }
    }
    Ok(newer_analyst_handoff_signal(notes_signal, generic_fallback))
}

// Can this check actually be run, or does it only record that it cannot?
//
// Both conditions are read from what the check records about ITSELF, so nothing
// is inferred: a check naming no exposure has no comparison to make, and a
// dataset the analyst marked as not materialized has no rows to read. Deliberately
// no size threshold -- a byte count is a guess dressed as a rule.
fn handoff_check_can_run(check: &Value) -> bool {
    let has_exposure = check
        .get("exposures")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| {
            item.as_str().map(|text| !text.trim().is_empty()).unwrap_or(false)
        }))
        .unwrap_or(false);
    let dataset = check
        .get("dataset")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let dataset_absent = dataset.contains("not materialized")
        || dataset.contains("not_materialized")
        || dataset.trim().is_empty();
    has_exposure && !dataset_absent
}

pub(crate) fn analyst_handoff_is_executable(payload: &Value) -> bool {
    if payload.get("status").and_then(Value::as_str) == Some("deferred") {
        return false;
    }
    // MEASURED ON cycle-a-20260919, 2026-09-20: an analyst handoff
    // explicitly marked not ready was dispatched ten times and every runner
    // failed because the episode CSV that its blueprint required did not exist.
    if payload
        .pointer("/analysis_design_memo/final_handoff_readiness/ready_for_runner")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    // A 91-byte stub used to pass the same gate as a 20 KB validation, because
    // the only question asked was whether the code field was non-empty.
    //
    // Non-empty is still not enough: on cycle-g-v91 followup-analyst-98's code
    // field held one comment line pointing at a source file stored elsewhere,
    // and followup-runner-110 "completed" it in 0.15 seconds having measured
    // nothing. Code with no line that is not a comment is not code.
    let has_check = payload
        .get("handoff_checks")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(handoff_check_can_run))
        .unwrap_or(false);
    let has_code_blueprint = payload
        .get("validation_code_blueprints")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("code")
                    .and_then(Value::as_str)
                    .map(blueprint_code_has_a_statement)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    has_check && has_code_blueprint
}

/// True when blueprint code has at least one line that is not blank or a comment.
fn blueprint_code_has_a_statement(code: &str) -> bool {
    code.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#')
    })
}

#[cfg(test)]
mod blueprint_code_statement_tests {
    use super::*;

    fn handoff(code: &str) -> Value {
        json!({
            "handoff_checks": [{ "check_id": "CHK-01", "exposures": ["x"], "dataset": "a table" }],
            "validation_code_blueprints": [{ "check_id": "CHK-01", "code": code }],
        })
    }

    #[test]
    fn a_comment_pointing_at_a_file_is_not_an_executable_handoff() {
        assert!(!analyst_handoff_is_executable(&handoff(
            "# Complete reviewed source is stored at /elsewhere/analysis_v3.py\n"
        )));
        assert!(!analyst_handoff_is_executable(&handoff("   \n# only notes\n\n")));
    }

    #[test]
    fn code_with_a_statement_is_still_executable() {
        assert!(analyst_handoff_is_executable(&handoff("# header\nprint('measure')\n")));
    }

    #[test]
    fn an_explicitly_not_ready_handoff_is_not_executable() {
        // MEASURED ON cycle-a-20260919, 2026-09-20: the handoff named
        // a procedural dataset that had not been materialized, marked itself
        // not ready, and its ten runner executions failed with no CSV dataset.
        let mut payload = handoff("print('requires materialized CSV')\n");
        payload["analysis_design_memo"] = json!({
            "final_handoff_readiness": {
                "ready_for_runner": false,
                "blocking_reason": "analysis_design_memo missing from analyst output"
            }
        });

        assert!(!analyst_handoff_is_executable(&payload));
    }
}

pub(crate) fn scenario_labels_from_value(value: &Value) -> Vec<String> {
    value
        .get("hypothesis_scenarios")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            item.get("label")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect()
}

pub(crate) fn discovered_queries_from_value(value: &Value) -> Vec<String> {
    value
        .get("discovered_queries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(ToString::to_string))
        .collect()
}

pub(crate) fn focus_families_for_runner(
    scenario_labels: &[String],
    action_type: &str,
) -> Vec<Value> {
    let mut families = Vec::<String>::new();
    let has_label = |needle: &str| scenario_labels.iter().any(|item| item == needle);
    if has_label("subgroup-moderator") {
        families.extend([
            "subgroup-stratification".to_string(),
            "subgroup-moderator".to_string(),
            "leave-one-group-out".to_string(),
        ]);
    }
    if has_label("equity-mechanism") {
        families.extend([
            "partition-and-threshold".to_string(),
            "subgroup-moderator".to_string(),
        ]);
    }
    if has_label("measurement-quality") {
        families.extend([
            "adjusted-signal".to_string(),
            "leave-one-group-out".to_string(),
        ]);
    }
    if has_label("lagged-effect") {
        families.extend([
            "unit-change".to_string(),
            "comparative-strength".to_string(),
        ]);
    }
    if has_label("threshold-regime") {
        families.extend([
            "partition-and-threshold".to_string(),
            "unit-change".to_string(),
        ]);
    }
    if action_type == "novelty_followup" {
        families.extend([
            "subgroup-moderator".to_string(),
            "partition-and-threshold".to_string(),
            "unit-change".to_string(),
        ]);
    }
    if families.is_empty() {
        families.extend([
            "adjusted-signal".to_string(),
            "unit-change".to_string(),
            "subgroup-moderator".to_string(),
        ]);
    }
    families.sort();
    families.dedup();
    families.into_iter().map(Value::String).collect()
}

pub(crate) fn focus_outcomes_for_runner(_hypotheses: &[String]) -> Vec<Value> {
    // Outcomes are decided by the analyst handoff contract (handoff_checks.outcome),
    // not keyword-routed from hypothesis text. Return an empty list so the runner
    // sources outcomes from the authoritative handoff artifact instead of
    // defaulting to a hardcoded domain (previously: life_expectancy, neonatal_mortality).
    Vec::new()
}

pub(crate) fn analysis_goals_for_runner(scenario_labels: &[String]) -> Vec<Value> {
    let mut goals = vec![
        Value::String("normalize the active dataset bundle".to_string()),
        Value::String("test the assigned hypotheses with scenario-specific validation rather than only pooled correlation".to_string()),
    ];
    for label in scenario_labels {
        let goal = match label.as_str() {
            "subgroup-moderator" => Some("run subgroup-stratified, interaction, and leave-one-group-out validation"),
            "equity-mechanism" => Some("test subgroup or low-coverage partition behavior as a rival to the pooled average"),
            "measurement-quality" => Some("treat reporting and measurement quality as an explicit rival explanation"),
            "lagged-effect" => Some("check lagged or time-shifted outcome alignment in addition to contemporaneous association"),
            "threshold-regime" => Some("look for threshold or regime changes rather than only linear average effects"),
            _ => None,
        };
        if let Some(goal) = goal {
            goals.push(Value::String(goal.to_string()));
        }
    }
    goals
}

/// Phase 1 data fetcher (docs/data-fetcher-2026-04-28.md §E) — structural
/// fallback that injects a ``data_acquisition_followup`` priority_action
/// when the lab-director hypothesis names open datasets but chronicle
/// did not recommend a fetch action.
///
/// Reads ``<state>/<cycle>-lab-director-hypothesis.json``; when its
/// ``identification_strategy.open_datasets`` array is non-empty and
/// ``priority_actions`` does not yet contain a
/// ``data_acquisition_followup`` entry, pushes one with the labels /
/// dataset_ids the hypothesis asked for. The fetcher then has a
/// concrete trigger and the medical / engineering verification flow no
/// longer relies on chronicle volunteering the action type itself.
///
/// No-ops when the hypothesis file is missing, malformed, or already
/// has an acquisition action queued.
pub(crate) fn inject_data_acquisition_fallback_action(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
) {
    let already_has = priority_actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("data_acquisition_followup")
    });
    if already_has {
        return;
    }
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    if !hypothesis_path.is_file() {
        return;
    }
    let hypothesis = match read_json(&hypothesis_path) {
        Ok(v) => v,
        Err(_) => return,
    };
    // The lab-director hypothesis schema is not stable across cycles
    // — the open_datasets array can live under
    // identification_strategy.open_datasets, primary_family.open_datasets,
    // or further nested. Walk the JSON tree once and gather every
    // "open_datasets" array we find so one schema change doesn't
    // silently break the trigger. The dedupe below by label / id keeps
    // the eventual action description tidy when the same set is
    // referenced from multiple paths.
    fn collect_open_datasets(value: &Value, out: &mut Vec<Value>) {
        match value {
            Value::Object(map) => {
                if let Some(Value::Array(items)) = map.get("open_datasets") {
                    for item in items {
                        out.push(item.clone());
                    }
                }
                for (_, v) in map.iter() {
                    collect_open_datasets(v, out);
                }
            }
            Value::Array(items) => {
                for v in items {
                    collect_open_datasets(v, out);
                }
            }
            _ => {}
        }
    }
    let mut datasets: Vec<Value> = Vec::new();
    collect_open_datasets(&hypothesis, &mut datasets);
    // Schema-shift fallback: if the hypothesis carries no structured
    // ``open_datasets`` array but the accession is named in the
    // statement / family / estimands prose (e.g.
    // ``…outperform cg06639320 in FHL2 in both GSE40279 and GSE87571…``),
    // scan the serialised hypothesis once for known accession
    // patterns (GSE / SRP / PRJ / E-MTAB / phs) and treat each as a
    // synthetic dataset entry. This keeps the fallback firing across
    // schema variations the lab-director may emit run-to-run.
    if datasets.is_empty() {
        let text = serde_json::to_string(&hypothesis).unwrap_or_default();
        let patterns: [&str; 5] = [
            r"\b(GSE\d{3,7})\b",
            r"\b(SRP\d{5,8})\b",
            r"\b(PRJ[EDN][A-Z]\d{4,9})\b",
            r"\b(E-[A-Z]{4}-\d{1,7})\b",
            r"\b(phs\d{6,9}(?:\.v\d+)?)\b",
        ];
        let mut seen_acc: std::collections::HashSet<String> = std::collections::HashSet::new();
        for raw_pat in patterns.iter() {
            // serde_json escapes backslashes; strip the case-insensitive
            // detail by matching uppercase explicitly. Use a lightweight
            // hand-rolled scan rather than pulling in the regex crate
            // here — patterns are simple enough and the hypothesis text
            // is bounded (<32 KB typical).
            for token in scan_simple_acc(&text, raw_pat) {
                let upper = token.to_uppercase();
                if seen_acc.insert(upper.clone()) {
                    datasets.push(json!({"accession": upper}));
                }
            }
        }
    }
    if datasets.is_empty() {
        return;
    }
    let mut seen_labels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut labels: Vec<String> = Vec::new();
    for ds in &datasets {
        // Prefer the BARE accession-shaped fields (``accession``,
        // ``label``, ``name``) before the slug / internal-id fields
        // (``dataset_id``, ``id``). v37 demonstrated why: the
        // hypothesis carried both ``accession: "GSE40279"`` and
        // ``dataset_id: "dataset_GSE40279"``; the slug variant was
        // useless to NCBI eutils' search index because no public
        // record indexes ``dataset_GSE40279`` verbatim, and the
        // scout's regex identifier extractor could not pull the
        // bare ``GSE40279`` back out (Python ``\b`` does not split
        // on ``_``). Putting the clean accession first eliminates
        // the round-trip loss.
        let candidate = ds
            .get("accession")
            .and_then(Value::as_str)
            .or_else(|| ds.get("label").and_then(Value::as_str))
            .or_else(|| ds.get("name").and_then(Value::as_str))
            .or_else(|| ds.get("dataset_id").and_then(Value::as_str))
            .or_else(|| ds.get("id").and_then(Value::as_str))
            .map(str::to_string);
        if let Some(label) = candidate.filter(|s| !s.is_empty()) {
            if seen_labels.insert(label.to_lowercase()) {
                labels.push(label);
            }
        }
    }
    if labels.is_empty() {
        return;
    }
    let description = format!(
        "Acquire the open datasets the lab-director hypothesis depends on: {}. Chronicle did not surface a data_acquisition_followup but the hypothesis cannot be falsified without these cohorts on disk.",
        labels.join(", ")
    );
    priority_actions.push(json!({
        "brief_id": "fallback:lab_director_open_datasets",
        "description": description,
        "type": "data_acquisition_followup",
        "preferred_role": "scout",
        "priority_score": 95i64,
        "target_rubric": Value::Null,
        "target_score": Value::Null,
        "current_score": Value::Null,
        "blocker_reasons": json!(["chronicle_did_not_emit_data_acquisition_action"]),
        "fallback_origin": "lab_director_open_datasets",
        "dataset_labels": labels,
    }));

    // Sequencing fix (v25 lesson): when the fallback fires and the
    // cycle has no fetched-bundles index yet, the followup-analyst
    // dispatched in the SAME pass would race the scout and run with
    // empty candidate_datasets. Strip pivot_followup analyst actions
    // from this pass so the analyst is queued cleanly on the NEXT
    // supervisor pass — by then the scout has emitted
    // ``<state>/<cycle>-data-bundles.json`` and lab-director's role
    // plan writer can surface populated candidate_datasets. Other
    // analyst-related action types (recovery, etc.) are left alone;
    // only the strategy-pivot variant depends on candidate_datasets.
    let bundles_index_path = state_root(paths).join(format!("{cycle_id}-data-bundles.json"));
    if !bundles_index_path.is_file() {
        let before = priority_actions.len();
        priority_actions.retain(|action| {
            let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
            let preferred_role = action
                .get("preferred_role")
                .and_then(Value::as_str)
                .unwrap_or("");
            !(action_type == "pivot_followup" && preferred_role == "analyst")
        });
        let _stripped = before - priority_actions.len();
        // Only log via comment — the supervisor's existing event
        // stream already captures the followup launch decisions, and
        // chronicle's pass diagnostics will show the pivot_followup
        // queued on the subsequent pass once data-bundles.json lands.
    }
}
