mod artifact_readiness;
mod chronicle_response;
mod context;
mod cycle_control;
mod cycle_metrics;
mod external_validation_gate;
mod field_landscape;
pub(crate) use field_landscape::*;
// The forward-citation frontier harvest: post-horizon work found from the
// landscape's canonical works, reviewed before the deep read. Named exports only.
mod frontier_harvest;
pub(crate) use frontier_harvest::{
    cycle_knowledge_horizon, dispatch_frontier_harvest, dispatch_frontier_review,
    frontier_admitted_papers,
    frontier_harvest_block_reasons, frontier_harvest_director_context, frontier_harvest_state_path,
    frontier_harvest_status, frontier_harvest_timeout_seconds, frontier_recall_clause,
    landscape_with_frontier, project_frontier_harvest, FRONTIER_HARVEST_ACTION,
    FRONTIER_HARVEST_WORKS_KEY,
};
// Full-text deep reads of the landscape's SOTA papers, published as cards for
// the problem selection below. Named exports only.
mod sota_cards;
pub(crate) use sota_cards::{
    dispatch_sota_deep_read_scout, project_sota_cards, sha256_hex, sota_deep_read_scout_protocol,
    SOTA_DEEP_READ_ACTION,
};
// Expert-grade problem selection between the SOTA cards and the lead. Named
// exports only: the module's helpers keep generic names.
mod problem_selection;
pub(crate) use problem_selection::{
    director_expert_selection_wait_reason, dispatch_expert_selection, expert_selection_action_of,
    expert_selection_director_context, expert_selection_engaged, expert_selection_output_contract,
    expert_selection_output_schema, expert_selection_prompt_clause, expert_selection_stage_lane,
    is_expert_selection_action, lead_expert_selection_rejection_reasons,
    project_expert_selection_lane, release_owner_selection_pause, NOVELTY_REFUTATION_ACTION,
    OWNER_SELECTION_BLOCK,
};
mod followup_counts;
mod followup_priority;
mod geo_scope;
mod hypothesis_frontier;
mod hypothesis_scoring;
mod inbox_activity;
mod json_window;
mod lane_counts;
mod lane_identity;
mod lane_state;
pub(crate) mod policy;
mod stage_gates;

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, read_dir};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use crate::chronicle::reporting::append_event;
use crate::chronicle::{
    aggregate_cycle, build_all_projections, build_brief_for_lane, build_paper_draft,
    build_research_report, cycle_briefs, decide_from_brief, read_jsonl,
};
use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{
    chronicle_briefs_root, cycle_lanes_root, events_root,
    labdirector_inbox_path, lane_brief_marker_path, lane_process_path, lane_result_fields,
    lane_role_plan_path, lane_root, now_iso, plans_root, read_json, read_json_cached,
    read_lane_final_status,
    read_lane_result_json, slugify, state_root, write_json,
};
use crate::labdirector::policy::{
    assigned_model_parameter, build_long_run_blueprint,
    chronicle_direct_corpus_interaction_directive, initial_analyst_role_plan,
    initial_data_scout_role_plan, initial_gatekeeper_role_plan, initial_lab_runner_role_plan,
    lab_director_research_notes_directive, task_markdown,
};
use crate::runtime::{
    abort_lane, all_cycle_contract_paths, annotate_contract_queue_role_plan, create_lane_contract,
    launch_lane_background, process_is_alive, run_lane, runtime_class_supports_background,
};
use artifact_readiness::{
    chronicle_graph_artifacts_ready, chronicle_requery_context_ready,
    lab_director_hypothesis_is_usable,
};
use chronicle_response::{build_chronicle_response, critical_questions_for_reports};
pub(crate) use context::write_chronicle_decision_digest;
use context::{
    attach_lab_director_context_controls, chronicle_direct_corpus_interaction_contract,
    chronicle_literature_relevance_contract,
    compact_chronicle_decision_digest, compact_json_context, compact_open_validation_gaps,
    completed_chronicle_gate_deliberation_exists, hypothesis_ledger_path, json_approx_bytes,
    lab_director_existing_research_notes_context, lab_director_research_notes_contract,
    latest_completed_chronicle_gate_deliberation, promote_impact_first_hypothesis_mandate,
};
pub(crate) use cycle_control::shared_pause_marker_path;
use cycle_control::{
    clear_pause_marker, clear_termination_code, collect_lane_failure_diagnostics, is_cycle_paused,
    read_termination_code, termination_code_path, write_pause_marker, write_termination_code,
};
use cycle_metrics::{
    compute_cycle_aggregate_metrics, cycle_aggregate_metrics_path,
    normalized_chronicle_report_item, write_cycle_aggregate_metrics,
};
use external_validation_gate::{
    external_validation_gate_actions, external_validation_required_for_gate,
};
use followup_counts::{
    count_completed_followup_lanes_by_role_and_action,
    count_followup_lanes_by_role, count_followup_lanes_by_role_and_action,
    count_open_followup_lanes_by_role_and_action, read_role_plan_if_compact,
    read_role_plan_index_fields, total_followup_lane_count,
};
use followup_priority::{
    followup_action_sort_key, gate_blocking_execution_recovery_action, pending_lane_action_priority,
    pending_lane_pipeline_unblock_rank,
};
use geo_scope::{
    analyst_handoff_targets_current_hypothesis, current_hypothesis_geo_accessions, scan_simple_acc,
    value_mentions_current_geo, value_targets_current_geo,
};
use hypothesis_frontier::{
    alternative_bonus, build_frontier_catalog, family_penalty_for_root,
    forbidden_dataset_terms_from_text, infer_family_root, is_nonfallback_hypothesis_candidate,
    normalized_text, dataset_discovery_contract, root_variable_convergence_penalty,
    statement_penalty, value_contains_forbidden_dataset_term,
};
use hypothesis_scoring::{
    hypothesis_data_verifiability_score, hypothesis_impact_score, hypothesis_reasoning_graph_score,
    hypothesis_selection_score, reasoning_gap_hypothesis_statements,
};
use inbox_activity::{latest_subagent_response_at, sleep_until_intervention_or_timeout};
use json_window::{json_file_window_text, json_top_level_bool_window};
use lane_counts::{
    cached_completed_lanes_for_role, completed_data_scout_count, completed_literature_scout_count,
    completed_role_counts, dependency_base_lane_id,
};
use lane_identity::{
    followup_role_for_action, lane_id_looks_like_analyst, lane_id_looks_like_lab_runner,
};
// The runtime widens the network of a lane that provisions an environment
// (runtime::codex_policy::lane_provisions_environment).
pub(crate) use lane_identity::{
    default_followup_action_for_role, ANALYSIS_PROPOSAL_DECISION_ACTION,
    RUNNER_EXECUTION_AUDIT_ACTION, SIMULATION_DATA_GENERATION_ACTION,
};
use lane_state::{
    abort_cycle_running_lanes, cached_large_cycle_lane_statuses, finalize_orphaned_running_lane,
    lane_dirs_from_contract_index, lane_has_finalized_outputs, lane_process_is_alive,
    running_lane_recently_updated,
};
use stage_gates::{
    conclusion_needs_hypothesis_strategy, document_stage_authorized,
    explicit_hypothesis_gate_failed, gate_restart_policy_from_review, hypothesis_gate_passed,
    lead_has_nothing_to_materialize, research_stage_gate_state,
    validation_materialization_gate_passed,
};

#[cfg(test)]
mod tests;

#[path = "gates/blocker_release.rs"]
mod blocker_release;
pub(crate) use blocker_release::*;
#[path = "gates/dependency_gates.rs"]
mod dependency_gates;
pub(crate) use dependency_gates::*;
#[path = "followups/external_gate_dispatch.rs"]
mod external_gate_dispatch;
pub(crate) use external_gate_dispatch::*;
#[path = "followups/role_plan.rs"]
mod role_plan;
pub(crate) use role_plan::*;
#[path = "handoffs/analyst_context.rs"]
mod analyst_context;
pub(crate) use analyst_context::*;
#[path = "handoffs/simulation_orders.rs"]
mod simulation_orders;
pub(crate) use simulation_orders::*;
#[path = "research_context/dataset_context.rs"]
mod dataset_context;
pub(crate) use dataset_context::*;
#[path = "research_context/role_plan_refresh.rs"]
mod role_plan_refresh;
pub(crate) use role_plan_refresh::*;
#[path = "recovery/supervisor_recovery.rs"]
mod supervisor_recovery;
pub(crate) use supervisor_recovery::*;
#[path = "supervision/cycle.rs"]
mod cycle;
pub(crate) use cycle::*;
#[path = "supervision/inbox.rs"]
mod inbox;
pub(crate) use inbox::*;
#[path = "recovery/requery_evidence.rs"]
mod requery_evidence;
pub(crate) use requery_evidence::*;
#[path = "plan/task_graph_collect.rs"]
mod task_graph_collect;
pub(crate) use task_graph_collect::*;
#[path = "plan/task_graph_gate_reviews.rs"]
mod task_graph_gate_reviews;
pub(crate) use task_graph_gate_reviews::*;
#[path = "plan/task_graph_blocking_recovery.rs"]
mod task_graph_blocking_recovery;
pub(crate) use task_graph_blocking_recovery::*;
#[path = "plan/task_graph_requery.rs"]
mod task_graph_requery;
pub(crate) use task_graph_requery::*;
#[path = "plan/task_graph.rs"]
mod task_graph;
pub(crate) use task_graph::*;
#[path = "followups/dispatch_support/mod.rs"]
mod dispatch_support;
pub(crate) use dispatch_support::*;
#[path = "followups/dispatch_recovery.rs"]
mod dispatch_recovery;
pub(crate) use dispatch_recovery::*;
#[path = "followups/dispatch_pivot.rs"]
mod dispatch_pivot;
pub(crate) use dispatch_pivot::*;
#[path = "followups/dispatch_hypotheses.rs"]
mod dispatch_hypotheses;
pub(crate) use dispatch_hypotheses::*;
#[path = "followups/dispatch_gate_restart.rs"]
mod dispatch_gate_restart;
pub(crate) use dispatch_gate_restart::*;
#[path = "followups/dispatch_novelty.rs"]
mod dispatch_novelty;
pub(crate) use dispatch_novelty::*;
#[path = "followups/dispatch.rs"]
mod dispatch;
pub(crate) use dispatch::*;
#[path = "plan/termination_pacing.rs"]
mod termination_pacing;
pub(crate) use termination_pacing::*;
#[path = "plan/run_loop.rs"]
mod run_loop;
pub(crate) use run_loop::*;
