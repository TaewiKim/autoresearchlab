#![allow(unused_imports)]
use super::*;

/// Validate and publish whatever a finished stage lane produced. Called for
/// every lane from `run_lane`, whatever its status: a stage output's validity is
/// decided by its content, and a lane that produced nothing is recorded as a
/// failed attempt so the retry cap sees it.
pub(crate) fn project_expert_selection_lane(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    let Some(action) = expert_selection_action_of(role_plan) else {
        return Ok(None);
    };
    match action {
        FIELD_BELIEFS_ACTION => project_field_beliefs(paths, contract, payload),
        CANDIDATE_SLATE_ACTION => project_candidate_slate(paths, contract, payload),
        EXPERT_PANEL_ACTION => project_panel_review(paths, contract, role_plan, payload),
        NOVELTY_REFUTATION_ACTION => project_novelty_audit(paths, contract, role_plan),
        FEASIBILITY_AUDIT_ACTION => project_feasibility(paths, contract, role_plan, payload),
        _ => Ok(None),
    }
}
