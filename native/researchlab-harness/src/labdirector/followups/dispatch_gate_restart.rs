#![allow(unused_imports)]
use super::*;

const RESTART_ANSWERED_NOTICE: &str = "gate_restart_analyst_already_answered";

/// The gate-restart analyst whose answer still stands: the newest one that
/// completed, when no lane that could change its answer has ended since it was
/// launched.
///
/// MEASURED ON cycle-a-20260919, 2026-11-22: the gate asked for a
/// restart at every pass, each pass opened one analyst (the description carries
/// an attempt number, so no two share a signature; it had reached 279), and each
/// was assigned the lead's registered validation, whose held-out data had not
/// been produced. Analysts 1641-1655 reported "blocked: the canonical CSV and its
/// SHA-256 are absent" fifteen times in a row over two hours while nothing else
/// in the cycle ran.
///
/// What can change the answer is work: an engineer, runner, scout, gatekeeper or
/// other analyst lane ending. Another restart analyst cannot, and neither can a
/// director -- a decision changes the answer through the lanes it orders.
pub(crate) fn restart_analyst_that_answered_this_state(paths: &AppPaths, cycle_id: &str) -> Option<String> {
    let modified = |path: PathBuf| fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let mut ended: Vec<(std::time::SystemTime, String, PathBuf)> = fs::read_dir(cycle_lanes_root(paths, cycle_id))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let lane_dir = entry.path();
            let at = modified(lane_dir.join("final-status.json"))?;
            Some((at, entry.file_name().to_string_lossy().to_string(), lane_dir))
        })
        .collect();
    ended.sort_by(|left, right| right.0.cmp(&left.0));
    let plan_of = |lane_dir: &Path| read_role_plan_index_fields(&lane_dir.join("role-plan.json")).ok().flatten();
    let is_restart_analyst = |lane_dir: &Path| {
        plan_of(lane_dir).is_some_and(|plan| plan.role.as_deref() == Some("analyst") && plan.action_type.as_deref() == Some("gate_restart_followup"))
    };
    let is_director = |lane_dir: &Path| plan_of(lane_dir).is_some_and(|plan| plan.role.as_deref() == Some("lab-director"));
    let mut answered: Option<(String, std::time::SystemTime)> = None;
    for (ended_at, lane_id, lane_dir) in &ended {
        if let Some((_, launched_at)) = &answered {
            if ended_at <= launched_at {
                break;
            }
        }
        if is_restart_analyst(lane_dir) {
            if answered.is_none() {
                let completed = read_json(&lane_dir.join("final-status.json"))
                    .ok()
                    .is_some_and(|status| status.get("status").and_then(Value::as_str) == Some("completed"));
                if !completed {
                    return None; // one that failed has answered nothing
                }
                let launched_at = modified(lane_dir.join("invocation.json")).or_else(|| modified(lane_dir.join("prompt.txt")))?;
                answered = Some((lane_id.clone(), launched_at));
            }
            continue;
        }
        if is_director(lane_dir) {
            continue;
        }
        return None; // something that could change the answer ended after it began
    }
    answered.map(|(lane_id, _)| lane_id)
}

/// Tell the director, once per answer, that the restart it is waiting on was
/// answered and that nothing has moved since.
fn hand_restart_answer_to_director(paths: &AppPaths, cycle_id: &str, answered_by: &str) {
    let notices = crate::core::support::harness_notices_path(paths, cycle_id);
    let marker = format!("\"answered_by\":\"{answered_by}\"");
    let told = fs::read_to_string(&notices)
        .map(|text| text.lines().any(|line| line.contains(RESTART_ANSWERED_NOTICE) && line.contains(&marker)))
        .unwrap_or(false);
    if told {
        return;
    }
    let lane_dir = crate::core::support::lane_root(paths, cycle_id, answered_by);
    let message = format!(
        "The gate still asks for the hypothesis set to be restarted, and no analyst was opened for it this time. Analyst {answered_by} already took that assignment, and no engineer, runner, scout, gatekeeper or other analyst lane has ended since it began: a new analyst would be given the same inputs and return the same answer. Read its answer at {} (its notes and files are in the same directory). If it says the validation cannot be prepared because something does not exist yet -- data, a held-out run, a registered specification -- then producing that is the next move and it is yours to order: a standing order to the role that can produce it, or a simulation order. If instead the lead should change, change it. Another analyst will be opened for the restart once some lane's work has ended.",
        lane_dir.join("result.json").display()
    );
    let item = json!({
        "type": "supervisor_instruction",
        "payload": {"issue_code": "gate_restart_already_answered", "severity": "process_attention", "instance": answered_by, "message": message}
    });
    let lanes = dispatch_cycle_objective(paths, cycle_id)
        .and_then(|objective| spawn_supervisor_labdirector_followup(paths, cycle_id, &objective, &item))
        .unwrap_or_default();
    let _ = crate::chronicle::reporting::append_event(
        &notices,
        RESTART_ANSWERED_NOTICE,
        json!({
            "answered_by": answered_by,
            "director_lanes": lanes.iter().filter_map(|lane| lane.get("lane_id").cloned()).collect::<Vec<_>>(),
            "detail": "the gate asked for a restart again; the newest restart analyst completed and nothing that could change its answer has ended since it was launched, so no analyst was opened and the director was told",
        }),
    );
}

pub(crate) fn dispatch_gate_restart_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    existing_action_counts: &HashMap<String, usize>,
    action: &Value,
    action_type: &str,
    brief_id: &str,
    description: &str,
    target_rubric: &str,
    requested_preferred_role: &str,
    preferred_role: &str,
    restart_scope: &[String],
    action_candidate_payload: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    if preferred_role == "lab-director"
        && created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "lab-director",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "lab-director",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        // Ledger gate (owner option D): every restart lane — whether the action
        // came from the JS gate review or was synthesized by the Rust
        // hypothesis-gate flow — is created HERE, so this is the one choke
        // point where a ledger DENY can actually stop the "restart from
        // scratch" instruction from reaching a director.
        let ledger_deny = ledger_denies_pivot(paths, cycle_id);
        let director_description = match ledger_deny.as_deref() {
            Some(deny_reason) => format!(
                "A gate restart was requested, but the progress ledger DENIES a pivot this round.{clause} Treat the gate objections in the scope list as the binding constraints to close ON THE PROTECTED LEAD, and write the exact validation handoff that closes them. [attempt {attempt}]",
                clause = ledger_keep_refining_clause(deny_reason)
            ),
            None => format!(
                "{description} Make the restart decision directly as LabDirector: select one promotable family, demote literature-only claims, and write the exact validation handoff required before any document-stage work resumes. [attempt {attempt}]"
            ),
        };
        let director_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-director",
            brief_id,
            &director_description,
            restart_scope,
        );
        let director_signature = followup_task_signature(&director_task_body);
        if !existing_signatures.contains(&director_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-lab-director-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                "codex-agent",
                "read-write-scoped",
                &director_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "lab-director",
                assigned_model_for_role("lab-director", "codex-agent"),
                plan_ctx.objective,
                brief_id,
                &director_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "lab-director",
                    "requested_preferred_role": requested_preferred_role,
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    // Under a ledger deny the lane refines the protected lead in
                    // place; the restart-mode mandates would contradict that.
                    "restart_mode": if ledger_deny.is_some() { "lab-director-keep-refining" } else { "lab-director-gate-restart" },
                    "ledger_pivot_deny": match &ledger_deny { Some(reason) => json!(reason), None => Value::Null },
                    "must_select_one_promotable_family": ledger_deny.is_none(),
                    "must_demote_literature_only_claims": ledger_deny.is_none(),
                    "must_emit_validation_handoff_before_document_stage": true,
                    "selection_scope": "gatekeeper-objection-conditioned",
                }),
            )?;
            existing_signatures.insert(director_signature);
            *created_by_role
                .entry("lab-director".to_string())
                .or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "lab-director", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "lab-director",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    if created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "scout",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "scout",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        // In explore mode the role plan carries NO lead -- dispatch.rs empties
        // assigned_selected_hypotheses there on purpose, because explore means do
        // not pin the search to the incumbent. Telling this scout to "overturn the
        // current lead" therefore names something it was never given: v85 ran 112
        // explore passes, 21 of 45 scout lanes had no hypotheses at all, and the
        // same gate-restart action was redispatched up to attempt 26.
        let scout_description = if plan_ctx.convergence_mode == "explore" {
            format!(
                "{description} Search the problem space WIDE, not the incumbent: look for hypothesis families this cycle has not tried, measurement designs its instruments can support, and results that would make a different family the obvious lead. Do not anchor on the current lead -- you are not given it, and that is deliberate. [attempt {attempt}]"
            )
        } else {
            format!(
                "{description} Restart from the gatekeeper's objections by searching for stronger competing hypothesis families, sharper falsification targets, and literature that can overturn the current lead. [attempt {attempt}]"
            )
        };
        let scout_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "scout",
            brief_id,
            &scout_description,
            restart_scope,
        );
        let scout_signature = followup_task_signature(&scout_task_body);
        if !existing_signatures.contains(&scout_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                "external-driver",
                "driver-exec",
                &scout_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                assigned_model_for_role("scout", "external-driver"),
                plan_ctx.objective,
                brief_id,
                &scout_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "scout",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "novelty_mode": "gate-restart-regeneration",
                    "selection_scope": "gate-restart-open-search",
                }),
            )?;
            existing_signatures.insert(scout_signature);
            *created_by_role.entry("scout".to_string()).or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "scout", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "scout",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    // MEASURED ON cycle-a-20260919, 2026-11-10: the analyst lane below
    // had reached attempt 239. With the lead withdrawn and no candidate on the
    // action it is told to "synthesize and rank replacement hypotheses" and is
    // handed none, so it waits on the missing-hypothesis dependency, the cycle sits
    // for an hour until the stall is noticed, and a director is opened to retire
    // it -- whose `restart` queues the next one. Director 1922: "this is director
    // selection work, not an executable analyst handoff". Ranking needs something
    // to rank; so does the runner's "fresh validation pass on replacement
    // hypotheses".
    let lead_has_statement = current_lead_under_review(paths, cycle_id)
        .get("statement")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty());
    let something_to_rank = lead_has_statement || !action_candidate_payload.is_empty();

    // The same assignment, on a cycle in which nothing has ended since the last
    // analyst took it, gets the same answer: the director hears that answer once
    // instead of another analyst being opened.
    let analyst_due = created.len() < max_new_lanes
        && something_to_rank
        && followup_role_available(
            role_availability,
            "analyst",
            action_type,
            created_by_role,
            created_by_action,
        );
    let already_answered = if analyst_due { restart_analyst_that_answered_this_state(paths, cycle_id) } else { None };
    if let Some(answered_by) = already_answered.as_deref() {
        hand_restart_answer_to_director(paths, cycle_id, answered_by);
    }

    if analyst_due && already_answered.is_none() {
        let attempt = next_dispatch_action_attempt(
            "analyst",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let analyst_description = format!(
            "restart the hypothesis set from the gatekeeper critique, synthesize replacement lead hypotheses, and rank them by novelty, falsifiability, and data-verifiability [attempt {attempt}]"
        );
        let analyst_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "analyst",
            brief_id,
            &analyst_description,
            restart_scope,
        );
        let analyst_signature = followup_task_signature(&analyst_task_body);
        if !existing_signatures.contains(&analyst_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-analyst-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "analyst",
                "external-driver",
                "driver-exec",
                &analyst_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "analyst",
                assigned_model_for_role("analyst", "external-driver"),
                plan_ctx.objective,
                brief_id,
                &analyst_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "analyst",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "novelty_mode": "gate-restart-rerank",
                    "selection_scope": "gatekeeper-objection-conditioned",
                }),
            )?;
            existing_signatures.insert(analyst_signature);
            *created_by_role.entry("analyst".to_string()).or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "analyst", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "analyst",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    if created.len() < max_new_lanes
        && something_to_rank
        && !explicit_hypothesis_gate_failed(paths, cycle_id)?
        && followup_role_available(
            role_availability,
            "lab-runner",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "lab-runner",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let runner_description = format!(
            "run a fresh validation pass on replacement hypotheses implied by the gatekeeper critique, emphasizing stronger confound control, rival tests, and falsification checks [attempt {attempt}]"
        );
        let runner_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-runner",
            brief_id,
            &runner_description,
            restart_scope,
        );
        let runner_signature = followup_task_signature(&runner_task_body);
        if !existing_signatures.contains(&runner_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-runner-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "lab-runner",
                "external-driver",
                "driver-exec",
                &runner_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "lab-runner",
                assigned_model_for_role("lab-runner", "external-driver"),
                plan_ctx.objective,
                brief_id,
                &runner_description,
                action_type,
                restart_scope,
                action_candidate_payload,
                Some(plan_ctx.schema_quality),
                Some(plan_ctx.reasoning_graph),
                Some(plan_ctx.data_graph),
                plan_ctx.open_validation_gaps,
                json!({
                    "priority_source": "recommended_followup_action",
                    "preferred_role": "lab-runner",
                    "target_rubric": if target_rubric.is_empty() { Value::Null } else { json!(target_rubric) },
                    "target_score": action.get("target_score").cloned().unwrap_or(Value::Null),
                    "current_score": action.get("current_score").cloned().unwrap_or(Value::Null),
                    "blocker_reasons": action.get("blocker_reasons").cloned().unwrap_or_else(|| json!([])),
                    "validation_mode": "gate-restart-fresh-pass",
                    "selection_scope": "replacement-hypothesis-validation",
                }),
            )?;
            existing_signatures.insert(runner_signature);
            *created_by_role.entry("lab-runner".to_string()).or_insert(0) += 1;
            *created_by_action
                .entry(format!("{}::{}", "lab-runner", action_type))
                .or_insert(0) += 1;
            created.push(json!({
                "lane_id": lane_id,
                "role": "lab-runner",
                "contract_path": contract_path,
                "source_brief_id": brief_id,
                "role_plan_path": role_plan_path,
            }));
        }
    }

    Ok(())
}

#[cfg(test)]
mod restart_answer_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn fixture() -> (tempfile::TempDir, AppPaths) {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        (temp, paths)
    }

    fn at(minute: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000 + minute * 60)
    }

    fn touch(path: &Path, text: &str, when: SystemTime) {
        fs::write(path, text).unwrap();
        fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap();
    }

    /// A lane launched at `launched` and ended at `ended` (minutes).
    fn lane(paths: &AppPaths, lane_id: &str, role: &str, action_type: &str, launched: u64, ended: u64, status: &str) {
        let dir = cycle_lanes_root(paths, "c").join(lane_id);
        fs::create_dir_all(&dir).unwrap();
        touch(&dir.join("role-plan.json"), &format!("{{\n  \"action_type\": \"{action_type}\",\n  \"role\": \"{role}\",\n  \"source_brief_id\": \"gate-review\"\n}}\n"), at(launched));
        touch(&dir.join("invocation.json"), "{}", at(launched));
        touch(&dir.join("final-status.json"), &format!("{{\"status\": \"{status}\"}}"), at(ended));
    }

    // MEASURED: analysts 1641-1655, fifteen in a row, with nothing else ending.
    #[test]
    fn a_restart_analyst_is_not_reopened_while_nothing_has_ended_since_the_last_one_began() {
        let (_temp, paths) = fixture();
        lane(&paths, "followup-engineer-1307", "engineer", "simulation_generation_followup", 0, 10, "failed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c"), None, "no restart analyst has run");
        lane(&paths, "followup-analyst-1641", "analyst", "gate_restart_followup", 20, 27, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c").as_deref(), Some("followup-analyst-1641"));
        // A director deciding changes the answer only through what it orders.
        lane(&paths, "followup-lab-director-2093", "lab-director", "lab_director_requery_followup", 28, 40, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c").as_deref(), Some("followup-analyst-1641"));
        // The engineer it ordered ends: the next restart analyst has something new.
        lane(&paths, "followup-engineer-1310", "engineer", "capability_provisioning_followup", 41, 55, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c"), None);
        lane(&paths, "followup-analyst-1642", "analyst", "gate_restart_followup", 56, 63, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c").as_deref(), Some("followup-analyst-1642"));
    }

    #[test]
    fn work_that_ended_while_the_analyst_ran_or_an_analyst_that_failed_leaves_the_restart_open() {
        let (_temp, paths) = fixture();
        // A gatekeeper review ended after the analyst was launched: it did not see it.
        lane(&paths, "followup-analyst-1641", "analyst", "gate_restart_followup", 20, 30, "completed");
        lane(&paths, "followup-gatekeeper-2103", "gatekeeper", "independent_gate_review_followup", 15, 25, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c"), None);
        // Another analyst's own work counts as work.
        let (_temp, paths) = fixture();
        lane(&paths, "followup-analyst-1641", "analyst", "gate_restart_followup", 20, 30, "completed");
        lane(&paths, "followup-analyst-1640", "analyst", "methods_followup", 31, 38, "completed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c"), None);
        // The newest restart analyst failed: it answered nothing.
        let (_temp, paths) = fixture();
        lane(&paths, "followup-analyst-1641", "analyst", "gate_restart_followup", 20, 30, "completed");
        lane(&paths, "followup-analyst-1642", "analyst", "gate_restart_followup", 31, 38, "failed");
        assert_eq!(restart_analyst_that_answered_this_state(&paths, "c"), None);
    }
}
