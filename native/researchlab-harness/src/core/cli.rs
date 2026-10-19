use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "researchlab-harness")]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Commands,
}

#[derive(Subcommand)]
pub(crate) enum Commands {
    DemoLane {
        #[arg(long, default_value = "cycle-0001")]
        cycle_id: String,
        #[arg(long, default_value = "lane-runner-01")]
        lane_id: String,
    },
    RunLane {
        contract: PathBuf,
    },
    BuildBrief {
        #[arg(long)]
        cycle_id: String,
        #[arg(long)]
        lane_id: String,
    },
    AggregateCycle {
        #[arg(long)]
        cycle_id: String,
    },
    BuildViz {
        #[arg(long, default_value = "default")]
        cycle_id: String,
    },
    BuildReport {
        #[arg(long)]
        cycle_id: String,
    },
    LaneStatus {
        #[arg(long)]
        cycle_id: String,
        #[arg(long)]
        lane_id: String,
    },
    AbortLane {
        #[arg(long)]
        cycle_id: String,
        #[arg(long)]
        lane_id: String,
    },
    Decide {
        #[arg(long)]
        brief_id: String,
    },
    DemoFlow {
        #[arg(long, default_value = "cycle-0001")]
        cycle_id: String,
        #[arg(long, default_value = "lane-runner-01")]
        lane_id: String,
    },
    PrintLongRunBlueprint {
        #[arg(long)]
        write: bool,
    },
    MaterializeLongRunPlan {
        #[arg(long, default_value = "cycle-longrun-0001")]
        cycle_id: String,
        #[arg(long)]
        agent_plan: Option<PathBuf>,
    },
    RunPlan {
        #[arg(long, default_value = "cycle-longrun-0001")]
        cycle_id: String,
        #[arg(long, default_value_t = 4)]
        max_passes: usize,
        #[arg(long, default_value_t = 0)]
        sleep_seconds: u64,
        #[arg(long, default_value_t = 4)]
        max_concurrency: usize,
        #[arg(long, default_value_t = 1800)]
        stale_seconds: u64,
    },
    RunResearch {
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        cycle_id: Option<String>,
        #[arg(long, default_value_t = 8)]
        max_passes: usize,
        #[arg(long, default_value_t = 0)]
        sleep_seconds: u64,
        #[arg(long, default_value_t = 4)]
        max_concurrency: usize,
        #[arg(long, default_value_t = 1800)]
        stale_seconds: u64,
    },
    ImportCodexAuth,
    AuthStatus,
    DemoCodexLane {
        #[arg(long, default_value = "cycle-codex-0001")]
        cycle_id: String,
        #[arg(long, default_value = "lab-director-01")]
        lane_id: String,
    },
}
