//! GPU work for lanes whose sandbox cannot see the GPU.
//!
//! MEASURED ON cycle-a-20260919, 2026-11-10, in the cycle's container
//! (WSL2, GPU exposed as /dev/dxg, codex-cli 0.166.0):
//!
//! - outside any sandbox, `torch.cuda.is_available()` is True;
//! - inside a lane's Codex sandbox it is False. The sandbox is bubblewrap with a
//!   synthetic /dev, so the device node does not exist there, and no setting adds
//!   it: `writable_roots=["/dev/dxg"]` panics (it wants a directory) and
//!   `writable_roots=["/dev"]` fails in bwrap;
//! - `bwrap --ro-bind / / --dev-bind /dev /dev --unshare-net ... python` sees the
//!   GPU ("cuda True NVIDIA GeForce RTX 4060").
//!
//! So an engineer could install an environment and then only run it on the CPU:
//! followup-engineer-1256 recorded "NVML reported GPU access blocked by the
//! operating system", and a 500-episode diffusion-policy evaluation is many hours
//! that way. Seven weeks of directors read "no GPU" as a fact about the machine.
//!
//! The harness therefore runs GPU jobs for the lane. A lane writes a request into
//! its own `gpu-jobs/` directory (drivers/gpu/gpu_job.py does it and waits); the
//! broker, a thread of the process that supervises the lane and so outside the
//! lane's sandbox, runs the request in a sandbox of the harness's own and writes
//! the result back. That sandbox is not weaker than the lane's, only different:
//! the real /dev (the GPU), a read-only filesystem except the lane's own
//! directories, NO network at all (the lane's has an allowlist), none of the
//! harness's environment (it holds API keys), and the credential directories
//! masked. Every job is recorded with its command, exit code and time.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

use crate::core::model::AppPaths;
use crate::core::support::{lane_root, now_iso, read_json, state_root, write_json};

const DEFAULT_TIMEOUT_SECONDS: u64 = 3600;
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// GPU device nodes: WSL2's paravirtual adapter, and the native NVIDIA driver's.
const GPU_DEVICE_NODES: &[&str] = &["/dev/dxg", "/dev/nvidiactl", "/dev/nvidia0"];

fn env_flag_off(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

fn max_timeout_seconds() -> u64 {
    std::env::var("RESEARCHLAB_GPU_JOB_MAX_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(4 * 3600)
}

// --- yielding the GPU to other work ---------------------------------------------------
//
// OWNER DECISION 2026-11-11: "when other work is using the GPU, lower the
// priority". The machine is the owner's workstation; the GPU the cycle borrows is
// the one their other work runs on. A CUDA job has no priority the driver honours,
// so yielding means two things here: a job does not START while the GPU is in use
// by something else (it waits, and after a bound says so instead of running), and
// once started it runs at the lowest CPU and I/O priority.
//
// MEASURED in the cycle's container (WSL2, RTX 4060): idle, `nvidia-smi` reports
// 1-2 % utilisation and ~620 of 8151 MiB in use (the desktop). Per-process usage
// is not reported under WSL, so "other work" is read from the device totals
// before the job starts -- which is also why a job already running cannot tell
// its own load from a newcomer's and is not paused mid-run.

#[derive(Debug, Clone, Copy, PartialEq)]
struct GpuLoad {
    utilization_percent: u32,
    memory_used_mib: u64,
    memory_total_mib: u64,
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(default)
}

/// Sustained utilisation at or above this is another workload, not the desktop.
fn busy_utilization_percent() -> u32 {
    env_number("RESEARCHLAB_GPU_BUSY_UTIL_PERCENT", 20).min(100) as u32
}

/// Memory in use at or above this share of the card belongs to another workload.
fn busy_memory_percent() -> u64 {
    env_number("RESEARCHLAB_GPU_BUSY_MEMORY_PERCENT", 50).min(100)
}

/// How long a job waits for the GPU before it is handed back as not run.
fn busy_max_wait() -> Duration {
    Duration::from_secs(env_number("RESEARCHLAB_GPU_BUSY_MAX_WAIT_SECONDS", 1800))
}

/// The first GPU's line of `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total`.
fn parse_gpu_load(text: &str) -> Option<GpuLoad> {
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let mut fields = line.split(',').map(|field| field.trim().parse::<u64>());
    let utilization = fields.next()?.ok()?;
    let used = fields.next()?.ok()?;
    let total = fields.next()?.ok()?;
    Some(GpuLoad { utilization_percent: utilization.min(100) as u32, memory_used_mib: used, memory_total_mib: total })
}

fn sample_gpu_load() -> Option<GpuLoad> {
    let mut child = Command::new("nvidia-smi")
        .args(["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    match child.wait_timeout(Duration::from_secs(10)).ok()? {
        Some(status) if status.success() => {
            let mut text = String::new();
            std::io::Read::read_to_string(child.stdout.as_mut()?, &mut text).ok()?;
            parse_gpu_load(&text)
        }
        Some(_) => None,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Why these readings mean the GPU is in use by other work, or `None`.
///
/// Utilisation must hold across every reading: one spike is a window being
/// dragged. Memory is a level, so the latest reading decides.
fn gpu_busy_reason(samples: &[GpuLoad], utilization_limit: u32, memory_limit_percent: u64) -> Option<String> {
    let latest = samples.last()?;
    let sustained = samples.iter().map(|sample| sample.utilization_percent).min().unwrap_or(0);
    if sustained >= utilization_limit {
        return Some(format!(
            "the GPU is {sustained}% utilised by other work (limit {utilization_limit}%), {} of {} MiB in use",
            latest.memory_used_mib, latest.memory_total_mib
        ));
    }
    if latest.memory_total_mib > 0 && latest.memory_used_mib * 100 >= latest.memory_total_mib * memory_limit_percent {
        return Some(format!(
            "other work holds {} of {} MiB of GPU memory (limit {memory_limit_percent}%)",
            latest.memory_used_mib, latest.memory_total_mib
        ));
    }
    None
}

fn gpu_busy_now() -> (Option<GpuLoad>, Option<String>) {
    let mut samples = Vec::new();
    for round in 0..3 {
        match sample_gpu_load() {
            Some(sample) => samples.push(sample),
            // No reading is not a reason to hold a job: the gate needs evidence.
            None => return (None, None),
        }
        if round < 2 {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    (samples.last().copied(), gpu_busy_reason(&samples, busy_utilization_percent(), busy_memory_percent()))
}

/// Wait until the GPU is free of other work. `Ok` carries the wait and the last
/// reading; `Err` the reason it was still busy when the wait ran out or the lane
/// ended.
fn wait_for_free_gpu(
    max_wait: Duration,
    cancel: Option<&AtomicBool>,
    mut waiting: impl FnMut(&str, Duration),
) -> std::result::Result<(Duration, Option<GpuLoad>), String> {
    let started = Instant::now();
    loop {
        let (load, busy) = gpu_busy_now();
        let Some(reason) = busy else {
            return Ok((started.elapsed(), load));
        };
        if started.elapsed() >= max_wait {
            return Err(reason);
        }
        waiting(&reason, started.elapsed());
        let pause = Instant::now();
        while pause.elapsed() < Duration::from_secs(20) {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(format!("the lane ended while waiting: {reason}"));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// The lowest-priority way to start `program`: idle I/O class, nice 19.
fn low_priority_command(program: &Path) -> Command {
    let find = |name: &str| ["/usr/bin", "/bin", "/usr/local/bin"].iter().map(|dir| Path::new(dir).join(name)).find(|path| path.is_file());
    match (find("ionice"), find("nice")) {
        (Some(ionice), Some(nice)) => {
            let mut command = Command::new(ionice);
            command.args(["-c", "3"]).arg(nice).args(["-n", "19"]).arg(program);
            command
        }
        (None, Some(nice)) => {
            let mut command = Command::new(nice);
            command.args(["-n", "19"]).arg(program);
            command
        }
        _ => Command::new(program),
    }
}

fn bwrap_path() -> Option<PathBuf> {
    std::env::var("RESEARCHLAB_GPU_JOB_BWRAP")
        .ok()
        .map(PathBuf::from)
        .into_iter()
        .chain(["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].iter().map(PathBuf::from))
        .find(|path| path.is_file())
}

/// Why GPU jobs cannot run on this host, or `None` when they can.
pub(crate) fn gpu_jobs_unavailable_reason() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return Some("the GPU job sandbox is built on bubblewrap, which is Linux-only".to_string());
    }
    if env_flag_off("RESEARCHLAB_GPU_JOBS") {
        return Some("disabled by RESEARCHLAB_GPU_JOBS".to_string());
    }
    if bwrap_path().is_none() {
        return Some("bubblewrap (bwrap) is not installed".to_string());
    }
    if !GPU_DEVICE_NODES.iter().any(|node| Path::new(node).exists()) {
        return Some("no GPU device node (/dev/dxg, /dev/nvidiactl) on this host".to_string());
    }
    None
}

pub(crate) fn gpu_jobs_available() -> bool {
    gpu_jobs_unavailable_reason().is_none()
}

pub(crate) fn gpu_job_dir(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    lane_root(paths, cycle_id, lane_id).join("gpu-jobs")
}

fn gpu_job_ledger_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-gpu-jobs.jsonl"))
}

#[derive(Debug, Clone, PartialEq)]
struct JobSpec {
    id: String,
    argv: Vec<String>,
    timeout_seconds: u64,
    env: BTreeMap<String, String>,
}

fn valid_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && !id.starts_with('.')
}

fn valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// What a request must be before anything is run for it.
///
/// The sandbox is the boundary, not this check: whatever the argv names runs with
/// no network and no write access outside the lane. The check keeps a request
/// well-formed and its record honest (an absolute interpreter, a bounded time).
fn validate_request(id: &str, request: &Value) -> std::result::Result<JobSpec, String> {
    if !valid_job_id(id) {
        return Err("the job id may use letters, digits, '.', '_' and '-' only (at most 80)".to_string());
    }
    let argv: Vec<String> = request
        .get("argv")
        .and_then(Value::as_array)
        .ok_or("`argv` must be a list: the interpreter, then the script and its arguments")?
        .iter()
        .map(|item| item.as_str().map(ToString::to_string).ok_or("every `argv` entry must be a string"))
        .collect::<std::result::Result<_, _>>()?;
    if argv.is_empty() || argv.len() > 256 {
        return Err("`argv` must hold between 1 and 256 entries".to_string());
    }
    let program = Path::new(&argv[0]);
    if !program.is_absolute() || program.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err(format!("argv[0] must be an absolute path without '..': {}", argv[0]));
    }
    if !program.exists() {
        return Err(format!("argv[0] does not exist: {}", argv[0]));
    }
    let requested = request.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    if requested == 0 {
        return Err("`timeout_seconds` must be positive".to_string());
    }
    let mut env = BTreeMap::new();
    if let Some(entries) = request.get("env").and_then(Value::as_object) {
        for (key, value) in entries {
            let Some(value) = value.as_str() else {
                return Err(format!("env.{key} must be a string"));
            };
            if !valid_env_key(key) {
                return Err(format!("env key {key:?} is not a valid variable name"));
            }
            env.insert(key.clone(), value.to_string());
        }
    }
    Ok(JobSpec { id: id.to_string(), argv, timeout_seconds: requested.min(max_timeout_seconds()), env })
}

/// The directories a job may write: the lane's own, its artifact directory, and
/// the cycle's dataset directory (where a simulation order's episodes belong).
fn writable_dirs(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Vec<PathBuf> {
    let lane_dir = lane_root(paths, cycle_id, lane_id);
    let artifacts = paths.runtime_root.join("artifacts").join(cycle_id).join(lane_id);
    let _ = fs::create_dir_all(&artifacts);
    let mut dirs = vec![lane_dir, artifacts];
    let datasets = paths.runtime_root.join("datasets").join(cycle_id);
    if datasets.is_dir() {
        dirs.push(datasets);
    }
    dirs
}

/// Directories whose contents no job needs and no job gets.
fn masked_dirs(paths: &AppPaths) -> Vec<PathBuf> {
    let mut dirs = vec![paths.runtime_root.join("secrets")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".codex"));
        dirs.push(home.join(".claude"));
        dirs.push(home.join(".ssh"));
        dirs.push(home.join(".config").join("gh"));
    }
    dirs.retain(|dir| dir.is_dir());
    dirs
}

/// The bubblewrap arguments for one job, before the job's own argv.
fn sandbox_args(project_root: &Path, writable: &[PathBuf], masked: &[PathBuf], env: &BTreeMap<String, String>) -> Vec<String> {
    let text = |path: &Path| path.display().to_string();
    let mut args: Vec<String> = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc"]
        .iter()
        .map(ToString::to_string)
        .collect();
    // Everything readable, nothing writable ...
    args.extend(["--ro-bind".into(), "/".into(), "/".into()]);
    // ... the real devices, which is the point ...
    args.extend(["--dev-bind".into(), "/dev".into(), "/dev".into()]);
    args.extend(["--proc".into(), "/proc".into(), "--tmpfs".into(), "/tmp".into()]);
    for dir in masked {
        args.extend(["--tmpfs".into(), text(dir)]);
    }
    // ... and the lane's own directories to write in.
    for dir in writable {
        args.extend(["--bind".into(), text(dir), text(dir)]);
    }
    args.extend(["--chdir".into(), text(project_root), "--clearenv".into()]);
    let mut set = |key: &str, value: &str| args.extend(["--setenv".into(), key.to_string(), value.to_string()]);
    set("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    set("LANG", "C.UTF-8");
    if let Ok(home) = std::env::var("HOME") {
        set("HOME", &home);
    }
    // The filesystem is read-only: caches go to /tmp, bytecode is not written.
    set("PYTHONDONTWRITEBYTECODE", "1");
    set("PYTHONUNBUFFERED", "1");
    set("MPLCONFIGDIR", "/tmp/matplotlib");
    set("NUMBA_CACHE_DIR", "/tmp/numba");
    // There is no network: fail at once instead of waiting on a resolver.
    set("HF_HUB_OFFLINE", "1");
    set("TRANSFORMERS_OFFLINE", "1");
    set("RESEARCHLAB_GPU_JOB", "1");
    for (key, value) in env {
        set(key, value);
    }
    args.push("--".into());
    args
}

fn append_ledger(paths: &AppPaths, cycle_id: &str, record: &Value) {
    let path = gpu_job_ledger_path(paths, cycle_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{record}");
    }
}

fn tail_of(path: &Path, max_bytes: usize) -> String {
    let text = fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).to_string()).unwrap_or_default();
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

/// Run the request at `request_path` and write its result beside it.
pub(crate) fn run_gpu_job_request(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    request_path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<Value> {
    let job_dir = request_path.parent().context("a request file has a directory")?.to_path_buf();
    let id = request_path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".request.json"))
        .ok_or_else(|| anyhow!("a request file is named <id>.request.json"))?
        .to_string();
    let result_path = job_dir.join(format!("{id}.result.json"));
    let stdout_path = job_dir.join(format!("{id}.stdout.log"));
    let stderr_path = job_dir.join(format!("{id}.stderr.log"));
    let started_at = now_iso();
    let finish = |mut result: Value| -> Result<Value> {
        result["job_id"] = json!(id);
        result["lane_id"] = json!(lane_id);
        result["cycle_id"] = json!(cycle_id);
        result["started_at"] = json!(started_at);
        result["finished_at"] = json!(now_iso());
        write_json(&result_path, &result)?;
        append_ledger(paths, cycle_id, &result);
        Ok(result)
    };

    let request = match read_json(request_path) {
        Ok(request) => request,
        Err(error) => return finish(json!({"status": "rejected", "error": format!("the request is not readable JSON: {error}")})),
    };
    let spec = match validate_request(&id, &request) {
        Ok(spec) => spec,
        Err(reason) => return finish(json!({"status": "rejected", "error": reason, "argv": request.get("argv")})),
    };
    if let Some(reason) = gpu_jobs_unavailable_reason() {
        return finish(json!({"status": "rejected", "error": format!("GPU jobs cannot run here: {reason}"), "argv": spec.argv}));
    }
    let bwrap = bwrap_path().context("bwrap disappeared between the check and the launch")?;
    let writable = writable_dirs(paths, cycle_id, lane_id);
    let masked = masked_dirs(paths);
    let args = sandbox_args(&paths.project_root, &writable, &masked, &spec.env);
    let max_wait = busy_max_wait();
    let accepted_path = job_dir.join(format!("{id}.accepted.json"));
    let accepted = |state: &str| {
        let _ = write_json(
            &accepted_path,
            &json!({"job_id": id, "accepted_at": started_at, "timeout_seconds": spec.timeout_seconds,
                    "max_gpu_wait_seconds": max_wait.as_secs(), "state": state}),
        );
    };
    accepted("accepted");
    // Other work on the GPU goes first.
    let (gpu_wait, gpu_load) = match wait_for_free_gpu(max_wait, cancel, |reason, waited| {
        accepted(&format!("waiting {}s for the GPU: {reason}", waited.as_secs()));
    }) {
        Ok(ready) => ready,
        Err(reason) => {
            return finish(json!({
                "status": "gpu_busy",
                "error": format!("not run: {reason}. The GPU is shared with the owner's other work, which has priority; this job waited up to {}s for it. Try again later.", max_wait.as_secs()),
                "argv": spec.argv,
            }));
        }
    };
    accepted("running");

    let clock = Instant::now();
    let mut child = match low_priority_command(&bwrap)
        .args(&args)
        .args(&spec.argv)
        .stdin(Stdio::null())
        .stdout(Stdio::from(File::create(&stdout_path)?))
        .stderr(Stdio::from(File::create(&stderr_path)?))
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return finish(json!({"status": "failed", "error": format!("the sandbox could not be started: {error}"), "argv": spec.argv})),
    };
    let waited = child.wait_timeout(Duration::from_secs(spec.timeout_seconds))?;
    let (status, exit_code) = match waited {
        Some(exit) => (if exit.success() { "completed" } else { "failed" }, exit.code()),
        None => {
            // Killing bwrap takes its pid namespace, and so every process of the job.
            let _ = child.kill();
            let _ = child.wait();
            ("timeout", None)
        }
    };
    finish(json!({
        "status": status,
        "exit_code": exit_code,
        "elapsed_seconds": (clock.elapsed().as_millis() as f64) / 1000.0,
        "timeout_seconds": spec.timeout_seconds,
        "gpu_wait_seconds": gpu_wait.as_secs(),
        "gpu_before_start": gpu_load.map(|load| json!({
            "utilization_percent": load.utilization_percent,
            "memory_used_mib": load.memory_used_mib,
            "memory_total_mib": load.memory_total_mib,
        })),
        "priority": "started only once the GPU was not in use by other work; runs at nice 19 and idle I/O class",
        "argv": spec.argv,
        "env": spec.env,
        "stdout_path": stdout_path,
        "stderr_path": stderr_path,
        "stdout_tail": tail_of(&stdout_path, 4000),
        "stderr_tail": tail_of(&stderr_path, 4000),
        "sandbox": {
            "run_by": "the harness, outside the lane's sandbox",
            "gpu": "visible (the host's /dev is bound)",
            "network": "none",
            "filesystem": "read-only except the directories under `writable`",
            "writable": writable,
            "masked": masked,
            "environment": "cleared; only what `env` and the harness's fixed set name",
        },
    }))
}

/// Requests in `job_dir` that have no result yet, oldest first.
fn pending_requests(job_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(job_dir) else {
        return Vec::new();
    };
    let mut pending: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_name()?.to_str()?.strip_suffix(".request.json")?.to_string();
            if job_dir.join(format!("{id}.result.json")).exists() {
                return None;
            }
            let written = entry.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH);
            Some((written, path))
        })
        .collect();
    pending.sort();
    pending.into_iter().map(|(_, path)| path).collect()
}

/// Serves one lane's GPU job requests while the lane runs.
pub(crate) struct GpuJobBroker {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl GpuJobBroker {
    /// `None` when GPU jobs cannot run on this host; the reason is written to the
    /// lane's `gpu-jobs/UNAVAILABLE.txt` so a waiting client can say why.
    pub(crate) fn start(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Option<Self> {
        let job_dir = gpu_job_dir(paths, cycle_id, lane_id);
        let _ = fs::create_dir_all(&job_dir);
        let notice = job_dir.join("UNAVAILABLE.txt");
        if let Some(reason) = gpu_jobs_unavailable_reason() {
            let _ = fs::write(&notice, format!("{reason}\n"));
            return None;
        }
        let _ = fs::remove_file(&notice);
        let _ = write_json(&job_dir.join("broker.json"), &json!({"serving_since": now_iso(), "pid": std::process::id()}));
        let stop = Arc::new(AtomicBool::new(false));
        let (paths, cycle_id, lane_id, flag) = (paths.clone(), cycle_id.to_string(), lane_id.to_string(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                for request in pending_requests(&job_dir) {
                    if flag.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Err(error) = run_gpu_job_request(&paths, &cycle_id, &lane_id, &request, Some(flag.as_ref())) {
                        eprintln!("[researchlab-harness] GPU job {} failed to run: {error:#}", request.display());
                        // Never serve the same broken request twice.
                        let id = request.file_name().and_then(|name| name.to_str()).unwrap_or("job").trim_end_matches(".request.json").to_string();
                        let _ = write_json(&job_dir.join(format!("{id}.result.json")), &json!({"status": "failed", "error": format!("{error:#}")}));
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            let _ = fs::remove_file(job_dir.join("broker.json"));
        });
        Some(Self { stop, handle: Some(handle) })
    }
}

impl Drop for GpuJobBroker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // A job in flight belongs to a lane that has ended; it dies with this
        // process (--die-with-parent). Do not hold the lane's exit for it.
        if let Some(handle) = self.handle.take() {
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_program() -> String {
        std::env::current_exe().unwrap().display().to_string()
    }

    #[test]
    fn a_request_names_an_absolute_program_and_is_bounded() {
        let program = existing_program();
        let spec = validate_request("anchor-eval_01", &json!({"argv": [program, "eval.py", "--episodes", "50"], "timeout_seconds": 999_999_999u64, "env": {"CUDA_VISIBLE_DEVICES": "0"}})).unwrap();
        assert_eq!(spec.argv.len(), 4);
        assert_eq!(spec.timeout_seconds, max_timeout_seconds(), "a request cannot outlast the cap");
        assert_eq!(spec.env.get("CUDA_VISIBLE_DEVICES").map(String::as_str), Some("0"));
        assert_eq!(validate_request("j", &json!({"argv": [program]})).unwrap().timeout_seconds, DEFAULT_TIMEOUT_SECONDS);

        for (id, request, why) in [
            ("../escape", json!({"argv": [existing_program()]}), "an id is a file name"),
            ("j", json!({"argv": []}), "nothing to run"),
            ("j", json!({"argv": "python eval.py"}), "a shell line is not an argv"),
            ("j", json!({"argv": ["python", "eval.py"]}), "a relative program"),
            ("j", json!({"argv": ["/no/such/interpreter"]}), "a program that is not there"),
            ("j", json!({"argv": [existing_program()], "timeout_seconds": 0}), "no time"),
            ("j", json!({"argv": [existing_program()], "env": {"A B": "x"}}), "a malformed variable"),
            ("j", json!({"argv": [existing_program()], "env": {"A": 1}}), "a non-string value"),
        ] {
            assert!(validate_request(id, &request).is_err(), "{why}");
        }
    }

    #[test]
    fn the_sandbox_has_the_devices_no_network_and_none_of_the_harness_environment() {
        let env: BTreeMap<String, String> = [("OMP_NUM_THREADS".to_string(), "4".to_string())].into_iter().collect();
        let args = sandbox_args(
            Path::new("/work/researchlab"),
            &[PathBuf::from("/work/researchlab/.research-lab/lanes/c/followup-engineer-9")],
            &[PathBuf::from("/work/researchlab/.research-lab/secrets")],
            &env,
        );
        let has = |window: &[&str]| args.windows(window.len()).any(|slice| slice.iter().map(String::as_str).eq(window.iter().copied()));
        assert!(has(&["--dev-bind", "/dev", "/dev"]), "the GPU is a device: {args:?}");
        assert!(has(&["--ro-bind", "/", "/"]));
        assert!(args.contains(&"--unshare-net".to_string()), "no network");
        assert!(args.contains(&"--clearenv".to_string()), "the harness's environment holds API keys");
        assert!(args.contains(&"--die-with-parent".to_string()));
        assert!(has(&["--tmpfs", "/work/researchlab/.research-lab/secrets"]));
        assert!(has(&["--bind", "/work/researchlab/.research-lab/lanes/c/followup-engineer-9", "/work/researchlab/.research-lab/lanes/c/followup-engineer-9"]));
        assert!(has(&["--setenv", "OMP_NUM_THREADS", "4"]));
        // Masks and binds come after the read-only root, or they would be hidden by it.
        let position = |flag: &str, value: &str| args.windows(2).position(|pair| pair[0] == flag && pair[1] == value).unwrap();
        assert!(position("--ro-bind", "/") < position("--tmpfs", "/work/researchlab/.research-lab/secrets"));
        assert!(position("--ro-bind", "/") < position("--bind", "/work/researchlab/.research-lab/lanes/c/followup-engineer-9"));
        assert_eq!(args.last().map(String::as_str), Some("--"), "the job's argv follows");
    }

    // OWNER DECISION 2026-11-11: other work on the GPU goes first.
    #[test]
    fn a_gpu_in_use_by_other_work_is_busy_and_an_idle_desktop_is_not() {
        let load = |utilization_percent, memory_used_mib| GpuLoad { utilization_percent, memory_used_mib, memory_total_mib: 8151 };
        assert_eq!(parse_gpu_load("2, 624, 8151\n"), Some(load(2, 624)));
        assert_eq!(parse_gpu_load("\n97, 6100, 8151\n3, 10, 24000\n"), Some(load(97, 6100)), "the first GPU");
        assert_eq!(parse_gpu_load("[N/A], 624, 8151"), None);
        assert_eq!(parse_gpu_load(""), None);

        // The measured idle desktop: 1-2 %, ~620 MiB.
        assert_eq!(gpu_busy_reason(&[load(2, 624), load(1, 618), load(1, 615)], 20, 50), None);
        // One spike is not a workload ...
        assert_eq!(gpu_busy_reason(&[load(3, 700), load(85, 700), load(2, 700)], 20, 50), None);
        // ... sustained use is,
        let training = gpu_busy_reason(&[load(96, 3000), load(99, 3000), load(97, 3000)], 20, 50).unwrap();
        assert!(training.contains("96%"), "{training}");
        // and so is a model another process is holding, even while it idles.
        let held = gpu_busy_reason(&[load(0, 5200), load(0, 5200), load(0, 5200)], 20, 50).unwrap();
        assert!(held.contains("5200 of 8151"), "{held}");
        assert_eq!(gpu_busy_reason(&[], 20, 50), None, "no reading holds nothing");
    }

    #[test]
    fn a_job_is_started_at_the_lowest_priority_the_host_offers() {
        let command = low_priority_command(Path::new("/usr/bin/bwrap"));
        let line: Vec<String> = std::iter::once(command.get_program().to_string_lossy().to_string())
            .chain(command.get_args().map(|arg| arg.to_string_lossy().to_string()))
            .collect();
        assert_eq!(line.last().map(String::as_str), Some("/usr/bin/bwrap"), "{line:?}");
        if Path::new("/usr/bin/nice").is_file() {
            assert!(line.windows(2).any(|pair| pair[0] == "-n" && pair[1] == "19"), "{line:?}");
        }
    }

    #[test]
    fn a_host_that_cannot_run_gpu_jobs_says_why_in_the_lane() {
        let Some(reason) = gpu_jobs_unavailable_reason() else {
            return; // this host can: covered by the live probe, not here
        };
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        assert!(GpuJobBroker::start(&paths, "gpu", "followup-engineer-1").is_none());
        let notice = fs::read_to_string(gpu_job_dir(&paths, "gpu", "followup-engineer-1").join("UNAVAILABLE.txt")).unwrap();
        assert_eq!(notice.trim(), reason);
    }

    #[test]
    fn a_malformed_request_is_answered_and_recorded_not_run() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        let (cycle, lane) = ("gpu", "followup-engineer-1");
        let job_dir = gpu_job_dir(&paths, cycle, lane);
        fs::create_dir_all(&job_dir).unwrap();
        fs::create_dir_all(state_root(&paths)).unwrap();
        let request = job_dir.join("bad.request.json");
        write_json(&request, &json!({"argv": "python train.py"})).unwrap();
        assert_eq!(pending_requests(&job_dir), vec![request.clone()]);
        let result = run_gpu_job_request(&paths, cycle, lane, &request, None).unwrap();
        assert_eq!(result["status"], json!("rejected"));
        assert!(result["error"].as_str().unwrap().contains("argv"));
        assert!(job_dir.join("bad.result.json").is_file());
        assert!(pending_requests(&job_dir).is_empty(), "answered once");
        let ledger = fs::read_to_string(gpu_job_ledger_path(&paths, cycle)).unwrap();
        assert!(ledger.contains("\"rejected\""), "{ledger}");
    }
}
