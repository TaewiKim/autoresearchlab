use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[cfg(test)]
use super::agent_command::{command_from_common_locations, researchlab_codex_home};
use super::codex_lane::run_codex_agent_lane;
#[cfg(test)]
use super::codex_outputs::{analyst_handoff_payload, normalize_chronicle_result_payload};
#[cfg(test)]
use super::codex_policy::{
    codex_disabled_features, codex_failure_category, codex_timeout_seconds,
    data_scout_should_fetch, is_gatekeeper_empty_output, parse_codex_config_overrides,
};
#[cfg(test)]
use super::codex_prompt::build_codex_prompt;
#[cfg(test)]
use super::codex_schema::codex_output_schema;
#[cfg(test)]
use super::graph_normalization::normalize_graph_vocabulary;
use super::lab_director_projection::{
    project_lab_director_payload_to_hypothesis, project_lab_director_simulation_orders,
};
#[cfg(test)]
use super::lane_lifecycle::create_lane_contract;
use super::lane_lifecycle::{
    best_effort_reconcile_cycle, best_effort_refresh_after_analyst_report,
    should_refresh_gate_after_lane_completion,
};
#[cfg(test)]
use super::process::{process_metadata, validate_process_metadata};
use super::queue::update_sqlite_contract_queue_status;
#[cfg(test)]
use super::queue::{
    all_cycle_contract_paths, annotate_contract_queue_role_plan, contract_index_path,
    contract_queue_path, pipeline_queue_db_path,
};
use super::role_plan::optional_role_plan;
#[cfg(test)]
use super::role_plan::role_plan_dataset_override;
use super::runtime_drivers::{run_external_driver, run_native_readonly};

use crate::chronicle::reporting::append_event;
use crate::core::model::{AppPaths, HarnessResult, LaneContract};
use crate::core::support::{lane_role_plan_path, lane_root, now_iso, read_json, write_json};

const APPROVED_SCHOLARLY_NETWORK_POLICY: &str = "approved-scholarly-metadata-v1";

fn approved_data_followup_needs_codex_upgrade(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    policy: Option<&str>,
) -> bool {
    if policy != Some(APPROVED_SCHOLARLY_NETWORK_POLICY)
        || contract.role != "scout"
        || contract.runtime_class != "external-driver"
    {
        return false;
    }
    let Some(plan) = role_plan else {
        return false;
    };
    let requested_action = plan
        .get("requested_action_type")
        .and_then(Value::as_str)
        .or_else(|| {
            plan.get("planner_metadata")
                .and_then(|metadata| metadata.get("requested_action_type"))
                .and_then(Value::as_str)
        });
    plan.get("action_type").and_then(Value::as_str) == Some("reasoning_literature_scout")
        && requested_action == Some("data_acquisition_followup")
}

fn effective_execution_contract(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    policy: Option<&str>,
) -> LaneContract {
    if !approved_data_followup_needs_codex_upgrade(contract, role_plan, policy) {
        return contract.clone();
    }
    let mut upgraded = contract.clone();
    upgraded.runtime_class = "codex-agent".to_string();
    upgraded.mode = "read-write-scoped".to_string();
    if let Some(lane_root) = upgraded.task_file.parent() {
        upgraded.output_artifact = Some(lane_root.join("result.json"));
        upgraded.allowed_outputs = vec![lane_root.to_path_buf()];
    }
    upgraded
}

// A role plan may have been materialized before the runtime had a chance to
// convert its external contract.  Keep the execution-facing plan coherent with
// that conversion: Codex must not inherit the Python external-driver model
// marker (which has no Codex model semantics).
fn effective_execution_role_plan(
    contract: &LaneContract,
    role_plan: Option<Value>,
    policy: Option<&str>,
) -> Option<Value> {
    let mut plan = role_plan?;
    if !approved_data_followup_needs_codex_upgrade(contract, Some(&plan), policy) {
        return Some(plan);
    }
    let route = crate::labdirector::policy::literature_scout_model_route();
    plan["assigned_model"] = route["model"].clone();
    plan["model_route"] = route;
    Some(plan)
}

fn direct_runner_handoff(role_plan: &Value) -> Option<&Value> {
    crate::labdirector::direct_handoff_runner_role_plan_path(role_plan)?;
    [
        "/analysis_request/analyst_handoff",
        "/planner_metadata/analysis_request/analyst_handoff",
        "/planner_metadata/analyst_handoff",
    ]
    .iter()
    .find_map(|pointer| role_plan.pointer(pointer))
}

fn stale_runner_analysis_contract(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Option<(String, String)> {
    if contract.role != "lab-runner" {
        return None;
    }
    crate::labdirector::handoff_contract_is_stale(
        paths,
        &contract.cycle_id,
        direct_runner_handoff(role_plan?)?,
    )
}

fn supersede_stale_contract_runner(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    result_path: &Path,
    final_status_path: &Path,
    run_state_path: &Path,
    events_path: &Path,
) -> Result<Option<HarnessResult>> {
    let Some((bound, current)) = stale_runner_analysis_contract(paths, contract, role_plan) else {
        return Ok(None);
    };
    // MEASURED ON cycle-a-20260919, 2026-10-16: followup-runner-351's
    // role plan was materialized from analyst-869's analysis:d46c... handoff and
    // launched against analysis:2c00.... The driver rejected it, but only after
    // the stale immutable blueprint had consumed a runner execution.
    let status = json!({
        "lane_id": contract.lane_id,
        "status": "aborted",
        "completed_at": now_iso(),
        "degraded": true,
        "failure_category": "stale_analysis_contract_handoff",
        "supervisor_recovery_reason": "queued analyst handoff no longer matches the canonical analysis contract",
        "bound_contract_id": bound,
        "current_contract_id": current,
    });
    write_json(final_status_path, &status)?;
    write_json(run_state_path, &json!({
        "lane_id": contract.lane_id,
        "role": contract.role,
        "status": "aborted",
        "updated_at": now_iso(),
        "reason": "stale analysis contract handoff superseded before execution",
        "bound_contract_id": status["bound_contract_id"],
        "current_contract_id": status["current_contract_id"],
    }))?;
    append_event(events_path, "lane_superseded", status.clone())?;
    update_sqlite_contract_queue_status(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        "aborted",
        None,
    )?;
    Ok(Some(HarnessResult {
        lane_id: contract.lane_id.clone(),
        status: "aborted".to_string(),
        result_path: result_path.to_path_buf(),
        final_status_path: final_status_path.to_path_buf(),
        events_path: events_path.to_path_buf(),
    }))
}

pub fn run_lane(paths: &AppPaths, contract_path: &Path) -> Result<HarnessResult> {
    let contract: LaneContract = serde_json::from_value(read_json(contract_path)?)?;
    if crate::labdirector::policy::planning_only_scope_blocks_role(&contract.role) {
        bail!("planning-only research scope blocks LabRunner execution");
    }
    let root = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    fs::create_dir_all(&root)?;

    let events_path = root.join("events.jsonl");
    let result_path = root.join("result.json");
    let final_status_path = root.join("final-status.json");
    let artifacts_path = root.join("artifacts.json");
    let run_state_path = root.join("run-state.json");
    let stdout_path = root.join("stdout.log");
    let stderr_path = root.join("stderr.log");
    let execution_context_path = root.join("execution-context.json");
    let role_plan = super::gate_review_binding::bind_current_review(
        paths, &contract, optional_role_plan(paths, &contract)?,
    )?;
    if let Some(result) = supersede_stale_contract_runner(
        paths,
        &contract,
        role_plan.as_ref(),
        &result_path,
        &final_status_path,
        &run_state_path,
        &events_path,
    )? {
        best_effort_reconcile_cycle(paths, &contract.cycle_id);
        return Ok(result);
    }
    let role_plan_path = lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id);
    // Follow-up contracts are created before their native role plan is
    // materialized. Under approved scholarly scope, that plan can convert a
    // data-acquisition follow-up into an adaptive literature Scout. Upgrade the
    // effective execution contract as well, so it runs as a Codex agent rather
    // than the legacy external dataset driver.
    let scholarly_policy = std::env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY").ok();
    let execution_contract =
        effective_execution_contract(&contract, role_plan.as_ref(), scholarly_policy.as_deref());
    let role_plan =
        effective_execution_role_plan(&contract, role_plan, scholarly_policy.as_deref());

    append_event(
        &events_path,
        "lane_started",
        json!({
            "lane_id": contract.lane_id,
            "runtime_class": execution_contract.runtime_class,
            "has_role_plan": role_plan.is_some(),
        }),
    )?;
    write_json(
        &execution_context_path,
        &json!({
            "cycle_id": contract.cycle_id,
            "lane_id": contract.lane_id,
            "role": contract.role,
            "runtime_class": execution_contract.runtime_class,
            "task_file": contract.task_file,
            "role_plan_path": if role_plan_path.exists() { json!(role_plan_path) } else { json!(null) },
            "role_plan": role_plan,
        }),
    )?;
    write_json(
        &run_state_path,
        &json!({
            "lane_id": contract.lane_id,
            "status": "running",
            "started_at": now_iso(),
            "runtime_class": execution_contract.runtime_class,
            "role": contract.role,
            "role_plan_path": if role_plan_path.exists() { json!(role_plan_path) } else { json!(null) },
            "execution_context_path": execution_context_path,
        }),
    )?;
    update_sqlite_contract_queue_status(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        "running",
        None,
    )?;

    let execution = match execution_contract.runtime_class.as_str() {
        "external-driver" => run_external_driver(paths, &execution_contract, role_plan.as_ref()),
        "codex-agent" => {
            run_codex_agent_lane(paths, &execution_contract, &root, role_plan.as_ref())
        }
        "native-readonly" => run_native_readonly(paths, &execution_contract, role_plan.as_ref()),
        other => bail!("unsupported runtime_class: {other}"),
    };

    let execution_result = match execution {
        Ok((status, payload, stdout, stderr, artifacts)) => {
            fs::write(&stdout_path, stdout)?;
            fs::write(&stderr_path, stderr)?;
            write_json(&result_path, &payload)?;
            if let Err(error) =
                project_lab_director_payload_to_hypothesis(paths, &contract, &payload)
            {
                append_event(
                    &events_path,
                    "lab_director_hypothesis_projection_failed",
                    json!({
                        "lane_id": contract.lane_id,
                        "error": error.to_string(),
                    }),
                )?;
            }
            // A landscape scout's field landscape, validated against the papers
            // the screening gate admitted and published for the lead gate -- see
            // labdirector::field_landscape. Whatever the lane's own status: the
            // landscape's validity is decided by its content, not by whether the
            // adaptive-search contract called the search saturated.
            if let Err(error) = crate::labdirector::project_field_landscape(
                paths,
                &contract,
                role_plan.as_ref(),
            ) {
                append_event(
                    &events_path,
                    "field_landscape_projection_failed",
                    json!({
                        "lane_id": contract.lane_id,
                        "error": error.to_string(),
                    }),
                )?;
            }
            // A frontier-harvest lane's top-K, published with each one's review
            // state -- see labdirector::frontier_harvest.
            if let Err(error) =
                crate::labdirector::project_frontier_harvest(paths, &contract, role_plan.as_ref())
            {
                append_event(
                    &events_path,
                    "frontier_harvest_projection_failed",
                    json!({
                        "lane_id": contract.lane_id,
                        "error": error.to_string(),
                    }),
                )?;
            }
            // A deep-read scout's SOTA cards, each checked against the cached
            // full text it cites and published merged across attempts -- see
            // labdirector::sota_cards. Whatever the lane's status: a timed-out
            // lane keeps the cards it finished.
            if let Err(error) =
                crate::labdirector::project_sota_cards(paths, &contract, role_plan.as_ref())
            {
                append_event(
                    &events_path,
                    "sota_cards_projection_failed",
                    json!({
                        "lane_id": contract.lane_id,
                        "error": error.to_string(),
                    }),
                )?;
            }
            // An expert-selection stage lane's beliefs, slate, panel review,
            // novelty audit or feasibility verdicts, validated and published --
            // see labdirector::problem_selection. Whatever the lane's status,
            // for the same reason as the landscape above.
            if let Err(error) = crate::labdirector::project_expert_selection_lane(
                paths,
                &contract,
                role_plan.as_ref(),
                &payload,
            ) {
                append_event(
                    &events_path,
                    "expert_selection_projection_failed",
                    json!({
                        "lane_id": contract.lane_id,
                        "error": error.to_string(),
                    }),
                )?;
            }
            // The director's simulation orders, recorded once here rather than
            // re-read from every director result on every scheduling pass -- see
            // record_lab_director_simulation_orders.
            if status == "completed" {
                if let Err(error) =
                    project_lab_director_simulation_orders(paths, &contract, &payload)
                {
                    append_event(
                        &events_path,
                        "lab_director_simulation_orders_projection_failed",
                        json!({
                            "lane_id": contract.lane_id,
                            "error": error.to_string(),
                        }),
                    )?;
                }
            }
            write_json(
                &artifacts_path,
                &json!({
                    "lane_id": contract.lane_id,
                    "artifacts": artifacts,
                }),
            )?;
            // Propagate degradation markers from the payload so downstream
            // reconcilers can distinguish "genuine completion" from "synthetic
            // completion via codex_degraded_payload" (cycle-output coherence
            // revision P0-1).
            let degraded = payload
                .get("degraded")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let failure_category = payload
                .get("failure_category")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            // C4 silent-failure guard: a DEGRADED analyst lane is a synthetic
            // fallback handoff (codex_degraded_payload after quota/context/
            // timeout), not real analysis. If it is left as "completed" a
            // lab-runner will validate a fabricated handoff and self-heal will
            // NOT retry it (self-heal only reprocesses "failed"). Reclassify it
            // to "failed" so the analyst is retried instead of the pipeline
            // silently advancing on fake evidence. (lab-director degradation is
            // already handled downstream via the degraded-hypothesis "not
            // usable" check in artifact_readiness.) status stays &str (Copy).
            let status = if degraded && contract.role == "analyst" {
                "failed".to_string()
            } else {
                status
            };
            write_json(
                &run_state_path,
                &json!({
                    "lane_id": contract.lane_id,
                    "status": status,
                    "updated_at": now_iso(),
                    "runtime_class": contract.runtime_class,
                    "role": contract.role,
                    "result_path": result_path,
                    "role_plan_path": if role_plan_path.exists() { json!(role_plan_path) } else { json!(null) },
                    "execution_context_path": execution_context_path,
                    "degraded": degraded,
                    "failure_category": failure_category,
                }),
            )?;
            write_json(
                &final_status_path,
                &json!({
                    "lane_id": contract.lane_id,
                    "status": status,
                    "completed_at": now_iso(),
                    "result_path": result_path,
                    "role_plan_path": if role_plan_path.exists() { json!(role_plan_path) } else { json!(null) },
                    "degraded": degraded,
                    "failure_category": failure_category,
                }),
            )?;
            let event_type = match status.as_str() {
                "completed" => "lane_completed",
                "failed" => "lane_failed",
                _ => "lane_prepared",
            };
            append_event(
                &events_path,
                event_type,
                json!({ "lane_id": contract.lane_id, "result_path": result_path }),
            )?;
            update_sqlite_contract_queue_status(
                paths,
                &contract.cycle_id,
                &contract.lane_id,
                &status,
                None,
            )?;
            if should_refresh_gate_after_lane_completion(&contract.role, &status) {
                best_effort_refresh_after_analyst_report(
                    paths,
                    &contract.cycle_id,
                    &contract.lane_id,
                );
            }
            Ok(HarnessResult {
                lane_id: contract.lane_id,
                status: status.to_string(),
                result_path,
                final_status_path,
                events_path,
            })
        }
        Err(error) => {
            fs::write(&stderr_path, format!("{error:#}"))?;
            write_json(
                &run_state_path,
                &json!({
                    "lane_id": contract.lane_id,
                    "status": "failed",
                    "updated_at": now_iso(),
                    "error": error.to_string(),
                }),
            )?;
            write_json(
                &final_status_path,
                &json!({
                    "lane_id": contract.lane_id,
                    "status": "failed",
                    "completed_at": now_iso(),
                    "error": error.to_string(),
                }),
            )?;
            append_event(
                &events_path,
                "lane_failed",
                json!({ "lane_id": contract.lane_id, "error": error.to_string() }),
            )?;
            update_sqlite_contract_queue_status(
                paths,
                &contract.cycle_id,
                &contract.lane_id,
                "failed",
                Some(&error.to_string()),
            )?;
            Err(error)
        }
    };

    best_effort_reconcile_cycle(paths, &contract.cycle_id);
    execution_result
}

#[cfg(test)]
mod approved_data_followup_execution_tests {
    use super::*;
    use std::path::PathBuf;

    fn external_scout_contract() -> LaneContract {
        LaneContract {
            cycle_id: "cycle-test".to_string(),
            lane_id: "followup-scout-01".to_string(),
            role: "scout".to_string(),
            runtime_class: "external-driver".to_string(),
            mode: "driver-exec".to_string(),
            cwd: PathBuf::from("."),
            task_file: PathBuf::from(".research-lab/lanes/cycle-test/followup-scout-01/task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![],
            output_artifact: None,
            fallback_strategy: None,
        }
    }

    #[test]
    fn approved_converted_data_followup_executes_as_codex_agent() {
        let contract = external_scout_contract();
        let role_plan = json!({
            "action_type": "reasoning_literature_scout",
            "requested_action_type": "data_acquisition_followup",
        });
        let upgraded = effective_execution_contract(
            &contract,
            Some(&role_plan),
            Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
        );
        assert_eq!(upgraded.runtime_class, "codex-agent");
        assert_eq!(upgraded.mode, "read-write-scoped");
        assert!(upgraded
            .output_artifact
            .as_ref()
            .unwrap()
            .ends_with("result.json"));
        let execution_plan = effective_execution_role_plan(
            &contract,
            Some(role_plan.clone()),
            Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
        )
        .unwrap();
        assert_ne!(
            execution_plan["assigned_model"],
            crate::labdirector::policy::CODEX_LUNA_MODEL
        );
        assert_eq!(
            execution_plan["model_route"]["model"],
            execution_plan["assigned_model"]
        );
        let unchanged = effective_execution_contract(&contract, Some(&role_plan), None);
        assert_eq!(unchanged.runtime_class, "external-driver");
    }

    #[test]
    fn queued_runner_with_superseded_analysis_contract_never_starts_its_driver() {
        // MEASURED ON cycle-a-20260919, 2026-10-16: runner 351's
        // materialized role plan carried analyst-869's d46c contract while the
        // canonical contract was 2c00; the stale blueprint reached Python and
        // failed all four contract preflight checks instead of being retired.
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let runtime = temp.path().join(".research-lab");
        let cycle = "cycle-a-20260919";
        let lane = "followup-runner-351";
        let lane_dir = runtime.join("lanes").join(cycle).join(lane);
        fs::create_dir_all(project.join("src/policy")).unwrap();
        fs::create_dir_all(&lane_dir).unwrap();
        fs::write(
            project.join("src/policy/analysis_contract.js"),
            "if (process.argv[4] === '--current') process.stdout.write(JSON.stringify({contract_id:'analysis:2c00'}));\n",
        )
        .unwrap();
        let task = lane_dir.join("task.md");
        fs::write(&task, "execute frozen analyst handoff").unwrap();
        let contract_path = lane_dir.join("lane-contract.json");
        write_json(&contract_path, &json!({
            "cycle_id": cycle,
            "lane_id": lane,
            "role": "lab-runner",
            "runtime_class": "external-driver",
            "mode": "driver-exec",
            "cwd": project,
            "task_file": task,
            "allowed_inputs": [],
            "allowed_outputs": [lane_dir.join("outputs")],
            "output_artifact": lane_dir.join("outputs/result.json"),
            "fallback_strategy": null,
        }))
        .unwrap();
        write_json(&lane_dir.join("role-plan.json"), &json!({
            "role": "lab-runner",
            "source_brief_id": "analyst-handoff",
            "action_type": "methods_followup",
            "analysis_request": {"analyst_handoff": {
                "primary_hypothesis_id": "analysis:d46c",
                "analysis_contract": {"contract_id": "analysis:d46c"},
                "validation_targets": [{"claim_text": "superseded claim"}],
                "validation_code_blueprints": [{"blueprint_id": "frozen-old"}]
            }},
            "planner_metadata": {
                "analyst_handoff_path": "/lanes/followup-analyst-869/handoff-validation-plan.json"
            }
        }))
        .unwrap();
        let paths = AppPaths {
            project_root: project,
            runtime_root: runtime,
            data_root: temp.path().join("data"),
            stats_driver_script: temp.path().join("driver-must-not-run.py"),
            literature_driver_script: temp.path().join("literature-must-not-run.py"),
        };

        let result = run_lane(&paths, &contract_path).unwrap();
        assert_eq!(result.status, "aborted");
        assert!(!result.result_path.exists(), "no stale execution may be recorded");
        let final_status = read_json(&result.final_status_path).unwrap();
        assert_eq!(final_status["failure_category"], "stale_analysis_contract_handoff");
        assert_eq!(final_status["bound_contract_id"], "analysis:d46c");
        assert_eq!(final_status["current_contract_id"], "analysis:2c00");
        let events = fs::read_to_string(result.events_path).unwrap();
        assert!(events.contains("lane_superseded"));
        assert!(!events.contains("lane_started"));
    }
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    include!("engine_test_support.rs");
    include!("engine_projection_tests.rs");
    include!("engine_queue_process_tests.rs");
    include!("engine_codex_policy_tests.rs");
    include!("engine_analyst_schema_tests.rs");
    include!("engine_gatekeeper_tests.rs");
}
