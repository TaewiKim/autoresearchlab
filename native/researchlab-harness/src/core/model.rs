use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LaneContract {
    pub(crate) cycle_id: String,
    pub(crate) lane_id: String,
    pub(crate) role: String,
    pub(crate) runtime_class: String,
    pub(crate) mode: String,
    pub(crate) cwd: PathBuf,
    pub(crate) task_file: PathBuf,
    #[serde(default)]
    pub(crate) allowed_inputs: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) allowed_outputs: Vec<PathBuf>,
    pub(crate) output_artifact: Option<PathBuf>,
    pub(crate) fallback_strategy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChronicleBrief {
    pub(crate) brief_id: String,
    pub(crate) cycle_id: String,
    #[serde(default)]
    pub(crate) claim_deltas: Vec<Value>,
    #[serde(default)]
    pub(crate) lane_summaries: Vec<Value>,
    #[serde(default)]
    pub(crate) open_questions: Vec<String>,
    #[serde(default)]
    pub(crate) recommended_actions: Vec<Value>,
    #[serde(default)]
    pub(crate) hypothesis_candidates: Vec<String>,
    pub(crate) strategy_advice: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StrategyDecision {
    pub(crate) decision_id: String,
    pub(crate) cycle_id: String,
    pub(crate) mode: String,
    pub(crate) reason: String,
    pub(crate) trigger_signals: Vec<String>,
    pub(crate) approved_actions: Vec<String>,
    pub(crate) deferred_actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AuthState {
    pub(crate) source: String,
    pub(crate) imported_at: String,
    pub(crate) auth_mode: Option<String>,
    pub(crate) has_api_key: bool,
    pub(crate) has_access_token: bool,
    pub(crate) has_refresh_token: bool,
    pub(crate) account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HarnessResult {
    pub(crate) lane_id: String,
    pub(crate) status: String,
    pub(crate) result_path: PathBuf,
    pub(crate) final_status_path: PathBuf,
    pub(crate) events_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct AppPaths {
    pub(crate) project_root: PathBuf,
    pub(crate) runtime_root: PathBuf,
    pub(crate) data_root: PathBuf,
    pub(crate) stats_driver_script: PathBuf,
    pub(crate) literature_driver_script: PathBuf,
}
