#![allow(unused_imports)]
use super::*;

pub(crate) fn dispatch_novelty_followups(
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
    is_converging: bool,
    assigned_selected_hypotheses: &[String],
    action_candidate_statements: &[String],
    action_candidate_payload: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<bool> {
    if action_type != "novelty_followup" {
        return Ok(false);
    }

    if assigned_selected_hypotheses.is_empty() {
        if is_converging {
            // Converging suppresses WIDENING the hypothesis space, which is
            // right: the open branch below tells a scout to enumerate every
            // method family the objective spans, and that is exploration.
            //
            // A prior-art audit of the lead already chosen is not exploration.
            // It is the evidence the gate needs to score novelty at all, and
            // suppressing it here means novelty can never clear at exactly the
            // moment the cycle has settled on something to clear.
            //
            // MEASURED ON cycle-g-v91, 2026-09-13. convergence_mode=converge,
            // and the plan held EIGHT queued `novelty_followup` actions naming
            // `scout` -- "complete and finalize the paper-specific, hash-matched
            // prior-art audit" -- none carrying a selected hypothesis, so every
            // one returned here having dispatched nothing. Zero scout
            // novelty lanes existed in a cycle at gate round 15. The gatekeeper
            // scored novelty 50 and wrote the reason: "four targeted searches
            // found no exact match, but the retrieval was noisy and cannot clear
            // novelty". The audit that would settle it was requested eight times
            // and discarded eight times.
            //
            // So when converging, the lead is taken from the artifact instead of
            // the action and the selected branch runs. There is a lead by
            // definition -- that is what converging means -- and if there is
            // not, nothing is dispatched, as before.
            let lead = current_lead_under_review(paths, cycle_id);
            let statement = lead
                .get("statement")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let Some(statement) = statement else {
                return Ok(true);
            };
            let from_artifact = vec![statement.to_string()];
            dispatch_selected_novelty_followups(
                paths,
                cycle_id,
                max_new_lanes,
                plan_ctx,
                role_availability,
                existing_action_counts,
                action,
                action_type,
                brief_id,
                target_rubric,
                &from_artifact,
                action_candidate_payload,
                created,
                existing_signatures,
                created_by_role,
                created_by_action,
            )?;
            return Ok(true);
        }
        let novelty_hypotheses = if action_candidate_statements.is_empty() {
            Vec::new()
        } else {
            action_candidate_statements.to_vec()
        };
        dispatch_open_novelty_followups(
            paths,
            cycle_id,
            max_new_lanes,
            plan_ctx,
            role_availability,
            existing_action_counts,
            action,
            action_type,
            brief_id,
            description,
            target_rubric,
            &novelty_hypotheses,
            action_candidate_payload,
            created,
            existing_signatures,
            created_by_role,
            created_by_action,
        )?;
        return Ok(true);
    }

    dispatch_selected_novelty_followups(
        paths,
        cycle_id,
        max_new_lanes,
        plan_ctx,
        role_availability,
        existing_action_counts,
        action,
        action_type,
        brief_id,
        target_rubric,
        assigned_selected_hypotheses,
        action_candidate_payload,
        created,
        existing_signatures,
        created_by_role,
        created_by_action,
    )?;
    Ok(true)
}

pub(crate) fn dispatch_open_novelty_followups(
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
    novelty_hypotheses: &[String],
    action_candidate_payload: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
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
        let scout_description = format!(
            "{description} Search BROADLY and autonomously across the objective's whole prior-art landscape so novelty can be judged against the RIGHT baseline: enumerate the distinct method families / sub-topics the objective spans and cover EACH (do not drill a single hot sub-area), and deliberately surface the DIRECT prior art and named baselines for the current lead's specific technique — including foundational works and any survey / state-of-the-art report, not only the newest preprints. The goal is a corpus that already contains whatever prior work would make this lead non-novel, plus adjacent rival families that suggest a genuinely more novel direction. Use the field's own expert vocabulary; do not assume epidemiology/econometrics framing (moderators, lag structures, cohorts) unless the objective is actually in that field. [attempt {attempt}]"
        );
        let scout_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "scout",
            brief_id,
            &scout_description,
            novelty_hypotheses,
        );
        let scout_signature = followup_task_signature(&scout_task_body);
        if !existing_signatures.contains(&scout_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                "codex-agent",
                "read-write-scoped",
                &scout_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                assigned_model_for_role("scout", "codex-agent"),
                plan_ctx.objective,
                brief_id,
                &scout_description,
                action_type,
                novelty_hypotheses,
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
                    "novelty_mode": "expand-hypothesis-space",
                    "selection_scope": if novelty_hypotheses.is_empty() {
                        "open"
                    } else {
                        "graph-derived-candidates"
                    },
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

    if created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "analyst",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "analyst",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let analyst_description =
            format!("synthesize more original hypothesis families from reasoning-graph claims and data-graph weak spots, emphasizing moderators, partitions, threshold effects, alternative mechanisms, and measurement channels [attempt {attempt}]");
        let analyst_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "analyst",
            brief_id,
            &analyst_description,
            novelty_hypotheses,
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
                novelty_hypotheses,
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
                    "novelty_mode": "synthesize-novel-hypotheses",
                    "selection_scope": if novelty_hypotheses.is_empty() {
                        "open"
                    } else {
                        "graph-derived-candidates"
                    },
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
    Ok(())
}

pub(crate) fn dispatch_selected_novelty_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_new_lanes: usize,
    plan_ctx: &DispatchPlanContext<'_>,
    role_availability: &FollowupRoleAvailabilityContext<'_>,
    existing_action_counts: &HashMap<String, usize>,
    action: &Value,
    action_type: &str,
    brief_id: &str,
    target_rubric: &str,
    assigned_selected_hypotheses: &[String],
    action_candidate_payload: &[Value],
    created: &mut Vec<Value>,
    existing_signatures: &mut HashSet<String>,
    created_by_role: &mut HashMap<String, usize>,
    created_by_action: &mut HashMap<String, usize>,
) -> Result<()> {
    // Once a hypothesis is chosen, nobody went back to the literature for it.
    //
    // This branch dispatched a lab-runner to execute the selected hypothesis and
    // an analyst to design tests for it -- both about whether the claim is TRUE.
    // Nothing asked whether it is NEW. The sibling branch above does search, but
    // it runs only while no hypothesis has been selected, so its query is the
    // whole prior-art landscape rather than this claim's.
    //
    // Those are different searches. "What is this field working on" returns the
    // crowded centre; "who has already done THIS, and what is it measured
    // against" returns the handful of papers that decide whether the lead
    // survives -- and the second question cannot be asked until there is a lead
    // to ask it about.
    //
    // MEASURED ON cycle-g-v91: the two `novelty_followup` lanes opened were
    // followup-analyst-01 and followup-runner-01. No scout. Novelty is the
    // binding rubric in this programme and the gate has been failing leads on it
    // for many cycles; the corpus that would settle it was never gathered for
    // the lead in hand.
    //
    // It is dispatched FIRST for the same reason. This action exists to move
    // novelty, and when slots are scarce the prior art is what moves it -- a
    // validation run on a lead that a known paper already published is work
    // spent to learn something the literature would have said.
    if created.len() < max_new_lanes
        && !assigned_selected_hypotheses.is_empty()
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
        let scout_description = format!(
            "search the prior art for the SELECTED hypothesis below, not for the field around it. Find the closest published work to this specific claim -- the same measured quantity, the same intervention, the same decision it is trying to make -- and the named baselines and evaluations it would have to beat. Include foundational work and any survey or state-of-the-art report that would already contain it, not only recent preprints: a claim is not novel because nothing recent says it. Report what you find as prior art EVEN IF it removes the novelty of this lead; a lead retired here costs one lane, and the same lead retired at the gate costs the cycle. If the closest work you can find does not cover the claim, say precisely which part is uncovered, because that gap is the novelty delta the gate will ask for. Use the field's own vocabulary as it appears in the objective and the hypothesis; do not import framing from another discipline. [attempt {attempt}]"
        );
        let scout_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "scout",
            brief_id,
            &scout_description,
            assigned_selected_hypotheses,
        );
        let scout_signature = followup_task_signature(&scout_task_body);
        if !existing_signatures.contains(&scout_signature) {
            let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
            let contract_path = create_lane_contract(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                "codex-agent",
                "read-write-scoped",
                &scout_task_body,
            )?;
            let role_plan_path = write_followup_role_plan(
                paths,
                cycle_id,
                &lane_id,
                "scout",
                assigned_model_for_role("scout", "codex-agent"),
                plan_ctx.objective,
                brief_id,
                &scout_description,
                action_type,
                assigned_selected_hypotheses,
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
                    "novelty_mode": "prior-art-for-selected-hypothesis",
                    "selection_scope": "selected_hypotheses_only",
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

    // A lab-runner executes an analyst handoff; it cannot do anything else.
    // MEASURED ON cycle-a-20260919, 2026-09-28/29: with novelty the
    // gate's binding rubric, the plan held 84 novelty_followup actions -- asking
    // for scouts, the director, the gatekeeper, chronicle, never a runner -- and
    // this branch opened a runner for each one it reached. With no new handoff to
    // run, each re-executed the newest ready one, followup-analyst-192's, which
    // failed before inference every time: 25 of 37 runners in ten hours ran it,
    // the last eight back to back, one every five minutes, and the director
    // began each decision by explaining the same failure again.
    //
    // So a novelty action opens a runner only while a handoff is actually
    // waiting for one. The scout above is what moves novelty.
    if created.len() < max_new_lanes
        && latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)?
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
            "test the selected novelty hypotheses by closing explicit reasoning-graph gaps with moderator, threshold, partition, lag, or rival-explanation analysis rather than repeating the pooled baseline result [attempt {attempt}]"
        );
        let runner_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "lab-runner",
            brief_id,
            &runner_description,
            assigned_selected_hypotheses,
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
                assigned_selected_hypotheses,
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
                    "novelty_mode": "validate-selected-novel-hypotheses",
                    "selection_scope": "selected_hypotheses_only",
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

    if created.len() < max_new_lanes
        && followup_role_available(
            role_availability,
            "analyst",
            action_type,
            created_by_role,
            created_by_action,
        )
    {
        let attempt = next_dispatch_action_attempt(
            "analyst",
            action_type,
            existing_action_counts,
            created_by_action,
        );
        let analyst_description =
            format!("translate the selected novelty hypotheses into explicit moderator, threshold, rival-explanation, or high-upside test families using the reasoning graph and current data graph as the primary guide [attempt {attempt}]");
        let analyst_task_body = followup_task_markdown(
            cycle_id,
            plan_ctx.objective,
            "analyst",
            brief_id,
            &analyst_description,
            assigned_selected_hypotheses,
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
                assigned_selected_hypotheses,
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
                    "novelty_mode": "synthesize-novel-hypotheses",
                    "selection_scope": "selected_hypotheses_only",
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
    Ok(())
}
