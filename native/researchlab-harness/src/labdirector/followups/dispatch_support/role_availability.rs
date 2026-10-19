#![allow(unused_imports)]
use super::*;

fn latest_executable_analyst_handoff_path(paths: &AppPaths, cycle_id: &str) -> Result<Option<String>> {
    let Some(handoff_signal) = latest_analyst_handoff_signal(paths, cycle_id)? else {
        return Ok(None);
    };
    let handoff_payload = handoff_signal
        .get("payload")
        .cloned()
        .unwrap_or(Value::Null);
    if !analyst_handoff_is_executable(&handoff_payload) {
        return Ok(None);
    }
    let handoff_path = handoff_signal
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if handoff_path.is_empty() {
        return Ok(None);
    }
    Ok(Some(handoff_path))
}

/// A handoff waits for a runner until one has run it OR one is on its way.
///
/// Counting only runners that had finished is what let a handoff collect a
/// queue of them. MEASURED ON cycle-a-20260919, 2026-09-29: with one
/// worker slot a runner waits a long time before it starts, and every dispatch
/// pass in between saw the handoff as still unserved. Sixteen runners ran six
/// handoffs -- analyst-201's and analyst-203's four times each, analyst-209's
/// and analyst-213's three times each.
fn handoff_waiting_for_runner(paths: &AppPaths, cycle_id: &str, handoff_path: &str) -> Result<bool> {
    let already_run = latest_lab_runner_context_for_handoff(paths, cycle_id, handoff_path)?
        .as_ref()
        .map(|context| runner_context_is_exact_handoff(context, handoff_path))
        == Some(true);
    if already_run {
        return Ok(false);
    }
    if open_lab_runner_lane_for_handoff(paths, cycle_id, handoff_path)?.is_some() {
        return Ok(false);
    }
    // The same code on the same data under another handoff's name is the same
    // run; see runtime::handoff_seal::execution_identity.
    Ok(crate::runtime::handoff_seal::execution_served_by(paths, cycle_id, handoff_path)?.is_none())
}

pub(crate) fn latest_executable_analyst_handoff_waiting_for_runner(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<bool> {
    let Some(handoff_path) = latest_executable_analyst_handoff_path(paths, cycle_id)? else {
        return Ok(false);
    };
    handoff_waiting_for_runner(paths, cycle_id, &handoff_path)
}

/// Whether the newest executable handoff already has its runner -- run, running
/// or queued. `None` when there is no executable handoff at all, which says
/// nothing about whether a runner is wanted.
pub(crate) fn latest_executable_analyst_handoff_served(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<bool>> {
    let Some(handoff_path) = latest_executable_analyst_handoff_path(paths, cycle_id)? else {
        return Ok(None);
    };
    Ok(Some(!handoff_waiting_for_runner(paths, cycle_id, &handoff_path)?))
}

pub(crate) struct FollowupRoleAvailabilityContext<'a> {
    pub(crate) external_validation_required: bool,
    pub(crate) gate_independence_required: bool,
    pub(crate) data_acquisition_query_blocked: bool,
    pub(crate) has_pending_data_acquisition_action: bool,
    pub(crate) existing_followup_counts: &'a HashMap<String, usize>,
    pub(crate) existing_action_counts: &'a HashMap<String, usize>,
    pub(crate) open_action_counts: &'a HashMap<String, usize>,
    pub(crate) existing_total_followups: usize,
    /// The cycle's one follow-up budget (budget_caps::total_followup_cap).
    pub(crate) total_followup_cap: usize,
    pub(crate) pass_budget_by_role: &'a HashMap<&'static str, usize>,
    /// Whether the owner has authorised writing the paper. The roles that do that
    /// work were the only ones with no exemption of any kind, so on cycle-g-v89
    /// the author sat blocked at 77 lanes against a cap of 64 while the gatekeeper
    /// ran to 325 against an exempt ceiling of 402 -- in a cycle whose whole
    /// remaining purpose was the manuscript.
    pub(crate) document_stage_authorized: bool,
    /// See `latest_executable_analyst_handoff_served`. A lab-runner executes the
    /// newest executable analyst handoff and nothing else, whatever action opened
    /// it, so once that handoff has its runner another one can only repeat it.
    pub(crate) latest_handoff_served: Option<bool>,
}

pub(crate) struct DispatchPlanContext<'a> {
    pub(crate) objective: &'a str,
    /// "explore" | "focus" | "converge". Explore deliberately withholds the
    /// current lead from followup role plans, so any instruction that refers to
    /// that lead has to change with it -- see dispatch_gate_restart.
    pub(crate) convergence_mode: &'a str,
    pub(crate) candidate_hypotheses: &'a [Value],
    pub(crate) schema_quality: &'a Value,
    pub(crate) reasoning_graph: &'a Value,
    pub(crate) data_graph: &'a Value,
    pub(crate) open_validation_gaps: &'a [Value],
}

pub(crate) fn followup_role_available(
    ctx: &FollowupRoleAvailabilityContext<'_>,
    role: &str,
    action_type: &str,
    created_by_role: &HashMap<String, usize>,
    created_by_action: &HashMap<String, usize>,
) -> bool {
    // Since 2026-10-03 no role has a lifetime cap: the cycle has one follow-up
    // budget (checked below, before everything else). The exemptions that follow
    // now only guarantee a role at least one lane per pass (two for analyst
    // recovery); the measurements in them record why each was first exempted
    // from the per-role caps that are gone.
    let analyst_recovery_exempt = role == "analyst"
        && (action_type == "runner_failure_recovery_followup"
            || action_type == "pivot_followup"
            || action_type == "runner_scientific_recovery_followup"
            || action_type == "runner_result_interpretation_followup"
            || action_type == "labdirector_comparator_validation_followup"
            // MEASURED ON cycle-a-20260919, 2026-10-02: the selected
            // bundle completed while the Analyst had 275 historical lanes
            // against the plain cap of 64. Its hypothesis_followup was the only
            // action that could publish post-bundle validation, but it was
            // refused while gate reviews kept completing against old evidence.
            // Keep the existing finite exempt ceiling; classify the pipeline
            // analysis as recovery work so the experiment_data epoch can end.
            || action_type == "hypothesis_followup"
            || action_type.starts_with("hypothesis_regeneration"));
    let scout_data_acquisition_exempt =
        role == "scout" && action_type == "data_acquisition_followup";
    let scout_novelty_exempt = role == "scout" && action_type == "novelty_followup";
    let scout_hypothesis_regeneration_exempt =
        role == "scout" && action_type.starts_with("hypothesis_regeneration");
    let lab_runner_validation_exempt = role == "lab-runner" && action_type == "methods_followup";
    // A run the programme has COMMITTED to, with a manuscript waiting on the
    // number it produces. It is not ordinary analyst work and it was on no
    // exemption list, so on cycle-g-v89 the owner adopted two experiments and
    // neither could open a lane: 199 analyst lanes against a plain cap of 64.
    let adopted_experiment_exempt =
        role == "analyst" && action_type == "author_requested_experiment";
    let labdirector_pivot_requery_exempt = role == "lab-director"
        && matches!(
            action_type,
            "lab_director_requery_followup"
                | "gate_restart_followup"
                | "analyst_handoff_review_followup"
        );
    // MEASURED ON cycle-a-20260919, 2026-09-30: the completed
    // simulation blockers arrived after the plain LabDirector cap was already
    // exhausted. A recovery decision cannot wait behind the ordinary lanes
    // whose blocker it exists to resolve. It still uses the finite exempt
    // ceiling below.
    let labdirector_blocking_recovery_exempt =
        role == "lab-director" && action_type == "blocking_lane_recovery_planning";
    let chronicle_gate_deliberation_exempt =
        role == "chronicle" && action_type == "chronicle_gate_deliberation_followup";
    let chronicle_evidence_request_exempt =
        role == "chronicle" && action_type == "chronicle_evidence_request_followup";
    let external_validation_exempt = ctx.external_validation_required
        && matches!(
            action_type,
            "external_validation_followup" | "external_validation_analysis_followup"
        );
    let gatekeeper_review_exempt =
        role == "gatekeeper" && action_type == "independent_gate_review_followup";
    // The only way a simulator-sourced cycle gets data (cycle-b-20260918):
    // no scout or data-acquisition action can stand in for it, so it must not
    // wait behind the ordinary caps. Still one open lane per action (below).
    let engineer_simulation_exempt = role == "engineer"
        && (action_type == SIMULATION_DATA_GENERATION_ACTION
            // The audit of how a result was produced sits between the run and
            // everyone who would use it, so it must not queue behind the
            // ordinary engineer cap either. Still one open lane per action.
            || action_type == crate::labdirector::RUNNER_EXECUTION_AUDIT_ACTION);
    // The write-up's own headroom, and only against a valid authorisation. Same
    // shape as every exemption above: finite (cap * multiplier), never unbounded.
    let document_stage_exempt =
        ctx.document_stage_authorized && matches!(role, "author" | "illustrator");
    let gate_independence_exempt = ctx.gate_independence_required
        && matches!(
            (role, action_type),
            ("lab-director", "gate_restart_followup")
                | ("lab-director", "lab_director_requery_followup")
                | ("gatekeeper", "independent_gate_review_followup")
                | ("analyst", "methods_followup")
                | ("lab-runner", "methods_followup")
                | ("scout", "novelty_followup")
        );
    let created_now = created_by_role.get(role).copied().unwrap_or(0);
    // The one cap, before every exception below: the cycle's follow-up budget,
    // the same for every role and every action. See budget_caps::total_followup_cap.
    let total_existing =
        ctx.existing_total_followups + created_by_role.values().copied().sum::<usize>();
    if total_existing >= ctx.total_followup_cap {
        return false;
    }
    // A runner has nothing new to run once the newest handoff has one -- and a
    // runner opened earlier in this pass is bound to that same handoff.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-29: a director's
    // comparator validation, meant for an analyst, fell back to a lab-runner at
    // the analyst's per-pass limit -- twice per decision -- and chronicle,
    // gate-restart and novelty actions opened runners too. Each re-ran the
    // handoff its predecessor was already queued for: ten of sixteen runners
    // were repeats.
    if role == "lab-runner"
        && (ctx.latest_handoff_served == Some(true)
            || (ctx.latest_handoff_served == Some(false) && created_now > 0))
    {
        return false;
    }
    let action_key = format!("{role}::{action_type}");
    if role == "scout"
        && action_type == "data_acquisition_followup"
        && ctx.data_acquisition_query_blocked
    {
        return false;
    }
    let open_same_action = ctx
        .open_action_counts
        .get(&action_key)
        .copied()
        .unwrap_or(0)
        + created_by_action.get(&action_key).copied().unwrap_or(0);
    let rubric_parallel_gate_review =
        role == "gatekeeper" && action_type == "independent_gate_review_followup";
    if open_same_action > 0 && !rubric_parallel_gate_review {
        return false;
    }
    // The decision on the analysts' proposals is bounded by itself, not by the
    // director's lane count.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-28. The director's cap is
    // 64 and its exempt ceiling 64 x 3 = 192; the cycle had 198 director lanes,
    // almost all requeries of the same question. So every director action was
    // refused -- the requeries, which was the ceiling doing its job, but also
    // this one, which is the only action in the plan that could change the
    // answer. Exempting it from the plain cap was not enough: it hit the exempt
    // ceiling on the same count.
    //
    // It cannot run away the way the requeries did. One lane per distinct set of
    // outstanding proposals (collect_analysis_proposal_decision_actions), one
    // open at a time (above), and a ceiling of its own here.
    if action_type == crate::labdirector::ANALYSIS_PROPOSAL_DECISION_ACTION {
        let asked = ctx.existing_action_counts.get(&action_key).copied().unwrap_or(0)
            + created_by_action.get(&action_key).copied().unwrap_or(0);
        return asked < analysis_proposal_decision_cap();
    }
    // The same for a LabDirector simulation order: it is bounded by itself, not by
    // the engineer's lifetime count.
    //
    // MEASURED ON cycle-a-20260919, 2026-10-01. The engineer ceiling is
    // 48 x 5 = 240 and the cycle had spent exactly 240 engineer lanes, almost all
    // on the Isaac order the director has since replaced. The director's MuJoCo
    // order randomized_support_equivalence_v2 was ranked first every pass and
    // refused every pass; two analysts waited twenty hours for its data, and the
    // gate went on reviewing a lead nothing could test.
    //
    // It cannot run away: the action exists only while the order needs an
    // engineer (collect_simulation_generation_actions), which ends after
    // max_failed_simulation_attempts per issue; one is open at a time (above);
    // and provisioning stays serial, one engineer per pass.
    if action_type == SIMULATION_DATA_GENERATION_ACTION {
        return created_now == 0;
    }
    // And for the director's answer to a blocker: once per distinct set of
    // blocked lanes (recovery_already_planned_for, in both collectors), one open
    // at a time (above), one director per pass.
    //
    // MEASURED ON cycle-a-20260919, 2026-10-02. The director had 321
    // lanes against an exempt ceiling of 64 x 5 = 320, so every director action
    // was refused -- including the recovery that would put the owner's stop of
    // followup-engineer-247, and the owner's question with it, in front of the
    // director. The cycle created no lane for two hours.
    if action_type == "blocking_lane_recovery_planning" {
        return created_now == 0;
    }
    let pass_cap = if analyst_recovery_exempt {
        ctx.pass_budget_by_role
            .get(role)
            .copied()
            .unwrap_or(0)
            .max(2)
    } else if scout_data_acquisition_exempt
        || scout_novelty_exempt
        || scout_hypothesis_regeneration_exempt
        || lab_runner_validation_exempt
        || adopted_experiment_exempt
        || labdirector_pivot_requery_exempt
        || labdirector_blocking_recovery_exempt
        || chronicle_gate_deliberation_exempt
        || chronicle_evidence_request_exempt
        || external_validation_exempt
        || gatekeeper_review_exempt
        || gate_independence_exempt
        || document_stage_exempt
        || engineer_simulation_exempt
    {
        ctx.pass_budget_by_role
            .get(role)
            .copied()
            .unwrap_or(0)
            .max(1)
    } else {
        ctx.pass_budget_by_role.get(role).copied().unwrap_or(0)
    };
    // Resuming a failed literature lane must not wait for data acquisition.
    //
    // MEASURED ON cycle-b-20260917d, 2026-09-17. scout-02 stopped on
    // adaptive_literature_search_incomplete, the planner ranked its
    // adaptive_search_followup, and this check refused it because a
    // data-acquisition action was pending. That action is held until a Chronicle
    // gate deliberation completes, and Chronicle waits for a literature scout: the
    // only scout that could complete was this one. The cycle sat with zero
    // running lanes while gatekeepers re-rejected an empty hypothesis.
    let scout_literature_resume = matches!(
        action_type,
        "adaptive_search_followup" | "abstract_review_followup"
    );
    if role == "scout"
        && action_type != "data_acquisition_followup"
        && action_type != "external_validation_followup"
        && !scout_literature_resume
        && ctx.has_pending_data_acquisition_action
    {
        let existing_data = ctx
            .existing_action_counts
            .get("scout::data_acquisition_followup")
            .copied()
            .unwrap_or(0);
        let created_data = created_by_action
            .get("scout::data_acquisition_followup")
            .copied()
            .unwrap_or(0);
        if existing_data + created_data == 0 {
            return false;
        }
    }
    if role == "scout" && action_type == "data_acquisition_followup" {
        let created_data = created_by_action
            .get("scout::data_acquisition_followup")
            .copied()
            .unwrap_or(0);
        let open_data = ctx
            .open_action_counts
            .get("scout::data_acquisition_followup")
            .copied()
            .unwrap_or(0);
        if open_data + created_data > 0 {
            return false;
        }
    }
    created_now < pass_cap
}
