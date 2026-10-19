mod agent_command;
pub(crate) mod auth;
mod codex_lane;
mod codex_login;
mod codex_outputs;
mod codex_policy;
// Crate-visible so labdirector::tests can assert on LAB_DIRECTOR_OUTPUT_CONTRACT.
// A prompt-contract rule has no compiler behind it; a test reading the text is
// the only thing that fails when a later edit drops a clause.
pub(crate) mod codex_prompt;
mod codex_schema;
mod docker_scout;
mod engine;
mod graph_normalization;
mod gate_review_binding;
pub(crate) mod handoff_seal;
mod lab_director_projection;
mod lane_lifecycle;
mod literature_agent;
pub(crate) mod owner_directives;
mod process;
mod prompt_budget;
mod queue;
mod research_api_policy;
mod role_plan;
mod runtime_drivers;
mod windows_sandbox_readiness;

pub(crate) use auth::{auth_status, import_codex_auth};
pub(crate) use codex_policy::codex_timeout_seconds;
pub(crate) use engine::*;
pub(crate) use lane_lifecycle::{
    abort_lane, create_lane_contract, create_prompt_seed_contract, lane_status,
    launch_lane_background, make_demo_contract,
};
pub(crate) use process::{process_is_alive, runtime_class_supports_background};
pub(crate) use queue::{
    all_cycle_contract_paths, annotate_contract_queue_role_plan,
    update_sqlite_contract_queue_status,
};
