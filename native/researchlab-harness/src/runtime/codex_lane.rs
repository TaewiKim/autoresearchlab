use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use super::agent_command::{
    agent_command, agent_runtime, extract_claude_last_message, researchlab_codex_home,
    resolve_agent_runtime, AgentRuntime,
};
use super::codex_outputs::{
    analyst_handoff_payload, chronicle_required_artifacts_present, extract_codex_last_message,
    extract_first_json_object, normalize_chronicle_result_payload, synthesized_analyst_handoff,
    synthesized_author_payload, synthesized_chronicle_payload,
};
use super::codex_policy::{
    codex_config_overrides, codex_degraded_payload, codex_disabled_features,
    codex_failure_category, codex_timeout_seconds, excerpt_text, is_gatekeeper_empty_output,
    is_transient_codex_auth_failure, lane_provisions_environment, role_plan_action_type,
    CodexNetworkPermissionProfile, OpenSourceAssetNetwork, SCHOLARLY_NETWORK_DOMAINS,
};
use super::codex_prompt::{
    build_codex_context_retry_prompt, build_codex_prompt, codex_cli_supported_model,
    ABSTRACT_SCREENING_POLICY, RESEARCH_API_POLICY,
};
use super::codex_schema::codex_output_schema;
use super::docker_scout::{docker_scout_config, DockerScout};
use super::graph_normalization::normalize_graph_vocabulary;
use super::process::{terminate_process_group, write_process_metadata};
use super::research_api_policy::apply_cli_environment;
use crate::chronicle::reporting::append_event;
use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{
    lane_process_path, lane_role_plan_path, now_iso, state_root, write_json,
};
use crate::labdirector::shared_pause_marker_path;
use crate::labdirector::write_chronicle_decision_digest;
use crate::runtime::auth::auth_status;

#[derive(Debug)]
struct CodexExecutionPolicy {
    sandbox: &'static str,
    approval_policy: &'static str,
    bypass: bool,
    network_profile: Option<CodexNetworkPermissionProfile>,
}

// `codex exec --ephemeral` deliberately has no persisted thread id. The
// collaboration tools require one in order to attach child agents, so exposing
// them in an ephemeral lane can only fail ("no thread with id") after wasting a
// model turn. Keep the lane ephemeral and disable both collaboration feature
// generations explicitly. These are appended after caller-provided config so a
// user-level or environment override cannot re-enable an incompatible tool.
const EPHEMERAL_INCOMPATIBLE_FEATURES: &[&str] = &["multi_agent", "multi_agent_v2"];
const WINDOWS_SETUP_WATCHDOG_POLL: Duration = Duration::from_millis(250);
const WINDOWS_SETUP_LOG_TAIL_BYTES: usize = 16 * 1024;

struct ChildWatchOutcome {
    timed_out: bool,
    /// Killed by the idle watchdog: no event reached stdout for the idle limit
    /// while no tool call was in flight. Also reported as `timed_out`, so the
    /// existing timeout recovery retries it.
    stalled: bool,
    setup_blocked: Option<String>,
    exit_status: Option<ExitStatus>,
}

/// How long a Codex lane may emit nothing before it is treated as stalled.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18. followup-analyst-03 wrote
/// `thread.started` and `turn.started` and then nothing for thirty minutes,
/// until the role timeout killed it. Eleven analyst lanes on the same model and
/// prompt sizes (87-163KB) produced their first items within one to five
/// minutes, so fifteen minutes of silence is a stall, not deep reasoning.
/// `RESEARCHLAB_CODEX_IDLE_SECONDS=0` disables it.
fn codex_idle_limit() -> Option<Duration> {
    let seconds = std::env::var("RESEARCHLAB_CODEX_IDLE_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(900);
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

/// A tool call the agent started and has not finished. A long simulation or
/// build legitimately prints nothing until it returns, so silence then is not a
/// stall.
fn tool_call_in_flight(stdout_tail: &str) -> bool {
    stdout_tail
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('{'))
        .map(|line| line.contains("\"type\":\"item.started\""))
        .unwrap_or(false)
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let truncated = len > WINDOWS_SETUP_LOG_TAIL_BYTES as u64;
    if truncated
        && file
            .seek(SeekFrom::End(-(WINDOWS_SETUP_LOG_TAIL_BYTES as i64)))
            .is_err()
    {
        return String::new();
    }
    let mut bytes = Vec::with_capacity(WINDOWS_SETUP_LOG_TAIL_BYTES);
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    // A tail that starts mid-line has lost the line's event type, so an
    // agent message would pass the agent_message filter as bare text. Drop it.
    //
    // MEASURED ON cycle-b-20260918, 2026-09-18. followup-analyst-24's
    // final message was one 20 KB line whose prose said "tool execution" and
    // "setup ... installation ... incomplete"; the tail cut off its
    // "agent_message" prefix, the watchdog read it as a Windows setup failure,
    // and the whole cycle paused for a manual resume.
    let bytes = if truncated {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(newline) => &bytes[newline + 1..],
            None => &[][..],
        }
    } else {
        &bytes[..]
    };
    // The tail can begin inside a UTF-8 character while the child appends; a
    // lossy decode still preserves the ASCII setup-failure markers.
    String::from_utf8_lossy(bytes).into_owned()
}

fn explicit_helper_setup_failure(text: &str) -> bool {
    text.contains("orchestrator_helper_launch_canceled")
        || text.contains("orchestrator_helper_launch_incomplete")
        || text.contains("orchestrator_helper_canceled")
        || text.contains("orchestrator_helper_incomplete")
}

fn windows_setup_failure_signature(text: &str) -> bool {
    explicit_helper_setup_failure(text)
        || text.lines().any(|line| {
            (line.contains("shellexecuteexw") && (line.contains("1223") || line.contains("cancel")))
                || ((line.contains("win32") || line.contains("windows"))
                    && line.contains("error")
                    && line.contains("1223"))
                || ((line.contains("sandbox") || line.contains("setup"))
                    && (line.contains("helper") || line.contains("installation"))
                    && (line.contains("cancel") || line.contains("incomplete")))
        })
}

fn windows_setup_failure_evidence(stdout: &str, stderr: &str) -> Option<String> {
    let stderr = stderr.to_ascii_lowercase();
    if windows_setup_failure_signature(&stderr) {
        return Some(excerpt_text(&stderr, 1200));
    }
    let stdout = stdout.to_ascii_lowercase().lines()
        .filter(|line| !line.contains("agent_message"))
        .collect::<Vec<_>>().join("\n");
    let stdout_runtime_helper_failure = stdout.lines().any(|line| {
        explicit_helper_setup_failure(line)
            && !line.contains("agent_message")
            && [
                "tool",
                "function_call_output",
                "command_execution",
                "file_change",
                "error_during_execution",
                "\"type\":\"error\"",
                "\"is_error\":true",
            ]
            .iter()
            .any(|marker| line.contains(marker))
    });
    if stdout_runtime_helper_failure {
        return Some(excerpt_text(&stdout, 1200));
    }
    // Agent prose can quote an earlier setup failure. stdout is actionable only
    // in an actual tool/runtime error envelope, on the same event line as the
    // signature; stderr remains authoritative.
    let runtime_error_context = |line: &str| {
        [
            "error_during_execution",
            "tool execution",
            "tool_error",
            "runtime error",
            "execution failed",
            "\"is_error\":true",
        ]
        .iter()
        .any(|marker| line.contains(marker))
    };
    stdout
        .lines()
        .any(|line| runtime_error_context(line) && windows_setup_failure_signature(line))
        .then(|| excerpt_text(&stdout, 1200))
}

fn scoped_windows_setup_problem(
    paths: &AppPaths,
    contract: &LaneContract,
    policy: &CodexExecutionPolicy,
) -> Option<String> {
    // The live state of the sandbox, asked twice for two different questions:
    // what to refuse THIS lane for (only a lane with a scoped profile uses those
    // proxy ports), and whether an existing pause still describes anything.
    let live_for_this_lane = policy
        .network_profile
        .as_ref()
        .and_then(|_| super::windows_sandbox_readiness::scholarly_windows_setup_problem());
    let pause_path = shared_pause_marker_path(paths, &contract.cycle_id);
    let paused = fs::read(&pause_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| {
            value.get("block_type").and_then(Value::as_str) == Some("windows_sandbox_setup")
        });
    if !paused {
        return live_for_this_lane;
    }
    // A pause was a LATCH. Refusing on "a pause exists" returned that sentence as
    // the evidence for the next pause, which re-recorded it with a fresh
    // blocked_at, so one transient conflict halted the cycle for good and only a
    // human could end it.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-22. The desktop app rewrote
    // setup_marker.json at 02:33:02Z; ten seconds later the cycle paused with
    // `phase: prelaunch_readiness` whose evidence was this check's own message,
    // and every launch after it did the same. The marker's port list is not a
    // conflict this harness stops for (see marker_problem), so nothing was
    // actually wrong by then.
    //
    // It is a live condition now: it holds while the sandbox is really unusable
    // and clears itself when it is not. A setup prompt that was cancelled still
    // fails the readiness check, so a genuine block still holds.
    match super::windows_sandbox_readiness::scholarly_windows_setup_problem() {
        None => {
            let _ = fs::remove_file(&pause_path);
            let _ = fs::remove_file(
                state_root(paths).join(format!("{}-termination-code.json", contract.cycle_id)),
            );
            let _ = append_event(
                &root_event_path(paths, contract),
                "windows_sandbox_setup_pause_cleared",
                json!({
                    "lane_id": contract.lane_id,
                    "reason": "the sandbox passes readiness again; the pause described a conflict that is gone",
                }),
            );
            live_for_this_lane
        }
        // Still broken: refuse with what is WRONG, never with the fact that a
        // refusal exists.
        Some(problem) => Some(problem),
    }
}

fn record_windows_setup_block(
    paths: &AppPaths,
    contract: &LaneContract,
    phase: &str,
    evidence: &str,
) -> Result<()> {
    let pause_path = shared_pause_marker_path(paths, &contract.cycle_id);
    let reason = if phase.contains("prelaunch") {
        "Windows sandbox configuration conflict or setup failure blocked the launch; manual resume is required after resolving the setup state."
    } else {
        "Windows sandbox setup helper was canceled or incomplete; manual resume is required after resolving the setup prompt."
    };
    let pause = json!({
        "cycle_id": contract.cycle_id,
        "status": "blocked",
        "block_type": "windows_sandbox_setup",
        "manual_resume_required": true,
        "reason": reason,
        "resume_condition": "Resolve the Windows sandbox setup prompt, then explicitly resume the cycle.",
        "source": "native-codex-watchdog",
        "phase": phase,
        "evidence": evidence,
        "blocked_at": now_iso(),
    });
    write_json(&pause_path, &pause)?;
    let termination_path =
        state_root(paths).join(format!("{}-termination-code.json", contract.cycle_id));
    let termination = json!({
        "cycle_id": contract.cycle_id,
        "generated_at": now_iso(),
        "code": "RUNTIME_SETUP_BLOCKED",
        "category": "runtime_environment",
        "reason": reason,
        "source": "orchestrator-self-healing",
        "should_stop": true,
        "metadata": {
            "block_type": "windows_sandbox_setup",
            "manual_resume_required": true,
            "pause_marker_path": pause_path,
            "phase": phase,
            "lane_id": contract.lane_id,
            "evidence": evidence,
        },
    });
    write_json(&termination_path, &termination)?;
    append_event(
        &root_event_path(paths, contract),
        "windows_sandbox_setup_blocked",
        json!({"lane_id": contract.lane_id, "phase": phase, "evidence": evidence}),
    )?;
    Ok(())
}

const PROVIDER_QUOTA_BLOCK: &str = "provider_quota";

/// The reason recorded when an earlier lane found the provider out of quota.
/// While it stands, no further agent is launched for this cycle.
fn provider_quota_pause(paths: &AppPaths, contract: &LaneContract) -> Option<String> {
    let pause = fs::read(shared_pause_marker_path(paths, &contract.cycle_id))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
    if pause.get("block_type").and_then(Value::as_str) != Some(PROVIDER_QUOTA_BLOCK) {
        return None;
    }
    Some(
        pause
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("provider usage quota is exhausted")
            .to_string(),
    )
}

/// The provider's own "try again at ..." text, when it gives one.
fn provider_quota_retry_hint(text: &str) -> Option<String> {
    let marker = "try again at ";
    let start = text.find(marker)? + marker.len();
    let hint: String = text[start..]
        .chars()
        .take_while(|c| !matches!(c, '"' | '\\' | '\n' | '\r' | '}'))
        .take(80)
        .collect();
    let hint = hint.trim().trim_end_matches('.').trim().to_string();
    (!hint.is_empty()).then_some(hint)
}

fn provider_quota_blocked_lane(reason: &str) -> Value {
    json!({
        "status": "prepared",
        "block_type": PROVIDER_QUOTA_BLOCK,
        "failure_category": "quota_exceeded",
        "manual_resume_required": true,
        "retryable": true,
        "error": format!("agent launch skipped: {reason}"),
    })
}

fn record_provider_quota_block(
    paths: &AppPaths,
    contract: &LaneContract,
    evidence: &str,
) -> Result<()> {
    // The first lane to hit the limit records it; later ones must not rewrite
    // the evidence or the time it was found.
    if provider_quota_pause(paths, contract).is_some() {
        return Ok(());
    }
    let retry_hint = provider_quota_retry_hint(evidence);
    let reason = match &retry_hint {
        Some(hint) => format!(
            "Codex usage limit reached (provider says try again at {hint}); the cycle is paused and needs an explicit resume."
        ),
        None => "Codex usage limit reached; the cycle is paused and needs an explicit resume.".to_string(),
    };
    let pause_path = shared_pause_marker_path(paths, &contract.cycle_id);
    let evidence = excerpt_text(evidence, 1200);
    write_json(
        &pause_path,
        &json!({
            "cycle_id": contract.cycle_id,
            "status": "blocked",
            "block_type": PROVIDER_QUOTA_BLOCK,
            "manual_resume_required": true,
            "reason": reason,
            "resume_condition": "After the usage limit resets or the account changes, run resume-cycle or run-research for this cycle.",
            "retry_after_hint": retry_hint,
            "source": "native-codex-lane",
            "lane_id": contract.lane_id,
            "evidence": evidence,
            "blocked_at": now_iso(),
        }),
    )?;
    write_json(
        &state_root(paths).join(format!("{}-termination-code.json", contract.cycle_id)),
        &json!({
            "cycle_id": contract.cycle_id,
            "generated_at": now_iso(),
            "code": "PROVIDER_QUOTA_EXHAUSTED",
            "category": "provider_quota",
            "reason": reason,
            "source": "native-codex-lane",
            "should_stop": true,
            "metadata": {
                "block_type": PROVIDER_QUOTA_BLOCK,
                "manual_resume_required": true,
                "pause_marker_path": pause_path,
                "lane_id": contract.lane_id,
                "retry_after_hint": retry_hint,
            },
        }),
    )?;
    append_event(
        &root_event_path(paths, contract),
        "provider_quota_exhausted",
        json!({"lane_id": contract.lane_id, "retry_after_hint": retry_hint}),
    )?;
    Ok(())
}

fn root_event_path(paths: &AppPaths, contract: &LaneContract) -> PathBuf {
    paths
        .runtime_root
        .join("lanes")
        .join(&contract.cycle_id)
        .join(&contract.lane_id)
        .join("events.jsonl")
}

fn wait_for_agent_with_setup_watchdog(
    child: &mut Child,
    child_pid: u32,
    stdout_log_path: &Path,
    stderr_log_path: &Path,
    timeout: Duration,
    paths: &AppPaths,
    contract: &LaneContract,
    phase: &str,
) -> Result<ChildWatchOutcome> {
    wait_for_agent(
        child,
        child_pid,
        stdout_log_path,
        stderr_log_path,
        timeout,
        paths,
        contract,
        phase,
        true,
    )
}

/// `check_windows_setup` is false for a Docker scout: its Codex never touches
/// the Windows sandbox, so a Windows setup signature in its output is not one.
#[allow(clippy::too_many_arguments)]
fn wait_for_agent(
    child: &mut Child,
    child_pid: u32,
    stdout_log_path: &Path,
    stderr_log_path: &Path,
    timeout: Duration,
    paths: &AppPaths,
    contract: &LaneContract,
    phase: &str,
    check_windows_setup: bool,
) -> Result<ChildWatchOutcome> {
    let started = Instant::now();
    let idle_limit = codex_idle_limit();
    let mut last_stdout_len = 0u64;
    let mut last_output_at = Instant::now();
    loop {
        let stdout = read_log_tail(stdout_log_path);
        let stderr = read_log_tail(stderr_log_path);
        let stdout_len = fs::metadata(stdout_log_path).map(|meta| meta.len()).unwrap_or(0);
        if stdout_len != last_stdout_len || tool_call_in_flight(&stdout) {
            last_stdout_len = stdout_len;
            last_output_at = Instant::now();
        }
        if let Some(evidence) = check_windows_setup
            .then(|| windows_setup_failure_evidence(&stdout, &stderr))
            .flatten()
        {
            terminate_process_group(child_pid);
            let exit_status = child.wait().ok();
            record_windows_setup_block(paths, contract, phase, &evidence)?;
            return Ok(ChildWatchOutcome {
                timed_out: false,
                stalled: false,
                setup_blocked: Some(evidence),
                exit_status,
            });
        }
        if let Some(exit_status) = child.try_wait()? {
            return Ok(ChildWatchOutcome {
                timed_out: false,
                stalled: false,
                setup_blocked: None,
                exit_status: Some(exit_status),
            });
        }
        let stalled = idle_limit.is_some_and(|limit| last_output_at.elapsed() >= limit);
        if stalled || started.elapsed() >= timeout {
            terminate_process_group(child_pid);
            if stalled {
                let _ = append_event(
                    &root_event_path(paths, contract),
                    "codex_stream_stalled",
                    json!({
                        "lane_id": contract.lane_id,
                        "phase": phase,
                        "idle_seconds": last_output_at.elapsed().as_secs(),
                        "elapsed_seconds": started.elapsed().as_secs(),
                    }),
                );
            }
            return Ok(ChildWatchOutcome {
                timed_out: true,
                stalled,
                setup_blocked: None,
                exit_status: child.wait().ok(),
            });
        }
        sleep(WINDOWS_SETUP_WATCHDOG_POLL);
    }
}

fn effective_codex_disabled_features(configured: Vec<String>) -> Vec<String> {
    let mut features = configured;
    for feature in EPHEMERAL_INCOMPATIBLE_FEATURES {
        if !features.iter().any(|existing| existing == feature) {
            features.push((*feature).to_string());
        }
    }
    features
}

fn should_enforce_literature_completion(status: &str, timed_out: bool, exit_success: bool) -> bool {
    status == "completed" && !timed_out && exit_success
}

impl CodexExecutionPolicy {
    fn from_env() -> Result<Self> {
        fn optional_env(name: &str) -> Result<Option<String>> {
            match std::env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(err) => Err(anyhow!("invalid {name}: {err}")),
            }
        }
        let sandbox = optional_env("RESEARCHLAB_CODEX_SANDBOX")?;
        let approval_policy = optional_env("RESEARCHLAB_CODEX_APPROVAL_POLICY")?;
        let network_profile = CodexNetworkPermissionProfile::from_env()?;
        Self::from_values_with_network(
            sandbox.as_deref(),
            approval_policy.as_deref(),
            network_profile,
        )
    }

    fn from_values(sandbox: Option<&str>, approval_policy: Option<&str>) -> Result<Self> {
        Self::from_values_with_network(sandbox, approval_policy, None)
    }

    fn from_values_with_network(
        sandbox: Option<&str>,
        approval_policy: Option<&str>,
        network_profile: Option<CodexNetworkPermissionProfile>,
    ) -> Result<Self> {
        // Preserve the legacy default only when neither option was supplied.
        // An explicit option always opts into normal sandbox/approval handling.
        if network_profile.is_some()
            && sandbox
                .map(str::trim)
                .is_some_and(|value| value != "workspace-write")
        {
            return Err(anyhow!(
                "a scoped Codex network profile requires RESEARCHLAB_CODEX_SANDBOX=workspace-write"
            ));
        }
        if network_profile.is_some()
            && approval_policy
                .map(str::trim)
                .is_some_and(|value| value != "on-request")
        {
            return Err(anyhow!(
                "a scoped Codex network profile requires RESEARCHLAB_CODEX_APPROVAL_POLICY=on-request"
            ));
        }
        let bypass = network_profile.is_none() && sandbox.is_none() && approval_policy.is_none();
        let sandbox = match sandbox.map(str::trim) {
            None if bypass => "danger-full-access",
            None | Some("workspace-write") => "workspace-write",
            Some("read-only") => "read-only",
            Some("danger-full-access") => "danger-full-access",
            Some(value) => {
                return Err(anyhow!(
                    "invalid RESEARCHLAB_CODEX_SANDBOX {value:?}: expected read-only, workspace-write, or danger-full-access"
                ));
            }
        };
        let approval_policy = match approval_policy.map(str::trim) {
            None if bypass => "never",
            None | Some("on-request") => "on-request",
            Some("never") => "never",
            Some(value) => {
                return Err(anyhow!(
                    "invalid RESEARCHLAB_CODEX_APPROVAL_POLICY {value:?}: expected on-request or never"
                ));
            }
        };
        Ok(Self {
            sandbox,
            approval_policy,
            bypass,
            network_profile,
        })
    }

    /// A lane that installs software or fetches models (see
    /// `lane_provisions_environment`) runs with the open-source asset profile
    /// when the launcher opted in; every other lane keeps the policy as it is.
    /// Only a scoped profile is widened: without one the lane is not
    /// network-limited to begin with.
    fn for_lane(self, provisions_environment: bool, assets: Option<&OpenSourceAssetNetwork>) -> Self {
        match (provisions_environment, assets, self.network_profile.as_ref()) {
            (true, Some(assets), Some(profile)) => {
                let network_profile = Some(profile.with_open_source_assets(assets));
                Self { network_profile, ..self }
            }
            _ => self,
        }
    }

    fn network_mode(&self, runtime: AgentRuntime) -> &str {
        match self.network_profile.as_ref() {
            Some(profile) if runtime == AgentRuntime::Codex => profile.mode,
            _ => "legacy",
        }
    }

    fn sandbox_mode(&self, runtime: AgentRuntime) -> &str {
        match runtime {
            AgentRuntime::Codex => self.sandbox,
            AgentRuntime::Claude => "skip-permissions",
        }
    }

    fn permission_profile_name(&self, runtime: AgentRuntime) -> Option<&str> {
        if runtime == AgentRuntime::Codex {
            self.network_profile.as_ref().map(|profile| profile.name)
        } else {
            None
        }
    }

    fn network_domains(&self, runtime: AgentRuntime) -> &[String] {
        if runtime == AgentRuntime::Codex {
            self.network_profile
                .as_ref()
                .map(|profile| profile.domains.as_slice())
                .unwrap_or(&[])
        } else {
            &[]
        }
    }

    fn approvals_mode(&self, runtime: AgentRuntime) -> &str {
        if runtime == AgentRuntime::Claude || self.bypass {
            "bypass"
        } else {
            self.approval_policy
        }
    }
}

fn append_codex_exec_args(
    builder: &mut Command,
    assigned_model: Option<&str>,
    disabled_features: &[String],
    config_overrides: &[String],
    policy: &CodexExecutionPolicy,
    last_message_path: &Path,
    output_schema_path: Option<&Path>,
) {
    builder.arg("exec").arg("--json").arg("--ephemeral");
    if let Some(model) = assigned_model {
        builder.arg("--model").arg(model);
    }
    for feature in disabled_features {
        if !EPHEMERAL_INCOMPATIBLE_FEATURES.contains(&feature.as_str()) {
            builder.arg("--disable").arg(feature);
        }
    }
    for item in config_overrides {
        builder.arg("--config").arg(item);
    }
    for feature in EPHEMERAL_INCOMPATIBLE_FEATURES {
        builder.arg("--disable").arg(feature);
    }
    builder.arg("--skip-git-repo-check");
    if let Some(profile) = policy.network_profile.as_ref() {
        // `codex exec` selects named permissions with `default_permissions`.
        // The CLI rejects combining that selector with `--sandbox`.
        // Preserve Windows sandbox setup and managed requirements. The full
        // selected profile is replaced below, so other user profiles cannot
        // widen this launch.
        builder.arg("--strict-config");
        for item in profile.forced_config_overrides() {
            builder.arg("--config").arg(item);
        }
    } else {
        builder.arg("--sandbox").arg(policy.sandbox);
    }
    if policy.bypass {
        builder.arg("--dangerously-bypass-approvals-and-sandbox");
    } else {
        // exec has no --ask-for-approval flag; apply this after other overrides
        // so the explicit execution policy wins over any general config entry.
        builder
            .arg("--config")
            .arg(format!("approval_policy=\"{}\"", policy.approval_policy));
    }
    // These forced overrides come after general config so CLI lanes remain on
    // the subscription-backed ChatGPT login and OpenAI provider.
    builder
        .arg("--config")
        .arg("forced_login_method=\"chatgpt\"");
    builder.arg("--config").arg("model_provider=\"openai\"");
    builder.arg("--output-last-message").arg(last_message_path);
    if let Some(schema_path) = output_schema_path {
        builder.arg("--output-schema").arg(schema_path);
    }
    builder.arg("-");
}

/// Rewraps a built host Codex command as the Docker scout's `docker run` and
/// writes the prompt the container reads (`<stem>.docker.txt`, host paths
/// translated) next to the host prompt, which stays unchanged. Returns the
/// command and the prompt to feed on stdin.
fn docker_scout_launch(
    scout: &DockerScout,
    host_codex: &Command,
    setsid_path: &Path,
    prompt_path: &Path,
) -> Result<(Command, PathBuf)> {
    let prompt = fs::read_to_string(prompt_path)
        .with_context(|| format!("read {} for the Docker scout", prompt_path.display()))?;
    let docker_prompt_path = prompt_path.with_extension("docker.txt");
    fs::write(&docker_prompt_path, scout.container_prompt(&prompt))?;
    Ok((scout.command(host_codex, setsid_path), docker_prompt_path))
}

/// Which network profile the lane ran with, its mode and its hosts, written to
/// invocation.json and to every process record of the lane.
fn record_network_policy(target: &mut Value, policy: &CodexExecutionPolicy, runtime: AgentRuntime) {
    target["permission_profile"] = json!(policy.permission_profile_name(runtime));
    target["network_mode"] = json!(policy.network_mode(runtime));
    target["network_domains"] = json!(policy.network_domains(runtime));
}

fn record_execution_venue(
    target: &mut Value,
    scout: Option<&DockerScout>,
    role_plan: Option<&Value>,
) {
    target["execution_venue"] = json!(if scout.is_some() { "docker" } else { "host" });
    if let Some(scout) = scout {
        target["docker_image"] = json!(scout.image);
        target["docker_container"] = json!(scout.container_name);
    } else if super::docker_scout::order_must_run_on_the_host(role_plan) {
        // Why THIS lane is on the host while the rest of the cycle is not: the
        // only Isaac on this machine is a Windows install, and a Linux container
        // can see its files but run none of them.
        target["host_venue_reason"] = json!(
            "the ordered simulator is installed only for Windows on this host; a Linux container cannot execute it"
        );
    }
}

fn model_reported_blocked_status(extracted_json: Option<&Value>) -> bool {
    extracted_json
        .and_then(|payload| payload.get("status"))
        .and_then(Value::as_str)
        .map(|status| status.eq_ignore_ascii_case("blocked"))
        .unwrap_or(false)
}

fn preserve_failed_literature_scout(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    failure_category: &str,
    status: &mut &'static str,
    payload: &mut Value,
) -> bool {
    let is_literature_scout = contract.role == "scout"
        && !matches!(
            role_plan_action_type(role_plan),
            "data_acquisition_followup" | "reasoning_data_scout" | crate::labdirector::SOTA_DEEP_READ_ACTION
        );
    if !is_literature_scout || failure_category == "auth_refresh_wait" {
        return false;
    }

    *status = "failed";
    payload["status"] = json!("failed");
    payload["failure_category"] = json!(failure_category);
    payload["execution_failed"] = json!(true);
    true
}

#[cfg(test)]
mod execution_policy_tests {
    use super::*;
    use tempfile::TempDir;

    fn watchdog_paths(root: &Path) -> AppPaths {
        AppPaths {
            project_root: root.join("project"),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("data"),
            stats_driver_script: root.join("stats.py"),
            literature_driver_script: root.join("literature.py"),
        }
    }

    fn watchdog_contract(root: &Path) -> LaneContract {
        LaneContract {
            cycle_id: "cycle-watchdog".to_string(),
            lane_id: "scout-02".to_string(),
            role: "scout".to_string(),
            runtime_class: "codex-agent".to_string(),
            mode: "read-write-scoped".to_string(),
            cwd: root.to_path_buf(),
            task_file: root.join("task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![],
            output_artifact: None,
            fallback_strategy: None,
        }
    }

    fn policy_args(policy: &CodexExecutionPolicy) -> Vec<String> {
        let mut command = Command::new("codex");
        append_codex_exec_args(
            &mut command,
            None,
            &[],
            &[],
            policy,
            Path::new("last.txt"),
            None,
        );
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn no_policy_options_preserve_legacy_invocation() {
        let policy = CodexExecutionPolicy::from_values(None, None).unwrap();
        assert_eq!(
            policy_args(&policy),
            [
                "exec",
                "--json",
                "--ephemeral",
                "--disable",
                "multi_agent",
                "--disable",
                "multi_agent_v2",
                "--skip-git-repo-check",
                "--sandbox",
                "danger-full-access",
                "--dangerously-bypass-approvals-and-sandbox",
                "--config",
                "forced_login_method=\"chatgpt\"",
                "--config",
                "model_provider=\"openai\"",
                "--output-last-message",
                "last.txt",
                "-",
            ]
        );
        assert_eq!(
            policy.sandbox_mode(AgentRuntime::Codex),
            "danger-full-access"
        );
        assert_eq!(policy.approvals_mode(AgentRuntime::Codex), "bypass");
        assert_eq!(policy.approval_policy, "never");
    }

    #[test]
    fn explicit_policy_options_never_add_bypass() {
        for sandbox in [
            None,
            Some("read-only"),
            Some("workspace-write"),
            Some("danger-full-access"),
        ] {
            for approval in [None, Some("on-request"), Some("never")] {
                if sandbox.is_none() && approval.is_none() {
                    continue;
                }
                let policy = CodexExecutionPolicy::from_values(sandbox, approval).unwrap();
                let args = policy_args(&policy);
                assert!(!args
                    .iter()
                    .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
                assert!(args
                    .windows(2)
                    .any(|pair| pair == ["--sandbox", sandbox.unwrap_or("workspace-write")]));
                assert!(args.contains(&format!(
                    "approval_policy=\"{}\"",
                    approval.unwrap_or("on-request")
                )));
                assert_eq!(
                    policy.sandbox_mode(AgentRuntime::Codex),
                    sandbox.unwrap_or("workspace-write")
                );
                assert_eq!(
                    policy.approvals_mode(AgentRuntime::Codex),
                    approval.unwrap_or("on-request")
                );
            }
        }
    }

    #[test]
    fn invalid_policy_options_fail_instead_of_falling_back_to_bypass() {
        for sandbox in ["", "  ", "workspace_write", "invalid"] {
            let error = CodexExecutionPolicy::from_values(Some(sandbox), None).unwrap_err();
            assert!(error.to_string().contains("RESEARCHLAB_CODEX_SANDBOX"));
        }
        for approval in ["", "  ", "bypass", "invalid"] {
            let error = CodexExecutionPolicy::from_values(None, Some(approval)).unwrap_err();
            assert!(error
                .to_string()
                .contains("RESEARCHLAB_CODEX_APPROVAL_POLICY"));
        }
    }

    #[test]
    fn scoped_scholarly_network_uses_named_profile_without_legacy_sandbox_network() {
        // Every approved host, taken from the list itself: a hand-typed copy
        // went stale the day a citation index was added to it.
        let profile =
            CodexNetworkPermissionProfile::from_values(Some(&SCHOLARLY_NETWORK_DOMAINS.join(",")))
                .unwrap()
                .unwrap();
        let policy = CodexExecutionPolicy::from_values_with_network(
            Some("workspace-write"),
            Some("on-request"),
            Some(profile),
        )
        .unwrap();
        let mut command = Command::new("codex");
        append_codex_exec_args(
            &mut command,
            None,
            &[],
            &["features.network_proxy=false".to_string()],
            &policy,
            Path::new("last.txt"),
            None,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"--strict-config".to_string()));
        assert!(!args.contains(&"--ignore-user-config".to_string()));
        assert!(!args.iter().any(|arg| arg == "--sandbox"));
        assert!(!args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        let profile_override = args
            .iter()
            .find(|arg| arg.starts_with("permissions.researchlab_scholarly={"))
            .expect("complete scholarly profile override");
        assert!(profile_override.contains("extends=\":workspace\""));
        assert!(profile_override.contains("network={enabled=true,mode=\"limited\""));
        for domain in SCHOLARLY_NETWORK_DOMAINS {
            assert!(profile_override.contains(&format!("\"{domain}\"=\"allow\"")));
        }
        let forced_proxy_index = args
            .iter()
            .rposition(|arg| arg == "features.network_proxy=true")
            .unwrap();
        let broad_override_index = args
            .iter()
            .position(|arg| arg == "features.network_proxy=false")
            .unwrap();
        assert!(forced_proxy_index > broad_override_index);
        assert!(args.contains(&"default_permissions=\"researchlab_scholarly\"".to_string()));
        assert!(args.contains(&"approval_policy=\"on-request\"".to_string()));
    }

    #[test]
    fn scoped_scholarly_network_rejects_empty_extra_or_broad_hosts() {
        assert!(CodexNetworkPermissionProfile::from_values(Some(" ")).is_err());
        assert!(CodexNetworkPermissionProfile::from_values(Some("example.com")).is_err());
        assert!(CodexNetworkPermissionProfile::from_values(Some("openalex.org")).is_err());
        assert!(CodexNetworkPermissionProfile::from_values(Some("*.arxiv.org")).is_err());
        // An asset host does not become a scholarly host.
        let error = CodexNetworkPermissionProfile::from_values(Some("pypi.org")).unwrap_err();
        assert!(error
            .to_string()
            .contains("RESEARCHLAB_CODEX_NETWORK_DOMAINS contains unapproved host \"pypi.org\""));
    }

    fn scholarly_policy() -> CodexExecutionPolicy {
        let profile =
            CodexNetworkPermissionProfile::from_values(Some(&SCHOLARLY_NETWORK_DOMAINS.join(",")))
                .unwrap()
                .unwrap();
        CodexExecutionPolicy::from_values_with_network(
            Some("workspace-write"),
            Some("on-request"),
            Some(profile),
        )
        .unwrap()
    }

    #[test]
    fn asset_hosts_are_approved_only_as_listed() {
        use super::super::codex_policy::OPEN_SOURCE_ASSET_DOMAINS;
        // Not opted in: engineers keep today's scholarly profile.
        assert_eq!(OpenSourceAssetNetwork::from_values(None, None, None).unwrap(), None);
        assert_eq!(OpenSourceAssetNetwork::from_values(None, Some("0"), None).unwrap(), None);
        // Opted in with no list: every approved asset host, git-capable mode.
        let all = OpenSourceAssetNetwork::from_values(None, Some("1"), None).unwrap().unwrap();
        assert_eq!(all.domains, OPEN_SOURCE_ASSET_DOMAINS.iter().map(|d| d.to_string()).collect::<Vec<_>>());
        assert_eq!(all.mode, "full");
        // A reproduction anchor is DEFINED by one published checkpoint, and its
        // authors often host it themselves. cycle-a-20260919 opened
        // its repaired sequence with the official Diffusion Policy Push-T
        // checkpoint, which no package index serves.
        assert!(
            all.domains.iter().any(|host| host == "diffusion-policy.cs.columbia.edu"),
            "the asset profile reaches every index but not the file an anchor is defined by: {:?}",
            all.domains
        );
        // A narrowed list may name asset and scholarly hosts, in any case.
        let narrow = OpenSourceAssetNetwork::from_values(
            Some(" PyPI.org ,files.pythonhosted.org,api.openalex.org,pypi.org,*.hf.co"),
            None,
            Some("limited"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            narrow.domains,
            ["pypi.org", "files.pythonhosted.org", "api.openalex.org", "*.hf.co"]
        );
        assert_eq!(narrow.mode, "limited");
        // Anything else is refused, wildcards included unless listed verbatim.
        for host in ["example.com", "*", "*.co", "**.hf.co", "*.githubusercontent.com", "pypi.org.evil.com"] {
            let error = OpenSourceAssetNetwork::from_values(Some(host), Some("1"), None).unwrap_err();
            assert!(
                error.to_string().contains("RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS contains unapproved host"),
                "{host}: {error}"
            );
        }
        assert!(OpenSourceAssetNetwork::from_values(Some(" , "), None, None).is_err());
        assert!(OpenSourceAssetNetwork::from_values(None, Some("1"), Some("open")).is_err());
    }

    #[test]
    fn only_a_provisioning_lane_gets_the_asset_profile() {
        for (role, action) in [
            ("engineer", "capability_provisioning_followup"),
            ("engineer", crate::labdirector::SIMULATION_DATA_GENERATION_ACTION),
            ("engineer", ""),
            // The action provisions, whichever role was handed it.
            ("lab-runner", "capability_provisioning_followup"),
        ] {
            assert!(lane_provisions_environment(role, action), "{role}/{action}");
        }
        for role in ["scout", "analyst", "lab-runner", "gatekeeper", "lab-director", "chronicle", "author", "illustrator"] {
            for action in ["", "reasoning_literature_scout", "methods_followup", "pivot_followup"] {
                assert!(!lane_provisions_environment(role, action), "{role}/{action}");
            }
        }

        let assets = OpenSourceAssetNetwork::from_values(None, Some("1"), None).unwrap().unwrap();
        let engineer = scholarly_policy().for_lane(true, Some(&assets));
        assert_eq!(
            engineer.permission_profile_name(AgentRuntime::Codex),
            Some("researchlab_open_source_assets")
        );
        assert_eq!(engineer.network_mode(AgentRuntime::Codex), "full");
        let domains = engineer.network_domains(AgentRuntime::Codex);
        // Scholarly ∪ assets, each once.
        for host in SCHOLARLY_NETWORK_DOMAINS.iter().chain(["pypi.org", "github.com", "*.hf.co", "dl.fbaipublicfiles.com"].iter()) {
            assert_eq!(domains.iter().filter(|d| d == host).count(), 1, "{host}");
        }
        let args = policy_args(&engineer);
        let profile = args
            .iter()
            .find(|arg| arg.starts_with("permissions.researchlab_open_source_assets={"))
            .expect("asset profile override");
        assert!(profile.contains("mode=\"full\""));
        assert!(profile.contains("\"*.hf.co\"=\"allow\""));
        assert!(profile.contains("proxy_url=\"http://127.0.0.1:3128\""));
        assert!(args.contains(&"default_permissions=\"researchlab_open_source_assets\"".to_string()));
        assert!(!args.iter().any(|arg| arg.contains("researchlab_scholarly")));

        // Scholarly lanes are untouched, as are lanes with no opt-in.
        for policy in [
            scholarly_policy().for_lane(false, Some(&assets)),
            scholarly_policy().for_lane(true, None),
        ] {
            assert_eq!(policy.permission_profile_name(AgentRuntime::Codex), Some("researchlab_scholarly"));
            assert_eq!(policy.network_mode(AgentRuntime::Codex), "limited");
            assert_eq!(policy_args(&policy), policy_args(&scholarly_policy()));
        }
        // A lane with no scoped profile is not network-limited; nothing to widen.
        let legacy = CodexExecutionPolicy::from_values(None, None).unwrap().for_lane(true, Some(&assets));
        assert_eq!(legacy.permission_profile_name(AgentRuntime::Codex), None);
        assert_eq!(legacy.network_mode(AgentRuntime::Codex), "legacy");
    }

    #[test]
    fn the_lane_records_which_network_profile_it_ran_with() {
        let assets = OpenSourceAssetNetwork::from_values(Some("pypi.org"), None, None).unwrap().unwrap();
        let mut engineer = json!({"lane_id": "followup-engineer-01"});
        record_network_policy(&mut engineer, &scholarly_policy().for_lane(true, Some(&assets)), AgentRuntime::Codex);
        assert_eq!(engineer["permission_profile"], "researchlab_open_source_assets");
        assert_eq!(engineer["network_mode"], "full");
        assert!(engineer["network_domains"].as_array().unwrap().contains(&json!("pypi.org")));
        assert!(engineer["network_domains"].as_array().unwrap().contains(&json!("api.openalex.org")));

        let mut scout = json!({});
        record_network_policy(&mut scout, &scholarly_policy(), AgentRuntime::Codex);
        assert_eq!(scout["permission_profile"], "researchlab_scholarly");
        assert_eq!(scout["network_mode"], "limited");
        assert_eq!(scout["network_domains"], json!(SCHOLARLY_NETWORK_DOMAINS));

        let mut claude = json!({});
        record_network_policy(&mut claude, &scholarly_policy(), AgentRuntime::Claude);
        assert_eq!(claude["permission_profile"], Value::Null);
        assert_eq!(claude["network_mode"], "legacy");
    }

    #[test]
    fn explicit_policy_wins_over_general_config_and_preserves_output_args() {
        let policy =
            CodexExecutionPolicy::from_values(Some(" workspace-write "), Some(" on-request "))
                .unwrap();
        let mut command = Command::new("codex");
        append_codex_exec_args(
            &mut command,
            Some("test-model"),
            &["test-feature".to_string()],
            &["approval_policy=\"never\"".to_string()],
            &policy,
            Path::new("last message.txt"),
            Some(Path::new("schema.json")),
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "exec",
                "--json",
                "--ephemeral",
                "--model",
                "test-model",
                "--disable",
                "test-feature",
                "--config",
                "approval_policy=\"never\"",
                "--disable",
                "multi_agent",
                "--disable",
                "multi_agent_v2",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "--config",
                "approval_policy=\"on-request\"",
                "--config",
                "forced_login_method=\"chatgpt\"",
                "--config",
                "model_provider=\"openai\"",
                "--output-last-message",
                "last message.txt",
                "--output-schema",
                "schema.json",
                "-",
            ]
        );
        assert_eq!(
            policy.sandbox_mode(AgentRuntime::Claude),
            "skip-permissions"
        );
        assert_eq!(policy.approvals_mode(AgentRuntime::Claude), "bypass");
    }

    #[test]
    fn ephemeral_invocation_forces_collaboration_off_after_general_config() {
        let policy = CodexExecutionPolicy::from_values(None, None).unwrap();
        let mut command = Command::new("codex");
        append_codex_exec_args(
            &mut command,
            None,
            &["multi_agent".to_string(), "shell_snapshot".to_string()],
            &[
                "features.multi_agent=true".to_string(),
                "features.multi_agent_v2=true".to_string(),
            ],
            &policy,
            Path::new("last.txt"),
            None,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let config_v1 = args
            .iter()
            .position(|arg| arg == "features.multi_agent=true")
            .unwrap();
        let config_v2 = args
            .iter()
            .position(|arg| arg == "features.multi_agent_v2=true")
            .unwrap();
        let disabled_v1 = args.iter().rposition(|arg| arg == "multi_agent").unwrap();
        let disabled_v2 = args
            .iter()
            .rposition(|arg| arg == "multi_agent_v2")
            .unwrap();
        assert!(disabled_v1 > config_v1);
        assert!(disabled_v2 > config_v2);
        assert_eq!(args.iter().filter(|arg| *arg == "multi_agent").count(), 1);
        assert_eq!(
            args.iter().filter(|arg| *arg == "multi_agent_v2").count(),
            1
        );

        let effective = effective_codex_disabled_features(vec!["shell_snapshot".to_string()]);
        assert!(effective.iter().any(|item| item == "multi_agent"));
        assert!(effective.iter().any(|item| item == "multi_agent_v2"));
    }

    #[test]
    fn model_reported_blocked_status_is_a_lane_failure_signal() {
        assert!(model_reported_blocked_status(Some(&json!({
            "status": "blocked",
            "reason": "uv trampoline execution was blocked: permission denied",
            "candidate_count": 0
        }))));
    }

    #[test]
    fn an_agent_message_cut_by_the_log_tail_is_not_a_setup_failure() {
        // followup-analyst-24: one long final message line whose prose names a
        // tool execution and an incomplete setup installation.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("stdout.log");
        let prose = "the setup helper installation stayed incomplete; not a tool execution. "
            .repeat(WINDOWS_SETUP_LOG_TAIL_BYTES / 40);
        let line = format!(
            "{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"{prose}\"}}}}\n"
        );
        fs::write(&path, format!("{{\"type\":\"turn.started\"}}\n{line}")).unwrap();
        let tail = read_log_tail(&path);
        assert!(!tail.contains("\"type\":\"agent_message\""), "the fixture must cut the prefix");
        assert!(windows_setup_failure_evidence(&tail, "").is_none());

        // A real tool error line inside the tail is still seen.
        let tool_error = "{\"subtype\":\"error_during_execution\",\"message\":\"ShellExecuteExW failed: 1223\"}\n";
        fs::write(&path, format!("{line}{tool_error}")).unwrap();
        assert!(windows_setup_failure_evidence(&read_log_tail(&path), "").is_some());
        // The context and the signature must share a line.
        assert!(windows_setup_failure_evidence(
            "{\"type\":\"tool_error\",\"message\":\"network\"}\n{\"note\":\"setup helper cancel\"}",
            "",
        )
        .is_none());
    }

    #[test]
    fn setup_watchdog_accepts_all_helper_incomplete_variants_but_not_quoted_agent_prose() {
        assert!(windows_setup_failure_evidence("", "orchestrator_helper_incomplete").is_some());
        assert!(windows_setup_failure_evidence(
            r#"{\"type\":\"tool_result\",\"result\":\"orchestrator_helper_canceled: setup helper exited before setup completed\"}"#,
            "",
        )
        .is_some());
        assert!(windows_setup_failure_evidence(
            r#"{\"type\":\"agent_message\",\"text\":\"orchestrator_helper_incomplete: prior failure\"}"#,
            "",
        )
        .is_none());
        assert!(windows_setup_failure_evidence(
            "{\"subtype\":\"error_during_execution\",\"message\":\"ShellExecuteExW failed: 1223\"}",
            "",
        )
        .is_some());
        assert!(windows_setup_failure_evidence(
            "I previously saw ShellExecuteExW failed: 1223, but will now continue with another task.",
            "",
        )
        .is_none());
    }

    #[test]
    fn completed_empty_data_scout_is_not_reclassified_as_blocked() {
        assert!(!model_reported_blocked_status(Some(&json!({
            "status": "completed",
            "candidate_count": 0,
            "dataset_candidates": []
        }))));
    }

    #[test]
    fn blocked_literature_scout_is_not_promoted_by_degraded_fallback() {
        let contract = LaneContract {
            cycle_id: "cycle-test".to_string(),
            lane_id: "scout-test".to_string(),
            role: "scout".to_string(),
            runtime_class: "codex-agent".to_string(),
            mode: "read-write-scoped".to_string(),
            cwd: PathBuf::from("."),
            task_file: PathBuf::from("task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![],
            output_artifact: None,
            fallback_strategy: None,
        };
        let role_plan = json!({"action_type": "reasoning_literature_scout"});
        let mut status = "failed";
        let mut payload = json!({
            "status": "failed",
            "model_reported_blocked": true,
            "extracted_json": {"status": "blocked", "blocker": "setup helper canceled"},
            "error": "agent reported status=blocked",
            "stderr": "ShellExecuteExW failed: 1223"
        });

        assert!(preserve_failed_literature_scout(
            &contract,
            Some(&role_plan),
            "context_window_exceeded",
            &mut status,
            &mut payload,
        ));
        assert_eq!(status, "failed");
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["failure_category"], "context_window_exceeded");
        assert_eq!(payload["extracted_json"]["status"], "blocked");
        assert_eq!(payload["error"], "agent reported status=blocked");
        assert!(!should_enforce_literature_completion(status, false, true));

        let mut auth_status = "failed";
        let mut auth_payload = json!({"status": "failed"});
        assert!(!preserve_failed_literature_scout(
            &contract,
            Some(&role_plan),
            "auth_refresh_wait",
            &mut auth_status,
            &mut auth_payload,
        ));
    }

    #[test]
    fn provider_quota_pauses_the_cycle_once_and_blocks_later_launches() {
        let temp = TempDir::new().unwrap();
        let paths = watchdog_paths(temp.path());
        let contract = watchdog_contract(temp.path());
        fs::create_dir_all(state_root(&paths)).unwrap();
        let limit = "{\"type\":\"error\",\"message\":\"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 21st, 2026 9:43 AM.\"}";

        let read_test_json = |path: &Path| -> Value {
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        };

        assert!(provider_quota_pause(&paths, &contract).is_none());
        record_provider_quota_block(&paths, &contract, limit).unwrap();

        let pause = read_test_json(&shared_pause_marker_path(&paths, &contract.cycle_id));
        assert_eq!(pause["block_type"], "provider_quota");
        assert_eq!(pause["retry_after_hint"], "Sep 21st, 2026 9:43 AM");
        let termination = read_test_json(
            &state_root(&paths).join(format!("{}-termination-code.json", contract.cycle_id)),
        );
        assert_eq!(termination["code"], "PROVIDER_QUOTA_EXHAUSTED");
        assert_eq!(termination["should_stop"], true);
        // The run loop stops dispatching while this marker exists.
        assert!(shared_pause_marker_path(&paths, &contract.cycle_id).exists());

        // Every later lane is refused before an agent starts, and stays runnable.
        let reason = provider_quota_pause(&paths, &contract).expect("pause is visible");
        let refused = provider_quota_blocked_lane(&reason);
        assert_eq!(refused["status"], "prepared");
        assert_eq!(refused["retryable"], true);

        // A second lane hitting the limit does not rewrite the first record.
        let mut later = watchdog_contract(temp.path());
        later.lane_id = "gatekeeper-07".to_string();
        record_provider_quota_block(&paths, &later, "usage limit").unwrap();
        let pause = read_test_json(&shared_pause_marker_path(&paths, &contract.cycle_id));
        assert_eq!(pause["lane_id"], "scout-02");
    }

    #[test]
    fn provider_quota_retry_hint_is_optional() {
        assert_eq!(provider_quota_retry_hint("You've hit your usage limit."), None);
        assert_eq!(
            provider_quota_retry_hint("limit reached. try again at 1:58 PM.\n"),
            Some("1:58 PM".to_string())
        );
    }

    #[test]
    fn a_silent_codex_stream_is_stopped_as_stalled_but_a_running_tool_is_not() {
        let temp = TempDir::new().unwrap();
        let paths = watchdog_paths(temp.path());
        let contract = watchdog_contract(temp.path());
        let lane_dir = paths
            .runtime_root
            .join("lanes")
            .join(&contract.cycle_id)
            .join(&contract.lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        let previous = std::env::var("RESEARCHLAB_CODEX_IDLE_SECONDS").ok();
        std::env::set_var("RESEARCHLAB_CODEX_IDLE_SECONDS", "2");

        // followup-analyst-03's shape: two start events, then nothing.
        let run = |line: &str, name: &str| {
            let stdout_path = lane_dir.join(format!("{name}.stdout.log"));
            let stderr_path = lane_dir.join(format!("{name}.stderr.log"));
            fs::write(&stdout_path, format!("{{\"type\":\"thread.started\"}}\n{line}\n")).unwrap();
            #[cfg(windows)]
            let mut child = Command::new("cmd")
                .args(["/C", "ping -n 8 127.0.0.1 >nul"])
                .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
                .spawn()
                .unwrap();
            #[cfg(not(windows))]
            let mut child = Command::new("sh")
                .args(["-c", "sleep 7"])
                .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
                .spawn()
                .unwrap();
            let pid = child.id();
            let started = Instant::now();
            let outcome = wait_for_agent_with_setup_watchdog(
                &mut child, pid, &stdout_path, &stderr_path,
                Duration::from_secs(5), &paths, &contract, name,
            )
            .unwrap();
            (outcome, started.elapsed())
        };

        let (silent, waited) = run("{\"type\":\"turn.started\"}", "silent");
        assert!(silent.stalled, "a silent stream was not reported as stalled");
        assert!(silent.timed_out, "a stall must reach the existing timeout recovery");
        assert!(waited < Duration::from_secs(5), "the stall waited for the role timeout");

        // A long simulation or build prints nothing until it returns.
        let (tool, _) = run(
            "{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\"}}",
            "tool",
        );
        assert!(!tool.stalled, "a running tool call was killed as a stall");

        match previous {
            Some(value) => std::env::set_var("RESEARCHLAB_CODEX_IDLE_SECONDS", value),
            None => std::env::remove_var("RESEARCHLAB_CODEX_IDLE_SECONDS"),
        }
    }

    #[test]
    fn setup_watchdog_stops_a_mock_child_and_writes_shared_runtime_blockers() {
        let temp = TempDir::new().unwrap();
        let paths = watchdog_paths(temp.path());
        let contract = watchdog_contract(temp.path());
        let lane_dir = paths
            .runtime_root
            .join("lanes")
            .join(&contract.cycle_id)
            .join(&contract.lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        let stdout_path = lane_dir.join("mock.stdout.log");
        let stderr_path = lane_dir.join("mock.stderr.log");
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args([
                "/C",
                "echo ShellExecuteExW failed: 1223 1>&2 & ping -n 10 127.0.0.1 >nul",
            ])
            .stdout(Stdio::from(File::create(&stdout_path).unwrap()))
            .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", "echo 'ShellExecuteExW failed: 1223' >&2; sleep 10"])
            .stdout(Stdio::from(File::create(&stdout_path).unwrap()))
            .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
            .spawn()
            .unwrap();

        let child_pid = child.id();
        let outcome = wait_for_agent_with_setup_watchdog(
            &mut child,
            child_pid,
            &stdout_path,
            &stderr_path,
            Duration::from_secs(3),
            &paths,
            &contract,
            "mock",
        )
        .unwrap();
        assert!(!outcome.timed_out);
        assert!(outcome.setup_blocked.is_some());
        let pause_path = shared_pause_marker_path(&paths, &contract.cycle_id);
        let pause = crate::core::support::read_json(&pause_path).unwrap();
        assert_eq!(pause["block_type"], json!("windows_sandbox_setup"));
        assert_eq!(pause["manual_resume_required"], json!(true));
        // A directly invoked or already queued lane must honor the same block,
        // even when its execution policy would otherwise skip scoped preflight.
        let termination_path =
            state_root(&paths).join(format!("{}-termination-code.json", contract.cycle_id));
        let termination = crate::core::support::read_json(&termination_path).unwrap();
        assert_eq!(termination["code"], json!("RUNTIME_SETUP_BLOCKED"));
        assert_eq!(termination["should_stop"], json!(true));

        // The pause is a live condition, not a latch: on a host whose sandbox
        // passes readiness again it clears itself, and it never refuses a lane
        // with the fact that a refusal exists. On a host that still fails
        // readiness it holds, and says what is wrong.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-22: refusing on "a
        // pause exists" handed that sentence to the next pause as its evidence,
        // which re-recorded it with a fresh blocked_at, for ever.
        let policy = CodexExecutionPolicy::from_values(None, None).unwrap();
        let pause_path = shared_pause_marker_path(&paths, &contract.cycle_id);
        match crate::runtime::windows_sandbox_readiness::scholarly_windows_setup_problem() {
            None => {
                assert_eq!(scoped_windows_setup_problem(&paths, &contract, &policy), None);
                assert!(!pause_path.exists(), "a pause nothing describes must clear itself");
                assert!(!termination_path.exists());
            }
            Some(problem) => {
                assert_eq!(
                    scoped_windows_setup_problem(&paths, &contract, &policy),
                    Some(problem)
                );
                assert!(pause_path.exists(), "a real setup problem still holds the cycle");
            }
        }
        assert!(
            !scoped_windows_setup_problem(&paths, &contract, &policy)
                .is_some_and(|reason| reason.contains("Existing Windows sandbox setup pause")),
            "a refusal must name the problem, never the refusal"
        );
    }

    #[test]
    fn a_docker_scout_ignores_windows_setup_signatures() {
        let temp = TempDir::new().unwrap();
        let paths = watchdog_paths(temp.path());
        let contract = watchdog_contract(temp.path());
        let stdout_path = temp.path().join("docker.stdout.log");
        let stderr_path = temp.path().join("docker.stderr.log");
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", "echo ShellExecuteExW failed: 1223 1>&2"])
            .stdout(Stdio::from(File::create(&stdout_path).unwrap()))
            .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", "echo 'ShellExecuteExW failed: 1223' >&2"])
            .stdout(Stdio::from(File::create(&stdout_path).unwrap()))
            .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
            .spawn()
            .unwrap();
        let child_pid = child.id();
        let outcome = wait_for_agent(
            &mut child,
            child_pid,
            &stdout_path,
            &stderr_path,
            Duration::from_secs(10),
            &paths,
            &contract,
            "docker",
            false,
        )
        .unwrap();
        assert!(outcome.setup_blocked.is_none());
        assert!(!outcome.timed_out);
        assert!(!shared_pause_marker_path(&paths, &contract.cycle_id).exists());
    }

    #[test]
    fn a_docker_scout_launch_keeps_the_host_args_and_prompt() {
        let temp = TempDir::new().unwrap();
        let lane = temp.path().join("lane");
        fs::create_dir_all(&lane).unwrap();
        let prompt_path = lane.join("prompt.txt");
        let host_prompt = "Write D:\\projects\\researchlab\\researchlab\\out.json\n";
        fs::write(&prompt_path, host_prompt).unwrap();
        let profile =
            CodexNetworkPermissionProfile::from_values(Some(&SCHOLARLY_NETWORK_DOMAINS.join(",")))
                .unwrap()
                .unwrap();
        let policy = CodexExecutionPolicy::from_values_with_network(
            Some("workspace-write"),
            Some("on-request"),
            Some(profile),
        )
        .unwrap();
        let lane_host = Path::new(r"D:\projects\researchlab\researchlab\.research-lab\lanes\c\l");
        let mut host = Command::new("codex");
        append_codex_exec_args(
            &mut host,
            Some("gpt-5.5"),
            &[],
            &[],
            &policy,
            &lane_host.join("output-last-message.txt"),
            Some(&lane_host.join("output-schema.json")),
        );
        let host_args: Vec<String> = host
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let scout = DockerScout {
            gpus: None,
            extra_mounts: Vec::new(),
            image: "researchlab:local".to_string(),
            mount_root: "D:/projects/researchlab".to_string(),
            container_name: "rl-c-l".to_string(),
            auth_json: "C:/Users/user/.codex/auth.json".to_string(),
            workdir: "/work/researchlab".to_string(),
            container_env: vec![("RESEARCHLAB_PYTHON".to_string(), "python3".to_string())],
            host_python: None,
        };
        let (docker, stdin_path) =
            docker_scout_launch(&scout, &host, Path::new("/definitely/not/setsid"), &prompt_path)
                .unwrap();

        assert_eq!(stdin_path, lane.join("prompt.docker.txt"));
        assert_eq!(fs::read_to_string(&prompt_path).unwrap(), host_prompt);
        let container_prompt = fs::read_to_string(&stdin_path).unwrap();
        assert!(container_prompt.starts_with("This lane runs in a Linux container"));
        assert!(container_prompt.ends_with("Write /work/researchlab/out.json\n"));

        assert_eq!(docker.get_program(), "docker");
        let args: Vec<String> = docker
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let codex_at = args.iter().position(|arg| arg == "codex").unwrap();
        assert_eq!(args[codex_at - 1], "researchlab:local");
        let container_args = &args[codex_at + 1..];
        assert_eq!(container_args.len(), host_args.len());
        for (host_arg, container_arg) in host_args.iter().zip(container_args) {
            if host_arg.starts_with(r"D:\projects") {
                assert!(container_arg.starts_with("/work/researchlab/.research-lab/lanes/c/l/"));
            } else {
                // Policy, profile and approval args pass through unchanged.
                assert_eq!(host_arg, container_arg);
            }
        }
        assert!(container_args.contains(&"approval_policy=\"on-request\"".to_string()));

        let mut invocation = json!({});
        record_execution_venue(&mut invocation, Some(&scout), None);
        assert_eq!(invocation["execution_venue"], json!("docker"));
        assert_eq!(invocation["docker_image"], json!("researchlab:local"));
        assert_eq!(invocation["docker_container"], json!("rl-c-l"));
        let mut host_lane = json!({});
        record_execution_venue(&mut host_lane, None, None);
        assert_eq!(host_lane, json!({"execution_venue": "host"}));
    }
}

// How many extra "finish the job" turns a chronicle lane gets when it exits 0
// having only *announced* the KG artifacts. 0 disables continuation (revert to
// the legacy reclassify-as-failed-and-retry behaviour).
pub(crate) fn chronicle_continuation_max_passes() -> usize {
    std::env::var("RESEARCHLAB_CHRONICLE_CONTINUATION_MAX_PASSES")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(2)
}

// Re-instruct the SAME chronicle lane to actually WRITE the three KG artifacts
// it already announced. We faithfully restate the lane's own task contract
// (exact paths + node/edge duties) and feed back the model's truncated last
// message so it resumes instead of re-planning. No scientific content is
// injected here — only "finish writing the files you said you would".
pub(crate) fn build_chronicle_continuation_prompt(
    contract: &LaneContract,
    state_dir: &Path,
    attempt: usize,
    prior_last_message: &str,
) -> String {
    let cycle = contract.cycle_id.as_str();
    let lane = contract.lane_id.as_str();
    let lit = state_dir
        .join(format!("{cycle}-literature-graph.json"))
        .display()
        .to_string();
    let data = state_dir
        .join(format!("{cycle}-data-graph.json"))
        .display()
        .to_string();
    let trend = state_dir
        .join(format!("{cycle}-trend-summary.json"))
        .display()
        .to_string();
    let prior = excerpt_text(prior_last_message, 1200);
    format!(
        "You are RESUMING the same chronicle KG-bootstrap lane ({lane}) for cycle {cycle}. \
Your previous turn ended cleanly (exit 0) while you were still working — your last message was:\n\
\"{prior}\"\n\n\
The cycle is now BLOCKED because one or more of the three mandatory knowledge-graph artifacts are \
missing or empty on disk. Do NOT re-plan, re-summarize, ask questions, or fetch more papers than \
needed. Using your shell tools, FINISH WRITING the artifacts to these EXACT paths now, then stop:\n\
  - {lit}\n  - {data}\n  - {trend}\n\n\
Rules (unchanged from your original task — re-read scout corpus at \
.research-lab/lanes/{cycle}/scout-*/result.json which is already complete):\n\
- literature-graph.json: nodes for candidate variable families, mechanisms, and outcomes referenced \
in the retrieved literature, edges annotated by supporting paper ids. Never leave it empty merely \
because validation data is not downloaded; reviews still yield mechanism/outcome families.\n\
- data-graph.json: nodes for the SPECIFIC datasets/cohorts/registries named in the prompt or \
surfaced by data-scout candidates (each dataset node type:\"dataset\" with metadata dataset_name, \
access_status, materialized), plus variable/outcome nodes connected by candidate_validation_target \
or measured_in edges. Preserve any nodes already present in the file.\n\
- trend-summary.json: compact JSON with cluster_labels, dominant_mechanisms, rising_methodologies, \
saturated_baselines, open_gaps, research_attention_map, attention_concentration — grounded in the \
retrieved papers.\n\
- Each file must be valid JSON with non-trivial content (real nodes[] and edges[], > 2 bytes).\n\
- SEQUENTIAL_EXECUTION_RULE: run shell commands STRICTLY ONE AT A TIME; emit a short message between \
commands so the lane heartbeat stays alive.\n\
- When all three files exist on disk, emit the small (<=2 KB) final JSON object: \
{{\"status\":\"ok\",\"graph_artifact_paths\":[\"{lit}\",\"{data}\",\"{trend}\"],\
\"discussion_seed_for_lab_director\":\"<=500 chars\"}}.\n\
This is continuation attempt {attempt}: produce the FILES, not narration.\n\
{ABSTRACT_SCREENING_POLICY}\n{RESEARCH_API_POLICY}\n\
If no approved literature is available, record pending abstract review with its queue path; \
do not invent graph evidence or turn pending candidates into supporting nodes."
    )
}

// Run one codex continuation turn for a chronicle lane that ended without its
// KG artifacts. Mirrors the compact-context retry path. Returns
// (timed_out, exit_success, stdout, stderr, last_message).
#[allow(clippy::too_many_arguments)]
fn run_chronicle_continuation_attempt(
    paths: &AppPaths,
    contract: &LaneContract,
    root: &Path,
    command: &str,
    setsid_path: &Path,
    runtime: AgentRuntime,
    assigned_model: Option<&str>,
    disabled_features: &[String],
    config_overrides: &[String],
    execution_policy: &CodexExecutionPolicy,
    codex_home: Option<&Path>,
    output_schema_present: bool,
    output_schema_path: &Path,
    timeout_seconds: u64,
    attempt: usize,
    prompt_text: &str,
) -> Result<(bool, bool, String, String, String)> {
    let prompt_path = root.join(format!("prompt-chronicle-continuation-{attempt}.txt"));
    let stdout_log_path = root.join(format!("stdout-chronicle-continuation-{attempt}.log"));
    let stderr_log_path = root.join(format!("stderr-chronicle-continuation-{attempt}.log"));
    let last_message_path = root.join(format!(
        "output-last-message-chronicle-continuation-{attempt}.txt"
    ));
    fs::write(&prompt_path, prompt_text)?;

    let mut builder = if setsid_path.exists() {
        let mut wrapped = Command::new(setsid_path);
        wrapped.arg(command);
        wrapped
    } else {
        Command::new(command)
    };
    match runtime {
        AgentRuntime::Codex => {
            append_codex_exec_args(
                &mut builder,
                assigned_model,
                disabled_features,
                config_overrides,
                execution_policy,
                &last_message_path,
                output_schema_present.then_some(output_schema_path),
            );
        }
        AgentRuntime::Claude => {
            let claude_model = assigned_model.filter(|model| {
                let lower = model.to_ascii_lowercase();
                matches!(lower.as_str(), "sonnet" | "opus" | "haiku")
                    || lower.starts_with("claude-")
            });
            builder
                .arg("-p")
                .arg("--output-format")
                .arg("json")
                .arg("--dangerously-skip-permissions")
                .args(if let Some(model) = claude_model {
                    vec!["--model".to_string(), model.to_string()]
                } else {
                    Vec::new()
                });
        }
    }
    apply_cli_environment(&mut builder);
    if let Some(reason) = provider_quota_pause(paths, contract) {
        return Err(anyhow!("chronicle continuation not launched: {reason}"));
    }
    if let Some(evidence) = scoped_windows_setup_problem(paths, contract, execution_policy) {
        record_windows_setup_block(paths, contract, "chronicle_prelaunch", &evidence)?;
        return Err(anyhow!("Windows sandbox setup blocked chronicle continuation: {evidence}"));
    }
    let mut child = builder
        .current_dir(&contract.cwd)
        .envs(codex_home.map(|path| ("CODEX_HOME", path.as_os_str())))
        .stdin(Stdio::from(
            File::open(&prompt_path).context("open chronicle continuation prompt for stdin")?,
        ))
        .stdout(Stdio::from(
            File::create(&stdout_log_path).context("create chronicle continuation stdout.log")?,
        ))
        .stderr(Stdio::from(
            File::create(&stderr_log_path).context("create chronicle continuation stderr.log")?,
        ))
        .spawn()
        .with_context(|| {
            format!(
                "failed to spawn chronicle continuation agent runtime ({})",
                runtime.as_str()
            )
        })?;
    let child_pid = child.id();
    let mut continuation_metadata = json!({
        "pid": child_pid,
        "started_at": now_iso(),
        "driver": match runtime {
            AgentRuntime::Codex => "codex-agent-executor",
            AgentRuntime::Claude => "claude-agent-executor",
        },
        "agent_runtime": runtime.as_str(),
        "sandbox_mode": execution_policy.sandbox_mode(runtime),
        "approvals_mode": execution_policy.approvals_mode(runtime),
        "approval_policy": if runtime == AgentRuntime::Codex { Some(execution_policy.approval_policy) } else { None },
        "timeout_seconds": timeout_seconds,
        "continuation_attempt": attempt,
    });
    record_network_policy(&mut continuation_metadata, execution_policy, runtime);
    write_process_metadata(
        paths,
        contract,
        "chronicle_continuation_running",
        continuation_metadata,
    )?;
    let watch = wait_for_agent_with_setup_watchdog(
        &mut child,
        child_pid,
        &stdout_log_path,
        &stderr_log_path,
        Duration::from_secs(timeout_seconds),
        paths,
        contract,
        "chronicle_continuation",
    )?;
    let timed_out = watch.timed_out;
    let exit_status = watch.exit_status;
    let _ = fs::remove_file(lane_process_path(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
    ));
    let stdout = fs::read_to_string(&stdout_log_path).unwrap_or_default();
    let stderr = fs::read_to_string(&stderr_log_path).unwrap_or_default();
    let last_message = {
        let file_value = fs::read_to_string(&last_message_path).unwrap_or_default();
        if !file_value.trim().is_empty() {
            file_value
        } else {
            match runtime {
                AgentRuntime::Codex => extract_codex_last_message(&stdout),
                AgentRuntime::Claude => extract_claude_last_message(&stdout),
            }
        }
    };
    let exit_success = exit_status.as_ref().map(|s| s.success()).unwrap_or(false);
    if watch.setup_blocked.is_some() {
        return Err(anyhow!(
            "Windows sandbox setup helper blocked chronicle continuation"
        ));
    }
    Ok((timed_out, exit_success, stdout, stderr, last_message))
}

pub(crate) fn run_codex_agent_lane(
    paths: &AppPaths,
    contract: &LaneContract,
    root: &Path,
    role_plan: Option<&Value>,
) -> Result<(String, Value, String, String, Vec<String>)> {
    let prompt_path = root.join("prompt.txt");
    let invocation_path = root.join("invocation.json");
    let output_last_message_path = root.join("output-last-message.txt");
    let output_schema_path = root.join("output-schema.json");
    // Codex stdout/stderr go straight to disk so the kernel never has to
    // hold them in a pipe buffer. See the comment near the spawn() call
    // below for why this matters (v14~v17 hung on pipe write/read).
    let stdout_log_path = root.join("stdout.log");
    let stderr_log_path = root.join("stderr.log");
    let role_plan_path = lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id);
    let prompt_text = build_codex_prompt(contract, role_plan)?;
    fs::write(&prompt_path, &prompt_text)?;
    let action_type = role_plan_action_type(role_plan);
    let output_schema = codex_output_schema(&contract.role, action_type);
    if let Some(schema) = output_schema.as_ref() {
        write_json(&output_schema_path, schema)?;
    }
    let interpretation_schema = role_plan
        .and_then(|value| value.get("interpretation_schema"))
        .cloned();
    if contract.role == "analyst" && role_plan.is_none() {
        return Err(anyhow!(
            "analyst lane {} requires a role plan before execution",
            contract.lane_id
        ));
    }

    let auth = auth_status(paths)?;
    let requested_runtime = agent_runtime();
    let runtime = resolve_agent_runtime(requested_runtime);
    let execution_policy = if runtime == AgentRuntime::Codex {
        let provisions_environment = lane_provisions_environment(&contract.role, action_type);
        // Read only for a provisioning lane, so an asset setting can never
        // change or fail a scholarly lane.
        let assets = if provisions_environment {
            OpenSourceAssetNetwork::from_env()?
        } else {
            None
        };
        CodexExecutionPolicy::from_env()?.for_lane(provisions_environment, assets.as_ref())
    } else {
        CodexExecutionPolicy::from_values(None, None)?
    };
    let command = agent_command(runtime);
    let disabled_features = effective_codex_disabled_features(codex_disabled_features());
    let mut config_overrides = codex_config_overrides();
    if runtime == AgentRuntime::Codex {
        let routed_reasoning_effort = role_plan
            .and_then(|value| value.get("model_route"))
            .and_then(|route| route.get("reasoning_effort"))
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                )
            });
        let role_reasoning_effort =
            routed_reasoning_effort.or_else(|| match contract.role.as_str() {
                "lab-director" => Some("xhigh"),
                "analyst" => Some("high"),
                _ => None,
            });
        if let Some(reasoning_effort) = role_reasoning_effort {
            let override_value = format!("model_reasoning_effort=\"{reasoning_effort}\"");
            if !config_overrides.iter().any(|item| item == &override_value) {
                config_overrides.push(override_value);
            }
        }
    }
    let model_route = role_plan.and_then(|value| value.get("model_route"));
    let assigned_model = model_route
        .and_then(|route| route.get("model"))
        .or_else(|| role_plan.and_then(|value| value.get("assigned_model")))
        .and_then(Value::as_str)
        .map(codex_cli_supported_model)
        .filter(|value| !value.trim().is_empty());
    let docker_scout = docker_scout_config(
        paths,
        contract,
        root,
        runtime == AgentRuntime::Codex,
        researchlab_codex_home().as_deref(),
        role_plan,
    );

    let mut invocation = json!({
        "lane_id": contract.lane_id,
        "role": contract.role,
        "requested_agent_runtime": requested_runtime.as_str(),
        "agent_runtime": runtime.as_str(),
        "sandbox_mode": execution_policy.sandbox_mode(runtime),
        "approvals_mode": execution_policy.approvals_mode(runtime),
        "approval_policy": if runtime == AgentRuntime::Codex { Some(execution_policy.approval_policy) } else { None },
        "command": command,
        "assigned_model": assigned_model,
        "model_route": model_route,
        "has_access_token": auth.has_access_token,
        "has_refresh_token": auth.has_refresh_token,
        "auth_mode": auth.auth_mode,
        "prompt_path": prompt_path,
        "output_last_message_path": output_last_message_path,
        "output_schema_path": if output_schema.is_some() { json!(output_schema_path) } else { Value::Null },
        "interpretation_schema": interpretation_schema,
        "config_overrides": config_overrides.clone(),
        "ephemeral": true,
        "disabled_features": disabled_features.clone(),
        "task_file": contract.task_file,
        "role_plan_path": if role_plan_path.exists() { json!(role_plan_path) } else { json!(null) },
        "runtime_fallback_applied": requested_runtime != runtime,
    });
    record_network_policy(&mut invocation, &execution_policy, runtime);
    record_execution_venue(&mut invocation, docker_scout.as_ref(), role_plan);
    write_json(&invocation_path, &invocation)?;

    if command.is_none() {
        return Err(anyhow!(
            "requested {} runtime is unavailable; no automatic fallback to another provider is permitted",
            runtime.as_str()
        ));
    }

    let timeout_seconds = codex_timeout_seconds(contract, role_plan);
    let command = command.unwrap();
    let driver_label = match runtime {
        AgentRuntime::Codex => "codex-agent-executor",
        AgentRuntime::Claude => "claude-agent-executor",
    };
    let codex_home = if runtime == AgentRuntime::Codex {
        researchlab_codex_home()
    } else {
        None
    };
    let setsid_path = PathBuf::from("/usr/bin/setsid");
    let mut command_builder = if setsid_path.exists() {
        let mut wrapped = Command::new(&setsid_path);
        wrapped.arg(&command);
        wrapped
    } else {
        Command::new(&command)
    };

    match runtime {
        AgentRuntime::Codex => {
            append_codex_exec_args(
                &mut command_builder,
                assigned_model,
                &disabled_features,
                &config_overrides,
                &execution_policy,
                &output_last_message_path,
                output_schema.as_ref().map(|_| output_schema_path.as_path()),
            );
        }
        AgentRuntime::Claude => {
            // Claude CLI: -p (print/non-interactive), --output-format json gives
            // a single JSON object with "result" containing the final message.
            // --dangerously-skip-permissions matches the codex bypass behavior.
            // Only forward --model when the catalog assigned a claude-shaped
            // model id (alias like "sonnet"/"opus"/"haiku" or a "claude-..." id).
            // Codex-shaped ids ("gpt-5.x", "codex-...") would be rejected by
            // claude, so we let the CLI pick its default in that case.
            let claude_model = assigned_model.filter(|model| {
                let lower = model.to_ascii_lowercase();
                matches!(lower.as_str(), "sonnet" | "opus" | "haiku")
                    || lower.starts_with("claude-")
            });
            command_builder
                .arg("-p")
                .arg("--output-format")
                .arg("json")
                .arg("--dangerously-skip-permissions")
                .args(if let Some(model) = claude_model {
                    vec!["--model".to_string(), model.to_string()]
                } else {
                    Vec::new()
                });
            // No equivalent of codex --output-last-message; we extract from stdout.
        }
    };
    let mut stdin_prompt_path = prompt_path.clone();
    if let Some(scout) = docker_scout.as_ref() {
        (command_builder, stdin_prompt_path) =
            docker_scout_launch(scout, &command_builder, &setsid_path, &prompt_path)?;
        // A container left behind by a killed earlier attempt would hold the name.
        scout.remove_container();
    }
    apply_cli_environment(&mut command_builder);
    if let Some(reason) = provider_quota_pause(paths, contract) {
        return Ok((
            "prepared".to_string(),
            provider_quota_blocked_lane(&reason),
            String::new(),
            String::new(),
            vec![
                prompt_path.display().to_string(),
                invocation_path.display().to_string(),
            ],
        ));
    }
    let _scholarly_proxy_lease = if docker_scout.is_none()
        && runtime == AgentRuntime::Codex
        && execution_policy.network_profile.is_some()
    {
        Some(super::windows_sandbox_readiness::acquire_scholarly_proxy_lease()?)
    } else {
        None
    };
    // This admission check only reads the Windows sandbox marker and probes
    // local port availability. A passing check cannot rule out a later UAC
    // cancellation, so the runtime watchdog below remains necessary. A Docker
    // scout does not use the Windows sandbox, so neither check applies to it.
    if let Some(evidence) = docker_scout
        .is_none()
        .then(|| scoped_windows_setup_problem(paths, contract, &execution_policy))
        .flatten()
    {
        record_windows_setup_block(paths, contract, "prelaunch_readiness", &evidence)?;
        return Ok((
            "blocked".to_string(),
            json!({
                "status": "blocked",
                "driver": driver_label,
                "block_type": "windows_sandbox_setup",
                "manual_resume_required": true,
                "retryable": false,
                "error": "Windows sandbox readiness check blocked the Codex launch; resolve setup and explicitly resume.",
                "evidence": evidence,
            }),
            String::new(),
            String::new(),
            vec![
                prompt_path.display().to_string(),
                invocation_path.display().to_string(),
            ],
        ));
    }
    let mut child = command_builder
        .current_dir(&contract.cwd)
        // A Docker scout's Codex uses the container's CODEX_HOME.
        .envs(
            codex_home
                .iter()
                .filter(|_| docker_scout.is_none())
                .map(|path| ("CODEX_HOME", path.as_os_str())),
        )
        // CRITICAL stdio policy — file fds, NOT pipes.
        //
        // Codex CLI fork()s child processes that inherit stdio fds.
        // v14~v17 chronicle/lab-director lanes hung indefinitely under
        // the previous pipe-based stdio because:
        //   (a) Codex children kept the stdin pipe handle open even
        //       after the lane runner closed its writer side, so Codex
        //       never received EOF and the read() blocked.
        //   (b) Codex's per-event JSON stream eventually filled the
        //       64 KB pipe buffer for stdout (only drained later in
        //       wait_with_output), so Codex blocked on write().
        //       `wchan=pipe_w` confirmed on every hung lane.
        // Both vanish when stdio is wired to ordinary files: file fds
        // inherit cleanly across fork(), the kernel never has to
        // coordinate a pipe peer, and the on-disk artefacts double as
        // the stdout.log / stderr.log we read back below.
        .stdin(Stdio::from(
            File::open(&stdin_prompt_path).context("open prompt for stdin")?,
        ))
        .stdout(Stdio::from(
            File::create(&stdout_log_path).context("create stdout.log")?,
        ))
        .stderr(Stdio::from(
            File::create(&stderr_log_path).context("create stderr.log")?,
        ))
        .spawn()
        .with_context(|| format!("failed to spawn agent runtime ({})", runtime.as_str()))?;
    let child_pid = child.id();
    let mut process_metadata = json!({
        "pid": child_pid,
        "started_at": now_iso(),
        "driver": driver_label,
        "agent_runtime": runtime.as_str(),
        "sandbox_mode": execution_policy.sandbox_mode(runtime),
        "approvals_mode": execution_policy.approvals_mode(runtime),
        "approval_policy": if runtime == AgentRuntime::Codex { Some(execution_policy.approval_policy) } else { None },
        "timeout_seconds": timeout_seconds,
    });
    record_network_policy(&mut process_metadata, &execution_policy, runtime);
    record_execution_venue(&mut process_metadata, docker_scout.as_ref(), role_plan);
    write_process_metadata(paths, contract, "agent_running", process_metadata)?;
    // No stdin write needed — Codex reads the prompt directly from
    // prompt.txt via the file-backed stdin we plumbed in at spawn().
    // Note: prompt.txt was already written to disk earlier in this
    // function (fs::write(&prompt_path, &prompt_text)).
    let initial_watch = wait_for_agent(
        &mut child,
        child_pid,
        &stdout_log_path,
        &stderr_log_path,
        Duration::from_secs(timeout_seconds),
        paths,
        contract,
        "initial",
        docker_scout.is_none(),
    )?;
    // Killing the host `docker` client leaves the container running; after a
    // normal exit `--rm` already removed it and this is a no-op.
    if let Some(scout) = docker_scout.as_ref() {
        scout.remove_container();
    }
    let mut timed_out = initial_watch.timed_out;
    let mut stalled = initial_watch.stalled;
    // wait() not wait_with_output() — stdout/stderr are file fds, not
    // pipes; the OS closed them when Codex exited. We read the captured
    // text back from disk below.
    let mut exit_status = initial_watch.exit_status;
    let _ = fs::remove_file(lane_process_path(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
    ));
    let mut stdout = fs::read_to_string(&stdout_log_path).unwrap_or_default();
    let mut stderr = fs::read_to_string(&stderr_log_path).unwrap_or_default();
    let mut output_last_message = {
        let file_value = fs::read_to_string(&output_last_message_path).unwrap_or_default();
        if !file_value.trim().is_empty() {
            file_value
        } else {
            match runtime {
                AgentRuntime::Codex => extract_codex_last_message(&stdout),
                AgentRuntime::Claude => extract_claude_last_message(&stdout),
            }
        }
    };
    if let Some(evidence) = initial_watch.setup_blocked {
        let pause_path = shared_pause_marker_path(paths, &contract.cycle_id);
        let termination_path =
            state_root(paths).join(format!("{}-termination-code.json", contract.cycle_id));
        return Ok((
            "blocked".to_string(),
            json!({
                "status": "blocked",
                "driver": driver_label,
                "block_type": "windows_sandbox_setup",
                "manual_resume_required": true,
                "retryable": false,
                "error": "Windows sandbox setup helper blocked this Codex lane; resolve the prompt and explicitly resume.",
                "evidence": evidence,
                "pause_marker_path": pause_path,
                "termination_code_path": termination_path,
                "stdout": stdout,
                "stderr": stderr,
            }),
            stdout,
            stderr,
            vec![
                prompt_path.display().to_string(),
                invocation_path.display().to_string(),
            ],
        ));
    }
    let mut compact_retry_attempted = false;
    let mut compact_retry_succeeded = false;
    let initial_exit_success = exit_status.as_ref().map(|s| s.success()).unwrap_or(false);
    let first_failure = codex_failure_category(&stdout, &stderr, &output_last_message, timed_out);
    // A busy model is not a failed lane. The role plan already names the
    // alternative in model_route.fallback_chain, which until now nothing read:
    // thirteen lanes on 2026-09-10 paid for their whole prompt and were written
    // off because the runtime happened to be at capacity.
    let capacity_fallback_model: Option<String> = if first_failure == Some("model_at_capacity") {
        role_plan
            .and_then(|value| value.get("model_route"))
            .and_then(|route| route.get("fallback_chain"))
            .and_then(Value::as_array)
            .and_then(|chain| {
                chain
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|candidate| Some(*candidate) != assigned_model)
                    .map(str::to_string)
            })
    } else {
        None
    };
    if !timed_out
        && !initial_exit_success
        && (first_failure == Some("context_window_exceeded") || capacity_fallback_model.is_some())
    {
        compact_retry_attempted = true;
        let retry_prompt_path = root.join("prompt-retry-compact.txt");
        let retry_stdout_log_path = root.join("stdout-retry-compact.log");
        let retry_stderr_log_path = root.join("stderr-retry-compact.log");
        let retry_output_last_message_path = root.join("output-last-message-retry-compact.txt");
        // Nothing was wrong with the prompt when the model was merely busy, so
        // it is sent again unchanged; only an over-long context earns a rewrite.
        let retry_prompt = if capacity_fallback_model.is_some() {
            fs::read_to_string(&prompt_path)?
        } else {
            build_codex_context_retry_prompt(
                contract,
                role_plan,
                &stdout,
                &stderr,
                &output_last_message,
            )?
        };
        fs::write(&retry_prompt_path, retry_prompt)?;

        let mut retry_builder = if setsid_path.exists() {
            let mut wrapped = Command::new(&setsid_path);
            wrapped.arg(&command);
            wrapped
        } else {
            Command::new(&command)
        };
        let retry_model = capacity_fallback_model.as_deref().or(assigned_model);
        match runtime {
            AgentRuntime::Codex => {
                append_codex_exec_args(
                    &mut retry_builder,
                    retry_model,
                    &disabled_features,
                    &config_overrides,
                    &execution_policy,
                    &retry_output_last_message_path,
                    output_schema.as_ref().map(|_| output_schema_path.as_path()),
                );
            }
            AgentRuntime::Claude => {
                let claude_model = retry_model.filter(|model| {
                    let lower = model.to_ascii_lowercase();
                    matches!(lower.as_str(), "sonnet" | "opus" | "haiku")
                        || lower.starts_with("claude-")
                });
                retry_builder
                    .arg("-p")
                    .arg("--output-format")
                    .arg("json")
                    .arg("--dangerously-skip-permissions")
                    .args(if let Some(model) = claude_model {
                        vec!["--model".to_string(), model.to_string()]
                    } else {
                        Vec::new()
                    });
            }
        }
        let mut retry_stdin_path = retry_prompt_path.clone();
        if let Some(scout) = docker_scout.as_ref() {
            (retry_builder, retry_stdin_path) =
                docker_scout_launch(scout, &retry_builder, &setsid_path, &retry_prompt_path)?;
            scout.remove_container();
        }
        apply_cli_environment(&mut retry_builder);
        if let Some(reason) = provider_quota_pause(paths, contract) {
            return Ok((
                "prepared".to_string(),
                provider_quota_blocked_lane(&reason),
                stdout,
                stderr,
                vec![prompt_path.display().to_string(), invocation_path.display().to_string()],
            ));
        }
        if let Some(evidence) = docker_scout
            .is_none()
            .then(|| scoped_windows_setup_problem(paths, contract, &execution_policy))
            .flatten()
        {
            record_windows_setup_block(paths, contract, "compact_retry_prelaunch", &evidence)?;
            return Ok((
                "blocked".to_string(),
                json!({
                    "status": "blocked",
                    "block_type": "windows_sandbox_setup",
                    "manual_resume_required": true,
                    "retryable": false,
                    "evidence": evidence,
                }),
                stdout,
                stderr,
                vec![prompt_path.display().to_string(), invocation_path.display().to_string()],
            ));
        }
        let mut retry_child = retry_builder
            .current_dir(&contract.cwd)
            .envs(
                codex_home
                    .iter()
                    .filter(|_| docker_scout.is_none())
                    .map(|path| ("CODEX_HOME", path.as_os_str())),
            )
            .stdin(Stdio::from(
                File::open(&retry_stdin_path).context("open compact retry prompt for stdin")?,
            ))
            .stdout(Stdio::from(
                File::create(&retry_stdout_log_path).context("create compact retry stdout.log")?,
            ))
            .stderr(Stdio::from(
                File::create(&retry_stderr_log_path).context("create compact retry stderr.log")?,
            ))
            .spawn()
            .with_context(|| {
                format!(
                    "failed to spawn compact retry agent runtime ({})",
                    runtime.as_str()
                )
            })?;
        let retry_pid = retry_child.id();
        let mut retry_metadata = json!({
            "pid": retry_pid,
            "started_at": now_iso(),
            "driver": match runtime {
                AgentRuntime::Codex => "codex-agent-executor",
                AgentRuntime::Claude => "claude-agent-executor",
            },
            "agent_runtime": runtime.as_str(),
            "sandbox_mode": execution_policy.sandbox_mode(runtime),
            "approvals_mode": execution_policy.approvals_mode(runtime),
            "approval_policy": if runtime == AgentRuntime::Codex { Some(execution_policy.approval_policy) } else { None },
            "timeout_seconds": timeout_seconds.min(600),
            "retry_of_pid": child_pid,
        });
        record_network_policy(&mut retry_metadata, &execution_policy, runtime);
        record_execution_venue(&mut retry_metadata, docker_scout.as_ref(), role_plan);
        write_process_metadata(paths, contract, "agent_compact_retry_running", retry_metadata)?;
        let retry_watch = wait_for_agent(
            &mut retry_child,
            retry_pid,
            &retry_stdout_log_path,
            &retry_stderr_log_path,
            Duration::from_secs(timeout_seconds.min(600)),
            paths,
            contract,
            "compact_context_retry",
            docker_scout.is_none(),
        )?;
        if let Some(scout) = docker_scout.as_ref() {
            scout.remove_container();
        }
        let retry_timed_out = retry_watch.timed_out;
        let retry_stalled = retry_watch.stalled;
        let retry_exit_status = retry_watch.exit_status;
        let _ = fs::remove_file(lane_process_path(
            paths,
            &contract.cycle_id,
            &contract.lane_id,
        ));
        let retry_stdout = fs::read_to_string(&retry_stdout_log_path).unwrap_or_default();
        let retry_stderr = fs::read_to_string(&retry_stderr_log_path).unwrap_or_default();
        if let Some(evidence) = retry_watch.setup_blocked {
            let pause_path = shared_pause_marker_path(paths, &contract.cycle_id);
            let termination_path =
                state_root(paths).join(format!("{}-termination-code.json", contract.cycle_id));
            return Ok((
                "blocked".to_string(),
                json!({
                    "status": "blocked",
                    "driver": driver_label,
                    "block_type": "windows_sandbox_setup",
                    "manual_resume_required": true,
                    "retryable": false,
                    "error": "Windows sandbox setup helper blocked compact context retry; resolve the prompt and explicitly resume.",
                    "evidence": evidence,
                    "pause_marker_path": pause_path,
                    "termination_code_path": termination_path,
                    "stdout": retry_stdout,
                    "stderr": retry_stderr,
                }),
                retry_stdout,
                retry_stderr,
                vec![retry_prompt_path.display().to_string()],
            ));
        }
        let retry_output_last_message = {
            let file_value =
                fs::read_to_string(&retry_output_last_message_path).unwrap_or_default();
            if !file_value.trim().is_empty() {
                file_value
            } else {
                match runtime {
                    AgentRuntime::Codex => extract_codex_last_message(&retry_stdout),
                    AgentRuntime::Claude => extract_claude_last_message(&retry_stdout),
                }
            }
        };
        let retry_success = retry_exit_status
            .as_ref()
            .map(|s| s.success())
            .unwrap_or(false);
        if retry_success || !retry_output_last_message.trim().is_empty() {
            compact_retry_succeeded = retry_success;
            timed_out = retry_timed_out;
            stalled = retry_stalled;
            exit_status = retry_exit_status;
            stdout = format!(
                "{}\n\n--- compact context retry stdout ---\n{}",
                excerpt_text(&stdout, 4000),
                retry_stdout
            );
            stderr = format!(
                "{}\n\n--- compact context retry stderr ---\n{}",
                excerpt_text(&stderr, 4000),
                retry_stderr
            );
            output_last_message = retry_output_last_message;
        } else {
            stdout = format!(
                "{}\n\n--- compact context retry stdout ---\n{}",
                stdout, retry_stdout
            );
            stderr = format!(
                "{}\n\n--- compact context retry stderr ---\n{}",
                stderr, retry_stderr
            );
        }
    }
    let exit_success = exit_status.as_ref().map(|s| s.success()).unwrap_or(false);
    let exit_code = exit_status.as_ref().and_then(|s| s.code());
    let transient_auth_failure =
        !timed_out && !exit_success && is_transient_codex_auth_failure(&stdout, &stderr);
    // Whether this run's login was revoked, recorded for the owner (and
    // cleared once a turn runs again); see codex_login.
    let login_revoked = super::codex_login::note_codex_login(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        codex_home.as_deref(),
        &stdout,
        &stderr,
    )
    .unwrap_or(false);
    let mut status = if !timed_out && exit_success {
        "completed"
    } else if transient_auth_failure {
        "prepared"
    } else {
        "failed"
    };
    let extracted_json = extract_first_json_object(&output_last_message)
        .or_else(|| extract_first_json_object(&stdout));
    let model_reported_execution_error = extracted_json
        .as_ref()
        .map(|payload| {
            payload.get("is_error").and_then(Value::as_bool) == Some(true)
                || payload.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
                || payload
                    .get("errors")
                    .and_then(Value::as_array)
                    .map(|items| !items.is_empty())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let model_reported_blocked = model_reported_blocked_status(extracted_json.as_ref());
    if status == "completed" && (model_reported_execution_error || model_reported_blocked) {
        status = "failed";
    }
    let mut payload = json!({
        "status": status,
        "driver": driver_label,
        "requested_agent_runtime": requested_runtime.as_str(),
        "agent_runtime": runtime.as_str(),
        "runtime_fallback_applied": requested_runtime != runtime,
        "returncode": exit_code,
        "timed_out": timed_out,
        "stalled_stream": stalled,
        "timeout_seconds": timeout_seconds,
        "prompt_path": prompt_path,
        "invocation_path": invocation_path,
        "output_last_message_path": output_last_message_path,
        "output_last_message": output_last_message,
        "extracted_json": extracted_json,
        "role_plan": role_plan.cloned(),
        "stdout": stdout,
        "stderr": stderr,
    });
    if model_reported_execution_error {
        payload["model_reported_execution_error"] = json!(true);
        payload["error"] = json!(
            "agent runtime returned an execution-error payload despite a successful process exit"
        );
    }
    if model_reported_blocked {
        payload["model_reported_blocked"] = json!(true);
        payload["retryable"] = json!(true);
        payload["error"] = json!(
            "agent reported status=blocked despite a successful process exit; lane reclassified as failed for recovery"
        );
    }
    if compact_retry_attempted {
        payload["compact_context_retry_attempted"] = json!(true);
        payload["compact_context_retry_succeeded"] = json!(compact_retry_succeeded);
    }
    if transient_auth_failure {
        payload["retryable"] = json!(true);
        payload["wait_for_auth_refresh"] = json!(true);
        payload["warning"] = json!("codex authentication expired; lane left prepared so the planner can resume after re-authentication");
        payload["retry_reason"] = json!("codex_auth_expired");
    }
    if login_revoked {
        payload["codex_login_required"] = json!(true);
        payload["warning"] = json!("the Codex login was revoked; the lane waits for the owner to sign in again");
    }
    let mut artifacts = vec![
        prompt_path.display().to_string(),
        invocation_path.display().to_string(),
        output_last_message_path.display().to_string(),
        output_schema_path.display().to_string(),
    ];
    if contract.role == "analyst" {
        let final_analysis_plan = crate::core::support::read_json(&crate::core::support::lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id)).ok();
        let action_type = final_analysis_plan
            .as_ref()
            .or(role_plan)
            .and_then(|plan| plan.get("action_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_post_run_interpretation =
            action_type == "runner_result_interpretation_followup";
        let has_post_run_report = extracted_json
            .as_ref()
            .and_then(|value| value.get("lab_director_validation_report"))
            .and_then(Value::as_object)
            .is_some_and(|report| !report.is_empty());
        let code_file_roots = super::codex_outputs::blueprint_code_file_roots(paths, root);
        if is_post_run_interpretation && has_post_run_report {
            // A post-run report is the terminal artifact for this Analyst lane;
            // materializing a fresh handoff here would restart the loop it just
            // adjudicated.
            status = "completed";
            payload["status"] = json!(status);
        } else if is_post_run_interpretation {
            status = "failed";
            payload["status"] = json!(status);
            payload["error"] = json!(
                "Analyst post-run interpretation missing lab_director_validation_report"
            );
        } else if let Some(mut handoff_payload) = analyst_handoff_payload(&output_last_message) {
            super::gate_review_binding::attach_analysis_contract(&mut handoff_payload, final_analysis_plan.as_ref().or(role_plan));
            super::codex_outputs::inline_blueprint_code_files(&mut handoff_payload, &code_file_roots);
            super::handoff_seal::seal_analyst_handoff(paths, &contract.cycle_id, &mut handoff_payload);
            let handoff_path = root.join("handoff-validation-plan.json");
            write_json(&handoff_path, &handoff_payload)?;
            if let Some(design_memo) = handoff_payload.get("analysis_design_memo") {
                let design_memo_path = root.join("analysis-design-memo.json");
                write_json(&design_memo_path, design_memo)?;
                payload["analysis_design_memo_path"] =
                    json!(design_memo_path.display().to_string());
                artifacts.push(design_memo_path.display().to_string());
            }
            payload["analyst_handoff"] = handoff_payload;
            payload["analyst_handoff_path"] = json!(handoff_path.display().to_string());
            artifacts.push(handoff_path.display().to_string());
        } else if let Some(mut handoff_payload) =
            synthesized_analyst_handoff(role_plan, &output_last_message)
        {
            super::gate_review_binding::attach_analysis_contract(&mut handoff_payload, final_analysis_plan.as_ref().or(role_plan));
            super::codex_outputs::inline_blueprint_code_files(&mut handoff_payload, &code_file_roots);
            super::handoff_seal::seal_analyst_handoff(paths, &contract.cycle_id, &mut handoff_payload);
            let handoff_path = root.join("handoff-validation-plan.json");
            write_json(&handoff_path, &handoff_payload)?;
            if let Some(design_memo) = handoff_payload.get("analysis_design_memo") {
                let design_memo_path = root.join("analysis-design-memo.json");
                write_json(&design_memo_path, design_memo)?;
                payload["analysis_design_memo_path"] =
                    json!(design_memo_path.display().to_string());
                artifacts.push(design_memo_path.display().to_string());
            }
            status = "completed";
            payload["status"] = json!(status);
            payload["analyst_handoff"] = handoff_payload;
            payload["analyst_handoff_path"] = json!(handoff_path.display().to_string());
            payload["degraded_handoff"] = json!(true);
            payload["warning"] = json!("analyst handoff synthesized from role plan because the model did not emit an executable contract");
            artifacts.push(handoff_path.display().to_string());
        } else {
            status = "failed";
            payload["status"] = json!(status);
            payload["error"] = json!("analyst output missing executable handoff_checks, validation_code_blueprints, or self_review contract");
        }
    } else if contract.role == "chronicle" && !output_last_message.trim().is_empty() {
        status = "completed";
        payload["status"] = json!(status);
        payload["chronicle_fallback"] =
            synthesized_chronicle_payload(role_plan, &output_last_message);
        payload["warning"] = json!("chronicle lane soft-completed from partial structured output after mixed-format model response");
    } else if contract.role == "author" && !output_last_message.trim().is_empty() {
        status = "completed";
        payload["status"] = json!(status);
        payload["author_fallback"] = synthesized_author_payload(role_plan, &output_last_message);
        payload["warning"] = json!("author lane soft-completed from partial output after codex timeout or shell snapshot failure");
    }

    // Gatekeeper-specific integrity check: an exit-0 Codex response with no
    // verdict and no last-message text is a *silent* failure, not a valid
    // review. Leaving it status=completed causes downstream aggregation to
    // treat "pending gate rubric" as a real scientific blocker, which
    // masquerades as a rejection and stalls the cycle without triggering
    // recovery. Reclassifying as status=failed makes the labdirector
    // recovery path spawn a retry lane.
    if is_gatekeeper_empty_output(
        &contract.role,
        status,
        extracted_json.as_ref(),
        &output_last_message,
    ) {
        status = "failed";
        payload["status"] = json!(status);
        payload["error"] = json!(
            "gatekeeper returned empty output with no verdict; reclassified as failed so recovery re-dispatches the review"
        );
        payload["gate_review_empty_output"] = json!(true);
    }

    if status != "completed" {
        if let Some(failure_category) =
            codex_failure_category(&stdout, &stderr, &output_last_message, timed_out)
        {
            if failure_category == "quota_exceeded" {
                // Stop the cycle, not just this lane. Emitting a "completed"
                // placeholder let the planner treat it as work done and spawn
                // the next follow-up, which also hit the limit: 40 empty
                // gatekeeper lanes in two minutes, each one a fabricated
                // artifact the cycle then had to reason about.
                record_provider_quota_block(paths, contract, &format!("{stdout}\n{stderr}"))?;
                let mut quota_payload = codex_degraded_payload(
                    contract,
                    &prompt_path,
                    &invocation_path,
                    role_plan,
                    &auth,
                    failure_category,
                    &stdout,
                    &stderr,
                    &output_last_message,
                );
                // Left runnable, not completed: the lane did no work, and after
                // the limit resets it should run for real rather than be skipped.
                status = "prepared";
                quota_payload["status"] = json!(status);
                quota_payload["retryable"] = json!(true);
                quota_payload["block_type"] = json!(PROVIDER_QUOTA_BLOCK);
                quota_payload["manual_resume_required"] = json!(true);
                quota_payload["reason"] = json!(
                    "codex usage quota exceeded; lane left prepared and the cycle paused until an explicit resume"
                );
                payload = quota_payload;
            } else if !preserve_failed_literature_scout(
                contract,
                role_plan,
                failure_category,
                &mut status,
                &mut payload,
            ) {
                status = if failure_category == "auth_refresh_wait" {
                    "prepared"
                } else {
                    "completed"
                };
                payload = codex_degraded_payload(
                    contract,
                    &prompt_path,
                    &invocation_path,
                    role_plan,
                    &auth,
                    failure_category,
                    &stdout,
                    &stderr,
                    &output_last_message,
                );
                if failure_category == "auth_refresh_wait" {
                    payload["status"] = json!(status);
                    payload["retryable"] = json!(true);
                    payload["wait_for_auth_refresh"] = json!(true);
                    payload["retry_reason"] = json!("codex_auth_expired");
                }
            }
            if status == "completed" && contract.role == "analyst" {
                if let Some(mut handoff_payload) =
                    synthesized_analyst_handoff(role_plan, &output_last_message)
                {
                    let final_analysis_plan = crate::core::support::read_json(&crate::core::support::lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id)).ok();
                    super::gate_review_binding::attach_analysis_contract(&mut handoff_payload, final_analysis_plan.as_ref().or(role_plan));
                    super::codex_outputs::inline_blueprint_code_files(
                        &mut handoff_payload,
                        &super::codex_outputs::blueprint_code_file_roots(paths, root),
                    );
                    super::handoff_seal::seal_analyst_handoff(
                        paths,
                        &contract.cycle_id,
                        &mut handoff_payload,
                    );
                    let handoff_path = root.join("handoff-validation-plan.json");
                    write_json(&handoff_path, &handoff_payload)?;
                    payload["analyst_handoff"] = handoff_payload;
                    payload["analyst_handoff_path"] = json!(handoff_path.display().to_string());
                    payload["warning"] =
                        json!("analyst handoff synthesized after codex context/quota failure");
                    artifacts.push(handoff_path.display().to_string());
                }
            } else if status == "completed" && contract.role == "author" {
                payload["author_fallback"] =
                    synthesized_author_payload(role_plan, &output_last_message);
            }
        }
    }

    // Chronicle-specific post-completion normalization. Chronicle is told
    // (policy.rs:277) to write the data-graph and literature-graph
    // directly from its LLM output, which means those files arrive with
    // whatever shape the model chose — and crucially, with no
    // ``vocabulary`` section because the model's bash tool just dumps a
    // JSON file rather than going through createDataGraph(). We round-
    // trip the artefacts here so the vocabulary auto-grows from the
    // observed ``node.type`` / ``edge.relation`` strings the model
    // actually emitted.
    if status == "completed" && contract.role == "chronicle" {
        normalize_chronicle_result_payload(&mut payload);
        let state_dir = paths.runtime_root.join("state");
        for filename in [
            format!("{}-data-graph.json", contract.cycle_id),
            format!("{}-literature-graph.json", contract.cycle_id),
        ] {
            let graph_path = state_dir.join(&filename);
            if graph_path.exists() {
                if let Err(err) = normalize_graph_vocabulary(&graph_path) {
                    payload["chronicle_normalization_warning"] =
                        json!(format!("could not normalize {filename}: {err}"));
                }
            }
        }
        match write_chronicle_decision_digest(paths, &contract.cycle_id) {
            Ok(digest_path) => {
                payload["chronicle_decision_digest_path"] =
                    json!(digest_path.display().to_string());
                artifacts.push(digest_path.display().to_string());
            }
            Err(err) => {
                payload["chronicle_decision_digest_warning"] =
                    json!(format!("could not write compact LabDirector digest: {err}"));
            }
        }
    }

    // Artifact-readiness gate for chronicle (must run AFTER the degraded-payload
    // promotion above): a chronicle lane that finished — whether genuinely
    // exit-0 OR degraded/timeout-promoted to "completed" — without its three
    // mandated KG bootstrap artifacts (literature_graph, data_graph,
    // trend_summary) is reclassified as failed so self-healing retries KG
    // generation before LabDirector hypothesis selection. Placing this here
    // (not before the `if status != "completed"` block) is the fix for the
    // ordering bug where a timed-out chronicle was promoted to "completed"
    // after the check and slipped through, leaving the whole cycle without a
    // data-graph and deadlocked at the scout->analyst handoff.
    if contract.role == "chronicle"
        && status == "completed"
        && !chronicle_required_artifacts_present(paths, &contract.cycle_id)
    {
        // Continuation: the dominant chronicle failure mode in constrained
        // environments is the model ending its turn (exit 0) right after
        // *announcing* it will write the graphs, leaving the files unwritten.
        // Rather than reclassify-and-retry the whole expensive lane from
        // scratch, give it a few focused "finish writing the files you said
        // you would" turns first. This emits real artifacts (no fabrication):
        // if the model still produces nothing, we fall through to the original
        // reclassify-as-failed path so self-healing still backstops it.
        let max_passes = chronicle_continuation_max_passes();
        let state_dir = state_root(paths);
        let mut continuation_passes = 0usize;
        while continuation_passes < max_passes
            && !chronicle_required_artifacts_present(paths, &contract.cycle_id)
        {
            continuation_passes += 1;
            let continuation_prompt = build_chronicle_continuation_prompt(
                contract,
                &state_dir,
                continuation_passes,
                &output_last_message,
            );
            match run_chronicle_continuation_attempt(
                paths,
                contract,
                root,
                &command,
                &setsid_path,
                runtime,
                assigned_model,
                &disabled_features,
                &config_overrides,
                &execution_policy,
                codex_home.as_deref(),
                output_schema.is_some(),
                &output_schema_path,
                timeout_seconds,
                continuation_passes,
                &continuation_prompt,
            ) {
                Ok((_cont_timed_out, _cont_exit_success, cont_stdout, cont_stderr, cont_last)) => {
                    stdout = format!(
                        "{}\n\n--- chronicle continuation #{} stdout ---\n{}",
                        excerpt_text(&stdout, 4000),
                        continuation_passes,
                        cont_stdout
                    );
                    stderr = format!(
                        "{}\n\n--- chronicle continuation #{} stderr ---\n{}",
                        excerpt_text(&stderr, 4000),
                        continuation_passes,
                        cont_stderr
                    );
                    if !cont_last.trim().is_empty() {
                        output_last_message = cont_last;
                    }
                }
                Err(err) => {
                    payload["chronicle_continuation_error"] = json!(format!(
                        "continuation attempt {continuation_passes} failed: {err}"
                    ));
                    break;
                }
            }
        }

        if chronicle_required_artifacts_present(paths, &contract.cycle_id) {
            // The continuation produced the missing artifacts: keep the lane
            // completed and re-run the same normalization the on-time path does.
            payload["chronicle_fallback"] =
                synthesized_chronicle_payload(role_plan, &output_last_message);
            normalize_chronicle_result_payload(&mut payload);
            for filename in [
                format!("{}-data-graph.json", contract.cycle_id),
                format!("{}-literature-graph.json", contract.cycle_id),
            ] {
                let graph_path = state_dir.join(&filename);
                if graph_path.exists() {
                    if let Err(err) = normalize_graph_vocabulary(&graph_path) {
                        payload["chronicle_normalization_warning"] =
                            json!(format!("could not normalize {filename}: {err}"));
                    }
                }
            }
            match write_chronicle_decision_digest(paths, &contract.cycle_id) {
                Ok(digest_path) => {
                    payload["chronicle_decision_digest_path"] =
                        json!(digest_path.display().to_string());
                    artifacts.push(digest_path.display().to_string());
                }
                Err(err) => {
                    payload["chronicle_decision_digest_warning"] =
                        json!(format!("could not write compact LabDirector digest: {err}"));
                }
            }
            payload["chronicle_continuation_passes"] = json!(continuation_passes);
            payload["warning"] = json!(
                "chronicle KG artifacts produced after continuation pass(es); the model had announced the graphs but ended its turn before writing them"
            );
        } else {
            status = "failed";
            payload["status"] = json!(status);
            payload["error"] = json!(
                "chronicle completed without literature_graph, data_graph, and trend_summary artifacts; reclassified as failed so KG generation is retried before LabDirector hypothesis selection"
            );
            payload["missing_chronicle_graph_artifacts"] = json!(true);
            payload["retryable"] = json!(true);
            if continuation_passes > 0 {
                payload["chronicle_continuation_passes"] = json!(continuation_passes);
            }
        }
    }

    // Literature completeness describes the model's research output. Do not
    // let it replace a CLI/runtime failure (for example, strict-config
    // rejection before the model starts) with a scientific-search failure.
    if should_enforce_literature_completion(status, timed_out, exit_success) {
        if let Some(literature_status) =
            super::literature_agent::enforce_literature_agent_completion(
                paths,
                contract,
                role_plan,
                &mut payload,
            )?
        {
            status = literature_status;
        }
    }
    record_execution_venue(&mut payload, docker_scout.as_ref(), role_plan);
    Ok((status.to_string(), payload, stdout, stderr, artifacts))
}

#[cfg(test)]
mod tests {
    use super::should_enforce_literature_completion;

    #[test]
    fn literature_completion_only_runs_after_successful_cli_completion() {
        assert!(should_enforce_literature_completion(
            "completed",
            false,
            true
        ));
        assert!(!should_enforce_literature_completion(
            "failed", false, false
        ));
        assert!(!should_enforce_literature_completion(
            "completed",
            true,
            false
        ));
        assert!(!should_enforce_literature_completion(
            "prepared", false, false
        ));
    }
}
