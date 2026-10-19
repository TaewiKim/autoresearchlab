use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::process::Command;
#[cfg(not(windows))]
use std::thread::sleep;
#[cfg(not(windows))]
use std::time::Duration;

use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{lane_process_path, write_json};

fn valid_process_stage(stage: &str) -> bool {
    matches!(
        stage,
        "launcher_spawned"
            | "lane_running"
            | "external_driver_running"
            | "agent_running"
            | "agent_compact_retry_running"
            | "chronicle_continuation_running"
    )
}

pub(crate) fn validate_process_metadata(stage: &str, metadata: &Value) -> Result<()> {
    if !valid_process_stage(stage) {
        bail!("invalid process stage: {stage}");
    }
    let actual_stage = metadata
        .get("stage")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("process metadata missing stage"))?;
    if actual_stage != stage {
        bail!("process metadata stage mismatch: expected {stage}, got {actual_stage}");
    }
    let pid = metadata
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("process metadata missing pid"))?;
    if pid == 0 {
        bail!("process metadata pid must be positive");
    }
    for key in ["cycle_id", "lane_id", "role", "runtime_class", "started_at"] {
        let value = metadata
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if value.is_empty() {
            bail!("process metadata for stage {stage} missing {key}");
        }
    }
    match stage {
        "launcher_spawned" => {
            if metadata.get("contract_path").is_none() {
                bail!("launcher process metadata missing contract_path");
            }
        }
        "external_driver_running" => {
            if metadata.get("driver").is_none() {
                bail!("external driver process metadata missing driver");
            }
        }
        "agent_running" | "agent_compact_retry_running" | "chronicle_continuation_running" => {
            let agent_runtime = metadata
                .get("agent_runtime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if agent_runtime.is_empty() {
                bail!("agent process metadata missing agent_runtime");
            }
        }
        "lane_running" => {}
        _ => unreachable!(),
    }
    Ok(())
}

pub(crate) fn process_metadata(
    contract: &LaneContract,
    stage: &str,
    mut extra: Value,
) -> Result<Value> {
    let Some(obj) = extra.as_object_mut() else {
        bail!("process metadata extra must be a JSON object");
    };
    obj.insert("stage".to_string(), json!(stage));
    obj.insert("cycle_id".to_string(), json!(contract.cycle_id));
    obj.insert("lane_id".to_string(), json!(contract.lane_id));
    obj.insert("role".to_string(), json!(contract.role));
    obj.insert("runtime_class".to_string(), json!(contract.runtime_class));
    let metadata = Value::Object(obj.clone());
    validate_process_metadata(stage, &metadata)?;
    Ok(metadata)
}

pub(crate) fn write_process_metadata(
    paths: &AppPaths,
    contract: &LaneContract,
    stage: &str,
    extra: Value,
) -> Result<()> {
    let metadata = process_metadata(contract, stage, extra)?;
    write_json(
        &lane_process_path(paths, &contract.cycle_id, &contract.lane_id),
        &metadata,
    )
}

/// A zombie is not alive.
///
/// `kill -0` succeeds for a defunct process: the pid entry survives until the
/// parent reaps it, and when the parent is gone too, nothing ever will. So a
/// lane whose agent died while its supervisor was being restarted reads as
/// RUNNING for the rest of the cycle, `orphaned-running` never fires, and the
/// dispatcher will not open a replacement lane because it can see one already
/// open. cycle-g-v89 sat like that for 38 minutes with the only role that could
/// clear its gate blockers permanently unavailable.
///
/// The process state settles it, and `ps` is the portable way to ask.
#[cfg(not(windows))]
fn process_state(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if state.is_empty() {
        None
    } else {
        Some(state)
    }
}

#[cfg(not(windows))]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // `ps` is the authority when it answers: a leading Z is a reaped-pending
    // corpse holding a pid, and nothing more.
    if let Some(state) = process_state(pid) {
        return !state.starts_with('Z');
    }
    // No `ps`, or it could not see the process: fall back to the signal probe,
    // which at least distinguishes "no such pid" from "exists".
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    if pid == 0 {
        return false;
    }
    // A process handle becomes signaled when the process exits. Query it
    // directly: spawning tasklist for every lane poll is needlessly expensive.
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) }; // SYNCHRONIZE
    if handle.is_null() {
        // Access denied is not evidence of death. Fail conservatively for
        // anything except ERROR_INVALID_PARAMETER (a nonexistent process).
        return unsafe { GetLastError() } != 87;
    }
    let state = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    state != 0 // WAIT_OBJECT_0 means exited; timeout or query failure is live.
}

#[cfg(windows)]
pub(crate) fn windows_system_command(relative_path: &str) -> Command {
    use std::os::windows::process::CommandExt;

    let system_root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(system_root.join("System32").join(relative_path));
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

pub(crate) fn runtime_class_supports_background(runtime_class: &str) -> bool {
    matches!(runtime_class, "external-driver" | "codex-agent")
}

#[cfg(not(windows))]
fn terminate_pid(pid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
    sleep(Duration::from_secs(1));
    if process_is_alive(pid) {
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status();
    }
}

/// This process's own process group, read from /proc so no libc binding is
/// needed. None when /proc is unavailable.
#[cfg(not(windows))]
fn own_process_group() -> Option<u32> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // "pid (comm) state ppid pgrp ..." -- comm may hold spaces and parens, so
    // read the fields after the LAST ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(2)?.parse().ok()
}

/// A group this harness must never signal: pid 0 (`kill -TERM -0` is "my own
/// process group"), this process, or the group this process belongs to.
///
/// MEASURED on cycle-a-20260919, 2026-09-28: the cycle container died
/// at 12:23:23 with exit 143 -- a SIGTERM from inside, one second after a scout
/// lane's 900-second timeout. The kill below was the sender: without `--`,
/// procps-ng's `kill` does not read `-<pid>` as a process group, and can land on
/// the caller's own. The orchestrator, run-plan and every lane not under setsid
/// share that group, so it takes the whole cycle down. `--` fixes the parse; this
/// guard is the second line, so no future mistake in how the pid is spelled can
/// signal this harness's own group again. The Windows branch has always refused
/// pid 0 and its own pid; this branch refused nothing.
#[cfg(not(windows))]
fn refuses_to_signal_group(pid: u32) -> bool {
    pid == 0 || pid == std::process::id() || own_process_group() == Some(pid)
}

#[cfg(not(windows))]
pub(crate) fn terminate_process_group(pid: u32) {
    if refuses_to_signal_group(pid) {
        eprintln!("[harness] refused to signal process group {pid}: it is this harness's own group");
        return;
    }
    // `--` is what makes `-<pid>` a process group. MEASURED 2026-09-28 against
    // procps-ng 4.0.4 (Ubuntu 24.04): without it, `kill -TERM -<pid>` parses the
    // number as more options, not as a group. For a pid of 409 it reported
    // success and signalled nothing -- the lane group was never killed -- and for
    // a pid of 10 it killed the CALLER. The orchestrator, run-plan and every
    // lane not under setsid share one process group, so on
    // cycle-a-20260919 a scout timing out at 12:23:22 took the whole
    // cycle down with SIGTERM one second later. With `--`, both small and large
    // pids kill exactly the target group and the caller survives.
    let _ = Command::new("kill")
        .args(["-TERM", "--"])
        .arg(format!("-{}", pid))
        .status();
    sleep(Duration::from_secs(1));
    if process_is_alive(pid) {
        let _ = Command::new("kill")
            .args(["-KILL", "--"])
            .arg(format!("-{}", pid))
            .status();
    }
    if process_is_alive(pid) {
        terminate_pid(pid);
    }
}

#[cfg(windows)]
pub(crate) fn terminate_process_group(pid: u32) {
    if pid == 0 || pid == std::process::id() || !process_is_alive(pid) {
        return;
    }
    // Windows has no POSIX process groups. Terminate the owned process tree;
    // callers using persisted PIDs must first pass the lane identity guard.
    let _ = windows_system_command("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::process::Stdio;
    use std::time::Duration;
    use wait_timeout::ChildExt;

    #[test]
    fn windows_process_liveness_distinguishes_current_and_missing_pid() {
        assert!(process_is_alive(std::process::id()));
        assert!(!process_is_alive(0));
        assert!(!process_is_alive(u32::MAX));
    }

    #[test]
    fn windows_owned_child_termination_is_observable() {
        let mut child = windows_system_command(r"WindowsPowerShell\v1.0\powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn owned test child");
        let pid = child.id();
        assert!(process_is_alive(pid));
        terminate_process_group(pid);
        let exited = child
            .wait_timeout(Duration::from_secs(5))
            .unwrap()
            .is_some();
        if !exited {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(exited, "owned child must exit after tree termination");
        assert!(!process_is_alive(pid));
    }
}

#[cfg(all(test, not(windows)))]
mod unix_group_guard_tests {
    use super::*;

    // `kill -TERM -0` signals the caller's own process group, which on the
    // cycle container is the orchestrator's. Neither 0 nor our own group nor our
    // own pid may ever be group-killed.
    #[test]
    fn the_harness_never_signals_its_own_group() {
        assert!(refuses_to_signal_group(0));
        assert!(refuses_to_signal_group(std::process::id()));
        let own = own_process_group().expect("/proc/self/stat is readable in tests");
        assert!(refuses_to_signal_group(own));
        // Calling it on our own group must return without signalling us: if it
        // did not, this test process would die here.
        terminate_process_group(own);
        terminate_process_group(0);
        // An unrelated, owned child in its own group is still terminated.
        let mut child = Command::new("setsid")
            .args(["sleep", "30"])
            .spawn()
            .expect("spawn setsid sleep");
        let pid = child.id();
        terminate_process_group(pid);
        let _ = child.wait();
        assert!(!process_is_alive(pid));
    }
}
