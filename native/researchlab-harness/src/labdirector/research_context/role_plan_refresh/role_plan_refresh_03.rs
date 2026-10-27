#![allow(unused_imports)]
use super::*;

/// The current analysis contract's id, from the one place that computes it
/// (src/policy/analysis_contract.js). None when contracts are not in use for
/// the cycle or it cannot be computed: then nothing is held back for it.
pub(crate) fn current_analysis_contract_id(paths: &AppPaths, cycle_id: &str) -> Option<String> {
    let script = paths.project_root.join("src/policy/analysis_contract.js");
    if !script.is_file() {
        return None;
    }
    let output = std::process::Command::new("node")
        .arg(&script)
        .arg(&paths.project_root)
        .arg(cycle_id)
        .arg("--current")
        .current_dir(&paths.project_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice::<Value>(&output.stdout)
        .ok()?
        .get("contract_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// (bound, current) when a primary handoff names an analysis contract other
/// than the current one. Supporting-only handoffs do not validate that claim.
pub(crate) fn handoff_contract_is_stale(
    paths: &AppPaths,
    cycle_id: &str,
    handoff: &Value,
) -> Option<(String, String)> {
    // MEASURED ON cycle-a-20260919, 2026-10-18: analyst-1016's
    // supporting-only contact audit was discarded when result-informed prose
    // changed the contract id, although supporting preflight deliberately does
    // not bind that audit to the primary claim. Keep fail-closed contract
    // identity for primary evidence, but do not apply it to supporting work.
    if handoff_is_supporting_only(handoff) {
        return None;
    }
    let bound = handoff
        .pointer("/analysis_contract/contract_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())?
        .to_string();
    let current = current_analysis_contract_id(paths, cycle_id)?;
    (bound != current).then_some((bound, current))
}

pub(crate) fn note_stale_handoff_contract(paths: &AppPaths, cycle_id: &str, handoff_path: &str, stale: &(String, String)) {
    let notices = crate::core::support::harness_notices_path(paths, cycle_id);
    // As the path is written in the notice: JSON-escaped.
    let path_in_notice = serde_json::to_string(handoff_path).unwrap_or_default();
    let already = fs::read_to_string(&notices)
        .map(|text| {
            text.lines().any(|line| {
                line.contains("\"handoff_contract_stale\"") && line.contains(&path_in_notice) && line.contains(&stale.1)
            })
        })
        .unwrap_or(false);
    if already {
        return;
    }
    let _ = crate::chronicle::reporting::append_event(
        &notices,
        "handoff_contract_stale",
        json!({
            "handoff_path": handoff_path,
            "bound_contract_id": stale.0,
            "current_contract_id": stale.1,
            "effect": "no lab-runner is created for this handoff; an analyst must re-issue it under the current contract",
        }),
    );
}

/// How many verified primary measurements of one analysis contract are run
/// before another primary execution of it is held.
///
/// MEASURED ON cycle-a-20260919, 2026-10-26: runners 779 and 780
/// ran two scripts for the same estimands on the same sealed data, then runner
/// 781 existed only to compare their identical results. Once the registered
/// measurement exists, later analysts must receive it instead of reproducing it.
pub(crate) const CONTRACT_MEASUREMENTS_BEFORE_HOLD: usize = 1;

/// Whether every check of the handoff is a supporting audit
/// (`column_mapping.analysis_evidence_role = "supporting"`), as the runner's
/// contract preflight reads it (drivers/analysis/python_stats_lib/analysis_contract.py).
pub(crate) fn handoff_is_supporting_only(handoff: &Value) -> bool {
    let checks = handoff
        .get("handoff_checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    !checks.is_empty() && checks.iter().all(|check| column_mapping_value(check, "analysis_evidence_role") == Some("supporting"))
}

/// One `column_mapping` entry of a handoff check, in either spelling: the
/// `{key: column}` object older handoffs use, or the `[{"key", "column"}]`
/// pairs the analyst schema writes (drivers/.../blueprint_model.py,
/// _column_mapping_dict). MEASURED ON cycle-a-20260919, 2026-10-18:
/// analysts 1011, 1012, and 1014 used the pairs for supporting audits and were
/// held as primary executions of an already measured contract.
pub(crate) fn column_mapping_value<'a>(check: &'a Value, key: &str) -> Option<&'a str> {
    match check.get("column_mapping")? {
        Value::Object(map) => map.get(key).and_then(Value::as_str),
        Value::Array(pairs) => pairs
            .iter()
            .find(|pair| pair.get("key").and_then(Value::as_str) == Some(key))
            .and_then(|pair| pair.get("column").and_then(Value::as_str)),
        _ => None,
    }
}

/// MEASURED ON cycle-a-20260919, 2026-10-18: runners 486/487 measured
/// one registered specification; a result-informed lead rewrite changed its
/// contract id and sent the same specification to runners 493/494. Claim prose
/// and registration ancestry do not make that a new execution.
pub(crate) fn primary_measurement_spec(contract: &Value) -> Option<Value> {
    let mut spec = contract.get("operational_spec")?.as_object()?.clone();
    for field in [
        "analysis_evidence_role",
        "canonical_statement",
        "canonical_estimands",
        "base_contract_id",
    ] {
        spec.remove(field);
    }
    (!spec.is_empty()).then_some(Value::Object(spec))
}

fn runner_analysis_contract(role_plan: &Value) -> Option<&Value> {
    [
        "/planner_metadata/analysis_request/analyst_handoff/analysis_contract",
        "/planner_metadata/analyst_handoff/analysis_contract",
        "/planner_metadata/cycle_analyst_handoff/payload/analysis_contract",
        "/analysis_request/analyst_handoff/analysis_contract",
        "/analyst_handoff/analysis_contract",
    ]
    .iter()
    .find_map(|pointer| role_plan.pointer(pointer))
}

/// The runner lanes whose result is a verified primary measurement of the
/// handoff's registered execution specification, oldest lane id first. A
/// result-informed claim rewrite can change the contract id, so a runner's
/// immutable role-plan snapshot supplies the substantive cross-contract match.
pub(crate) fn verified_primary_measurements(
    paths: &AppPaths,
    cycle_id: &str,
    contract: &Value,
) -> Result<Vec<String>> {
    let Some(contract_id) = contract.get("contract_id").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };
    let measurement_spec = primary_measurement_spec(contract);
    let mut lanes = Vec::new();
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id.contains("runner") {
            continue;
        }
        let Ok(preflight) = read_json(&lane_dir.join("analysis-contract-preflight.json")) else {
            continue;
        };
        let Some(executed_contract_id) = preflight.get("contract_id").and_then(Value::as_str) else {
            continue;
        };
        if executed_contract_id != contract_id {
            let role_plan = read_json_if_below(&lane_dir.join("role-plan.json"), 2 * 1024 * 1024)?
                .unwrap_or(Value::Null);
            let executed_spec = runner_analysis_contract(&role_plan).and_then(primary_measurement_spec);
            if measurement_spec.is_none() || executed_spec != measurement_spec {
                continue;
            }
        }
        let Ok(result) = read_json(&lane_dir.join("result.json")) else {
            continue;
        };
        let binding = result
            .get("analysis_contract_validation")
            .or_else(|| result.pointer("/validation_summary/analysis_contract_validation"));
        let field = |name: &str| binding.and_then(|item| item.get(name)).and_then(Value::as_str);
        if field("contract_id") == Some(executed_contract_id)
            && field("status") == Some("verified")
            && field("evidence_role") == Some("primary")
        {
            lanes.push(lane_id);
        }
    }
    Ok(lanes)
}

pub(crate) fn note_contract_already_measured(
    paths: &AppPaths,
    cycle_id: &str,
    handoff_path: &str,
    contract_id: &str,
    measured_by: &[String],
) {
    let notices = crate::core::support::harness_notices_path(paths, cycle_id);
    let path_in_notice = serde_json::to_string(handoff_path).unwrap_or_default();
    let already = fs::read_to_string(&notices)
        .map(|text| {
            text.lines()
                .any(|line| line.contains("\"contract_already_measured\"") && line.contains(&path_in_notice))
        })
        .unwrap_or(false);
    if already {
        return;
    }
    let _ = crate::chronicle::reporting::append_event(
        &notices,
        "contract_already_measured",
        json!({
            "handoff_path": handoff_path,
            "contract_id": contract_id,
            "measured_by": measured_by,
            "effect": "no lab-runner is created for another primary execution of this registered measurement specification; its estimates are in the runners named. A supporting audit (analysis_evidence_role=supporting) still runs, and a substantively changed specification is a new measurement",
        }),
    );
}

pub(crate) fn completed_analyst_post_run_report_exists(
    paths: &AppPaths,
    cycle_id: &str,
    runner_lane_id: &str,
) -> Result<bool> {
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_analyst(&lane_id) {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        let result_path = lane_dir.join("result.json");
        if !role_plan_path.exists() || !final_status_path.exists() || !result_path.exists() {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("analyst")
            || role_plan.action_type.as_deref() != Some("runner_result_interpretation_followup")
            || role_plan.source_brief_id.as_deref() != Some(runner_lane_id)
        {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let result = read_lane_result_json(&result_path)?;
        if analyst_post_run_report_declares_gate_ready(&result) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn completed_analyst_post_run_review_count(
    paths: &AppPaths,
    cycle_id: &str,
    runner_lane_id: &str,
) -> Result<usize> {
    let mut count = 0usize;
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if !lane_id_looks_like_analyst(&lane_id) {
            continue;
        }
        let role_plan_path = lane_dir.join("role-plan.json");
        let final_status_path = lane_dir.join("final-status.json");
        if !role_plan_path.exists() || !final_status_path.exists() {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("analyst")
            || role_plan.action_type.as_deref() != Some("runner_result_interpretation_followup")
            || role_plan.source_brief_id.as_deref() != Some(runner_lane_id)
        {
            continue;
        }
        let Some(final_status) = read_lane_final_status(&final_status_path)? else {
            continue;
        };
        if final_status.get("status").and_then(Value::as_str) == Some("completed") {
            count += 1;
        }
    }
    Ok(count)
}

/// Cap on how many runner-recovery requeries (lab_director_requery_followup with a
/// `labdirector-runner-recovery-*` source) may complete before the cycle stops looping
/// on degraded validation. Without it, every degraded lab-runner spawns a fresh per-lane
/// recovery requery, which re-briefs the analyst, which emits a new executable handoff,
/// which supersedes the next runner — an unbounded loop that keeps the pipeline from
/// quiescing so the gatekeeper never re-fires. Once the cap is reached we accept the
/// executed-but-degraded validation and let the gatekeeper judge it HONESTLY (we do not
/// relax the gate, force a hypothesis, or fake a pass — a genuinely weak validation still
/// scores low and the director can then make a real novelty pivot instead of re-revising).
pub(crate) const RUNNER_RECOVERY_ATTEMPT_CAP: usize = 6;

/// Count runner-recovery requeries that have been CREATED for the cycle (lab-director
/// lanes whose action_type is lab_director_requery_followup and whose source_brief_id
/// starts with `labdirector-runner-recovery-`), regardless of whether they completed.
/// We count created (not just completed) requeries on purpose: when the recovery
/// requeries themselves get starved/undispatched (stuck at no run-state), counting only
/// completed ones would leave the cap unreached forever and the gatekeeper deadlocked. A
/// cycle that has already SPAWNED this many degraded-runner recovery requeries has tried
/// to recover enough — accept the executed-but-degraded validation and let the gatekeeper
/// judge it honestly rather than deferring the gate forever.
pub(crate) fn completed_runner_recovery_requery_count(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<usize> {
    let mut count = 0usize;
    for (_lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        let role_plan_path = lane_dir.join("role-plan.json");
        if !role_plan_path.exists() {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&role_plan_path)? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("lab-director")
            || role_plan.action_type.as_deref() != Some("lab_director_requery_followup")
            || !role_plan
                .source_brief_id
                .as_deref()
                .map(|source| source.starts_with("labdirector-runner-recovery-"))
                .unwrap_or(false)
        {
            continue;
        }
        count += 1;
    }
    Ok(count)
}

/// Whether `text` names the lane `lane_id` as a whole token.
///
/// Directors write the lane as it reads in prose -- "Runner-152", "runner-152's
/// handoff", "followup-runner-152" -- so the `followup-` prefix is optional and
/// case is ignored, but the number must end there ("runner-15" is not
/// "runner-152") and the name must start there ("lab-runner-152" is another lane).
pub(crate) fn text_names_lane(text: &str, lane_id: &str) -> bool {
    let haystack = text.to_ascii_lowercase();
    let lane = lane_id.trim().to_ascii_lowercase();
    let short = lane.strip_prefix("followup-").unwrap_or(&lane);
    if short.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(found) = haystack[from..].find(short) {
        let start = from + found;
        let end = start + short.len();
        from = start + 1;
        let next_ok = bytes.get(end).is_none_or(|byte| !byte.is_ascii_alphanumeric());
        if !next_ok {
            continue;
        }
        let before = &haystack[..start];
        let prev_ok = match before.as_bytes().last() {
            None => true,
            Some(byte) if byte.is_ascii_alphanumeric() => false,
            Some(b'-') => short != lane.as_str() && before.ends_with("followup-"),
            Some(_) => true,
        };
        if prev_ok {
            return true;
        }
    }
    false
}

/// A LabDirector has already ruled on this runner: a director lane that completed
/// after the runner did, and whose result names it.
///
/// MEASURED ON cycle-a-20260919, 2026-10-06 12:45. Three
/// `labdirector-runner-recovery-*` director lanes opened at once for runners
/// 150, 151 and 152 -- next to two other director lanes -- although each runner
/// had already been ruled on by name: runner-150 by directors 459 and 460,
/// runner-151 by 460 and 461, runner-152 by 462 ("validly falsified the
/// protected action-support projection lead"). The recovery request is keyed
/// to its own brief id, so a ruling the director made in any other lane never
/// counted, and every degraded runner bought a fresh director call to repeat a
/// verdict already given.
pub(crate) fn runner_adjudicated_by_director(
    paths: &AppPaths,
    cycle_id: &str,
    runner_lane_id: &str,
) -> Result<bool> {
    let runner_dir = lane_root(paths, cycle_id, runner_lane_id);
    let Some(runner_done_ms) = file_modified_ms(&runner_dir.join("final-status.json")) else {
        return Ok(false);
    };
    for (lane_id, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        if lane_id == runner_lane_id {
            continue;
        }
        let final_status_path = lane_dir.join("final-status.json");
        let Some(done_ms) = file_modified_ms(&final_status_path) else {
            continue;
        };
        if done_ms <= runner_done_ms {
            continue;
        }
        let Some(role_plan) = read_role_plan_index_fields(&lane_dir.join("role-plan.json"))? else {
            continue;
        };
        if role_plan.role.as_deref() != Some("lab-director") {
            continue;
        }
        let completed = read_json(&final_status_path)
            .ok()
            .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string))
            .is_some_and(|status| status == "completed");
        if !completed {
            continue;
        }
        let Ok(result) = fs::read_to_string(lane_dir.join("result.json")) else {
            continue;
        };
        if text_names_lane(&result, runner_lane_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A completed lab-runner is "gate-ready" when it did NOT degrade and its analyst
/// quality standard is already satisfied (robust, quality-graded validation for the
/// current lead). Such a runner is sufficient evidence for the gatekeeper to review:
/// the separate analyst post-run interpretation is redundant, and a newer un-run
/// handoff (continuous lab-director/analyst churn) must not defer the gate forever.
pub(crate) fn runner_context_gate_ready(context: &Value) -> bool {
    let satisfied = context
        .get("analyst_quality_standard")
        .or_else(|| {
            context
                .get("validation_summary")
                .and_then(|value| value.get("analyst_quality_standard"))
        })
        .and_then(|value| value.get("satisfied"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let blueprints_failed = context
        .get("blueprints_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    satisfied && blueprints_failed == 0 && !runner_context_requires_handoff_revision(context)
}

/// True when this runner result is the boot-time instrument probe rather than a
/// validation run.
///
/// The probe reports `extracted_json.instrument_inventory` and a
/// `not_applicable` validation status. It measures what the container can do; it
/// tests no hypothesis, has no analyst handoff, and can never be gate-ready — so
/// treating it as "the latest completed runner" defers every gatekeeper forever.
/// cycle-g-v87 lost a whole cycle to exactly that: 33 lanes completed, 0 gate
/// rounds, 10 gatekeepers parked on `lab-runner-01`.
///
/// Matched on the result because the probe is selected by two different paths and
/// only one of them stamps the role plan.
pub(crate) fn runner_context_is_instrument_probe(context: &Value) -> bool {
    // The stamp the context builder lifts off the raw result. This is the field
    // that actually exists here; the ones below are for callers that pass a raw
    // result instead of a built context, and for the JS-stamped plan.
    if context.get("instrument_probe").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if context
        .get("extracted_json")
        .and_then(|value| value.get("instrument_inventory"))
        .is_some()
    {
        return true;
    }
    if context.get("instrument_inventory").is_some() {
        return true;
    }
    matches!(
        context.get("lane_kind").and_then(Value::as_str),
        Some("instrument_probe")
    )
}

pub(crate) fn latest_runner_post_run_review_blocker(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<String>> {
    let latest_completed = latest_completed_lab_runner_context(paths, cycle_id)?;
    // Gate-convergence guard: if a clean, analyst-quality-satisfied completed runner
    // already exists for the current lead, do NOT keep deferring the gatekeeper on a
    // churning newer handoff that has not yet been run. Without this, continuous
    // lab-director/analyst handoff generation defers the gate forever even though
    // robust validation evidence already exists.
    // Judge gate-readiness over ALL completed runners, not only the latest: a
    // clean gate-ready runner for the current lead (e.g. the render/validation
    // lab-runner) must release the gatekeeper even if a NEWER followup-runner
    // later completed in a degraded state and became the "latest". Otherwise the
    // gatekeeper is deferred forever on post-run-review / handoff-revision churn
    // while robust validation evidence already exists.
    let gate_ready = latest_completed
        .as_ref()
        .map(runner_context_gate_ready)
        .unwrap_or(false)
        || any_completed_lab_runner_gate_ready(paths, cycle_id)?;
    if !gate_ready {
        if let Some(latest_handoff_path) = latest_executable_analyst_handoff_path(paths, cycle_id)?
        {
            if latest_lab_runner_context_for_handoff(paths, cycle_id, &latest_handoff_path)?
                .as_ref()
                .map(|context| runner_context_is_exact_handoff(context, &latest_handoff_path))
                != Some(true)
            {
                return Ok(Some(format!(
                    "waiting-for-latest-analyst-handoff-runner analyst_handoff_path={}",
                    latest_handoff_path
                )));
            }
        }
    }
    let Some(runner_context) = latest_completed else {
        return Ok(None);
    };
    // The capability probe is not a validation run: it cannot carry an analyst
    // handoff and cannot reach a gate-ready status, so blocking on it is
    // permanent. Let the gatekeeper proceed and judge whatever evidence exists.
    if runner_context_is_instrument_probe(&runner_context) {
        return Ok(None);
    }
    let lane_id = runner_context
        .get("lane_id")
        .and_then(Value::as_str)
        .unwrap_or("lab-runner");
    let handoff_path = runner_context
        .get("analyst_handoff_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    if handoff_path.trim().is_empty() && !gate_ready {
        return Ok(Some(format!(
            "waiting-for-runner-execution-report runner_lane_id={} analyst_handoff_path=missing",
            lane_id
        )));
    }
    // `&& !gate_ready` added 2026-08-20. This check used to fire unconditionally,
    // which contradicted the guard directly above it: gate_ready exists precisely
    // so the gatekeeper is not deferred "even though robust validation evidence
    // already exists", and then this returned a blocker anyway.
    //
    // MEASURED ON cycle-g-v81. `lab-runner-01` completed with overall_status=passed,
    // 13 checks passed / 0 failed, 0 blueprints failed, analyst_quality_standard
    // .satisfied=true, and real measured_quantities — it executed the director's
    // unclamped-tail inversion candidate. Its only defect was having no
    // `analyst_handoff_path`, which a BASE runner never has: base runner lanes are
    // created at cycle start, before any analyst handoff exists. Being the latest
    // completed runner, it became the one this function reads, and all nine
    // gatekeeper lanes sat at `waiting-for-runner-execution-report` until the
    // watchdog halted the cycle on activity_without_gate_progress with 0 gate rounds
    // — while a second gate-ready runner (followup-runner-02, also 13/13, WITH a
    // handoff path) sat there unused.
    //
    // A handoff path is provenance for the post-run REVIEW; it is not evidence
    // quality. When the run is gate-ready, the gatekeeper judges the evidence.
    // Without gate-readiness the blocker stands, so a runner that produced nothing
    // still cannot open the gate.
    //
    // This surfaced only because 46516c0 let base runners execute at all; before
    // that they never completed, so they never became "latest".

    if runner_context_requires_handoff_revision(&runner_context) {
        // Runner-recovery loop guard: once RUNNER_RECOVERY_ATTEMPT_CAP recovery requeries
        // have already completed this cycle and the runner still degrades, stop deferring
        // the gatekeeper. Accept the executed-but-degraded validation and let the gatekeeper
        // judge it honestly instead of looping forever on handoff revisions.
        if completed_runner_recovery_requery_count(paths, cycle_id)? >= RUNNER_RECOVERY_ATTEMPT_CAP
        {
            return Ok(None);
        }
        // A ruling given in any director lane releases the gate as the dedicated
        // recovery lane would; see runner_adjudicated_by_director.
        if runner_adjudicated_by_director(paths, cycle_id, lane_id)? {
            return Ok(None);
        }
        let source_brief_id = format!("labdirector-runner-recovery-{lane_id}");
        if !completed_followup_action_from_source_exists(
            paths,
            cycle_id,
            "lab-director",
            "lab_director_requery_followup",
            &source_brief_id,
        ) {
            return Ok(Some(format!(
                "waiting-for-labdirector-runner-recovery runner_lane_id={} source_brief_id={}",
                lane_id, source_brief_id
            )));
        }
        return Ok(None);
    }
    // Post-run interpretation is redundant when the runner is already gate-ready
    // (clean + analyst quality standard satisfied): the robust validation is
    // sufficient for the gatekeeper. Only wait for the post-run review when the
    // runner is not yet gate-ready.
    if !gate_ready && !completed_analyst_post_run_report_exists(paths, cycle_id, &lane_id)? {
        return Ok(Some(format!(
            "waiting-for-analyst-post-run-review runner_lane_id={} required_action=runner_result_interpretation_followup",
            lane_id
        )));
    }
    Ok(None)
}

pub(crate) fn push_analyst_handoff_followup_action(
    paths: &AppPaths,
    cycle_id: &str,
    priority_actions: &mut Vec<Value>,
    brief_id: &str,
    source: &str,
    handoff_path: String,
    handoff_payload: Value,
    priority_score: i64,
    blocker_reason: &str,
) -> Result<()> {
    if let Some(runner_context) =
        latest_lab_runner_context_for_handoff(paths, cycle_id, &handoff_path)?
            .filter(|context| runner_context_is_exact_handoff(context, &handoff_path))
    {
        let handoff_hypothesis_statement = handoff_payload
            .get("column_mapping")
            .and_then(|item| item.get("hypothesis_statement"))
            .and_then(Value::as_str)
            .or_else(|| handoff_payload.get("summary").and_then(Value::as_str))
            .or_else(|| {
                handoff_payload
                    .get("handoff_checks")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|item| item.get("hypothesis_text"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("");
        let handoff_candidate_hypotheses = if handoff_hypothesis_statement.trim().is_empty() {
            json!([])
        } else {
            json!([{ "statement": handoff_hypothesis_statement }])
        };
        let lane_id = runner_context
            .get("lane_id")
            .and_then(Value::as_str)
            .unwrap_or("lab-runner");
        let overall_status = runner_context
            .get("overall_status")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        let checks_failed = runner_context
            .get("checks_failed")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let blueprints_failed = runner_context
            .get("blueprints_failed")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let failed_checks = runner_context
            .get("failed_checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let failed_check_summary = if failed_checks.is_empty() {
            "none reported".to_string()
        } else {
            failed_checks.join(",")
        };
        if runner_context_requires_handoff_revision(&runner_context) {
            // Already ruled on by name: no second director call for the same verdict.
            if runner_adjudicated_by_director(paths, cycle_id, lane_id)? {
                return Ok(());
            }
            priority_actions.push(json!({
                "brief_id": format!("labdirector-runner-recovery-{lane_id}"),
                "description": format!(
                    "LabDirector must adjudicate degraded validation from lab-runner {lane_id}: overall_status={overall_status}, checks_failed={checks_failed}, blueprints_failed={blueprints_failed}, failed_checks={failed_check_summary}. Do not let this recovery action prescribe the analysis plan. LabDirector must author the next research instruction, decide whether to revise the handoff, demote/replace the claim, request missing evidence, or close the current lead, and update research notes."
                ),
                "type": "lab_director_requery_followup",
                "priority": "high",
                "priority_score": 134,
                "preferred_role": "lab-director",
                "target_rubric": "technical_quality",
                "target_score": 95,
                "current_score": Value::Null,
                "blocker_reasons": json!([
                    "lab-runner consumed the latest analyst handoff but scientific validation did not pass",
                    "repeat execution of the same stale handoff is prohibited"
                ]),
                "candidate_hypotheses": handoff_candidate_hypotheses,
                "validation_results": runner_context,
                "failed_runner_context": runner_context,
                "open_source_agent_requirement": runner_context
                    .get("open_source_agent_requirements")
                    .cloned()
                    .unwrap_or(Value::Null),
                "analysis_request": {
                    "source": "degraded-runner-labdirector-adjudication",
                    "lab_director_must_author_research_instruction": true,
                    "supervisor_or_runtime_must_not_prescribe_analysis_plan": true,
                    "handoff_source": source,
                    "handoff_path": handoff_path,
                    "analyst_handoff": handoff_payload,
                    "failed_runner_context": runner_context,
                },
            }));
        } else if !completed_analyst_post_run_report_exists(paths, cycle_id, lane_id)?
            && completed_analyst_post_run_review_count(paths, cycle_id, lane_id)? < 3
        {
            priority_actions.push(json!({
                "brief_id": lane_id,
                "description": format!(
                    "interpret LabRunner {lane_id} results for the Analyst-to-LabRunner validation cycle. Decide whether the evidence is sufficient for LabDirector gate review or whether another runner iteration is needed. If sufficient, write a concise lab_director_validation_report with hypothesis decision, effect direction/strength, controls, failure modes, and artifacts; otherwise emit a revised executable handoff-validation-plan.json. Analyst chooses the report timing; LabDirector gates only after Analyst declares the result ready. overall_status={overall_status}, checks_failed={checks_failed}, blueprints_failed={blueprints_failed}."
                ),
                "type": "runner_result_interpretation_followup",
                "priority": "high",
                "priority_score": 136,
                "preferred_role": "analyst",
                "target_rubric": "technical_quality",
                "target_score": 95,
                "current_score": Value::Null,
                "blocker_reasons": json!([
                    "LabRunner produced validation results that must be interpreted by Analyst before LabDirector gate review"
                ]),
                "candidate_hypotheses": handoff_candidate_hypotheses,
                "validation_results": runner_context,
                "analysis_request": {
                    "source": "runner-result-analyst-interpretation",
                    "handoff_source": source,
                    "handoff_path": handoff_path,
                    "analyst_handoff": handoff_payload,
                    "runner_context": runner_context,
                    "analyst_decides_report_timing": true,
                    "lab_director_is_gate_after_analyst_report": true,
                    "post_run_review_contract": {
                        "gate_unlock_condition": "emit lab_director_validation_report with a decision and scientific basis; otherwise emit a revised handoff-validation-plan.json and keep gate blocked",
                        "required_report_fields": [
                            "hypothesis_decision",
                            "effect_direction",
                            "effect_strength",
                            "controls",
                            "negative_controls",
                            "confounder_assessment",
                            "falsification_assessment",
                            "protocol_deviations",
                            "failure_modes",
                            "artifacts"
                        ]
                    },
                },
            }));
        }
        return Ok(());
    }

    if open_lab_runner_lane_for_handoff(paths, cycle_id, &handoff_path)?.is_some() {
        return Ok(());
    }
    // A handoff whose code and data another runner already ran (or is queued to
    // run) under a different handoff's name asks for nothing new. The direct
    // handoff runner bypasses role availability, so it is stopped here.
    if crate::runtime::handoff_seal::execution_served_by(paths, cycle_id, &handoff_path)?.is_some() {
        return Ok(());
    }
    // A handoff written against an analysis contract that is no longer current
    // cannot run: the runner's preflight refuses it (analysis_contract_mismatch).
    // MEASURED ON cycle-a-20260919, 2026-10-16: runners 323, 324, 325
    // and 326 were created one per pass for analyst-842's handoff, bound to
    // contract f14409a6..., while the lead's contract was d09ea5a7...; each
    // failed within a minute, and each came out of the cycle's follow-up budget.
    // An analyst re-issues the handoff under the current contract instead.
    if let Some(stale) = handoff_contract_is_stale(paths, cycle_id, &handoff_payload) {
        note_stale_handoff_contract(paths, cycle_id, &handoff_path, &stale);
        return Ok(());
    }
    // A contract already measured is not measured again.
    //
    // MEASURED ON cycle-a-20260919, 2026-10-18: contract 12daf336 was
    // executed by 18 runners (458-475) for 18 analysts' freshly written scripts,
    // and every one wrote the same four estimates, 0.8992 [0.1585] first among
    // them; contract d03b2918 then by eight more (478-485), 0.7119 [0.6512]
    // each time. A deterministic analysis of the same sealed data reproduces its
    // numbers; with one lane at a time, the 24 repeats held the gatekeepers and
    // engineers for most of a day. What a further analyst can add is a
    // supporting audit, which still runs.
    if !handoff_is_supporting_only(&handoff_payload) {
        if let Some(contract_id) = handoff_payload
            .pointer("/analysis_contract/contract_id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        {
            let measured = verified_primary_measurements(
                paths,
                cycle_id,
                handoff_payload.get("analysis_contract").unwrap_or(&Value::Null),
            )?;
            if measured.len() >= CONTRACT_MEASUREMENTS_BEFORE_HOLD {
                note_contract_already_measured(paths, cycle_id, &handoff_path, contract_id, &measured);
                return Ok(());
            }
        }
    }

    let handoff_checks = handoff_payload
        .get("handoff_checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let check_count = handoff_checks.len();
    let check_ids = handoff_checks
        .iter()
        .filter_map(|item| {
            item.get("check_id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .take(12)
        .collect::<Vec<_>>();
    let handoff_fingerprint = slugify(&format!("{}::{}", handoff_path, check_ids.join("|")));
    let artifact_word = if brief_id == "analyst-handoff-artifact" {
        " artifact"
    } else {
        ""
    };
    priority_actions.push(json!({
        "brief_id": brief_id,
        "description": format!(
            "execute the latest executable analyst handoff{artifact_word} from {handoff_path} with {check_count} validation checks before any gate promotion; required_check_ids={}; handoff_fingerprint={handoff_fingerprint}",
            check_ids.join(",")
        ),
        "type": "methods_followup",
        "priority": "high",
        "priority_score": priority_score,
        "preferred_role": "lab-runner",
        "target_rubric": "technical_quality",
        "target_score": 95,
        "current_score": Value::Null,
        "blocker_reasons": json!([blocker_reason]),
        "candidate_hypotheses": json!([]),
        "handoff_fingerprint": handoff_fingerprint,
        "required_check_ids": json!(check_ids),
        "handoff_checks": handoff_payload
            .get("handoff_checks")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "validation_code_blueprints": handoff_payload
            .get("validation_code_blueprints")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "analysis_request": {
            "source": source,
            "handoff_path": handoff_path,
            "analyst_handoff": handoff_payload,
        },
    }));
    Ok(())
}

#[cfg(test)]
mod runner_context_revision_tests {
    use super::*;

    #[test]
    fn satisfied_analyst_standard_routes_to_interpretation_even_if_inconclusive() {
        let context = serde_json::json!({
            "overall_status": "inconclusive",
            "checks_failed": 1,
            "blueprints_failed": 0,
            "failed_checks": ["binary_outcome_inferred"],
            "validation_summary": {
                "analyst_quality_standard": {
                    "satisfied": true,
                    "failed_requirements": []
                },
                "handoff_check_resolutions": [{
                    "check_id": "sample_binary_outcome",
                    "resolved": true,
                    "resolution_status": "schema_blocked"
                }]
            }
        });
        assert!(!runner_context_requires_handoff_revision(&context));
    }

    #[test]
    fn unsatisfied_analyst_standard_still_requires_revision() {
        let context = serde_json::json!({
            "overall_status": "inconclusive",
            "checks_failed": 1,
            "blueprints_failed": 0,
            "failed_checks": ["binary_outcome_inferred"],
            "analyst_quality_standard": {
                "satisfied": false,
                "failed_requirements": ["handoff_check_unresolved:sample_binary_outcome"]
            }
        });
        assert!(runner_context_requires_handoff_revision(&context));
    }

    #[test]
    fn resolved_interpretation_handoff_is_report_not_runner_rerun() {
        let role_plan = serde_json::json!({
            "action_type": "runner_result_interpretation_followup",
            "planner_metadata": {
                "validation_results": {
                    "blueprints_failed": 0,
                    "validation_summary": {
                        "analyst_quality_standard": {"satisfied": true},
                        "handoff_check_resolutions": [{
                            "check_id": "sample_binary_outcome",
                            "resolved": true,
                            "resolution_status": "schema_blocked"
                        }]
                    }
                }
            }
        });
        assert!(interpretation_handoff_is_resolved_report(&role_plan));
    }

    #[test]
    fn unresolved_interpretation_handoff_can_still_rerun() {
        let role_plan = serde_json::json!({
            "action_type": "runner_result_interpretation_followup",
            "planner_metadata": {
                "validation_results": {
                    "blueprints_failed": 0,
                    "analyst_quality_standard": {"satisfied": false},
                    "handoff_check_resolutions": [{
                        "check_id": "sample_binary_outcome",
                        "resolved": false,
                        "resolution_status": "ambiguous_inconclusive"
                    }]
                }
            }
        });
        assert!(!interpretation_handoff_is_resolved_report(&role_plan));
    }
}
