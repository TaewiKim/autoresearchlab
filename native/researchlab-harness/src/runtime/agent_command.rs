use serde_json::Value;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn command_candidate_is_healthy(command_path: &str) -> bool {
    Command::new(command_path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn codex_command() -> Option<String> {
    env::var("RESEARCHLAB_CODEX_CMD")
        .ok()
        .filter(|item| !item.trim().is_empty())
        .filter(|item| command_candidate_is_healthy(item))
        .or_else(standalone_codex_command)
        .or_else(|| {
            which::which("codex")
                .ok()
                .map(|path| path.display().to_string())
                .filter(|item| command_candidate_is_healthy(item))
        })
        .or_else(|| command_from_common_locations("codex"))
}

fn standalone_codex_command() -> Option<String> {
    // The Windows desktop app ships its own versioned CLI and can leave that
    // older binary at the front of the already-running app process's PATH.
    // Prefer the independently installed Codex CLI location so an in-place CLI
    // update takes effect without restarting the desktop app. An explicit
    // RESEARCHLAB_CODEX_CMD still wins above this check.
    #[cfg(windows)]
    {
        let path = env::var("LOCALAPPDATA")
            .ok()
            .filter(|item| !item.trim().is_empty())
            .map(PathBuf::from)?
            .join("Programs")
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("codex.exe");
        if is_executable_file(&path) {
            let command = path.display().to_string();
            if command_candidate_is_healthy(&command) {
                return Some(command);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && (meta.permissions().mode() & 0o111) != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

pub(crate) fn command_from_common_locations(command_name: &str) -> Option<String> {
    let home = env::var("HOME")
        .ok()
        .filter(|item| !item.trim().is_empty())?;
    let home = PathBuf::from(home);
    let mut candidates = Vec::new();

    if let Ok(nvm_bin) = env::var("NVM_BIN") {
        if !nvm_bin.trim().is_empty() {
            candidates.push(PathBuf::from(nvm_bin).join(command_name));
        }
    }

    let nvm_node_root = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = std::fs::read_dir(&nvm_node_root) {
        let mut bins = entries
            .filter_map(|entry| {
                entry
                    .ok()
                    .map(|entry| entry.path().join("bin").join(command_name))
            })
            .collect::<Vec<_>>();
        bins.sort_by(|a, b| b.cmp(a));
        candidates.extend(bins);
    }

    candidates.extend([
        home.join(".local").join("bin").join(command_name),
        home.join("Library").join("pnpm").join(command_name),
        PathBuf::from("/opt/homebrew/bin").join(command_name),
        PathBuf::from("/usr/local/bin").join(command_name),
    ]);

    candidates.into_iter().find_map(|path| {
        if !is_executable_file(&path) {
            return None;
        }
        let command = path.display().to_string();
        if command_candidate_is_healthy(&command) {
            Some(command)
        } else {
            None
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentRuntime {
    Codex,
    Claude,
}

impl AgentRuntime {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AgentRuntime::Codex => "codex",
            AgentRuntime::Claude => "claude",
        }
    }
}

pub(crate) fn agent_runtime() -> AgentRuntime {
    match env::var("RESEARCHLAB_AGENT_RUNTIME")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("claude") => AgentRuntime::Claude,
        _ => AgentRuntime::Codex,
    }
}

pub(crate) fn resolve_agent_runtime(preferred: AgentRuntime) -> AgentRuntime {
    resolve_agent_runtime_with_availability(
        preferred,
        codex_command().is_some(),
        claude_command().is_some(),
    )
}

fn resolve_agent_runtime_with_availability(
    preferred: AgentRuntime,
    codex_available: bool,
    _claude_available: bool,
) -> AgentRuntime {
    match preferred {
        AgentRuntime::Codex => {
            if codex_available {
                AgentRuntime::Codex
            } else {
                // A requested Codex lane must fail clearly when Codex is not
                // available. Falling through to Claude could select a
                // different provider/account and create an unintended charge.
                AgentRuntime::Codex
            }
        }
        AgentRuntime::Claude => AgentRuntime::Claude,
    }
}

pub(crate) fn claude_command() -> Option<String> {
    env::var("RESEARCHLAB_CLAUDE_CMD")
        .ok()
        .filter(|item| !item.trim().is_empty())
        .filter(|item| command_candidate_is_healthy(item))
        .or_else(|| {
            which::which("claude")
                .ok()
                .map(|path| path.display().to_string())
                .filter(|item| command_candidate_is_healthy(item))
        })
        .or_else(|| command_from_common_locations("claude"))
}

pub(crate) fn agent_command(runtime: AgentRuntime) -> Option<String> {
    match runtime {
        AgentRuntime::Codex => codex_command(),
        AgentRuntime::Claude => claude_command(),
    }
}

pub(crate) fn researchlab_codex_home() -> Option<PathBuf> {
    let home = env::var("HOME")
        .ok()
        .filter(|item| !item.trim().is_empty())?;
    let codex_home = PathBuf::from(home).join(".codex");
    if codex_home.is_dir() {
        Some(codex_home)
    } else {
        None
    }
}

pub(crate) fn extract_claude_last_message(stdout: &str) -> String {
    // claude -p --output-format json emits a single JSON object on stdout;
    // accept either {"result": "..."} or {"text": "..."}.
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        for key in ["result", "text", "content", "output"] {
            if let Some(text) = parsed.get(key).and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    return text.to_string();
                }
            }
        }
        if let Some(messages) = parsed.get("messages").and_then(Value::as_array) {
            for message in messages.iter().rev() {
                if let Some(text) = message
                    .get("content")
                    .and_then(Value::as_str)
                    .or_else(|| message.get("text").and_then(Value::as_str))
                {
                    if !text.trim().is_empty() {
                        return text.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::{
        agent_runtime, command_candidate_is_healthy, resolve_agent_runtime_with_availability,
        AgentRuntime,
    };
    use std::env;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use tempfile::tempdir;

    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn remove(key: &'static str) -> Self {
            let original = env::var(key).ok();
            // SAFETY: unit tests mutate process env in a narrow scope and
            // restore the previous value before returning.
            unsafe { env::remove_var(key) };
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.original.as_deref() {
                Some(value) => {
                    // SAFETY: restore the pre-test value before exiting scope.
                    unsafe { env::set_var(self.key, value) };
                }
                None => {
                    // SAFETY: restore the pre-test absence before exiting scope.
                    unsafe { env::remove_var(self.key) };
                }
            }
        }
    }

    #[test]
    fn does_not_fall_back_to_claude_when_codex_is_unhealthy() {
        let _runtime = EnvGuard::remove("RESEARCHLAB_AGENT_RUNTIME");

        assert_eq!(agent_runtime(), AgentRuntime::Codex);
        assert_eq!(
            resolve_agent_runtime_with_availability(agent_runtime(), false, true),
            AgentRuntime::Codex
        );
    }

    #[test]
    fn keeps_codex_when_no_healthy_fallback_exists() {
        let _runtime = EnvGuard::remove("RESEARCHLAB_AGENT_RUNTIME");

        assert_eq!(
            resolve_agent_runtime_with_availability(agent_runtime(), false, false),
            AgentRuntime::Codex
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_broken_wrapper_command() {
        let tempdir = tempdir().unwrap();
        let script_path = tempdir.path().join("broken-codex");
        fs::write(
            &script_path,
            "#!/bin/sh\nprintf 'Error: spawn missing-binary ENOENT\\n' >&2\nexit 1\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&script_path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).unwrap();

        assert!(!command_candidate_is_healthy(script_path.to_str().unwrap()));
    }
}
