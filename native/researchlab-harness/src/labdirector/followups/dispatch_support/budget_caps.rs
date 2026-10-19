#![allow(unused_imports)]
use super::*;

pub(crate) fn followup_task_signature(task_body: &str) -> String {
    slugify(&normalize_followup_attempt_markers(task_body))
}

pub(crate) fn dispatch_cycle_objective(paths: &AppPaths, cycle_id: &str) -> Result<String> {
    let cycle_plan_path = plans_root(paths).join(format!("{cycle_id}-cycle-plan.json"));
    if cycle_plan_path.exists() {
        Ok(read_json(&cycle_plan_path)?
            .get("objective")
            .and_then(Value::as_str)
            .unwrap_or("Continue the active research cycle.")
            .to_string())
    } else {
        Ok("Continue the active research cycle.".to_string())
    }
}

pub(crate) fn stage_gate_recovery_required_for_plan(plan: &Value) -> bool {
    plan.get("stage_gate_state")
        .and_then(|item| item.get("gates"))
        .and_then(Value::as_array)
        .map(|gates| {
            gates
                .iter()
                .any(|gate| gate.get("passed").and_then(Value::as_bool) != Some(true))
        })
        .unwrap_or(false)
}

pub(crate) fn stage_gate_blocks_pivot_for_plan(plan: &Value) -> bool {
    plan.get("stage_gate_state")
        .and_then(|item| item.get("gates"))
        .and_then(Value::as_array)
        .map(|gates| {
            let explicit_hypothesis_gate_failed = gates.iter().any(|gate| {
                gate.get("stage").and_then(Value::as_str) == Some("hypothesis_generation")
                    && gate.get("passed").and_then(Value::as_bool) != Some(true)
                    && gate
                        .get("explicit_hypothesis_gate_failed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            });
            let first_failed_blocks_pivot = gates
                .iter()
                .find(|gate| gate.get("passed").and_then(Value::as_bool) != Some(true))
                .map(|gate| {
                    gate.get("stage").and_then(Value::as_str)
                        == Some("validation_materialization_analysis")
                })
                .unwrap_or(false);
            explicit_hypothesis_gate_failed || first_failed_blocks_pivot
        })
        .unwrap_or(false)
}

/// The cycle's one follow-up budget, shared by every role.
///
/// Until 2026-10-03 each role had its own lifetime cap (lab-director 64,
/// chronicle 32, engineer 48, ...) times an "exempt" multiplier, plus a hard
/// analyst limit, plus a global fuse. On cycle-a-20260919, a nine-day
/// cycle, those role caps were the cause of one stall after another: the
/// engineer at 240 of 240 could not run the director's new order, the director
/// at 321 of 320 could not answer a blocker, and the chronicle at 167 of 160
/// could not produce the comparison the director was waiting on -- each fixed
/// by exempting one more action. A lifetime count per role measures how long a
/// cycle has run, not whether one role is running away. The owner's call: one
/// budget for the cycle.
///
/// Runaway within a role is held by what measures it -- one lane per pass per
/// role (pass_followup_budget_by_role), one open lane per action, and the bounds
/// some actions carry themselves (a simulation order's attempts, one recovery
/// per blocker) -- not by a lifetime count. RESEARCHLAB_FOLLOWUP_BUDGET sets the
/// budget; 4096 was the global fuse before, and stays the default.
pub(crate) fn total_followup_cap() -> usize {
    std::env::var("RESEARCHLAB_FOLLOWUP_BUDGET")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(4096)
}

/// A spent budget is the owner's decision to make, so it is said once, where
/// the owner reads what the harness did -- not left as a cycle that idles.
///
/// MEASURED ON cycle-a-20260919, 2026-10-15: the cycle reached 4,158
/// follow-up lanes against the 4,096 budget. From 09:38 every run-plan pass
/// created nothing and launched nothing, the supervisor read it as decision
/// latency and spawned director lanes, and four directors in a row asked for
/// one runner that no pass could create. Nothing anywhere said the budget was
/// the reason; it took a reading of the dispatch code to find it.
pub(crate) fn notice_followup_budget_spent(paths: &AppPaths, cycle_id: &str, followups: usize, budget: usize) {
    let notices = crate::core::support::harness_notices_path(paths, cycle_id);
    let marker = format!("\"budget\":{budget}");
    let already = fs::read_to_string(&notices)
        .map(|text| {
            text.lines()
                .any(|line| line.contains("\"followup_budget_spent\"") && line.contains(&marker))
        })
        .unwrap_or(false);
    if already {
        return;
    }
    let _ = crate::chronicle::reporting::append_event(
        &notices,
        "followup_budget_spent",
        json!({
            "budget": budget,
            "followups": followups,
            "setting": "RESEARCHLAB_FOLLOWUP_BUDGET",
            "effect": "no follow-up lane of any role is created until the budget is raised",
        }),
    );
}

/// How many times one cycle may put the analysts' proposals to the LabDirector.
/// Each is a distinct set of proposals, so this is a count of new questions, not
/// of retries; 24 is far more than a cycle produces and still finite.
pub(crate) fn analysis_proposal_decision_cap() -> usize {
    std::env::var("RESEARCHLAB_ANALYSIS_PROPOSAL_DECISION_CAP")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(24)
}

pub(crate) fn pass_followup_budget_by_role() -> HashMap<&'static str, usize> {
    HashMap::from([
        // Repository-native workflow gate blockers often need Analyst repair
        // before another runner attempt. Limit runner fan-out per pass so one
        // slow or repeated execution cannot dominate the whole recovery loop.
        ("lab-runner", 1usize),
        ("analyst", 3usize),
        ("scout", 3usize),
        ("chronicle", 1usize),
        ("gatekeeper", 8usize),
        ("lab-director", 2usize),
        ("author", 1usize),
        ("illustrator", 1usize),
        // Provisioning is serial by nature: two lanes installing into the same
        // runtime race each other, and the second one's failure is the first
        // one's half-finished state.
        ("engineer", 1usize),
    ])
}

pub(crate) fn next_dispatch_action_attempt(
    role: &str,
    action_type: &str,
    existing_action_counts: &HashMap<String, usize>,
    created_by_action: &HashMap<String, usize>,
) -> usize {
    let key = format!("{role}::{action_type}");
    existing_action_counts.get(&key).copied().unwrap_or(0)
        + created_by_action.get(&key).copied().unwrap_or(0)
        + 1
}
