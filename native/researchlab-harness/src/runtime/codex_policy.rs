use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::env;
use std::path::Path;

use crate::core::model::{AuthState, LaneContract};

pub(crate) const SCHOLARLY_NETWORK_PROFILE: &str = "researchlab_scholarly";
pub(crate) const SCHOLARLY_NETWORK_DOMAINS: &[&str] = &[
    "api.openalex.org",
    "api.crossref.org",
    "api.semanticscholar.org",
    "api.opencitations.net",
    "export.arxiv.org",
    "arxiv.org",
    // Deep reading (drivers/literature/search_lib/fulltext.py): ar5iv renders
    // the full text of papers arXiv has no HTML for. Paper IDs only.
    "ar5iv.labs.arxiv.org",
    // Open-source asset METADATA of a paper (search_lib/assets.py): repository
    // license/stars/head/README and Hub checkpoint/dataset records. No clone,
    // no file download; the Python validator admits only those endpoints.
    "api.github.com",
    "huggingface.co",
];

/// The profile a lane that provisions an environment runs with: the scholarly
/// hosts plus the package registries, code hosts and model stores below.
///
/// Owner decision, 2026-09-19: the agents that build the experiments must be
/// able to install open-source libraries (Python, Java, Rust, JavaScript) and
/// the physical-AI platforms of NVIDIA, Meta and Google. Open-source leverage
/// is the owner's top priority. Under the scholarly profile every pip/npm/cargo
/// install, git clone and model download of an engineer lane failed.
pub(crate) const OPEN_SOURCE_ASSET_NETWORK_PROFILE: &str = "researchlab_open_source_assets";
/// Exact hosts, plus scoped wildcards where a CDN hands out per-region or
/// per-object host names. Codex's network proxy accepts `*.example.com`
/// (subdomains only) and `**.example.com` (apex and subdomains) and refuses a
/// global `*`. A host is admitted only as spelled here: `*.hf.co` is approved
/// as that literal, so no environment value can widen it to `*.co`.
///
/// MEASURED ON this host, 2026-09-19, codex-cli 0.153.4 `codex exec` with this
/// profile: pypi.org, registry.npmjs.org, index.crates.io, repo1.maven.org,
/// huggingface.co, raw.githubusercontent.com and a codeload.github.com tarball
/// returned 200; `pip download` saved a wheel; `*.hf.co` admitted
/// cas-bridge.xethub.hf.co, two labels deep; example.com and www.google.com
/// were refused by the allowlist.
pub(crate) const OPEN_SOURCE_ASSET_DOMAINS: &[&str] = &[
    // Python
    "pypi.org",
    "files.pythonhosted.org",
    "download.pytorch.org",
    "pypi.nvidia.com",
    "pypi.ngc.nvidia.com",
    "conda.anaconda.org",
    "repo.anaconda.com",
    // JavaScript
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    // Rust
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "static.rust-lang.org",
    // Java
    "repo.maven.apache.org",
    "repo1.maven.org",
    "services.gradle.org",
    "plugins.gradle.org",
    // plugins.gradle.org redirects plugin artifacts here.
    "plugins-artifacts.gradle.org",
    "downloads.gradle.org",
    // Code. api.github.com is also a scholarly host (repository metadata).
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
    // Git LFS objects of a cloned repository.
    "media.githubusercontent.com",
    "gitlab.com",
    // Models and datasets. The Hub answers on huggingface.co and redirects file
    // bodies to its CDNs: cdn-lfs-us-1.hf.co / cdn-lfs-eu-1.hf.co for LFS, and
    // cas-bridge / cas-server / transfer under xethub.hf.co for Xet storage,
    // which hf_hub uses for most repositories now. cdn-lfs.huggingface.co is
    // the older LFS host; it no longer resolved on 2026-09-19 and is kept for
    // clients that still name it.
    "huggingface.co",
    "cdn-lfs.huggingface.co",
    "*.hf.co",
    // NVIDIA: Isaac Sim/Lab and Omniverse assets, NGC models (GR00T, Cosmos),
    // CUDA redistributables. Warp and Newton install from pypi.
    "developer.download.nvidia.com",
    "api.ngc.nvidia.com",
    "ngc.nvidia.com",
    // NGC file bodies are served from these after api.ngc.nvidia.com.
    "files.ngc.nvidia.com",
    "xfiles.ngc.nvidia.com",
    "omniverse-content-production.s3-us-west-2.amazonaws.com",
    "omniverse-content-production.s3.us-west-2.amazonaws.com",
    "nvcr.io",
    // Meta model and dataset downloads.
    "dl.fbaipublicfiles.com",
    // Google / DeepMind: MuJoCo releases, Playground and Gemma assets
    // (Menagerie itself is on github.com).
    "storage.googleapis.com",
    "dl.google.com",
    // A published paper's own checkpoints and datasets, where the authors host
    // them themselves rather than on a hub. An asset profile that reaches every
    // package index but not the file a reproduction anchor is DEFINED by can
    // install the code and never check the number.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21: the LabDirector's
    // repaired sequence opens with the official Diffusion Policy Push-T
    // low-dimensional checkpoint, served from diffusion-policy.cs.columbia.edu,
    // which no profile host covered. robomimic's datasets are on the same host.
    "diffusion-policy.cs.columbia.edu",
    "robomimic.github.io",
    // Academic mirrors of the same kind, kept narrow: a named host per asset,
    // never a wildcard over a university domain.
    "rail.eecs.berkeley.edu",
    "rl.cs.utexas.edu",
];

/// `limited` admits only GET, HEAD and OPTIONS. The asset profile defaults to
/// `full` because git over smart HTTP POSTs to `git-upload-pack`.
///
/// MEASURED ON this host, 2026-09-19: under `limited`, `git ls-remote
/// https://github.com/google-deepmind/mujoco_menagerie` failed with "RPC
/// failed; HTTP 403" and a POST to pypi.org was refused 403 by the proxy;
/// under `full` the same ls-remote returned HEAD and pypi.org answered the
/// POST itself (405). The allowlist is enforced in both modes.
/// `RESEARCHLAB_CODEX_ASSET_NETWORK_MODE=limited` keeps an engineer to
/// read-only methods at the cost of git clones (codeload tarballs still work).
const OPEN_SOURCE_ASSET_DEFAULT_MODE: &str = "full";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodexNetworkPermissionProfile {
    pub(crate) name: &'static str,
    pub(crate) domains: Vec<String>,
    /// Codex network mode: `limited` (GET/HEAD/OPTIONS) or `full`.
    pub(crate) mode: &'static str,
}

/// The hosts in `raw`, each one of `approved`, deduplicated in order.
fn approved_domains(raw: &str, env_name: &str, approved: &[&str]) -> Result<Vec<String>> {
    let mut domains = Vec::new();
    for raw_domain in raw.split(',') {
        let domain = raw_domain.trim().to_ascii_lowercase();
        if domain.is_empty() {
            continue;
        }
        if !approved.contains(&domain.as_str()) {
            return Err(anyhow!(
                "{env_name} contains unapproved host {domain:?}; allowed hosts: {}",
                approved.join(",")
            ));
        }
        if !domains.contains(&domain) {
            domains.push(domain);
        }
    }
    Ok(domains)
}

/// Scholarly and asset hosts together, without repeats.
fn scholarly_and_asset_domains() -> Vec<&'static str> {
    let mut hosts: Vec<&'static str> = SCHOLARLY_NETWORK_DOMAINS.to_vec();
    for host in OPEN_SOURCE_ASSET_DOMAINS {
        if !hosts.contains(host) {
            hosts.push(host);
        }
    }
    hosts
}

/// Does this lane install software or fetch models? The engineer provisions
/// the tools a design declared and runs the LabDirector's simulation orders;
/// either action type widens a lane even if another role was given it.
/// Scouts, analysts, lab-runners, gatekeepers and directors never do.
pub(crate) fn lane_provisions_environment(role: &str, action_type: &str) -> bool {
    role == "engineer"
        || action_type == crate::labdirector::SIMULATION_DATA_GENERATION_ACTION
        || action_type == crate::labdirector::default_followup_action_for_role("engineer")
}

/// What a provisioning lane may reach beyond the scholarly hosts, or `None`
/// when the launcher did not opt in (the lane keeps the scholarly profile).
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpenSourceAssetNetwork {
    pub(crate) domains: Vec<String>,
    pub(crate) mode: &'static str,
}

impl OpenSourceAssetNetwork {
    /// `raw_domains` is RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS: when set it
    /// names the hosts, each approved as a scholarly or asset host. When unset,
    /// RESEARCHLAB_OPEN_SOURCE_ASSETS=1 admits every approved asset host.
    pub(crate) fn from_values(
        raw_domains: Option<&str>,
        enabled: Option<&str>,
        mode: Option<&str>,
    ) -> Result<Option<Self>> {
        let domains = match raw_domains {
            Some(raw) => {
                let domains = approved_domains(
                    raw,
                    "RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS",
                    &scholarly_and_asset_domains(),
                )?;
                if domains.is_empty() {
                    return Err(anyhow!(
                        "RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS must name at least one approved host"
                    ));
                }
                domains
            }
            None if enabled.map(str::trim) == Some("1") => OPEN_SOURCE_ASSET_DOMAINS
                .iter()
                .map(|domain| (*domain).to_string())
                .collect(),
            None => return Ok(None),
        };
        let mode = match mode.map(str::trim) {
            None | Some("") => OPEN_SOURCE_ASSET_DEFAULT_MODE,
            Some("full") => "full",
            Some("limited") => "limited",
            Some(value) => {
                return Err(anyhow!(
                    "invalid RESEARCHLAB_CODEX_ASSET_NETWORK_MODE {value:?}: expected full or limited"
                ));
            }
        };
        Ok(Some(Self { domains, mode }))
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        fn optional(name: &str) -> Result<Option<String>> {
            match env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(env::VarError::NotPresent) => Ok(None),
                Err(error) => Err(anyhow!("invalid {name}: {error}")),
            }
        }
        let raw_domains = optional("RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS")?;
        let enabled = optional("RESEARCHLAB_OPEN_SOURCE_ASSETS")?;
        let mode = optional("RESEARCHLAB_CODEX_ASSET_NETWORK_MODE")?;
        Self::from_values(raw_domains.as_deref(), enabled.as_deref(), mode.as_deref())
    }
}

impl CodexNetworkPermissionProfile {
    pub(crate) fn from_values(raw_domains: Option<&str>) -> Result<Option<Self>> {
        let Some(raw_domains) = raw_domains else {
            return Ok(None);
        };
        let domains = approved_domains(
            raw_domains,
            "RESEARCHLAB_CODEX_NETWORK_DOMAINS",
            SCHOLARLY_NETWORK_DOMAINS,
        )?;
        if domains.is_empty() {
            return Err(anyhow!(
                "RESEARCHLAB_CODEX_NETWORK_DOMAINS must name at least one approved scholarly host"
            ));
        }
        Ok(Some(Self {
            name: SCHOLARLY_NETWORK_PROFILE,
            domains,
            mode: "limited",
        }))
    }

    /// This profile widened by the asset hosts: scholarly ∪ assets, under the
    /// asset profile's name and mode. Same proxy ports and the same Windows
    /// sandbox setup as the scholarly profile: the setup marker records proxy
    /// ports and local binding, not hosts, and the allowlist is enforced by
    /// the proxy each `codex exec` starts for itself.
    pub(crate) fn with_open_source_assets(&self, assets: &OpenSourceAssetNetwork) -> Self {
        let mut domains = self.domains.clone();
        for domain in &assets.domains {
            if !domains.contains(domain) {
                domains.push(domain.clone());
            }
        }
        Self {
            name: OPEN_SOURCE_ASSET_NETWORK_PROFILE,
            domains,
            mode: assets.mode,
        }
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        match env::var("RESEARCHLAB_CODEX_NETWORK_DOMAINS") {
            Ok(value) => Self::from_values(Some(&value)),
            Err(env::VarError::NotPresent) => Ok(None),
            Err(error) => Err(anyhow!(
                "invalid RESEARCHLAB_CODEX_NETWORK_DOMAINS: {error}"
            )),
        }
    }

    pub(crate) fn forced_config_overrides(&self) -> Vec<String> {
        // Force the complete named profile as one TOML object. Dotted `-c`
        // domain keys parse host dots as nested maps, and replacing the whole
        // profile prevents a same-named user profile retaining broader access.
        let domains = self
            .domains
            .iter()
            .map(|domain| format!("\"{domain}\"=\"allow\""))
            .collect::<Vec<_>>()
            .join(",");
        vec![
            format!(
                "permissions.{}={{extends=\":workspace\",network={{enabled=true,mode=\"{}\",proxy_url=\"http://127.0.0.1:{}\",socks_url=\"http://127.0.0.1:{}\",enable_socks5=true,allow_local_binding=false,domains={{{domains}}}}}}}",
                self.name,
                self.mode,
                super::windows_sandbox_readiness::SCHOLARLY_PROXY_PORTS[0],
                super::windows_sandbox_readiness::SCHOLARLY_PROXY_PORTS[1],
            ),
            "features.network_proxy=true".to_string(),
            format!("default_permissions=\"{}\"", self.name),
        ]
    }
}

pub(crate) fn role_plan_action_type(role_plan: Option<&Value>) -> &str {
    role_plan
        .and_then(|value| value.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub(crate) fn data_scout_should_fetch(role_plan: Option<&Value>) -> bool {
    let Some(role_plan) = role_plan else {
        return false;
    };
    let metadata = role_plan.get("planner_metadata").unwrap_or(&Value::Null);
    let target_rubric = metadata
        .get("target_rubric")
        .or_else(|| role_plan.get("target_rubric"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let source_brief = role_plan
        .get("source_brief_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let discovery_mode = metadata
        .get("source_discovery_mode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let fetch_policy = metadata
        .get("fetch_policy")
        .or_else(|| role_plan.get("fetch_policy"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let initial_lane = metadata
        .get("initial_lane")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if initial_lane || discovery_mode == "initial-open-data-search" {
        return false;
    }
    if matches!(fetch_policy, "fetch" | "materialize" | "required") {
        return true;
    }
    matches!(
        target_rubric,
        "validation_materialization_gate" | "external_validity"
    ) || matches!(
        source_brief,
        "stage-gate-validation-materialization" | "external-validation"
    ) || matches!(
        discovery_mode,
        "external-validation-search" | "validation-materialization-fetch"
    )
}

pub(crate) fn supervisor_constrained_data_scout_retry(role_plan: Option<&Value>) -> bool {
    let Some(role_plan) = role_plan else {
        return false;
    };
    let metadata = role_plan.get("planner_metadata").unwrap_or(&Value::Null);
    metadata
        .get("supervisor_constrained_data_scout_retry")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn env_seconds(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub(crate) fn codex_timeout_seconds(contract: &LaneContract, role_plan: Option<&Value>) -> u64 {
    // A field landscape verifies canonical and frontier works across every
    // subfield of the objective and reviews their abstracts: not a 15-minute
    // scout search either.
    //
    // MEASURED ON cycle-b-20260919b, 2026-09-19. followup-scout-01, the
    // cycle's only landscape scout, ran out of the scout's 900 s with no
    // field-landscape.json written, and every stage after it waited.
    if role_plan_action_type(role_plan) == crate::labdirector::FIELD_LANDSCAPE_SCOUT_ACTION {
        return env_seconds("RESEARCHLAB_FIELD_LANDSCAPE_TIMEOUT_SECONDS", 3_600);
    }
    // Searching the last months of two sources for each of the top candidates.
    if role_plan_action_type(role_plan) == crate::labdirector::NOVELTY_REFUTATION_ACTION {
        return env_seconds("RESEARCHLAB_EXPERT_NOVELTY_TIMEOUT_SECONDS", 2_400);
    }
    // Reading ~10 papers in full and resolving their assets is not a 15-minute
    // scout search; it has its own budget (labdirector::sota_cards). Cards are
    // written one file per paper, so a timed-out lane keeps what it finished.
    if role_plan_action_type(role_plan) == crate::labdirector::SOTA_DEEP_READ_ACTION {
        return env::var("RESEARCHLAB_SOTA_DEEP_READ_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(3_600);
    }
    // The ordered experiment builds its scene, demonstrations and policy arms
    // and then runs every condition x seed x episode of the design. It is the
    // longest lane in the cycle, not a 15-minute engineer errand.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21. The order for
    // coverage_decay_planar_push_v1 is 3 policy arms x 2 axes x 5 distance bins
    // x 3 seeds x 40 episodes at 4000 physics steps. followup-engineer-02 got
    // the engineer default of 900 s and spent 120 of them on one pip install.
    if role_plan_action_type(role_plan) == crate::labdirector::SIMULATION_DATA_GENERATION_ACTION {
        return env_seconds("RESEARCHLAB_SIMULATION_TIMEOUT_SECONDS", 7_200);
    }
    env::var("RESEARCHLAB_CODEX_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            let action_type = role_plan_action_type(role_plan);
            let base: u64 = match contract.role.as_str() {
                // A literature scout retrieves, screens, reads full abstracts and
                // writes its journal and synthesis; 15 minutes is not enough.
                //
                // MEASURED ON cycle-a-20260919, 2026-09-19..10-07: of 86
                // reasoning_literature_scout lanes 74 were killed at exactly 900 s
                // and 2 completed; of 117 adaptive_search_followup resumes none
                // completed (23 timeouts, the rest ending with their own search
                // journal unfinished); novelty_followup lost 11 of 14 to the same
                // wall. The scout lanes that do have their own budgets finish
                // inside it: the field landscape in 26 min of 60, expert novelty
                // refutation in 13-24 min of 40. Each failed scout also opened a
                // blocking-recovery director lane.
                "scout" => env_seconds("RESEARCHLAB_SCOUT_TIMEOUT_SECONDS", 2_700),
                "analyst" => 1_800,
                "lab-runner" => 1_800,
                // Chronicle bootstraps the cycle's KG artifacts (literature_graph
                // + data_graph + trend_summary). At 1200s it was timing out
                // exactly at the artifact-write step, leaving the cycle with no
                // data-graph and deadlocked; give it the lab-director-class
                // budget so the first-pass artifacts land before the deadline
                // (retry-on-timeout still backstops via self-healing).
                "chronicle" => 2_400,
                "author" => 1_200,
                "illustrator" => 1_200,
                "gatekeeper" => 1_200,
                "lab-director" => 2_400,
                _ => 900,
            };
            if contract.role == "lab-director"
                && (action_type == "recovery_followup"
                    || action_type == "lab_director_requery_followup"
                    || action_type == "hypothesis_generation_recovery")
            {
                base.saturating_add(600)
            } else if action_type == "recovery_followup"
                || action_type == "lab_director_requery_followup"
                || action_type == "hypothesis_generation_recovery"
            {
                base.saturating_add(300)
            } else {
                base
            }
        })
}

pub(crate) fn codex_disabled_features() -> Vec<String> {
    let raw = env::var("RESEARCHLAB_CODEX_DISABLE_FEATURES")
        .unwrap_or_else(|_| "shell_snapshot".to_string());
    let mut features = Vec::new();
    for item in raw.split(',') {
        let feature = item.trim();
        if !feature.is_empty() && !features.iter().any(|existing| existing == feature) {
            features.push(feature.to_string());
        }
    }
    features
}

pub(crate) fn parse_codex_config_overrides(raw: Option<&str>) -> Vec<String> {
    let raw = raw.unwrap_or("");
    let mut overrides = Vec::new();
    for item in raw.split(',') {
        let override_value = item.trim();
        let override_key = override_value
            .split_once('=')
            .map(|(key, _)| key.trim())
            .unwrap_or(override_value);
        // Removed from current Codex config. Silently discard the legacy key
        // so an old launcher environment cannot make `--strict-config` fail
        // before the scoped permission profile is applied.
        if override_key == "ghost_snapshot.enabled" {
            continue;
        }
        if !override_value.is_empty()
            && !overrides.iter().any(|existing| existing == override_value)
        {
            overrides.push(override_value.to_string());
        }
    }
    overrides
}

pub(crate) fn codex_config_overrides() -> Vec<String> {
    let raw = env::var("RESEARCHLAB_CODEX_CONFIG_OVERRIDES").ok();
    parse_codex_config_overrides(raw.as_deref())
}

pub(crate) fn codex_fallback_payload(
    contract: &LaneContract,
    prompt_path: &Path,
    invocation_path: &Path,
    role_plan: Option<&Value>,
    auth: &AuthState,
) -> Value {
    let summary = match contract.role.as_str() {
        "author" => {
            "fallback author synthesized an approval-oriented narrative scaffold from the role plan"
        }
        "chronicle" => {
            "fallback chronicle synthesized a brief contract and highlighted pending evidence gaps"
        }
        "illustrator" => {
            "fallback illustrator synthesized researcher-facing visual guidance from the role plan"
        }
        "lab-director" => "fallback lab-director preserved the execution plan and decision scope",
        _ => "fallback codex-agent completed a structured placeholder output from the role plan",
    };
    let deliverables = role_plan
        .and_then(|value| value.get("deliverables").cloned())
        .or_else(|| role_plan.and_then(|value| value.get("outputs").cloned()))
        .unwrap_or_else(|| json!([]));
    let next_steps = role_plan
        .and_then(|value| value.get("revision_goals").cloned())
        .or_else(|| role_plan.and_then(|value| value.get("presentation_goals").cloned()))
        .or_else(|| role_plan.and_then(|value| value.get("summary_contract").cloned()))
        .unwrap_or_else(|| json!([]));

    json!({
        "status": "completed",
        "driver": "codex-agent-fallback",
        "reason": "codex command not available; synthesized fallback output from role plan",
        "lane_id": contract.lane_id,
        "role": contract.role,
        "prompt_path": prompt_path,
        "invocation_path": invocation_path,
        "role_plan": role_plan.cloned(),
        "auth_status": auth,
        "summary": summary,
        "deliverables": deliverables,
        "next_steps": next_steps,
    })
}

pub(crate) fn is_transient_codex_auth_failure(stdout: &str, stderr: &str) -> bool {
    let haystack = format!("{}\n{}", stdout, stderr).to_lowercase();
    haystack.contains("refresh_token_reused")
        || haystack.contains("provided authentication token is expired")
        || haystack.contains("your access token could not be refreshed")
        || haystack.contains("please log out and sign in again")
        || haystack.contains("failed to refresh token")
}

// Empty gatekeeper output must be failed so recovery can dispatch a retry.
pub(crate) fn is_gatekeeper_empty_output(
    role: &str,
    status: &str,
    extracted_json: Option<&Value>,
    output_last_message: &str,
) -> bool {
    if role != "gatekeeper" || status != "completed" {
        return false;
    }
    let has_verdict = extracted_json
        .and_then(|v| v.get("verdict"))
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    !has_verdict && output_last_message.trim().is_empty()
}

// The runtime's own report, with the agent's transcript removed.
//
// Every command a lane runs and every byte it reads arrives on stdout as an
// `item.*` envelope, so scanning all of stdout lets any text the agent READ
// name this lane's cause of death. cycle-g-v89 lost four hours to exactly that:
// a lane that failed with "Selected model is at capacity" listed a directory
// holding a file named `...-cleared-20260909-quota-window-...`, and that single
// word inside a filename made it quota_exceeded and halted the cycle.
//
// Runtime envelopes are kept -- `error` and `turn.failed` from the Codex CLI,
// `result` from the Claude runtime -- along with anything that is not a JSON
// line at all, because some runtimes report failures as plain text.
fn runtime_reported_text(stdout: &str) -> String {
    let mut reported = String::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if value
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|kind| kind.starts_with("item."))
                    .unwrap_or(false)
                {
                    continue;
                }
            }
        }
        reported.push_str(line);
        reported.push('\n');
    }
    reported
}

pub(crate) fn codex_failure_category(
    stdout: &str,
    stderr: &str,
    output_last_message: &str,
    timed_out: bool,
) -> Option<&'static str> {
    if timed_out {
        return Some("timeout");
    }
    let reported = runtime_reported_text(stdout);
    let combined = format!("{reported}\n{stderr}\n{output_last_message}").to_lowercase();
    if combined.contains("context_length_exceeded")
        || combined.contains("maximum context length")
        || combined.contains("input exceeds the maximum length")
        || combined.contains("exceeds the maximum length")
        || combined.contains("maximum length of 1048576")
        || combined.contains("too many tokens")
        || combined.contains("prompt is too long")
        || combined.contains("context window")
    {
        return Some("context_window_exceeded");
    }
    // The phrasings a quota failure actually uses. A bare "quota" is a word, not
    // a diagnosis: it matched an archived filename and cost this cycle four
    // hours.
    // The runtime is busy, not out of budget, and it says which remedy applies:
    // "Please try a different model." Distinguishing this from a quota failure
    // is the difference between a retry and a halted cycle.
    if combined.contains("at capacity") || combined.contains("model_overloaded") {
        return Some("model_at_capacity");
    }
    if combined.contains("insufficient_quota")
        || combined.contains("quota_exceeded")
        || combined.contains("exceeded your current quota")
        || combined.contains("usage limit")
        || combined.contains("billing_hard_limit_reached")
    {
        return Some("quota_exceeded");
    }
    if combined.contains("401 unauthorized")
        || combined.contains("403")
        || combined.contains("missing bearer or basic authentication")
        || combined.contains("codex_auth_expired")
        || combined.contains("auth refresh")
        || combined.contains("oauth authentication is currently not allowed")
        || combined.contains("permission_error")
    {
        return Some("auth_refresh_wait");
    }
    if combined.contains("rate limit")
        || combined.contains("rate_limit")
        || combined.contains("too many requests")
        || combined.contains("status code 429")
        || combined.contains("request failed with status code 429")
    {
        return Some("rate_limited");
    }
    None
}

pub(crate) fn excerpt_text(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= limit {
        return trimmed.to_string();
    }
    format!(
        "{} [truncated]",
        trimmed
            .chars()
            .take(limit.saturating_sub(12))
            .collect::<String>()
    )
}

pub(crate) fn codex_degraded_payload(
    contract: &LaneContract,
    prompt_path: &Path,
    invocation_path: &Path,
    role_plan: Option<&Value>,
    auth: &AuthState,
    failure_category: &str,
    stdout: &str,
    stderr: &str,
    output_last_message: &str,
) -> Value {
    let mut payload =
        codex_fallback_payload(contract, prompt_path, invocation_path, role_plan, auth);
    payload["degraded"] = json!(true);
    payload["failure_category"] = json!(failure_category);
    payload["status"] = json!("completed");
    payload["failure_excerpt"] = json!({
        "stdout": excerpt_text(stdout, 1200),
        "stderr": excerpt_text(stderr, 1200),
        "last_message": excerpt_text(output_last_message, 1200),
    });
    payload["reason"] = json!(match failure_category {
        "context_window_exceeded" => "codex context window exceeded; emitted degraded fallback payload from compacted role plan",
        "quota_exceeded" => "codex usage quota exceeded; emitted degraded fallback payload from role plan",
        "model_at_capacity" => "every model offered for this lane reported it was at capacity; emitted degraded fallback payload from role plan",
        "rate_limited" => "codex rate limit encountered; emitted degraded fallback payload from role plan",
        "auth_refresh_wait" => "codex authentication is missing or expired; emitted degraded fallback payload and paused retries until auth refresh",
        "timeout" => "codex execution timed out; emitted degraded fallback payload from role plan",
        _ => "codex execution failed; emitted degraded fallback payload from role plan",
    });
    payload
}
