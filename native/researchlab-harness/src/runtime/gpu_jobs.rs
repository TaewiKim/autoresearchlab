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
pub(crate) fn run_gpu_job_request(paths: &AppPaths, cycle_id: &str, lane_id: &str, request_path: &Path) -> Result<Value> {
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
    write_json(
        &job_dir.join(format!("{id}.accepted.json")),
        &json!({"job_id": id, "accepted_at": started_at, "timeout_seconds": spec.timeout_seconds}),
    )?;

    let clock = Instant::now();
    let mut child = match Command::new(&bwrap)
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
                    if let Err(error) = run_gpu_job_request(&paths, &cycle_id, &lane_id, &request) {
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
        let result = run_gpu_job_request(&paths, cycle, lane, &request).unwrap();
        assert_eq!(result["status"], json!("rejected"));
        assert!(result["error"].as_str().unwrap().contains("argv"));
        assert!(job_dir.join("bad.result.json").is_file());
        assert!(pending_requests(&job_dir).is_empty(), "answered once");
        let ledger = fs::read_to_string(gpu_job_ledger_path(&paths, cycle)).unwrap();
        assert!(ledger.contains("\"rejected\""), "{ledger}");
    }
}
