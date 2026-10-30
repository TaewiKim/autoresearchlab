#![allow(unused_imports)]
use super::*;

pub(crate) fn lane_quiescence_wait_seconds(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    elapsed_seconds: u64,
    default_wait_seconds: u64,
) -> u64 {
    default_wait_seconds.max(
        stale_threshold_for_lane(contract, role_plan, default_wait_seconds)
            .saturating_sub(elapsed_seconds),
    )
}

fn cycle_quiescence_wait_seconds(
    paths: &AppPaths,
    cycle_id: &str,
    default_wait_seconds: u64,
) -> Result<u64> {
    let mut wait_seconds = default_wait_seconds;
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let run_state_path = lane_dir.join("run-state.json");
        if !run_state_path.exists()
            || read_json(&run_state_path)?
                .get("status")
                .and_then(Value::as_str)
                != Some("running")
            || !lane_process_is_alive(paths, cycle_id, &lane_id)
        {
            continue;
        }
        let contract_path = lane_dir.join("lane-contract.json");
        if !contract_path.exists() {
            continue;
        }
        let contract: LaneContract = serde_json::from_value(read_json(&contract_path)?)?;
        let role_plan = read_json(&lane_dir.join("role-plan.json")).ok();
        let started_at = read_json(&lane_process_path(paths, cycle_id, &lane_id))?
            .get("started_at")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc));
        let elapsed_seconds = started_at
            .map(|value| (Utc::now() - value).num_seconds().max(0) as u64)
            .unwrap_or(0);
        wait_seconds = wait_seconds.max(lane_quiescence_wait_seconds(
            &contract,
            role_plan.as_ref(),
            elapsed_seconds,
            default_wait_seconds,
        ));
    }
    Ok(wait_seconds)
}

pub(crate) fn wait_for_cycle_quiescence(
    paths: &AppPaths,
    cycle_id: &str,
    max_wait_seconds: u64,
    poll_seconds: u64,
) -> Result<Vec<Value>> {
    // MEASURED ON cycle-a-20260919, 2026-09-22. Shutdown waited its
    // generic 1,800 seconds and then aborted followup-engineer-40, -42 and -46
    // while their checkpointed simulation sweep was making progress inside its
    // 7,200-second runtime budget. Wait out the active lane's remaining budget.
    let max_wait_seconds =
        cycle_quiescence_wait_seconds(paths, cycle_id, max_wait_seconds)?;
    let mut waited = 0u64;
    let step = poll_seconds.max(1);
    while waited < max_wait_seconds {
        if running_lane_count(paths, cycle_id)? == 0 {
            return Ok(Vec::new());
        }
        sleep(Duration::from_secs(step));
        waited += step;
    }
    abort_cycle_running_lanes(paths, cycle_id)
}

/// A base lab-runner that is ready to run, and could therefore be preempted.
///
/// The caller withholds follow-up dispatch while this is true, so that a base
/// runner about to execute is not buried under follow-up lanes. That is right
/// for a runner that is READY. It is exactly wrong for one that is blocked,
/// because the thing that would unblock it is a follow-up lane -- so a blocked
/// base runner suppresses the dispatch that clears its own blocker and the
/// cycle stops.
///
/// This used to skip two named blockers, `waiting-for-rival-analyst-handoffs`
/// and `waiting-for-data-acquisition`. Naming them individually is the same
/// half-exemption that cost 4b37d60 and then cycle-g-v91: the traffic simply
/// moves to the door still bolted.
///
/// MEASURED ON cycle-g-v91, 2026-09-12. `lab-runner-02` sat pending on
/// `waiting-for-upstream-evidence analyst_completed=0` -- a third blocker, not
/// on the list. With the action-type allowlist removed the director's recovery
/// plan finally reached the planner and asked, four times over, for one
/// replacement scout. No scout lane was ever opened, because this function
/// returned true for a runner that could not move and the whole follow-up
/// dispatch was skipped. The scout would have produced the corpus, the analyst
/// would have followed, and `analyst_completed` would have stopped being zero.
///
/// So the rule is the general one: a lane that is itself blocked is not ready,
/// and a lane that is not ready cannot be the reason to withhold the work that
/// would ready it. A base runner with no blocker still suppresses follow-ups,
/// which is the case this was written for.
pub(crate) fn pending_base_lab_runner_exists(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    if let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? {
        for lane in lane_statuses {
            let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
            if lane_id.is_empty() || lane_id.starts_with("followup-") {
                continue;
            }
            let role_matches = lane.get("role").and_then(Value::as_str) == Some("lab-runner")
                || lane_id_looks_like_lab_runner(lane_id);
            if !role_matches {
                continue;
            }
            let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(
                status,
                "running" | "completed" | "failed" | "aborted" | "cancelled"
            ) {
                continue;
            }
            let contract_path = lane_root(paths, cycle_id, lane_id).join("lane-contract.json");
            if !contract_path.exists() {
                continue;
            }
            let contract: LaneContract = serde_json::from_value(read_json(&contract_path)?)?;
            if contract.role != "lab-runner" || contract.lane_id.starts_with("followup-") {
                continue;
            }
            // A lane that is itself blocked cannot be the reason to withhold
            // the dispatch that would unblock it. See the note on this function.
            if dependency_blocker_for_lane(paths, cycle_id, &contract)?.is_some() {
                continue;
            }
            return Ok(true);
        }
        return Ok(false);
    }
    for contract_path in all_cycle_contract_paths(paths, cycle_id)? {
        if contract_path
            .parent()
            .map(|root| root.join("final-status.json").exists())
            .unwrap_or(false)
        {
            continue;
        }
        let contract: LaneContract = serde_json::from_value(read_json(&contract_path)?)?;
        if contract.role != "lab-runner" || contract.lane_id.starts_with("followup-") {
            continue;
        }
        let root = lane_root(paths, cycle_id, &contract.lane_id);
        if root.join("run-state.json").exists() {
            let run_state = read_json(&root.join("run-state.json"))?;
            if matches!(
                run_state.get("status").and_then(Value::as_str),
                Some("running") | Some("completed")
            ) {
                continue;
            }
        }
        if dependency_blocker_for_lane(paths, cycle_id, &contract)?.is_some() {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

pub(crate) fn zero_candidate_data_acquisition_attempts(paths: &AppPaths, cycle_id: &str) -> usize {
    let lanes_root = cycle_lanes_root(paths, cycle_id);
    let Ok(entries) = read_dir(lanes_root) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id.contains("scout") {
                return None;
            }
            let result_path = entry.path().join("result.json");
            if !result_path.exists() {
                return None;
            }
            read_json(&result_path).ok()
        })
        .filter(|result| {
            let has_structured_discovery_contract = result
                .get("role_plan")
                .and_then(|plan| plan.get("planner_metadata"))
                .and_then(|metadata| metadata.get("dataset_discovery_contract"))
                .is_some();
            if !has_structured_discovery_contract {
                return false;
            }
            result.get("driver").and_then(Value::as_str) == Some("data-scout-browser")
                && result.get("status").and_then(Value::as_str).unwrap_or("") != "skipped"
                && result
                    .get("candidate_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    == 0
                && result
                    .get("fetched_bundle_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    == 0
        })
        .count()
}

pub(crate) fn latest_scout_discovery_without_materialization_summary(
    paths: &AppPaths,
    cycle_id: &str,
    limit: usize,
) -> Option<Value> {
    let limit = limit.max(1);
    let roots = [
        cycle_lanes_root(paths, cycle_id),
        paths
            .runtime_root
            .join("artifacts")
            .join("stats")
            .join(cycle_id),
    ];
    let mut by_lane: HashMap<String, (u128, PathBuf)> = HashMap::new();
    for root in roots {
        let Ok(entries) = read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id.starts_with("followup-scout-") {
                continue;
            }
            let result_path = entry.path().join("result.json");
            if !result_path.is_file() {
                continue;
            }
            let Ok(metadata) = fs::metadata(&result_path) else {
                continue;
            };
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|mtime| mtime.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            let replace = by_lane
                .get(&lane_id)
                .map(|(existing_ms, _)| modified_ms > *existing_ms)
                .unwrap_or(true);
            if replace {
                by_lane.insert(lane_id, (modified_ms, result_path));
            }
        }
    }

    let mut candidate_count = 0u64;
    let mut open_candidate_count = 0u64;
    let mut candidates_with_accession = 0u64;
    let mut fetched_bundle_count = 0u64;
    let mut lane_ids = Vec::new();
    let mut result_paths = Vec::new();
    let mut latest = by_lane.into_iter().collect::<Vec<_>>();
    latest.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    for (lane_id, (_, result_path)) in latest {
        let Ok(result) = lane_result_fields(
            &result_path,
            &[
                "status",
                "candidate_count",
                "open_candidate_count",
                "candidates_with_accession",
                "fetched_bundle_count",
                "data_graph_appended",
                "data_graph_update_path",
            ],
        ) else {
            continue;
        };
        let status = result.get("status").and_then(Value::as_str).unwrap_or("");
        let candidates = result
            .get("candidate_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let open_candidates = result
            .get("open_candidate_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let accession_candidates = result
            .get("candidates_with_accession")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let fetched = result
            .get("fetched_bundle_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let data_graph_appended = result
            .get("data_graph_appended")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_data_graph_update_path = result
            .get("data_graph_update_path")
            .and_then(Value::as_str)
            .map(|path| !path.trim().is_empty())
            .unwrap_or(false);
        // FIX-K: the materialization signal the analyst actually needs is
        // FETCHED data bundles, not graph-node appends. Previously a scout that
        // appended candidate nodes to the data-graph (data_graph_appended=true)
        // was treated as "materialized" and skipped — so when the chronicle
        // succeeds and writes a data-graph, discovery scouts append nodes
        // (data_graph_appended=true) but fetch 0 bundles, the recovery never
        // fires, no materialize-fetch pass is scheduled, and the analyst defers
        // forever with reason "awaiting_data_acquisition" (observed in v7:
        // 36 open DOI/GEO candidates, fetched_bundle_count=0). Trigger the
        // recovery whenever a completed scout has accession-bearing candidates
        // but fetched 0 bundles, regardless of graph append. `fetched > 0` (real
        // materialized data) is the only thing that should skip it. FIX-D bounds
        // the recovery rounds so a genuinely unfetchable corpus can't loop.
        if status != "completed" || candidates == 0 || accession_candidates == 0 || fetched > 0 {
            let _ = has_data_graph_update_path;
            let _ = data_graph_appended;
            continue;
        }
        candidate_count += candidates;
        open_candidate_count += open_candidates;
        candidates_with_accession += accession_candidates;
        fetched_bundle_count += fetched;
        lane_ids.push(json!(lane_id));
        result_paths.push(json!(result_path.to_string_lossy()));
        if lane_ids.len() >= limit {
            break;
        }
    }
    if lane_ids.len() < limit {
        return None;
    }

    Some(json!({
        "reason": "scout_discovery_without_materialization_stagnation",
        "repeated_lane_count": lane_ids.len(),
        "lane_ids": lane_ids,
        "result_paths": result_paths,
        "totals": {
            "candidate_count": candidate_count,
            "open_candidate_count": open_candidate_count,
            "candidates_with_accession": candidates_with_accession,
            "fetched_bundle_count": fetched_bundle_count
        }
    }))
}

pub(crate) fn enforce_zero_nonfallback_hypothesis_recovery_actions(
    priority_actions: &mut Vec<Value>,
    selected_hypotheses: &[Value],
    objective: &str,
) {
    if !selected_hypotheses.is_empty() {
        return;
    }
    let has_gate_critical_or_executable_action = priority_actions.iter().any(|action| {
        let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
        let target_rubric = action
            .get("target_rubric")
            .and_then(Value::as_str)
            .unwrap_or("");
        let evidence_bound_gate_review = action_type == "independent_gate_review_followup"
            && (action.get("latest_validation_lane_id").is_some()
                || action
                    .get("validation_results")
                    .filter(|value| !value.is_null())
                    .is_some());
        matches!(
            action.get("brief_id").and_then(Value::as_str),
            Some("analyst-handoff")
                | Some("analyst-handoff-artifact")
                | Some("analyst-handoff-revision")
        ) || matches!(
            action_type,
            "external_validation_followup"
                | "external_validation_analysis_followup"
                | "labdirector_comparator_validation_followup"
        ) || evidence_bound_gate_review
            || target_rubric == "external_validity"
            || target_rubric == "gate_independence"
            || (action_type == "methods_followup" && !target_rubric.is_empty())
    });
    if has_gate_critical_or_executable_action {
        return;
    }
    // A zero-hypothesis plan is a design-stage blocker, not a validation
    // backlog. After blocking the old `unclassified_family` fallback, the
    // planner must not keep dispatching analyst/gate/runner followups that
    // have no concrete, classified hypothesis to test; those lanes only
    // regenerate deferred `hyp-fallback-unclassified` handoffs forever.
    // Keep only discovery/requery actions and force a paired scout +
    // LabDirector recovery request that must create classified families
    // before analyst handoff is allowed again.
    priority_actions.retain(|action| {
        matches!(
            action.get("type").and_then(Value::as_str),
            Some("data_acquisition_followup")
                | Some("lab_director_requery_followup")
                | Some("chronicle_evidence_request_followup")
                | Some("labdirector_comparator_validation_followup")
        ) || action
            .get("type")
            .and_then(Value::as_str)
            .map(|item| item.starts_with("hypothesis_regeneration"))
            .unwrap_or(false)
    });
    if !priority_actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("lab_director_requery_followup")
            && action.get("brief_id").and_then(Value::as_str) == Some("zero-nonfallback-hypotheses")
    }) {
        priority_actions.push(json!({
            "brief_id": "zero-nonfallback-hypotheses",
            "type": "lab_director_requery_followup",
            "preferred_role": "lab-director",
            "target_rubric": "hypothesis_strategy",
            "priority_score": 160,
            "description": "Design-stage recovery: no classified, nonfallback hypothesis is selectable. Read the objective, current literature/data graph, scout bundles, and failed/deferred handoffs; produce at least three substantive, falsifiable hypothesis families in the objective's own field, each with a concrete named dataset or benchmark, variables, outcomes, mechanisms, rivals, and executable validation requirements. Do not emit analyst handoff until a non-unclassified family is selected.",
            "candidate_hypotheses": [],
            "recovery_reason": "zero_nonfallback_hypotheses",
        }));
    }
    if !priority_actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("data_acquisition_followup")
            && action.get("brief_id").and_then(Value::as_str) == Some("zero-nonfallback-hypotheses")
    }) {
        priority_actions.push(json!({
            "brief_id": "zero-nonfallback-hypotheses",
            "type": "data_acquisition_followup",
            "preferred_role": "scout",
            "target_rubric": "dataset_support",
            "priority_score": 155,
            "description": "Design-stage recovery: find alternative public datasets or standard benchmarks, in the repositories the objective's own field uses, that can support classified, substantive hypotheses. Exclude forbidden/reused datasets from the objective, return schema clues and same-dataset reference papers, and avoid generic binary-outcome fallback targets.",
            "candidate_hypotheses": [],
            "recovery_reason": "zero_nonfallback_hypotheses",
            "dataset_discovery_contract": dataset_discovery_contract(objective),
        }));
    }
    priority_actions.sort_by(|a, b| {
        b["priority_score"]
            .as_i64()
            .cmp(&a["priority_score"].as_i64())
    });
}

#[derive(Clone, Debug)]
pub(crate) struct DependencySnapshot {
    pub(crate) counts: HashMap<String, usize>,
    pub(crate) completed_scouts: usize,
    pub(crate) completed_data_scouts: usize,
    pub(crate) has_lab_director_hypothesis: bool,
    pub(crate) conclusion_needs_hypothesis_strategy: bool,
    pub(crate) hypothesis_gate_passed: bool,
    pub(crate) latest_analyst_handoff_signal: Option<Value>,
    pub(crate) pending_runner_post_run_review: Option<String>,
}

pub(crate) fn dependency_snapshot(paths: &AppPaths, cycle_id: &str) -> Result<DependencySnapshot> {
    let counts = completed_role_counts(paths, cycle_id)?;
    let completed_scouts = completed_literature_scout_count(paths, cycle_id)?;
    let lab_director_hypothesis_path =
        state_root(paths).join(format!("{}-lab-director-hypothesis.json", cycle_id));
    Ok(DependencySnapshot {
        counts,
        completed_scouts,
        completed_data_scouts: completed_data_scout_count(paths, cycle_id)?,
        has_lab_director_hypothesis: lab_director_hypothesis_is_usable(
            paths,
            cycle_id,
            &lab_director_hypothesis_path,
        ),
        conclusion_needs_hypothesis_strategy: conclusion_needs_hypothesis_strategy(
            paths, cycle_id,
        )?,
        hypothesis_gate_passed: hypothesis_gate_passed(paths, cycle_id)?,
        latest_analyst_handoff_signal: latest_analyst_handoff_signal(paths, cycle_id)?,
        pending_runner_post_run_review: latest_runner_post_run_review_blocker(paths, cycle_id)?,
    })
}

/// A director lane opened BECAUSE a blocking lane failed.
///
/// The ordering gates below hold a lab-director lane until a literature scout
/// has completed, which is right for the ordinary case: the director should not
/// pick a lead with no corpus. It is exactly wrong for the one lane whose job is
/// to decide what to do about a scout that will never complete.
///
/// MEASURED ON cycle-g-v91. Three scouts failed
/// (`literature_abstract_review_required`, `adaptive_literature_search_incomplete`),
/// the aggregate raised the recovery request, the dispatcher opened
/// `followup-lab-director-02` for it -- and the gate skipped that lane with
/// `waiting-for-literature-scout scout_literature_completed=0`, the very
/// condition it was opened to resolve. All twelve pending lanes carried a
/// variant of that one reason, so the cycle could not move and could not decide
/// to move differently.
///
/// This is the third instance of the shape. v82: the director was told to cite a
/// verified instrument when no instrument had been probed. 4b37d60: a
/// materialization exemption named `lab-runner` while the same gate also held
/// the analyst, so the analyst stayed blocked and the runner it released was
/// then held on `analyst_completed=0`.
pub(crate) fn lane_is_blocking_failure_recovery(role_plan: &Value) -> bool {
    role_plan.get("action_type").and_then(Value::as_str) == Some("blocking_lane_recovery_planning")
}

pub(crate) fn gatekeeper_review_has_bound_validation_evidence(role_plan: &Value) -> bool {
    if role_plan.get("action_type").and_then(Value::as_str)
        != Some("independent_gate_review_followup")
    {
        return false;
    }
    let review_action = role_plan
        .get("planner_metadata")
        .and_then(|item| item.get("review_action"))
        .unwrap_or(&Value::Null);
    role_plan.get("latest_validation_lane_id").is_some()
        || role_plan.get("validation_results").is_some()
        || role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("latest_validation_lane_id"))
            .is_some()
        || role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("validation_results"))
            .is_some()
        || review_action.get("latest_validation_lane_id").is_some()
        || review_action.get("validation_results").is_some()
}

fn gatekeeper_plan_targets_current_lead(
    role_plan: &Value,
    authoritative_lead: &Value,
) -> bool {
    fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
        names.iter().find_map(|name| {
            value
                .get(*name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
        })
    }

    let planned = role_plan
        .get("planner_metadata")
        .and_then(|item| item.get("current_lead_under_review"))
        .unwrap_or(&Value::Null);
    let current = authoritative_lead
        .get("selected_hypothesis")
        .filter(|item| item.is_object())
        .unwrap_or(authoritative_lead);
    let planned_id = field(planned, &["hypothesis_id", "memory_id"]);
    let current_id = field(current, &["hypothesis_id", "memory_id"])
        .or_else(|| field(authoritative_lead, &["hypothesis_id", "memory_id"]));
    if planned_id.is_some() && current_id.is_some() {
        return planned_id == current_id;
    }
    let planned_family = field(planned, &["primary_family", "family_root"]);
    let current_family = field(current, &["primary_family", "family_root"])
        .or_else(|| field(authoritative_lead, &["primary_family", "family_root"]));
    if planned_family.is_some() && current_family.is_some() {
        return planned_family == current_family;
    }
    let planned_statement = field(planned, &["statement", "hypothesis_statement"]);
    let current_statement = field(current, &["statement", "hypothesis_statement"])
        .or_else(|| field(authoritative_lead, &["statement", "hypothesis_statement"]));
    planned_statement.is_some()
        && current_statement.is_some()
        && planned_statement == current_statement
}

#[cfg(test)]
mod current_lead_completed_gate_tests {
    use super::*;
    use tempfile::TempDir;

    fn paths_for(root: &Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("datasets"),
            stats_driver_script: PathBuf::from("unused-stats.py"),
            literature_driver_script: PathBuf::from("unused-literature.py"),
        }
    }

    fn gatekeeper_contract(root: &Path, cycle_id: &str) -> LaneContract {
        serde_json::from_value(json!({
            "cycle_id": cycle_id,
            "lane_id": "followup-gatekeeper-363",
            "role": "gatekeeper",
            "runtime_class": "codex-agent",
            "mode": "read-write-scoped",
            "cwd": root,
            "task_file": root.join("task.md"),
            "output_artifact": root.join("result.json"),
            "fallback_strategy": null
        }))
        .unwrap()
    }

    fn analyst_contract(root: &Path, cycle_id: &str) -> LaneContract {
        serde_json::from_value(json!({
            "cycle_id": cycle_id,
            "lane_id": "followup-analyst-1357",
            "role": "analyst",
            "runtime_class": "codex-agent",
            "mode": "read-write-scoped",
            "cwd": root,
            "task_file": root.join("task.md"),
            "output_artifact": root.join("result.json"),
            "fallback_strategy": null
        }))
        .unwrap()
    }

    #[test]
    fn queued_analyst_waits_for_the_latest_handoff_runner_measurement() {
        // MEASURED ON cycle-a-20260919, 2026-10-29: analysts 1337
        // and 1357 launched before runners 803/819 for the immediately prior
        // handoff, then produced primary handoffs the completed runner made
        // contract_already_measured. Reproduce the same dependency record.
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let cycle_id = "cycle-a-20260919";
        let lane_dir = lane_root(&paths, cycle_id, "followup-analyst-1357");
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({"role": "analyst", "action_type": "novelty_followup"}),
        )
        .unwrap();
        write_json(
            &state_root(&paths).join(format!("{cycle_id}-lab-director-hypothesis.json")),
            &json!({
                "status": "selected",
                "statement": "loss-family refinement interaction",
                "primary_family": "loss_family_refinement_support_interaction",
                "validation_data_status": "materialized"
            }),
        )
        .unwrap();
        let snapshot = DependencySnapshot {
            counts: HashMap::from([
                ("analyst".to_string(), 1),
                ("lab-runner".to_string(), 1),
            ]),
            completed_scouts: 1,
            completed_data_scouts: 1,
            has_lab_director_hypothesis: true,
            conclusion_needs_hypothesis_strategy: false,
            hypothesis_gate_passed: false,
            latest_analyst_handoff_signal: None,
            pending_runner_post_run_review: Some(
                "waiting-for-latest-analyst-handoff-runner analyst_handoff_path=/lanes/followup-analyst-1356/handoff-validation-plan.json".to_string(),
            ),
        };

        let blocker = raw_dependency_blocker_for_lane_with_snapshot(
            &paths,
            cycle_id,
            &analyst_contract(temp.path(), cycle_id),
            &snapshot,
        )
        .unwrap();
        assert_eq!(blocker, snapshot.pending_runner_post_run_review);
    }

    #[test]
    fn parsed_retired_reviews_do_not_block_the_queued_current_lead_review() {
        // MEASURED ON cycle-a-20260919, 2026-10-08: conclusion
        // churned through three blocking_lane_recovery_planning lanes while
        // followup-gatekeeper-363 had been queued for the current topology lead
        // since 11:00. Retired reviews made gate status parsed/pending=0, which
        // blocked that lane before it could replace their scores.
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let cycle_id = "cycle-a-20260919";
        fs::create_dir_all(state_root(&paths)).unwrap();
        let lane_dir = lane_root(&paths, cycle_id, "followup-gatekeeper-363");
        fs::create_dir_all(&lane_dir).unwrap();
        write_json(
            &state_root(&paths).join(format!("{cycle_id}-lab-director-hypothesis.json")),
            &json!({
                "status": "selected",
                "statement": "disconnecting support changes fixed-policy gaps",
                "primary_family": "support_topology_randomized_intervention",
                "validation_data_status": "materialized"
            }),
        )
        .unwrap();
        write_json(
            &state_root(&paths).join(format!("{cycle_id}-gate-review.json")),
            &json!({
                "gatekeeper_review_status": "parsed",
                "gatekeeper_pending_rubrics": [],
                "gatekeeper_reviews_normalized": [{
                    "lane_id": "followup-gatekeeper-198",
                    "focus_rubric": "reproducibility",
                    "briefed_lead_key": null
                }]
            }),
        )
        .unwrap();
        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "role": "gatekeeper",
                "action_type": "independent_gate_review_followup",
                "planner_metadata": {
                    "target_rubric": "reproducibility",
                    "current_lead_under_review": {
                        "statement": "the same topology claim before a wording-only restatement",
                        "primary_family": "support_topology_randomized_intervention"
                    }
                }
            }),
        )
        .unwrap();
        let mut counts = HashMap::new();
        counts.insert("lab-runner".to_string(), 1);
        let snapshot = DependencySnapshot {
            counts,
            completed_scouts: 1,
            completed_data_scouts: 1,
            has_lab_director_hypothesis: true,
            conclusion_needs_hypothesis_strategy: false,
            hypothesis_gate_passed: false,
            latest_analyst_handoff_signal: None,
            pending_runner_post_run_review: None,
        };

        let blocker = raw_dependency_blocker_for_lane_with_snapshot(
            &paths,
            cycle_id,
            &gatekeeper_contract(temp.path(), cycle_id),
            &snapshot,
        )
        .unwrap();
        assert_eq!(blocker, None, "the queued current-lead review must reach execution");

        write_json(
            &lane_dir.join("role-plan.json"),
            &json!({
                "role": "gatekeeper",
                "action_type": "independent_gate_review_followup",
                "planner_metadata": {
                    "target_rubric": "reproducibility",
                    "current_lead_under_review": {
                        "statement": "retired refinement claim",
                        "primary_family": "loss_family_by_refinement"
                    }
                }
            }),
        )
        .unwrap();
        assert_eq!(
            raw_dependency_blocker_for_lane_with_snapshot(
                &paths,
                cycle_id,
                &gatekeeper_contract(temp.path(), cycle_id),
                &snapshot,
            )
            .unwrap()
            .as_deref(),
            Some("blocked-by-completed-gatekeeper-review pending_rubrics=0"),
            "retired-lead reviews must remain closed",
        );
    }
}

pub(crate) fn lab_runner_methods_followup_has_executable_handoff(role_plan: &Value) -> bool {
    if role_plan.get("action_type").and_then(Value::as_str) != Some("methods_followup") {
        return false;
    }
    let source_brief_id = role_plan
        .get("source_brief_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let handoff_sourced = source_brief_id.starts_with("analyst-handoff")
        || role_plan
            .get("planner_metadata")
            .and_then(|item| item.get("analysis_request"))
            .and_then(|item| item.get("source"))
            .and_then(Value::as_str)
            == Some("latest-executable-analyst-handoff");
    let planner_analysis_request = role_plan
        .get("planner_metadata")
        .and_then(|item| item.get("analysis_request"))
        .unwrap_or(&Value::Null);
    handoff_sourced
        && (executable_validation_spec_present(role_plan)
            || executable_validation_spec_present(planner_analysis_request))
}

/// Why a gate review would only re-read what the last round already read.
///
/// A round moves a rubric only if it has something new to judge: a different
/// lead, or evidence that did not exist when the last round was recorded.
/// MEASURED ON cycle-g-v91, 2026-09-14: eight gatekeeper lanes queued at 08:59
/// ran at 10:11-10:24 against a lead chosen at 09:43 whose newest runner evidence
/// was from 09:37. The second round they formed re-read the first round's
/// material, scored nothing higher -- it could not -- and was the fifth flat round
/// that halted the cycle. Four more such lanes were queued behind them.
///
/// Holds until a runner produces evidence after that round, or the lead changes.
pub(crate) fn gate_review_has_nothing_new(
    paths: &AppPaths,
    cycle_id: &str,
    target_rubric: Option<&str>,
) -> Option<String> {
    let target_rubric = target_rubric.unwrap_or("").trim();
    let rubric_still_pending = !target_rubric.is_empty()
        && read_json(&state_root(paths).join(format!("{cycle_id}-gate-review.json")))
            .ok()
            .and_then(|review| review.get("gatekeeper_pending_rubrics").cloned())
            .and_then(|rubrics| rubrics.as_array().cloned())
            .is_some_and(|rubrics| {
                rubrics
                    .iter()
                    .any(|rubric| rubric.as_str() == Some(target_rubric))
            });
    // MEASURED ON cycle-a-20260919, 2026-10-04: the gate explicitly
    // reported novelty and clarity pending, but their queued current-lead
    // reviews were held for new runner evidence after stale round 107. A rubric
    // absent from that round is itself new work; it does not need another run.
    if rubric_still_pending {
        return None;
    }
    let progress = fs::read_to_string(
        state_root(paths).join(format!("{cycle_id}-hypothesis-progress.jsonl")),
    )
    .ok()?;
    let last_round = progress
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|row| {
            row.get("memory_type").and_then(Value::as_str) == Some("decision")
                && row
                    .get("content")
                    .and_then(|content| content.get("rubric"))
                    .and_then(Value::as_array)
                    .is_some()
        })?;
    let round_statement = last_round
        .get("content")
        .and_then(|content| content.get("statement"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let round_at = last_round
        .get("ts")
        .and_then(Value::as_str)
        .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
        .map(|ts| ts.with_timezone(&Utc))?;
    let lead = read_json(&state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"))).ok()?;
    let lead_statement: String = lead
        .get("statement")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        // The round record keeps the first 600 characters of the statement.
        .take(600)
        .collect();
    if round_statement.is_empty() || lead_statement.trim() != round_statement {
        return None;
    }
    let lanes_root = paths.runtime_root.join("lanes").join(cycle_id);
    for entry in fs::read_dir(&lanes_root).ok()?.flatten() {
        let lane_id = entry.file_name().to_string_lossy().to_string();
        if !lane_id.contains("runner") {
            continue;
        }
        let final_status_path = entry.path().join("final-status.json");
        let Some(finished_at) = fs::metadata(&final_status_path)
            .and_then(|meta| meta.modified())
            .ok()
            .map(DateTime::<Utc>::from)
        else {
            continue;
        };
        if finished_at <= round_at {
            continue;
        }
        let completed = read_json(&final_status_path)
            .ok()
            .and_then(|status| status.get("status").and_then(Value::as_str).map(ToString::to_string))
            .as_deref()
            == Some("completed");
        if !completed {
            continue;
        }
        let result_path = entry.path().join("result.json");
        if fs::metadata(&result_path).map(|meta| meta.len()).unwrap_or(u64::MAX) > 16 * 1024 * 1024 {
            continue;
        }
        let measured = read_json(&result_path)
            .ok()
            .and_then(|result| result.get("blueprint_executions").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .any(|execution| match execution.get("produced_evidence").and_then(Value::as_bool) {
                Some(flag) => flag,
                None => {
                    execution.get("status").and_then(Value::as_str) == Some("completed")
                        && execution
                            .get("metrics")
                            .and_then(Value::as_object)
                            .is_some_and(|metrics| !metrics.is_empty())
                }
            });
        if measured {
            return None;
        }
    }
    Some(format!(
        "waiting-for-new-lead-evidence last_round={} recorded_at={}",
        last_round.get("task_id").and_then(Value::as_str).unwrap_or("unknown"),
        round_at.to_rfc3339(),
    ))
}

#[cfg(test)]
mod new_lead_evidence_tests {
    use super::*;

    fn cycle_paths(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("datasets"),
            stats_driver_script: std::path::PathBuf::from("unused-stats.py"),
            literature_driver_script: std::path::PathBuf::from("unused-literature.py"),
        }
    }

    fn write(path: &std::path::Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn recorded_round(paths: &AppPaths, statement: &str) {
        let round = json!({
            "memory_type": "decision",
            "task_id": "round-48",
            "ts": "2020-01-01T00:00:00Z",
            "content": { "statement": statement, "rubric": [{ "name": "novelty", "score": 64 }] }
        });
        write(
            &state_root(paths).join("cycle-test-hypothesis-progress.jsonl"),
            &format!("{}\n{}\n", json!({ "event_type": "lead_supersession_decision" }), round),
        );
    }

    fn current_lead(paths: &AppPaths, statement: &str) {
        write(
            &state_root(paths).join("cycle-test-lab-director-hypothesis.json"),
            &json!({ "statement": statement }).to_string(),
        );
    }

    fn finished_runner(paths: &AppPaths, lane: &str, produced_evidence: bool) {
        let dir = paths.runtime_root.join("lanes").join("cycle-test").join(lane);
        write(
            &dir.join("result.json"),
            &json!({ "blueprint_executions": [{ "status": "completed", "produced_evidence": produced_evidence }] })
                .to_string(),
        );
        write(&dir.join("final-status.json"), &json!({ "status": "completed" }).to_string());
    }

    #[test]
    fn a_review_of_the_same_lead_with_no_newer_evidence_is_held() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        fs::create_dir_all(paths.runtime_root.join("lanes").join("cycle-test")).unwrap();
        recorded_round(&paths, "the lead under review");
        current_lead(&paths, "the lead under review");
        finished_runner(&paths, "followup-runner-01", false);
        let reason =
            gate_review_has_nothing_new(&paths, "cycle-test", None).expect("should hold");
        assert!(reason.starts_with("waiting-for-new-lead-evidence"), "{reason}");
        assert!(reason.contains("round-48"), "{reason}");
    }

    #[test]
    fn evidence_finished_after_the_round_releases_the_review() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        recorded_round(&paths, "the lead under review");
        current_lead(&paths, "the lead under review");
        finished_runner(&paths, "followup-runner-01", true);
        assert_eq!(gate_review_has_nothing_new(&paths, "cycle-test", None), None);
    }

    #[test]
    fn a_different_lead_is_new_input_by_itself() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        fs::create_dir_all(paths.runtime_root.join("lanes").join("cycle-test")).unwrap();
        recorded_round(&paths, "the previous lead");
        current_lead(&paths, "a lead no round has reviewed");
        assert_eq!(gate_review_has_nothing_new(&paths, "cycle-test", None), None);
    }

    #[test]
    fn a_pending_rubric_advances_past_a_stale_round_without_another_runner() {
        // MEASURED ON cycle-a-20260919, 2026-10-04: round 107 was
        // recorded after reviews of retired leads, while the canonical gate
        // still named novelty and clarity as pending for the current lead.
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        recorded_round(&paths, "the current lead");
        current_lead(&paths, "the current lead");
        finished_runner(&paths, "followup-runner-136", false);
        write(
            &state_root(&paths).join("cycle-test-gate-review.json"),
            &json!({ "gatekeeper_pending_rubrics": ["novelty", "clarity"] }).to_string(),
        );

        assert_eq!(
            gate_review_has_nothing_new(&paths, "cycle-test", Some("novelty")),
            None,
        );
        assert!(
            gate_review_has_nothing_new(&paths, "cycle-test", Some("technical_quality"))
                .is_some(),
            "a rubric not pending at the gate must still wait for new evidence"
        );
    }

    #[test]
    fn a_rubric_held_for_a_confirming_review_is_released_without_new_evidence() {
        // Owner decision 2026-10-30: a gate that would pass asks for a second
        // review of the SAME evidence. The gate lists the rubric in
        // gatekeeper_pending_rubrics (and gatekeeper_unconfirmed_rubrics); a hold
        // for "nothing new since the last round" would defeat the confirmation.
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        recorded_round(&paths, "the current lead");
        current_lead(&paths, "the current lead");
        finished_runner(&paths, "followup-runner-136", false);
        write(
            &state_root(&paths).join("cycle-test-gate-review.json"),
            &json!({
                "gatekeeper_pending_rubrics": ["clarity"],
                "gatekeeper_unconfirmed_rubrics": ["clarity"]
            })
            .to_string(),
        );
        assert_eq!(gate_review_has_nothing_new(&paths, "cycle-test", Some("clarity")), None);
        assert!(gate_review_has_nothing_new(&paths, "cycle-test", Some("impact")).is_some());
    }

    #[test]
    fn a_cycle_with_no_recorded_round_holds_nothing() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = cycle_paths(temp.path());
        current_lead(&paths, "the lead under review");
        assert_eq!(gate_review_has_nothing_new(&paths, "cycle-test", None), None);
    }
}

pub(crate) fn dependency_blocker_for_lane(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
) -> Result<Option<String>> {
    let snapshot = dependency_snapshot(paths, cycle_id)?;
    dependency_blocker_for_lane_with_snapshot(paths, cycle_id, contract, &snapshot)
}

/// The gate, plus the one door the director was always told it had.
///
/// The blocker chain itself is unchanged and lives in
/// `raw_dependency_blocker_for_lane_with_snapshot`. What this adds is the single
/// place every caller passes through, so a recorded LabDirector release applies
/// to all twenty-four call sites rather than to whichever one somebody
/// remembered -- the half-exemption that cost 4b37d60 and then cycle-g-v91
/// happened twice because the exemption lived at the blocker and not at the
/// boundary.
pub(crate) fn dependency_blocker_for_lane_with_snapshot(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    snapshot: &DependencySnapshot,
) -> Result<Option<String>> {
    Ok(
        dependency_blocker_detail_for_lane_with_snapshot(paths, cycle_id, contract, snapshot)?
            .map(|blocker| blocker.reason),
    )
}

pub(crate) fn dependency_blocker_detail_for_lane_with_snapshot(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    snapshot: &DependencySnapshot,
) -> Result<Option<DependencyBlocker>> {
    let Some(reason) =
        raw_dependency_blocker_for_lane_with_snapshot(paths, cycle_id, contract, snapshot)?
    else {
        return Ok(None);
    };
    let blocker = DependencyBlocker::describe(reason);
    if let Some(override_entry) = dependency_gate_override_for(paths, cycle_id, &blocker.reason) {
        record_dependency_gate_release(
            paths,
            cycle_id,
            &contract.lane_id,
            &blocker,
            &override_entry,
        );
        return Ok(None);
    }
    Ok(Some(blocker))
}

fn raw_dependency_blocker_for_lane_with_snapshot(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &LaneContract,
    snapshot: &DependencySnapshot,
) -> Result<Option<String>> {
    if crate::labdirector::policy::planning_only_scope_blocks_role(&contract.role) {
        return Ok(Some(
            "planning-only-scope lab-runner execution disabled".to_string(),
        ));
    }
    // An expert-selection stage lane waits only on the artifact of the stage
    // before it, and it is dispatched only once that exists. The role gates
    // below would hold its director-role lanes behind chronicle and its
    // gatekeeper-role reviewers behind a runner that cannot exist before a lead
    // -- see labdirector::problem_selection.
    if expert_selection_stage_lane(paths, cycle_id, &contract.lane_id) {
        return Ok(None);
    }
    let counts = &snapshot.counts;
    let completed_scouts = snapshot.completed_scouts;
    let completed_analysts = counts.get("analyst").copied().unwrap_or(0);
    let completed_runners = counts.get("lab-runner").copied().unwrap_or(0);
    let completed_chronicles = counts.get("chronicle").copied().unwrap_or(0);
    // Lab-director hypothesis artifact path — analyst now reads this
    // instead of generating its own hypothesis.
    let lab_director_hypothesis_path =
        state_root(paths).join(format!("{}-lab-director-hypothesis.json", cycle_id));
    let has_lab_director_hypothesis = snapshot.has_lab_director_hypothesis;
    // Revised ordering (Level 3 pipeline redesign):
    //   scout ∥ chronicle       run in parallel from cycle start
    //   → lab-director          discusses with chronicle after scout and
    //                           chronicle both have emitted, synthesises
    //                           a hypothesis using literature_graph AND
    //                           data_graph
    //   → analyst               receives the lab-director hypothesis and
    //                           verifies it through analysis; updates
    //                           data_graph with results
    //   → lab-runner            executes analyst's validation script(s)
    //   → gatekeeper / illustrator / author
    //
    // Previously chronicle/gatekeeper/lab-director/illustrator/author
    // all waited on completed_analysts >= 1, which meant chronicle —
    // the graph/trend builder — could never run before analyst, so
    // analyst had no graphs to ground its hypothesis. That ordering is
    // inverted here.
    // Opened because upstream failed, so it cannot be held until upstream
    // succeeds. See lane_is_blocking_failure_recovery.
    let recovery_planning_lane = if contract.role == "lab-director" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        role_plan_path.exists()
            && read_json(&role_plan_path)
                .ok()
                .map(|role_plan| lane_is_blocking_failure_recovery(&role_plan))
                .unwrap_or(false)
    } else {
        false
    };
    if contract.role == "lab-director" && completed_scouts < 1 && !recovery_planning_lane {
        return Ok(Some(format!(
            "waiting-for-literature-scout scout_literature_completed={}",
            completed_scouts
        )));
    }
    if contract.role == "lab-director" && completed_chronicles < 1 && !recovery_planning_lane {
        return Ok(Some(format!(
            "waiting-for-chronicle chronicle_completed={}",
            completed_chronicles
        )));
    }
    // The opening decision waits for the field landscape a landscape scout is
    // building, so the first lead is chosen from the field and not from whatever
    // the first scout happened to retrieve (cycle-b-20260918, 2026-09-18: the
    // first query was already the most ready instrument's topic). Held only while
    // a landscape scout is actually open -- see director_field_landscape_wait_reason.
    if contract.role == "lab-director"
        && !recovery_planning_lane
        && !snapshot.has_lab_director_hypothesis
    {
        if let Some(reason) = director_field_landscape_wait_reason(paths, cycle_id) {
            return Ok(Some(reason));
        }
        // And then for the expert selection: the beliefs, slate, panel,
        // novelty and feasibility lanes, and the owner's pick
        // (cycle-b-20260919, 2026-09-19: one director alone chose a
        // diagnostic on the most ready instrument). Held only while the
        // pipeline can still move -- see director_expert_selection_wait_reason:
        // "waiting-for-expert-selection" or "waiting-for-owner-selection".
        if let Some(reason) = director_expert_selection_wait_reason(paths, cycle_id) {
            return Ok(Some(reason));
        }
    }
    if contract.role == "chronicle" && completed_scouts < 1 {
        return Ok(Some(format!(
            "waiting-for-literature-scout-before-kg scout_literature_completed={}",
            completed_scouts
        )));
    }
    // A dataset scout cannot complete under the approved-scholarly policy: that
    // policy forbids external dataset acquisition and rewrites every
    // data_acquisition_followup into a literature scout
    // (role_plan_01::effective_scout_followup_action). Holding Chronicle for one
    // is holding it for a lane the configuration will never produce.
    //
    // MEASURED ON cycle-b-20260918, 2026-09-18. The literature search
    // completed with 27 papers and the cycle then made no further progress:
    // Chronicle waited on data_scout_completed=0, lab-director waited on
    // Chronicle, analyst waited on the hypothesis, and the planner's
    // data_acquisition_followup was dispatched as yet another literature scout.
    let data_acquisition_is_policy_forbidden = std::env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY")
        .map(|value| value.trim() == "approved-scholarly-metadata-v1")
        .unwrap_or(false);
    if contract.role == "chronicle"
        && snapshot.completed_data_scouts < 1
        && !data_acquisition_is_policy_forbidden
    {
        return Ok(Some(format!(
            "waiting-for-data-scout-before-kg data_scout_completed={}",
            snapshot.completed_data_scouts
        )));
    }
    if contract.role == "lab-director" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        if role_plan_path.exists() {
            let role_plan = read_json(&role_plan_path)?;
            let is_requery_followup = role_plan.get("action_type").and_then(Value::as_str)
                == Some("lab_director_requery_followup");
            let is_runner_recovery_requery = is_requery_followup
                && role_plan
                    .get("source_brief_id")
                    .and_then(Value::as_str)
                    .map(|source| source.starts_with("labdirector-runner-recovery-"))
                    .unwrap_or(false);
            // The graphs are built from the scout corpus, so a recovery lane
            // opened because the scouts failed can never satisfy this either.
            // Exempting only the scout gate moved this lane's blocker from
            // `waiting-for-literature-scout` to `waiting-for-chronicle-graphs`
            // and changed nothing -- the same half-exemption as 4b37d60.
            if !chronicle_graph_artifacts_ready(paths, cycle_id)
                && !lane_is_blocking_failure_recovery(&role_plan)
                && !(is_requery_followup && chronicle_requery_context_ready(paths, cycle_id))
            {
                return Ok(Some(
                    "waiting-for-chronicle-graphs literature_graph=false data_graph=false trend_summary=false"
                        .to_string(),
                ));
            }
            if role_plan.get("action_type").and_then(Value::as_str)
                == Some("lab_director_requery_followup")
                && !is_runner_recovery_requery
                && completed_labdirector_requery_at_or_after(
                    paths,
                    cycle_id,
                    fs::metadata(&role_plan_path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .map(DateTime::<Utc>::from),
                )?
                && !chronicle_evidence_newer_than_labdirector_requery(paths, cycle_id)?
                && !latest_completed_followup_action_at(
                    paths,
                    cycle_id,
                    "chronicle",
                    "chronicle_evidence_request_followup",
                    None,
                )?
                .zip(
                    fs::metadata(&role_plan_path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .map(DateTime::<Utc>::from),
                )
                .map(|(chronicle_completed_at, role_plan_modified_at)| {
                    chronicle_completed_at > role_plan_modified_at
                })
                .unwrap_or(false)
            {
                return Ok(Some(
                    "blocked-by-completed-labdirector-requery duplicate_requery=true".to_string(),
                ));
            }
        }
    }
    if contract.role == "analyst" && completed_scouts < 1 {
        return Ok(Some(format!(
            "waiting-for-literature-scout scout_literature_completed={}",
            completed_scouts
        )));
    }
    // Analyst must normally wait for the lab-director hypothesis artifact.
    // Pivot analyst followups are the exception: their purpose is to create a
    // structurally new hypothesis family after pre-gate stagnation, so gating
    // them on the missing old lab-director hypothesis deadlocks the recovery
    // loop and only spawns more pending pivot lanes.
    if contract.role == "analyst" && !has_lab_director_hypothesis {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        let analyst_can_bootstrap_hypothesis = role_plan_path.exists()
            && read_json(&role_plan_path)
                .ok()
                .map(|role_plan| {
                    analyst_role_plan_can_bootstrap_without_labdirector_hypothesis(&role_plan)
                })
                .unwrap_or(false);
        if !analyst_can_bootstrap_hypothesis {
            return Ok(Some(format!(
                "waiting-for-lab-director-hypothesis artifact_exists=false path={}",
                lab_director_hypothesis_path.display()
            )));
        }
    }
    // The LabDirector's simulation orders are this cycle's data, and an analyst
    // started before an engineer has written them has nothing to analyse -- it
    // would defer on `no_matching_bundle` (cycle-b-20260918, 2026-09-18).
    // No orders, or orders an engineer settled without data, hold no analyst:
    // see simulation_data_wait_reason.
    //
    // The lab-runner is not held here too. Its analyst now starts only once the
    // data exists, and a wait keyed on a path in a handoff, with no order behind
    // it, is one no engineer is ever dispatched to release.
    if contract.role == "analyst" {
        if let Some(reason) = simulation_data_wait_reason(paths, cycle_id)? {
            return Ok(Some(reason));
        }
    }
    if contract.role == "gatekeeper" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        let role_plan = role_plan_path
            .exists()
            .then(|| read_json_cached(&role_plan_path).ok())
            .flatten();
        let is_gate_review = role_plan
            .as_ref()
            .and_then(|role_plan| role_plan.get("action_type"))
            .and_then(Value::as_str)
            == Some("independent_gate_review_followup");
        if is_gate_review {
            // MEASURED ON cycle-a-20260919, 2026-10-02: six gate
            // reviews were recorded as awaiting a lab-runner while the current
            // LabDirector simulation order still needed an engineer. No runner
            // can execute the analysis handoff before that bundle exists, so
            // name the direct prerequisite that scheduling can actually create.
            if let Some(reason) = simulation_data_wait_reason(paths, cycle_id)? {
                return Ok(Some(reason));
            }
            let target_rubric = role_plan
                .as_ref()
                .and_then(|role_plan| role_plan.get("planner_metadata"))
                .and_then(|item| item.get("target_rubric"))
                .or_else(|| {
                    role_plan
                        .as_ref()
                        .and_then(|role_plan| role_plan.get("target_rubric"))
                })
                .and_then(Value::as_str);
            if let Some(reason) = gate_review_has_nothing_new(paths, cycle_id, target_rubric) {
                return Ok(Some(reason));
            }
        }
    }
    let evidence_bound_gatekeeper_review = if contract.role == "gatekeeper" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        role_plan_path.exists()
            && read_json(&role_plan_path)
                .ok()
                .map(|role_plan| gatekeeper_review_has_bound_validation_evidence(&role_plan))
                .unwrap_or(false)
    } else {
        false
    };
    let executable_handoff_lab_runner = if contract.role == "lab-runner" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        role_plan_path.exists()
            && read_json(&role_plan_path)
                .ok()
                .map(|role_plan| lab_runner_methods_followup_has_executable_handoff(&role_plan))
                .unwrap_or(false)
    } else {
        false
    };
    // A lead with nothing to fetch is not waiting for data — the cycle is the
    // thing that produces it. Holding a lane here is a closed circle; see
    // lead_has_nothing_to_materialize for the cycle-g-v79 measurement.
    //
    // This deliberately does NOT name a role. The cycle-g-v79 fix exempted only
    // lab-runner, which unbolted one door of two: the analyst stayed held here,
    // and the runner it released was then held 120 lines below on
    // `analyst_completed=0`. cycle-g-v87 ran the full circle -- 18 analyst lanes
    // pending and 0 completed, 13 runner lanes pending, the gate round rejecting
    // the lead because "the sole runner record is not_applicable and cannot
    // substantiate any result".
    //
    // The gate asks one question: has this lead's validation data been fetched.
    // When the lead generates its data at run time there is no fetch, so the
    // question has no subject -- for the analyst designing the run exactly as
    // much as for the runner performing it. A lead naming a real accession still
    // gates every role normally.
    let nothing_to_materialize = lead_has_nothing_to_materialize(paths, cycle_id);
    if matches!(
        contract.role.as_str(),
        "analyst" | "lab-runner" | "gatekeeper"
    ) && has_lab_director_hypothesis
        && !validation_materialization_gate_passed(paths, cycle_id)?
        && !evidence_bound_gatekeeper_review
        && !executable_handoff_lab_runner
        && !nothing_to_materialize
    {
        return Ok(Some(
            "waiting-for-validation-materialization-gate validation_data_status=needs_materialization".to_string(),
        ));
    }
    if matches!(contract.role.as_str(), "gatekeeper") && completed_runners < 1 {
        return Ok(Some(format!(
            "waiting-for-core-experiments lab_runner_completed={}",
            completed_runners
        )));
    }
    if let Some(post_run_blocker) = snapshot.pending_runner_post_run_review.as_ref() {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        let role_plan = if role_plan_path.exists() {
            read_json(&role_plan_path).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let action_type = role_plan
            .get("action_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let source_brief_id = role_plan
            .get("source_brief_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let labdirector_is_runner_recovery = contract.role == "lab-director"
            && action_type == "lab_director_requery_followup"
            && source_brief_id.starts_with("labdirector-runner-recovery-");
        let labdirector_is_gate_consumer = contract.role == "lab-director"
            && matches!(
                action_type,
                "gate_restart_followup" | "analyst_handoff_review_followup"
            );
        // MEASURED ON cycle-a-20260919, 2026-10-29: queued analysts
        // 1337 and 1357 started while the preceding analysts' executable
        // handoffs were waiting for runners 803 and 819. Both rebuilt the same
        // primary contract without the result that completed seconds later,
        // and both handoffs were consequently discarded as already measured.
        // Let the runner finish first; launch-time context refresh can then turn
        // the queued analyst into an interpretation of that measurement.
        let analyst_would_rebuild_pending_handoff = contract.role == "analyst"
            && action_type != "runner_result_interpretation_followup"
            && post_run_blocker.starts_with("waiting-for-latest-analyst-handoff-runner");
        if !labdirector_is_runner_recovery
            && (matches!(
                contract.role.as_str(),
                "gatekeeper" | "illustrator" | "author"
            ) || labdirector_is_gate_consumer
                || analyst_would_rebuild_pending_handoff)
        {
            return Ok(Some(post_run_blocker.clone()));
        }
    }
    if matches!(contract.role.as_str(), "gatekeeper") {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        let role_plan = role_plan_path.exists().then(|| read_json(&role_plan_path).ok()).flatten();
        let is_independent_gate_review = role_plan
            .as_ref()
            .and_then(|role_plan| role_plan.get("action_type"))
            .and_then(Value::as_str)
            == Some("independent_gate_review_followup");
        let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
        if is_independent_gate_review && gate_review_path.exists() {
            let gate_review = read_json(&gate_review_path)?;
            let pending_rubric_count = gate_review
                .get("gatekeeper_pending_rubrics")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let gate_review_complete = gate_review
                .get("gatekeeper_review_status")
                .and_then(Value::as_str)
                == Some("parsed")
                && pending_rubric_count == 0;
            let authoritative_lead = read_json(
                &state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json")),
            )
            .unwrap_or(Value::Null);
            // MEASURED ON cycle-a-20260919, 2026-10-08: the cycle
            // stayed at conclusion while followup-gatekeeper-363, already
            // briefed on support_topology_randomized_intervention, remained
            // pending. A refresh called the gate "parsed" from retired,
            // unstamped reviews and this execution-time gate then made the only
            // current-lead review impossible to run. A materialized review of
            // the authoritative lead must be allowed to replace that stale
            // aggregate; old-lead queued reviews remain closed here.
            let targets_current_lead = role_plan.as_ref().is_some_and(|role_plan| {
                gatekeeper_plan_targets_current_lead(role_plan, &authoritative_lead)
            });
            if gate_review_complete && !targets_current_lead {
                return Ok(Some(
                    "blocked-by-completed-gatekeeper-review pending_rubrics=0".to_string(),
                ));
            }
        }
    }
    // An explicit, recorded owner authorisation releases the document stage. The
    // gate's verdict is unchanged by it; this is a door, not a rewrite.
    //
    // It has to clear BOTH holds. cycle-g-v89 showed why: with the authorisation
    // written, author-01 still sat pending on
    // `waiting-for-hypothesis-strategy`, because the conclusion review had
    // recommended lab_director_requery_followup and
    // hypothesis_regeneration_followup among its eleven follow-ups. That is
    // advice on how to PASS the gate, not a reason to refuse to record the result
    // that already exists -- and the owner deciding to document a cycle has
    // already accounted for the gate saying no.
    //
    // Same shape as 4b37d60: an exemption that named one of the two roles a gate
    // held, so the traffic simply moved to the door still bolted.
    let document_stage_released = document_stage_authorized(paths, cycle_id);
    if matches!(contract.role.as_str(), "illustrator" | "author")
        && snapshot.conclusion_needs_hypothesis_strategy
        && !document_stage_released
    {
        return Ok(Some(
            "waiting-for-hypothesis-strategy conclusion_requires_lab_director_requery=true"
                .to_string(),
        ));
    }
    if matches!(contract.role.as_str(), "illustrator" | "author")
        && !snapshot.hypothesis_gate_passed
        && !document_stage_released
    {
        return Ok(Some(
            "waiting-for-hypothesis-gate gate_passed=false".to_string(),
        ));
    }
    if matches!(contract.role.as_str(), "illustrator" | "author") && completed_runners < 1 {
        return Ok(Some(format!(
            "waiting-for-core-experiments lab_runner_completed={}",
            completed_runners
        )));
    }
    // chronicle has no wait gate — it starts as soon as the cycle does.
    if contract.role != "lab-runner" && contract.role != "analyst" {
        return Ok(None);
    }
    // The instrument-probe lane waits for NOTHING upstream. It measures what the
    // renderer can observe, so it needs no scout, no analyst and no hypothesis -
    // and the gates below would hold it behind exactly the evidence chain it
    // exists to unblock.
    //
    // cycle-g-v83 caught this the hard way: the lane was planned correctly
    // (lane_kind=instrument_probe, requires_analyst_handoff=false) and then sat
    // `pending` behind "waiting-for-upstream-evidence analyst_completed=0", which
    // is the v82 deadlock one layer up - no analyst without a hypothesis, no
    // hypothesis without a verified instrument, no instrument without this lane.
    // A field in the role plan does not move a gate; the gate has to know.
    if contract.role == "lab-runner" {
        let probe_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        if probe_plan_path.exists() {
            let probe_plan = read_json(&probe_plan_path)?;
            if probe_plan.get("lane_kind").and_then(Value::as_str) == Some("instrument_probe") {
                return Ok(None);
            }
        }
    }
    if contract.role == "lab-runner" && (completed_scouts < 1 || completed_analysts < 1) {
        return Ok(Some(format!(
            "waiting-for-upstream-evidence literature_scout_completed={} analyst_completed={}",
            completed_scouts, completed_analysts
        )));
    }
    if contract.role == "lab-runner"
        && contract.lane_id != "lab-runner-01"
        && completed_analysts < 2
    {
        return Ok(Some(format!(
            "waiting-for-rival-analyst-handoffs analyst_completed={}",
            completed_analysts
        )));
    }
    if contract.role == "lab-runner" {
        let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
        if role_plan_path.exists() {
            let role_plan = read_json(&role_plan_path)?;
            if role_plan
                .get("planner_metadata")
                .and_then(|item| item.get("runner_handoff_required"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Ok(Some(
                    "waiting-for-analyst-handoff-reroute runner_handoff_required=true".to_string(),
                ));
            }
        }
        match snapshot.latest_analyst_handoff_signal.as_ref() {
            None => {
                return Ok(Some(
                    "waiting-for-analyst-handoff no_completed_analyst_handoff=true".to_string(),
                ));
            }
            Some(signal) => {
                let payload = signal.get("payload").unwrap_or(&Value::Null);
                if !analyst_handoff_is_executable(payload) {
                    let reason = payload
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("missing_executable_blueprint");
                    return Ok(Some(format!(
                        "waiting-for-data-acquisition analyst_handoff_not_executable=true reason={reason}"
                    )));
                }
            }
        }
    }
    Ok(None)
}

pub(crate) fn analyst_role_plan_can_bootstrap_without_labdirector_hypothesis(
    role_plan: &Value,
) -> bool {
    let action_type = role_plan
        .get("action_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(
        action_type,
        "pivot_followup"
            | "chronicle_required_evidence"
            | "chronicle_brainstorm_followup"
            | "runner_failure_recovery_followup"
            | "runner_scientific_recovery_followup"
    ) {
        return true;
    }
    let planner_metadata = role_plan.get("planner_metadata").unwrap_or(&Value::Null);
    planner_metadata
        .get("analyst_handoff_required")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || planner_metadata
            .get("brainstorm_frame")
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

/// Where a lane sits in the dispatch order.
///
/// `document_stage_released` is the owner's explicit authorization to write the
/// cycle up. When it is set, the author and illustrator lanes sort to the very
/// front, ahead of recovery.
///
/// MEASURED ON cycle-g-v89: author-01 was never blocked, it was outranked. The
/// role table below puts author last, max-concurrency is 3, and the cycle created
/// 172 analyst follow-ups -- the slots ahead of it were refilled faster than they
/// drained, and the cycle reached the budget wall with the lane still pending.
/// illustrator-01 got through only because role_rank 6 beats 7.
///
/// That order is correct while the cycle is still doing science; the paper is
/// written once the evidence is in. It stops being correct the moment a human has
/// said to write it now. An authorization that the scheduler never reaches is a
/// door nobody walks through.
pub(crate) fn lane_priority_rank_with_authorization(
    contract: &LaneContract,
    document_stage_released: bool,
) -> (u8, u8, String) {
    let lane_id = contract.lane_id.as_str();
    let is_followup = lane_id.starts_with("followup-");
    let is_recovery = lane_id.contains("-recovery-");
    if document_stage_released && matches!(contract.role.as_str(), "author" | "illustrator") {
        return (0, 0, contract.lane_id.clone());
    }
    let phase_rank = if is_recovery {
        0
    } else if !is_followup {
        1
    } else {
        2
    };
    let role_rank = match contract.role.as_str() {
        "scout" => 0,
        "analyst" => 1,
        "lab-runner" => 2,
        "chronicle" => 3,
        "gatekeeper" => 4,
        "lab-director" => 5,
        "illustrator" => 6,
        "author" => 7,
        _ => 8,
    };
    (phase_rank, role_rank, contract.lane_id.clone())
}

/// The unauthorized ordering, which is what every caller outside the dispatch
/// loop wants.
pub(crate) fn lane_priority_rank(contract: &LaneContract) -> (u8, u8, String) {
    lane_priority_rank_with_authorization(contract, false)
}

pub fn existing_task_signatures(paths: &AppPaths, cycle_id: &str) -> Result<HashSet<String>> {
    let mut signatures = HashSet::new();
    for (_, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let task_file = lane_dir.join("task.md");
        if task_file.exists() {
            let body = fs::read_to_string(task_file)?;
            signatures.insert(slugify(&body));
            let normalized = normalize_followup_attempt_markers(&body);
            if normalized != body {
                signatures.insert(slugify(&normalized));
            }
        }
    }
    Ok(signatures)
}

pub(crate) fn normalize_followup_attempt_markers(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0;
    while let Some(rel_start) = body[cursor..].find(" [") {
        let start = cursor + rel_start;
        let inner_start = start + " [".len();
        if let Some(rel_end) = body[inner_start..].find(']') {
            let end = inner_start + rel_end;
            if is_followup_attempt_marker(&body[inner_start..end]) {
                out.push_str(&body[cursor..start]);
                cursor = end + 1;
                continue;
            }
        }
        out.push_str(&body[cursor..inner_start]);
        cursor = inner_start;
    }
    out.push_str(&body[cursor..]);
    out
}

pub(crate) fn is_followup_attempt_marker(marker: &str) -> bool {
    let Some((prefix, attempt_number)) = marker.rsplit_once(' ') else {
        return false;
    };
    !attempt_number.is_empty()
        && attempt_number.chars().all(|ch| ch.is_ascii_digit())
        && prefix.split_whitespace().last() == Some("attempt")
}

#[cfg(test)]
mod chronicle_data_scout_gate_tests {
    use super::*;
    use tempfile::TempDir;

    fn paths_for(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("datasets"),
            stats_driver_script: std::path::PathBuf::from("unused-stats.py"),
            literature_driver_script: std::path::PathBuf::from("unused-literature.py"),
        }
    }

    fn chronicle_contract(root: &std::path::Path) -> LaneContract {
        serde_json::from_value(json!({
            "cycle_id": "cycle-kg", "lane_id": "chronicle-01", "role": "chronicle",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": root, "task_file": root.join("task.md"),
            "output_artifact": root.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap()
    }

    /// The literature scout completed; no data scout has, and under the approved
    /// scholarly policy none ever can.
    fn snapshot_without_data_scout(paths: &AppPaths) -> DependencySnapshot {
        let mut snapshot = dependency_snapshot(paths, "cycle-kg").unwrap();
        snapshot.completed_scouts = 1;
        snapshot.completed_data_scouts = 0;
        snapshot
    }

    #[test]
    fn a_policy_that_forbids_dataset_acquisition_does_not_hold_chronicle_for_a_data_scout() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        let contract = chronicle_contract(temp.path());
        let snapshot = snapshot_without_data_scout(&paths);

        let previous = std::env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY").ok();
        std::env::remove_var("RESEARCHLAB_LITERATURE_NETWORK_POLICY");
        let blocked = raw_dependency_blocker_for_lane_with_snapshot(&paths, "cycle-kg", &contract, &snapshot).unwrap();
        assert!(
            blocked.as_deref().unwrap_or("").contains("waiting-for-data-scout-before-kg"),
            "without the policy the data-scout gate still holds: {blocked:?}",
        );

        std::env::set_var("RESEARCHLAB_LITERATURE_NETWORK_POLICY", "approved-scholarly-metadata-v1");
        let released = raw_dependency_blocker_for_lane_with_snapshot(&paths, "cycle-kg", &contract, &snapshot).unwrap();
        assert!(
            !released.as_deref().unwrap_or("").contains("waiting-for-data-scout-before-kg"),
            "chronicle held for a data scout the policy forbids: {released:?}",
        );

        match previous {
            Some(value) => std::env::set_var("RESEARCHLAB_LITERATURE_NETWORK_POLICY", value),
            None => std::env::remove_var("RESEARCHLAB_LITERATURE_NETWORK_POLICY"),
        }
    }
}

#[cfg(test)]
mod simulation_data_gate_tests {
    use super::*;
    use tempfile::TempDir;

    fn paths_for(root: &std::path::Path) -> AppPaths {
        AppPaths {
            project_root: root.to_path_buf(),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("datasets"),
            stats_driver_script: std::path::PathBuf::from("unused-stats.py"),
            literature_driver_script: std::path::PathBuf::from("unused-literature.py"),
        }
    }

    fn analyst_contract(root: &std::path::Path) -> LaneContract {
        serde_json::from_value(json!({
            "cycle_id": "cycle-sim", "lane_id": "followup-analyst-01", "role": "analyst",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": root, "task_file": root.join("task.md"),
            "output_artifact": root.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap()
    }

    fn gatekeeper_contract(root: &std::path::Path) -> LaneContract {
        serde_json::from_value(json!({
            "cycle_id": "cycle-sim", "lane_id": "followup-gatekeeper-01", "role": "gatekeeper",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": root, "task_file": root.join("task.md"),
            "output_artifact": root.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap()
    }

    fn analyst_blocker(paths: &AppPaths, root: &std::path::Path) -> Option<String> {
        let mut snapshot = dependency_snapshot(paths, "cycle-sim").unwrap();
        snapshot.completed_scouts = 1;
        snapshot.has_lab_director_hypothesis = true;
        raw_dependency_blocker_for_lane_with_snapshot(paths, "cycle-sim", &analyst_contract(root), &snapshot)
            .unwrap()
    }

    fn order() -> Value {
        json!({
            "request_id": "grasp_sweep",
            "simulator_backend": "mujoco",
            "output_path": ".research-lab/datasets/cycle-sim/simulations/grasp_sweep/episodes.csv",
        })
    }

    #[test]
    fn a_gate_review_awaits_the_engineer_while_its_simulation_bundle_is_pending() {
        // MEASURED ON cycle-a-20260919, 2026-10-02: the dependency
        // stall record named lab-runner for six gatekeepers even though the v3
        // order was only partially materialized and still needed an engineer.
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(
            &state_root(&paths).join("cycle-sim-lab-director-hypothesis.json"),
            &json!({"statement": "the lead under review"}),
        )
        .unwrap();
        fs::write(
            state_root(&paths).join("cycle-sim-hypothesis-progress.jsonl"),
            format!(
                "{}\n",
                json!({
                    "memory_type": "decision", "task_id": "round-49",
                    "ts": "2020-01-01T00:00:00Z",
                    "content": {
                        "statement": "the lead under review",
                        "rubric": [{"name": "technical_quality", "score": 51}]
                    }
                })
            ),
        )
        .unwrap();
        let role_plan_path =
            lane_role_plan_path(&paths, "cycle-sim", "followup-gatekeeper-01");
        write_json(
            &role_plan_path,
            &json!({"action_type": "independent_gate_review_followup"}),
        )
        .unwrap();
        record_lab_director_simulation_orders(
            &paths,
            "cycle-sim",
            "followup-lab-director-01",
            &json!({"simulation_orders": [order()]}),
        )
        .unwrap();

        let snapshot = dependency_snapshot(&paths, "cycle-sim").unwrap();
        let blocker = dependency_blocker_detail_for_lane_with_snapshot(
            &paths,
            "cycle-sim",
            &gatekeeper_contract(temp.path()),
            &snapshot,
        )
        .unwrap()
        .expect("the incomplete simulation order should hold the review");
        assert_eq!(
            blocker.reason,
            "waiting-for-simulation-data request_id=grasp_sweep (engineer)"
        );
        assert_eq!(blocker.awaited_role.as_deref(), Some("engineer"));
    }

    #[test]
    fn an_analyst_waits_for_the_directors_simulation_data_and_is_released_by_it() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        fs::create_dir_all(state_root(&paths)).unwrap();
        // Without orders the gate says whatever it said before simulations existed.
        let baseline = analyst_blocker(&paths, temp.path());
        assert!(
            !baseline.as_deref().unwrap_or("").starts_with("waiting-for-simulation-data"),
            "{baseline:?}"
        );

        record_lab_director_simulation_orders(
            &paths,
            "cycle-sim",
            "followup-lab-director-01",
            &json!({"simulation_orders": [order()]}),
        )
        .unwrap();
        assert_eq!(
            analyst_blocker(&paths, temp.path()).as_deref(),
            Some("waiting-for-simulation-data request_id=grasp_sweep (engineer)")
        );

        let out = paths.runtime_root.join("datasets/cycle-sim/simulations/grasp_sweep");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("episodes.csv"), "friction,seed,lift_success\n0.4,1,1\n").unwrap();
        // Rows without a manifest are not yet auditable data.
        assert!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap().is_some());
        // A manifest that does not show the arms worked in support is not
        // auditable data either: the analyst keeps waiting.
        fs::write(out.join("manifest.json"), "{}").unwrap();
        assert!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap().is_some());
        write_json(
            &out.join("manifest.json"),
            &json!({
                "pilot": {"passed": true, "seeds": [1], "episodes_per_condition": 10, "criteria_results": []},
                "in_support_validation": {
                    "passed": true,
                    "arms": [{"name": "gripper", "in_support_success_rate": 0.8, "episodes": 10}]
                }
            }),
        )
        .unwrap();
        assert_eq!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap(), None);
        assert_eq!(analyst_blocker(&paths, temp.path()), baseline, "the data exists and the analyst still waits");
    }

    // An engineer that finished without data is an attempt, not an answer: the
    // analyst waits while a retry is due, and stops waiting once the order's
    // attempts run out, so no analyst is held for good.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-01
    // ended `completed` with no episodes.csv and the order counted as settled
    // on the spot: no engineer was dispatched again and the data never came.
    #[test]
    fn an_order_an_engineer_settled_without_data_holds_no_analyst() {
        let temp = TempDir::new().unwrap();
        let paths = paths_for(temp.path());
        fs::create_dir_all(state_root(&paths)).unwrap();
        record_lab_director_simulation_orders(
            &paths,
            "cycle-sim",
            "followup-lab-director-01",
            &json!({"simulation_orders": [order()]}),
        )
        .unwrap();
        let engineer = "followup-engineer-01";
        create_lane_contract(&paths, "cycle-sim", engineer, "engineer", "codex-agent", "read-write-scoped", "run it")
            .unwrap();
        let dir = lane_root(&paths, "cycle-sim", engineer);
        write_json(
            &dir.join("role-plan.json"),
            &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
        )
        .unwrap();
        // Open: the analyst waits on it.
        assert!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap().is_some());
        write_json(&dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        // Still due another engineer, so the wait stands.
        assert!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap().is_some());

        let retry = "followup-engineer-02";
        create_lane_contract(&paths, "cycle-sim", retry, "engineer", "codex-agent", "read-write-scoped", "run it")
            .unwrap();
        let retry_dir = lane_root(&paths, "cycle-sim", retry);
        write_json(
            &retry_dir.join("role-plan.json"),
            &json!({"action_type": SIMULATION_DATA_GENERATION_ACTION, "source_brief_id": "simulation-grasp_sweep"}),
        )
        .unwrap();
        write_json(&retry_dir.join("final-status.json"), &json!({"status": "completed"})).unwrap();
        assert_eq!(simulation_data_wait_reason(&paths, "cycle-sim").unwrap(), None);
    }
}
