#![allow(unused_imports)]
use super::*;

/// How long a lane has been waiting for a worker slot, in seconds.
///
/// Taken from its contract, which is written once when the lane is created and
/// never rewritten, so it is the one timestamp that means "waiting since".
/// Put the roles other lanes are waiting on at the front of the dispatch order.
///
/// Blocked lanes are skipped before slots are handed out, so they hold nothing.
/// The lane whose completion would RELEASE them competes for the same few slots
/// as work nobody is waiting on, and loses on a sort that has no idea anyone is
/// waiting.
///
/// MEASURED ON cycle-g-v91, 2026-09-13. Ten gatekeepers were blocked on
/// `waiting-for-latest-analyst-handoff-runner`; the handoff was written at 03:13
/// and no runner started on it until 04:37, an hour and twenty-four minutes
/// later, with every dispatch pass in between recording nineteen
/// `no-worker-slots` skips. The gate sat at round 32 for three hours.
///
/// The blocker names who can clear it -- `awaited_role`, the field added when
/// every blocker was given an owner -- so this reads that and nothing else. No
/// action type and no role literal: whichever role is being waited on this cycle
/// is the one promoted, and a cycle where nobody is waiting sorts as before.
///
/// Stable, so the order already computed survives inside each group.
pub(crate) fn awaited_roles_first(
    items: &mut [(PathBuf, LaneContract)],
    awaited_roles: &HashSet<String>,
) {
    // An engineer stays first even so, the one role this rule names on purpose.
    // MEASURED ON cycle-b-20260918, 2026-09-18: a simulation order had its
    // engineer pending at the top pending-lane priority, and this promotion --
    // applied after that sort -- moved two literature lanes ahead of it, twice,
    // while all downstream work waited on the engineer's data. Engineer lanes
    // exist only to provision or produce what the rest of the cycle consumes.
    if awaited_roles.is_empty() {
        items.sort_by_key(|(_, contract)| u8::from(contract.role != "engineer"));
        return;
    }
    items.sort_by_key(|(_, contract)| {
        (
            u8::from(contract.role != "engineer"),
            u8::from(!awaited_roles.contains(&contract.role)),
        )
    });
}

pub(crate) fn lane_waiting_seconds(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> u64 {
    let contract_path = lane_root(paths, cycle_id, lane_id).join("lane-contract.json");
    let Ok(metadata) = fs::metadata(&contract_path) else {
        return 0;
    };
    let Ok(created) = metadata.modified() else {
        return 0;
    };
    SystemTime::now()
        .duration_since(created)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Seconds a lane may be passed over before it outranks fresh work.
///
/// Tunable because the right value depends on how long a lane takes and how
/// many slots there are; 0 disables the promotion and restores the old order.
fn dispatch_starvation_seconds() -> u64 {
    env::var("RESEARCHLAB_DISPATCH_STARVATION_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(3600)
}

/// 0 for a lane that has waited past the threshold, 1 for everything else.
///
/// The dispatch order is a priority sort with no term for waiting, and slots
/// are few. When higher-ranked work is created faster than it is consumed, the
/// sort is stable against the same losers forever: a lane behind the cut is
/// behind it on every round, and nothing about it changes.
///
/// MEASURED ON cycle-g-v91, 2026-09-13/14. With `--max-concurrency 3`, a single
/// dispatch pass skipped 37 lanes and 29 of them read `no-worker-slots`. Two of
/// those were the cycle's only `abstract_review_followup` lanes -- the step that
/// turns retrieved papers into admitted ones -- enqueued at 10:09Z and still
/// unlaunched five and a half hours later, with the plan holding 94 queued
/// novelty actions and 51 gate-restart actions ahead of them. Admitted papers
/// sat at 179 for the whole of it while the gate advanced from round 21 to 29,
/// and every literature lane that found reviewable papers was recorded as a
/// blocking failure asking for the review lane that could not start.
///
/// Deliberately not a list of action types that deserve a slot. The failure is
/// starvation, not a mis-ranked action, and the next starved lane will be some
/// other kind: a rule that names the one seen here fixes this cycle and no
/// other. This promotes any lane that has been waiting too long, whatever it
/// is, and leaves the existing keys to order the promoted ones among
/// themselves.
///
/// It sits BELOW the owner's document authorization, which the comment there
/// says must settle the order at the first key, and above everything the
/// scheduler decides for itself.
pub(crate) fn dispatch_starvation_rank(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> u8 {
    let threshold = dispatch_starvation_seconds();
    if threshold == 0 {
        return 1;
    }
    if lane_waiting_seconds(paths, cycle_id, lane_id) >= threshold {
        0
    } else {
        1
    }
}

/// The starvation key: the rank above, then -- among starved lanes only --
/// longest waiting first.
///
/// The rank alone promotes a starved lane over fresh work, but once every
/// candidate has been waiting past the threshold it no longer tells them apart,
/// and the keys below it pick the same winner every time.
///
/// MEASURED ON cycle-a-20260919, 2026-09-29. Ten gate re-reviews were
/// queued, each waiting for new lead evidence; with one worker slot, whenever
/// evidence arrived the novelty re-review won on the keys below this one. The
/// technical-quality re-review, enqueued 09-28 15:26Z, and the reproducibility
/// one (16:41Z) were still unlaunched seventeen hours later, while three
/// novelty re-reviews enqueued at 19:46Z ran. The gate kept scoring
/// reproducibility 6 from a review of a lead retired the day before, while
/// reviews of the current lead put it at 78-82.
///
/// Lanes that are not starved all get the same key, so their order is the
/// scheduler's as before.
pub(crate) fn dispatch_starvation_order(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
) -> (u8, std::cmp::Reverse<u64>) {
    if dispatch_starvation_rank(paths, cycle_id, lane_id) == 0 {
        (0, std::cmp::Reverse(lane_waiting_seconds(paths, cycle_id, lane_id)))
    } else {
        (1, std::cmp::Reverse(0))
    }
}

pub(crate) fn open_contract_paths_for_dispatch(
    paths: &AppPaths,
    cycle_id: &str,
    fresh_followups: &[Value],
) -> Result<Option<Vec<PathBuf>>> {
    let Some(lane_statuses) = cached_large_cycle_lane_statuses(paths, cycle_id)? else {
        return Ok(None);
    };

    let mut seen = HashSet::new();
    let mut contract_paths = Vec::new();
    for followup in fresh_followups {
        let Some(raw_path) = followup.get("contract_path").and_then(Value::as_str) else {
            continue;
        };
        let path = PathBuf::from(raw_path);
        let key = path.display().to_string();
        if seen.insert(key) && path.exists() {
            contract_paths.push(path);
        }
    }

    for lane in lane_statuses {
        let status = lane.get("status").and_then(Value::as_str).unwrap_or("");
        if !matches!(status, "pending" | "prepared" | "running") {
            continue;
        }
        let Some(lane_id) = lane.get("lane_id").and_then(Value::as_str) else {
            continue;
        };
        let path = lane
            .get("contract_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| lane_root(paths, cycle_id, lane_id).join("lane-contract.json"));
        let key = path.display().to_string();
        if seen.insert(key) && path.exists() {
            contract_paths.push(path);
        }
    }

    Ok(Some(contract_paths))
}

pub(crate) fn dispatchable_contract_paths(
    paths: &AppPaths,
    cycle_id: &str,
    contract_paths: Vec<PathBuf>,
) -> Vec<PathBuf> {
    contract_paths
        .into_iter()
        .filter(|path| {
            let Some(lane_id) = path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
            else {
                return true;
            };
            // MEASURED ON cycle-a-20260919, 2026-09-30.
            // followup-lab-director-195 had a final-status record whose status
            // was `prepared` after quota recovery. Treating the record's mere
            // existence as terminal kept it queued for 157 hours while newer
            // LabDirector lanes ran. Prepared is runnable; only a terminal
            // status may remove a contract from dispatch.
            !lane_has_finalized_outputs(paths, cycle_id, lane_id)
        })
        .collect()
}

pub(crate) fn dispatch_pre_schedule_followups(
    paths: &AppPaths,
    cycle_id: &str,
    max_concurrency: usize,
    dispatch_batch_size: usize,
) -> Result<Vec<Value>> {
    if max_concurrency == 0 {
        return Ok(Vec::new());
    }
    if latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)? {
        return dispatch_followup_lanes(paths, cycle_id, dispatch_batch_size);
    }
    if external_validation_required_for_gate(paths, cycle_id)? {
        let mut created =
            dispatch_external_validation_gate_lanes(paths, cycle_id, dispatch_batch_size)?;
        if created.is_empty() {
            created = dispatch_followup_lanes(paths, cycle_id, dispatch_batch_size)?;
        }
        return Ok(created);
    }
    Ok(Vec::new())
}

pub fn run_plan(
    paths: &AppPaths,
    cycle_id: &str,
    max_passes: usize,
    sleep_seconds: u64,
    max_concurrency: usize,
    stale_seconds: u64,
) -> Result<Value> {
    let plan = materialize_long_run_plan(paths, cycle_id, None)?;
    let manifest_path = plan
        .get("lane_manifest_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("missing lane manifest path"))?;

    clear_termination_code(paths, cycle_id)?;
    let mut pass_summaries = Vec::new();
    let mut terminated_early = false;
    let watchdog_interval_seconds = 600i64;
    let mut last_subagent_response_at =
        latest_subagent_response_at(paths, cycle_id)?.unwrap_or_else(Utc::now);
    let mut last_watchdog_review_at = Utc::now();
    // Mid-cycle stagnation tracking. The watchdog block above only logs a
    // dialogue event; without this block, cycles that hit a permanent
    // pending-lane gate (e.g. lab-runner-N waiting for rival-analyst-handoffs
    // that never arrive) would loop until --max-passes runs out.
    let mut last_completion_review_signature: Option<String> = None;
    let mut identical_completion_review_streak: u32 = 0;
    // Cap by env so users can experiment with longer/looser bounds.
    let stagnation_repeat_limit: u32 = env::var("RESEARCHLAB_STAGNATION_REPEAT_LIMIT")
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
        .filter(|value: &u32| *value > 0)
        .unwrap_or(3);
    let stagnation_pending_silence_seconds: i64 =
        env::var("RESEARCHLAB_STAGNATION_PENDING_SILENCE_SECONDS")
            .ok()
            .and_then(|raw| raw.trim().parse().ok())
            .filter(|value: &i64| *value > 0)
            .unwrap_or(1200);
    // Hard-stall ceiling — a native pre-gate saturation break. Pre-gate
    // stagnation normally requests a PIVOT (blocked_terminal_stop) rather than
    // terminating, and that suppresses every termination branch below via
    // `!pre_gate_pivot_requested`. The JS run-research supervisor has a
    // pre-gate saturation break (RESEARCHLAB_PREGATE_SATURATION_ROUNDS) that
    // eventually terminates such a cycle, but resume-cycle (the watchdog's
    // driver) never runs that JS path — so under the watchdog a cycle that can
    // neither progress nor pivot livelocks forever (observed in omics v5/v6:
    // watchdog restarted resume-cycle ~100x, never terminating). This bound
    // fires regardless of the pivot request when nothing has run and no
    // subagent has responded for the whole window, guaranteeing termination of
    // a truly stuck cycle. A healthy cycle keeps a lane running or produces
    // subagent responses, so it never reaches this idle threshold.
    let hard_stall_seconds: i64 = env::var("RESEARCHLAB_HARD_STALL_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
        .filter(|value: &i64| *value > 0)
        .unwrap_or(3600);
    // C3 busy-livelock backstop. `identical_completion_review_streak` above
    // RESETS on any activity (a running lane, a created followup, a launch), so a
    // cycle that spawns followup-scouts/analysts every pass while making ZERO
    // scientific progress (observed: cg v18 160 scouts, v23 326 topic_dominance
    // checks, 0 completed lab-runner, gate never scores) keeps resetting the
    // streak and never trips repeated_review_stagnation (which also demands
    // created_followups.is_empty()) nor hard_stall (which demands running==0).
    // It runs forever. This tracks a SCIENTIFIC signature (completion/approval
    // score, claim + completed-experiment counts, gate score, hypothesis gate)
    // that generic followup churn does NOT change, and grows a streak whenever
    // that signature is flat AND no core (analyst/lab-runner) lane is running
    // (so a genuinely long in-flight experiment is never mistaken for churn).
    // At `sci_stagnation_rounds` it requests a pivot (through the same machinery
    // as pre_gate stagnation, but firing even during followup churn); at 2x it
    // TERMINATES regardless of the pivot request — the guaranteed livelock kill.
    let mut last_scientific_signature: Option<String> = None;
    let mut scientific_stagnation_streak: u64 = 0;
    let sci_stagnation_rounds: u64 = env::var("RESEARCHLAB_SCI_STAGNATION_ROUNDS")
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
        .filter(|value: &u64| *value > 0)
        .unwrap_or(6);

    for pass in 1..=max_passes {
        let mut launched = Vec::new();
        let mut skipped = Vec::new();
        let mut pre_dispatch_labdirector_review = review_labdirector_inbox(paths, cycle_id)?;
        // The owner may re-choose by rewriting their selection file; see
        // problem_selection::owner::apply_owner_reselection.
        crate::labdirector::problem_selection::apply_owner_reselection(paths, cycle_id)?;

        // Researcher-issued /pause blocks the dispatch loop here until /resume
        // or /stop lands in the inbox. Each wake re-drains the inbox so control
        // commands are honored promptly.
        let pause_poll_seconds = sleep_seconds.max(5);
        while is_cycle_paused(paths, cycle_id) {
            // An owner-selection pause lifts itself once the owner has chosen a
            // candidate (or its configured timeout passed); see
            // labdirector::problem_selection::owner.
            if release_owner_selection_pause(paths, cycle_id)? {
                continue;
            }
            if read_termination_code(paths, cycle_id)?
                .as_ref()
                .and_then(|value| value.get("should_stop"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                break;
            }
            sleep_until_intervention_or_timeout(paths, cycle_id, pause_poll_seconds)?;
            if let Some(review) = review_labdirector_inbox(paths, cycle_id)? {
                pre_dispatch_labdirector_review = Some(review);
            }
        }
        // A runtime watchdog can write a terminal pause marker while a
        // background Codex lane is running.  Never schedule another lane once
        // that marker remains present; a manual resume is the only safe way to
        // clear it after Windows sandbox setup is resolved.
        if is_cycle_paused(paths, cycle_id) {
            terminated_early = true;
            break;
        }

        let dispatch_batch_size = max_concurrency.max(4);
        let handoff_waiting_for_runner =
            latest_executable_analyst_handoff_waiting_for_runner(paths, cycle_id)?;
        let mut pre_created_followups = if handoff_waiting_for_runner {
            dispatch_pre_schedule_followups(paths, cycle_id, max_concurrency, dispatch_batch_size)?
        } else {
            Vec::new()
        };
        let supervisor_actions = if handoff_waiting_for_runner {
            Vec::new()
        } else {
            supervise_cycle(paths, cycle_id, 2, stale_seconds)?
        };
        if pre_created_followups.is_empty() {
            pre_created_followups = dispatch_pre_schedule_followups(
                paths,
                cycle_id,
                max_concurrency,
                dispatch_batch_size,
            )?;
        }
        // The field landscape, from the first pass and again whenever it is
        // missing or invalid; no lead can be selected without it. See
        // labdirector::field_landscape.
        if max_concurrency > 0 {
            pre_created_followups.extend(dispatch_field_landscape_scout(paths, cycle_id)?);
            // Then the frontier harvest: the post-horizon papers citing the
            // landscape's canonical works, reviewed before the deep read. See
            // labdirector::frontier_harvest.
            pre_created_followups.extend(dispatch_frontier_harvest(paths, cycle_id)?);
            // And the reviewer for what that harvest queued: while the published
            // harvest state has a pending top-K candidate and no live lane is
            // bound to its queue, one Codex scout reviews it. The harvest lane's
            // own pending_review handoff does not survive a self-heal reset.
            pre_created_followups.extend(dispatch_frontier_review(paths, cycle_id)?);
            // Then the SOTA deep read: ~10 landscape papers read in full, one
            // card each. See labdirector::sota_cards.
            pre_created_followups.extend(dispatch_sota_deep_read_scout(paths, cycle_id)?);
            // Then the expert selection between the SOTA cards and the lead:
            // beliefs, slate, panel, novelty, feasibility, owner checkpoint. See
            // labdirector::problem_selection.
            pre_created_followups.extend(dispatch_expert_selection(paths, cycle_id)?);
        }
        let ordered_contracts =
            |fresh_followups: &[Value]| -> Result<Vec<(PathBuf, LaneContract)>> {
                let gate_closure_ready =
                    hypothesis_gate_closure_ready(paths, cycle_id).unwrap_or(false);
                let external_validation_required =
                    external_validation_required_for_gate(paths, cycle_id).unwrap_or(false);
                let contract_paths = if let Some(paths) =
                    open_contract_paths_for_dispatch(paths, cycle_id, fresh_followups)?
                {
                    paths
                } else {
                    all_cycle_contract_paths(paths, cycle_id)?
                };
                let document_stage_released = document_stage_authorized(paths, cycle_id);
                let mut items = dispatchable_contract_paths(paths, cycle_id, contract_paths)
                    .into_iter()
                    .map(|path| {
                        let contract: LaneContract = serde_json::from_value(read_json(&path)?)?;
                        Ok((path, contract))
                    })
                    .collect::<Result<Vec<_>>>()?;
                items.sort_by_cached_key(|(_, contract)| {
                    let mut novelty_rank = 2u8;
                    let mut gate_action_rank = 3u8;
                    let mut pipeline_unblock_rank = 1u8;
                    let role_plan_path = lane_role_plan_path(paths, cycle_id, &contract.lane_id);
                    if let Ok(Some(role_plan)) = read_role_plan_if_compact(&role_plan_path) {
                        pipeline_unblock_rank =
                            pending_lane_pipeline_unblock_rank(Some(&role_plan));
                        gate_action_rank = pending_lane_action_priority(
                            Some(&role_plan),
                            external_validation_required,
                        );
                        let target_rubric = role_plan
                            .get("planner_metadata")
                            .and_then(|item| item.get("target_rubric"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let action_type = role_plan
                            .get("action_type")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let brainstorm_frame = role_plan
                            .get("planner_metadata")
                            .and_then(|item| item.get("brainstorm_frame"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if target_rubric == "novelty"
                            || action_type == "novelty_followup"
                            || !brainstorm_frame.is_empty()
                        {
                            novelty_rank = if contract.role == "scout" || contract.role == "analyst"
                            {
                                0
                            } else {
                                1
                            };
                        }
                    }
                    let gate_review_rank = if gate_closure_ready && contract.role == "gatekeeper" {
                        0u8
                    } else {
                        1u8
                    };
                    let (phase_rank, role_rank, lane_key) =
                        lane_priority_rank_with_authorization(&contract, document_stage_released);
                    let phase_rank = if gate_action_rank <= 2 {
                        0u8
                    } else {
                        phase_rank
                    };
                    // An owner authorization to document the cycle settles the order
                    // at the FIRST key, because the five below it cannot.
                    //
                    // MEASURED ON cycle-g-v89: the cycle reached the budget wall with
                    // author-01 still pending. Not because author sorts last among the
                    // base roles -- a base lane already outranks every `followup-*` on
                    // phase_rank -- but because `gate_action_rank <= 2` promotes a
                    // gate-driven follow-up to phase 0, and it then wins on
                    // gate_review_rank or gate_action_rank, both compared before
                    // role_rank. An authorization that loses on the third key is a door
                    // the scheduler never walks through.
                    let owner_document_rank = if document_stage_released
                        && matches!(contract.role.as_str(), "author" | "illustrator")
                    {
                        0u8
                    } else {
                        1u8
                    };
                    let starvation_rank =
                        dispatch_starvation_order(paths, cycle_id, &contract.lane_id);
                    (
                        owner_document_rank,
                        // MEASURED ON cycle-a-20260919, 2026-10-01:
                        // followup-runner-101 was the only lane that could turn
                        // the selected simulation bundle into fresh validation,
                        // but it stayed pending behind 60 gate reviews aged up
                        // to 49 hours. Three comparator-design lanes completed
                        // while the cycle remained at experiment_data. Preserve
                        // general anti-starvation ordering after this one direct
                        // handoff edge has been allowed to advance the pipeline.
                        pipeline_unblock_rank,
                        starvation_rank,
                        phase_rank,
                        gate_review_rank,
                        gate_action_rank,
                        novelty_rank,
                        role_rank,
                        lane_key,
                    )
                });
                Ok(items)
            };
        let mut drain_rounds = 0usize;
        let drain_sleep_seconds = sleep_seconds.max(1);
        let max_drain_rounds = std::cmp::max(
            max_concurrency.saturating_mul(2),
            (30 / drain_sleep_seconds).max(1) as usize,
        );
        let max_core_wait_rounds = std::cmp::max(
            max_drain_rounds,
            (std::cmp::min(stale_seconds, 120) / drain_sleep_seconds).max(1) as usize,
        );
        let mut contract_items = ordered_contracts(&pre_created_followups)?;
        // The roles that some lane was waiting on last round. Empty on the first
        // round, because nothing has been observed to be waiting yet.
        let mut awaited_roles: HashSet<String> = HashSet::new();
        loop {
            drain_rounds += 1;
            skipped.clear();
            // Whoever the blocked lanes are waiting for goes first.
            //
            // Blocked lanes are skipped before slots are handed out, so they
            // hold nothing -- but the lane whose completion would RELEASE them
            // competes for the same few slots as work nobody is waiting on, and
            // loses on a sort that has no idea anyone is waiting.
            //
            // MEASURED ON cycle-g-v91, 2026-09-13. Ten gatekeepers were blocked
            // on `waiting-for-latest-analyst-handoff-runner`, whose
            // `awaited_role` is the analyst-handoff runner; the handoff was
            // written at 03:13 and no runner started on it until 04:37, an hour
            // and twenty-four minutes later, with every dispatch pass in between
            // recording nineteen `no-worker-slots` skips. The gate sat at round
            // 32 for three hours.
            //
            // The blocker itself names who can clear it -- `awaited_role`, the
            // field added when every blocker was given an owner -- so this reads
            // that and nothing else. No action type, no role literal: whichever
            // role is being waited on this cycle is the one promoted, and a
            // cycle where nobody is waiting sorts exactly as before.
            //
            // A stable sort, so the existing order survives inside each group.
            awaited_roles_first(&mut contract_items, &awaited_roles);
            let mut launched_this_round = 0usize;
            let mut blocked_this_round: Vec<(String, DependencyBlocker)> = Vec::new();
            let mut waiting_on_running_lane = false;
            let mut slot_blocked = false;
            let mut waiting_on_core_dependency = false;
            let dependency_snapshot = dependency_snapshot(paths, cycle_id)?;
            let mut active_running_lanes = if max_concurrency == 0 {
                0
            } else {
                running_lane_count(paths, cycle_id)?
            };

            for (contract_path, contract) in &contract_items {
                let run_state_path =
                    lane_root(paths, cycle_id, &contract.lane_id).join("run-state.json");

                if lane_has_finalized_outputs(paths, cycle_id, &contract.lane_id) {
                    skipped.push(json!({
                        "lane_id": contract.lane_id,
                        "reason": "already-finalized",
                    }));
                    continue;
                }

                // The background launcher persists its PID before the child
                // creates run-state.json.  Treat that interval as running so
                // a later drain round cannot spawn this contract twice.
                if lane_process_is_alive(paths, cycle_id, &contract.lane_id) {
                    waiting_on_running_lane = true;
                    skipped.push(json!({
                        "lane_id": contract.lane_id,
                        "reason": "already-launching",
                    }));
                    continue;
                }

                if run_state_path.exists() {
                    let run_state = read_json(&run_state_path)?;
                    if run_state.get("status").and_then(Value::as_str) == Some("running") {
                        waiting_on_running_lane = true;
                        skipped.push(json!({
                            "lane_id": contract.lane_id,
                            "reason": "already-running",
                        }));
                        continue;
                    }
                }

                if let Some(blocker) = dependency_blocker_detail_for_lane_with_snapshot(
                    paths,
                    cycle_id,
                    &contract,
                    &dependency_snapshot,
                )? {
                    let reason = blocker.reason.clone();
                    if reason.starts_with("waiting-for-") {
                        waiting_on_running_lane = true;
                    }
                    if reason.starts_with("waiting-for-literature-scout")
                        || reason.starts_with("waiting-for-upstream-evidence")
                        || reason.starts_with("waiting-for-core-analysis")
                    {
                        waiting_on_core_dependency = true;
                    }
                    // Recorded with who could clear it, because the skip list
                    // has always said what the lane is waiting for and never
                    // who is supposed to supply it -- and on cycle-g-v91 the
                    // answer was nobody.
                    skipped.push(json!({
                        "lane_id": contract.lane_id,
                        "reason": reason,
                        "awaited_role": blocker.awaited_role,
                        "clears_when": blocker.clears_when,
                    }));
                    blocked_this_round.push((contract.lane_id.clone(), blocker));
                    continue;
                }

                let supports_background =
                    runtime_class_supports_background(&contract.runtime_class);
                if supports_background && max_concurrency == 0 {
                    skipped.push(json!({
                        "lane_id": contract.lane_id,
                        "reason": "dispatch-disabled",
                    }));
                    continue;
                }

                refresh_role_plan_context_before_launch(paths, cycle_id, &contract)?;

                if supports_background {
                    let available_slots = max_concurrency.saturating_sub(active_running_lanes);
                    if available_slots == 0 {
                        slot_blocked = true;
                        waiting_on_running_lane = true;
                        skipped.push(json!({
                            "lane_id": contract.lane_id,
                            "reason": "no-worker-slots",
                        }));
                        continue;
                    }
                    let launched_lane = launch_lane_background(paths, contract_path)?;
                    launched.push(launched_lane);
                    launched_this_round += 1;
                    active_running_lanes += 1;
                } else {
                    let result = run_lane(paths, contract_path)?;
                    launched.push(json!({
                        "lane_id": result.lane_id,
                        "status": result.status,
                        "result_path": result.result_path,
                    }));
                    launched_this_round += 1;
                }
            }

            if launched_this_round > 0 && drain_rounds < max_drain_rounds {
                continue;
            }

            if waiting_on_core_dependency
                && active_running_lanes > 0
                && drain_rounds < max_core_wait_rounds
            {
                sleep_until_intervention_or_timeout(paths, cycle_id, drain_sleep_seconds)?;
                continue;
            }

            if waiting_on_running_lane
                && (slot_blocked || active_running_lanes > 0)
                && drain_rounds < max_drain_rounds
            {
                sleep_until_intervention_or_timeout(paths, cycle_id, drain_sleep_seconds)?;
                continue;
            }

            // A round that launched nothing, is running nothing, and skipped
            // lanes only on dependency blockers is the cycle-g-v90/v91 stall.
            // Nothing else in the tree names it: the chronicle aggregate calls a
            // cycle open-but-inactive only when `pending == 0`, and these stalls
            // all had a dozen lanes pending, so the cycle reported `running`
            // while nothing in it could move. Recording it here -- the one place
            // that knows both that nothing launched and why -- lets the expiry
            // turn it into a decision instead of a wait with no end.
            awaited_roles = blocked_this_round
                .iter()
                .filter_map(|(_, blocker)| blocker.awaited_role.clone())
                .collect();

            if launched_this_round == 0 && active_running_lanes == 0 && !blocked_this_round.is_empty()
            {
                record_dependency_stall(paths, cycle_id, &blocked_this_round);
            } else {
                clear_dependency_stall(paths, cycle_id);
            }

            break;
        }

        let brief_ids = collect_new_briefs(paths, cycle_id)?;
        let labdirector_review =
            review_labdirector_inbox(paths, cycle_id)?.or(pre_dispatch_labdirector_review);
        let cycle_state_path = aggregate_cycle(paths, cycle_id)?;
        let viz_outputs = build_all_projections(paths, cycle_id)?;
        let strategy_decision_path =
            state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
        let pre_gate_pivot_pending = if strategy_decision_path.exists() {
            let strategy = read_json(&strategy_decision_path).unwrap_or(Value::Null);
            strategy.get("mode").and_then(Value::as_str) == Some("pivot")
        } else {
            false
        };
        let mut created_followups = if max_concurrency == 0 {
            Vec::new()
        } else if external_validation_required_for_gate(paths, cycle_id)? {
            dispatch_external_validation_gate_lanes(paths, cycle_id, dispatch_batch_size)?
        } else if pending_base_lab_runner_exists(paths, cycle_id)? && !pre_gate_pivot_pending {
            Vec::new()
        } else {
            dispatch_followup_lanes(paths, cycle_id, dispatch_batch_size)?
        };
        if !pre_created_followups.is_empty() {
            let mut combined = pre_created_followups;
            combined.extend(created_followups);
            created_followups = combined;
        }
        let completion_review = labdirector_completion_review(paths, cycle_id)?;
        let latest_decision = latest_labdirector_decision(paths, cycle_id)?;
        let conclusion_gate_passed_from_review = completion_review
            .get("conclusion_gate_passed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let conclusion_gate_passed = if conclusion_gate_passed_from_review {
            true
        } else {
            let conclusion_review_path =
                state_root(paths).join(format!("{cycle_id}-conclusion-review.json"));
            if conclusion_review_path.exists() {
                read_json(&conclusion_review_path)?
                    .get("conclusion_gate_passed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            } else {
                false
            }
        };
        let hypothesis_gate_passed_now = hypothesis_gate_passed(paths, cycle_id)?;
        let document_generation_gate_passed = conclusion_gate_passed && hypothesis_gate_passed_now;
        let report_path = if document_generation_gate_passed {
            Some(build_research_report(paths, cycle_id)?)
        } else {
            None
        };
        let paper_path = if document_generation_gate_passed {
            Some(build_paper_draft(paths, cycle_id)?)
        } else {
            None
        };

        let decision = if let Some(last_brief_id) = brief_ids.last() {
            Some(decide_from_brief(paths, last_brief_id)?)
        } else {
            None
        };
        if let Some(latest_response_at) = latest_subagent_response_at(paths, cycle_id)? {
            if latest_response_at > last_subagent_response_at {
                last_subagent_response_at = latest_response_at;
            }
        }
        let cycle_state = read_json(&cycle_state_path)?;
        let lane_counts = cycle_state
            .get("lane_counts")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let pending_lane_count = lane_counts
            .get("pending")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let running_lane_total = lane_counts
            .get("running")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let report_review_path = state_root(paths).join(format!("{cycle_id}-report-review.json"));
        let report_gate_passed = if report_review_path.exists() {
            let review = read_json(&report_review_path)?;
            review
                .get("report_gate_passed")
                .and_then(Value::as_bool)
                .or_else(|| {
                    review
                        .get("communication_gate_passed")
                        .and_then(Value::as_bool)
                })
                .or_else(|| review.get("pass").and_then(Value::as_bool))
                .unwrap_or(false)
        } else {
            false
        };
        let paper_review_path = state_root(paths).join(format!("{cycle_id}-paper-review.json"));
        let paper_gate_passed = if paper_review_path.exists() {
            let review = read_json(&paper_review_path)?;
            review
                .get("paper_gate_passed")
                .and_then(Value::as_bool)
                .or_else(|| {
                    review
                        .get("submission_gate_passed")
                        .and_then(Value::as_bool)
                })
                .or_else(|| review.get("pass").and_then(Value::as_bool))
                .unwrap_or(false)
        } else {
            false
        };
        let document_gate_passed = report_gate_passed && paper_gate_passed;
        let approval_review_path =
            state_root(paths).join(format!("{cycle_id}-approval-review.json"));
        let raw_approval_gate_passed = if approval_review_path.exists() {
            let review = read_json(&approval_review_path)?;
            review
                .get("approval_gate_passed")
                .and_then(Value::as_bool)
                .or_else(|| review.get("pass").and_then(Value::as_bool))
                .unwrap_or(false)
        } else {
            false
        };
        let approval_gate_passed = raw_approval_gate_passed
            && conclusion_gate_passed
            && hypothesis_gate_passed_now
            && document_gate_passed;
        let gate_review_path = state_root(paths).join(format!("{cycle_id}-gate-review.json"));
        let gate_review = if gate_review_path.exists() {
            read_json(&gate_review_path).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let silence_seconds = (Utc::now() - last_subagent_response_at)
            .num_seconds()
            .max(0);
        let watchdog_due = silence_seconds >= watchdog_interval_seconds
            && (Utc::now() - last_watchdog_review_at).num_seconds() >= watchdog_interval_seconds;
        if watchdog_due {
            let watchdog_payload = json!({
                "cycle_id": cycle_id,
                "reviewed_at": now_iso(),
                "last_subagent_response_at": last_subagent_response_at.to_rfc3339(),
                "silence_seconds": silence_seconds,
                "pending_lane_count": pending_lane_count,
                "running_lane_count": running_lane_total,
                "completion_review_mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
                "decision_mode": latest_decision.as_ref().and_then(|item| item.get("mode")).cloned().unwrap_or(Value::Null),
            });
            append_event(
                &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
                "labdirector_watchdog_review",
                watchdog_payload,
            )?;
            last_watchdog_review_at = Utc::now();
        }
        // Mid-cycle stagnation checkpoint: surface artifact-state when progress
        // stalls. Before the approval gate passes, stagnation is not terminal:
        // it requests a pivot so the next supervisor pass can spawn a structurally
        // new hypothesis/design follow-up instead of killing the cycle.
        let completion_signature = serde_json::to_string(&json!({
            "completion_score": completion_review.get("completion_score").cloned().unwrap_or(Value::Null),
            "approval_readiness_score": completion_review.get("approval_readiness_score").cloned().unwrap_or(Value::Null),
            "approval_blocker_count": completion_review.get("approval_blocker_count").cloned().unwrap_or(Value::Null),
            "claim_count": completion_review.get("claim_count").cloned().unwrap_or(Value::Null),
            "open_question_count": completion_review.get("open_question_count").cloned().unwrap_or(Value::Null),
            "recommended_action_count": completion_review.get("recommended_action_count").cloned().unwrap_or(Value::Null),
            "completed_experiment_lanes": completion_review.get("completed_experiment_lanes").cloned().unwrap_or(Value::Null),
            "weak_rubric_dimension_count": completion_review.get("weak_rubric_dimension_count").cloned().unwrap_or(Value::Null),
            "mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
        }))
        .unwrap_or_default();
        let signature_changed = last_completion_review_signature
            .as_deref()
            .map(|prev| prev != completion_signature.as_str())
            .unwrap_or(true);
        // Only grow the repeat streak when the cycle is BOTH stuck on the same
        // review AND not making progress. If a lane is running or the
        // supervisor just dispatched followups or launched anything, the
        // unchanged review is just mid-iteration latency, not real stagnation.
        // Resetting on progress prevents the watchdog from killing genuine
        // refinement loops.
        let progress_signal_present =
            running_lane_total > 0 || !created_followups.is_empty() || !launched.is_empty();
        if signature_changed || progress_signal_present {
            identical_completion_review_streak = if signature_changed { 1 } else { 0 };
        } else {
            identical_completion_review_streak =
                identical_completion_review_streak.saturating_add(1);
        }
        last_completion_review_signature = Some(completion_signature.clone());

        // C3 scientific-progress signature (see the loop-state comment). Unlike
        // `completion_signature`, this ignores generic activity and captures only
        // scientific outcome; followup churn never changes it.
        let scientific_signature = serde_json::to_string(&json!({
            "completion_score": completion_review.get("completion_score").cloned().unwrap_or(Value::Null),
            "approval_readiness_score": completion_review.get("approval_readiness_score").cloned().unwrap_or(Value::Null),
            "claim_count": completion_review.get("claim_count").cloned().unwrap_or(Value::Null),
            "completed_experiment_lanes": completion_review.get("completed_experiment_lanes").cloned().unwrap_or(Value::Null),
            "gate_score": gate_review.get("score").cloned().unwrap_or(Value::Null),
            "hypothesis_gate_passed": hypothesis_gate_passed_now,
        }))
        .unwrap_or_default();
        let scientific_signature_changed = last_scientific_signature
            .as_deref()
            .map(|prev| prev != scientific_signature.as_str())
            .unwrap_or(true);
        // Core (analyst/lab-runner) lanes actively running = genuine in-flight
        // experiment; do NOT accrue stagnation while one is running (it will move
        // the scientific signature when it finishes). Sourced from the researcher
        // view's evidence readiness; default 0 (unknown -> allow accrual, which is
        // safe because the trigger is pivot-first and the window is generous).
        let running_core_lane_count = read_json(
            &paths
                .runtime_root
                .join("researcher-views")
                .join(format!("{cycle_id}-researcher-view.json")),
        )
        .ok()
        .and_then(|view| {
            view.get("evidence_readiness")
                .and_then(|readiness| readiness.get("running_core_lane_count"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
        if scientific_signature_changed {
            scientific_stagnation_streak = 0;
        } else if running_core_lane_count == 0 {
            scientific_stagnation_streak = scientific_stagnation_streak.saturating_add(1);
        }
        last_scientific_signature = Some(scientific_signature);
        // Fires even during followup churn (unlike repeated_review_stagnation) —
        // that is the whole point. Guarded by no running core lane + not yet
        // approved. Pivot at the bound, terminate at 2x the bound.
        let scientific_stagnation_pivot = !approval_gate_passed
            && running_core_lane_count == 0
            && scientific_stagnation_streak >= sci_stagnation_rounds;
        let scientific_stagnation_terminal = !approval_gate_passed
            && running_core_lane_count == 0
            && scientific_stagnation_streak >= sci_stagnation_rounds.saturating_mul(2);

        let no_runnable_work =
            pending_lane_count == 0 && running_lane_total == 0 && created_followups.is_empty();
        let pending_lanes_blocked = pending_lane_count > 0
            && running_lane_total == 0
            && created_followups.is_empty()
            && silence_seconds >= stagnation_pending_silence_seconds;
        let repeated_review_stagnation = identical_completion_review_streak
            >= stagnation_repeat_limit
            && running_lane_total == 0
            && created_followups.is_empty();
        // Fires even when a pre-gate pivot is requested (unlike the conditions
        // above): pending work exists, nothing is running, and no subagent has
        // responded for the whole hard-stall window. This is the resume-cycle/
        // watchdog-safe backstop against the pivot-forever livelock; it does NOT
        // require created_followups.is_empty() because the livelock is precisely
        // a followup that gets re-created every pass but can never run.
        let hard_stalled = pending_lane_count > 0
            && running_lane_total == 0
            && silence_seconds >= hard_stall_seconds;
        let pre_gate_recovery_reason = pre_gate_pivot_reason(
            approval_gate_passed,
            hypothesis_gate_passed_now,
            &completion_review,
            &gate_review,
            pending_lane_count,
            running_lane_total,
            created_followups.len(),
            silence_seconds,
            identical_completion_review_streak,
            stagnation_repeat_limit,
            stagnation_pending_silence_seconds,
        );
        // OR in the C3 scientific-stagnation pivot so the SAME pivot machinery
        // fires even while followups are still being created (the churn case the
        // pre_gate reasons above deliberately exclude).
        let pre_gate_recovery_reason =
            pre_gate_recovery_reason.or(if scientific_stagnation_pivot {
                Some("scientific_stagnation_no_progress")
            } else {
                None
            });
        let mut pre_gate_pivot_requested = false;
        if let Some(stagnation_reason) = pre_gate_recovery_reason {
            let checkpoint_payload = json!({
                "cycle_id": cycle_id,
                "reviewed_at": now_iso(),
                "stagnation_reason": stagnation_reason,
                "identical_completion_review_streak": identical_completion_review_streak,
                "stagnation_repeat_limit": stagnation_repeat_limit,
                "stagnation_pending_silence_seconds": stagnation_pending_silence_seconds,
                "pending_lane_count": pending_lane_count,
                "running_lane_count": running_lane_total,
                "created_followups_count": created_followups.len(),
                "silence_seconds": silence_seconds,
                "approval_blocker_count": completion_review.get("approval_blocker_count").cloned().unwrap_or(Value::Null),
                "approval_readiness_score": completion_review.get("approval_readiness_score").cloned().unwrap_or(Value::Null),
                "completion_score": completion_review.get("completion_score").cloned().unwrap_or(Value::Null),
                "claim_count": completion_review.get("claim_count").cloned().unwrap_or(Value::Null),
                "gate_score": gate_review.get("score").cloned().unwrap_or(Value::Null),
                "gate_mode": gate_review.get("mode").cloned().unwrap_or(Value::Null),
                "completion_review_mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
                "decision_mode": latest_decision.as_ref().and_then(|item| item.get("mode")).cloned().unwrap_or(Value::Null),
            });
            append_event(
                &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
                "labdirector_mid_checkpoint",
                checkpoint_payload.clone(),
            )?;
            let strategy_decision_path =
                state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
            let existing_strategy = if strategy_decision_path.exists() {
                read_json(&strategy_decision_path).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let pivot_payload = json!({
                "cycle_id": cycle_id,
                "decided_at": now_iso(),
                "mode": "pivot",
                "reason": format!(
                    "pre-gate stagnation detected ({stagnation_reason}); abandon the repeated completion-review payload and generate a structurally new hypothesis/design family"
                ),
                "source": "supervisor_stagnation_recovery",
                "stagnation_reason": stagnation_reason,
                "approval_gate_passed": approval_gate_passed,
                "requires_new_hypothesis_family": true,
                "requires_schema_backed_validation_design": true,
                "blocked_terminal_stop": true,
                "checkpoint": checkpoint_payload,
            });
            if should_refresh_pre_gate_pivot_decision(&existing_strategy, &pivot_payload) {
                write_json(&strategy_decision_path, &pivot_payload)?;
                append_event(
                    &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
                    "labdirector_stagnation_pivot_requested",
                    pivot_payload,
                )?;
            } else {
                append_event(
                    &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
                    "labdirector_stagnation_pivot_already_active",
                    json!({
                        "cycle_id": cycle_id,
                        "reviewed_at": now_iso(),
                        "stagnation_reason": stagnation_reason,
                        "existing_decided_at": existing_strategy.get("decided_at").cloned().unwrap_or(Value::Null),
                        "existing_reason": existing_strategy.get("reason").cloned().unwrap_or(Value::Null),
                    }),
                )?;
            }
            pre_gate_pivot_requested = true;
            identical_completion_review_streak = 0;
        }

        // FIX-AD: scout data-materialization fail-closed -> force a LabDirector
        // pivot. pre_gate_pivot_reason above only fires on lane-idle stagnation;
        // the materialization dead-end stays "busy" (scouts keep discovering
        // accession-bearing candidates while runners validate the lead on a
        // mismatched override dataset), so it never trips that path and the
        // LabDirector keeps upholding a lead whose dataset can never be
        // materialized. Detect it directly: when >= N recent scout lanes found
        // accession candidates but materialized ZERO bundles, deliver that
        // fail-closed signal to the LabDirector as a forced pivot via the existing
        // strategy-decision path (dispatch_pivot_followups then requires a
        // structurally distinct, materialized replacement family). This does NOT
        // touch any gate threshold or verdict — it is a data-availability
        // fail-closed -> pivot, it respects an in-flight pivot, and it only
        // re-arms on genuinely new fail-closed scout evidence so it cannot churn.
        if !approval_gate_passed && !pre_gate_pivot_requested {
            let failclosed_rounds =
                std::env::var("RESEARCHLAB_SCOUT_MATERIALIZATION_FAILCLOSED_ROUNDS")
                    .ok()
                    .and_then(|raw| raw.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(6);
            let override_mismatch_threshold =
                std::env::var("RESEARCHLAB_LEAD_OVERRIDE_MISMATCH_THRESHOLD")
                    .ok()
                    .and_then(|raw| raw.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(2);
            // Two independent fail-closed signals, OR'd:
            //  (1) >= N recent scout lanes discovered accession-bearing
            //      candidates but materialized ZERO bundles (no usable data at
            //      all for the search), and
            //  (2) the active lead's declared dataset/accession is never
            //      materialized while completed runners keep validating that
            //      lead on a MISMATCHED dataset via dataset_bundle_source ==
            //      "override" (materialization "succeeded" for other datasets
            //      but not the lead's; the override silently masks the dead end).
            // (2) is the one that bites a lead pinned to an unobtainable dataset.
            //
            // GUARD (locally-materialized / simulation leads): both signals are
            // proxies for "the lead's dataset can never be obtained." They are
            // keyed off the SCOUT-fetched bundle index, so a lead whose declared
            // dataset is already materialized ON DISK — a locally-generated or
            // simulation bundle under datasets/<cycle_id>/<slug>/ that no scout
            // ever "fetched" — is wrongly fail-closed and force-pivoted away even
            // though its data is present and usable. Skip the fail-closed pivot
            // entirely when the active lead's dataset exists on disk (mirrors
            // stage_gates::hypothesis_dataset_materialized: an explicit path that
            // exists, or a non-empty datasets/<cycle_id>/<slug> bundle dir).
            let materialization_failclosed =
                if active_lead_dataset_materialized_on_disk(paths, cycle_id) {
                    None
                } else {
                    latest_scout_discovery_without_materialization_summary(
                        paths,
                        cycle_id,
                        failclosed_rounds,
                    )
                    .or_else(|| {
                        active_lead_dataset_override_mismatch(
                            paths,
                            cycle_id,
                            override_mismatch_threshold,
                        )
                    })
                };
            if let Some(materialization_failclosed) = materialization_failclosed {
                let failclosed_signature = materialization_failclosed
                    .get("lane_ids")
                    .and_then(Value::as_array)
                    .and_then(|ids| ids.first())
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let strategy_decision_path =
                    state_root(paths).join(format!("{cycle_id}-strategy-decision.json"));
                let existing_strategy = if strategy_decision_path.exists() {
                    read_json(&strategy_decision_path).unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let existing_is_pivot =
                    existing_strategy.get("mode").and_then(Value::as_str) == Some("pivot");
                // An in-flight pivot is one whose LabDirector requery has not yet
                // completed; don't disturb it. A satisfied (or stale) pivot may be
                // overridden so the lead does not silently resume an uphold.
                // "In flight" = no LabDirector requery has completed since the
                // existing pivot was DECIDED. Compare only to the pivot's
                // decided_at (NOT to latest chronicle evidence): chronicle
                // evidence is produced continuously, so keying off it would make
                // every prior pivot look perpetually in-flight and this forced
                // pivot would never arm.
                let existing_pivot_in_flight = existing_is_pivot && {
                    let existing_decided_at =
                        strategy_decision_timestamp(&strategy_decision_path, &existing_strategy);
                    !completed_labdirector_requery_at_or_after(
                        paths,
                        cycle_id,
                        existing_decided_at,
                    )?
                };
                let existing_is_same_failclosed = existing_is_pivot
                    && existing_strategy.get("source").and_then(Value::as_str)
                        == Some("scout_materialization_failclosed");
                let existing_signature = existing_strategy
                    .get("scout_materialization_failclosed_signature")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let should_force_failclosed_pivot = !existing_pivot_in_flight
                    && (!existing_is_same_failclosed || existing_signature != failclosed_signature);
                if should_force_failclosed_pivot {
                    let pivot_payload = json!({
                        "cycle_id": cycle_id,
                        "decided_at": now_iso(),
                        "mode": "pivot",
                        "reason": "scout data-materialization fail-closed: scouts repeatedly discovered accession-bearing candidates but materialized zero usable bundles for the active lead, so the lead can never reach robust cross-source validation (runners fall back to a mismatched override dataset). Pivot to a structurally distinct hypothesis family whose dataset is already materialized instead of upholding an unmaterializable lead.",
                        "source": "scout_materialization_failclosed",
                        "forced": true,
                        "requires_new_hypothesis_family": true,
                        "requires_materialized_dataset": true,
                        "requires_schema_backed_validation_design": true,
                        "blocked_terminal_stop": true,
                        "scout_materialization_failclosed_signature": failclosed_signature,
                        "scout_materialization_failclosed": materialization_failclosed,
                    });
                    write_json(&strategy_decision_path, &pivot_payload)?;
                    append_event(
                        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
                        "labdirector_scout_materialization_failclosed_pivot_requested",
                        pivot_payload,
                    )?;
                    pre_gate_pivot_requested = true;
                    identical_completion_review_streak = 0;
                }
            }
        }

        if approval_gate_passed {
            let _ = write_termination_code(
                paths,
                cycle_id,
                "APPROVAL_GATE_PASSED",
                "gate_passed",
                "approval and high-impact document gates passed and the current long-run cycle can stop",
                json!({
                    "approval_gate_passed": approval_gate_passed,
                    "raw_approval_gate_passed": raw_approval_gate_passed,
                    "conclusion_gate_passed": conclusion_gate_passed,
                    "hypothesis_gate_passed": hypothesis_gate_passed_now,
                    "report_gate_passed": report_gate_passed,
                    "paper_gate_passed": paper_gate_passed,
                    "document_gate_passed": document_gate_passed,
                    "report_ready": report_path.as_ref().map(|path| path.exists()).unwrap_or(false),
                    "paper_ready": paper_path.as_ref().map(|path| path.exists()).unwrap_or(false),
                }),
            )?;
        } else if hard_stalled {
            let _ = write_termination_code(
                paths,
                cycle_id,
                "STAGNATION_HARD_STALL",
                "stagnation",
                "no lane has run and no subagent has responded for the hard-stall window; terminating a cycle that can neither progress nor pivot (resume-cycle/watchdog-safe pre-gate saturation break)",
                json!({
                    "pending_lane_count": pending_lane_count,
                    "running_lane_count": running_lane_total,
                    "created_followups_count": created_followups.len(),
                    "silence_seconds": silence_seconds,
                    "hard_stall_seconds": hard_stall_seconds,
                    "pre_gate_pivot_requested": pre_gate_pivot_requested,
                    "last_subagent_response_at": last_subagent_response_at.to_rfc3339(),
                }),
            )?;
        } else if scientific_stagnation_terminal {
            // C3 guaranteed livelock kill: fires regardless of the pivot request
            // (like hard_stall) so a cycle that keeps spawning followups with a
            // flat scientific signature and no running core lane cannot loop
            // forever. The pivot at the 1x bound already had a chance to help.
            let _ = write_termination_code(
                paths,
                cycle_id,
                "SCIENTIFIC_STAGNATION_NO_PROGRESS",
                "stagnation",
                "scientific signature (scores, claim/experiment counts, gate score, hypothesis gate) unchanged for >=2x the scientific-stagnation window while no core lane runs; the cycle is spawning followup churn without progressing and the pivot did not help — terminate with current evidence instead of looping forever",
                json!({
                    "scientific_stagnation_streak": scientific_stagnation_streak,
                    "sci_stagnation_rounds": sci_stagnation_rounds,
                    "running_core_lane_count": running_core_lane_count,
                    "pending_lane_count": pending_lane_count,
                    "running_lane_count": running_lane_total,
                    "created_followups_count": created_followups.len(),
                    "completion_score": completion_review.get("completion_score").cloned().unwrap_or(Value::Null),
                    "approval_readiness_score": completion_review.get("approval_readiness_score").cloned().unwrap_or(Value::Null),
                    "claim_count": completion_review.get("claim_count").cloned().unwrap_or(Value::Null),
                    "gate_score": gate_review.get("score").cloned().unwrap_or(Value::Null),
                    "approval_blocker_count": completion_review.get("approval_blocker_count").cloned().unwrap_or(Value::Null),
                }),
            )?;
        } else if !pre_gate_pivot_requested && no_runnable_work {
            let _ = write_termination_code(
                paths,
                cycle_id,
                "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK",
                "continuation_impossible",
                "no runnable lanes or follow-up work remain for this cycle",
                json!({
                    "pending_lane_count": pending_lane_count,
                    "running_lane_count": running_lane_total,
                    "created_followups_count": created_followups.len(),
                    "latest_decision_mode": latest_decision.as_ref().and_then(|item| item.get("mode")).cloned().unwrap_or(Value::Null),
                    "completion_review_mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
                    "last_subagent_response_at": last_subagent_response_at.to_rfc3339(),
                    "silence_seconds": silence_seconds,
                }),
            )?;
        } else if !pre_gate_pivot_requested && pending_lanes_blocked {
            let _ = write_termination_code(
                paths,
                cycle_id,
                "STAGNATION_PENDING_LANES_BLOCKED",
                "stagnation",
                "pending lanes are blocked on dependencies that no completed work can satisfy",
                json!({
                    "pending_lane_count": pending_lane_count,
                    "running_lane_count": running_lane_total,
                    "silence_seconds": silence_seconds,
                    "identical_completion_review_streak": identical_completion_review_streak,
                    "completion_review_mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
                    "decision_mode": latest_decision.as_ref().and_then(|item| item.get("mode")).cloned().unwrap_or(Value::Null),
                }),
            )?;
        } else if !pre_gate_pivot_requested && repeated_review_stagnation {
            let _ = write_termination_code(
                paths,
                cycle_id,
                "STAGNATION_REPEATED_COMPLETION_REVIEW",
                "stagnation",
                "completion review payload has not changed across multiple supervisor passes",
                json!({
                    "pending_lane_count": pending_lane_count,
                    "running_lane_count": running_lane_total,
                    "identical_completion_review_streak": identical_completion_review_streak,
                    "stagnation_repeat_limit": stagnation_repeat_limit,
                    "completion_review_mode": completion_review.get("mode").cloned().unwrap_or(Value::Null),
                    "decision_mode": latest_decision.as_ref().and_then(|item| item.get("mode")).cloned().unwrap_or(Value::Null),
                }),
            )?;
        }
        let termination = termination_status(paths, cycle_id, report_path.as_deref())?;
        let pacing = adaptive_codex_pacing_snapshot(
            paths,
            cycle_id,
            sleep_seconds,
            launched.len(),
            created_followups.len(),
        )?;
        write_json(&codex_pacing_path(paths, cycle_id), &pacing)?;
        let adaptive_pause_seconds = pacing
            .get("pause_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let unfinished_lane_count = pending_lane_count + running_lane_total;
        let watchdog_pause_cap = if unfinished_lane_count > 0 {
            let remaining_until_review = (watchdog_interval_seconds - silence_seconds)
                .clamp(1, watchdog_interval_seconds)
                as u64;
            adaptive_pause_seconds.min(remaining_until_review)
        } else {
            adaptive_pause_seconds
        };

        pass_summaries.push(json!({
            "pass": pass,
            "launched": launched,
            "skipped": skipped,
            "brief_ids": brief_ids,
            "labdirector_review": labdirector_review,
            "cycle_state_path": cycle_state_path,
            "viz_outputs": viz_outputs,
            "supervisor_actions": supervisor_actions,
            "created_followups": created_followups,
            "report_path": report_path,
            "paper_path": paper_path,
            "completion_review": completion_review,
            "latest_labdirector_decision": latest_decision,
            "decision": decision,
            "termination": termination,
            "watchdog": {
                "last_subagent_response_at": last_subagent_response_at.to_rfc3339(),
                "silence_seconds": silence_seconds,
                "review_due": watchdog_due,
            },
            "pacing": pacing,
        }));

        if termination.get("should_terminate").and_then(Value::as_bool) == Some(true) {
            terminated_early = true;
            break;
        }

        if pass < max_passes && watchdog_pause_cap > 0 {
            sleep_until_intervention_or_timeout(paths, cycle_id, watchdog_pause_cap)?;
        }
    }

    let shutdown_actions =
        wait_for_cycle_quiescence(paths, cycle_id, stale_seconds.max(60), sleep_seconds.max(1))?;
    let final_cycle_state_path = aggregate_cycle(paths, cycle_id)?;
    let final_viz_outputs = build_all_projections(paths, cycle_id)?;
    let summary_path = plans_root(paths).join(format!("{cycle_id}-run-summary.json"));
    let summary = json!({
        "cycle_id": cycle_id,
        "max_passes": max_passes,
        "sleep_seconds": sleep_seconds,
        "terminated_early": terminated_early,
        "pass_summaries": pass_summaries,
        "shutdown_actions": shutdown_actions,
    });
    write_json(&summary_path, &summary)?;

    Ok(json!({
        "cycle_id": cycle_id,
        "summary_path": summary_path,
        "final_cycle_state_path": final_cycle_state_path,
        "final_viz_outputs": final_viz_outputs,
        "passes_completed": summary["pass_summaries"].as_array().map(|items| items.len()).unwrap_or(0),
        "lane_manifest_path": manifest_path,
    }))
}

pub(crate) fn should_refresh_pre_gate_pivot_decision(existing: &Value, candidate: &Value) -> bool {
    if existing.get("mode").and_then(Value::as_str) != Some("pivot") {
        return true;
    }
    if existing.get("source").and_then(Value::as_str) != Some("supervisor_stagnation_recovery") {
        return true;
    }
    let existing_stagnation_reason = existing.get("stagnation_reason").and_then(Value::as_str);
    let candidate_stagnation_reason = candidate.get("stagnation_reason").and_then(Value::as_str);
    existing_stagnation_reason != candidate_stagnation_reason
}

// FIX-AD: distinctive token for accession matching. The longest alphanumeric
// run in the raw accession (e.g. "10.5281/zenodo.11206564" -> "11206564",
// "GSE228779" -> "gse228779"). Lower-cased for case-insensitive containment.
pub(crate) fn failclosed_accession_token(raw: &str) -> String {
    raw.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| part.len() >= 4)
        .max_by_key(|part| part.len())
        .unwrap_or("")
        .to_lowercase()
}

// A directory that exists and holds at least one entry.
pub(crate) fn dataset_dir_non_empty(dir: &std::path::Path) -> bool {
    dir.is_dir()
        && std::fs::read_dir(dir)
            .ok()
            .map(|mut entries| entries.any(|entry| entry.is_ok()))
            .unwrap_or(false)
}

// True when a single dataset reference resolves to a materialized bundle on
// disk: either an explicit path (absolute or separator-bearing) that exists, or
// a slug naming a non-empty datasets/<cycle_id>/<slug> bundle dir. A final
// substring pass tolerates scheme/namespace prefixes (e.g. "local:xarm7:<slug>")
// by matching the slug against existing non-empty bundle dir names.
pub(crate) fn dataset_reference_materialized(
    datasets_root: &std::path::Path,
    candidate: &str,
) -> bool {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return false;
    }
    let as_path = std::path::Path::new(trimmed);
    if (as_path.is_absolute() || trimmed.contains('/')) && as_path.exists() {
        return true;
    }
    let slug = trimmed.to_ascii_lowercase();
    if dataset_dir_non_empty(&datasets_root.join(&slug)) {
        return true;
    }
    // MEASURED ON cycle-a-20260919, 2026-10-30: the harness writes the
    // data it generates under datasets/<cycle>/simulations/<slug>, and only
    // fetched bundles sit directly under datasets/<cycle>/. A lead whose
    // 12 MB episodes.csv was on disk was called unobtainable, its hypothesis
    // artifact "missing", and four analysts, two authors and an illustrator
    // waited 70 minutes for a file that existed. One level down is looked at too.
    if let Ok(entries) = std::fs::read_dir(datasets_root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() && dataset_dir_non_empty(&entry.path().join(&slug)) {
                return true;
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(datasets_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.len() >= 6
                && (slug.contains(&name) || name.contains(&slug))
                && dataset_dir_non_empty(&entry.path())
            {
                return true;
            }
        }
    }
    false
}

// True when the active lead's declared dataset is materialized on disk. Reads
// the lab-director hypothesis and inspects the usual dataset-reference keys on
// both the top-level record and its `selected_hypothesis`. Used to suppress the
// scout-materialization fail-closed pivot for leads backed by a locally
// generated / simulation bundle that no scout fetched.
pub(crate) fn active_lead_dataset_materialized_on_disk(paths: &AppPaths, cycle_id: &str) -> bool {
    let hyp_path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let Ok(hyp) = read_json(&hyp_path) else {
        return false;
    };
    let datasets_root = paths.runtime_root.join("datasets").join(cycle_id);
    const DATASET_KEYS: [&str; 6] = [
        "dataset_or_accession",
        "selected_dataset",
        "accession",
        "dataset_accession",
        "materialized_dataset",
        "dataset_root",
    ];
    let mut candidates: Vec<String> = Vec::new();
    for source in [hyp.get("selected_hypothesis"), Some(&hyp)] {
        let Some(obj) = source else {
            continue;
        };
        for key in DATASET_KEYS {
            if let Some(text) = obj.get(key).and_then(Value::as_str) {
                candidates.push(text.to_string());
            }
        }
    }
    candidates
        .iter()
        .any(|candidate| {
            dataset_reference_materialized(&datasets_root, candidate)
                || (candidate.contains('/') && paths.project_root.join(candidate).exists())
        })
}

// FIX-AD: detect the active lead being validated on a MISMATCHED dataset via
// `dataset_bundle_source == "override"`. When the lead's declared dataset never
// materializes (its accession is absent from the fetched data bundles) yet
// completed runners keep validating the lead's-accession hypothesis on a
// different dataset's root, the lead can never reach robust cross-source
// validation — the override silently substitutes a non-lead dataset and the
// degraded result masks the dead end. Returns Some(summary) once >= threshold
// such runner lanes exist. Pure data-availability signal; touches no gate.
pub(crate) fn active_lead_dataset_override_mismatch(
    paths: &AppPaths,
    cycle_id: &str,
    threshold: usize,
) -> Option<Value> {
    // MEASURED ON cycle-a-20260919, 2026-10-10: a verified local
    // 34,560-row simulation bundle was still called CONFIRMED_UNOBTAINABLE by
    // nineteen older override-runner records, so the extant hypothesis artifact
    // was unusable and every analyst waited forever for it to exist.
    if active_lead_dataset_materialized_on_disk(paths, cycle_id) {
        return None;
    }
    let hyp_path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let hyp = read_json(&hyp_path).ok()?;
    let lead = hyp
        .get("selected_hypothesis")
        .cloned()
        .unwrap_or_else(|| hyp.clone());
    let accession_raw = lead
        .get("dataset_or_accession")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let accession_token = failclosed_accession_token(&accession_raw);
    if accession_token.is_empty() {
        return None;
    }
    // If a fetched bundle already materialized the lead's accession, the lead is
    // not data-blocked — bail out (no fail-closed).
    for bundle in cycle_fetched_data_bundles(paths, cycle_id) {
        let path = bundle
            .get("bundle_path")
            .and_then(Value::as_str)
            .unwrap_or("");
        let doi = bundle
            .get("candidate_doi")
            .and_then(Value::as_str)
            .unwrap_or("");
        let url = bundle
            .get("candidate_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let haystack = format!("{path} {doi} {url}").to_lowercase();
        if haystack.contains(&accession_token) {
            return None;
        }
    }
    let lanes_root = cycle_lanes_root(paths, cycle_id);
    let mut mismatch_lanes: Vec<(u128, String)> = Vec::new();
    if let Ok(entries) = read_dir(&lanes_root) {
        for entry in entries.flatten() {
            let lane_id = entry.file_name().to_string_lossy().to_string();
            if !lane_id.starts_with("followup-runner-") {
                continue;
            }
            let result_path = entry.path().join("result.json");
            if !result_path.is_file() {
                continue;
            }
            let Ok(result) = lane_result_fields(
                &result_path,
                &["dataset_bundle_source", "dataset_root", "selected_hypotheses"],
            ) else {
                continue;
            };
            if result.get("dataset_bundle_source").and_then(Value::as_str) != Some("override") {
                continue;
            }
            let root = result
                .get("dataset_root")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if root.contains(&accession_token) {
                // Override happens to point at the lead's own dataset — fine.
                continue;
            }
            let runner_targets_lead = result
                .get("selected_hypotheses")
                .and_then(Value::as_array)
                .map(|items| {
                    items.iter().any(|item| {
                        item.get("hypothesis_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)
                            .map(|id| id.to_lowercase().contains(&accession_token))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if !runner_targets_lead {
                continue;
            }
            let modified_ms = fs::metadata(&result_path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|mtime| mtime.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            mismatch_lanes.push((modified_ms, lane_id));
        }
    }
    if mismatch_lanes.len() < threshold.max(1) {
        return None;
    }
    mismatch_lanes.sort_by(|a, b| b.0.cmp(&a.0));
    let lane_ids: Vec<Value> = mismatch_lanes
        .iter()
        .take(12)
        .map(|(_, id)| json!(id))
        .collect();
    Some(json!({
        "reason": "active_lead_dataset_override_mismatch",
        "lead_accession": accession_raw,
        "mismatch_runner_lane_count": mismatch_lanes.len(),
        "lane_ids": lane_ids,
    }))
}

/// FIX-BH (fail-closed blind-spot): a lead can sit UNMATERIALIZED indefinitely if no runner ever
/// attempts to fetch it — `active_lead_dataset_override_mismatch` only fires on a try-and-fail
/// (runners validating on an override substitute), so a NEVER-ATTEMPTED unmaterialized lead is never
/// disqualified while materialized alternatives go unused (observed in v15: lead GSE294669 unmaterialized
/// for many rounds while gse106898/228779/318067/322943 sat fetched). Disqualify a lead whose dataset
/// has NO fetched bundle once the cycle has run >= `rounds_threshold` lab-director decision rounds AND
/// at least one OTHER dataset is materialized (so the director has a concrete materialized alternative).
/// Data-availability constraint only — the director still chooses WHICH materialized dataset.
pub(crate) fn lead_unmaterialized_persisted(
    paths: &AppPaths,
    cycle_id: &str,
    rounds_threshold: usize,
) -> Option<String> {
    if active_lead_dataset_materialized_on_disk(paths, cycle_id) {
        return None;
    }
    let hyp_path = state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let hyp = read_json(&hyp_path).ok()?;
    let lead = hyp
        .get("selected_hypothesis")
        .cloned()
        .unwrap_or_else(|| hyp.clone());
    let accession_raw = lead
        .get("dataset_or_accession")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let accession_token = failclosed_accession_token(&accession_raw);
    if accession_token.is_empty() {
        return None;
    }
    let fetched = cycle_fetched_data_bundles(paths, cycle_id);
    if fetched.is_empty() {
        return None; // nothing materialized yet -> early cycle, do not fire
    }
    let lead_materialized = fetched.iter().any(|bundle| {
        let path = bundle
            .get("bundle_path")
            .and_then(Value::as_str)
            .unwrap_or("");
        let doi = bundle
            .get("candidate_doi")
            .and_then(Value::as_str)
            .unwrap_or("");
        let url = bundle
            .get("candidate_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        format!("{path} {doi} {url}")
            .to_lowercase()
            .contains(&accession_token)
    });
    if lead_materialized {
        return None; // lead's own dataset is materialized -> not data-blocked
    }
    let mut director_rounds = 0usize;
    if let Ok(entries) = read_dir(cycle_lanes_root(paths, cycle_id)) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("followup-lab-director-")
            {
                director_rounds += 1;
            }
        }
    }
    if director_rounds < rounds_threshold.max(1) {
        return None; // not persisted long enough -> give materialization a chance
    }
    Some(accession_raw)
}

/// FIX-AG: the forbidden-dataset term set, augmented with any lead accession
/// the FIX-AD data-availability signal has confirmed UNOBTAINABLE. The static
/// set (`forbidden_dataset_terms_from_text`) only recognises GEO-style
/// accessions embedded in the objective text; a Zenodo/DOI lead pinned to an
/// unobtainable dataset is invisible to it. Prompt- and digest-level signals
/// (FIX-AD/AE) and the is_usable rejection (FIX-AF) did not stop the
/// lab-director from upholding the dead lead, so we promote the confirmed
/// unobtainable accession to a hard forbidden term. The existing machinery then
/// rejects any decision/override/hypothesis bound to it at the stage gates,
/// excludes it from the role-plan candidate set, and reports it to the director
/// as a NON-OVERRIDABLE forbidden accession. Selection among the remaining
/// already-materialized candidates stays entirely with the lab-director; the
/// harness only disqualifies the unobtainable dataset. Never touches the gate
/// threshold or verdict.
pub(crate) fn effective_forbidden_dataset_terms(
    paths: &AppPaths,
    cycle_id: &str,
    objective: &str,
) -> Vec<String> {
    let mut terms = forbidden_dataset_terms_from_text(objective);
    let override_threshold = std::env::var("RESEARCHLAB_LEAD_OVERRIDE_MISMATCH_THRESHOLD")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(2);
    if let Some(signal) = active_lead_dataset_override_mismatch(paths, cycle_id, override_threshold)
    {
        if let Some(accession) = signal.get("lead_accession").and_then(Value::as_str) {
            let token = failclosed_accession_token(accession).to_lowercase();
            if token.len() >= 4 && !terms.contains(&token) {
                terms.push(token);
            }
        }
    }
    // FIX-BH: also forbid a lead that has stayed UNMATERIALIZED for too many decision rounds while
    // materialized alternatives exist (the never-attempted-fetch blind spot).
    let unmaterialized_rounds = std::env::var("RESEARCHLAB_LEAD_UNMATERIALIZED_ROUNDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(12);
    if let Some(accession) = lead_unmaterialized_persisted(paths, cycle_id, unmaterialized_rounds) {
        let token = failclosed_accession_token(&accession).to_lowercase();
        if token.len() >= 4 && !terms.contains(&token) {
            terms.push(token);
        }
    }
    terms
}
