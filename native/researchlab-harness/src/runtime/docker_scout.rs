//! Literature scouts run their Codex inside a Linux container.
//!
//! cycle-b-20260918, 2026-09-18: the desktop app's Codex rewrote the
//! shared Windows sandbox firewall rules; scouts moved to Docker. Every Codex
//! on a Windows host shares one elevated sandbox (fixed accounts, globally named
//! firewall rules), and the desktop app keeps resetting the proxy exceptions
//! the scholarly network profile needs, so a scout lost its network mid-search.
//! Inside the image Codex uses bubblewrap and its own allowlist proxy and never
//! touches the Windows sandbox. Only scouts need the network, so only they move.
//!
//! 2026-09-22, the owner: run the whole cycle in the container, not only the
//! scouts. The desktop app kept halting the cycle from outside it, and a venue
//! that only one role uses leaves every other role exposed to the same host.
//!
//! Opt-in, widest first: `RESEARCHLAB_DOCKER_IMAGE` puts EVERY codex lane in the
//! container; `RESEARCHLAB_SCOUT_DOCKER_IMAGE` still names an image for scouts
//! alone and overrides it for that role. `RESEARCHLAB_DOCKER_MOUNT` (or the
//! older `RESEARCHLAB_SCOUT_DOCKER_MOUNT`) names the host directory mounted at
//! `/work`, default the parent of the project root, and
//! `RESEARCHLAB_DOCKER_EXTRA_MOUNTS` adds the trees that live outside it --
//! reference repositories, simulator environments -- as `host=container` pairs
//! separated by `;`. `RESEARCHLAB_DOCKER_GPUS` is passed to `docker run --gpus`.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::core::model::{AppPaths, LaneContract};

pub(crate) const CONTAINER_ROOT: &str = "/work";
const CONTAINER_AUTH_PATH: &str = "/root/.codex/auth.json";
const SCOUT_IMAGE_ENV: &str = "RESEARCHLAB_SCOUT_DOCKER_IMAGE";
const IMAGE_ENV: &str = "RESEARCHLAB_DOCKER_IMAGE";
const SCOUT_MOUNT_ENV: &str = "RESEARCHLAB_SCOUT_DOCKER_MOUNT";
const MOUNT_ENV: &str = "RESEARCHLAB_DOCKER_MOUNT";
const EXTRA_MOUNTS_ENV: &str = "RESEARCHLAB_DOCKER_EXTRA_MOUNTS";
const GPUS_ENV: &str = "RESEARCHLAB_DOCKER_GPUS";

/// The image this lane runs in, if any: a role-specific image wins over the
/// cycle-wide one, so a scout can keep a lighter image than an engineer needs.
fn image_for_role(env: &dyn Fn(&str) -> Option<String>, role: &str) -> Option<String> {
    let named = |name: &str| {
        env(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let role_specific = match role {
        "scout" => named(SCOUT_IMAGE_ENV),
        _ => None,
    };
    role_specific.or_else(|| named(IMAGE_ENV))
}

/// Host trees that live outside the `/work` mount and that a lane still needs:
/// reference repositories, simulator environments, model caches. Each entry is
/// `host=container`; an entry without `=` is mounted at the same path with `/`
/// separators, which is what a Linux image expects for `/opt/...` style roots.
pub(crate) fn parse_extra_mounts(raw: &str) -> Vec<(String, String)> {
    raw.split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| match entry.split_once('=') {
            Some((host, container)) => {
                let host = host.trim();
                let container = container.trim();
                (!host.is_empty() && !container.is_empty())
                    .then(|| (normalize_host_path(host), container.to_string()))
            }
            None => {
                let host = normalize_host_path(entry);
                let container = host.clone();
                Some((host, container))
            }
        })
        .collect()
}
/// Host settings the scout's drivers read. Host PATH and interpreter paths are
/// Windows spellings and are deliberately not forwarded.
const FORWARDED_ENV: &[&str] = &[
    "RESEARCHLAB_LITERATURE_NETWORK_POLICY",
    "RESEARCHLAB_CODEX_NETWORK_DOMAINS",
    "RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DockerScout {
    pub(crate) image: String,
    /// What `docker run --gpus` is given, when the lane's work needs a GPU.
    pub(crate) gpus: Option<String>,
    /// Host trees outside `/work` this lane needs, as `(host, container)`.
    pub(crate) extra_mounts: Vec<(String, String)>,
    /// Host directory mounted at `/work`, with `/` separators.
    pub(crate) mount_root: String,
    pub(crate) container_name: String,
    /// Host `auth.json`, mounted read-write so token refreshes stay in the one
    /// file the desktop app and host lanes also use.
    pub(crate) auth_json: String,
    /// The lane's working directory inside the container.
    pub(crate) workdir: String,
    pub(crate) container_env: Vec<(String, String)>,
    /// The host RESEARCHLAB_PYTHON the prompt names; the container uses python3.
    pub(crate) host_python: Option<String>,
}

/// Backends whose only installation on this host is a Windows one.
///
/// 2026-09-22, the owner: run Isaac from where it is already installed. That
/// install is `D:/envs/isaacsim6`, a WINDOWS Python -- measured: it reports
/// `platform.system() == "Windows"` and its Scripts/ holds .exe files. Bind
/// mounting it into a Linux container makes the files visible and nothing
/// runnable, so a lane ordered against Isaac stays on the host.
///
/// The order names its own backend, so the lane's venue follows the experiment
/// rather than the role: the same engineer runs a MuJoCo order in the container
/// and an Isaac order on the host.
const HOST_ONLY_SIMULATOR_BACKENDS: &[&str] = &["isaac", "isaacsim", "isaac-sim", "isaaclab", "isaac_lab", "omniverse"];

/// The simulator this lane was ordered to run, when it was ordered to run one.
fn ordered_simulator_backend(role_plan: Option<&serde_json::Value>) -> Option<String> {
    role_plan?
        .get("planner_metadata")?
        .get("simulation_order")?
        .get("simulator_backend")?
        .as_str()
        .map(|value| value.trim().to_ascii_lowercase())
}

pub(crate) fn order_must_run_on_the_host(role_plan: Option<&serde_json::Value>) -> bool {
    ordered_simulator_backend(role_plan).is_some_and(|backend| {
        HOST_ONLY_SIMULATOR_BACKENDS
            .iter()
            .any(|host_only| backend.contains(host_only))
    })
}

/// The container config for this lane, or `None` when it runs on the host.
pub(crate) fn docker_scout_config(
    paths: &AppPaths,
    contract: &LaneContract,
    lane_root: &Path,
    is_codex: bool,
    codex_home: Option<&Path>,
    role_plan: Option<&serde_json::Value>,
) -> Option<DockerScout> {
    if order_must_run_on_the_host(role_plan) {
        return None;
    }
    docker_scout_config_from(
        &|name: &str| std::env::var(name).ok(),
        paths,
        contract,
        lane_root,
        is_codex,
        codex_home,
    )
}

pub(crate) fn docker_scout_config_from(
    env: &dyn Fn(&str) -> Option<String>,
    paths: &AppPaths,
    contract: &LaneContract,
    lane_root: &Path,
    is_codex: bool,
    codex_home: Option<&Path>,
) -> Option<DockerScout> {
    if !is_codex {
        return None;
    }
    let image = image_for_role(env, &contract.role)?;
    let mount_root = env(MOUNT_ENV)
        .or_else(|| env(SCOUT_MOUNT_ENV))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| paths.project_root.parent().map(Path::to_path_buf))?;
    let mount_root = normalize_host_path(&mount_root.to_string_lossy());
    // HOME is often unset for a Windows process, so the harness's own
    // CODEX_HOME lookup can come back empty while auth.json exists.
    let codex_home = codex_home
        .map(Path::to_path_buf)
        .or_else(|| env("CODEX_HOME").filter(|v| !v.trim().is_empty()).map(PathBuf::from))
        .or_else(|| {
            env("USERPROFILE")
                .filter(|v| !v.trim().is_empty())
                .map(|home| PathBuf::from(home).join(".codex"))
        })?;
    let auth_json = codex_home.join("auth.json");
    // A missing file would be bind-mounted as an empty directory; the scout
    // could not authenticate, so it stays on the host instead.
    if !auth_json.is_file() {
        return None;
    }
    let workdir = host_to_container(&mount_root, &contract.cwd)?;
    // Codex writes its last message and reads the schema from the lane
    // directory; both must be visible inside the container.
    host_to_container(&mount_root, lane_root)?;
    let mut container_env = vec![("RESEARCHLAB_PYTHON".to_string(), "python3".to_string())];
    for name in FORWARDED_ENV {
        if let Some(value) = env(name) {
            container_env.push(((*name).to_string(), value));
        }
    }
    let extra_mounts = env(EXTRA_MOUNTS_ENV)
        .map(|raw| parse_extra_mounts(&raw))
        .unwrap_or_default();
    Some(DockerScout {
        image,
        gpus: env(GPUS_ENV)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        extra_mounts,
        mount_root,
        container_name: container_name(&contract.cycle_id, &contract.lane_id),
        auth_json: normalize_host_path(&auth_json.to_string_lossy()),
        workdir,
        container_env,
        host_python: env("RESEARCHLAB_PYTHON")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

pub(crate) fn container_name(cycle_id: &str, lane_id: &str) -> String {
    format!("rl-{cycle_id}-{lane_id}")
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(128)
        .collect()
}

/// `D:\a\b`, `D:/a/b/` and `\\?\D:\a\b` all become `D:/a/b`.
fn normalize_host_path(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let mut normalized = path.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

/// The container spelling of a host path under the mount, or `None` outside it.
pub(crate) fn host_to_container(mount_root: &str, path: &Path) -> Option<String> {
    let path = normalize_host_path(&path.to_string_lossy());
    let mount = normalize_host_path(mount_root);
    let prefix = path.get(..mount.len())?;
    if !prefix.eq_ignore_ascii_case(&mount) {
        return None;
    }
    let rest = &path[mount.len()..];
    if rest.is_empty() {
        Some(CONTAINER_ROOT.to_string())
    } else if rest.starts_with('/') {
        Some(format!("{CONTAINER_ROOT}{rest}"))
    } else {
        None
    }
}

fn is_path_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

/// A run of `/` and `\` starting at `pos`: (length, backslash count).
fn separator_run(bytes: &[u8], pos: usize) -> (usize, usize) {
    let mut len = 0;
    let mut backslashes = 0;
    while let Some(&byte) = bytes.get(pos + len) {
        match byte {
            b'/' => len += 1,
            b'\\' => {
                len += 1;
                backslashes += 1;
            }
            _ => break,
        }
    }
    (len, backslashes)
}

/// Where the mount prefix ends when it starts at `start`, and whether it was
/// spelled JSON-escaped (`\\`).
fn match_mount_at(bytes: &[u8], start: usize, components: &[&str]) -> Option<(usize, bool)> {
    if start > 0 && is_path_name_byte(bytes[start - 1]) {
        return None;
    }
    let mut pos = start;
    let mut escaped = false;
    for (index, component) in components.iter().enumerate() {
        if index > 0 {
            let (len, backslashes) = separator_run(bytes, pos);
            if len == 0 || len > 2 || (len == 2 && backslashes != 2) {
                return None;
            }
            escaped |= backslashes == 2;
            pos += len;
        }
        let end = pos + component.len();
        if end > bytes.len() || !bytes[pos..end].eq_ignore_ascii_case(component.as_bytes()) {
            return None;
        }
        pos = end;
    }
    if bytes.get(pos).copied().is_some_and(is_path_name_byte) {
        return None;
    }
    Some((pos, escaped))
}

/// Rewrites every host path under the mount to its `/work/...` spelling.
///
/// Handles `D:\x`, `D:/x`, mixed separators and the JSON-escaped `D:\\x` of a
/// role plan embedded in the prompt. In escaped text a single backslash is an
/// escape (`\n`, `\"`) and ends the path; elsewhere it is a separator. Paths
/// outside the mount are left as written.
pub(crate) fn translate_host_paths(mount_root: &str, text: &str) -> String {
    let mount = normalize_host_path(mount_root);
    let components: Vec<&str> = mount.split('/').collect();
    let Some(first) = components.first().map(|c| c.as_bytes()) else {
        return text.to_string();
    };
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut pos = 0;
    while pos < bytes.len() {
        let candidate = if first.is_empty() {
            matches!(bytes[pos], b'/' | b'\\')
        } else {
            bytes[pos].eq_ignore_ascii_case(&first[0])
        };
        let Some((mut end, mut escaped)) = candidate
            .then(|| match_mount_at(bytes, pos, &components))
            .flatten()
        else {
            pos += 1;
            continue;
        };
        out.push_str(&text[copied..pos]);
        out.push_str(CONTAINER_ROOT);
        // The rest of the path: names are copied, separators become `/`.
        loop {
            let (len, backslashes) = separator_run(bytes, end);
            if len == 0 {
                break;
            }
            let lone_backslash_escape = backslashes == 1 && len == 1;
            if (escaped && lone_backslash_escape)
                || (lone_backslash_escape && bytes.get(end + 1) == Some(&b'"'))
            {
                break;
            }
            escaped |= backslashes >= 2;
            out.push('/');
            end += len;
            let name_start = end;
            while end < bytes.len()
                && !matches!(bytes[end], b'/' | b'\\')
                && !bytes[end].is_ascii_whitespace()
                && !matches!(
                    bytes[end],
                    b'"' | b'\'' | b'`' | b',' | b';' | b')' | b']' | b'}' | b'<' | b'>' | b'|'
                )
            {
                end += 1;
            }
            out.push_str(&text[name_start..end]);
        }
        copied = end;
        pos = end;
    }
    out.push_str(&text[copied..]);
    out
}

impl DockerScout {
    /// The one line prepended to the prompt the container reads.
    pub(crate) fn venue_note(&self) -> String {
        let windows_spelling = self.mount_root.replace('/', "\\");
        format!(
            "This lane runs in a Linux container: the repository is at {CONTAINER_ROOT}; host paths {windows_spelling}\\… are {CONTAINER_ROOT}/…; use python3 (the shell is bash, not PowerShell)."
        )
    }

    /// The prompt as the container sees it: the host interpreter replaced by
    /// python3, host paths translated, the venue note first. The host prompt
    /// file keeps its host paths.
    pub(crate) fn container_prompt(&self, prompt: &str) -> String {
        let mut prompt = prompt.to_string();
        // A bare name ("python") is left alone: replacing it would also rewrite
        // every "python3" and "python" in the text.
        if let Some(python) = self
            .host_python
            .as_deref()
            .filter(|python| python.contains(['/', '\\']))
        {
            // The PowerShell and POSIX invocations the prompt builder writes
            // (codex_prompt::python_runtime_clause_for), then any bare mention.
            for spelling in [
                format!("& '{}'", python.replace('\'', "''")),
                format!("'{}'", python.replace('\'', r#"'"'"'"#)),
                python.to_string(),
            ] {
                prompt = prompt.replace(&spelling, "python3");
            }
        }
        format!(
            "{}\n\n{}",
            self.venue_note(),
            translate_host_paths(&self.mount_root, &prompt)
        )
    }

    /// `docker run ... <image> codex <codex_args>`, every host path in the
    /// Codex arguments mapped to its container spelling.
    pub(crate) fn run_args<'a>(&self, codex_args: impl IntoIterator<Item = &'a OsStr>) -> Vec<OsString> {
        let mut args: Vec<OsString> = [
            "run",
            "--rm",
            "-i",
            "--name",
            self.container_name.as_str(),
            // Without these bubblewrap cannot create its namespaces ("No
            // permissions to create a new namespace"). They loosen the
            // container, not the Codex sandbox inside it.
            "--security-opt",
            "seccomp=unconfined",
            "--security-opt",
            "apparmor=unconfined",
            "-v",
            format!("{}:{CONTAINER_ROOT}", self.mount_root).as_str(),
            "-v",
            format!("{}:{CONTAINER_AUTH_PATH}", self.auth_json).as_str(),
            "-w",
            self.workdir.as_str(),
        ]
        .iter()
        .map(OsString::from)
        .collect();
        // Trees the lane needs that live outside /work: reference repositories,
        // simulator environments, model caches.
        for (host, container) in &self.extra_mounts {
            args.push("-v".into());
            args.push(format!("{host}:{container}").into());
        }
        // A simulation lane's work is the GPU's; without this the container sees
        // no device and every engineer falls back to CPU silently.
        if let Some(gpus) = &self.gpus {
            args.push("--gpus".into());
            args.push(gpus.clone().into());
        }
        for (name, value) in &self.container_env {
            args.push("-e".into());
            args.push(format!("{name}={value}").into());
        }
        args.push(self.image.clone().into());
        args.push("codex".into());
        for arg in codex_args {
            args.push(match arg.to_str() {
                Some(text) => translate_host_paths(&self.mount_root, text).into(),
                None => arg.to_os_string(),
            });
        }
        args
    }

    /// Wraps an already-built host Codex command (`codex <args>`, optionally
    /// behind setsid) into the equivalent `docker run`.
    pub(crate) fn command(&self, host_codex: &Command, setsid_path: &Path) -> Command {
        let wrapped_by_setsid = Path::new(host_codex.get_program())
            .file_name()
            .is_some_and(|name| name == "setsid");
        let codex_args = host_codex.get_args().skip(usize::from(wrapped_by_setsid));
        let mut command = if setsid_path.exists() {
            let mut wrapped = Command::new(setsid_path);
            wrapped.arg("docker");
            wrapped
        } else {
            Command::new("docker")
        };
        command.args(self.run_args(codex_args));
        command
    }

    /// Removes the container. Killing the host `docker` client does not stop
    /// the container, so every kill path and every relaunch calls this. Errors
    /// (usually "no such container" after `--rm`) are ignored.
    pub(crate) fn remove_container(&self) {
        remove_docker_container(&self.container_name);
    }
}

/// `docker rm -f <name>`, ignoring errors ("no such container" after `--rm`).
pub(crate) fn remove_docker_container(name: &str) {
    let _ = Command::new("docker")
        .args(["rm", "-f", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// The container a lane's process metadata says it runs in, if any.
///
/// The name is derived from the cycle and lane, never read from the metadata,
/// so an abort can only ever remove this lane's own container.
pub(crate) fn lane_docker_container(
    process: &serde_json::Value,
    cycle_id: &str,
    lane_id: &str,
) -> Option<String> {
    (process.get("execution_venue").and_then(serde_json::Value::as_str) == Some("docker"))
        .then(|| container_name(cycle_id, lane_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_aborted_docker_lane_names_only_its_own_container() {
        let docker = serde_json::json!({"execution_venue": "docker", "docker_container": "someone-else"});
        assert_eq!(
            lane_docker_container(&docker, "cycle-b-20260918", "followup-scout-04").as_deref(),
            Some("rl-cycle-b-20260918-followup-scout-04"),
        );
        let host = serde_json::json!({"execution_venue": "host"});
        assert!(lane_docker_container(&host, "c", "l").is_none());
        assert!(lane_docker_container(&serde_json::json!({"pid": 1}), "c", "l").is_none());
    }
    use std::collections::HashMap;
    use tempfile::TempDir;

    const MOUNT: &str = "D:/projects/researchlab";

    fn paths(project_root: &Path) -> AppPaths {
        AppPaths {
            project_root: project_root.to_path_buf(),
            runtime_root: project_root.join(".research-lab"),
            data_root: project_root.join("data"),
            stats_driver_script: project_root.join("stats.py"),
            literature_driver_script: project_root.join("literature.py"),
        }
    }

    fn contract(role: &str, cwd: &Path) -> LaneContract {
        LaneContract {
            cycle_id: "Cycle-B_20260918".to_string(),
            lane_id: "scout lit/01".to_string(),
            role: role.to_string(),
            runtime_class: "codex".to_string(),
            mode: "agent".to_string(),
            cwd: cwd.to_path_buf(),
            task_file: cwd.join("task.md"),
            allowed_inputs: Vec::new(),
            allowed_outputs: Vec::new(),
            output_artifact: None,
            fallback_strategy: None,
        }
    }

    struct Fixture {
        _dir: TempDir,
        project: PathBuf,
        codex_home: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("mount").join("researchlab");
        std::fs::create_dir_all(&project).unwrap();
        let codex_home = dir.path().join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
        Fixture { _dir: dir, project, codex_home }
    }

    fn lookup(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    fn config(
        vars: &[(&str, &str)],
        fx: &Fixture,
        role: &str,
        is_codex: bool,
    ) -> Option<DockerScout> {
        let env = lookup(vars);
        docker_scout_config_from(
            &env,
            &paths(&fx.project),
            &contract(role, &fx.project),
            &fx.project.join(".research-lab").join("lanes"),
            is_codex,
            Some(&fx.codex_home),
        )
    }

    #[test]
    fn only_a_codex_scout_with_the_image_set_runs_in_docker() {
        let fx = fixture();
        let image = [(IMAGE_ENV, "researchlab:local")];
        let scout = config(&image, &fx, "scout", true).expect("docker scout");
        assert_eq!(scout.image, "researchlab:local");
        assert_eq!(scout.workdir, "/work/researchlab");
        assert_eq!(
            scout.mount_root,
            normalize_host_path(&fx.project.parent().unwrap().to_string_lossy())
        );
        assert_eq!(scout.container_name, "rl-cycle-b_20260918-scout-lit-01");
        assert!(scout.auth_json.ends_with("codex-home/auth.json"));

        assert!(config(&[], &fx, "scout", true).is_none(), "unset image");
        assert!(config(&[(IMAGE_ENV, "  ")], &fx, "scout", true).is_none(), "blank image");
        assert!(config(&image, &fx, "scout", false).is_none(), "claude runtime");

        // 2026-09-22, the owner: the cycle-wide image puts EVERY codex lane in
        // the container. A venue only one role used left every other role on the
        // host the desktop app keeps resetting.
        for role in ["analyst", "lab-director", "engineer", "chronicle", "gatekeeper"] {
            let lane = config(&image, &fx, role, true)
                .unwrap_or_else(|| panic!("{role} should run in the cycle-wide image"));
            assert_eq!(lane.image, "researchlab:local");
        }

        // The scout-only image still names a venue for scouts alone, and still
        // overrides the cycle-wide one for that role.
        let scout_only = [(SCOUT_IMAGE_ENV, "researchlab:scouts")];
        assert_eq!(
            config(&scout_only, &fx, "scout", true).expect("scout image").image,
            "researchlab:scouts"
        );
        for role in ["analyst", "engineer"] {
            assert!(config(&scout_only, &fx, role, true).is_none(), "{role}");
        }
        let both = [(SCOUT_IMAGE_ENV, "researchlab:scouts"), (IMAGE_ENV, "researchlab:local")];
        assert_eq!(config(&both, &fx, "scout", true).unwrap().image, "researchlab:scouts");
        assert_eq!(config(&both, &fx, "engineer", true).unwrap().image, "researchlab:local");
    }

    // 2026-09-22, the owner: "can Isaac run from its existing install instead?" It can,
    // but only on the host: D:/envs/isaacsim6 is a Windows install (measured:
    // platform.system() == "Windows", .exe files in Scripts/), and a Linux
    // container can see those files and execute none of them. The venue follows
    // the ORDER's simulator, not the lane's role, so one engineer runs a MuJoCo
    // order in the container and an Isaac order on the host.
    #[test]
    fn an_isaac_order_keeps_its_lane_on_the_host() {
        use serde_json::json;
        let order = |backend: &str| {
            json!({"planner_metadata": {"simulation_order": {"simulator_backend": backend}}})
        };
        for backend in ["isaacsim", "Isaac Sim", "ISAACLAB", "isaac-sim", "omniverse kit"] {
            assert!(
                order_must_run_on_the_host(Some(&order(backend))),
                "{backend} has no Linux install here"
            );
        }
        for backend in ["mujoco", "MuJoCo 3.11", "genesis", "pybullet"] {
            assert!(!order_must_run_on_the_host(Some(&order(backend))), "{backend}");
        }
        // A lane with no order at all is not a simulation lane.
        assert!(!order_must_run_on_the_host(None));
        assert!(!order_must_run_on_the_host(Some(&json!({"planner_metadata": {}}))));
    }

    #[test]
    fn the_container_is_refused_for_an_isaac_order_even_with_the_image_set() {
        use serde_json::json;
        let fx = fixture();
        let image = [(IMAGE_ENV, "researchlab:full")];
        let isaac = json!({"planner_metadata": {"simulation_order": {"simulator_backend": "isaacsim"}}});
        let mujoco = json!({"planner_metadata": {"simulation_order": {"simulator_backend": "mujoco"}}});
        // config() goes through docker_scout_config_from, which does not see the
        // role plan; the role-plan gate lives in docker_scout_config. Assert the
        // gate itself, and that the same lane is otherwise container-eligible.
        assert!(order_must_run_on_the_host(Some(&isaac)));
        assert!(!order_must_run_on_the_host(Some(&mujoco)));
        assert!(config(&image, &fx, "engineer", true).is_some());
    }

    // A lane whose work is the GPU's, and whose assets live outside /work.
    #[test]
    fn extra_mounts_and_gpus_reach_the_docker_command() {
        let fx = fixture();
        let vars = [
            (IMAGE_ENV, "researchlab:local"),
            (GPUS_ENV, "all"),
            (
                EXTRA_MOUNTS_ENV,
                "D:/projects/reference-repos=/opt/refs; D:/envs/isaacsim6",
            ),
        ];
        let lane = config(&vars, &fx, "engineer", true).expect("engineer in docker");
        assert_eq!(lane.gpus.as_deref(), Some("all"));
        assert_eq!(
            lane.extra_mounts,
            vec![
                ("D:/projects/reference-repos".to_string(), "/opt/refs".to_string()),
                ("D:/envs/isaacsim6".to_string(), "D:/envs/isaacsim6".to_string()),
            ]
        );
        let argv = lane.run_args([OsStr::new("exec")]);
        let rendered: Vec<String> =
            argv.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(rendered.contains(&"--gpus".to_string()), "{rendered:?}");
        assert!(
            rendered.contains(&"D:/projects/reference-repos:/opt/refs".to_string()),
            "{rendered:?}"
        );
    }

    #[test]
    fn a_scout_outside_the_mount_or_without_auth_stays_on_the_host() {
        let fx = fixture();
        let elsewhere = TempDir::new().unwrap();
        let vars = [
            (IMAGE_ENV, "img"),
            (MOUNT_ENV, elsewhere.path().to_str().unwrap()),
        ];
        assert!(config(&vars, &fx, "scout", true).is_none());

        std::fs::remove_file(fx.codex_home.join("auth.json")).unwrap();
        assert!(config(&[(IMAGE_ENV, "img")], &fx, "scout", true).is_none());
    }

    #[test]
    fn auth_is_found_through_codex_home_or_userprofile_when_home_is_unset() {
        let fx = fixture();
        let profile = fx.codex_home.parent().unwrap().join("profile");
        std::fs::create_dir_all(profile.join(".codex")).unwrap();
        std::fs::write(profile.join(".codex").join("auth.json"), "{}").unwrap();
        let find = |vars: &[(&str, &str)]| {
            let env = lookup(vars);
            docker_scout_config_from(
                &env,
                &paths(&fx.project),
                &contract("scout", &fx.project),
                &fx.project,
                true,
                None,
            )
            .map(|scout| scout.auth_json)
        };
        assert_eq!(find(&[(IMAGE_ENV, "img")]), None);
        let codex_home = fx.codex_home.to_str().unwrap();
        let via_codex_home = find(&[(IMAGE_ENV, "img"), ("CODEX_HOME", codex_home)]);
        assert!(via_codex_home.unwrap().ends_with("codex-home/auth.json"));
        let via_profile = find(&[(IMAGE_ENV, "img"), ("USERPROFILE", profile.to_str().unwrap())]);
        assert!(via_profile.unwrap().ends_with("profile/.codex/auth.json"));
    }

    #[test]
    fn container_env_pins_python3_and_forwards_only_the_listed_settings() {
        let fx = fixture();
        let scout = config(
            &[
                (IMAGE_ENV, "img"),
                ("RESEARCHLAB_LITERATURE_NETWORK_POLICY", "approved-scholarly-metadata-v1"),
                ("PYTHONUTF8", "1"),
                ("PATH", r"C:\Windows"),
                ("RESEARCHLAB_PYTHON", r"C:\Python311\python.exe"),
            ],
            &fx,
            "scout",
            true,
        )
        .unwrap();
        assert_eq!(
            scout.container_env,
            vec![
                ("RESEARCHLAB_PYTHON".to_string(), "python3".to_string()),
                (
                    "RESEARCHLAB_LITERATURE_NETWORK_POLICY".to_string(),
                    "approved-scholarly-metadata-v1".to_string()
                ),
                ("PYTHONUTF8".to_string(), "1".to_string()),
            ]
        );
    }

    #[test]
    fn the_image_env_var_enables_docker_through_the_process_environment() {
        let fx = fixture();
        let previous = std::env::var(IMAGE_ENV).ok();
        std::env::set_var(IMAGE_ENV, "researchlab:local");
        let with_image = docker_scout_config(
            &paths(&fx.project),
            &contract("scout", &fx.project),
            &fx.project,
            true,
            Some(&fx.codex_home),
            None,
        );
        std::env::remove_var(IMAGE_ENV);
        let without_image = docker_scout_config(
            &paths(&fx.project),
            &contract("scout", &fx.project),
            &fx.project,
            true,
            Some(&fx.codex_home),
            None,
        );
        if let Some(value) = previous {
            std::env::set_var(IMAGE_ENV, value);
        }
        assert_eq!(with_image.map(|s| s.image).as_deref(), Some("researchlab:local"));
        assert!(without_image.is_none());
    }

    #[test]
    fn host_paths_map_to_work_with_either_separator() {
        for path in [
            r"D:\projects\researchlab\researchlab\.research-lab\lanes\x",
            "D:/projects/researchlab/researchlab/.research-lab/lanes/x",
            r"d:\projects\researchlab/researchlab\.research-lab/lanes\x",
            r"\\?\D:\projects\researchlab\researchlab\.research-lab\lanes\x",
        ] {
            assert_eq!(
                host_to_container(MOUNT, Path::new(path)).as_deref(),
                Some("/work/researchlab/.research-lab/lanes/x"),
                "{path}"
            );
        }
        assert_eq!(host_to_container(r"D:\projects\researchlab\", Path::new(MOUNT)).as_deref(), Some("/work"));
        assert_eq!(host_to_container(MOUNT, Path::new(r"D:\projects\researchlab-other\x")), None);
        assert_eq!(host_to_container(MOUNT, Path::new(r"C:\Users\user\.codex")), None);
    }

    #[test]
    fn prompt_text_paths_are_translated_in_every_spelling() {
        let text = concat!(
            r"Read D:\projects\researchlab\researchlab\.research-lab\lanes\c\l\role-plan.json now.",
            "\n",
            r#"{"journal":"D:\\projects\\researchlab\\researchlab\\runtime\\j.json","x":1}"#,
            "\n",
            "Also d:/projects/researchlab/researchlab/drivers/literature/search.py, then ",
            r"D:/projects/researchlab\researchlab\notes.md",
        );
        let expected = concat!(
            "Read /work/researchlab/.research-lab/lanes/c/l/role-plan.json now.",
            "\n",
            r#"{"journal":"/work/researchlab/runtime/j.json","x":1}"#,
            "\n",
            "Also /work/researchlab/drivers/literature/search.py, then ",
            "/work/researchlab/notes.md",
        );
        assert_eq!(translate_host_paths(MOUNT, text), expected);
    }

    #[test]
    fn escaped_json_keeps_its_escapes_after_a_path() {
        let text = r#""see D:\\projects\\researchlab\\a\\b.json\nnext \"D:\\projects\\researchlab\"""#;
        assert_eq!(
            translate_host_paths(MOUNT, text),
            r#""see /work/a/b.json\nnext \"/work\"""#
        );
    }

    #[test]
    fn paths_outside_the_mount_are_left_as_written() {
        let text = concat!(
            r"C:\Users\user\.codex\auth.json and D:\projects\researchlab-other\x and ",
            r"D:\projects\other\y and XD:\projects\researchlab\z and D:\projects",
        );
        assert_eq!(translate_host_paths(MOUNT, text), text);
    }

    #[test]
    fn container_prompt_starts_with_the_venue_note() {
        let fx = fixture();
        let mut scout = config(&[(IMAGE_ENV, "img")], &fx, "scout", true).unwrap();
        scout.mount_root = MOUNT.to_string();
        scout.host_python = Some("D:/projects/superdex/.venv/Scripts/python.exe".to_string());
        let prompt = scout.container_prompt(concat!(
            r"cd D:\projects\researchlab\researchlab",
            "\nRun `& 'D:/projects/superdex/.venv/Scripts/python.exe' <script.py>`",
            "\nor D:/projects/superdex/.venv/Scripts/python.exe x.py",
        ));
        let (note, body) = prompt.split_once("\n\n").unwrap();
        assert!(note.starts_with("This lane runs in a Linux container: the repository is at /work;"));
        assert!(note.contains(r"host paths D:\projects\researchlab\… are /work/…; use python3"));
        assert_eq!(body, "cd /work/researchlab\nRun `python3 <script.py>`\nor python3 x.py");
    }

    #[test]
    fn docker_argv_wraps_the_host_codex_args_with_paths_mapped() {
        let fx = fixture();
        let mut scout = config(
            &[(IMAGE_ENV, "researchlab:local"), ("PYTHONUTF8", "1")],
            &fx,
            "scout",
            true,
        )
        .unwrap();
        scout.mount_root = MOUNT.to_string();
        scout.auth_json = "C:/Users/user/.codex/auth.json".to_string();
        scout.workdir = "/work/researchlab".to_string();
        let mut host = Command::new("codex");
        host.args([
            "exec",
            "--json",
            "--config",
            "approval_policy=\"on-request\"",
            "--output-last-message",
            r"D:\projects\researchlab\researchlab\.research-lab\lanes\c\l\output-last-message.txt",
            "--output-schema",
            r"D:\projects\researchlab\researchlab\.research-lab\lanes\c\l\output-schema.json",
            "-",
        ]);
        let command = scout.command(&host, Path::new("/definitely/not/setsid"));
        assert_eq!(command.get_program(), "docker");
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let expected: Vec<String> = [
            "run",
            "--rm",
            "-i",
            "--name",
            "rl-cycle-b_20260918-scout-lit-01",
            "--security-opt",
            "seccomp=unconfined",
            "--security-opt",
            "apparmor=unconfined",
            "-v",
            "D:/projects/researchlab:/work",
            "-v",
            "C:/Users/user/.codex/auth.json:/root/.codex/auth.json",
            "-w",
            "/work/researchlab",
            "-e",
            "RESEARCHLAB_PYTHON=python3",
            "-e",
            "PYTHONUTF8=1",
            "researchlab:local",
            "codex",
            "exec",
            "--json",
            "--config",
            "approval_policy=\"on-request\"",
            "--output-last-message",
            "/work/researchlab/.research-lab/lanes/c/l/output-last-message.txt",
            "--output-schema",
            "/work/researchlab/.research-lab/lanes/c/l/output-schema.json",
            "-",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);

        // A setsid-wrapped host command contributes only codex's own args.
        let mut wrapped = Command::new("/usr/bin/setsid");
        wrapped.arg("codex").arg("exec");
        let args: Vec<String> = scout
            .command(&wrapped, Path::new("/definitely/not/setsid"))
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[args.len() - 2..], ["codex", "exec"]);
    }
}
