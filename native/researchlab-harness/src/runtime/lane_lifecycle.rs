use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime};

use super::process::{process_is_alive, terminate_process_group, write_process_metadata};
use super::queue::{
    rebuild_contract_index, update_sqlite_contract_queue_status, upsert_contract_index,
    upsert_contract_queue,
};
use crate::chronicle::aggregate_cycle;
use crate::chronicle::reporting::append_event;
use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{
    events_root, external_artifacts_root, lane_process_path, lane_root, now_iso, read_json,
    write_json,
};

pub fn create_lane_contract(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    role: &str,
    runtime_class: &str,
    mode: &str,
    task_markdown: &str,
) -> Result<PathBuf> {
    // An external Analyst invokes the literature driver, not numeric analysis.
    // It cannot perform mandatory abstract review or author a reasoned handoff.
    // Normalize all specialized dispatchers to the generic Analyst architecture;
    // deterministic numeric execution remains on external-driver LabRunners.
    let (runtime_class, mode) = if role == "analyst" && runtime_class == "external-driver" {
        ("codex-agent", "read-write-scoped")
    } else {
        (runtime_class, mode)
    };
    let root = lane_root(paths, cycle_id, lane_id);
    fs::create_dir_all(&root)?;
    let task_file = root.join("task.md");
    fs::write(&task_file, task_markdown)?;

    let output_artifact = if runtime_class == "external-driver" {
        Some(external_artifacts_root(paths, cycle_id, lane_id).join("result.json"))
    } else {
        Some(root.join("result.json"))
    };

    let allowed_outputs = if runtime_class == "external-driver" {
        vec![external_artifacts_root(paths, cycle_id, lane_id)]
    } else {
        vec![root.clone()]
    };

    let contract = LaneContract {
        cycle_id: cycle_id.to_string(),
        lane_id: lane_id.to_string(),
        role: role.to_string(),
        runtime_class: runtime_class.to_string(),
        mode: mode.to_string(),
        cwd: paths.project_root.clone(),
        task_file,
        allowed_inputs: vec![],
        allowed_outputs,
        output_artifact,
        fallback_strategy: None,
    };

    let contract_path = root.join("lane-contract.json");
    write_json(&contract_path, &serde_json::to_value(&contract)?)?;
    upsert_contract_index(paths, cycle_id, &contract_path)
        .or_else(|_| rebuild_contract_index(paths, cycle_id).map(|_| ()))?;
    upsert_contract_queue(
        paths,
        cycle_id,
        &contract_path,
        lane_id,
        role,
        runtime_class,
        mode,
    )?;
    Ok(contract_path)
}

pub fn make_demo_contract(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    runtime_class: &str,
    role: &str,
    mode: &str,
) -> Result<PathBuf> {
    create_lane_contract(
        paths,
        cycle_id,
        lane_id,
        role,
        runtime_class,
        mode,
        &format!(
            "# Lane Task\n\n- cycle_id: {cycle_id}\n- role: {role}\n- task: run the assigned research workload and report through Chronicle\n"
        ),
    )
}

pub fn create_prompt_seed_contract(
    paths: &AppPaths,
    cycle_id: &str,
    prompt: &str,
) -> Result<PathBuf> {
    create_lane_contract(
        paths,
        cycle_id,
        "prompt-seed-01",
        "lab-runner",
        "external-driver",
        "driver-exec",
        &format!(
            "# Prompt Seed Task\n\n- cycle_id: {cycle_id}\n- role: lab-runner\n- user_prompt: {prompt}\n- task: analyze the user prompt directly and emit the first Chronicle-ready result\n"
        ),
    )
}

pub fn lane_status(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Result<Value> {
    let root = lane_root(paths, cycle_id, lane_id);
    let run_state_path = root.join("run-state.json");
    let final_status_path = root.join("final-status.json");
    let process_path = lane_process_path(paths, cycle_id, lane_id);
    Ok(json!({
        "cycle_id": cycle_id,
        "lane_id": lane_id,
        "run_state": if run_state_path.exists() { read_json(&run_state_path)? } else { json!(null) },
        "final_status": if final_status_path.exists() { read_json(&final_status_path)? } else { json!(null) },
        "process": if process_path.exists() { read_json(&process_path)? } else { json!(null) },
    }))
}

fn best_effort_refresh_cycle_outputs(paths: &AppPaths, cycle_id: &str) -> bool {
    let cli_path = paths.project_root.join("src").join("cli").join("index.js");
    if !cli_path.exists() {
        return false;
    }
    let lock_dir = paths.runtime_root.join("state");
    let _ = fs::create_dir_all(&lock_dir);
    let lock_path = lock_dir.join(format!("{cycle_id}-refresh-cycle.lock"));
    let mut lock_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(_) => {
            let stale = refresh_lock_owner_inactive(&lock_path)
                || fs::metadata(&lock_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .map(|age| age > Duration::from_secs(900))
                    .unwrap_or(false);
            if stale {
                let _ = fs::remove_file(&lock_path);
                match OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&lock_path)
                {
                    Ok(file) => file,
                    Err(_) => return false,
                }
            } else {
                return false;
            }
        }
    };
    let _ = writeln!(lock_file, "pid={}", std::process::id());
    let _ = writeln!(lock_file, "cycle_id={cycle_id}");
    let _ = writeln!(lock_file, "created_at={}", crate::core::support::now_iso());

    let refresh_timeout_seconds = env::var("RESEARCHLAB_LANE_REFRESH_TIMEOUT_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(180);
    let mut refresh_command = Command::new("node");
    #[cfg(windows)]
    refresh_command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = match refresh_command
        .arg(&cli_path)
        .arg("refresh-cycle")
        .arg("--cycle-id")
        .arg(cycle_id)
        .current_dir(&paths.project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            let _ = fs::remove_file(&lock_path);
            return false;
        }
    };
    let mut completed = false;
    let deadline = Instant::now() + Duration::from_secs(refresh_timeout_seconds);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                completed = status.success();
                break;
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                wait_for_child_exit_after_kill(&mut child, Duration::from_secs(5));
                break;
            }
            Ok(None) => sleep(Duration::from_millis(250)),
            Err(_) => break,
        }
    }
    let _ = fs::remove_file(&lock_path);
    completed
}

fn wait_for_child_exit_after_kill(child: &mut Child, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() >= deadline => return false,
            Ok(None) => sleep(Duration::from_millis(100)),
            Err(_) => return false,
        }
    }
}

fn refresh_lock_owner_inactive(lock_path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(lock_path) else {
        return false;
    };
    let Some(pid) = raw.lines().find_map(|line| {
        line.strip_prefix("pid=")
            .and_then(|value| value.trim().parse::<u32>().ok())
    }) else {
        return false;
    };
    if pid == 0 || !process_is_alive(pid) {
        return true;
    }
    let proc_stat = PathBuf::from(format!("/proc/{pid}/stat"));
    let Ok(stat) = fs::read_to_string(proc_stat) else {
        return false;
    };
    stat.rsplit_once(") ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .map(|state| state == "Z")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_pid_guard_rejects_unrelated_and_empty_cmdlines() {
        // A recycled pid belonging to an innocent process must NOT be killed.
        assert!(!cmdline_plausibly_lane(
            "bash /work/some_supervisor.sh",
            "cycle-cv-v1",
            "followup-runner-06"
        ));
        assert!(!cmdline_plausibly_lane(
            "sleep infinity",
            "cycle-cv-v1",
            "lane-01"
        ));
        // Kernel threads / zombies read back as empty cmdlines.
        assert!(!cmdline_plausibly_lane("", "cycle-cv-v1", "lane-01"));
        assert!(!cmdline_plausibly_lane("   ", "cycle-cv-v1", "lane-01"));
    }

    #[test]
    fn stale_pid_guard_accepts_genuine_lane_runtimes() {
        // codex CLI lane
        assert!(cmdline_plausibly_lane(
            "codex exec --skip-git-repo-check some prompt",
            "cycle-cv-v1",
            "followup-runner-06"
        ));
        // python external driver referencing the cycle's dataset path
        assert!(cmdline_plausibly_lane(
            "python3 drivers/analysis/python_stats.py --csv-root /work/researchlab/.research-lab/datasets/cycle-cv-v1/x/csv",
            "cycle-cv-v1",
            "lab-runner-02"
        ));
        // process carrying the lane id itself
        assert!(cmdline_plausibly_lane(
            "bash /tmp/launch-followup-runner-06.sh",
            "cycle-cv-v1",
            "followup-runner-06"
        ));
    }

    #[test]
    fn killed_refresh_child_wait_is_bounded() {
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = super::super::process::windows_system_command(
                r"WindowsPowerShell\v1.0\powershell.exe",
            );
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ]);
            command
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child");
        child.kill().expect("kill test child");
        assert!(wait_for_child_exit_after_kill(
            &mut child,
            Duration::from_secs(2)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_pid_guard_checks_owned_child_command_line() {
        let mut child = super::super::process::windows_system_command(
            r"WindowsPowerShell\v1.0\powershell.exe",
        )
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30 # cycle-windows-identity-check lane-windows-identity-check",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn owned identity test child");
        let pid = child.id();
        let matching = pid_cmdline_matches_lane(
            pid,
            "cycle-windows-identity-check",
            "lane-windows-identity-check",
        );
        let unrelated = pid_cmdline_matches_lane(pid, "unrelated-cycle", "unrelated-lane");
        // Always clean up our own handle, even when identity lookup failed.
        child.kill().expect("kill owned identity test child");
        child.wait().expect("reap owned identity test child");
        assert!(
            matching,
            "the process command line must expose its lane identity"
        );
        assert!(!unrelated, "an unrelated lane must not match this process");
        assert!(!pid_cmdline_matches_lane(u32::MAX, "cycle", "lane"));
    }

    /// Needs Docker and the scout image; skips (passes) without them.
    #[test]
    fn aborting_a_docker_scout_removes_its_container_after_the_client_is_gone() {
        let image = "researchlab:local";
        let have_image = Command::new("docker")
            .args(["image", "inspect", image])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !have_image {
            eprintln!("skipping: docker image {image} not available");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            project_root: temp.path().join("project"),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: temp.path().join("stats.py"),
            literature_driver_script: temp.path().join("literature.py"),
        };
        let (cycle_id, lane_id) = ("abort-docker-test", "followup-scout-01");
        let name = super::super::docker_scout::container_name(cycle_id, lane_id);
        super::super::docker_scout::remove_docker_container(&name);
        let started = Command::new("docker")
            .args(["run", "-d", "--name", &name, "--entrypoint", "sleep", image, "300"])
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(started.success());
        // The host `docker` client is already gone: the pid is dead.
        fs::create_dir_all(lane_root(&paths, cycle_id, lane_id)).unwrap();
        fs::write(
            lane_process_path(&paths, cycle_id, lane_id),
            json!({"pid": u32::MAX, "execution_venue": "docker"}).to_string(),
        )
        .unwrap();

        let result = abort_lane(&paths, cycle_id, lane_id).unwrap();
        let still_there = Command::new("docker")
            .args(["container", "inspect", &name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        super::super::docker_scout::remove_docker_container(&name);
        assert_eq!(result["docker_container"], json!(name));
        assert!(!still_there, "an aborted Docker scout left its container running");
    }

    #[test]
    fn analyst_completion_triggers_gate_refresh_policy() {
        assert!(should_refresh_gate_after_lane_completion(
            "analyst",
            "completed"
        ));
        assert!(!should_refresh_gate_after_lane_completion(
            "lab-runner",
            "completed"
        ));
        assert!(!should_refresh_gate_after_lane_completion(
            "analyst", "failed"
        ));
    }

    #[test]
    fn permission_denied_abort_write_errors_are_structured() {
        let mut errors = Vec::new();
        record_permission_write_error(
            &mut errors,
            Path::new("/tmp/researchlab/lane/run-state.json"),
            anyhow!(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "blocked"
            )),
        )
        .expect("permission errors should be reportable");

        assert_eq!(errors.len(), 1);
        assert_eq!(
            errors[0].get("permission_denied").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            errors[0].get("path").and_then(Value::as_str),
            Some("/tmp/researchlab/lane/run-state.json")
        );
    }

    #[test]
    fn non_permission_abort_write_errors_still_fail() {
        let mut errors = Vec::new();
        let err = record_permission_write_error(
            &mut errors,
            Path::new("/tmp/researchlab/lane/run-state.json"),
            anyhow!(std::io::Error::new(std::io::ErrorKind::Other, "disk lost")),
        )
        .expect_err("non-permission errors should still fail");

        assert!(errors.is_empty());
        assert!(err.to_string().contains("disk lost"));
    }
}

pub(crate) fn best_effort_reconcile_cycle(paths: &AppPaths, cycle_id: &str) {
    let _ = aggregate_cycle(paths, cycle_id);
    if crate::labdirector::running_lane_count(paths, cycle_id).unwrap_or(1) == 0 {
        let _ = best_effort_refresh_cycle_outputs(paths, cycle_id);
        let _ = aggregate_cycle(paths, cycle_id);
    }
}

pub(crate) fn should_refresh_gate_after_lane_completion(role: &str, status: &str) -> bool {
    role == "analyst" && status == "completed"
}

pub(crate) fn best_effort_refresh_after_analyst_report(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
) {
    let refreshed = best_effort_refresh_cycle_outputs(paths, cycle_id);
    let _ = append_event(
        &events_root(paths).join(format!("{cycle_id}-cycle-events.jsonl")),
        "analyst_report_gate_review_refresh",
        json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "refresh_cycle_invoked": refreshed,
            "refresh_target": "gate/conclusion/approval reviews",
            "reason": "analyst report completed; LabDirector gate review must not remain stale",
        }),
    );
}

pub fn launch_lane_background(paths: &AppPaths, contract_path: &Path) -> Result<Value> {
    let contract: LaneContract = serde_json::from_value(read_json(contract_path)?)?;
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    fs::create_dir_all(&lane_dir)?;
    let stdout_path = lane_dir.join("launcher.stdout.log");
    let stderr_path = lane_dir.join("launcher.stderr.log");
    let stdout_file = File::create(&stdout_path)?;
    let stderr_file = File::create(&stderr_path)?;
    let current_exe = env::current_exe().context("failed to resolve current executable")?;
    let setsid_path = PathBuf::from("/usr/bin/setsid");
    let mut command = if setsid_path.exists() {
        let mut command = Command::new(&setsid_path);
        command.arg(&current_exe);
        command
    } else {
        Command::new(&current_exe)
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let child = command
        .arg("run-lane")
        .arg(contract_path)
        .current_dir(&paths.project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .context("failed to spawn background lane worker")?;

    write_process_metadata(
        paths,
        &contract,
        "launcher_spawned",
        json!({
            "pid": child.id(),
            "started_at": now_iso(),
            "launcher": "researchlab-harness",
            "detached": setsid_path.exists(),
            "contract_path": contract_path,
        }),
    )?;
    update_sqlite_contract_queue_status(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
        "spawned",
        None,
    )?;
    append_event(
        &lane_dir.join("events.jsonl"),
        "lane_spawned",
        json!({
            "lane_id": contract.lane_id,
            "pid": child.id(),
        }),
    )?;
    Ok(json!({
        "lane_id": contract.lane_id,
        "status": "spawned",
        "pid": child.id(),
        "contract_path": contract_path,
    }))
}

// Pure identity predicate for the stale-pid guard in `abort_lane`. A lane's
// runtime processes are the codex CLI, an external python driver, or a node
// shim — all of which carry the lane id, the cycle id, or a recognizable
// runtime marker in their command line. A recycled pid (arbitrary unrelated
// process, or an empty cmdline for a kernel thread/zombie) matches none.
pub(crate) fn cmdline_plausibly_lane(cmdline: &str, cycle_id: &str, lane_id: &str) -> bool {
    if cmdline.trim().is_empty() {
        return false;
    }
    let lowered = cmdline.to_lowercase();
    lowered.contains(&lane_id.to_lowercase())
        || lowered.contains(&cycle_id.to_lowercase())
        || lowered.contains("codex")
        || lowered.contains("researchlab")
}

#[cfg(not(windows))]
fn pid_cmdline_matches_lane(pid: u32, cycle_id: &str, lane_id: &str) -> bool {
    let raw = match fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(bytes) => bytes,
        Err(_) => return false, // process gone: nothing to kill
    };
    let cmdline = String::from_utf8_lossy(&raw).replace('\0', " ");
    cmdline_plausibly_lane(&cmdline, cycle_id, lane_id)
}

#[cfg(windows)]
fn pid_cmdline_matches_lane(pid: u32, cycle_id: &str, lane_id: &str) -> bool {
    if pid == 0 || !process_is_alive(pid) {
        return false;
    }
    // CIM exposes the real command line, including Python/Node lane arguments.
    // An executable name alone cannot distinguish unrelated interpreter jobs.
    // Only a numeric PID enters the command; cycle/lane text stays in Rust.
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
         Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = {pid}' \
         -OperationTimeoutSec 5 -ErrorAction Stop | Select-Object -ExpandProperty CommandLine"
    );
    let output = super::process::windows_system_command(r"WindowsPowerShell\v1.0\powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    cmdline_plausibly_lane(&String::from_utf8_lossy(&output.stdout), cycle_id, lane_id)
}

pub fn abort_lane(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Result<Value> {
    let process_path = lane_process_path(paths, cycle_id, lane_id);
    let root = lane_root(paths, cycle_id, lane_id);
    let events_path = root.join("events.jsonl");
    let final_status_path = root.join("final-status.json");
    let run_state_path = root.join("run-state.json");

    if final_status_path.exists() {
        let final_status = read_json(&final_status_path).unwrap_or_else(|_| json!({}));
        if matches!(
            final_status.get("status").and_then(Value::as_str),
            Some("completed") | Some("failed") | Some("prepared")
        ) {
            let _ = fs::remove_file(&process_path);
            return Ok(json!({
                "cycle_id": cycle_id,
                "lane_id": lane_id,
                "aborted": false,
                "reason": "lane already finalized",
                "final_status": final_status,
            }));
        }
    }

    if !process_path.exists() {
        return Ok(json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "aborted": false,
            "reason": "no live process metadata found",
        }));
    }

    let process = read_json(&process_path)?;
    let pid = process
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("process metadata missing pid"))?;
    // Identity check before killing: the persisted pid can be STALE — written by
    // an earlier boot of the container, after which the pid namespace reset and
    // the number was recycled by an unrelated process. Blindly signalling the
    // group then TERMs an innocent bystander (observed: every run-plan startup
    // group-killed its own supervisor session via a recycled pid, a ~2-minute
    // kill loop that survived container restarts because the stale metadata
    // lives on disk). Only kill when /proc/<pid>/cmdline plausibly belongs to
    // this lane's runtime; otherwise treat the metadata as stale and just clean
    // it up — the lane's real process is long gone.
    if pid_cmdline_matches_lane(pid as u32, cycle_id, lane_id) {
        terminate_process_group(pid as u32);
    }
    // A Docker scout's pid is the host `docker` client; killing it leaves the
    // container running. Remove it even when the client is already gone.
    let docker_container =
        super::docker_scout::lane_docker_container(&process, cycle_id, lane_id);
    if let Some(name) = docker_container.as_deref() {
        super::docker_scout::remove_docker_container(name);
    }

    let mut write_errors = Vec::new();
    let run_state = json!({
        "lane_id": lane_id,
        "status": "aborted",
        "updated_at": now_iso(),
        "reason": "terminated by orchestrator",
    });
    if let Err(err) = write_json(&run_state_path, &run_state) {
        record_permission_write_error(&mut write_errors, &run_state_path, err)?;
    }
    let final_status = json!({
        "lane_id": lane_id,
        "status": "aborted",
        "completed_at": now_iso(),
        "reason": "terminated by orchestrator",
    });
    if let Err(err) = write_json(&final_status_path, &final_status) {
        record_permission_write_error(&mut write_errors, &final_status_path, err)?;
    }
    let process_metadata_removed = fs::remove_file(&process_path).is_ok();
    if let Err(err) = append_event(
        &events_path,
        "lane_aborted",
        json!({
            "lane_id": lane_id,
            "pid": pid,
            "reason": "terminated by orchestrator",
            "docker_container": docker_container,
        }),
    ) {
        record_permission_write_error(&mut write_errors, &events_path, err)?;
    }

    if !write_errors.is_empty() {
        return Ok(json!({
            "cycle_id": cycle_id,
            "lane_id": lane_id,
            "aborted": true,
            "finalized": false,
            "pid": pid,
            "reason": "lane_state_write_permission_denied_after_terminate",
            "permission_blocker": true,
            "process_metadata_removed": process_metadata_removed,
            "write_errors": write_errors,
        }));
    }

    Ok(json!({
        "cycle_id": cycle_id,
        "lane_id": lane_id,
        "aborted": true,
        "pid": pid,
        "docker_container": docker_container,
        "process_metadata_removed": process_metadata_removed,
    }))
}

fn record_permission_write_error(
    write_errors: &mut Vec<Value>,
    path: &Path,
    err: anyhow::Error,
) -> Result<()> {
    let permission_denied = error_is_permission_denied(&err);
    let message = err.to_string();
    if !permission_denied {
        return Err(err);
    }
    write_errors.push(json!({
        "path": path.display().to_string(),
        "error": message,
        "permission_denied": true,
    }));
    Ok(())
}

fn error_is_permission_denied(err: &anyhow::Error) -> bool {
    if err
        .downcast_ref::<std::io::Error>()
        .map(|io| io.kind() == ErrorKind::PermissionDenied)
        .unwrap_or(false)
    {
        return true;
    }
    err.chain().any(|cause| {
        let message = cause.to_string();
        message.contains("Permission denied") || message.contains("os error 13")
    })
}
