//! A revoked Codex login, told to the owner instead of waited out.
//!
//! MEASURED ON cycle-a-20260919, 2026-10-01. The container's Codex
//! refresh token was revoked (`token_revoked`, "Please log out and sign in
//! again"). Every lane failed in under a second, was classified
//! `auth_refresh_wait`, left prepared and retried five minutes later -- the
//! right answer for an access token that Codex refreshes by itself, and no
//! answer at all for a login only the owner can renew. From 02:15 to 13:21 UTC
//! not one lane completed, nothing told the owner, and the supervisor spent four
//! diagnoses on the same 401.
//!
//! The lanes keep their retry (a login is picked up by the next one with no
//! restart). What changes is that the condition is written down where the owner
//! and the supervisor read it, with the auth file's identity, and is removed the
//! moment a lane runs a turn again.
use anyhow::Result;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::chronicle::reporting::append_event;
use crate::core::model::AppPaths;
use crate::core::support::{harness_notices_path, now_iso, state_root, write_json};

/// Codex's own words for a login that no refresh will bring back. A plain
/// expired access token ("provided authentication token is expired") is not one
/// of them: Codex refreshes it on the next call.
pub(crate) fn codex_login_revoked(stdout: &str, stderr: &str) -> bool {
    let haystack = format!("{stdout}\n{stderr}").to_lowercase();
    haystack.contains("token_revoked")
        || haystack.contains("refresh token was revoked")
        || haystack.contains("please log out and sign in again")
        || haystack.contains("refresh_token_reused")
        || haystack.contains("refresh_token_invalidated")
}

pub(crate) fn codex_login_marker_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-codex-login-required.json"))
}

/// Which auth.json the failing run used, as the supervisor can compare it: a
/// new login rewrites the file, so a changed identity means the owner acted.
fn auth_identity(codex_home: Option<&Path>) -> Value {
    let Some(home) = codex_home else {
        return Value::Null;
    };
    let auth_path = home.join("auth.json");
    let meta = fs::metadata(&auth_path).ok();
    let mtime_ms = meta
        .as_ref()
        .and_then(|item| item.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64);
    json!({
        "auth_json_path": auth_path.display().to_string(),
        "auth_json_mtime_ms": mtime_ms,
        "auth_json_len": meta.as_ref().map(|item| item.len()),
    })
}

/// Records or clears the condition after a Codex run. Returns whether the run
/// failed on a revoked login.
pub(crate) fn note_codex_login(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    codex_home: Option<&Path>,
    stdout: &str,
    stderr: &str,
) -> Result<bool> {
    let marker_path = codex_login_marker_path(paths, cycle_id);
    let events_path = harness_notices_path(paths, cycle_id);
    if codex_login_revoked(stdout, stderr) {
        let identity = auth_identity(codex_home);
        let existing = fs::read(&marker_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        // The first lane records it; later ones do not rewrite it unless the
        // owner has signed in since and the login is still refused.
        if let Some(existing) = existing.as_ref() {
            if existing.get("auth") == Some(&identity) {
                return Ok(true);
            }
        }
        let detected_at = existing
            .as_ref()
            .and_then(|item| item.get("detected_at").cloned())
            .unwrap_or_else(|| json!(now_iso()));
        let home = codex_home
            .map(|item| item.display().to_string())
            .unwrap_or_else(|| "~/.codex".to_string());
        write_json(
            &marker_path,
            &json!({
                "cycle_id": cycle_id,
                "status": "owner_action_required",
                "detected_at": detected_at,
                "updated_at": now_iso(),
                "lane_id": lane_id,
                "reason": "The Codex login was revoked; no agent can run until the owner signs in again. Lanes keep retrying and resume on their own after the login.",
                "owner_action": format!("Sign in again for CODEX_HOME={home}: `codex login --device-auth` (in Docker: docker exec -it <container> codex login --device-auth)."),
                "auth": identity,
                "evidence": super::codex_policy::excerpt_text(stderr, 600),
            }),
        )?;
        append_event(
            &events_path,
            "codex_login_required",
            json!({"lane_id": lane_id, "marker_path": marker_path.display().to_string()}),
        )?;
        return Ok(true);
    }
    // A turn that ran is the proof the login works again.
    let turn_ran = stdout.contains("\"type\":\"turn.completed\"");
    if turn_ran && marker_path.exists() {
        fs::remove_file(&marker_path)?;
        append_event(&events_path, "codex_login_restored", json!({"lane_id": lane_id}))?;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::support::read_json;

    const REVOKED: &str = r#"{"type":"error","message":"Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."}"#;
    const STDERR_401: &str = "ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, auth error code: token_revoked";

    fn fixture() -> (tempfile::TempDir, AppPaths, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let runtime_root = dir.path().join(".research-lab");
        let paths = AppPaths {
            project_root: dir.path().to_path_buf(),
            runtime_root: runtime_root.clone(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        };
        let home = dir.path().join(".codex");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "{\"auth_mode\":\"chatgpt\"}").unwrap();
        (dir, paths, home)
    }

    #[test]
    fn an_expired_access_token_is_not_a_revoked_login() {
        assert!(!codex_login_revoked("", "provided authentication token is expired"));
        assert!(codex_login_revoked(REVOKED, ""));
        assert!(codex_login_revoked("", STDERR_401));
    }

    #[test]
    fn a_revoked_login_is_written_once_and_cleared_by_a_turn_that_runs() {
        let (_dir, paths, home) = fixture();
        let marker = codex_login_marker_path(&paths, "c1");
        assert!(note_codex_login(&paths, "c1", "lane-a", Some(&home), REVOKED, STDERR_401).unwrap());
        let first = read_json(&marker).unwrap();
        assert_eq!(first["status"], "owner_action_required");
        assert_eq!(first["lane_id"], "lane-a");
        assert!(first["auth"]["auth_json_mtime_ms"].as_u64().is_some());

        // A second lane on the same login does not rewrite it.
        assert!(note_codex_login(&paths, "c1", "lane-b", Some(&home), REVOKED, "").unwrap());
        assert_eq!(read_json(&marker).unwrap()["lane_id"], "lane-a");

        // A failure that is not about the login leaves it in place.
        assert!(!note_codex_login(&paths, "c1", "lane-c", Some(&home), "", "status code 429").unwrap());
        assert!(marker.exists());

        // The owner signs in; the next lane runs a turn.
        let ran = "{\"type\":\"turn.started\"}\n{\"type\":\"turn.completed\",\"usage\":{}}";
        assert!(!note_codex_login(&paths, "c1", "lane-d", Some(&home), ran, "").unwrap());
        assert!(!marker.exists());
        let events = fs::read_to_string(harness_notices_path(&paths, "c1")).unwrap();
        assert_eq!(events.matches("\"codex_login_required\"").count(), 1);
        assert_eq!(events.matches("\"codex_login_restored\"").count(), 1);
    }

    #[test]
    fn a_login_still_refused_after_a_new_sign_in_is_recorded_again() {
        let (_dir, paths, home) = fixture();
        let marker = codex_login_marker_path(&paths, "c1");
        note_codex_login(&paths, "c1", "lane-a", Some(&home), REVOKED, "").unwrap();
        let detected = read_json(&marker).unwrap()["detected_at"].clone();
        fs::write(home.join("auth.json"), "{\"auth_mode\":\"chatgpt\",\"x\":1}").unwrap();
        note_codex_login(&paths, "c1", "lane-b", Some(&home), REVOKED, "").unwrap();
        let again = read_json(&marker).unwrap();
        assert_eq!(again["lane_id"], "lane-b");
        assert_eq!(again["detected_at"], detected, "the outage keeps its start");
    }
}
