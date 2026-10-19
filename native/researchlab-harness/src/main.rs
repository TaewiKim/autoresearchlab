use anyhow::Result;
use clap::Parser;
use serde_json::json;

mod chronicle;
mod core;
mod labdirector;
mod runtime;

use crate::chronicle::{
    aggregate_cycle, build_all_projections, build_brief_for_lane, build_research_report,
    decide_from_brief,
};
use crate::core::cli::{Cli, Commands};
use crate::core::support::{app_paths, ensure_runtime_dirs, print_json, slugify};
use crate::labdirector::{
    materialize_long_run_plan, materialize_long_run_plan_with_objective, run_plan,
};
use crate::runtime::{
    abort_lane, auth_status, create_prompt_seed_contract, import_codex_auth, lane_status,
    make_demo_contract, run_lane,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("[researchlab-harness] {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let paths = app_paths()?;
    ensure_runtime_dirs(&paths)?;

    match cli.command {
        Commands::DemoLane { cycle_id, lane_id } => {
            let contract_path = make_demo_contract(
                &paths,
                &cycle_id,
                &lane_id,
                "external-driver",
                "lab-runner",
                "driver-exec",
            )?;
            let result = run_lane(&paths, &contract_path)?;
            let brief = build_brief_for_lane(&paths, &cycle_id, &lane_id)?;
            print_json(&json!({
                "contract": contract_path,
                "result": result.result_path,
                "brief": brief
            }))?;
        }
        Commands::RunLane { contract } => {
            let result = run_lane(&paths, &contract)?;
            print_json(&json!({
                "lane_id": result.lane_id,
                "status": result.status,
                "result_path": result.result_path
            }))?;
        }
        Commands::BuildBrief { cycle_id, lane_id } => {
            let brief = build_brief_for_lane(&paths, &cycle_id, &lane_id)?;
            print_json(&serde_json::to_value(brief)?)?;
        }
        Commands::AggregateCycle { cycle_id } => {
            let output = aggregate_cycle(&paths, &cycle_id)?;
            print_json(&json!({ "cycle_state": output }))?;
        }
        Commands::BuildViz { cycle_id } => {
            let outputs = build_all_projections(&paths, &cycle_id)?;
            print_json(&json!({ "outputs": outputs }))?;
        }
        Commands::BuildReport { cycle_id } => {
            let output = build_research_report(&paths, &cycle_id)?;
            print_json(&json!({ "report_path": output }))?;
        }
        Commands::LaneStatus { cycle_id, lane_id } => {
            let status = lane_status(&paths, &cycle_id, &lane_id)?;
            print_json(&status)?;
        }
        Commands::AbortLane { cycle_id, lane_id } => {
            let status = abort_lane(&paths, &cycle_id, &lane_id)?;
            print_json(&status)?;
        }
        Commands::Decide { brief_id } => {
            let decision = decide_from_brief(&paths, &brief_id)?;
            print_json(&serde_json::to_value(decision)?)?;
        }
        Commands::DemoFlow { cycle_id, lane_id } => {
            let contract_path = make_demo_contract(
                &paths,
                &cycle_id,
                &lane_id,
                "external-driver",
                "lab-runner",
                "driver-exec",
            )?;
            let result = run_lane(&paths, &contract_path)?;
            let brief = build_brief_for_lane(&paths, &cycle_id, &lane_id)?;
            let cycle_state = aggregate_cycle(&paths, &cycle_id)?;
            let viz_outputs = build_all_projections(&paths, &cycle_id)?;
            let decision = decide_from_brief(&paths, &brief.brief_id)?;
            print_json(&json!({
                "contract": contract_path,
                "result": result.result_path,
                "brief": brief,
                "cycle_state": cycle_state,
                "viz_outputs": viz_outputs,
                "decision": decision
            }))?;
        }
        Commands::PrintLongRunBlueprint { write } => {
            let blueprint = crate::labdirector::policy::build_long_run_blueprint();
            if write {
                let output = paths
                    .project_root
                    .join("examples")
                    .join("generated_long_run_blueprint.json");
                crate::core::support::write_json(&output, &blueprint)?;
                print_json(&json!({ "path": output, "blueprint": blueprint }))?;
            } else {
                print_json(&blueprint)?;
            }
        }
        Commands::MaterializeLongRunPlan {
            cycle_id,
            agent_plan,
        } => {
            let payload = materialize_long_run_plan(&paths, &cycle_id, agent_plan.as_deref())?;
            print_json(&payload)?;
        }
        Commands::RunPlan {
            cycle_id,
            max_passes,
            sleep_seconds,
            max_concurrency,
            stale_seconds,
        } => {
            let payload = run_plan(
                &paths,
                &cycle_id,
                max_passes,
                sleep_seconds,
                max_concurrency,
                stale_seconds,
            )?;
            print_json(&payload)?;
        }
        Commands::RunResearch {
            prompt,
            cycle_id,
            max_passes,
            sleep_seconds,
            max_concurrency,
            stale_seconds,
        } => {
            let cycle_id = cycle_id.unwrap_or_else(|| {
                format!(
                    "cycle-{}",
                    slugify(&prompt).chars().take(24).collect::<String>()
                )
            });
            materialize_long_run_plan_with_objective(&paths, &cycle_id, Some(&prompt), None)?;
            let seed_contract = create_prompt_seed_contract(&paths, &cycle_id, &prompt)?;
            let seed_final_status =
                crate::core::support::lane_root(&paths, &cycle_id, "prompt-seed-01")
                    .join("final-status.json");
            if !seed_final_status.exists() {
                let seed_result = run_lane(&paths, &seed_contract)?;
                if seed_result.status == "completed" {
                    let _ = build_brief_for_lane(&paths, &cycle_id, "prompt-seed-01")?;
                }
            }
            let payload = run_plan(
                &paths,
                &cycle_id,
                max_passes,
                sleep_seconds,
                max_concurrency,
                stale_seconds,
            )?;
            print_json(&json!({
                "cycle_id": cycle_id,
                "prompt": prompt,
                "result": payload,
            }))?;
        }
        Commands::ImportCodexAuth => {
            let auth_path = import_codex_auth(&paths)?;
            print_json(&json!({ "auth_path": auth_path }))?;
        }
        Commands::AuthStatus => {
            let status = auth_status(&paths)?;
            print_json(&serde_json::to_value(status)?)?;
        }
        Commands::DemoCodexLane { cycle_id, lane_id } => {
            let payload = materialize_long_run_plan(&paths, &cycle_id, None)?;
            let contract_path = crate::core::support::lane_root(&paths, &cycle_id, &lane_id)
                .join("lane-contract.json");
            let result = run_lane(&paths, &contract_path)?;
            print_json(&json!({
                "cycle_plan": payload["cycle_plan_path"],
                "contract": contract_path,
                "status": result.status,
                "result": result.result_path
            }))?;
        }
    }

    Ok(())
}
